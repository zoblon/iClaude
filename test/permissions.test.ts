import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CalDavGateway, classifyCalendar } from '../src/core/calendar/caldav.js';
import { CalendarWriteService } from '../src/core/calendar/writeService.js';
import { calendars, cfg, ev, FakeStore } from './fakeStore.js';
import { createEventSchema, updateEventSchema } from '../src/mcp/writeTools.js';

let store: FakeStore;
let svc: CalendarWriteService;
beforeEach(() => {
  store = new FakeStore();
  svc = new CalendarWriteService(cfg, store);
});

const base = { title: 'Test', start: '2026-10-20T14:00:00' };

describe('Anlegen: geteilte Kalender nur bei ausdrücklicher Nennung', () => {
  it('schreibt ohne Angabe in den privaten Standardkalender', async () => {
    const r = await svc.createEvent(base);
    expect(r.calendar).toBe('MCP-Test');
    expect(r.shared).toBe(false);
    expect(store.creates).toBe(1);
    expect([...store.objects.keys()][0]).toContain('/priv/');
  });

  it('lehnt einen geteilten Kalender über "calendar" ab und nennt den richtigen Weg', async () => {
    await expect(svc.createEvent({ ...base, calendar: 'Gemeinsam' })).rejects.toThrow(/geteilter Kalender.*shared_calendar="Gemeinsam"/s);
    expect(store.creates).toBe(0);
  });

  it('lehnt auch Groß-/Kleinschreibung-Varianten über "calendar" ab', async () => {
    await expect(svc.createEvent({ ...base, calendar: 'gemeinsam' })).rejects.toThrow(/geteilter Kalender/);
    expect(store.creates).toBe(0);
  });

  it('schreibt in den geteilten Kalender nur mit shared_calendar', async () => {
    const r = await svc.createEvent({ ...base, sharedCalendar: 'Gemeinsam' });
    expect(r.calendar).toBe('Gemeinsam');
    expect(r.shared).toBe(true);
    expect(store.creates).toBe(1);
  });

  it('lehnt shared_calendar für einen privaten Kalender ab', async () => {
    await expect(svc.createEvent({ ...base, sharedCalendar: 'MCP-Test' })).rejects.toThrow(/kein geteilter Kalender/);
    expect(store.creates).toBe(0);
  });

  it('lehnt calendar und shared_calendar zusammen ab', async () => {
    await expect(svc.createEvent({ ...base, calendar: 'MCP-Test', sharedCalendar: 'Gemeinsam' })).rejects.toThrow(/nur eines/);
    expect(store.creates).toBe(0);
  });

  it('weigert sich, wenn der Standardkalender ein geteilter Kalender ist', async () => {
    const s = new CalendarWriteService({ ...cfg, defaultCalendar: 'Gemeinsam' }, store);
    await expect(s.createEvent(base)).rejects.toThrow(/Standardkalender darf nicht geteilt sein/);
    expect(store.creates).toBe(0);
  });

  it('schreibt nirgends hin, wenn weder Kalender noch Standardkalender bekannt sind', async () => {
    const s = new CalendarWriteService({ ...cfg, defaultCalendar: undefined }, store);
    await expect(s.createEvent(base)).rejects.toThrow(/Kein Kalender angegeben/);
    expect(store.creates).toBe(0);
  });

  it.each([
    ['Feiertage', /abonniert/],
    ['Nur lesen', /schreibgeschützt/],
    ['Familie', /Aufgabenliste/],
    ['Gibtsnicht', /nicht gefunden/],
  ])('lehnt "%s" ab', async (name, msg) => {
    await expect(svc.createEvent({ ...base, calendar: name })).rejects.toThrow(msg);
    await expect(svc.createEvent({ ...base, sharedCalendar: name })).rejects.toThrow();
    expect(store.creates).toBe(0);
  });
});

describe('Keine Einladungen', () => {
  it('Schema akzeptiert keine Teilnehmer- oder Organisator-Felder', () => {
    const ok = createEventSchema.safeParse({ title: 'x', start: '2026-10-20T14:00:00' });
    expect(ok.success).toBe(true);
    for (const field of ['attendees', 'attendee', 'organizer', 'invitees', 'method']) {
      const r = createEventSchema.safeParse({ title: 'x', start: '2026-10-20T14:00:00', [field]: ['a@b.de'] });
      expect(r.success, field).toBe(false);
      const u = updateEventSchema.safeParse({ id: '/u/calendars/priv/a.ics', title: 'x', [field]: ['a@b.de'] });
      expect(u.success, field).toBe(false);
    }
  });

  it('eingeschleuste Teilnehmer in Textfeldern landen nicht im Termin', async () => {
    const evil = 'Hi\r\nATTENDEE;CN=X:mailto:opfer@example.com\r\nORGANIZER:mailto:x@example.com';
    await svc.createEvent({ ...base, title: evil, location: evil, notes: evil });
    const data = [...store.objects.values()][0]!.data;
    expect(data).not.toMatch(/^ATTENDEE/m);
    expect(data).not.toMatch(/^ORGANIZER/m);
    expect(data).not.toMatch(/^METHOD/m);
  });
});

describe('Ändern', () => {
  it('ändert einen eigenen Termin, erhält unbekannte Eigenschaften und erhöht den ETag', async () => {
    const id = store.put('priv', 'a', ev('A'));
    const before = [...store.objects.values()][0]!;
    const r = await svc.updateEvent({ id, etag: before.etag!, title: 'Neuer Titel' });
    expect(r.event.title).toBe('Neuer Titel');
    const after = [...store.objects.values()][0]!;
    expect(after.etag).not.toBe(before.etag);
    expect(after.data).toContain('X-APPLE-STRUCTURED-LOCATION');
    expect(after.data).toContain('X-MEINE-ERWEITERUNG:wichtig');
    expect(after.data).toContain('DTSTART;TZID=Europe/Berlin:20261021T100000');
  });

  it('lädt vor jeder Änderung den kompletten Termin per GET und nutzt keine Abfragekopie', async () => {
    const id = store.put('priv', 'a', ev('A'));
    store.gets = 0;
    store.queries = 0;
    await svc.updateEvent({ id, title: 'Neu' });
    expect(store.gets).toBeGreaterThanOrEqual(1);
    expect(store.queries).toBe(0);
    // Die Teilkopie aus einer Abfrage hätte die X-Eigenschaften verloren; geschrieben wurde das vollständige Original.
    const stored = [...store.objects.values()][0]!.data;
    expect(stored).toContain('X-MEINE-ERWEITERUNG:wichtig');
    expect(stored).toContain('X-APPLE-STRUCTURED-LOCATION');
  });

  it('erhöht SEQUENCE um eins und setzt LAST-MODIFIED neu', async () => {
    const id = store.put('priv', 'a', ev('A')); // SEQUENCE:1, kein LAST-MODIFIED
    const before = Date.now();
    await svc.updateEvent({ id, title: 'Neu' });
    const stored = [...store.objects.values()][0]!.data;
    expect(stored).toMatch(/^SEQUENCE:2$/m);
    const m = /^LAST-MODIFIED:(\d{8}T\d{6}Z)$/m.exec(stored);
    expect(m).not.toBeNull();
    const t = Date.parse(m![1]!.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
    expect(t).toBeGreaterThanOrEqual(before - 2000);
    expect(t).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('verschiebt mit nur "start" und behält die Dauer (90 Minuten)', async () => {
    const id = store.put('priv', 'a', ev('A'));
    const r = await svc.updateEvent({ id, start: '2026-10-22T09:00:00' });
    expect(r.event.start).toBe('2026-10-22T09:00:00+02:00');
    expect(r.event.end).toBe('2026-10-22T10:30:00+02:00');
  });

  it('lehnt Termine mit Teilnehmern ab und ändert nichts', async () => {
    const id = store.put('priv', 'a', ev('A', 'ATTENDEE;CN=X:mailto:x@example.com\r\nORGANIZER:mailto:me@example.com'));
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/Teilnehmer/);
    expect(store.updates).toBe(0);
  });

  it('lehnt Termine mit fremdem Organisator ab, erlaubt den eigenen', async () => {
    const foreign = store.put('priv', 'f', ev('F', 'ORGANIZER:mailto:chef@firma.de'));
    await expect(svc.updateEvent({ id: foreign, title: 'x' })).rejects.toThrow(/anderen Person organisiert/);
    expect(store.updates).toBe(0);
    const own = store.put('priv', 'o', ev('O', 'ORGANIZER:mailto:ME@example.com'));
    await expect(svc.updateEvent({ id: own, title: 'x' })).resolves.toBeTruthy();
    expect(store.updates).toBe(1);
  });

  it('verlangt für Termine in geteilten Kalendern die ausdrückliche Nennung', async () => {
    const id = store.put('gemeinsam', 's', ev('S'));
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/shared_calendar="Gemeinsam"/);
    await expect(svc.updateEvent({ id, title: 'x', sharedCalendar: 'Termine' })).rejects.toThrow(/shared_calendar="Gemeinsam"/);
    expect(store.updates).toBe(0);
    const r = await svc.updateEvent({ id, title: 'x', sharedCalendar: 'Gemeinsam' });
    expect(r.shared).toBe(true);
    expect(store.updates).toBe(1);
  });

  it('lehnt shared_calendar bei privatem Termin ab', async () => {
    const id = store.put('priv', 'a', ev('A'));
    await expect(svc.updateEvent({ id, title: 'x', sharedCalendar: 'Gemeinsam' })).rejects.toThrow(/kein geteilter Kalender/);
  });

  it('lehnt Änderungen an einzelnen Vorkommen ab, erlaubt die ganze Serie', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5'));
    await expect(svc.updateEvent({ id, title: 'x', occurrenceStart: '2026-10-28T10:00:00+01:00' })).rejects.toThrow(/einzelnen Vorkommen/);
    expect(store.updates).toBe(0);
    const r = await svc.updateEvent({ id, title: 'Ganze Serie' });
    expect(r.event.recurring).toBe(true);
    expect(store.updates).toBe(1);
  });

  it('ändert die Zeit einer Serie mit Ausnahmen nicht, wohl aber den Titel', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5\r\nEXDATE;TZID=Europe/Berlin:20261028T100000'));
    await expect(svc.updateEvent({ id, start: '2026-10-22T09:00:00' })).rejects.toThrow(/Ausnahmen/);
    expect(store.updates).toBe(0);
    await expect(svc.updateEvent({ id, title: 'ok' })).resolves.toBeTruthy();
  });

  it('lehnt ab, wenn der übergebene ETag nicht mehr passt', async () => {
    const id = store.put('priv', 'a', ev('A'));
    await expect(svc.updateEvent({ id, etag: '"alt"', title: 'x' })).rejects.toThrow(/seit dem Abruf geändert/);
    expect(store.updates).toBe(0);
  });

  it('akzeptiert den ETag auch ohne Anführungszeichen oder mit W/, lehnt aber andere ab', async () => {
    const id = store.put('priv', 'a', ev('A'));
    const etag = [...store.objects.values()][0]!.etag!; // z. B. "e1" mit Anführungszeichen
    const bare = etag.replace(/"/g, '');
    await expect(svc.updateEvent({ id, etag: bare, title: 'eins' })).resolves.toBeTruthy();
    const next = [...store.objects.values()][0]!.etag!;
    await expect(svc.updateEvent({ id, etag: `W/${next}`, title: 'zwei' })).resolves.toBeTruthy();
    await expect(svc.updateEvent({ id, etag: bare, title: 'drei' })).rejects.toThrow(/seit dem Abruf geändert/);
  });

  it('lehnt ab, wenn der Termin zwischen Lesen und Schreiben von jemand anderem geändert wurde', async () => {
    const id = store.put('priv', 'a', ev('A'));
    store.afterGet = (o) => {
      // Dritter ändert den Termin direkt nach unserem Lesen
      store.objects.set(o.url, { ...o, etag: '"von-dritten-geaendert"' });
    };
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/inzwischen geändert/);
    expect(store.updates).toBe(0);
  });

  it('schreibt nicht ohne ETag', async () => {
    const id = store.put('priv', 'a', ev('A'));
    store.objects.set([...store.objects.keys()][0]!, { url: [...store.objects.keys()][0]!, data: ev('A') });
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/ETag/);
  });

  it.each([
    ['https://evil.example.com/u/calendars/priv/a.ics'],
    ['/u/calendars/priv/../gemeinsam/a.ics'],
    ['/u/calendars/priv/a.txt'],
    ['/andere/calendars/x/a.ics'],
  ])('lehnt die ungültige ID %s ab', async (id) => {
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/ID/);
    expect(store.updates).toBe(0);
  });

  it('verlangt mindestens eine Änderung', async () => {
    const id = store.put('priv', 'a', ev('A'));
    await expect(svc.updateEvent({ id })).rejects.toThrow(/Keine Änderung/);
  });
});

describe('Erkennung geteilter Kalender (im Zweifel geteilt)', () => {
  const me = '/123/principal/';
  it('privat nur bei eigenem Eigentümer ohne Freigabe-Merkmale', () => {
    expect(classifyCalendar({ resourcetype: { calendar: {} }, owner: { href: me }, currentUserPrivilegeSet: { privilege: [{ write: {} }] } }, me)).toMatchObject({ shared: false, writable: true });
  });
  it.each([
    ['sharedOwner', { resourcetype: { calendar: {}, sharedOwner: {} }, owner: me }],
    ['shared', { resourcetype: { calendar: {}, shared: {} }, owner: me }],
    ['invite', { resourcetype: { calendar: {} }, owner: me, invite: {} }],
    ['sharedUrl', { resourcetype: { calendar: {} }, owner: me, sharedUrl: 'x' }],
    ['fremder Eigentümer', { resourcetype: { calendar: {} }, owner: '/999/principal/' }],
    ['kein Eigentümer erkennbar', { resourcetype: { calendar: {} } }],
  ])('%s gilt als geteilt', (_n, props) => {
    expect(classifyCalendar(props, me).shared).toBe(true);
  });
  it('gilt als geteilt, wenn der eigene Account unbekannt ist', () => {
    expect(classifyCalendar({ resourcetype: { calendar: {} }, owner: me }, '').shared).toBe(true);
  });
  it('abonnierte Kalender sind nicht beschreibbar', () => {
    expect(classifyCalendar({ resourcetype: { calendar: {}, subscribed: {} }, owner: me }, me).subscribed).toBe(true);
  });
});

describe('Schreiben nur mit Freigabe', () => {
  it('das echte Gateway lehnt gefälschte Freigaben ab, bevor etwas gesendet wird', async () => {
    const gw = new CalDavGateway(cfg);
    const forged = { op: 'create', calendar: calendars[0] } as never;
    await expect(gw.createObject(forged, 'ABCDEFGH-1234.ics', 'x')).rejects.toThrow(/ohne Freigabe/);
    await expect(gw.updateObject({ op: 'update', calendar: calendars[0] } as never, { url: 'https://x/', etag: '"1"', data: 'x' })).rejects.toThrow(/ohne Freigabe/);
  });
});

describe('Löschen, Senden und Verschieben im Code: nur die zwei erlaubten Wege', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = files('src').map((f) => ({ f: f.split('\\').join('/'), text: readFileSync(f, 'utf8') }));
  const code = src.map(({ f, text }) => ({ f, code: strip(text) }));

  it('nur delete_event und trash_message tragen Lösch-/Verschiebe-Namen, sonst gibt es kein Werkzeug dieser Art', () => {
    const names = src.flatMap(({ text }) => [...text.matchAll(/registerTool\(\s*'([^']+)'/g)].map((m) => m[1]!));
    expect(names).toEqual(expect.arrayContaining(['list_calendars', 'list_events', 'search_events', 'find_free_slots', 'create_event', 'update_event', 'search_contacts', 'get_contact', 'delete_event', 'trash_message']));
    const risky = names.filter((n) => /delete|remove|cancel|send|move|mark|flag|archive|trash|expunge|forward|reply/i.test(n));
    expect(risky.sort()).toEqual(['delete_event', 'trash_message']);
  });

  it('verbotene Funktionen kommen im Code nirgends vor (kein Senden, kein Löschen von Kontakten, keine Flags, kein EXPUNGE, kein Rückfall auf COPY)', () => {
    const forbidden = [
      /deleteCalendarObject/, /deleteVCard/, /createVCard/, /updateVCard/,
      /createTransport/, /sendMail/, /from 'nodemailer'/, /smtp/i,
      /messageDelete/, /messageCopy/, /messageFlags(Add|Remove|Set)/, /\.setFlagColor/, /mailboxDelete/, /mailboxRename/, /\.expunge/i, /\bEXPUNGE\b/,
    ];
    for (const { f, code: c } of code) for (const re of forbidden) expect(c, `${f}: ${re}`).not.toMatch(re);
    // Das Merkmal \\Deleted kommt nur im Beschreibungstext des Werkzeugs vor ("setzt es nicht"), nie im übrigen Code.
    for (const { f, code: c } of code) if (f !== 'src/mcp/trashTools.ts') expect(c, `${f}: \\Deleted`).not.toMatch(/\\+Deleted/);
  });

  it('Termine werden nur im CalDAV-Gateway gelöscht (ein einziges DELETE) und nur über deleteObject', () => {
    for (const { f, code: c } of code) {
      const allowedFile = f === 'src/core/calendar/caldav.ts';
      expect(/method:\s*'DELETE'/.test(c), `${f}: DELETE`).toBe(allowedFile);
      expect(/\bdeleteObject\b/.test(c), `${f}: deleteObject`).toBe(['src/core/calendar/caldav.ts', 'src/core/calendar/types.ts', 'src/core/calendar/writeService.ts'].includes(f));
      expect(/\.delete\(/.test(c), `${f}: .delete(`).toBe(false);
    }
    const caldav = code.find((x) => x.f === 'src/core/calendar/caldav.ts')!.code;
    expect(caldav.match(/method:\s*'DELETE'/g)).toHaveLength(1);
    // Das einzige DELETE steht in deleteObject, hinter der Prüfung der Freigabe.
    const body = caldav.slice(caldav.indexOf('async deleteObject'));
    expect(body.indexOf("WriteGrant.isValid(grant, 'delete')")).toBeGreaterThan(-1);
    expect(body.indexOf("WriteGrant.isValid(grant, 'delete')")).toBeLessThan(body.indexOf("method: 'DELETE'"));
  });

  it('Mails werden nur in moveToTrash verschoben: direktes UID MOVE, nie imapflow.messageMove (dessen Rückfall wäre COPY + Löschen-Markierung + EXPUNGE)', () => {
    for (const { f, code: c } of code) {
      expect(/messageMove/.test(c), `${f}: messageMove`).toBe(false);
      // Rohe IMAP-Befehle (exec('GROSSBUCHSTABEN', …)) gibt es nur in imap.ts; RegExp.exec ist etwas anderes.
      expect(/\bexec\(\s*'[A-Z]/.test(c), `${f}: exec mit IMAP-Befehl`).toBe(f === 'src/core/mail/imap.ts');
    }
    const imap = code.find((x) => x.f === 'src/core/mail/imap.ts')!.code;
    expect([...imap.matchAll(/exec\(\s*'([A-Z][^']*)'/g)].map((m) => m[1])).toEqual(['UID MOVE']); // genau ein Aufruf
    const fn = imap.slice(imap.indexOf('async moveToTrash'), imap.indexOf('async close'));
    expect(fn).toContain("TrashGrant.isValid(grant)");
    expect(fn.indexOf('TrashGrant.isValid(grant)')).toBeLessThan(fn.indexOf("w.exec('UID MOVE'"));
    // Die schmale Lese-Schnittstelle kennt keine verändernden Methoden.
    const like = imap.slice(imap.indexOf('export interface ImapLike'), imap.indexOf('interface ImapAppend'));
    expect(like).not.toMatch(/messageMove|messageDelete|append|messageFlags|store\(|exec\(/);
  });

  it('Dateien werden nur im Sicherungsspeicher entfernt', () => {
    for (const { f, code: c } of code) {
      expect(/\b(unlink|unlinkSync|rmdir|rmSync)\b|\brm\(/.test(c), `${f}: Datei entfernen`).toBe(f === 'src/core/calendar/backup.ts');
    }
  });

  it('die Speicher-Schnittstelle kennt als Löschen nur deleteObject', () => {
    const types = readFileSync('src/core/calendar/types.ts', 'utf8');
    const hits = [...strip(types).matchAll(/\b\w*(delete|remove)\w*\b/gi)].map((m) => m[0]);
    expect(hits).toEqual(['deleteObject']);
  });

  it('die Lese-Schnittstelle für Mail hat weiterhin keine verändernde Methode', () => {
    const types = readFileSync('src/core/mail/types.ts', 'utf8');
    const reader = types.slice(types.indexOf('export interface MailReader'), types.indexOf('/** Ablegen von Entwürfen'));
    expect(reader).not.toMatch(/delete|remove|move|trash|flag|store|append/i);
  });

  it('Gateways lehnen gefälschte Löschfreigaben ab, bevor etwas gesendet wird', async () => {
    const gw = new CalDavGateway(cfg);
    await expect(gw.deleteObject({ op: 'delete', calendar: calendars[0] } as never, { url: 'https://p1.example.com/u/calendars/priv/a.ics', etag: '"1"' })).rejects.toThrow(/ohne Freigabe/);
    const update = { op: 'update', calendar: calendars[0] } as never;
    await expect(gw.deleteObject(update, { url: 'https://p1.example.com/u/calendars/priv/a.ics', etag: '"1"' })).rejects.toThrow(/ohne Freigabe/);
  });
});
