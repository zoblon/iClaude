import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { beforeEach, describe, expect, it } from 'vitest';
import { expandObject } from '../src/core/calendar/events.js';
import { locateOccurrence } from '../src/core/calendar/ics.js';
import { CalendarWriteService } from '../src/core/calendar/writeService.js';
import { calendars, cfg, ev, FakeStore } from './fakeStore.js';

const Z = 'Europe/Berlin';
let store: FakeStore;
let svc: CalendarWriteService;
beforeEach(() => {
  store = new FakeStore();
  svc = new CalendarWriteService(cfg, store);
});

const wrap = (body: string, tz = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${tz}${body}\r\nEND:VCALENDAR\r\n`;
const timed = (extra = '', uid = 'S') =>
  wrap(`BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T100000Z\r\nSEQUENCE:3\r\nDTSTART;TZID=Europe/Berlin:20261021T100000\r\nDTEND;TZID=Europe/Berlin:20261021T113000\r\nSUMMARY:Weekly\r\nLOCATION:Room 1\r\nX-KEEP:me\r\nRRULE:FREQ=WEEKLY;COUNT=6\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:a\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n${extra}END:VEVENT`);
const allDay = () => wrap('BEGIN:VEVENT\r\nUID:D\r\nDTSTAMP:20261001T100000Z\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nSUMMARY:Birthday\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEND:VEVENT');
const utc = () => wrap('BEGIN:VEVENT\r\nUID:U\r\nDTSTAMP:20261001T100000Z\r\nDTSTART:20261021T080000Z\r\nDTEND:20261021T090000Z\r\nSUMMARY:UTC series\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEND:VEVENT');

const put = (data: string, name = 'a') => store.put('priv', name, data);
const stored = (name = 'a') => store.objects.get(`https://p1.example.com/u/calendars/priv/${name}.ics`)!;
const events = (name = 'a') => ICAL.Component.fromString(stored(name).data).getAllSubcomponents('vevent');
const range = (a: string, b: string) => ({ zone: Z, rangeStartMs: DateTime.fromISO(a, { zone: Z }).toMillis(), rangeEndMs: DateTime.fromISO(b, { zone: Z }).toMillis() });
const list = (name = 'a', a = '2026-10-01', b = '2026-12-31') => expandObject(stored(name), calendars[0]!, range(a, b)).events;

describe('changing one occurrence of a series', () => {
  it('writes an override with RECURRENCE-ID in the same resource; the master and other data stay untouched', async () => {
    const id = put(timed());
    const masterBefore = JSON.stringify(events()[0]!.toJSON());
    const r = await svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'Moved talk', start: '2026-10-29T15:00:00', location: 'Room 9', notes: 'Bring slides', alertsMinutes: [30] });
    expect(r.changed).toEqual(expect.arrayContaining(['title', 'time', 'location', 'notes', 'alerts', 'occurrence']));
    expect(r.event).toMatchObject({ title: 'Moved talk', start: '2026-10-29T15:00:00+01:00', end: '2026-10-29T16:30:00+01:00', location: 'Room 9', notes: 'Bring slides', recurring: true, occurrenceStart: '2026-10-28T10:00:00+01:00' });

    const [master, ov, ...rest] = events();
    expect(rest).toEqual([]);
    expect(JSON.stringify(master!.toJSON())).toBe(masterBefore); // master unchanged, SEQUENCE included
    expect(ov!.getFirstPropertyValue('uid')).toBe('S');
    expect(stored().data).toMatch(/RECURRENCE-ID;TZID=Europe\/Berlin:20261028T100000/);
    expect(ov!.getFirstPropertyValue('sequence')).toBe(4); // master SEQUENCE:3 + 1
    expect(String(ov!.getFirstPropertyValue('last-modified'))).toMatch(/^20\d{2}-/);
    expect(ov!.hasProperty('rrule')).toBe(false);
    expect(ov!.getFirstPropertyValue('x-keep')).toBe('me');
    expect(ov!.getAllSubcomponents('valarm')).toHaveLength(1);
    expect(ov!.hasProperty('attendee')).toBe(false);
    expect(stored().data).not.toMatch(/ATTENDEE|ORGANIZER|METHOD/);
  });

  it('list_events shows the moved occurrence once at its new time and not at the old one', async () => {
    const id = put(timed());
    await svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', start: '2026-10-29T15:00:00' });
    const all = list();
    expect(all).toHaveLength(6);
    expect(all.map((e) => e.start)).toContain('2026-10-29T15:00:00+01:00');
    expect(all.map((e) => e.start)).not.toContain('2026-10-28T10:00:00+01:00');
    expect(new Set(all.map((e) => e.start)).size).toBe(6);
    // other occurrences are unchanged, also across the DST change on 25 October
    expect(all.map((e) => e.start).filter((s) => !s.includes('15:00'))).toEqual([
      '2026-10-21T10:00:00+02:00', '2026-11-04T10:00:00+01:00', '2026-11-11T10:00:00+01:00', '2026-11-18T10:00:00+01:00', '2026-11-25T10:00:00+01:00',
    ]);
    // asking for exactly the new day finds it, asking for the old day does not
    expect(list('a', '2026-10-28', '2026-10-29')).toHaveLength(0);
    expect(list('a', '2026-10-29', '2026-10-30')).toHaveLength(1);
  });

  it('updates an existing override for that occurrence (by its original start or by its current start) instead of adding another', async () => {
    const id = put(timed());
    await svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', start: '2026-10-29T15:00:00' });
    const seq1 = events()[1]!.getFirstPropertyValue('sequence');
    await svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'Renamed' }); // original start
    await svc.updateEvent({ id, occurrenceStart: '2026-10-29T15:00:00+01:00', location: 'Cafe' }); // current start
    expect(events()).toHaveLength(2);
    const ov = events()[1]!;
    expect(ov.getFirstPropertyValue('summary')).toBe('Renamed');
    expect(ov.getFirstPropertyValue('location')).toBe('Cafe');
    expect(ov.getFirstPropertyValue('sequence')).toBe(Number(seq1) + 2);
    expect(list().find((e) => e.title === 'Renamed')).toMatchObject({ start: '2026-10-29T15:00:00+01:00', location: 'Cafe' });
  });

  it('keeps other overrides exactly as they are', async () => {
    const id = put(timed());
    await svc.updateEvent({ id, occurrenceStart: '2026-11-04T10:00:00+01:00', title: 'Second override' });
    const before = JSON.stringify(events()[1]!.toJSON());
    await svc.updateEvent({ id, occurrenceStart: '2026-11-11T10:00:00+01:00', title: 'Third override' });
    expect(events()).toHaveLength(3);
    expect(JSON.stringify(events()[1]!.toJSON())).toBe(before);
  });

  it('changes only the duration with end, and keeps the duration when only start is given', async () => {
    const id = put(timed());
    const a = await svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', end: '2026-10-28T12:00:00' });
    expect(a.event).toMatchObject({ start: '2026-10-28T10:00:00+01:00', end: '2026-10-28T12:00:00+01:00' });
    const b = await svc.updateEvent({ id, occurrenceStart: '2026-11-04T10:00:00+01:00', start: '2026-11-04T09:00:00' });
    expect(b.event).toMatchObject({ start: '2026-11-04T09:00:00+01:00', end: '2026-11-04T10:30:00+01:00' });
  });

  it('works for the occurrence right at the daylight saving change (25 October 2026) and keeps wall-clock times', async () => {
    const id = put(timed());
    const r = await svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', start: '2026-10-25T02:30:00' });
    expect(r.event.start).toBe('2026-10-25T02:30:00+02:00');
    // before the change: +02:00, after: +01:00, the untouched occurrences stay at 10:00 local time
    const starts = list().map((e) => e.start);
    expect(starts).toContain('2026-10-21T10:00:00+02:00');
    expect(starts).toContain('2026-11-04T10:00:00+01:00');
  });

  it('all-day series: changes one day, moves it to another day, keeps the others', async () => {
    store.put('priv', 'd', allDay());
    const id = '/u/calendars/priv/d.ics';
    const r = await svc.updateEvent({ id, occurrenceStart: '2026-11-03', title: 'Special day', start: '2026-11-10' });
    expect(r.event).toMatchObject({ title: 'Special day', allDay: true, start: '2026-11-10', end: '2026-11-10', occurrenceStart: '2026-11-03T00:00:00+01:00' });
    const all = list('d', '2026-10-30', '2026-11-20');
    expect(all.map((e) => e.start).sort()).toEqual(['2026-11-01', '2026-11-02', '2026-11-04', '2026-11-05', '2026-11-10']);
    expect(stored('d').data).toMatch(/RECURRENCE-ID;VALUE=DATE:20261103/);
    // all-day <-> timed is not possible for a single occurrence
    await expect(svc.updateEvent({ id, occurrenceStart: '2026-11-02', allDay: false, start: '2026-11-02T10:00:00' })).rejects.toThrow(/all-day and timed/);
  });

  it('UTC series stay in UTC', async () => {
    store.put('priv', 'u', utc());
    const r = await svc.updateEvent({ id: '/u/calendars/priv/u.ics', occurrenceStart: '2026-10-22T10:00:00+02:00', start: '2026-10-22T14:00:00' });
    expect(r.event.start).toBe('2026-10-22T14:00:00+02:00');
    expect(stored('u').data).toMatch(/RECURRENCE-ID:20261022T080000Z/);
    expect(stored('u').data).toMatch(/DTSTART:20261022T120000Z/);
  });

  it('refuses occurrences the rule does not have, deleted ones, and invalid input; changes nothing', async () => {
    const id = put(timed('EXDATE;TZID=Europe/Berlin:20261104T100000\r\n'));
    for (const bad of ['2026-10-22T10:00:00+02:00', '2026-12-30T10:00:00+01:00', '2026-11-04T10:00:00+01:00', '2026-10-28T11:00:00+01:00', '2026-10-28']) {
      await expect(svc.updateEvent({ id, occurrenceStart: bad, title: 'x' }), bad).rejects.toThrow(/no occurrence/);
    }
    await expect(svc.updateEvent({ id, occurrenceStart: 'tomorrow', title: 'x' })).rejects.toThrow(/invalid/);
    expect(store.updates).toBe(0);
  });

  it('keeps the old rules: attendees, foreign organizer, shared calendars without shared_calendar, stale ETag', async () => {
    const withAtt = put(timed('ATTENDEE;CN=X:mailto:x@example.com\r\nORGANIZER:mailto:me@example.com\r\n'), 'att');
    await expect(svc.updateEvent({ id: withAtt, occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'x' })).rejects.toThrow(/attendees/);
    const foreign = put(timed('ORGANIZER:mailto:boss@company.example\r\n'), 'foreign');
    await expect(svc.updateEvent({ id: foreign, occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'x' })).rejects.toThrow(/organized by another person/);
    const shared = store.put('shared', 's', timed());
    await expect(svc.updateEvent({ id: shared, occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'x' })).rejects.toThrow(/shared_calendar="Shared"/);
    await expect(svc.updateEvent({ id: shared, occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'x', sharedCalendar: 'Shared' })).resolves.toBeTruthy();
    const id = put(timed());
    await expect(svc.updateEvent({ id, etag: '"old"', occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'x' })).rejects.toThrow(/changed since it was fetched/);
    expect(store.updates).toBe(1); // only the shared one with the explicit name
  });

  it('series with exceptions can have more exceptions (whole-series time changes are still refused)', async () => {
    const id = put(timed('EXDATE;TZID=Europe/Berlin:20261104T100000\r\n'));
    await expect(svc.updateEvent({ id, start: '2026-10-22T09:00:00' })).rejects.toThrow(/exceptions/);
    await expect(svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', start: '2026-10-28T11:00:00' })).resolves.toBeTruthy();
  });

  it('locateOccurrence accepts the occurrence by its original start in another offset notation', () => {
    const loc = locateOccurrence(timed(), '2026-10-28T09:00:00Z', Z);
    expect(loc.key).toBe('2026-10-28T10:00:00+01:00');
  });

  it('the permissions still refuse deleting single occurrences', async () => {
    const { authorizeDelete } = await import('../src/core/permissions.js');
    expect(() =>
      authorizeDelete({ calendar: calendars[0]!, facts: { hasMaster: true, hasAttendees: false, recurring: true, hasExceptions: false }, selfAddresses: [], occurrenceStart: '2026-10-28T10:00:00+01:00' }),
    ).toThrow(/Single occurrences/);
    // and the occurrence update is not a back door for deletion: no EXDATE, no CANCELLED is ever written
    const id = put(timed());
    await svc.updateEvent({ id, occurrenceStart: '2026-10-28T10:00:00+01:00', title: 'Still there' });
    expect(stored().data).not.toMatch(/EXDATE|STATUS:CANCELLED/);
    expect(ev('x')).toBeTruthy();
  });
});
