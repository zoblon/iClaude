import { simpleParser } from 'mailparser';
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { authorizeDraft } from '../permissions.js';
import { clip } from '../untrusted.js';
import { parseMessage, tidy } from './body.js';
import { buildDraft, parseMailbox, type Mailbox } from './mime.js';
import { decodeRef } from './ref.js';
import type { Address, DraftStore, MailReader } from './types.js';

const MAX_RECIPIENTS = 20;
const MAX_BODY_CHARS = 20_000;
const MAX_QUOTE_CHARS = 4_000;
const MAX_REFERENCES = 20;

export interface DraftInput {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  subject?: string | undefined;
  body: string;
  /** ID of a message being replied to (sets In-Reply-To and References). */
  replyToId?: string | undefined;
  /** Quote the original message when replying (default: yes). */
  quote?: boolean | undefined;
}

export interface DraftView {
  id?: string;
  mailbox: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo?: string;
  quoted: boolean;
  bodyChars: number;
  note: string;
}

const show = (m: Mailbox) => (m.name ? `${m.name} <${m.address}>` : m.address);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function toMailboxes(list: string[] | undefined, label: string): Mailbox[] {
  const items = (list ?? []).map((s) => s.trim()).filter(Boolean);
  const out = items.map(parseMailbox);
  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.address.toLowerCase()) ? false : (seen.add(m.address.toLowerCase()), true)));
}

const fromAddress = (a: Address): Mailbox | undefined =>
  a.address ? { ...(a.name ? { name: a.name.replace(/[\r\n\u0000-\u001F]/g, ' ').slice(0, 100) } : {}), address: a.address } : undefined;

/** Prefix "Re: ..." only once (also if "AW:" or similar is already there). */
export function replySubject(original: string): string {
  return /^\s*(re|aw|antw|sv)\s*:/i.test(original) ? original.trim() : `Re: ${original.trim()}`;
}

export function quoteBlock(text: string, who: string, date: DateTime | undefined): string {
  const chars = Array.from(text);
  const cut = chars.length > MAX_QUOTE_CHARS;
  const body = (cut ? chars.slice(0, MAX_QUOTE_CHARS).join('') : text).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  const when = date ? `On ${date.setLocale('en-US').toFormat('LLL d, yyyy')}, at ${date.toFormat('HH:mm')}, ${who} wrote:` : `${who} wrote:`;
  return `${when}\n${body}${cut ? '\n> […]' : ''}`;
}

/**
 * Creates drafts. Nothing is ever sent. The sender is always the user's own iCloud address; there is no Bcc and no attachments.
 */
export class DraftService {
  constructor(
    private readonly cfg: Config,
    private readonly reader: MailReader,
    private readonly store: DraftStore,
    private readonly mailboxes: () => Promise<import('./types.js').MailboxInfo[]>,
  ) {}

  async createDraft(a: DraftInput): Promise<DraftView> {
    const body = a.body.replace(/\s+$/g, '');
    if (!body.trim()) throw new UserError('The draft text must not be empty. Please provide a text.');
    if (Array.from(body).length > MAX_BODY_CHARS) throw new UserError(`The text is too long (max. ${MAX_BODY_CHARS} characters). Please shorten it.`);

    let to = toMailboxes(a.to, 'to');
    const cc = toMailboxes(a.cc, 'cc');
    if (to.length + cc.length > MAX_RECIPIENTS) throw new UserError(`Too many recipients (max. ${MAX_RECIPIENTS}). Please split them up.`);

    // Permissions first: the target folder (Drafts) is fixed before anything is built or loaded.
    const grant = authorizeDraft(await this.mailboxes());

    let subject = (a.subject ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let text = body;
    let quoted = false;

    if (a.replyToId) {
      const original = await this.reader.fetchSource(decodeRef(a.replyToId));
      const msg = await parseMessage(original.source, 'text');
      if (!msg.messageId) throw new UserError('The original message has no Message-ID, so no reply draft can be built. Please create a new draft without reply_to_id.');
      inReplyTo = msg.messageId;
      references = [...msg.references, msg.messageId].slice(-MAX_REFERENCES);
      if (!subject) subject = replySubject(msg.subject);
      if (!to.length) {
        const candidates = (msg.replyTo.length ? msg.replyTo : msg.from).map(fromAddress).filter((m): m is Mailbox => Boolean(m));
        // Reply to one of the user's own messages: address the original recipients
        const others = candidates.some((m) => same(m.address, this.cfg.mailUser)) ? msg.to.map(fromAddress).filter((m): m is Mailbox => Boolean(m)) : candidates;
        to = others.filter((m) => !same(m.address, this.cfg.mailUser)).slice(0, MAX_RECIPIENTS);
        if (!to.length) to = others.slice(0, MAX_RECIPIENTS);
      }
      if (a.quote ?? true) {
        const who = msg.from[0] ? show({ ...(msg.from[0].name ? { name: msg.from[0].name } : {}), address: msg.from[0].address ?? '' }).trim() : 'Unknown';
        const when = msg.date ? DateTime.fromISO(msg.date).setZone(this.cfg.timezone) : undefined;
        text = `${body}\n\n${quoteBlock(tidy(msg.text), who, when?.isValid ? when : undefined)}`;
        quoted = true;
      }
    }

    if (!to.length && !cc.length) throw new UserError('Please specify at least one recipient (to or cc).');
    if (!subject) throw new UserError('Please specify a subject (or use reply_to_id).');
    if (Array.from(subject).length > 300) throw new UserError('The subject is too long (max. 300 characters).');

    const from: Mailbox = { address: this.cfg.mailUser };
    const domain = this.cfg.mailUser.split('@')[1] ?? 'icloud.com';
    const { raw } = buildDraft(
      { from, to, cc, subject, body: text, inReplyTo, references, date: DateTime.now().setZone(this.cfg.timezone) },
      domain,
    );
    await this.assertSafe(raw, { from, to, cc });

    const saved = await this.store.appendDraft(grant, raw);
    return {
      ...(saved.id ? { id: saved.id } : {}),
      mailbox: saved.mailbox,
      from: from.address,
      to: to.map(show),
      cc: cc.map(show),
      subject: clip(subject, 300),
      ...(inReplyTo ? { inReplyTo } : {}),
      quoted,
      bodyChars: Array.from(text).length,
      note: 'The draft is in the Drafts folder and was NOT sent. Please review it in Apple Mail and send it yourself.',
    };
  }

  /** Last safeguard: sender, recipients and headers are exactly as intended, nothing extra. */
  private async assertSafe(raw: Buffer, want: { from: Mailbox; to: Mailbox[]; cc: Mailbox[] }): Promise<void> {
    const p = await simpleParser(raw);
    const addrs = (a: unknown) =>
      (Array.isArray(a) ? a : a ? [a] : []).flatMap((x: { value: Array<{ address?: string }> }) => x.value.map((v) => (v.address ?? '').toLowerCase())).sort();
    const exp = (l: Mailbox[]) => l.map((m) => m.address.toLowerCase()).sort();
    const ok =
      JSON.stringify(addrs(p.from)) === JSON.stringify(exp([want.from])) &&
      JSON.stringify(addrs(p.to)) === JSON.stringify(exp(want.to)) &&
      JSON.stringify(addrs(p.cc)) === JSON.stringify(exp(want.cc)) &&
      !p.headers.has('bcc') &&
      !p.headers.has('sender') &&
      !p.headers.has('reply-to') &&
      !p.headers.has('return-path') &&
      (p.attachments ?? []).length === 0;
    if (!ok) throw new UserError('Internal safeguard: sender or recipients of the draft do not match the input. Nothing was written.');
  }
}
