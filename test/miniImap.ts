/**
 * Minimal IMAP server for tests. Speaks enough IMAP for imapflow and logs every command.
 * Behaves like a real server: a client that opens a mailbox with SELECT (read-write) and fetches the content without PEEK
 * marks the message as read. Changes (STORE, COPY, APPEND, …) are recorded as violations.
 */
import net from 'node:net';

export interface MiniMessage {
  uid: number;
  flags: string[];
  /** Raw source (RFC 822) */
  raw: string;
  subject: string;
  from: string;
  messageId: string;
  date: string;
  attachment?: boolean;
}

export interface MiniBox {
  special?: string;
  uidValidity: number;
  messages: MiniMessage[];
}

const MUTATING = /^(COPY|APPEND|EXPUNGE|DELETE|CREATE|RENAME|SUBSCRIBE|UNSUBSCRIBE|SETACL|SETQUOTA|REPLACE)$/i;

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function addr(s: string): string {
  const m = /^(.*?)\s*<(.+)@(.+)>$/.exec(s);
  if (m) return `((${q(m[1]!.replace(/"/g, ''))} NIL ${q(m[2]!)} ${q(m[3]!)}))`;
  const p = /^([^@\s]+)@(\S+)$/.exec(s.trim());
  return p ? `((NIL NIL ${q(p[1]!)} ${q(p[2]!)}))` : 'NIL';
}

function envelope(m: MiniMessage, inReplyTo?: string): string {
  return `(${q(m.date)} ${q(m.subject)} ${addr(m.from)} ${addr(m.from)} ${addr(m.from)} ${addr('Me <me@icloud.com>')} NIL NIL ${inReplyTo ? q(inReplyTo) : 'NIL'} ${q(m.messageId)})`;
}

/* ---- A small MIME parser: real multipart messages get a correct BODYSTRUCTURE and addressable parts ---- */

interface MimeNode {
  part: string;
  type: string;
  subtype: string;
  params: Record<string, string>;
  encoding: string;
  disposition?: string;
  filename?: string;
  body: string;
  children: MimeNode[];
}

function paramsOf(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of value.matchAll(/;\s*([\w*-]+)\s*=\s*(?:"([^"]*)"|([^;\s]+))/g)) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  return out;
}

export function parseMime(raw: string, part = ''): MimeNode {
  const i = raw.indexOf('\r\n\r\n');
  const head = (i >= 0 ? raw.slice(0, i) : raw).replace(/\r\n[ \t]+/g, ' ');
  const body = i >= 0 ? raw.slice(i + 4) : '';
  const h = (n: string) => new RegExp(`^${n}:[ \\t]*(.*)$`, 'im').exec(head)?.[1]?.trim() ?? '';
  const ct = h('Content-Type') || 'text/plain';
  const [mime = 'text/plain'] = ct.split(';');
  const [type = 'text', subtype = 'plain'] = mime.trim().toLowerCase().split('/');
  const params = paramsOf(ct);
  const cd = h('Content-Disposition');
  const node: MimeNode = {
    part,
    type,
    subtype,
    params,
    encoding: (h('Content-Transfer-Encoding') || '7bit').toLowerCase(),
    ...(cd ? { disposition: cd.split(';')[0]!.trim().toLowerCase() } : {}),
    ...(cd && paramsOf(cd).filename ? { filename: paramsOf(cd).filename! } : {}),
    body,
    children: [],
  };
  if (type === 'multipart' && params.boundary) {
    const marker = `--${params.boundary}`;
    const chunks = body.split(marker).slice(1).filter((c) => !c.startsWith('--'));
    node.children = chunks.map((c, k) => parseMime(c.replace(/^\r\n/, '').replace(/\r\n$/, ''), `${part}${part ? '.' : ''}${k + 1}`));
  }
  return node;
}

const isMultipartRaw = (raw: string) => /^Content-Type:\s*multipart\//im.test(raw.slice(0, raw.indexOf('\r\n\r\n') >= 0 ? raw.indexOf('\r\n\r\n') : raw.length));

function structureOf(n: MimeNode): string {
  const params = Object.entries(n.params).filter(([k]) => k !== 'boundary' || n.type === 'multipart');
  const plist = params.length ? `(${params.map(([k, v]) => `${q(k.toUpperCase())} ${q(v)}`).join(' ')})` : 'NIL';
  if (n.type === 'multipart') return `(${n.children.map(structureOf).join('')} ${q(n.subtype.toUpperCase())} ${plist} NIL NIL)`;
  const disp = n.disposition ? `(${q(n.disposition.toUpperCase())} ${n.filename ? `(${q('FILENAME')} ${q(n.filename)})` : 'NIL'})` : 'NIL';
  const size = Buffer.byteLength(n.body);
  const lines = n.type === 'text' ? ` ${n.body.split('\n').length}` : '';
  return `(${q(n.type.toUpperCase())} ${q(n.subtype.toUpperCase())} ${plist} NIL NIL ${q(n.encoding.toUpperCase())} ${size}${lines} NIL ${disp} NIL)`;
}

function findPart(n: MimeNode, part: string): MimeNode | undefined {
  if ((n.part || '1') === part && n.type !== 'multipart') return n;
  for (const c of n.children) {
    const hit = findPart(c, part);
    if (hit) return hit;
  }
  return undefined;
}

function bodyStructure(m: MiniMessage): string {
  if (isMultipartRaw(m.raw)) return structureOf(parseMime(m.raw));
  const text = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 100 5 NIL NIL NIL)';
  if (!m.attachment) return text;
  return `(${text}("APPLICATION" "PDF" ("NAME" "invoice.pdf") NIL NIL "BASE64" 1000 NIL ("ATTACHMENT" ("FILENAME" "invoice.pdf")) NIL) "MIXED" ("BOUNDARY" "b") NIL NIL)`;
}

/** Sequence sets like "1:*", "3", "1,2,5:7". */
function expand(set: string, max: number): number[] {
  const out: number[] = [];
  for (const part of set.split(',')) {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    for (let i = Math.min(lo, hi); i <= Math.max(lo, hi); i++) out.push(i);
  }
  return out;
}

export class MiniImap {
  /** All received commands (without tag, password redacted). */
  commands: string[] = [];
  violations: string[] = [];
  /** Folders where an APPEND with \\Draft is allowed (empty = every APPEND is a violation). */
  allowAppend = new Set<string>();
  appends: Array<{ box: string; flags: string[]; raw: string }> = [];
  /** Folders that may be opened read-write (SELECT). Otherwise every SELECT is a violation. */
  allowWriteSelect = new Set<string>();
  /** Target folders that MOVE may move into. Otherwise every MOVE is a violation. */
  allowMove = new Set<string>();
  /** Successfully executed moves. */
  moves: Array<{ from: string; to: string; uids: number[] }> = [];
  /** Flags that STORE may set or clear (empty = every STORE is a violation). */
  allowStoreFlags = new Set<string>();
  /** Successfully executed STOREs. */
  stores: Array<{ box: string; uids: number[]; op: '+' | '-'; flags: string[] }> = [];
  private server?: net.Server;
  port = 0;

  /** MOVE attempts the server rejected as an unknown command (only with move: false). */
  rejectedMoves: string[] = [];

  /**
   * move: the server understands (UID) MOVE. Otherwise it answers with BAD, like a server without the extension.
   * advertiseMove: it lists MOVE in its capabilities (default: same as move). iCloud understands MOVE but does not list it (verified live).
   */
  constructor(
    public boxes: Record<string, MiniBox>,
    private readonly opts: { move?: boolean; advertiseMove?: boolean; noCopyUid?: boolean } = {},
  ) {}

  private get caps(): string {
    return `IMAP4rev1 UIDPLUS${this.opts.advertiseMove ?? this.opts.move ? ' MOVE' : ''}`;
  }

  flagsSnapshot(): Record<string, Record<number, string[]>> {
    return Object.fromEntries(Object.entries(this.boxes).map(([n, b]) => [n, Object.fromEntries(b.messages.map((m) => [m.uid, [...m.flags].sort()]))]));
  }

  async start(): Promise<void> {
    this.server = net.createServer((sock) => this.session(sock));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.port = (this.server!.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private session(sock: net.Socket): void {
    let buf = '';
    let selected: { name: string; readOnly: boolean } | undefined;
    const send = (s: string) => sock.write(s);
    send(`* OK [CAPABILITY ${this.caps}] ready\r\n`);

    const handle = (line: string) => {
      const m = /^(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!m) return;
      const [, tag, cmdRaw, rest = ''] = m;
      let cmd = cmdRaw!.toUpperCase();
      let args = rest;
      let byUid = false;
      if (cmd === 'UID') {
        byUid = true;
        const m2 = /^(\S+)\s*(.*)$/.exec(rest)!;
        cmd = m2[1]!.toUpperCase();
        args = m2[2]!;
      }
      this.commands.push(cmd === 'LOGIN' ? 'LOGIN ***' : `${byUid ? 'UID ' : ''}${cmd} ${args}`.trim());
      const ok = (text = 'done') => send(`${tag} OK ${text}\r\n`);
      if (MUTATING.test(cmd)) {
        this.violations.push(`${byUid ? 'UID ' : ''}${cmd} ${args}`);
        return send(`${tag} NO not allowed in test\r\n`);
      }
      const boxNames = Object.keys(this.boxes);
      const flagsOf = (b: MiniBox) => b.special;
      switch (cmd) {
        case 'CAPABILITY':
          send(`* CAPABILITY ${this.caps}\r\n`);
          return ok();
        case 'LOGIN':
          return send(`${tag} OK [CAPABILITY ${this.caps}] Logged in\r\n`);
        case 'LIST':
        case 'LSUB':
          // LIST "" "" only asks for the hierarchy delimiter
          if (/^""\s+""\s*$/.test(args.trim())) {
            send(`* ${cmd} (\\Noselect) "/" ""\r\n`);
            return ok();
          }
          for (const n of boxNames) send(`* ${cmd} (\\HasNoChildren${flagsOf(this.boxes[n]!) ? ' ' + flagsOf(this.boxes[n]!) : ''}) "/" ${q(n)}\r\n`);
          return ok();
        case 'STATUS': {
          const name = /^"?([^"]+)"?/.exec(args)![1]!;
          const b = this.boxes[name];
          if (!b) return send(`${tag} NO no such mailbox\r\n`);
          const unseen = b.messages.filter((x) => !x.flags.includes('\\Seen')).length;
          send(`* STATUS ${q(name)} (MESSAGES ${b.messages.length} UNSEEN ${unseen})\r\n`);
          return ok();
        }
        case 'EXAMINE':
        case 'SELECT': {
          const name = /^"?([^"]+)"?/.exec(args)![1]!;
          const b = this.boxes[name];
          if (!b) return send(`${tag} NO no such mailbox\r\n`);
          selected = { name, readOnly: cmd === 'EXAMINE' };
          if (cmd === 'SELECT' && !this.allowWriteSelect.has(name)) this.violations.push(`SELECT ${name} (opened read-write)`);
          send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
          send(`* ${b.messages.length} EXISTS\r\n* 0 RECENT\r\n`);
          send(`* OK [UIDVALIDITY ${b.uidValidity}] ok\r\n* OK [UIDNEXT ${Math.max(0, ...b.messages.map((x) => x.uid)) + 1}] ok\r\n`);
          return send(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] done\r\n`);
        }
        case 'MOVE': {
          // Allowed only with the capability, from a folder opened read-write into an allowed target folder.
          const mv = /^(\S+)\s+(.+)$/.exec(args);
          const dest = mv ? mv[2]!.trim().replace(/^"|"$/g, '') : '';
          if (!this.opts.move) {
            this.rejectedMoves.push(`${byUid ? 'UID ' : ''}MOVE ${args}`);
            return send(`${tag} BAD Command not recognized\r\n`);
          }
          if (!selected || selected.readOnly || !this.allowMove.has(dest)) {
            this.violations.push(`${byUid ? 'UID ' : ''}MOVE ${args}`);
            return send(`${tag} NO not allowed in test\r\n`);
          }
          const src = this.boxes[selected.name]!;
          const target = this.boxes[dest];
          if (!target) return send(`${tag} NO [TRYCREATE] no such mailbox\r\n`);
          const picks = (byUid ? expand(mv![1]!, Math.max(0, ...src.messages.map((x) => x.uid))) : expand(mv![1]!, src.messages.length))
            .map((n) => (byUid ? src.messages.find((x) => x.uid === n) : src.messages[n - 1]))
            .filter((x): x is MiniMessage => Boolean(x));
          if (!picks.length) return ok();
          const next = Math.max(0, ...target.messages.map((x) => x.uid)) + 1;
          const dstUids: number[] = [];
          const seqs: number[] = [];
          picks.forEach((msg, i) => {
            seqs.push(src.messages.indexOf(msg) + 1);
            dstUids.push(next + i);
            target.messages.push({ ...msg, uid: next + i, flags: [...msg.flags] });
          });
          src.messages = src.messages.filter((x) => !picks.includes(x));
          this.moves.push({ from: selected.name, to: dest, uids: picks.map((x) => x.uid) });
          if (!this.opts.noCopyUid) send(`* OK [COPYUID ${target.uidValidity} ${picks.map((x) => x.uid).join(',')} ${dstUids.join(',')}] moved\r\n`);
          for (const n of seqs.sort((a, b) => b - a)) send(`* ${n} EXPUNGE\r\n`);
          return ok('MOVE completed');
        }
        case 'STORE': {
          const st = /^(\S+)\s+([+-]?)FLAGS(\.SILENT)?\s+\(?([^)]*)\)?\s*$/i.exec(args);
          if (!selected || !st) return send(`${tag} BAD cannot parse\r\n`);
          const flags = st[4]!.split(/\s+/).filter(Boolean);
          if (selected.readOnly || !this.allowWriteSelect.has(selected.name) || !st[2] || flags.some((f) => !this.allowStoreFlags.has(f))) {
            this.violations.push(`${byUid ? 'UID ' : ''}STORE ${args}`);
            return send(`${tag} NO not allowed in test\r\n`);
          }
          const b = this.boxes[selected.name]!;
          const picks = (byUid ? expand(st[1]!, Math.max(0, ...b.messages.map((x) => x.uid))) : expand(st[1]!, b.messages.length))
            .map((n) => (byUid ? b.messages.find((x) => x.uid === n) : b.messages[n - 1]))
            .filter((x): x is MiniMessage => Boolean(x));
          for (const msg of picks) {
            msg.flags = st[2] === '+' ? [...new Set([...msg.flags, ...flags])] : msg.flags.filter((f) => !flags.includes(f));
            if (!st[3]) send(`* ${b.messages.indexOf(msg) + 1} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(' ')}))\r\n`);
          }
          this.stores.push({ box: selected.name, uids: picks.map((x) => x.uid), op: st[2] as '+' | '-', flags });
          return ok('STORE completed');
        }
        case 'CLOSE':
        case 'UNSELECT':
          selected = undefined;
          return ok();
        case 'NOOP':
          return ok();
        case 'LOGOUT':
          send('* BYE bye\r\n');
          ok();
          return sock.end();
        case 'SEARCH': {
          if (!selected) return send(`${tag} BAD no mailbox\r\n`);
          const b = this.boxes[selected.name]!;
          const upper = args.toUpperCase();
          const quoted = [...args.matchAll(/"([^"]*)"|(?<=\s)([^\s()"]+)(?=\s|\)|$)/g)].map((x) => (x[1] ?? x[2] ?? '').toLowerCase());
          // Like iCloud: header searches only find a Message-ID with angle brackets; without them there are 0 hits.
          const headerValues = [...args.matchAll(/HEADER\s+"?[\w-]+"?\s+("[^"]*"|\S+)/gi)].map((x) => x[1]!.replace(/^"|"$/g, '').toLowerCase());
          const badHeader = headerValues.filter((v) => !v.startsWith('<'));
          const goodHeader = headerValues.filter((v) => v.startsWith('<'));
          const skip = new Set(headerValues);
          const terms = [
            ...quoted.filter((t) => t && !skip.has(t) && !/^(or|header|from|to|subject|text|body|since|before|seen|unseen|all|message-id|in-reply-to|references|\d.*)$/i.test(t)),
            ...goodHeader,
          ];
          const hits = b.messages.filter((x) => {
            if (/\bUNSEEN\b/.test(upper) && x.flags.includes('\\Seen')) return false;
            if (terms.length === 0) return badHeader.length === 0;
            return terms.some((t) => x.raw.toLowerCase().includes(t));
          });
          send(`* SEARCH ${hits.map((x) => (byUid ? x.uid : b.messages.indexOf(x) + 1)).join(' ')}\r\n`.replace(/ \r\n$/, '\r\n'));
          return ok();
        }
        case 'FETCH': {
          if (!selected) return send(`${tag} BAD no mailbox\r\n`);
          const b = this.boxes[selected.name]!;
          const set = /^(\S+)\s+(.*)$/.exec(args)!;
          const attrs = set[2]!.replace(/^\(|\)$/g, '');
          const wanted = byUid ? expand(set[1]!, Math.max(...b.messages.map((x) => x.uid))) : expand(set[1]!, b.messages.length);
          const nonPeek = /BODY\[[^\]]*\]|\bRFC822(?:\.TEXT|\.HEADER)?(?![.\w])/i.test(attrs.replace(/BODY\.PEEK\[[^\]]*\]/gi, ''));
          for (const n of wanted) {
            const msg = byUid ? b.messages.find((x) => x.uid === n) : b.messages[n - 1];
            if (!msg) continue;
            const seq = b.messages.indexOf(msg) + 1;
            if (nonPeek) {
              this.violations.push(`FETCH without PEEK: ${attrs}`);
              if (!selected.readOnly && !msg.flags.includes('\\Seen')) msg.flags.push('\\Seen');
            }
            const parts: string[] = [`UID ${msg.uid}`];
            if (/\bFLAGS\b/i.test(attrs)) parts.push(`FLAGS (${msg.flags.join(' ')})`);
            if (/\bINTERNALDATE\b/i.test(attrs)) parts.push(`INTERNALDATE "07-Oct-2026 10:00:00 +0200"`);
            if (/\bRFC822\.SIZE\b/i.test(attrs)) parts.push(`RFC822.SIZE ${msg.raw.length}`);
            if (/\bENVELOPE\b/i.test(attrs)) parts.push(`ENVELOPE ${envelope(msg, /^In-Reply-To:\s*(<[^>]+>)/im.exec(msg.raw)?.[1])}`);
            if (/\bBODYSTRUCTURE\b/i.test(attrs)) parts.push(`BODYSTRUCTURE ${bodyStructure(msg)}`);
            const hdr = /BODY(?:\.PEEK)?\[(HEADER\.FIELDS[^\]]*)\]/i.exec(attrs);
            let literal: string | undefined;
            let literalKey = '';
            if (hdr) {
              const refs = /^References:.*$/im.exec(msg.raw)?.[0] ?? '';
              literal = refs ? `${refs}\r\n\r\n` : '\r\n';
              literalKey = `BODY[${hdr[1]}]`;
            } else if (/BODY(?:\.PEEK)?\[\]|\bRFC822(?![.\w])/i.test(attrs)) {
              literal = msg.raw;
              literalKey = /<\d+\.\d+>/.test(attrs) ? 'BODY[]<0>' : 'BODY[]';
            }
            let out = `* ${seq} FETCH (${parts.join(' ')}`;
            if (literal !== undefined) out += ` ${literalKey} {${Buffer.byteLength(literal)}}\r\n${literal}`;
            for (const pm of attrs.matchAll(/BODY(?:\.PEEK)?\[(\d+(?:\.\d+)*)\]/gi)) {
              const node = findPart(parseMime(msg.raw), pm[1]!);
              const content = node?.body.replace(/\r\n$/, '') ?? '';
              out += ` BODY[${pm[1]}] {${Buffer.byteLength(content)}}\r\n${content}`;
            }
            send(`${out})\r\n`);
          }
          return ok();
        }
        default:
          this.violations.push(`unknown command: ${cmd}`);
          return send(`${tag} BAD unknown\r\n`);
      }
    };

    let rest: Buffer = Buffer.alloc(0);
    let pending: { tag: string; box: string; flags: string[]; remaining: number } | undefined;
    const pump = () => {
      for (;;) {
        if (pending) {
          if (rest.length < pending.remaining) return;
          const content = Buffer.from(rest.subarray(0, pending.remaining)).toString('utf8');
          rest = Buffer.from(rest.subarray(pending.remaining));
          const { tag, box, flags } = pending;
          pending = undefined;
          const b = this.boxes[box];
          if (!b) {
            send(`${tag} NO [TRYCREATE] no such mailbox\r\n`);
            continue;
          }
          const uid = Math.max(0, ...b.messages.map((x) => x.uid)) + 1;
          const hdr = (n: string) => new RegExp(`^${n}:[ \\t]*(.*)$`, 'im').exec(content)?.[1]?.trim() ?? '';
          b.messages.push({ uid, flags, raw: content, subject: hdr('Subject'), from: hdr('From'), messageId: hdr('Message-ID'), date: hdr('Date') });
          this.appends.push({ box, flags, raw: content });
          send(`${tag} OK [APPENDUID ${b.uidValidity} ${uid}] done\r\n`);
          continue;
        }
        const i = rest.indexOf('\r\n');
        if (i < 0) return;
        const line = Buffer.from(rest.subarray(0, i)).toString('utf8');
        rest = Buffer.from(rest.subarray(i + 2));
        if (!line) continue;
        const ap = /^(\S+)\s+APPEND\s+"?([^"(]+?)"?\s*(?:\(([^)]*)\))?\s*(?:"[^"]*"\s*)?\{(\d+)(\+)?\}$/i.exec(line);
        if (ap) {
          const [, tag, box, flagText = '', len, nonSync] = ap;
          const flags = flagText.split(/\s+/).filter(Boolean);
          this.commands.push(`APPEND "${box}" (${flags.join(' ')})`);
          if (!this.allowAppend.has(box!) || !flags.includes('\\Draft')) this.violations.push(`APPEND ${box} (${flags.join(' ')})`);
          pending = { tag: tag!, box: box!, flags, remaining: Number(len) };
          if (!nonSync) send('+ ready\r\n');
          continue;
        }
        handle(line);
      }
    };
    sock.on('data', (d) => {
      rest = Buffer.concat([rest, typeof d === 'string' ? Buffer.from(d) : d]) as Buffer;
      pump();
    });
    sock.on('error', () => undefined);
  }
}

export const rfc822 = (o: { from: string; to?: string; subject: string; messageId: string; date: string; inReplyTo?: string; references?: string; body: string; html?: string }): string =>
  [
    `From: ${o.from}`,
    `To: ${o.to ?? 'Me <me@icloud.com>'}`,
    `Subject: ${o.subject}`,
    `Date: ${o.date}`,
    `Message-ID: ${o.messageId}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    o.body,
    '',
  ].join('\r\n');
