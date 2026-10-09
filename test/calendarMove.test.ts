import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupStore } from '../src/core/calendar/backup.js';
import { CalendarWriteService } from '../src/core/calendar/writeService.js';
import { UserError } from '../src/core/errors.js';
import { authorizeEventMove } from '../src/core/permissions.js';
import { updateEventSchema } from '../src/mcp/writeTools.js';
import { calendars, cfg, ev, FakeStore } from './fakeStore.js';

let store: FakeStore;
let svc: CalendarWriteService;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icloud-mcp-move-'));
  store = new FakeStore();
  svc = new CalendarWriteService(cfg, store, new BackupStore({ dir: join(root, 'deleted'), zone: cfg.timezone }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ID = 'ABCDEFGH-1234-5678';
const SRC = `/u/calendars/priv/${ID}.ics`;
const has = (slug: string, name = ID) => store.objects.has(`https://p1.example.com/u/calendars/${slug}/${name}.ics`);
const backups = () => (existsSync(join(root, 'deleted')) ? readdirSync(join(root, 'deleted')) : []);
const series = () => ev(ID, 'RRULE:FREQ=WEEKLY;COUNT=5\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:a\r\nTRIGGER:-PT15M\r\nEND:VALARM');

describe('moving an event to another calendar', () => {
  it('creates the copy in the target, reads it back, and only then deletes the source with If-Match', async () => {
    store.put('priv', ID, ev(ID));
    const before = store.objects.get(`https://p1.example.com/u/calendars/priv/${ID}.ics`)!;
    const r = await svc.updateEvent({ id: SRC, moveToCalendar: 'Events' });
    expect(store.calls).toEqual([`create:events/${ID}.ics`, `delete:priv/${ID}.ics`]);
    expect(store.lastDelete).toEqual({ url: before.url, etag: before.etag });
    expect(has('events')).toBe(true);
    expect(has('priv')).toBe(false);
    expect(r).toMatchObject({ calendar: 'Events', shared: false, changed: ['calendar'] });
    expect(r.moved).toMatchObject({ from: 'MCP-Test', to: 'Events', oldId: SRC, uidChanged: false });
    expect(r.event.id).toBe(`/u/calendars/events/${ID}.ics`);
    expect(r.event.title).toBe('Old title');
    // the target holds the complete original, including unknown properties
    expect(store.objects.get(`https://p1.example.com/u/calendars/events/${ID}.ics`)!.data).toBe(before.data);
    // backup of the source, like delete_event
    expect(backups()).toHaveLength(1);
    expect(readFileSync(r.moved!.backup.path, 'utf8')).toBe(before.data);
  });

  it('moves a whole series with its alarms and exceptions', async () => {
    store.put('priv', ID, ev(ID, 'RRULE:FREQ=WEEKLY;COUNT=5\r\nEXDATE;TZID=Europe/Berlin:20261028T100000'));
    const r = await svc.updateEvent({ id: SRC, moveToCalendar: 'events' });
    expect(r.event.recurring).toBe(true);
    expect(has('events')).toBe(true);
    expect(has('priv')).toBe(false);
  });

  it('uses a new UID (and file) when the target calendar refuses the old UID, and says so', async () => {
    store.rejectSameUid = true;
    store.put('priv', ID, series());
    const r = await svc.updateEvent({ id: SRC, moveToCalendar: 'Events' });
    expect(r.moved!.uidChanged).toBe(true);
    const created = [...store.objects.entries()].filter(([u]) => u.includes('/events/'));
    expect(created).toHaveLength(1);
    expect(created[0]![1].data).not.toContain(`UID:${ID}`);
    expect(created[0]![1].data).toMatch(/^UID:[0-9A-F-]{36}$/m);
    expect(has('priv')).toBe(false);
    expect(store.calls.filter((c) => c.startsWith('delete'))).toEqual([`delete:priv/${ID}.ics`]);
  });

  it('a new UID keeps the series and its overrides together', async () => {
    store.rejectSameUid = true;
    const withOverride = ev(ID, 'RRULE:FREQ=WEEKLY;COUNT=3').replace('END:VCALENDAR', '') + '';
    store.put('priv', ID, `${withOverride.replace(/\r\n$/, '')}\r\nBEGIN:VEVENT\r\nUID:${ID}\r\nDTSTAMP:20261001T100000Z\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261028T100000\r\nDTSTART;TZID=Europe/Berlin:20261029T150000\r\nDTEND;TZID=Europe/Berlin:20261029T163000\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
    await svc.updateEvent({ id: SRC, moveToCalendar: 'Events' });
    const data = [...store.objects.entries()].find(([u]) => u.includes('/events/'))![1].data;
    expect([...data.matchAll(/^UID:(.*)$/gm)].map((m) => m[1])).toHaveLength(2);
    expect(new Set([...data.matchAll(/^UID:(.*)$/gm)].map((m) => m[1])).size).toBe(1);
  });

  it('if the delete fails, both places are reported and nothing else happens', async () => {
    store.put('priv', ID, ev(ID));
    store.deleteError = new UserError('iCloud rejected the deletion (HTTP 500).');
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Events' })).rejects.toThrow(/copied to "Events" but could not be removed from "MCP-Test".*exists in both calendars.*Nothing else was done/s);
    expect(has('priv')).toBe(true);
    expect(has('events')).toBe(true);
    expect(store.calls).toEqual([`create:events/${ID}.ics`, `delete:priv/${ID}.ics`]); // no retry, no second delete
    expect(backups()).toHaveLength(1); // kept
  });

  it('does not delete when the copy read back differs from the original', async () => {
    store.put('priv', ID, ev(ID));
    store.onCreate = (d) => d.replace('SUMMARY:Old title', 'SUMMARY:Mangled');
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Events' })).rejects.toThrow(/does not match the original \(title\).*NOT deleted/s);
    expect(store.calls.filter((c) => c.startsWith('delete'))).toEqual([]);
    expect(has('priv')).toBe(true);
  });

  it('does nothing when the backup cannot be written', async () => {
    store.put('priv', ID, ev(ID));
    const blocked = join(root, 'blocked');
    (await import('node:fs')).writeFileSync(blocked, 'x');
    const s = new CalendarWriteService(cfg, store, new BackupStore({ dir: join(blocked, 'sub'), zone: cfg.timezone }));
    await expect(s.updateEvent({ id: SRC, moveToCalendar: 'Events' })).rejects.toThrow(/backup/);
    expect(store.calls).toEqual([]);
  });

  it('removes the backup and changes nothing when the target refuses for other reasons', async () => {
    store.put('priv', ID, ev(ID));
    store.createObject = async () => {
      throw new UserError('iCloud refuses write access to this calendar.', 401);
    };
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Events' })).rejects.toThrow(/refuses write access/);
    expect(has('priv')).toBe(true);
    expect(backups()).toEqual([]);
  });

  it('refuses attendees, a foreign organizer, a shared source, shared targets without the name, the same calendar and other targets', async () => {
    store.put('priv', 'att', ev('att', 'ATTENDEE;CN=X:mailto:x@example.com\r\nORGANIZER:mailto:me@example.com'));
    await expect(svc.updateEvent({ id: '/u/calendars/priv/att.ics', moveToCalendar: 'Events' })).rejects.toThrow(/attendees/);
    store.put('priv', 'foreign', ev('foreign', 'ORGANIZER:mailto:boss@company.example'));
    await expect(svc.updateEvent({ id: '/u/calendars/priv/foreign.ics', moveToCalendar: 'Events' })).rejects.toThrow(/organized by another person/);
    store.put('shared', 'sh', ev('sh'));
    await expect(svc.updateEvent({ id: '/u/calendars/shared/sh.ics', moveToCalendar: 'Events', sharedCalendar: 'Shared' })).rejects.toThrow(/never moved out of shared calendars/);
    store.put('priv', ID, ev(ID));
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Shared' })).rejects.toThrow(/shared calendar.*shared_calendar="Shared"/s);
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Events', sharedCalendar: 'Shared' })).rejects.toThrow(/not a shared calendar/);
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'MCP-Test' })).rejects.toThrow(/already in this calendar/);
    for (const name of ['Holidays', 'Read only', 'Family', 'Nope']) await expect(svc.updateEvent({ id: SRC, moveToCalendar: name }), name).rejects.toThrow();
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Events', occurrenceStart: '2026-10-28T10:00:00+01:00' })).rejects.toThrow(/Single occurrences/);
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Events', title: 'x' })).rejects.toThrow(/step of its own/);
    await expect(svc.updateEvent({ id: SRC, moveToCalendar: 'Events', etag: '"old"' })).rejects.toThrow(/changed since it was fetched/);
    expect(store.calls).toEqual([]);
    expect(has('priv')).toBe(true);
  });

  it('moves into a shared calendar only with its exact name in shared_calendar', async () => {
    store.put('priv', ID, ev(ID));
    const r = await svc.updateEvent({ id: SRC, moveToCalendar: 'Shared', sharedCalendar: 'shared' });
    expect(r).toMatchObject({ calendar: 'Shared', shared: true });
    expect(has('shared')).toBe(true);
    expect(has('priv')).toBe(false);
  });

  it('authorizeEventMove issues exactly a create grant for the target and a delete grant for the source', () => {
    const g = authorizeEventMove({
      calendars,
      source: calendars[0]!,
      facts: { hasMaster: true, hasAttendees: false, recurring: false, hasExceptions: false },
      selfAddresses: [cfg.appleId],
      target: 'Events',
    });
    expect([g.create.op, g.create.calendar.name, g.delete.op, g.delete.calendar.name]).toEqual(['create', 'Events', 'delete', 'MCP-Test']);
  });

  it('the schema takes move_to_calendar but still no attendees', () => {
    expect(updateEventSchema.safeParse({ id: '/u/calendars/priv/a.ics', move_to_calendar: 'Events' }).success).toBe(true);
    expect(updateEventSchema.safeParse({ id: '/u/calendars/priv/a.ics', move_to_calendar: 'Events', attendees: ['a@b.de'] }).success).toBe(false);
  });
});
