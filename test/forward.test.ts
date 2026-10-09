import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { DraftService, MAX_FORWARD_BYTES, forwardBlock, forwardSubject } from '../src/core/mail/draft.js';
import { ImapGateway, type ImapLike } from '../src/core/mail/imap.js';
import { buildDraft, filenameParams, safeFilename, safeMediaType } from '../src/core/mail/mime.js';
import { MailService } from '../src/core/mail/service.js';
import type { AttachmentInfo, MailReader } from '../src/core/mail/types.js';
import { createDraftSchema } from '../src/mcp/draftTools.js';
import { DateTime } from 'luxon';
import { cfg } from './fakeStore.js';
import { multipartMessage } from './mimeFixture.js';
import { MiniImap, rfc822 } from './miniImap.js';
import { makePdf } from './pdfFixture.js';

const pdf = makePdf(['Forwarded numbers']);
const umlautName = 'Übersicht für Müller – Quartalsbericht 2026 (final) ✓.pdf';
const original = multipartMessage({
  uid: 1,
  flags: ['\\Seen'],
  subject: 'iClaude Test',
  messageId: 'fw1@x',
  from: 'Anna Example <anna@example.com>',
  body: 'Hello,\nplease see the attached files.\nBest, Anna',
  parts: [
    { type: 'application/pdf', filename: 'report.pdf', data: pdf },
    { type: 'application/pdf', filename: umlautName, data: makePdf(['Second']) },
    { type: 'text/calendar', filename: 'invite.ics', data: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n', charset: 'UTF-8' },
  ],
});

let server: MiniImap;
let gateway: ImapGateway;
let mail: MailService;
let drafts: DraftService;
let id: string;

beforeAll(async () => {
  server = new MiniImap({
    INBOX: { uidValidity: 1700, messages: [original, { uid: 2, flags: [], subject: 'Plain', from: 'Bob <bob@example.com>', messageId: '<p1@x>', date: 'Wed, 07 Oct 2026 10:00:00 +0200', raw: rfc822({ from: 'Bob <bob@example.com>', subject: 'Plain', messageId: '<p1@x>', date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: 'Just text' }) }] },
    Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] },
  });
  server.allowAppend = new Set(['Drafts']);
  await server.start();
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  mail = new MailService(cfg, gateway);
  drafts = new DraftService(cfg, gateway, gateway, () => mail.mailboxes());
  id = (await mail.listRecent('inbox', 5)).messages.find((m) => m.subject === 'iClaude Test')!.id;
}, 30_000);

afterAll(async () => {
  await gateway.close();
  await server.stop();
});

const lastAppend = () => server.appends[server.appends.length - 1]!;
const parsedLast = () => simpleParser(Buffer.from(lastAppend().raw, 'utf8'));
const idOf = async (subject: string) => (await mail.listRecent('inbox', 5)).messages.find((m) => m.subject === subject)!.id;

describe('forwarding as a draft', () => {
  it('creates "Fwd: …" with the forwarding header, the original text and all attachments', async () => {
    const d = await drafts.createDraft({ forwardOfId: id, to: ['Carla <carla@example.com>'], body: 'FYI, see below.' });
    expect(d).toMatchObject({ subject: 'Fwd: iClaude Test', forwarded: true, quoted: true, mailbox: 'Drafts' });
    expect(d.attachments!.map((a) => a.filename)).toEqual(['report.pdf', umlautName, 'invite.ics']);
    // only APPEND with \Draft into Drafts; nothing sent, no other change on the wire
    expect(lastAppend()).toMatchObject({ box: 'Drafts' });
    expect(lastAppend().flags).toEqual(['\\Seen', '\\Draft']);
    expect(server.violations).toEqual([]);

    const p = await parsedLast();
    expect(p.subject).toBe('Fwd: iClaude Test');
    expect(p.from?.value[0]?.address).toBe(cfg.mailUser);
    expect(p.to).toMatchObject({ value: [{ address: 'carla@example.com' }] });
    expect(p.headers.has('in-reply-to')).toBe(false);
    expect(p.text).toContain('FYI, see below.');
    expect(p.text).toContain('Begin forwarded message:');
    expect(p.text).toContain('From: Anna Example <anna@example.com>');
    expect(p.text).toContain('Subject: iClaude Test');
    expect(p.text).toMatch(/Date: Wednesday, October 7, 2026 at 10:00:00 AM CEST/);
    expect(p.text).toContain('To: Me <me@icloud.com>');
    expect(p.text).toContain('please see the attached files.');
    expect(p.attachments.map((a) => a.filename)).toEqual(['report.pdf', umlautName, 'invite.ics']);
    expect(p.attachments[0]!.content.equals(pdf)).toBe(true);
    expect(p.attachments[0]!.contentType).toBe('application/pdf');
    // multipart/mixed, attachments Base64
    expect(lastAppend().raw).toMatch(/Content-Type: multipart\/mixed;\r\n boundary=/);
    expect(lastAppend().raw.match(/Content-Transfer-Encoding: base64/g)).toHaveLength(4);
  });

  it('the file name with umlauts, dash and symbols survives as RFC 2231 / RFC 2047 in the raw message', async () => {
    const raw = lastAppend().raw;
    expect(raw).toMatch(/filename\*0\*=UTF-8''/);
    expect(raw).toMatch(/filename="=\?UTF-8\?B\?/);
    for (const line of raw.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  });

  it('quote=false keeps only the forwarding header', async () => {
    await drafts.createDraft({ forwardOfId: id, to: ['carla@example.com'], body: 'Short.', quote: false });
    const p = await parsedLast();
    expect(p.text).toContain('Begin forwarded message:');
    expect(p.text).toContain('Subject: iClaude Test');
    expect(p.text).not.toContain('please see the attached files.');
  });

  it('takes only the chosen attachments, or none', async () => {
    const d = await drafts.createDraft({ forwardOfId: id, to: ['carla@example.com'], body: 'x', forwardAttachmentIds: ['3'] });
    expect(d.attachments!.map((a) => a.filename)).toEqual([umlautName]);
    expect((await parsedLast()).attachments.map((a) => a.filename)).toEqual([umlautName]);

    const none = await drafts.createDraft({ forwardOfId: id, to: ['carla@example.com'], body: 'x', forwardAttachmentIds: [] });
    expect(none.attachments).toBeUndefined();
    expect(lastAppend().raw).toMatch(/Content-Type: text\/plain; charset=UTF-8/);
    expect(lastAppend().raw).not.toMatch(/multipart/);
  });

  it('forwards a mail without attachments as a plain draft', async () => {
    const d = await drafts.createDraft({ forwardOfId: await idOf('Plain'), to: ['carla@example.com'], body: 'FYI' });
    expect(d).toMatchObject({ subject: 'Fwd: Plain', forwarded: true });
    expect(d.attachments).toBeUndefined();
    expect((await parsedLast()).text).toContain('Just text');
  });

  it('refuses unknown attachment_ids, a missing recipient, reply + forward together, and the stray option', async () => {
    const before = server.appends.length;
    await expect(drafts.createDraft({ forwardOfId: id, to: ['c@example.com'], body: 'x', forwardAttachmentIds: ['42'] })).rejects.toThrow(/no attachment with the attachment_id.*Available: 2 \(report\.pdf\)/);
    await expect(drafts.createDraft({ forwardOfId: id, body: 'x' })).rejects.toThrow(/recipient/);
    await expect(drafts.createDraft({ forwardOfId: id, replyToId: id, to: ['c@example.com'], body: 'x' })).rejects.toThrow(/either reply_to_id or forward_of_id/);
    await expect(drafts.createDraft({ forwardAttachmentIds: ['2'], to: ['c@example.com'], subject: 's', body: 'x' })).rejects.toThrow(/only makes sense together with forward_of_id/);
    expect(server.appends.length).toBe(before);
  });

  it('draft schema accepts the forward fields and still rejects attachments, bcc and sender', () => {
    expect(createDraftSchema.safeParse({ body: 'x', forward_of_id: 'INBOX|1|1', forward_attachment_ids: ['2'], to: ['a@example.com'] }).success).toBe(true);
    for (const f of ['attachments', 'bcc', 'from', 'files']) expect(createDraftSchema.safeParse({ body: 'x', [f]: ['x'] }).success, f).toBe(false);
  });
});

describe('the 20 MB limit', () => {
  const info = (n: number, size: number): AttachmentInfo => ({ id: String(n), filename: `f${n}.bin`, contentType: 'application/octet-stream', size, inline: false });
  const fakeReader = (attachments: AttachmentInfo[]): MailReader =>
    ({
      fetchSource: async () => ({
        source: Buffer.from(rfc822({ from: 'a@example.com', subject: 'Big', messageId: '<big@x>', date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: 'x' })),
        summary: {} as never,
        truncated: false,
        attachments,
      }),
      fetchPart: async () => {
        throw new Error('must not be downloaded');
      },
    }) as unknown as MailReader;
  const mb = [{ path: 'Drafts', name: 'Drafts', role: 'drafts', roleBy: 'flag' as const }];

  it('refuses a total above 20 MB before downloading anything, with a hint', async () => {
    const svc = new DraftService(cfg, fakeReader([info(2, 12 * 1024 * 1024), info(3, 9 * 1024 * 1024)]), gateway, async () => mb);
    await expect(svc.createDraft({ forwardOfId: 'INBOX|1700|1', to: ['c@example.com'], body: 'x' })).rejects.toThrow(/too large to forward.*forward_attachment_ids/s);
    expect(MAX_FORWARD_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('MIME building', () => {
  const base = { from: { address: 'me@icloud.com' }, to: [{ address: 'a@example.com' }], cc: [], subject: 'S', body: 'Body', date: DateTime.fromISO('2026-10-09T10:00:00+02:00') };

  it('ASCII names are quoted strings, special names are escaped', async () => {
    const { raw } = buildDraft({ ...base, attachments: [{ filename: 'plain name.txt', contentType: 'text/plain', data: Buffer.from('hi') }, { filename: 'we"ird.txt', contentType: 'text/plain', data: Buffer.from('yo') }] }, 'icloud.com');
    const p = await simpleParser(raw);
    expect(p.attachments.map((a) => a.filename)).toEqual(['plain name.txt', 'we"ird.txt']);
    expect(p.attachments.map((a) => a.content.toString())).toEqual(['hi', 'yo']);
  });

  it('long non-ASCII names use RFC 2231 continuations that survive parsing', async () => {
    const name = `${'Ärger Übung Öl '.repeat(10)}.docx`;
    const { raw } = buildDraft({ ...base, attachments: [{ filename: name, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.from('doc') }] }, 'icloud.com');
    expect(raw.toString()).toMatch(/filename\*1\*=/);
    const p = await simpleParser(raw);
    expect(p.attachments[0]!.filename).toBe(safeFilename(name));
  });

  it('header injection through file names or types is impossible', async () => {
    const { raw } = buildDraft({ ...base, attachments: [{ filename: 'a.txt\r\nBcc: victim@example.com', contentType: 'text/plain\r\nBcc: v@example.com', data: Buffer.from('x') }] }, 'icloud.com');
    const p = await simpleParser(raw);
    expect(p.headers.has('bcc')).toBe(false);
    expect(safeMediaType('text/plain\r\nX: y')).toBe('application/octet-stream');
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(filenameParams('filename', 'a.txt')).toEqual(['filename="a.txt"']);
  });
});

describe('helpers', () => {
  it('"Fwd:" only once', () => {
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fwd: Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('WG: Hallo')).toBe('WG: Hallo');
  });
  it('forwarding block with Cc', () => {
    const b = forwardBlock({ from: [{ name: 'A', address: 'a@x.de' }], subject: 'S', date: DateTime.fromISO('2026-10-07T10:00:00+02:00', { setZone: true }), to: [{ address: 'b@x.de' }], cc: [{ address: 'c@x.de' }], text: 'T' });
    expect(b.split('\n').slice(0, 2)).toEqual(['Begin forwarded message:', '']);
    expect(b).toContain('Cc: c@x.de');
    expect(b.endsWith('\n\nT')).toBe(true);
  });
});
