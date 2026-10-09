import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { DraftService, replySubject } from '../src/core/mail/draft.js';
import { ImapGateway, type ImapLike } from '../src/core/mail/imap.js';
import { MailService } from '../src/core/mail/service.js';
import { DraftGrant, authorizeDraft } from '../src/core/permissions.js';
import { createDraftSchema } from '../src/mcp/draftTools.js';
import { cfg } from './fakeStore.js';
import { MiniImap, rfc822, type MiniBox, type MiniMessage } from './miniImap.js';

const ME = cfg.mailUser; // me@icloud.com

const msg = (uid: number, flags: string[], subject: string, mid: string, from: string, extra: Partial<Parameters<typeof rfc822>[0]> = {}): MiniMessage => ({
  uid,
  flags,
  subject,
  from,
  messageId: `<${mid}>`,
  date: 'Wed, 07 Oct 2026 10:00:00 +0200',
  raw: rfc822({ from, subject, messageId: `<${mid}>`, date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: `Original of ${subject}\nsecond line`, ...extra }),
});

const boxes = (withDrafts = true): Record<string, MiniBox> => ({
  INBOX: {
    uidValidity: 1700,
    messages: [
      msg(1, [], 'Hello', 'a1@x', 'Anna Example <anna@example.com>', { references: '<r0@x>' }),
      msg(2, ['\\Seen'], 'AW: Meeting', 'a2@x', 'Bernd <bernd@example.com>'),
    ],
  },
  'Sent Messages': {
    special: '\\Sent',
    uidValidity: 1800,
    messages: [msg(1, ['\\Seen'], 'My text', 's1@x', ME, { to: 'Carla <carla@example.com>' })],
  },
  ...(withDrafts ? { Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] } } : {}),
});

let server: MiniImap;
let gateway: ImapGateway;
let mail: MailService;
let drafts: DraftService;

async function setup(withDrafts = true) {
  server = new MiniImap(boxes(withDrafts));
  server.allowAppend = new Set(['Drafts']);
  await server.start();
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  mail = new MailService(cfg, gateway);
  drafts = new DraftService(cfg, gateway, gateway, () => mail.mailboxes());
}

beforeAll(() => setup(), 30_000);
afterAll(async () => {
  await gateway.close();
  await server.stop();
});

const lastDraft = async () => simpleParser(Buffer.from(server.appends[server.appends.length - 1]!.raw));
const inboxId = async (subject: string) => (await mail.listRecent('INBOX', 10)).messages.find((m) => m.subject === subject)!.id;
const addrs = (a: unknown) => (a && typeof a === 'object' && 'value' in a ? (a as { value: Array<{ address?: string }> }).value.map((v) => v.address) : []);

describe('Create draft', () => {
  it('stores exactly one draft in the Drafts folder, with \\Draft and \\Seen, from the own address', async () => {
    const before = server.appends.length;
    const subject = 'Grüße aus Köln – prüfen 😀';
    const d = await drafts.createDraft({ to: [ME], subject, body: 'Liebe Grüße,\nTobi\n\nÄÖÜ ß' });
    expect(server.appends).toHaveLength(before + 1);
    const a = server.appends[before]!;
    expect(a.box).toBe('Drafts');
    expect(a.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']));
    const p = await lastDraft();
    expect(addrs(p.from)).toEqual([ME]);
    expect(addrs(p.to)).toEqual([ME]);
    expect(p.subject).toBe(subject);
    expect(p.text?.trim()).toBe('Liebe Grüße,\nTobi\n\nÄÖÜ ß');
    expect(p.headers.has('bcc')).toBe(false);
    expect(d).toMatchObject({ mailbox: 'Drafts', from: ME, to: [ME], quoted: false });
    expect(d.id).toMatch(/^Drafts\|1900\|\d+$/);
    expect(d.note).toContain('NOT sent');
  });

  it('the draft appears in Drafts, marked as draft and not as unread', async () => {
    const r = await mail.listRecent('drafts', 10);
    expect(r.messages.length).toBeGreaterThanOrEqual(1);
    expect(r.messages[0]).toMatchObject({ draft: true, unread: false });
  });

  it('nothing else is ever changed: only APPEND, only to Drafts, otherwise only EXAMINE and read commands', () => {
    expect(server.violations).toEqual([]);
    expect(server.commands.filter((c) => c.startsWith('APPEND')).every((c) => c.startsWith('APPEND "Drafts" (\\Seen \\Draft)') || c.startsWith('APPEND "Drafts" (\\Draft \\Seen)'))).toBe(true);
    const verbs = server.commands.map((c) => c.split(' ')[c.startsWith('UID') ? 1 : 0]);
    for (const v of ['STORE', 'COPY', 'MOVE', 'EXPUNGE', 'DELETE', 'CREATE', 'RENAME', 'SELECT']) expect(verbs, v).not.toContain(v);
  });

  it('existing messages stay unchanged (flags in inbox and sent)', async () => {
    const snap = JSON.stringify([server.flagsSnapshot().INBOX, server.flagsSnapshot()['Sent Messages']]);
    await drafts.createDraft({ to: [ME], subject: 'Another one', body: 'x' });
    expect(JSON.stringify([server.flagsSnapshot().INBOX, server.flagsSnapshot()['Sent Messages']])).toBe(snap);
  });
});

describe('Reply draft', () => {
  it('sets In-Reply-To, References, "Re:" and quotes; the recipient is the sender of the original', async () => {
    const id = await inboxId('Hello');
    const d = await drafts.createDraft({ body: 'Thanks, works for me!', replyToId: id });
    const p = await lastDraft();
    expect(p.subject).toBe('Re: Hello');
    expect(addrs(p.to)).toEqual(['anna@example.com']);
    expect(p.inReplyTo).toBe('<a1@x>');
    expect(p.references).toEqual(['<r0@x>', '<a1@x>']);
    const text = p.text!.replace(/\r\n/g, '\n');
    expect(text.startsWith('Thanks, works for me!')).toBe(true);
    expect(text).toMatch(/On Oct 7, 2026, at 10:00, Anna Example <anna@example\.com> wrote:/);
    expect(text).toContain('> Original of Hello\n> second line');
    expect(d).toMatchObject({ quoted: true, inReplyTo: 'a1@x' });
  });

  it('without quote: no ">" in the text', async () => {
    await drafts.createDraft({ body: 'Short.', replyToId: await inboxId('Hello'), quote: false });
    const p = await lastDraft();
    expect(p.text).not.toContain('>');
    expect(p.inReplyTo).toBe('<a1@x>');
  });

  it('uses the given subject and recipients when specified', async () => {
    await drafts.createDraft({ body: 'x', replyToId: await inboxId('Hello'), subject: 'Other subject', to: [ME], cc: ['c@example.com'] });
    const p = await lastDraft();
    expect(p.subject).toBe('Other subject');
    expect(addrs(p.to)).toEqual([ME]);
    expect(addrs(p.cc)).toEqual(['c@example.com']);
  });

  it('a reply to one of the own messages goes to its recipients', async () => {
    const sent = (await mail.listRecent('sent', 5)).messages[0]!;
    await drafts.createDraft({ body: 'Follow-up', replyToId: sent.id });
    const p = await lastDraft();
    expect(addrs(p.to)).toEqual(['carla@example.com']);
    expect(p.subject).toBe('Re: My text');
  });

  it('does not add "Re:" twice', () => {
    expect(replySubject('AW: Meeting')).toBe('AW: Meeting');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('Hello')).toBe('Re: Hello');
  });

  it('reading for the reply changes no flags (original stays unread)', async () => {
    const before = JSON.stringify(server.flagsSnapshot().INBOX);
    await drafts.createDraft({ body: 'x', replyToId: await inboxId('Hello') });
    expect(JSON.stringify(server.flagsSnapshot().INBOX)).toBe(before);
    expect((await mail.listRecent('INBOX', 10)).messages.find((m) => m.subject === 'Hello')!.unread).toBe(true);
  });
});

describe('Conversation with drafts (iCloud only searches headers with angle brackets)', () => {
  it('get_thread finds the original of a reply draft in the Drafts folder', async () => {
    const first = await drafts.createDraft({ to: [ME], subject: 'Thread start', body: 'one' });
    const reply = await drafts.createDraft({ body: 'two', replyToId: first.id! });
    const t = await mail.getThread(reply.id!, { includeText: false });
    expect(t.messages.map((m) => m.id).sort()).toEqual([first.id, reply.id].sort());
  });
  it('header searches use angle brackets', () => {
    const searches = server.commands.filter((c) => /SEARCH/.test(c) && /HEADER/i.test(c));
    expect(searches.length).toBeGreaterThan(0);
    for (const c of searches) for (const m of c.matchAll(/HEADER\s+"?[\w-]+"?\s+("[^"]*"|\S+)/gi)) expect(m[1]!.replace(/^"|"$/g, ''), c).toMatch(/^<.*>$/);
  });
});

describe('Rejections: nothing is written', () => {
  let before: number;
  beforeEach(() => {
    before = server.appends.length;
  });
  const none = () => expect(server.appends).toHaveLength(before);

  it.each([
    ['invalid address', { to: ['no-at'], subject: 's', body: 'x' }, /email address/],
    ['injected Bcc line in the address', { to: ['a@b.de\r\nBcc: x@y.de'], subject: 's', body: 'x' }, /control characters|email address/],
    ['empty text', { to: [ME], subject: 's', body: '   \n ' }, /must not be empty/],
    ['no recipient', { subject: 's', body: 'x' }, /recipient/],
    ['no subject', { to: [ME], body: 'x' }, /subject/],
    ['too many recipients', { to: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`), subject: 's', body: 'x' }, /Too many recipients/],
    ['text too long', { to: [ME], subject: 's', body: 'a'.repeat(20001) }, /text is too long/],
    ['subject too long', { to: [ME], subject: 's'.repeat(301), body: 'x' }, /subject is too long/],
    ['unknown reply ID', { body: 'x', replyToId: 'broken' }, /Invalid message ID/],
  ])('%s', async (_n, input, msgRe) => {
    await expect(drafts.createDraft(input as never)).rejects.toThrow(msgRe);
    none();
  });

  it('stale reply ID', async () => {
    const id = (await inboxId('Hello')).replace('|1700|', '|5|');
    await expect(drafts.createDraft({ body: 'x', replyToId: id })).rejects.toThrow(/stale/);
    none();
  });

  it('injected lines in the subject do not create a Bcc header', async () => {
    await drafts.createDraft({ to: [ME], subject: 'Hi\r\nBcc: evil@example.com', body: 'x' });
    const p = await lastDraft();
    expect(p.headers.has('bcc')).toBe(false);
    expect(addrs(p.to)).toEqual([ME]);
  });
});

describe('Permissions', () => {
  it('the schema accepts neither Bcc, sender nor attachments', () => {
    const ok = createDraftSchema.safeParse({ to: [ME], subject: 's', body: 'x' });
    expect(ok.success).toBe(true);
    for (const field of ['bcc', 'from', 'sender', 'attachments', 'reply_to', 'send', 'mailbox', 'folder', 'flags']) {
      expect(createDraftSchema.safeParse({ to: [ME], subject: 's', body: 'x', [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('the gateway does not write without a grant (not even with a forged grant)', async () => {
    await expect(gateway.appendDraft(undefined as never, Buffer.from('x'))).rejects.toThrow(/without a grant/);
    await expect(gateway.appendDraft({ mailbox: 'INBOX' } as never, Buffer.from('x'))).rejects.toThrow(/without a grant/);
    expect(DraftGrant.isValid({ mailbox: 'Drafts' })).toBe(false);
  });

  it('the target folder is always the Drafts folder (SPECIAL-USE), never freely chosen', () => {
    const grant = authorizeDraft([
      { path: 'INBOX', name: 'INBOX', role: 'inbox' },
      { path: 'Entwürfe-Neu', name: 'Entwürfe-Neu', role: 'drafts' },
      { path: 'Drafts', name: 'Drafts' },
    ]);
    expect(grant.mailbox).toBe('Entwürfe-Neu');
  });

  it('rejects when there is no Drafts folder (or several)', () => {
    expect(() => authorizeDraft([{ path: 'INBOX', name: 'INBOX', role: 'inbox' }])).toThrow(/No Drafts folder/);
    expect(() => authorizeDraft([{ path: 'A', name: 'A', role: 'drafts' }, { path: 'B', name: 'B', role: 'drafts' }])).toThrow(/several Drafts folders/);
  });

  it('no Drafts folder on the server: nothing is written', async () => {
    const s2 = new MiniImap(boxes(false));
    await s2.start();
    const g2 = new ImapGateway(
      cfg,
      () => new ImapFlow({ host: '127.0.0.1', port: s2.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike,
    );
    const m2 = new MailService(cfg, g2);
    const d2 = new DraftService(cfg, g2, g2, () => m2.mailboxes());
    try {
      await expect(d2.createDraft({ to: [ME], subject: 's', body: 'x' })).rejects.toThrow(/No Drafts folder/);
      expect(s2.appends).toHaveLength(0);
      expect(s2.commands.filter((c) => c.startsWith('APPEND'))).toEqual([]);
    } finally {
      await g2.close();
      await s2.stop();
    }
  });
});

describe('The code has exactly one write access to mail', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('.append( occurs only once, in ImapGateway.appendDraft, after the grant check', () => {
    const hits = files('src').filter((f) => /\.append\(|\bappend\(/.test(code(f)));
    expect(hits).toEqual([join('src', 'core', 'mail', 'imap.ts')]);
    const text = code(join('src', 'core', 'mail', 'imap.ts'));
    expect(text.match(/w\.append\(/g)).toHaveLength(1);
    expect(text.indexOf('DraftGrant.isValid')).toBeGreaterThan(-1);
    expect(text.indexOf('DraftGrant.isValid')).toBeLessThan(text.indexOf('w.append('));
  });

  it('there is no sending: no SMTP library, no transport, no tool for sending', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /nodemailer|smtp|sendmail/i.test(d))).toEqual([]);
    for (const f of files('src')) expect(code(f), f).not.toMatch(/createTransport|sendMail|smtp\.|:587|:465/i);
  });
});
