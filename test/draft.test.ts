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
  raw: rfc822({ from, subject, messageId: `<${mid}>`, date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: `Original von ${subject}\nzweite Zeile`, ...extra }),
});

const boxes = (withDrafts = true): Record<string, MiniBox> => ({
  INBOX: {
    uidValidity: 1700,
    messages: [
      msg(1, [], 'Hallo', 'a1@x', 'Anna Beispiel <anna@beispiel.de>', { references: '<r0@x>' }),
      msg(2, ['\\Seen'], 'AW: Termin', 'a2@x', 'Bernd <bernd@beispiel.de>'),
    ],
  },
  'Sent Messages': {
    special: '\\Sent',
    uidValidity: 1800,
    messages: [msg(1, ['\\Seen'], 'Mein Text', 's1@x', ME, { to: 'Carla <carla@beispiel.de>' })],
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

describe('Entwurf anlegen', () => {
  it('legt genau einen Entwurf im Entwürfe-Ordner ab, mit \\Draft und \\Seen, von der eigenen Adresse', async () => {
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
    expect(d.note).toContain('NICHT gesendet');
  });

  it('der Entwurf erscheint in Drafts, als Entwurf markiert und nicht als ungelesen', async () => {
    const r = await mail.listRecent('drafts', 10);
    expect(r.messages.length).toBeGreaterThanOrEqual(1);
    expect(r.messages[0]).toMatchObject({ draft: true, unread: false });
  });

  it('es wird nie etwas anderes verändert: nur APPEND, nur nach Drafts, sonst nur EXAMINE und lesende Befehle', () => {
    expect(server.violations).toEqual([]);
    expect(server.commands.filter((c) => c.startsWith('APPEND')).every((c) => c.startsWith('APPEND "Drafts" (\\Seen \\Draft)') || c.startsWith('APPEND "Drafts" (\\Draft \\Seen)'))).toBe(true);
    const verbs = server.commands.map((c) => c.split(' ')[c.startsWith('UID') ? 1 : 0]);
    for (const v of ['STORE', 'COPY', 'MOVE', 'EXPUNGE', 'DELETE', 'CREATE', 'RENAME', 'SELECT']) expect(verbs, v).not.toContain(v);
  });

  it('bestehende Nachrichten bleiben unverändert (Flags in Posteingang und Gesendet)', async () => {
    const snap = JSON.stringify([server.flagsSnapshot().INBOX, server.flagsSnapshot()['Sent Messages']]);
    await drafts.createDraft({ to: [ME], subject: 'Noch einer', body: 'x' });
    expect(JSON.stringify([server.flagsSnapshot().INBOX, server.flagsSnapshot()['Sent Messages']])).toBe(snap);
  });
});

describe('Antwort-Entwurf', () => {
  it('setzt In-Reply-To, References, "Re:" und zitiert; Empfänger ist der Absender des Originals', async () => {
    const id = await inboxId('Hallo');
    const d = await drafts.createDraft({ body: 'Danke, passt!', replyToId: id });
    const p = await lastDraft();
    expect(p.subject).toBe('Re: Hallo');
    expect(addrs(p.to)).toEqual(['anna@beispiel.de']);
    expect(p.inReplyTo).toBe('<a1@x>');
    expect(p.references).toEqual(['<r0@x>', '<a1@x>']);
    const text = p.text!.replace(/\r\n/g, '\n');
    expect(text.startsWith('Danke, passt!')).toBe(true);
    expect(text).toMatch(/Am 07\.10\.2026 um 10:00 schrieb Anna Beispiel <anna@beispiel\.de>:/);
    expect(text).toContain('> Original von Hallo\n> zweite Zeile');
    expect(d).toMatchObject({ quoted: true, inReplyTo: 'a1@x' });
  });

  it('ohne Zitat: kein ">" im Text', async () => {
    await drafts.createDraft({ body: 'Kurz.', replyToId: await inboxId('Hallo'), quote: false });
    const p = await lastDraft();
    expect(p.text).not.toContain('>');
    expect(p.inReplyTo).toBe('<a1@x>');
  });

  it('übernimmt eigenen Betreff und eigene Empfänger, wenn angegeben', async () => {
    await drafts.createDraft({ body: 'x', replyToId: await inboxId('Hallo'), subject: 'Anderer Betreff', to: [ME], cc: ['c@beispiel.de'] });
    const p = await lastDraft();
    expect(p.subject).toBe('Anderer Betreff');
    expect(addrs(p.to)).toEqual([ME]);
    expect(addrs(p.cc)).toEqual(['c@beispiel.de']);
  });

  it('Antwort auf eine eigene Nachricht geht an deren Empfänger', async () => {
    const sent = (await mail.listRecent('sent', 5)).messages[0]!;
    await drafts.createDraft({ body: 'Nachfrage', replyToId: sent.id });
    const p = await lastDraft();
    expect(addrs(p.to)).toEqual(['carla@beispiel.de']);
    expect(p.subject).toBe('Re: Mein Text');
  });

  it('hängt "Re:" nicht doppelt an', () => {
    expect(replySubject('AW: Termin')).toBe('AW: Termin');
    expect(replySubject('Re: Hallo')).toBe('Re: Hallo');
    expect(replySubject('Hallo')).toBe('Re: Hallo');
  });

  it('lesen für die Antwort ändert keine Flags (Original bleibt ungelesen)', async () => {
    const before = JSON.stringify(server.flagsSnapshot().INBOX);
    await drafts.createDraft({ body: 'x', replyToId: await inboxId('Hallo') });
    expect(JSON.stringify(server.flagsSnapshot().INBOX)).toBe(before);
    expect((await mail.listRecent('INBOX', 10)).messages.find((m) => m.subject === 'Hallo')!.unread).toBe(true);
  });
});

describe('Konversation mit Entwürfen (iCloud sucht Kopfzeilen nur mit spitzen Klammern)', () => {
  it('get_thread findet das Original zu einem Antwort-Entwurf im Entwürfe-Ordner', async () => {
    const first = await drafts.createDraft({ to: [ME], subject: 'Faden Anfang', body: 'eins' });
    const reply = await drafts.createDraft({ body: 'zwei', replyToId: first.id! });
    const t = await mail.getThread(reply.id!, { includeText: false });
    expect(t.messages.map((m) => m.id).sort()).toEqual([first.id, reply.id].sort());
  });
  it('die Kopfzeilen-Suchen laufen mit spitzen Klammern', () => {
    const searches = server.commands.filter((c) => /SEARCH/.test(c) && /HEADER/i.test(c));
    expect(searches.length).toBeGreaterThan(0);
    for (const c of searches) for (const m of c.matchAll(/HEADER\s+"?[\w-]+"?\s+("[^"]*"|\S+)/gi)) expect(m[1]!.replace(/^"|"$/g, ''), c).toMatch(/^<.*>$/);
  });
});

describe('Ablehnungen: dabei wird nichts geschrieben', () => {
  let before: number;
  beforeEach(() => {
    before = server.appends.length;
  });
  const none = () => expect(server.appends).toHaveLength(before);

  it.each([
    ['ungültige Adresse', { to: ['kein-at'], subject: 's', body: 'x' }, /Mailadresse/],
    ['eingeschleuste Bcc-Zeile in der Adresse', { to: ['a@b.de\r\nBcc: x@y.de'], subject: 's', body: 'x' }, /Steuerzeichen|Mailadresse/],
    ['leerer Text', { to: [ME], subject: 's', body: '   \n ' }, /nicht leer/],
    ['kein Empfänger', { subject: 's', body: 'x' }, /Empfänger/],
    ['kein Betreff', { to: [ME], body: 'x' }, /Betreff/],
    ['zu viele Empfänger', { to: Array.from({ length: 21 }, (_, i) => `u${i}@beispiel.de`), subject: 's', body: 'x' }, /Zu viele/],
    ['zu langer Text', { to: [ME], subject: 's', body: 'a'.repeat(20001) }, /zu lang/],
    ['zu langer Betreff', { to: [ME], subject: 's'.repeat(301), body: 'x' }, /Betreff ist zu lang/],
    ['unbekannte Antwort-ID', { body: 'x', replyToId: 'kaputt' }, /Nachrichten-ID/],
  ])('%s', async (_n, input, msgRe) => {
    await expect(drafts.createDraft(input as never)).rejects.toThrow(msgRe);
    none();
  });

  it('veraltete Antwort-ID', async () => {
    const id = (await inboxId('Hallo')).replace('|1700|', '|5|');
    await expect(drafts.createDraft({ body: 'x', replyToId: id })).rejects.toThrow(/veraltet/);
    none();
  });

  it('eingeschleuste Zeilen im Betreff erzeugen keine Bcc-Kopfzeile', async () => {
    await drafts.createDraft({ to: [ME], subject: 'Hi\r\nBcc: boese@beispiel.de', body: 'x' });
    const p = await lastDraft();
    expect(p.headers.has('bcc')).toBe(false);
    expect(addrs(p.to)).toEqual([ME]);
  });
});

describe('Rechte', () => {
  it('Schema nimmt weder Bcc, Absender noch Anhänge an', () => {
    const ok = createDraftSchema.safeParse({ to: [ME], subject: 's', body: 'x' });
    expect(ok.success).toBe(true);
    for (const field of ['bcc', 'from', 'sender', 'attachments', 'reply_to', 'send', 'mailbox', 'folder', 'flags']) {
      expect(createDraftSchema.safeParse({ to: [ME], subject: 's', body: 'x', [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('das Gateway schreibt nicht ohne Freigabe (auch nicht mit nachgebauter Freigabe)', async () => {
    await expect(gateway.appendDraft(undefined as never, Buffer.from('x'))).rejects.toThrow(/ohne Freigabe/);
    await expect(gateway.appendDraft({ mailbox: 'INBOX' } as never, Buffer.from('x'))).rejects.toThrow(/ohne Freigabe/);
    expect(DraftGrant.isValid({ mailbox: 'Drafts' })).toBe(false);
  });

  it('der Zielordner ist immer der Entwürfe-Ordner (SPECIAL-USE), nie frei wählbar', () => {
    const grant = authorizeDraft([
      { path: 'INBOX', name: 'INBOX', role: 'inbox' },
      { path: 'Entwürfe-Neu', name: 'Entwürfe-Neu', role: 'drafts' },
      { path: 'Drafts', name: 'Drafts' },
    ]);
    expect(grant.mailbox).toBe('Entwürfe-Neu');
  });

  it('ohne Entwürfe-Ordner (oder bei mehreren) wird abgelehnt', () => {
    expect(() => authorizeDraft([{ path: 'INBOX', name: 'INBOX', role: 'inbox' }])).toThrow(/kein Entwürfe-Ordner/);
    expect(() => authorizeDraft([{ path: 'A', name: 'A', role: 'drafts' }, { path: 'B', name: 'B', role: 'drafts' }])).toThrow(/mehrere/);
  });

  it('kein Entwürfe-Ordner auf dem Server: es wird nichts geschrieben', async () => {
    const s2 = new MiniImap(boxes(false));
    await s2.start();
    const g2 = new ImapGateway(
      cfg,
      () => new ImapFlow({ host: '127.0.0.1', port: s2.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike,
    );
    const m2 = new MailService(cfg, g2);
    const d2 = new DraftService(cfg, g2, g2, () => m2.mailboxes());
    try {
      await expect(d2.createDraft({ to: [ME], subject: 's', body: 'x' })).rejects.toThrow(/Entwürfe-Ordner/);
      expect(s2.appends).toHaveLength(0);
      expect(s2.commands.filter((c) => c.startsWith('APPEND'))).toEqual([]);
    } finally {
      await g2.close();
      await s2.stop();
    }
  });
});

describe('Im Code gibt es genau einen schreibenden Zugriff auf Mail', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('.append( kommt nur einmal vor, in ImapGateway.appendDraft, hinter der Freigabeprüfung', () => {
    const hits = files('src').filter((f) => /\.append\(|\bappend\(/.test(code(f)));
    expect(hits).toEqual([join('src', 'core', 'mail', 'imap.ts')]);
    const text = code(join('src', 'core', 'mail', 'imap.ts'));
    expect(text.match(/w\.append\(/g)).toHaveLength(1);
    expect(text.indexOf('DraftGrant.isValid')).toBeGreaterThan(-1);
    expect(text.indexOf('DraftGrant.isValid')).toBeLessThan(text.indexOf('w.append('));
  });

  it('es gibt kein Senden: keine SMTP-Bibliothek, kein Transport, kein Werkzeug zum Senden', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /nodemailer|smtp|sendmail/i.test(d))).toEqual([]);
    for (const f of files('src')) expect(code(f), f).not.toMatch(/createTransport|sendMail|smtp\.|:587|:465/i);
  });
});
