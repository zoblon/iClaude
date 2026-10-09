import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CalDavGateway } from '../src/core/calendar/caldav.js';
import { BackupStore } from '../src/core/calendar/backup.js';
import { describeEvent } from '../src/core/calendar/ics.js';
import { CalendarWriteService } from '../src/core/calendar/writeService.js';
import type { CalendarInfo } from '../src/core/calendar/types.js';
import { authorizeDelete } from '../src/core/permissions.js';
import { analyzeEvent } from '../src/core/calendar/ics.js';
import { createEventSchema, deleteEventSchema, registerWriteTools } from '../src/mcp/writeTools.js';
import { calendars, cfg, ev, FakeStore } from './fakeStore.js';

let store: FakeStore;
let svc: CalendarWriteService;
let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icloud-mcp-delete-'));
  dir = join(root, 'deleted');
  store = new FakeStore();
  svc = new CalendarWriteService(cfg, store, new BackupStore({ dir, zone: cfg.timezone }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const own = (extra = '') => ev('A', extra); // "Alter Titel", 21.10.2026 10:00–11:30 Berlin
const ARGS = { title: 'Alter Titel', start: '2026-10-21T10:00:00' };
const backups = () => (existsSync(dir) ? readdirSync(dir) : []);

describe('Löschen: der Normalfall', () => {
  it('löscht den Termin mit If-Match auf dessen ETag und legt vorher eine Sicherung an', async () => {
    const id = store.put('priv', 'a', own());
    const before = [...store.objects.values()][0]!;
    const r = await svc.deleteEvent({ id, ...ARGS });

    expect(store.deletes).toBe(1);
    expect(store.objects.size).toBe(0);
    expect(store.lastDelete).toEqual({ url: before.url, etag: before.etag });
    expect(r.calendar).toBe('MCP-Test');

    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_Alter Titel\.ics$/);
    expect(r.backup.path).toBe(join(dir, files[0]!));
    expect(r.backup.folder).toBe(dir);
    // Die Sicherung ist das vollständige Original, auch mit unbekannten Eigenschaften.
    expect(readFileSync(r.backup.path, 'utf8')).toBe(before.data);
    expect(readFileSync(r.backup.path, 'utf8')).toContain('X-MEINE-ERWEITERUNG:wichtig');
    expect(statSync(r.backup.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('lädt den Termin vor dem Löschen vollständig per GET, nicht aus einer Abfragekopie', async () => {
    const id = store.put('priv', 'a', own());
    store.gets = 0;
    store.queries = 0;
    await svc.deleteEvent({ id, ...ARGS });
    expect(store.gets).toBeGreaterThanOrEqual(1);
    expect(store.queries).toBe(0);
  });

  it('das Ergebnis enthält den Termin vollständig für create_event', async () => {
    const id = store.put(
      'priv',
      'a',
      ev('A', 'LOCATION:Praxis Dr. Müller\r\nDESCRIPTION:Bitte Versicherungskarte mitbringen\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:y\r\nTRIGGER:-P1D\r\nEND:VALARM'),
    );
    const r = await svc.deleteEvent({ id, ...ARGS });
    expect(r.deleted).toEqual({
      title: 'Alter Titel',
      start: '2026-10-21T10:00:00+02:00',
      end: '2026-10-21T11:30:00+02:00',
      allDay: false,
      location: 'Praxis Dr. Müller',
      notes: 'Bitte Versicherungskarte mitbringen',
      alertsMinutesBefore: [15, 1440],
      restoreHints: [],
    });
    // Alles daraus ist für create_event gültig.
    const asInput = { title: r.deleted.title, start: r.deleted.start, end: r.deleted.end, all_day: r.deleted.allDay, location: r.deleted.location, notes: r.deleted.notes, alerts_minutes_before: r.deleted.alertsMinutesBefore };
    expect(createEventSchema.safeParse(asInput).success).toBe(true);
    // Und tatsächlich wiederherstellbar: neu angelegt entsteht derselbe Termin.
    const again = await svc.createEvent({ title: r.deleted.title, start: r.deleted.start, end: r.deleted.end, allDay: r.deleted.allDay, location: r.deleted.location, notes: r.deleted.notes, alertsMinutes: r.deleted.alertsMinutesBefore });
    expect(again.event).toMatchObject({ title: 'Alter Titel', start: '2026-10-21T10:00:00+02:00', end: '2026-10-21T11:30:00+02:00', location: 'Praxis Dr. Müller' });
  });

  it('ganztägiger Termin: Datum statt Uhrzeit, Ende ist der letzte Tag', async () => {
    const data = ev('G').replace('DTSTART;TZID=Europe/Berlin:20261021T100000', 'DTSTART;VALUE=DATE:20261021').replace('DTEND;TZID=Europe/Berlin:20261021T113000', 'DTEND;VALUE=DATE:20261024');
    const id = store.put('priv', 'g', data);
    await expect(svc.deleteEvent({ id, title: 'Alter Titel', start: '2026-10-22' })).rejects.toThrow(/Startzeit passt nicht/);
    const r = await svc.deleteEvent({ id, title: 'Alter Titel', start: '2026-10-21' });
    expect(r.deleted).toMatchObject({ allDay: true, start: '2026-10-21', end: '2026-10-23' });
    expect(store.deletes).toBe(1);
  });

  it('ganzer Serientermin: Wiederholungsregel im Format von create_event', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=6'));
    const r = await svc.deleteEvent({ id, ...ARGS });
    expect(r.deleted.recurrence).toEqual({ frequency: 'WEEKLY', interval: 2, count: 6, weekdays: ['WE'] });
    expect(r.deleted.recurrenceRule).toContain('FREQ=WEEKLY');
    expect(r.deleted.restoreHints).toEqual([]);
    expect(store.deletes).toBe(1);
  });

  it('Serie mit Ausnahmen oder Sonderregel: Hinweise nennen, was create_event nicht abbilden kann', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=MONTHLY;BYDAY=2TU\r\nEXDATE;TZID=Europe/Berlin:20261117T100000'));
    const r = await svc.deleteEvent({ id, ...ARGS });
    expect(r.deleted.recurrence).toBeUndefined();
    expect(r.deleted.recurrenceRule).toContain('BYDAY=2TU');
    expect(r.deleted.restoreHints.join(' ')).toMatch(/Besonderheiten/);
    expect(r.deleted.restoreHints.join(' ')).toMatch(/Ausnahmen/);
  });

  it('Wiederholung bis zu einem Datum und täglich', () => {
    const d = describeEvent(ev('R', 'RRULE:FREQ=DAILY;UNTIL=20261031T215959Z'), 'Europe/Berlin');
    expect(d.recurrence).toEqual({ frequency: 'DAILY', until: '2026-10-31' });
  });

  it('monatlich am Tag des Beginns (BYMONTHDAY wie der Start) ist darstellbar', () => {
    const d = describeEvent(ev('R', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=21'), 'Europe/Berlin');
    expect(d.recurrence).toEqual({ frequency: 'MONTHLY' });
    expect(describeEvent(ev('R', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5'), 'Europe/Berlin').recurrence).toBeUndefined();
  });

  it('Erinnerungen mit fester Uhrzeit werden als nicht abbildbar gemeldet', () => {
    const d = describeEvent(ev('R', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER;VALUE=DATE-TIME:20261021T080000Z\r\nEND:VALARM'), 'Europe/Berlin');
    expect(d.alertsMinutesBefore).toBeUndefined();
    expect(d.restoreHints.join(' ')).toMatch(/Erinnerung/);
  });

  it('eigener Organisator ohne Teilnehmer ist erlaubt', async () => {
    const id = store.put('priv', 'o', own('ORGANIZER:mailto:ME@example.com'));
    await expect(svc.deleteEvent({ id, ...ARGS })).resolves.toBeTruthy();
    expect(store.deletes).toBe(1);
  });

  it('Titel und Startzeit werden großzügig, aber nicht beliebig verglichen', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: '  alter   TITEL ', start: '2026-10-21T10:00:00+02:00' })).resolves.toBeTruthy();
  });

  it('akzeptiert die gekürzte Form eines sehr langen Titels, wie list_events sie ausgibt', async () => {
    const long = 'L'.repeat(400);
    const id = store.put('priv', 'l', ev('L').replace('SUMMARY:Alter Titel', `SUMMARY:${long}`));
    const shown = `${'L'.repeat(300)}… [gekürzt, 400 Zeichen insgesamt]`;
    await expect(svc.deleteEvent({ id, title: shown, start: ARGS.start })).resolves.toBeTruthy();
  });

  it('räumt nach dem Löschen alte Sicherungen auf (über 90 Tage)', async () => {
    mkdirSync(dir, { recursive: true });
    const old = join(dir, '2025-01-01_000000_Uralt.ics');
    writeFileSync(old, 'x');
    const t = (Date.now() - 120 * 86_400_000) / 1000;
    (await import('node:fs')).utimesSync(old, t, t);
    const id = store.put('priv', 'a', own());
    const r = await svc.deleteEvent({ id, ...ARGS });
    expect(existsSync(old)).toBe(false);
    expect(r.prunedBackups).toBe(1);
    expect(existsSync(r.backup.path)).toBe(true);
  });
});

describe('Löschen: Ablehnungen (es wird nichts gelöscht, keine Sicherung bleibt zurück)', () => {
  const untouched = () => {
    expect(store.deletes).toBe(0);
    expect(store.objects.size).toBeGreaterThan(0);
    expect(backups()).toEqual([]);
  };

  it('falscher Titel', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: 'Anderer Titel', start: ARGS.start })).rejects.toThrow(/Titel passt nicht/);
    untouched();
  });

  it('leerer Titel', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: '   ', start: ARGS.start })).rejects.toThrow(/Titel/);
    untouched();
  });

  it('falsche Startzeit (nennt die richtige, damit der Aufruf wiederholt werden kann)', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-21T11:00:00' })).rejects.toThrow(/Startzeit passt nicht.*2026-10-21T10:00:00\+02:00/);
    untouched();
  });

  it('Startzeit in anderer Zeitzone, aber gleicher Zeitpunkt, passt', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-21T08:00:00Z' })).resolves.toBeTruthy();
  });

  it('Startzeit ohne Uhrzeit bei einem Termin mit Uhrzeit', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-21' })).rejects.toThrow(/keine Uhrzeit/);
    untouched();
  });

  it('bei einer Serie zählt der Start des ersten Termins; die Meldung weist darauf hin', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5'));
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-28T10:00:00' })).rejects.toThrow(/ERSTEN Termins/);
    untouched();
  });

  it('Termin mit Teilnehmern (iCloud könnte Absagen verschicken)', async () => {
    const id = store.put('priv', 'a', own('ATTENDEE;CN=X:mailto:x@example.com\r\nORGANIZER:mailto:me@example.com'));
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/Teilnehmer.*Absagen/s);
    untouched();
  });

  it('fremder Organisator', async () => {
    const id = store.put('priv', 'a', own('ORGANIZER:mailto:chef@firma.de'));
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/anderen Person organisiert/);
    untouched();
  });

  it('geteilter Kalender, auch mit shared_calendar', async () => {
    const id = store.put('gemeinsam', 's', own());
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/geteilten Kalender "Gemeinsam".*nie gelöscht/s);
    await expect(svc.deleteEvent({ id, ...ARGS, sharedCalendar: 'Gemeinsam' })).rejects.toThrow(/nie gelöscht.*auch nicht mit shared_calendar/s);
    untouched();
  });

  it('shared_calendar bei einem privaten Termin ist kein Weg, etwas zu erzwingen', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, ...ARGS, sharedCalendar: 'Gemeinsam' })).rejects.toThrow(/kein shared_calendar/);
    untouched();
  });

  it('einzelnes Vorkommen einer Serie (occurrence_start)', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5'));
    await expect(svc.deleteEvent({ id, ...ARGS, occurrenceStart: '2026-10-28T10:00:00+01:00' })).rejects.toThrow(/Einzelne Vorkommen.*ganze Serie/s);
    untouched();
  });

  it('Eintrag, der nur ein Vorkommen einer Serie ist (kein Haupttermin in der Datei)', async () => {
    const onlyException = ev('X', 'RECURRENCE-ID;TZID=Europe/Berlin:20261021T100000');
    const id = store.put('priv', 'x', onlyException);
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/einzelnes Vorkommen/);
    untouched();
  });

  it.each([
    ['Feiertage', 'abo', /abonniert/],
    ['Nur lesen', 'ro', /schreibgeschützt/],
    ['Familie', 'fam', /Aufgabenliste/],
  ])('Kalender "%s" (nicht beschreibbar oder keine Termine)', async (_n, slug, msg) => {
    const id = store.put(slug, 'x', own());
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(msg);
    untouched();
  });

  it('der Termin wurde seit dem Abruf geändert (ETag aus dem Abruf passt nicht)', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, ...ARGS, etag: '"alt"' })).rejects.toThrow(/seit dem Abruf geändert.*nichts gelöscht/s);
    untouched();
  });

  it('der Termin wird zwischen Lesen und Löschen von jemand anderem geändert: If-Match schlägt an, die Sicherung wird entfernt', async () => {
    const id = store.put('priv', 'a', own());
    store.afterGet = (o) => store.objects.set(o.url, { ...o, etag: '"von-dritten-geaendert"' });
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/inzwischen geändert/);
    expect(store.deletes).toBe(0);
    expect(store.objects.size).toBe(1);
    expect(backups()).toEqual([]);
  });

  it('kein ETag vom Server: es wird nicht gelöscht', async () => {
    const id = store.put('priv', 'a', own());
    const url = [...store.objects.keys()][0]!;
    store.objects.set(url, { url, data: own() });
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/ETag/);
    untouched();
  });

  it('Sicherung schlägt fehl: es wird nicht gelöscht', async () => {
    writeFileSync(dir, 'Datei statt Ordner'); // der Sicherungsordner kann nicht angelegt werden
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/Sicherung.*NICHT gelöscht/s);
    expect(store.deletes).toBe(0);
    expect(store.objects.size).toBe(1);
  });

  it('ohne eingerichteten Sicherungsspeicher wird nie gelöscht', async () => {
    const bare = new CalendarWriteService(cfg, store);
    const id = store.put('priv', 'a', own());
    await expect(bare.deleteEvent({ id, ...ARGS })).rejects.toThrow(/nicht eingerichtet/);
    expect(store.deletes).toBe(0);
  });

  it('Termin nicht gefunden', async () => {
    await expect(svc.deleteEvent({ id: '/u/calendars/priv/gibtsnicht.ics', ...ARGS })).rejects.toThrow(/nicht gefunden/);
    expect(store.deletes).toBe(0);
  });

  it.each([
    ['https://evil.example.com/u/calendars/priv/a.ics'],
    ['/u/calendars/priv/../gemeinsam/a.ics'],
    ['/u/calendars/priv/a.txt'],
    ['/andere/calendars/x/a.ics'],
  ])('ungültige ID %s', async (id) => {
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/ID/);
    expect(store.deletes).toBe(0);
  });

  it('löscht höchstens einen Termin je Aufruf: die anderen bleiben', async () => {
    const a = store.put('priv', 'a', own());
    store.put('priv', 'b', ev('B'));
    await svc.deleteEvent({ id: a, ...ARGS });
    expect(store.objects.size).toBe(1);
  });
});

describe('Rechteprüfung authorizeDelete', () => {
  const facts = (ics: string) => analyzeEvent(ics);
  const priv = calendars[0]!;
  it('stellt nur für private, beschreibbare Termin-Kalender eine Freigabe aus', () => {
    expect(authorizeDelete({ calendar: priv, facts: facts(ev('A')), selfAddresses: [cfg.appleId] }).op).toBe('delete');
    for (const c of [calendars[2]!, calendars[3]!, calendars[4]!, calendars[5]!]) {
      expect(() => authorizeDelete({ calendar: c, facts: facts(ev('A')), selfAddresses: [cfg.appleId], sharedCalendar: c.name })).toThrow();
    }
  });
  it('die Freigabe gilt nur zum Löschen', async () => {
    const grant = authorizeDelete({ calendar: priv, facts: facts(ev('A')), selfAddresses: [cfg.appleId] });
    await expect(store.updateObject(grant, { url: 'x', etag: '"1"', data: 'x' })).rejects.toThrow(/ohne Freigabe/);
    await expect(store.createObject(grant, 'ABCDEFGH-1234.ics', 'x')).rejects.toThrow(/ohne Freigabe/);
  });
});

describe('Werkzeug delete_event', () => {
  it('Schema: id, title und start sind Pflicht, unbekannte Felder werden abgelehnt', () => {
    const ok = { id: '/u/calendars/priv/a.ics', title: 'T', start: '2026-10-21T10:00:00' };
    expect(deleteEventSchema.safeParse(ok).success).toBe(true);
    for (const missing of ['id', 'title', 'start']) {
      const { [missing]: _drop, ...rest } = ok as Record<string, string>;
      expect(deleteEventSchema.safeParse(rest).success, missing).toBe(false);
    }
    for (const extra of ['attendees', 'force', 'permanent', 'calendar']) {
      expect(deleteEventSchema.safeParse({ ...ok, [extra]: 'x' }).success, extra).toBe(false);
    }
    expect(deleteEventSchema.safeParse({ ...ok, id: '' }).success).toBe(false);
  });

  it('ist als destruktiv gekennzeichnet, nicht schreibgeschützt, und beschreibt klar, was passiert', () => {
    const tools: Record<string, { description: string; annotations: Record<string, boolean> }> = {};
    registerWriteTools({ registerTool: (n: string, c: never) => (tools[n] = c) } as never, svc);
    const t = tools['delete_event']!;
    expect(t.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(t.description).toMatch(/PERMANENTLY deletes/);
    expect(t.description).toMatch(/iCloud itself cannot restore individual deleted events/);
    expect(t.description).toMatch(/\.ics/);
    expect(t.description).toMatch(/create_event/);
    expect(t.description).toMatch(/attendees/);
    expect(t.description).toMatch(/shared calendar/);
    expect(t.description).toMatch(/single occurrences/);
    expect(t.description).toMatch(/If the backup fails, nothing is deleted/);
  });

  it('das Ergebnis nennt Sicherung, Ordner, Wiederherstellung und dass iCloud nicht wiederherstellen kann', async () => {
    const tools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent: { zusammenfassung: string; hinweise: string[]; daten: { sicherung: { datei: string; pfad: string }; geloescht: { title: string } } } }> }> = {};
    registerWriteTools({ registerTool: (n: string, _c: unknown, h: never) => (tools[n] = { handler: h }) } as never, svc);
    const id = store.put('priv', 'a', own());
    const res = await tools['delete_event']!.handler({ id, ...ARGS });
    const out = res.structuredContent;
    expect(out.zusammenfassung).toMatch(/gelöscht/);
    expect(out.daten.geloescht.title).toBe('Alter Titel');
    expect(out.daten.sicherung.pfad).toBe(join(dir, out.daten.sicherung.datei));
    const notes = out.hinweise.join('\n');
    expect(notes).toContain(dir);
    expect(notes).toMatch(/Doppelklick.*Apple Kalender/s);
    expect(notes).toMatch(/iCloud selbst kann einzelne gelöschte Termine nicht wiederherstellen/);
    expect(notes).toMatch(/create_event/);
  });
});

describe('Löschen über die Leitung (echtes Gateway gegen einen lokalen HTTP-Server)', () => {
  let http: Server;
  let base: string;
  let seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }>;
  let status = 204;

  beforeEach(async () => {
    seen = [];
    status = 204;
    http = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.statusCode = status;
      res.end();
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => http.close(() => r()));
  });

  const calendar = (): CalendarInfo => ({ ...calendars[0]!, id: '/u/calendars/priv/', url: `${base}/u/calendars/priv/` });
  const grantFor = (c: CalendarInfo) => authorizeDelete({ calendar: c, facts: analyzeEvent(ev('A')), selfAddresses: [cfg.appleId] });

  it('sendet DELETE mit If-Match auf den ETag und der Anmeldung, und zwar nur einmal', async () => {
    const c = calendar();
    await new CalDavGateway(cfg).deleteObject(grantFor(c), { url: `${base}/u/calendars/priv/a.ics`, etag: '"abc123"' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('DELETE');
    expect(seen[0]!.url).toBe('/u/calendars/priv/a.ics');
    expect(seen[0]!.headers['if-match']).toBe('"abc123"');
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /);
  });

  it('412 (Termin inzwischen geändert) wird als klare Meldung gemeldet', async () => {
    status = 412;
    await expect(new CalDavGateway(cfg).deleteObject(grantFor(calendar()), { url: `${base}/u/calendars/priv/a.ics`, etag: '"alt"' })).rejects.toThrow(/inzwischen geändert.*nichts gelöscht/s);
  });

  it.each([
    [404, /nicht gefunden/],
    [403, /verweigert/],
    [500, /HTTP 500/],
  ])('Status %i', async (code, msg) => {
    status = code;
    await expect(new CalDavGateway(cfg).deleteObject(grantFor(calendar()), { url: `${base}/u/calendars/priv/a.ics`, etag: '"1"' })).rejects.toThrow(msg);
  });

  it('ohne ETag, mit fremder Adresse oder ohne Freigabe wird nichts gesendet', async () => {
    const gw = new CalDavGateway(cfg);
    const c = calendar();
    await expect(gw.deleteObject(grantFor(c), { url: `${base}/u/calendars/priv/a.ics`, etag: '' })).rejects.toThrow(/ETag/);
    await expect(gw.deleteObject(grantFor(c), { url: `${base}/u/calendars/gemeinsam/a.ics`, etag: '"1"' })).rejects.toThrow(/gehört nicht zu diesem Kalender/);
    await expect(gw.deleteObject(grantFor(c), { url: `${base}/u/calendars/priv/../gemeinsam/a.ics`, etag: '"1"' })).rejects.toThrow(/gehört nicht zu diesem Kalender/);
    await expect(gw.deleteObject(grantFor(c), { url: 'http://evil.example.com/u/calendars/priv/a.ics', etag: '"1"' })).rejects.toThrow(/gehört nicht zu diesem Kalender/);
    await expect(gw.deleteObject({ op: 'delete', calendar: c } as never, { url: `${base}/u/calendars/priv/a.ics`, etag: '"1"' })).rejects.toThrow(/ohne Freigabe/);
    expect(seen).toEqual([]);
  });
});
