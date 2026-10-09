import { simpleParser } from 'mailparser';
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { authorizeDraft } from '../permissions.js';
import { clip } from '../untrusted.js';
import { parseMessage, tidy } from './body.js';
import { buildDraft, parseMailbox, safeFilename, type DraftAttachment, type Mailbox } from './mime.js';
import { decodeRef } from './ref.js';
import type { Address, DraftStore, MailReader } from './types.js';

const MAX_RECIPIENTS = 20;
const MAX_BODY_CHARS = 20_000;
const MAX_QUOTE_CHARS = 4_000;
const MAX_REFERENCES = 20;
const MAX_FORWARD_CHARS = 60_000;
/** Total size of the forwarded attachments (decoded). */
export const MAX_FORWARD_BYTES = 20 * 1024 * 1024;

export interface DraftInput {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  subject?: string | undefined;
  body: string;
  /** ID of a message being replied to (sets In-Reply-To and References). */
  replyToId?: string | undefined;
  /** Quote the original message when replying or forwarding (default: yes). */
  quote?: boolean | undefined;
  /** ID of a message to forward (excludes replyToId). */
  forwardOfId?: string | undefined;
  /** Which attachments of the original to take along: attachment_ids from get_message. Default: all. An empty list: none. */
  forwardAttachmentIds?: string[] | undefined;
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
  /** Set for a forwarded message. */
  forwarded?: true;
  attachments?: Array<{ filename: string; size: number }>;
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

/** "Fwd: ..." only once (also if "Fw:" or "WG:" is already there). */
export function forwardSubject(original: string): string {
  return /^\s*(fwd?|wg|tr|rv)\s*:/i.test(original) ? original.trim() : `Fwd: ${original.trim()}`;
}

/** "CEST", "EDT", … Intl only knows some abbreviations per locale, so en-US is tried first, then en-GB. */
function zoneAbbreviation(dt: DateTime): string {
  const us = dt.setLocale('en-US').toFormat('ZZZZ');
  if (!/^GMT[+-]/.test(us)) return us;
  const gb = dt.setLocale('en-GB').toFormat('ZZZZ');
  return /^GMT[+-]/.test(gb) ? us : gb;
}

const showAddresses = (list: Address[]) =>
  list.map((a) => (a.address ? (a.name ? `${a.name} <${a.address}>` : a.address) : (a.name ?? ''))).filter(Boolean).join(', ');

/** The block Apple Mail puts above a forwarded message: "Begin forwarded message:" with From, Subject, Date, To (and Cc). */
export function forwardBlock(o: { from: Address[]; subject: string; date: DateTime | undefined; to: Address[]; cc: Address[]; text: string | undefined }): string {
  const lines = [
    'Begin forwarded message:',
    '',
    `From: ${showAddresses(o.from) || 'Unknown'}`,
    `Subject: ${o.subject}`,
    ...(o.date ? [`Date: ${o.date.setLocale('en-US').toFormat("cccc, LLLL d, yyyy 'at' h:mm:ss a")} ${zoneAbbreviation(o.date)}`] : []),
    `To: ${showAddresses(o.to) || 'Unknown'}`,
    ...(o.cc.length ? [`Cc: ${showAddresses(o.cc)}`] : []),
  ];
  const head = lines.join('\n');
  if (o.text === undefined) return head;
  const chars = Array.from(o.text);
  const cut = chars.length > MAX_FORWARD_CHARS;
  return `${head}\n\n${cut ? chars.slice(0, MAX_FORWARD_CHARS).join('') : o.text}${cut ? '\n\n[…]' : ''}`;
}

/**
 * Creates drafts. Nothing is ever sent. The sender is always the user's own iCloud address; there is no Bcc.
 * Attachments exist only when forwarding a message (the attachments of the original).
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

    if (a.replyToId && a.forwardOfId) throw new UserError('Please give either reply_to_id or forward_of_id, not both.');
    if (a.forwardAttachmentIds && !a.forwardOfId) throw new UserError('forward_attachment_ids only makes sense together with forward_of_id.');

    let subject = (a.subject ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let text = body;
    let quoted = false;
    let attachments: DraftAttachment[] = [];
    let forwarded = false;

    if (a.forwardOfId) {
      if (!to.length && !cc.length) throw new UserError('Please specify at least one recipient (to or cc) for the forwarded message.');
      const ref = decodeRef(a.forwardOfId);
      const original = await this.reader.fetchSource(ref);
      const msg = await parseMessage(original.source, 'text');
      if (!subject) subject = forwardSubject(msg.subject);

      const available = original.attachments;
      let chosen = available;
      if (a.forwardAttachmentIds) {
        const missing = a.forwardAttachmentIds.filter((id) => !available.some((x) => x.id === id));
        if (missing.length) {
          throw new UserError(`The original has no attachment with the attachment_id ${missing.map((m) => `"${m.slice(0, 20)}"`).join(', ')}. Available: ${available.map((x) => `${x.id} (${x.filename})`).join(', ') || '(none)'}.`);
        }
        chosen = available.filter((x) => a.forwardAttachmentIds!.includes(x.id));
      }
      const total = chosen.reduce((n, x) => n + x.size, 0);
      if (total > MAX_FORWARD_BYTES) {
        throw new UserError(
          `The attachments are too large to forward (${(total / 1024 / 1024).toFixed(1)} MB, at most ${MAX_FORWARD_BYTES / 1024 / 1024} MB in total). Nothing was created. Choose fewer attachments with forward_attachment_ids, or forward the mail in Apple Mail.`,
        );
      }
      let loaded = 0;
      for (const info of chosen) {
        const part = await this.reader.fetchPart(ref, info.id, MAX_FORWARD_BYTES - loaded);
        loaded += part.data.length;
        if (loaded > MAX_FORWARD_BYTES) throw new UserError(`The attachments are too large to forward (at most ${MAX_FORWARD_BYTES / 1024 / 1024} MB in total). Nothing was created.`);
        attachments.push({ filename: part.info.filename, contentType: part.info.contentType, data: part.data });
      }
      const when = msg.date ? DateTime.fromISO(msg.date).setZone(this.cfg.timezone) : undefined;
      const block = forwardBlock({
        from: msg.from,
        subject: msg.subject,
        date: when?.isValid ? when : undefined,
        to: msg.to,
        cc: msg.cc,
        text: a.quote === false ? undefined : `${tidy(msg.text)}${original.truncated ? '\n\n[The original message is very large; only the beginning is shown.]' : ''}`,
      });
      text = `${body}\n\n${block}`;
      quoted = a.quote !== false;
      forwarded = true;
    }

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
    if (!subject) throw new UserError('Please specify a subject (or use reply_to_id or forward_of_id).');
    if (Array.from(subject).length > 300) throw new UserError('The subject is too long (max. 300 characters).');

    const from: Mailbox = { address: this.cfg.mailUser };
    const domain = this.cfg.mailUser.split('@')[1] ?? 'icloud.com';
    const { raw } = buildDraft(
      { from, to, cc, subject, body: text, inReplyTo, references, date: DateTime.now().setZone(this.cfg.timezone), attachments },
      domain,
    );
    await this.assertSafe(raw, { from, to, cc, attachments });

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
      ...(forwarded ? { forwarded: true as const } : {}),
      ...(attachments.length ? { attachments: attachments.map((x) => ({ filename: safeFilename(x.filename), size: x.data.length })) } : {}),
      bodyChars: Array.from(text).length,
      note: 'The draft is in the Drafts folder and was NOT sent. Please review it in Apple Mail and send it yourself.',
    };
  }

  /** Last safeguard: sender, recipients and headers are exactly as intended, nothing extra. */
  private async assertSafe(raw: Buffer, want: { from: Mailbox; to: Mailbox[]; cc: Mailbox[]; attachments: DraftAttachment[] }): Promise<void> {
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
      // attachments exactly as intended: same number, same names, same sizes
      JSON.stringify((p.attachments ?? []).map((x) => [x.filename, x.size])) === JSON.stringify(want.attachments.map((x) => [safeFilename(x.filename), x.data.length]));
    if (!ok) throw new UserError('Internal safeguard: sender or recipients of the draft do not match the input. Nothing was written.');
  }
}
