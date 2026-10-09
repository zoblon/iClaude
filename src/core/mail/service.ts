import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { clip } from '../untrusted.js';
import { paginate, parseMessage, withoutQuotes, type Attachment, type Page } from './body.js';
import { decodeRef } from './ref.js';
import type { MailboxInfo, MailReader, MessageSummary, SearchCriteria } from './types.js';

const MAX_LIMIT = 50;
const MAILBOX_CACHE_MS = 60_000;
const SEARCH_BUDGET_MS = 75_000;
const LOCAL_PASS = 300;
const THREAD_ROUNDS = 3;
const THREAD_MAX_MESSAGES = 30;

/** Role aliases, including common German folder names (Posteingang, Gesendet, Entwürfe, Archiv, Papierkorb). */
const ALIASES: Record<string, string> = {
  inbox: 'inbox', posteingang: 'inbox',
  sent: 'sent', gesendet: 'sent',
  drafts: 'drafts', entwürfe: 'drafts', entwuerfe: 'drafts',
  archive: 'archive', archiv: 'archive',
  junk: 'junk', spam: 'junk',
  trash: 'trash', papierkorb: 'trash',
};

export interface SearchInput {
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  text?: string | undefined;
  /** Date YYYY-MM-DD, inclusive. */
  since?: string | undefined;
  /** Date YYYY-MM-DD, inclusive. */
  until?: string | undefined;
  unreadOnly?: boolean | undefined;
  /** Folder; if omitted: all folders except junk and Trash. */
  mailbox?: string | undefined;
  includeJunkAndTrash?: boolean | undefined;
  limit?: number | undefined;
}

export interface MessageView {
  id: string;
  mailbox: string;
  subject: string;
  from: MessageSummary['from'];
  to: MessageSummary['to'];
  cc: MessageSummary['cc'];
  date: string;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** Attachments; `attachmentId` is the argument for read_attachment (missing only if the server gave no structure). */
  attachments: Array<Attachment & { attachmentId?: string }>;
  format: 'text' | 'markdown';
  page: Omit<Page, 'text'>;
  text: string;
  sourceTruncated?: true;
}

export class MailService {
  private mailboxCache?: { at: number; list: MailboxInfo[] };

  constructor(
    private readonly cfg: Config,
    private readonly reader: MailReader,
  ) {}

  async mailboxes(): Promise<MailboxInfo[]> {
    if (this.mailboxCache && Date.now() - this.mailboxCache.at < MAILBOX_CACHE_MS) return this.mailboxCache.list;
    const list = await this.reader.listMailboxes();
    this.mailboxCache = { at: Date.now(), list };
    return list;
  }

  /** Folder by path, name or role ("inbox", "sent", "drafts", "archive", "junk", "trash"). */
  async resolveMailbox(ref: string | undefined): Promise<MailboxInfo> {
    const list = await this.mailboxes();
    const want = (ref ?? 'INBOX').trim();
    const lc = want.toLowerCase();
    const role = ALIASES[lc];
    const hit =
      list.find((m) => m.path.toLowerCase() === lc) ??
      list.find((m) => m.name.toLowerCase() === lc) ??
      (role ? list.find((m) => m.role === role) : undefined);
    if (!hit) {
      throw new UserError(`Folder "${clip(want, 100)}" not found. Available folders: ${list.map((m) => `"${m.path}"`).join(', ')}.`);
    }
    return hit;
  }

  async unreadCounts() {
    const list = await this.reader.listMailboxes();
    this.mailboxCache = { at: Date.now(), list };
    const withUnread = list.filter((m) => (m.unseen ?? 0) > 0 && m.role !== 'trash' && m.role !== 'junk');
    return { total: withUnread.reduce((n, m) => n + (m.unseen ?? 0), 0), mailboxes: list.map((m) => ({ mailbox: m.path, role: m.role, unread: m.unseen ?? 0 })) };
  }

  async listRecent(mailbox: string | undefined, count = 20) {
    const box = await this.resolveMailbox(mailbox);
    const messages = await this.reader.listRecent(box.path, Math.min(count, MAX_LIMIT));
    return { mailbox: box.path, messages };
  }

  private parseDay(s: string | undefined, label: string, plusDays = 0): Date | undefined {
    if (!s) return undefined;
    const d = DateTime.fromISO(s.trim().slice(0, 10), { zone: this.cfg.timezone });
    if (!d.isValid) throw new UserError(`${label} "${clip(s, 40)}" is invalid. Expected: YYYY-MM-DD.`);
    return d.startOf('day').plus({ days: plusDays }).toJSDate();
  }

  async search(a: SearchInput) {
    const crit: SearchCriteria = {
      from: a.from?.trim() || undefined,
      to: a.to?.trim() || undefined,
      subject: a.subject?.trim() || undefined,
      text: a.text?.trim() || undefined,
      since: this.parseDay(a.since, 'since'),
      before: this.parseDay(a.until, 'until', 1),
      unreadOnly: a.unreadOnly || undefined,
    };
    if (!crit.from && !crit.to && !crit.subject && !crit.text && !crit.since && !crit.before && !crit.unreadOnly) {
      throw new UserError('Please specify at least one search criterion: from, to, subject, text, since, until or unread_only.');
    }
    const limit = Math.min(a.limit ?? 20, MAX_LIMIT);
    const all = await this.mailboxes();
    const targets = a.mailbox
      ? [await this.resolveMailbox(a.mailbox)]
      : all.filter((m) => a.includeJunkAndTrash || (m.role !== 'junk' && m.role !== 'trash'));

    const started = Date.now();
    const found: MessageSummary[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const box of targets) {
      if (Date.now() - started > SEARCH_BUDGET_MS) {
        skipped.push(box.path);
        continue;
      }
      try {
        const r = await this.reader.search(box.path, crit, { limit, localPass: LOCAL_PASS });
        total += r.total;
        found.push(...r.messages);
      } catch (e) {
        // A single folder must not make the whole search fail, unless it is the only one.
        if (targets.length === 1) throw e;
        skipped.push(box.path);
      }
    }
    found.sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0));
    return {
      searched: targets.map((t) => t.path).filter((p) => !skipped.includes(p)),
      skipped,
      total,
      messages: found.slice(0, limit),
      cut: total > limit,
    };
  }

  async getMessage(id: string, format: 'text' | 'markdown' = 'text', offset = 0): Promise<MessageView> {
    const ref = decodeRef(id);
    const { source, summary, truncated, attachments } = await this.reader.fetchSource(ref);
    const msg = await parseMessage(source, format);
    const { text, ...page } = paginate(msg.text, offset);
    return {
      id: summary.id,
      mailbox: summary.mailbox,
      subject: msg.subject,
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      date: msg.date || summary.date,
      unread: summary.unread,
      flagged: summary.flagged,
      answered: summary.answered,
      ...(msg.messageId ? { messageId: msg.messageId } : {}),
      ...(msg.inReplyTo ? { inReplyTo: msg.inReplyTo } : {}),
      references: msg.references,
      attachments: attachments.length
        ? attachments.map((a) => ({ attachmentId: a.id, filename: a.filename, contentType: a.contentType, size: a.size, inline: a.inline }))
        : msg.attachments,
      format: msg.format,
      page,
      text,
      ...(truncated ? { sourceTruncated: true as const } : {}),
    };
  }

  /**
   * Conversation of a message: iCloud does not offer THREAD, so Message-ID, In-Reply-To and References
   * are merged over several rounds across the inbox, sent, drafts and archive folders.
   */
  async getThread(id: string, opts: { includeText?: boolean; excerptChars?: number } = {}) {
    const ref = decodeRef(id);
    const start = await this.reader.fetchSource(ref);
    const first = await parseMessage(start.source, 'text');

    const known = new Set<string>();
    const addIds = (s: { messageId?: string | undefined; inReplyTo?: string | undefined; references?: string[] | undefined }) => {
      for (const x of [s.messageId, s.inReplyTo, ...(s.references ?? [])]) if (x) known.add(x);
    };
    addIds(first);
    addIds(start.summary);

    const boxes = (await this.mailboxes()).filter((m) => m.role === 'inbox' || m.role === 'sent' || m.role === 'drafts' || m.role === 'archive');
    const byId = new Map<string, MessageSummary>([[start.summary.id, start.summary]]);
    const queried = new Set<string>();

    for (let round = 0; round < THREAD_ROUNDS; round++) {
      const todo = [...known].filter((k) => !queried.has(k));
      if (!todo.length) break;
      todo.forEach((k) => queried.add(k));
      let added = false;
      for (const box of boxes) {
        const related = await this.reader.findRelated(box.path, todo, THREAD_MAX_MESSAGES);
        for (const m of related) {
          if (byId.has(m.id) || byId.size >= THREAD_MAX_MESSAGES) continue;
          byId.set(m.id, m);
          addIds(m);
          added = true;
        }
      }
      if (!added) break;
    }

    // The same message can be in several folders (e.g. sent and archive): merge by Message-ID.
    const seen = new Set<string>();
    const messages = [...byId.values()]
      .sort((x, y) => (Date.parse(x.date) || 0) - (Date.parse(y.date) || 0))
      .filter((m) => {
        if (!m.messageId) return true;
        if (seen.has(m.messageId)) return false;
        seen.add(m.messageId);
        return true;
      });

    const includeText = opts.includeText ?? true;
    const per = Math.min(Math.max(opts.excerptChars ?? 1500, 200), 4000);
    let budget = 16_000;
    const out: Array<MessageSummary & { excerpt?: string; excerptTruncated?: true }> = [];
    for (const m of messages) {
      if (!includeText || budget <= 0) {
        out.push(m);
        continue;
      }
      try {
        const full = m.id === start.summary.id ? { source: start.source } : await this.reader.fetchSource(decodeRef(m.id));
        const parsed = await parseMessage(full.source, 'text');
        const body = Array.from(withoutQuotes(parsed.text));
        const take = Math.min(per, budget);
        budget -= Math.min(body.length, take);
        out.push({ ...m, excerpt: body.slice(0, take).join(''), ...(body.length > take ? { excerptTruncated: true as const } : {}) });
      } catch {
        out.push(m);
      }
    }
    return { messages: out, startedFrom: start.summary.id, cut: byId.size >= THREAD_MAX_MESSAGES };
  }
}
