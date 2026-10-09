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

const own = (extra = '') => ev('A', extra); // "Old title", 2026-10-21 10:00–11:30 Berlin
const ARGS = { title: 'Old title', start: '2026-10-21T10:00:00' };
const backups = () => (existsSync(dir) ? readdirSync(dir) : []);

describe('Deleting: the normal case', () => {
  it('deletes the event with If-Match on its ETag and creates a backup first', async () => {
    const id = store.put('priv', 'a', own());
    const before = [...store.objects.values()][0]!;
    const r = await svc.deleteEvent({ id, ...ARGS });

    expect(store.deletes).toBe(1);
    expect(store.objects.size).toBe(0);
    expect(store.lastDelete).toEqual({ url: before.url, etag: before.etag });
    expect(r.calendar).toBe('MCP-Test');

    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_Old title\.ics$/);
    expect(r.backup.path).toBe(join(dir, files[0]!));
    expect(r.backup.folder).toBe(dir);
    // The backup is the complete original, including unknown properties.
    expect(readFileSync(r.backup.path, 'utf8')).toBe(before.data);
    expect(readFileSync(r.backup.path, 'utf8')).toContain('X-MY-EXTENSION:important');
    expect(statSync(r.backup.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('loads the complete event via GET before deleting, not from a query copy', async () => {
    const id = store.put('priv', 'a', own());
    store.gets = 0;
    store.queries = 0;
    await svc.deleteEvent({ id, ...ARGS });
    expect(store.gets).toBeGreaterThanOrEqual(1);
    expect(store.queries).toBe(0);
  });

  it('the result contains the complete event for create_event', async () => {
    const id = store.put(
      'priv',
      'a',
      ev('A', 'LOCATION:Practice Dr. Müller\r\nDESCRIPTION:Please bring your insurance card\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:y\r\nTRIGGER:-P1D\r\nEND:VALARM'),
    );
    const r = await svc.deleteEvent({ id, ...ARGS });
    expect(r.deleted).toEqual({
      title: 'Old title',
      start: '2026-10-21T10:00:00+02:00',
      end: '2026-10-21T11:30:00+02:00',
      allDay: false,
      location: 'Practice Dr. Müller',
      notes: 'Please bring your insurance card',
      alertsMinutesBefore: [15, 1440],
      restoreHints: [],
    });
    // Everything in it is valid for create_event.
    const asInput = { title: r.deleted.title, start: r.deleted.start, end: r.deleted.end, all_day: r.deleted.allDay, location: r.deleted.location, notes: r.deleted.notes, alerts_minutes_before: r.deleted.alertsMinutesBefore };
    expect(createEventSchema.safeParse(asInput).success).toBe(true);
    // And actually restorable: re-creating it yields the same event.
    const again = await svc.createEvent({ title: r.deleted.title, start: r.deleted.start, end: r.deleted.end, allDay: r.deleted.allDay, location: r.deleted.location, notes: r.deleted.notes, alertsMinutes: r.deleted.alertsMinutesBefore });
    expect(again.event).toMatchObject({ title: 'Old title', start: '2026-10-21T10:00:00+02:00', end: '2026-10-21T11:30:00+02:00', location: 'Practice Dr. Müller' });
  });

  it('all-day event: date instead of time, end is the last day', async () => {
    const data = ev('G').replace('DTSTART;TZID=Europe/Berlin:20261021T100000', 'DTSTART;VALUE=DATE:20261021').replace('DTEND;TZID=Europe/Berlin:20261021T113000', 'DTEND;VALUE=DATE:20261024');
    const id = store.put('priv', 'g', data);
    await expect(svc.deleteEvent({ id, title: 'Old title', start: '2026-10-22' })).rejects.toThrow(/start time does not match/);
    const r = await svc.deleteEvent({ id, title: 'Old title', start: '2026-10-21' });
    expect(r.deleted).toMatchObject({ allDay: true, start: '2026-10-21', end: '2026-10-23' });
    expect(store.deletes).toBe(1);
  });

  it('whole recurring series: recurrence rule in the create_event format', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=6'));
    const r = await svc.deleteEvent({ id, ...ARGS });
    expect(r.deleted.recurrence).toEqual({ frequency: 'WEEKLY', interval: 2, count: 6, weekdays: ['WE'] });
    expect(r.deleted.recurrenceRule).toContain('FREQ=WEEKLY');
    expect(r.deleted.restoreHints).toEqual([]);
    expect(store.deletes).toBe(1);
  });

  it('series with exceptions or a special rule: hints name what create_event cannot represent', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=MONTHLY;BYDAY=2TU\r\nEXDATE;TZID=Europe/Berlin:20261117T100000'));
    const r = await svc.deleteEvent({ id, ...ARGS });
    expect(r.deleted.recurrence).toBeUndefined();
    expect(r.deleted.recurrenceRule).toContain('BYDAY=2TU');
    expect(r.deleted.restoreHints.join(' ')).toMatch(/special parts/);
    expect(r.deleted.restoreHints.join(' ')).toMatch(/exceptions/);
  });

  it('daily recurrence until a date', () => {
    const d = describeEvent(ev('R', 'RRULE:FREQ=DAILY;UNTIL=20261031T215959Z'), 'Europe/Berlin');
    expect(d.recurrence).toEqual({ frequency: 'DAILY', until: '2026-10-31' });
  });

  it('monthly on the start day (BYMONTHDAY equal to the start) is representable', () => {
    const d = describeEvent(ev('R', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=21'), 'Europe/Berlin');
    expect(d.recurrence).toEqual({ frequency: 'MONTHLY' });
    expect(describeEvent(ev('R', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=5'), 'Europe/Berlin').recurrence).toBeUndefined();
  });

  it('reminders at a fixed time are reported as not representable', () => {
    const d = describeEvent(ev('R', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER;VALUE=DATE-TIME:20261021T080000Z\r\nEND:VALARM'), 'Europe/Berlin');
    expect(d.alertsMinutesBefore).toBeUndefined();
    expect(d.restoreHints.join(' ')).toMatch(/reminder/);
  });

  it('own organizer without attendees is allowed', async () => {
    const id = store.put('priv', 'o', own('ORGANIZER:mailto:ME@example.com'));
    await expect(svc.deleteEvent({ id, ...ARGS })).resolves.toBeTruthy();
    expect(store.deletes).toBe(1);
  });

  it('title and start time are compared leniently, but not arbitrarily', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: '  old   TITLE ', start: '2026-10-21T10:00:00+02:00' })).resolves.toBeTruthy();
  });

  it('accepts the truncated form of a very long title, as list_events outputs it', async () => {
    const long = 'L'.repeat(400);
    const id = store.put('priv', 'l', ev('L').replace('SUMMARY:Old title', `SUMMARY:${long}`));
    const shown = `${'L'.repeat(300)}… [truncated, 400 characters in total]`;
    await expect(svc.deleteEvent({ id, title: shown, start: ARGS.start })).resolves.toBeTruthy();
  });

  it('prunes old backups after deleting (over 90 days)', async () => {
    mkdirSync(dir, { recursive: true });
    const old = join(dir, '2025-01-01_000000_Ancient.ics');
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

describe('Deleting: refusals (nothing is deleted, no backup is left behind)', () => {
  const untouched = () => {
    expect(store.deletes).toBe(0);
    expect(store.objects.size).toBeGreaterThan(0);
    expect(backups()).toEqual([]);
  };

  it('wrong title', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: 'Other title', start: ARGS.start })).rejects.toThrow(/title does not match/);
    untouched();
  });

  it('empty title', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: '   ', start: ARGS.start })).rejects.toThrow(/title/);
    untouched();
  });

  it('wrong start time (names the correct one so the call can be repeated)', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-21T11:00:00' })).rejects.toThrow(/start time does not match.*2026-10-21T10:00:00\+02:00/);
    untouched();
  });

  it('start time in another time zone but the same instant matches', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-21T08:00:00Z' })).resolves.toBeTruthy();
  });

  it('start time without time of day for a timed event', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-21' })).rejects.toThrow(/has no time of day/);
    untouched();
  });

  it('for a series the start of the first occurrence counts; the message points this out', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5'));
    await expect(svc.deleteEvent({ id, title: ARGS.title, start: '2026-10-28T10:00:00' })).rejects.toThrow(/FIRST occurrence/);
    untouched();
  });

  it('event with attendees (iCloud could send cancellations)', async () => {
    const id = store.put('priv', 'a', own('ATTENDEE;CN=X:mailto:x@example.com\r\nORGANIZER:mailto:me@example.com'));
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/attendees.*cancellations/s);
    untouched();
  });

  it('foreign organizer', async () => {
    const id = store.put('priv', 'a', own('ORGANIZER:mailto:boss@company.example'));
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/organized by another person/);
    untouched();
  });

  it('shared calendar, even with shared_calendar', async () => {
    const id = store.put('shared', 's', own());
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/shared calendar "Shared".*never deleted/s);
    await expect(svc.deleteEvent({ id, ...ARGS, sharedCalendar: 'Shared' })).rejects.toThrow(/never deleted, not even with shared_calendar/s);
    untouched();
  });

  it('shared_calendar on a private event is no way to force anything', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, ...ARGS, sharedCalendar: 'Shared' })).rejects.toThrow(/has no shared_calendar/);
    untouched();
  });

  it('single occurrence of a series (occurrence_start)', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5'));
    await expect(svc.deleteEvent({ id, ...ARGS, occurrenceStart: '2026-10-28T10:00:00+01:00' })).rejects.toThrow(/Single occurrences.*whole series/s);
    untouched();
  });

  it('entry that is only an occurrence of a series (no master event in the file)', async () => {
    const onlyException = ev('X', 'RECURRENCE-ID;TZID=Europe/Berlin:20261021T100000');
    const id = store.put('priv', 'x', onlyException);
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/single occurrence/);
    untouched();
  });

  it.each([
    ['Holidays', 'abo', /subscribed/],
    ['Read only', 'ro', /read-only/],
    ['Family', 'fam', /tasks list/],
  ])('calendar "%s" (not writable or no events)', async (_n, slug, msg) => {
    const id = store.put(slug, 'x', own());
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(msg);
    untouched();
  });

  it('the event has changed since it was fetched (the fetched ETag does not match)', async () => {
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, ...ARGS, etag: '"old"' })).rejects.toThrow(/changed since it was fetched.*Nothing was deleted/s);
    untouched();
  });

  it('the event is changed by someone else between reading and deleting: If-Match fails, the backup is removed', async () => {
    const id = store.put('priv', 'a', own());
    store.afterGet = (o) => store.objects.set(o.url, { ...o, etag: '"changed-by-third-party"' });
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/changed in the meantime/);
    expect(store.deletes).toBe(0);
    expect(store.objects.size).toBe(1);
    expect(backups()).toEqual([]);
  });

  it('no ETag from the server: nothing is deleted', async () => {
    const id = store.put('priv', 'a', own());
    const url = [...store.objects.keys()][0]!;
    store.objects.set(url, { url, data: own() });
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/ETag/);
    untouched();
  });

  it('backup fails: nothing is deleted', async () => {
    writeFileSync(dir, 'file instead of folder'); // the backup folder cannot be created
    const id = store.put('priv', 'a', own());
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/backup.*NOT deleted/s);
    expect(store.deletes).toBe(0);
    expect(store.objects.size).toBe(1);
  });

  it('without a configured backup store nothing is ever deleted', async () => {
    const bare = new CalendarWriteService(cfg, store);
    const id = store.put('priv', 'a', own());
    await expect(bare.deleteEvent({ id, ...ARGS })).rejects.toThrow(/not set up/);
    expect(store.deletes).toBe(0);
  });

  it('event not found', async () => {
    await expect(svc.deleteEvent({ id: '/u/calendars/priv/doesnotexist.ics', ...ARGS })).rejects.toThrow(/not found/);
    expect(store.deletes).toBe(0);
  });

  it.each([
    ['https://evil.example.com/u/calendars/priv/a.ics'],
    ['/u/calendars/priv/../shared/a.ics'],
    ['/u/calendars/priv/a.txt'],
    ['/other/calendars/x/a.ics'],
  ])('invalid ID %s', async (id) => {
    await expect(svc.deleteEvent({ id, ...ARGS })).rejects.toThrow(/ID/);
    expect(store.deletes).toBe(0);
  });

  it('deletes at most one event per call: the others stay', async () => {
    const a = store.put('priv', 'a', own());
    store.put('priv', 'b', ev('B'));
    await svc.deleteEvent({ id: a, ...ARGS });
    expect(store.objects.size).toBe(1);
  });
});

describe('Permission check authorizeDelete', () => {
  const facts = (ics: string) => analyzeEvent(ics);
  const priv = calendars[0]!;
  it('issues a grant only for private, writable event calendars', () => {
    expect(authorizeDelete({ calendar: priv, facts: facts(ev('A')), selfAddresses: [cfg.appleId] }).op).toBe('delete');
    for (const c of [calendars[2]!, calendars[3]!, calendars[4]!, calendars[5]!]) {
      expect(() => authorizeDelete({ calendar: c, facts: facts(ev('A')), selfAddresses: [cfg.appleId], sharedCalendar: c.name })).toThrow();
    }
  });
  it('the grant is valid only for deleting', async () => {
    const grant = authorizeDelete({ calendar: priv, facts: facts(ev('A')), selfAddresses: [cfg.appleId] });
    await expect(store.updateObject(grant, { url: 'x', etag: '"1"', data: 'x' })).rejects.toThrow(/without grant/);
    await expect(store.createObject(grant, 'ABCDEFGH-1234.ics', 'x')).rejects.toThrow(/without grant/);
  });
});

describe('Tool delete_event', () => {
  it('schema: id, title and start are required, unknown fields are rejected', () => {
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

  it('is marked destructive, not read-only, and clearly describes what happens', () => {
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

  it('the result names the backup, folder, restore path and that iCloud cannot restore', async () => {
    const tools: Record<string, { handler: (a: unknown) => Promise<{ content: Array<{ text: string }>; structuredContent: { summary: string; notes: string[]; data: { backup: { file: string; path: string }; deleted: { title: string } } } }> }> = {};
    registerWriteTools({ registerTool: (n: string, _c: unknown, h: never) => (tools[n] = { handler: h }) } as never, svc);
    const id = store.put('priv', 'a', own());
    const res = await tools['delete_event']!.handler({ id, ...ARGS });
    const out = res.structuredContent;
    expect(out.summary).toMatch(/deleted/);
    expect(out.data.deleted.title).toBe('Old title');
    expect(out.data.backup.path).toBe(join(dir, out.data.backup.file));
    const notes = out.notes.join('\n');
    expect(notes).toContain(dir);
    expect(notes).toMatch(/Double-clicking.*Apple Calendar/s);
    expect(notes).toMatch(/iCloud itself cannot restore individual deleted events/);
    expect(notes).toMatch(/create_event/);
  });
});

describe('Deleting over the wire (real gateway against a local HTTP server)', () => {
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

  it('sends DELETE with If-Match on the ETag and credentials, exactly once', async () => {
    const c = calendar();
    await new CalDavGateway(cfg).deleteObject(grantFor(c), { url: `${base}/u/calendars/priv/a.ics`, etag: '"abc123"' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('DELETE');
    expect(seen[0]!.url).toBe('/u/calendars/priv/a.ics');
    expect(seen[0]!.headers['if-match']).toBe('"abc123"');
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /);
  });

  it('412 (event changed in the meantime) is reported with a clear message', async () => {
    status = 412;
    await expect(new CalDavGateway(cfg).deleteObject(grantFor(calendar()), { url: `${base}/u/calendars/priv/a.ics`, etag: '"old"' })).rejects.toThrow(/changed in the meantime.*Nothing was deleted/s);
  });

  it.each([
    [404, /not found/],
    [403, /refuses/],
    [500, /HTTP 500/],
  ])('Status %i', async (code, msg) => {
    status = code;
    await expect(new CalDavGateway(cfg).deleteObject(grantFor(calendar()), { url: `${base}/u/calendars/priv/a.ics`, etag: '"1"' })).rejects.toThrow(msg);
  });

  it('without ETag, with a foreign URL or without a grant nothing is sent', async () => {
    const gw = new CalDavGateway(cfg);
    const c = calendar();
    await expect(gw.deleteObject(grantFor(c), { url: `${base}/u/calendars/priv/a.ics`, etag: '' })).rejects.toThrow(/ETag/);
    await expect(gw.deleteObject(grantFor(c), { url: `${base}/u/calendars/shared/a.ics`, etag: '"1"' })).rejects.toThrow(/does not belong to this calendar/);
    await expect(gw.deleteObject(grantFor(c), { url: `${base}/u/calendars/priv/../shared/a.ics`, etag: '"1"' })).rejects.toThrow(/does not belong to this calendar/);
    await expect(gw.deleteObject(grantFor(c), { url: 'http://evil.example.com/u/calendars/priv/a.ics', etag: '"1"' })).rejects.toThrow(/does not belong to this calendar/);
    await expect(gw.deleteObject({ op: 'delete', calendar: c } as never, { url: `${base}/u/calendars/priv/a.ics`, etag: '"1"' })).rejects.toThrow(/without grant/);
    expect(seen).toEqual([]);
  });
});
