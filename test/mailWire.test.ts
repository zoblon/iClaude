import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapGateway, type ImapLike } from '../src/core/mail/imap.js';
import { MailService } from '../src/core/mail/service.js';
import { decodeRef } from '../src/core/mail/ref.js';
import { cfg } from './fakeStore.js';
import { MiniImap, rfc822, type MiniMessage } from './miniImap.js';

const msg = (uid: number, flags: string[], subject: string, mid: string, extra: Partial<Parameters<typeof rfc822>[0]> = {}, attachment = false): MiniMessage => ({
  uid,
  flags,
  subject,
  from: 'Anna Example <anna@example.com>',
  messageId: `<${mid}>`,
  date: 'Wed, 07 Oct 2026 10:00:00 +0200',
  attachment,
  raw: rfc822({ from: 'Anna Example <anna@example.com>', subject, messageId: `<${mid}>`, date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: `Content of ${subject}`, ...extra }),
});

function encodedSubjectMessage(): MiniMessage {
  const subject = 'Rechnungsübersicht Oktober';
  const m = msg(1, ['\\Seen'], subject, 'enc1@x');
  m.raw = rfc822({ from: 'Anna Example <anna@example.com>', subject: `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, messageId: '<enc1@x>', date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: 'No match in the text' });
  return m;
}

let server: MiniImap;
let gateway: ImapGateway;
let service: MailService;

beforeAll(async () => {
  server = new MiniImap({
    INBOX: { uidValidity: 1700, messages: [msg(1, [], 'Unread one', 'a1@x'), msg(2, [], 'Unread two', 'a2@x', {}, true), msg(3, ['\\Seen'], 'Read three', 'a3@x', { inReplyTo: '<a1@x>', references: '<a1@x>' })] },
    'Sent Messages': { special: '\\Sent', uidValidity: 1800, messages: [msg(1, ['\\Seen'], 'Re: Unread one', 'a4@x', { inReplyTo: '<a1@x>', references: '<a1@x>' })] },
    Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] },
    // MIME-encoded subject: the raw source only contains Base64, so the server's TEXT search does not find the word.
    Archive: { special: '\\Archive', uidValidity: 2000, messages: [encodedSubjectMessage()] },
  });
  await server.start();
  // Real imapflow client connected to the test server (without TLS).
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  service = new MailService(cfg, gateway);
}, 30_000);

afterAll(async () => {
  await gateway.close();
  await server.stop();
});

describe('Reading changes nothing (checked on the wire, real imapflow against the test server)', () => {
  it('all read tools one after another: flags stay exactly the same', async () => {
    const before = JSON.stringify(server.flagsSnapshot());
    expect((await service.mailboxes()).map((m) => m.path)).toContain('INBOX');
    await service.unreadCounts();
    const recent = await service.listRecent('inbox', 10);
    expect(recent.messages.map((m) => m.subject)).toEqual(expect.arrayContaining(['Unread one', 'Unread two', 'Read three']));
    await service.search({ subject: 'Unread' });
    await service.search({ unreadOnly: true });
    const unread = recent.messages.find((m) => m.subject === 'Unread two')!;
    const full = await service.getMessage(unread.id);
    expect(full.text).toContain('Content of Unread two');
    expect(full.attachments).toEqual([{ attachmentId: '2', filename: 'invoice.pdf', contentType: 'application/pdf', size: 750, inline: false }]); // attachment only in the test server's body structure, not in the raw source
    await service.getThread(unread.id);

    expect(JSON.stringify(server.flagsSnapshot())).toBe(before);
    expect(server.violations).toEqual([]);
  });

  it('the unread messages are still unread afterwards', async () => {
    const r = await service.listRecent('INBOX', 10);
    expect(r.messages.filter((m) => m.unread).map((m) => m.subject).sort()).toEqual(['Unread one', 'Unread two']);
  });

  it('every mailbox is opened with EXAMINE, never with SELECT', () => {
    const opens = server.commands.filter((c) => /^(SELECT|EXAMINE)\b/.test(c));
    expect(opens.length).toBeGreaterThan(3);
    expect(opens.every((c) => c.startsWith('EXAMINE'))).toBe(true);
  });

  it('contents are only fetched with BODY.PEEK', () => {
    const fetches = server.commands.filter((c) => /FETCH/.test(c));
    expect(fetches.some((c) => /BODY\.PEEK\[\]/.test(c))).toBe(true);
    for (const c of fetches) {
      expect(c.replace(/BODY\.PEEK\[[^\]]*\]/g, ''), c).not.toMatch(/BODY\[|RFC822(?![.\w])/);
    }
  });

  it('nothing is ever changed: no STORE, COPY, MOVE, APPEND, EXPUNGE, DELETE, CREATE', () => {
    const sent = server.commands.map((c) => c.split(' ').slice(0, 2).join(' '));
    for (const verb of ['STORE', 'COPY', 'MOVE', 'APPEND', 'EXPUNGE', 'DELETE', 'CREATE', 'RENAME', 'SUBSCRIBE']) {
      expect(sent.filter((c) => new RegExp(`(^|\\s)${verb}$`).test(c)), verb).toEqual([]);
    }
  });

  it('the test server would have noticed a violation: opening read-write marks as read', async () => {
    // Counter-check: with a careless client (SELECT, without PEEK) the server would set the flag.
    const bad = new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true });
    bad.on('error', () => undefined);
    await bad.connect();
    const lock = await bad.getMailboxLock('INBOX'); // read-write
    try {
      const m = await bad.fetchOne('1', { uid: true, flags: true }, { uid: true });
      expect(m && m.flags && m.flags.has('\\Seen')).toBeFalsy();
    } finally {
      lock.release();
      await bad.logout();
    }
    expect(server.violations.some((v) => v.startsWith('SELECT'))).toBe(true);
    server.violations.length = 0; // reset after the counter-check
  });
});

describe('Search compensates for weaknesses of the iCloud server search', () => {
  it('finds a word from a MIME-encoded subject even with full-text search (TEXT)', async () => {
    const raw = await gateway.search('Archive', { text: 'Oktober' }, { limit: 10, localPass: 0 });
    expect(raw.total).toBe(0); // the server alone does not find it
    const r = await service.search({ text: 'Oktober', mailbox: 'archive' });
    expect(r.total).toBe(1);
    expect(r.messages[0]!.subject).toBe('Rechnungsübersicht Oktober');
  });
  it('finds it across all folders and with subject search', async () => {
    expect((await service.search({ text: 'Oktober' })).messages.map((m) => m.mailbox)).toEqual(['Archive']);
    expect((await service.search({ subject: 'Oktober' })).total).toBe(1);
  });
  it('a match only in the message body is still found by the server', async () => {
    const r = await service.search({ text: 'Content of Unread one' });
    expect(r.total).toBeGreaterThanOrEqual(1);
  });
});

describe('Conversations and pages via the service', () => {
  it('get_thread finds messages in several folders via Message-ID, In-Reply-To and References', async () => {
    const first = (await service.listRecent('INBOX', 10)).messages.find((m) => m.subject === 'Unread one')!;
    const before = JSON.stringify(server.flagsSnapshot());
    const t = await service.getThread(first.id);
    expect(t.messages.map((m) => m.subject).sort()).toEqual(['Re: Unread one', 'Read three', 'Unread one']);
    expect(t.messages.map((m) => m.mailbox).sort()).toEqual(['INBOX', 'INBOX', 'Sent Messages']);
    expect(t.messages.every((m) => typeof m.excerpt === 'string' && m.excerpt.length > 0)).toBe(true);
    expect(JSON.stringify(server.flagsSnapshot())).toBe(before);
  });

  it('get_thread without text returns only the overview', async () => {
    const first = (await service.listRecent('INBOX', 10)).messages[0]!;
    const t = await service.getThread(first.id, { includeText: false });
    expect(t.messages.every((m) => !('excerpt' in m))).toBe(true);
  });

  it('get_message returns a short message in one page without next_offset', async () => {
    const first = (await service.listRecent('INBOX', 10)).messages[0]!;
    const m = await service.getMessage(first.id);
    expect(m.page.truncated).toBe(false);
    expect(m.page.nextOffset).toBeUndefined();
    expect(m.page.totalLength).toBe(m.text.length);
  });
});

describe('Message IDs', () => {
  it('contain folder, UIDVALIDITY and UID and can be decoded again', async () => {
    const r = await service.listRecent('INBOX', 1);
    const ref = decodeRef(r.messages[0]!.id);
    expect(ref).toMatchObject({ path: 'INBOX', uidValidity: '1700' });
    expect(ref.uid).toBeGreaterThan(0);
  });
  it('reject a stale UIDVALIDITY', async () => {
    const r = await service.listRecent('INBOX', 1);
    const stale = r.messages[0]!.id.replace('|1700|', '|999|');
    await expect(service.getMessage(stale)).rejects.toThrow(/stale/);
  });
  it.each(['', 'x', 'INBOX|1|', 'INBOX|a|1', '../../etc|1|1|2'])('reject invalid ID "%s"', async (id) => {
    await expect(service.getMessage(id)).rejects.toThrow(/Invalid message ID/);
  });
});
