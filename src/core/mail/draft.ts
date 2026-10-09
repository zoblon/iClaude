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
  /** ID einer Nachricht, auf die geantwortet wird (setzt In-Reply-To und References). */
  replyToId?: string | undefined;
  /** Beim Antworten die Originalnachricht zitieren (Standard: ja). */
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

/** "Re: ..." nur einmal voranstellen (auch wenn schon "AW:" o. Ä. dasteht). */
export function replySubject(original: string): string {
  return /^\s*(re|aw|antw|sv)\s*:/i.test(original) ? original.trim() : `Re: ${original.trim()}`;
}

export function quoteBlock(text: string, who: string, date: DateTime | undefined): string {
  const chars = Array.from(text);
  const cut = chars.length > MAX_QUOTE_CHARS;
  const body = (cut ? chars.slice(0, MAX_QUOTE_CHARS).join('') : text).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  const when = date ? `Am ${date.toFormat('dd.LL.yyyy')} um ${date.toFormat('HH:mm')} schrieb ${who}:` : `${who} schrieb:`;
  return `${when}\n${body}${cut ? '\n> […]' : ''}`;
}

/**
 * Legt Entwürfe an. Es wird nie gesendet. Absender ist immer die eigene iCloud-Adresse, Bcc und Anhänge gibt es nicht.
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
    if (!body.trim()) throw new UserError('Der Text des Entwurfs darf nicht leer sein. Bitte einen Text angeben.');
    if (Array.from(body).length > MAX_BODY_CHARS) throw new UserError(`Der Text ist zu lang (höchstens ${MAX_BODY_CHARS} Zeichen). Bitte kürzen.`);

    let to = toMailboxes(a.to, 'to');
    const cc = toMailboxes(a.cc, 'cc');
    if (to.length + cc.length > MAX_RECIPIENTS) throw new UserError(`Zu viele Empfänger (höchstens ${MAX_RECIPIENTS}). Bitte aufteilen.`);

    // Rechte zuerst: der Zielordner steht fest (Entwürfe), bevor irgendetwas gebaut oder geladen wird.
    const grant = authorizeDraft(await this.mailboxes());

    let subject = (a.subject ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let text = body;
    let quoted = false;

    if (a.replyToId) {
      const original = await this.reader.fetchSource(decodeRef(a.replyToId));
      const msg = await parseMessage(original.source, 'text');
      if (!msg.messageId) throw new UserError('Die Originalnachricht hat keine Message-ID, daher kann kein Antwort-Entwurf gebaut werden. Bitte einen neuen Entwurf ohne reply_to_id anlegen.');
      inReplyTo = msg.messageId;
      references = [...msg.references, msg.messageId].slice(-MAX_REFERENCES);
      if (!subject) subject = replySubject(msg.subject);
      if (!to.length) {
        const candidates = (msg.replyTo.length ? msg.replyTo : msg.from).map(fromAddress).filter((m): m is Mailbox => Boolean(m));
        // Antwort auf eine eigene Nachricht: an die ursprünglichen Empfänger
        const others = candidates.some((m) => same(m.address, this.cfg.mailUser)) ? msg.to.map(fromAddress).filter((m): m is Mailbox => Boolean(m)) : candidates;
        to = others.filter((m) => !same(m.address, this.cfg.mailUser)).slice(0, MAX_RECIPIENTS);
        if (!to.length) to = others.slice(0, MAX_RECIPIENTS);
      }
      if (a.quote ?? true) {
        const who = msg.from[0] ? show({ ...(msg.from[0].name ? { name: msg.from[0].name } : {}), address: msg.from[0].address ?? '' }).trim() : 'Unbekannt';
        const when = msg.date ? DateTime.fromISO(msg.date).setZone(this.cfg.timezone) : undefined;
        text = `${body}\n\n${quoteBlock(tidy(msg.text), who, when?.isValid ? when : undefined)}`;
        quoted = true;
      }
    }

    if (!to.length && !cc.length) throw new UserError('Bitte mindestens einen Empfänger angeben (to oder cc).');
    if (!subject) throw new UserError('Bitte einen Betreff angeben (oder reply_to_id verwenden).');
    if (Array.from(subject).length > 300) throw new UserError('Der Betreff ist zu lang (höchstens 300 Zeichen).');

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
      note: 'Entwurf liegt im Ordner Entwürfe und wurde NICHT gesendet. Bitte in Apple Mail prüfen und selbst senden.',
    };
  }

  /** Letzte Sicherung: Absender, Empfänger und Kopfzeilen sind genau wie gewollt, nichts Zusätzliches. */
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
    if (!ok) throw new UserError('Interner Schutz: Absender oder Empfänger des Entwurfs stimmen nicht mit der Eingabe überein. Es wurde nichts geschrieben.');
  }
}
