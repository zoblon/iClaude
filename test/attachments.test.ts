import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { AttachmentService } from '../src/core/mail/attachment.js';
import { ImapGateway, attachmentsOf, decodeTransfer, encodeMailboxName, type ImapLike } from '../src/core/mail/imap.js';
import { decodeRef } from '../src/core/mail/ref.js';
import { MailService } from '../src/core/mail/service.js';
import { cfg } from './fakeStore.js';
import { ICS, multipartMessage } from './mimeFixture.js';
import { MiniImap } from './miniImap.js';
import { makePdf } from './pdfFixture.js';

const longText = Array.from({ length: 900 }, (_, i) => `Line ${i + 1} of the long text`).join('\n');
const message = multipartMessage({
  uid: 1,
  flags: [],
  subject: 'iClaude Test',
  messageId: 'att1@x',
  parts: [
    { type: 'application/pdf', filename: 'report.pdf', data: makePdf(['Quarterly numbers look fine', 'Second page text']) },
    { type: 'text/calendar', filename: 'invite.ics', data: ICS, charset: 'UTF-8' },
    { type: 'text/csv', filename: 'table.csv', data: 'name;city\nJürgen;Köln\n', charset: 'UTF-8', encoding: 'quoted-printable' },
    { type: 'application/pdf', filename: 'scan.pdf', data: makePdf([undefined, undefined]) },
    { type: 'image/png', filename: 'photo.png', data: Buffer.from('not really a png, but bytes') },
    { type: 'text/plain', filename: 'long.txt', data: longText },
    { type: 'text/html', filename: 'page.html', data: '<html><body><h1>Title</h1><p>Hello <b>world</b></p><p style="display:none">HIDDEN INSTRUCTION</p></body></html>' },
    { type: 'text/plain', filename: 'latin.txt', data: Buffer.from('Gr\xfc\xdfe aus K\xf6ln', 'latin1'), charset: 'windows-1252' },
    { type: 'application/octet-stream', filename: 'broken.pdf', data: Buffer.from('%PDF-1.4 this is not a real pdf') },
  ],
});

let server: MiniImap;
let gateway: ImapGateway;
let mail: MailService;
let attachments: AttachmentService;
let id: string;

beforeAll(async () => {
  server = new MiniImap({
    INBOX: { uidValidity: 1700, messages: [message] },
    Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] },
  });
  await server.start();
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  mail = new MailService(cfg, gateway);
  attachments = new AttachmentService(cfg, gateway);
  id = (await mail.listRecent('inbox', 5)).messages[0]!.id;
}, 30_000);

afterAll(async () => {
  await gateway.close();
  await server.stop();
});

const byName = async () => {
  const m = await mail.getMessage(id);
  return Object.fromEntries(m.attachments.map((a) => [a.filename, a.attachmentId!]));
};

describe('get_message lists attachments with stable IDs', () => {
  it('gives the IMAP part, name, type and size of every attachment (not the body text)', async () => {
    const m = await mail.getMessage(id);
    expect(m.attachments.map((a) => [a.attachmentId, a.filename, a.contentType, a.inline])).toEqual([
      ['2', 'report.pdf', 'application/pdf', false],
      ['3', 'invite.ics', 'text/calendar', false],
      ['4', 'table.csv', 'text/csv', false],
      ['5', 'scan.pdf', 'application/pdf', false],
      ['6', 'photo.png', 'image/png', false],
      ['7', 'long.txt', 'text/plain', false],
      ['8', 'page.html', 'text/html', false],
      ['9', 'latin.txt', 'text/plain', false],
      ['10', 'broken.pdf', 'application/octet-stream', false],
    ]);
    expect(m.attachments[0]!.size).toBeGreaterThan(400);
  });
  it('structure rules: body text is not an attachment, named text parts are', () => {
    const list = attachmentsOf({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'text/html' },
        { part: '3', type: 'image/png', disposition: 'inline', dispositionParameters: { filename: 'logo.png' }, size: 100 },
        { part: '4', type: 'message/rfc822', size: 50 },
      ],
    });
    expect(list.map((a) => [a.id, a.inline])).toEqual([['3', true], ['4', false]]);
  });
});

describe('read_attachment', () => {
  it('extracts the text of a PDF without a network and marks nothing as read', async () => {
    const ids = await byName();
    const before = JSON.stringify(server.flagsSnapshot());
    const r = await attachments.read(id, ids['report.pdf']!);
    expect(r.kind).toBe('pdf');
    expect(r.text).toContain('Quarterly numbers look fine');
    expect(r.text).toContain('Second page text');
    expect(r.pdf).toMatchObject({ pages: 2, textLayer: true });
    expect(JSON.stringify(server.flagsSnapshot())).toBe(before);
    // on the wire: read-only folder, only BODY.PEEK, nothing that changes anything
    expect(server.violations).toEqual([]);
    expect(server.commands.some((c) => /BODY\.PEEK\[2\]/i.test(c))).toBe(true);
    expect(server.commands.filter((c) => /\bSTORE\b|\bCOPY\b|\bMOVE\b|\bAPPEND\b|\bEXPUNGE\b|\bSELECT\b/.test(c))).toEqual([]);
  });

  it('reports a scanned PDF without a text layer explicitly', async () => {
    const r = await attachments.read(id, (await byName())['scan.pdf']!);
    expect(r.kind).toBe('pdf');
    expect(r.pdf).toMatchObject({ pages: 2, textLayer: false });
    expect(r.text).toBe('');
    expect(r.note).toMatch(/no text layer/);
  });

  it('reads a calendar invitation: title, times, location, organizer, method, recurrence, description', async () => {
    const r = await attachments.read(id, (await byName())['invite.ics']!);
    expect(r.kind).toBe('calendar');
    expect(r.calendar!.method).toBe('REQUEST');
    expect(r.calendar!.events[0]).toMatchObject({
      uid: 'invite-1@example.com',
      title: 'Project kickoff',
      start: '2026-10-21T10:00:00+02:00',
      end: '2026-10-21T11:30:00+02:00',
      allDay: false,
      location: 'Room 4',
      organizer: { name: 'Boss', email: 'boss@company.example' },
      recurrence: 'FREQ=WEEKLY;COUNT=4',
      description: 'Agenda\nand more',
      attendeeCount: 1,
      alarmsMinutesBefore: [15],
    });
  });

  it('reads text (quoted-printable UTF-8, windows-1252) and HTML as Markdown without hidden content', async () => {
    const ids = await byName();
    const csv = await attachments.read(id, ids['table.csv']!);
    expect(csv).toMatchObject({ kind: 'text', format: 'text' });
    expect(csv.text).toBe('name;city\nJürgen;Köln');
    expect((await attachments.read(id, ids['latin.txt']!)).text).toBe('Grüße aus Köln');
    const html = await attachments.read(id, ids['page.html']!);
    expect(html.format).toBe('markdown');
    expect(html.text).toContain('Title');
    expect(html.text).toContain('**world**');
    expect(html.text).not.toContain('HIDDEN INSTRUCTION');
  });

  it('pages long texts like get_message', async () => {
    const id7 = (await byName())['long.txt']!;
    const p1 = await attachments.read(id, id7);
    expect(p1.page).toMatchObject({ offset: 0, pageLength: 8000, truncated: true, nextOffset: 8000 });
    const p2 = await attachments.read(id, id7, p1.page!.nextOffset);
    expect(p2.page!.offset).toBe(8000);
    expect((p1.text! + p2.text!).startsWith('Line 1 of')).toBe(true);
    const last = await attachments.read(id, id7, 10_000_000);
    expect(last.page!.offset).toBe(last.page!.totalLength);
  });

  it('returns only metadata and a hint for other types', async () => {
    const r = await attachments.read(id, (await byName())['photo.png']!);
    expect(r).toMatchObject({ kind: 'unsupported', filename: 'photo.png', contentType: 'image/png' });
    expect(r.text).toBeUndefined();
    expect(r.note).toMatch(/not read/);
  });

  it('reports unreadable PDFs clearly', async () => {
    await expect(attachments.read(id, (await byName())['broken.pdf']!)).rejects.toThrow(/PDF could not be read/);
  });

  it('refuses unknown or malformed attachment_ids and stale message IDs without downloading anything', async () => {
    server.commands.length = 0;
    await expect(attachments.read(id, '1')).rejects.toThrow(/no attachment with this attachment_id/); // 1 is the body text
    await expect(attachments.read(id, '99')).rejects.toThrow(/no attachment with this attachment_id/);
    await expect(attachments.read(id, '2; DELETE')).rejects.toThrow(/Invalid attachment_id/);
    await expect(attachments.read(id.replace('|1700|', '|1701|'), '2')).rejects.toThrow(/stale/);
    expect(server.commands.some((c) => /BODY\.PEEK\[/i.test(c))).toBe(false);
  });

  it('refuses an attachment above the size limit before downloading it', async () => {
    server.commands.length = 0;
    await expect(gateway.fetchPart(decodeRef(id), '2', 100)).rejects.toThrow(/too large/);
    expect(server.commands.some((c) => /BODY\.PEEK\[2\]/i.test(c))).toBe(false);
    expect(server.violations).toEqual([]);
  });
});

describe('helpers', () => {
  it('decodes transfer encodings', () => {
    expect(decodeTransfer(Buffer.from('SGVsbG8='), 'base64').toString()).toBe('Hello');
    expect(decodeTransfer(Buffer.from('J=C3=BCrgen=\r\n x'), 'quoted-printable').toString()).toBe('Jürgen x');
  });
  it('encodes folder names as modified UTF-7', () => {
    expect(encodeMailboxName('Archive')).toBe('Archive');
    expect(encodeMailboxName('Entwürfe & Mehr')).toBe('Entw&APw-rfe &- Mehr');
    expect(encodeMailboxName('日本語')).toBe('&ZeVnLIqe-');
  });
});
