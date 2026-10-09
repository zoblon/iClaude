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
  from: 'Anna Beispiel <anna@beispiel.de>',
  messageId: `<${mid}>`,
  date: 'Wed, 07 Oct 2026 10:00:00 +0200',
  attachment,
  raw: rfc822({ from: 'Anna Beispiel <anna@beispiel.de>', subject, messageId: `<${mid}>`, date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: `Inhalt von ${subject}`, ...extra }),
});

function encodedSubjectMessage(): MiniMessage {
  const subject = 'Rechnungsübersicht Oktober';
  const m = msg(1, ['\\Seen'], subject, 'enc1@x');
  m.raw = rfc822({ from: 'Anna Beispiel <anna@beispiel.de>', subject: `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, messageId: '<enc1@x>', date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: 'Kein Treffer im Text' });
  return m;
}

let server: MiniImap;
let gateway: ImapGateway;
let service: MailService;

beforeAll(async () => {
  server = new MiniImap({
    INBOX: { uidValidity: 1700, messages: [msg(1, [], 'Ungelesen eins', 'a1@x'), msg(2, [], 'Ungelesen zwei', 'a2@x', {}, true), msg(3, ['\\Seen'], 'Gelesen drei', 'a3@x', { inReplyTo: '<a1@x>', references: '<a1@x>' })] },
    'Sent Messages': { special: '\\Sent', uidValidity: 1800, messages: [msg(1, ['\\Seen'], 'Re: Ungelesen eins', 'a4@x', { inReplyTo: '<a1@x>', references: '<a1@x>' })] },
    Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] },
    // Betreff MIME-kodiert: im Rohtext steht nur Base64, der Server findet das Wort per TEXT-Suche nicht.
    Archive: { special: '\\Archive', uidValidity: 2000, messages: [encodedSubjectMessage()] },
  });
  await server.start();
  // Echter imapflow-Client, verbunden mit dem Testserver (ohne TLS).
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  service = new MailService(cfg, gateway);
}, 30_000);

afterAll(async () => {
  await gateway.close();
  await server.stop();
});

describe('Lesen verändert nichts (über die Leitung geprüft, echter imapflow gegen Testserver)', () => {
  it('alle Lesewerkzeuge nacheinander: Flags bleiben exakt gleich', async () => {
    const before = JSON.stringify(server.flagsSnapshot());
    expect((await service.mailboxes()).map((m) => m.path)).toContain('INBOX');
    await service.unreadCounts();
    const recent = await service.listRecent('inbox', 10);
    expect(recent.messages.map((m) => m.subject)).toEqual(expect.arrayContaining(['Ungelesen eins', 'Ungelesen zwei', 'Gelesen drei']));
    await service.search({ subject: 'Ungelesen' });
    await service.search({ unreadOnly: true });
    const unread = recent.messages.find((m) => m.subject === 'Ungelesen zwei')!;
    const full = await service.getMessage(unread.id);
    expect(full.text).toContain('Inhalt von Ungelesen zwei');
    expect(full.attachments).toEqual([]); // Anhang nur in der Struktur des Testservers, nicht im Rohtext
    await service.getThread(unread.id);

    expect(JSON.stringify(server.flagsSnapshot())).toBe(before);
    expect(server.violations).toEqual([]);
  });

  it('die ungelesenen Nachrichten sind danach immer noch ungelesen', async () => {
    const r = await service.listRecent('INBOX', 10);
    expect(r.messages.filter((m) => m.unread).map((m) => m.subject).sort()).toEqual(['Ungelesen eins', 'Ungelesen zwei']);
  });

  it('jedes Postfach wird mit EXAMINE geöffnet, nie mit SELECT', () => {
    const opens = server.commands.filter((c) => /^(SELECT|EXAMINE)\b/.test(c));
    expect(opens.length).toBeGreaterThan(3);
    expect(opens.every((c) => c.startsWith('EXAMINE'))).toBe(true);
  });

  it('Inhalte werden nur mit BODY.PEEK geholt', () => {
    const fetches = server.commands.filter((c) => /FETCH/.test(c));
    expect(fetches.some((c) => /BODY\.PEEK\[\]/.test(c))).toBe(true);
    for (const c of fetches) {
      expect(c.replace(/BODY\.PEEK\[[^\]]*\]/g, ''), c).not.toMatch(/BODY\[|RFC822(?![.\w])/);
    }
  });

  it('es wird nie etwas verändert: kein STORE, COPY, MOVE, APPEND, EXPUNGE, DELETE, CREATE', () => {
    const sent = server.commands.map((c) => c.split(' ').slice(0, 2).join(' '));
    for (const verb of ['STORE', 'COPY', 'MOVE', 'APPEND', 'EXPUNGE', 'DELETE', 'CREATE', 'RENAME', 'SUBSCRIBE']) {
      expect(sent.filter((c) => new RegExp(`(^|\\s)${verb}$`).test(c)), verb).toEqual([]);
    }
  });

  it('der Testserver hätte einen Verstoß bemerkt: nicht schreibgeschütztes Öffnen markiert als gelesen', async () => {
    // Gegenprobe: Mit einem unvorsichtigen Client (SELECT, ohne PEEK) würde der Server das Flag setzen.
    const bad = new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true });
    bad.on('error', () => undefined);
    await bad.connect();
    const lock = await bad.getMailboxLock('INBOX'); // beschreibbar
    try {
      const m = await bad.fetchOne('1', { uid: true, flags: true }, { uid: true });
      expect(m && m.flags && m.flags.has('\\Seen')).toBeFalsy();
    } finally {
      lock.release();
      await bad.logout();
    }
    expect(server.violations.some((v) => v.startsWith('SELECT'))).toBe(true);
    server.violations.length = 0; // Gegenprobe zurücksetzen
  });
});

describe('Suche gleicht Schwächen der iCloud-Serversuche aus', () => {
  it('findet ein Wort aus einem MIME-kodierten Betreff auch bei der Volltextsuche (TEXT)', async () => {
    const raw = await gateway.search('Archive', { text: 'Oktober' }, { limit: 10, localPass: 0 });
    expect(raw.total).toBe(0); // der Server allein findet es nicht
    const r = await service.search({ text: 'Oktober', mailbox: 'archive' });
    expect(r.total).toBe(1);
    expect(r.messages[0]!.subject).toBe('Rechnungsübersicht Oktober');
  });
  it('findet es in allen Ordnern und bei der Betreffsuche', async () => {
    expect((await service.search({ text: 'Oktober' })).messages.map((m) => m.mailbox)).toEqual(['Archive']);
    expect((await service.search({ subject: 'Oktober' })).total).toBe(1);
  });
  it('ein Treffer nur im Nachrichtentext wird weiterhin vom Server gefunden', async () => {
    const r = await service.search({ text: 'Inhalt von Ungelesen eins' });
    expect(r.total).toBeGreaterThanOrEqual(1);
  });
});

describe('Konversationen und Seiten über den Dienst', () => {
  it('get_thread findet Nachrichten in mehreren Ordnern über Message-ID, In-Reply-To und References', async () => {
    const first = (await service.listRecent('INBOX', 10)).messages.find((m) => m.subject === 'Ungelesen eins')!;
    const before = JSON.stringify(server.flagsSnapshot());
    const t = await service.getThread(first.id);
    expect(t.messages.map((m) => m.subject).sort()).toEqual(['Gelesen drei', 'Re: Ungelesen eins', 'Ungelesen eins']);
    expect(t.messages.map((m) => m.mailbox).sort()).toEqual(['INBOX', 'INBOX', 'Sent Messages']);
    expect(t.messages.every((m) => typeof m.excerpt === 'string' && m.excerpt.length > 0)).toBe(true);
    expect(JSON.stringify(server.flagsSnapshot())).toBe(before);
  });

  it('get_thread ohne Text liefert nur die Übersicht', async () => {
    const first = (await service.listRecent('INBOX', 10)).messages[0]!;
    const t = await service.getThread(first.id, { includeText: false });
    expect(t.messages.every((m) => !('excerpt' in m))).toBe(true);
  });

  it('get_message liefert eine kurze Nachricht in einer Seite ohne next_offset', async () => {
    const first = (await service.listRecent('INBOX', 10)).messages[0]!;
    const m = await service.getMessage(first.id);
    expect(m.page.truncated).toBe(false);
    expect(m.page.nextOffset).toBeUndefined();
    expect(m.page.totalLength).toBe(m.text.length);
  });
});

describe('Nachrichten-IDs', () => {
  it('enthalten Ordner, UIDVALIDITY und UID und lassen sich wieder lesen', async () => {
    const r = await service.listRecent('INBOX', 1);
    const ref = decodeRef(r.messages[0]!.id);
    expect(ref).toMatchObject({ path: 'INBOX', uidValidity: '1700' });
    expect(ref.uid).toBeGreaterThan(0);
  });
  it('lehnen veraltete UIDVALIDITY ab', async () => {
    const r = await service.listRecent('INBOX', 1);
    const stale = r.messages[0]!.id.replace('|1700|', '|999|');
    await expect(service.getMessage(stale)).rejects.toThrow(/veraltet/);
  });
  it.each(['', 'x', 'INBOX|1|', 'INBOX|a|1', '../../etc|1|1|2'])('lehnen ungültige ID "%s" ab', async (id) => {
    await expect(service.getMessage(id)).rejects.toThrow(/Nachrichten-ID/);
  });
});
