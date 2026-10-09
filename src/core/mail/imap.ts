import { ImapFlow } from 'imapflow';
import type { Config } from '../config.js';
import { UserError, log, withTimeout } from '../errors.js';
import { clip } from '../untrusted.js';
import { encodeRef } from './ref.js';
import { DraftGrant, TrashGrant } from '../permissions.js';
import type { Address, DraftStore, MailboxInfo, MailReader, MailTrasher, MessageRef, MessageSummary, SearchCriteria } from './types.js';

/** Largest draft that will be stored. */
const MAX_DRAFT_BYTES = 1_000_000;
const OP_TIMEOUT_MS = 40_000;
const CONNECT_TIMEOUT_MS = 20_000;
/** Largest message that will be loaded (raw source including attachments). */
const MAX_SOURCE_BYTES = 3_000_000;

/** Maximum number of messages per folder fetched in detail. */
const DETAIL_CAP = 100;

/* ------------------------------------------------------------------ */
/* Narrow, read-only view of imapflow.                                 */
/* What is not listed here cannot be called by the code: no setting    */
/* flags, no deleting, moving, copying, creating or appending.         */
/* ------------------------------------------------------------------ */

interface EnvelopeAddress {
  name?: string | undefined;
  address?: string | undefined;
}
interface Envelope {
  date?: Date | string | undefined;
  subject?: string | undefined;
  messageId?: string | undefined;
  inReplyTo?: string | undefined;
  from?: EnvelopeAddress[] | undefined;
  to?: EnvelopeAddress[] | undefined;
  cc?: EnvelopeAddress[] | undefined;
}
interface BodyNode {
  type?: string | undefined;
  disposition?: string | undefined;
  childNodes?: BodyNode[] | undefined;
  parameters?: Record<string, string> | undefined;
  dispositionParameters?: Record<string, string> | undefined;
}
export interface ImapMessage {
  uid: number;
  seq?: number;
  flags?: Set<string> | undefined;
  envelope?: Envelope | undefined;
  internalDate?: Date | string | undefined;
  size?: number | undefined;
  bodyStructure?: BodyNode | undefined;
  source?: Buffer | undefined;
  headers?: Buffer | undefined;
}
export interface FetchQuery {
  uid?: boolean;
  flags?: boolean;
  envelope?: boolean;
  internalDate?: boolean;
  size?: boolean;
  bodyStructure?: boolean;
  headers?: string[];
  source?: { maxLength: number };
}
export interface SearchQuery {
  all?: boolean;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: Date;
  before?: Date;
  seen?: boolean;
  header?: Record<string, string>;
  or?: SearchQuery[];
}
export interface ListEntry {
  path: string;
  name: string;
  flags?: Set<string> | undefined;
  specialUse?: string | undefined;
  status?: { messages?: number | undefined; unseen?: number | undefined } | undefined;
}

export interface ImapLike {
  readonly usable: boolean;
  readonly mailbox: false | { path: string; exists: number; uidValidity: bigint };
  on(event: 'error' | 'close', cb: (e?: unknown) => void): unknown;
  connect(): Promise<void>;
  close(): void;
  logout(): Promise<void>;
  list(opts: { statusQuery: { messages: true; unseen: true } }): Promise<ListEntry[]>;
  /** Opens read-only only (IMAP EXAMINE). */
  getMailboxLock(path: string, opts: { readOnly: true }): Promise<{ release(): void }>;
  fetch(range: string, query: FetchQuery, opts?: { uid?: boolean }): AsyncIterable<ImapMessage>;
  fetchOne(seq: string, query: FetchQuery, opts?: { uid?: boolean }): Promise<ImapMessage | false>;
  search(query: SearchQuery, opts?: { uid?: boolean }): Promise<number[] | false>;
}

/** Only for storing drafts (IMAP APPEND). Used exclusively by appendDraft. */
interface ImapAppend {
  append(path: string, content: Buffer, flags: string[], idate?: Date): Promise<false | { destination: string; uid?: number; uidValidity?: bigint }>;
}

/**
 * Only for moving to the Trash (IMAP UID MOVE). Used exclusively by moveToTrash.
 * Deliberately contains nothing that could set flags or permanently remove messages.
 *
 * UID MOVE is deliberately sent directly (exec) and not via imapflow.messageMove: without an advertised MOVE capability,
 * that silently falls back to COPY + \\Deleted + EXPUNGE. iCloud does not advertise MOVE but understands UID MOVE (verified live).
 * If the server rejects the command, the operation is aborted. There is no fallback.
 */
interface ImapMove {
  getMailboxLock(path: string, opts: { readOnly: false }): Promise<{ release(): void }>;
  exec(command: 'UID MOVE', attributes: Array<{ type: 'SEQUENCE' | 'STRING'; value: string }>, options: object): Promise<{ next?: () => void }>;
}

export function defaultImapFactory(cfg: Config): () => ImapLike {
  return () =>
    new ImapFlow({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      auth: { user: cfg.mailUser, pass: cfg.appPassword },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: 90_000,
    }) as unknown as ImapLike;
}

const ROLE_BY_USE: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
};

/** Folder attribute from the server's LIST response (regardless of whether the server advertises SPECIAL-USE; otherwise imapflow would guess by name). */
function roleFromFlags(flags: Set<string> | undefined): string | undefined {
  if (!flags) return undefined;
  for (const f of flags) {
    const hit = Object.entries(ROLE_BY_USE).find(([use]) => use.toLowerCase() === f.toLowerCase());
    if (hit) return hit[1];
  }
  return undefined;
}

const mapAddresses = (a: EnvelopeAddress[] | undefined): Address[] =>
  (a ?? []).slice(0, 20).map((x) => ({
    ...(x.name ? { name: clip(x.name, 200) } : {}),
    ...(x.address ? { address: clip(x.address, 200) } : {}),
  }));

function hasAttachment(n: BodyNode | undefined): boolean {
  if (!n) return false;
  if (n.disposition?.toLowerCase() === 'attachment') return true;
  return (n.childNodes ?? []).some(hasAttachment);
}

const asDate = (d: Date | string | undefined): string => {
  if (!d) return '';
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString();
};

/** Message-IDs without angle brackets. */
const stripId = (s: string) => s.trim().replace(/^<|>$/g, '');

function parseReferences(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  const text = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const line = /^references:\s*(.*)$/im.exec(text)?.[1] ?? '';
  return [...line.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!).slice(0, 50);
}

function summarize(m: ImapMessage, path: string, uidValidity: string): MessageSummary {
  const e = m.envelope ?? {};
  const refs = parseReferences(m.headers);
  return {
    id: encodeRef({ path, uidValidity, uid: m.uid }),
    mailbox: path,
    subject: clip(e.subject ?? '', 300) || '(no subject)',
    from: mapAddresses(e.from),
    to: mapAddresses(e.to),
    cc: mapAddresses(e.cc),
    date: asDate(e.date ?? m.internalDate),
    unread: !(m.flags?.has('\\Seen') ?? false),
    flagged: m.flags?.has('\\Flagged') ?? false,
    answered: m.flags?.has('\\Answered') ?? false,
    ...(m.flags?.has('\\Draft') ? { draft: true as const } : {}),
    hasAttachments: hasAttachment(m.bodyStructure),
    ...(m.size !== undefined ? { size: m.size } : {}),
    ...(e.messageId ? { messageId: stripId(e.messageId) } : {}),
    ...(e.inReplyTo ? { inReplyTo: stripId(e.inReplyTo) } : {}),
    ...(refs.length ? { references: refs } : {}),
  };
}

const LIST_QUERY: FetchQuery = { uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true };
const THREAD_QUERY: FetchQuery = { ...LIST_QUERY, headers: ['references'] };

const isConnectionError = (e: unknown): boolean => {
  const code = (e as { code?: string } | undefined)?.code ?? '';
  const msg = e instanceof Error ? e.message : '';
  return /ECONNRESET|EPIPE|ETIMEDOUT|NoConnection|ECONNREFUSED/.test(code) || /Connection (closed|not available)|socket|ECONNRESET/i.test(msg);
};

const containsCI = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
const addrText = (a: Address[]) => a.map((x) => `${x.name ?? ''} ${x.address ?? ''}`).join(' ');

/** Checks the criteria locally against a summary (to compensate for gaps in the server search). */
function matchesLocally(s: MessageSummary, c: SearchCriteria): boolean {
  if (c.from && !containsCI(addrText(s.from), c.from)) return false;
  if (c.to && !containsCI(addrText([...s.to, ...s.cc]), c.to)) return false;
  if (c.subject && !containsCI(s.subject, c.subject)) return false;
  // Full text: the body cannot be checked locally, but the decoded headers (subject, sender, recipients) can.
  if (c.text && !containsCI(`${s.subject} ${addrText(s.from)} ${addrText(s.to)} ${addrText(s.cc)}`, c.text)) return false;
  if (c.unreadOnly && !s.unread) return false;
  if (c.since || c.before) {
    const t = Date.parse(s.date);
    if (Number.isNaN(t)) return false;
    if (c.since && t < c.since.getTime()) return false;
    if (c.before && t >= c.before.getTime()) return false;
  }
  return true;
}

/**
 * Read-only IMAP access to iCloud Mail. One connection is reused, operations run one after another.
 * Mailboxes are only opened with EXAMINE (read-only), contents are only fetched with BODY.PEEK.
 */
export class ImapGateway implements MailReader, DraftStore, MailTrasher {
  private client?: ImapLike;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    cfg: Config,
    private readonly factory: () => ImapLike = defaultImapFactory(cfg),
  ) {}

  private drop(): void {
    const c = this.client;
    this.client = undefined;
    try {
      c?.close();
    } catch {
      /* already closed */
    }
  }

  private async ensure(): Promise<ImapLike> {
    if (this.client?.usable) return this.client;
    this.drop();
    const c = this.factory();
    c.on('error', () => {});
    c.on('close', () => {
      if (this.client === c) this.client = undefined;
    });
    try {
      await withTimeout(c.connect(), CONNECT_TIMEOUT_MS, 'signing in to iCloud Mail');
    } catch (e) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
      if ((e as { authenticationFailed?: boolean } | undefined)?.authenticationFailed) {
        throw new UserError('Sign-in to iCloud Mail failed. Check the iCloud mail address (@icloud.com) and the app-specific password in the extension settings.');
      }
      throw e;
    }
    this.client = c;
    return c;
  }

  /** Runs an operation on the shared connection (sequentially, with one retry if the connection drops). */
  private async run<T>(what: string, fn: (c: ImapLike) => Promise<T>, retry = true): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    await prev.catch(() => undefined);
    try {
      for (let attempt = 0; ; attempt++) {
        const c = await this.ensure();
        try {
          return await withTimeout(fn(c), OP_TIMEOUT_MS, what);
        } catch (e) {
          if (e instanceof UserError && /timed? ?out/i.test(e.message)) this.drop();
          else if (isConnectionError(e)) this.drop();
          if (retry && attempt === 0 && isConnectionError(e)) {
            log('imap-reconnect');
            continue;
          }
          throw e;
        }
      }
    } finally {
      release();
    }
  }

  private async inMailbox<T>(c: ImapLike, path: string, fn: (uidValidity: string, exists: number) => Promise<T>): Promise<T> {
    let lock: { release(): void };
    try {
      lock = await c.getMailboxLock(path, { readOnly: true });
    } catch (e) {
      if (isConnectionError(e)) throw e;
      throw new UserError(`Could not open the folder "${clip(path, 100)}". Use list_mailboxes to check the available folders.`);
    }
    try {
      const mb = c.mailbox;
      if (!mb) throw new UserError('Could not open the folder.');
      return await fn(String(mb.uidValidity), mb.exists);
    } finally {
      lock.release();
    }
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    return this.run('loading the folders', async (c) => {
      const entries = await c.list({ statusQuery: { messages: true, unseen: true } });
      return entries
        .filter((e) => !e.flags?.has('\\Noselect') && !e.flags?.has('\\NonExistent'))
        .map((e) => {
          const byFlag = roleFromFlags(e.flags);
          const role = e.path.toUpperCase() === 'INBOX' ? 'inbox' : (byFlag ?? (e.specialUse ? ROLE_BY_USE[e.specialUse] : undefined));
          const roleBy = e.path.toUpperCase() === 'INBOX' ? undefined : byFlag ? ('flag' as const) : role ? ('name' as const) : undefined;
          return {
            path: e.path,
            name: e.name,
            ...(role ? { role } : {}),
            ...(roleBy ? { roleBy } : {}),
            ...(e.status?.messages !== undefined ? { messages: e.status.messages } : {}),
            ...(e.status?.unseen !== undefined ? { unseen: e.status.unseen } : {}),
          };
        });
    });
  }

  async listRecent(path: string, count: number): Promise<MessageSummary[]> {
    return this.run('loading the messages', (c) =>
      this.inMailbox(c, path, async (uv, exists) => {
        if (!exists) return [];
        const from = Math.max(1, exists - count + 1);
        const out: MessageSummary[] = [];
        for await (const m of c.fetch(`${from}:*`, LIST_QUERY)) out.push(summarize(m, path, uv));
        return out.sort(byNewest).slice(0, count);
      }),
    );
  }

  async search(path: string, crit: SearchCriteria, caps: { limit: number; localPass: number }): Promise<{ total: number; messages: MessageSummary[] }> {
    return this.run(`searching "${clip(path, 60)}"`, (c) =>
      this.inMailbox(c, path, async (uv, exists) => {
        const q: SearchQuery = {};
        if (crit.from) q.from = crit.from;
        if (crit.to) q.to = crit.to;
        if (crit.subject) q.subject = crit.subject;
        if (crit.text) q.text = crit.text;
        if (crit.since) q.since = crit.since;
        if (crit.before) q.before = crit.before;
        if (crit.unreadOnly) q.seen = false;
        if (!Object.keys(q).length) q.all = true;

        const found = (await c.search(q, { uid: true })) || [];
        const newest = [...found].sort((a, b) => b - a).slice(0, DETAIL_CAP);
        const byUid = new Map<number, MessageSummary>();
        if (newest.length) {
          for await (const m of c.fetch(newest.join(','), LIST_QUERY, { uid: true })) byUid.set(m.uid, summarize(m, path, uv));
        }
        let total = found.length;

        // iCloud's server-side search does not always find MIME-encoded subjects or short search terms (not even with TEXT).
        // Workaround: check the newest messages locally against their decoded headers.
        const localEligible = crit.from || crit.to || crit.subject || crit.text;
        if (localEligible && caps.localPass > 0 && byUid.size < caps.limit && exists > 0) {
          const from = Math.max(1, exists - caps.localPass + 1);
          for await (const m of c.fetch(`${from}:*`, LIST_QUERY)) {
            if (byUid.has(m.uid)) continue;
            const s = summarize(m, path, uv);
            if (matchesLocally(s, crit)) {
              byUid.set(m.uid, s);
              total++;
            }
          }
        }
        return { total, messages: [...byUid.values()].sort(byNewest) };
      }),
    );
  }

  async fetchSource(ref: MessageRef): Promise<{ source: Buffer; summary: MessageSummary; truncated: boolean }> {
    return this.run('loading the message', (c) =>
      this.inMailbox(c, ref.path, async (uv) => {
        if (uv !== ref.uidValidity) {
          throw new UserError('The message ID is stale (the folder was rebuilt). Please find the message again with list_recent or search_messages.');
        }
        const m = await c.fetchOne(String(ref.uid), { ...LIST_QUERY, source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true });
        if (!m || !m.source) {
          throw new UserError('Message not found. It may have been moved or deleted; please search again with search_messages.');
        }
        return { source: m.source, summary: summarize(m, ref.path, uv), truncated: (m.size ?? 0) > MAX_SOURCE_BYTES };
      }),
    );
  }

  async findRelated(path: string, ids: string[], limit: number): Promise<MessageSummary[]> {
    const clean = [...new Set(ids.map(stripId).filter(Boolean))].slice(0, 30);
    if (!clean.length) return [];
    return this.run(`searching the conversation in "${clip(path, 60)}"`, (c) =>
      this.inMailbox(c, path, async (uv) => {
        const uids = new Set<number>();
        for (const id of clean) {
          // iCloud only finds headers if the Message-ID is searched with angle brackets (without them: silently 0 hits).
          const b = `<${id}>`;
          const hits = await c.search(
            { or: [{ header: { 'message-id': b } }, { header: { 'in-reply-to': b } }, { header: { references: b } }] },
            { uid: true },
          );
          for (const u of hits || []) uids.add(u);
          if (uids.size >= limit * 2) break;
        }
        if (!uids.size) return [];
        const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
        const out: MessageSummary[] = [];
        for await (const m of c.fetch(newest.join(','), THREAD_QUERY, { uid: true })) out.push(summarize(m, path, uv));
        return out;
      }),
    );
  }

  /**
   * Stores a draft in the Drafts folder (IMAP APPEND with the flags \\Seen and \\Draft, as Apple Mail does for its own drafts). This is the only mail operation that writes.
   * No retry if the connection drops, so that two drafts are never created.
   */
  async appendDraft(grant: DraftGrant, raw: Buffer): Promise<{ mailbox: string; id?: string }> {
    if (!DraftGrant.isValid(grant)) throw new Error('Write access without a grant');
    if (raw.length > MAX_DRAFT_BYTES) throw new UserError('The draft is too large. Please shorten the text.');
    return this.run(
      'storing the draft',
      async (c) => {
        const w = c as unknown as Partial<ImapAppend>;
        if (typeof w.append !== 'function') throw new Error('append not available');
        const r = await w.append(grant.mailbox, raw, ['\\Seen', '\\Draft'], new Date());
        if (!r) throw new UserError('iCloud did not accept the draft. Please try again later.');
        return {
          mailbox: grant.mailbox,
          ...(r.uid !== undefined && r.uidValidity !== undefined ? { id: encodeRef({ path: grant.mailbox, uidValidity: String(r.uidValidity), uid: r.uid }) } : {}),
        };
      },
      false,
    );
  }

  /** Summaries (subject, sender, …) of specific messages; folders are opened read-only, nothing is marked as read. */
  async summaries(refs: MessageRef[]): Promise<Array<MessageSummary | undefined>> {
    const out: Array<MessageSummary | undefined> = refs.map(() => undefined);
    for (const [path, group] of groupByPath(refs)) {
      await this.run('checking the messages', (c) =>
        this.inMailbox(c, path, async (uv) => {
          for (const { ref } of group) assertCurrent(uv, ref);
          const byUid = new Map<number, MessageSummary>();
          for await (const m of c.fetch(group.map((g) => g.ref.uid).join(','), CHECK_QUERY, { uid: true })) byUid.set(m.uid, summarize(m, path, uv));
          for (const { ref, index } of group) out[index] = byUid.get(ref.uid);
        }),
      );
    }
    return out;
  }

  /**
   * Moves messages to the Trash (IMAP UID MOVE). This is the only operation that removes messages from a folder.
   * Never \\Deleted, never EXPUNGE, no fallback to COPY: if the server rejects UID MOVE, nothing happens.
   * No retry if the connection drops.
   */
  async moveToTrash(grant: TrashGrant, refs: MessageRef[]): Promise<{ trash: string; moved: number }> {
    if (!TrashGrant.isValid(grant)) throw new Error('Write access without a grant');
    if (refs.length === 0 || refs.length > grant.count) throw new Error('Count does not match the grant');
    for (const ref of refs) if (!grant.sources.has(ref.path) || ref.path === grant.trash) throw new Error('Folder not granted');
    // The target name is sent as a quoted string; iCloud calls the Trash "Deleted Messages". Unusual names are rejected.
    if (!/^[\x20-\x7e]{1,100}$/.test(grant.trash) || /["\\&]/.test(grant.trash)) {
      throw new UserError('The name of the Trash folder contains special characters that this connector cannot transmit safely. Nothing was moved.');
    }

    let moved = 0;
    for (const [path, group] of groupByPath(refs)) {
      try {
        await this.run(
          'moving to the Trash',
          async (c) => {
            const w = c as unknown as Partial<ImapMove>;
            if (typeof w.exec !== 'function' || typeof w.getMailboxLock !== 'function') throw new Error('MOVE not available');
            const lock = await w.getMailboxLock(path, { readOnly: false });
            try {
              const mb = c.mailbox;
              if (!mb) throw new UserError('Could not open the folder. Nothing was moved.');
              for (const { ref } of group) assertCurrent(String(mb.uidValidity), ref);
              try {
                const res = await w.exec('UID MOVE', [{ type: 'SEQUENCE', value: group.map((g) => g.ref.uid).join(',') }, { type: 'STRING', value: grant.trash }], {});
                res.next?.();
              } catch (e) {
                if (isConnectionError(e)) throw e;
                throw new UserError('iCloud rejected the move to the Trash (UID MOVE). Nothing was moved and nothing was deleted. Please move the mail to the Trash in Apple Mail.');
              }
            } finally {
              lock.release();
            }
          },
          false,
        );
      } catch (e) {
        if (moved > 0) {
          throw new UserError(`${moved} mail(s) were already moved to the Trash, the rest were not: ${e instanceof UserError ? e.message : 'unexpected error. Please check the Trash in Apple Mail.'}`);
        }
        throw e;
      }
      moved += group.length;
    }
    return { trash: grant.trash, moved };
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    try {
      await c?.logout();
    } catch {
      c?.close();
    }
  }
}

/** The check before moving only needs headers and flags (no content, nothing is marked as read). */
const CHECK_QUERY: FetchQuery = { uid: true, flags: true, envelope: true, internalDate: true };

function groupByPath(refs: MessageRef[]): Map<string, Array<{ ref: MessageRef; index: number }>> {
  const groups = new Map<string, Array<{ ref: MessageRef; index: number }>>();
  refs.forEach((ref, index) => {
    const g = groups.get(ref.path) ?? [];
    g.push({ ref, index });
    groups.set(ref.path, g);
  });
  return groups;
}

function assertCurrent(uidValidity: string, ref: MessageRef): void {
  if (uidValidity !== ref.uidValidity) {
    throw new UserError('The message ID is stale (the folder was rebuilt). Nothing was moved. Please find the mail again with list_recent or search_messages.');
  }
}

function byNewest(a: MessageSummary, b: MessageSummary): number {
  return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.id.localeCompare(a.id);
}
