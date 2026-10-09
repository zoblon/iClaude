import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { expandObject } from '../src/core/calendar/events.js';
import type { CalendarInfo } from '../src/core/calendar/types.js';

const cal: CalendarInfo = { id: '/c/1/', name: 'Events', kind: 'events', shared: false, subscribed: false, writable: true, url: 'https://x/c/1/' };
const Z = 'Europe/Berlin';
const range = (a: string, b: string) => ({
  zone: Z,
  rangeStartMs: DateTime.fromISO(a, { zone: Z }).toMillis(),
  rangeEndMs: DateTime.fromISO(b, { zone: Z }).toMillis(),
});
const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
const obj = (body: string) => ({ url: 'https://x/c/1/abc.ics', etag: '"e1"', data: wrap(body) });

describe('expandObject', () => {
  it('reads a single event with time zone', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Europe/Berlin:20261009T140000\r\nDTEND;TZID=Europe/Berlin:20261009T150000\r\nSUMMARY:Dentist\r\nLOCATION:Office\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-11-01'),
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ title: 'Dentist', location: 'Office', allDay: false, start: '2026-10-09T14:00:00+02:00', end: '2026-10-09T15:00:00+02:00', recurring: false });
  });

  it('reads UTC times and converts them to the user time zone', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:u\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nSUMMARY:UTC\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]?.start).toBe('2026-10-09T14:00:00+02:00');
  });

  it('treats floating times as the user local time', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:f\r\nDTSTART:20261009T090000\r\nDTEND:20261009T100000\r\nSUMMARY:Floating\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]?.start).toBe('2026-10-09T09:00:00+02:00');
  });

  it('outputs all-day events with their last day (end is exclusive in iCal)', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261012\r\nSUMMARY:Trip\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]).toMatchObject({ allDay: true, start: '2026-10-10', end: '2026-10-11' });
  });

  it('all-day without DTEND lasts one day', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:d2\r\nDTSTART;VALUE=DATE:20261010\r\nSUMMARY:Holiday\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]).toMatchObject({ allDay: true, start: '2026-10-10', end: '2026-10-10' });
  });

  it('expands a weekly recurrence across the DST change (local time stays 10:00)', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=Europe/Berlin:20261016T100000\r\nDTEND;TZID=Europe/Berlin:20261016T110000\r\nRRULE:FREQ=WEEKLY;COUNT=5\r\nSUMMARY:Weekly sync\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-12-31'),
    );
    expect(r.events.map((e) => e.start)).toEqual([
      '2026-10-16T10:00:00+02:00',
      '2026-10-23T10:00:00+02:00',
      '2026-10-30T10:00:00+01:00', // DST ends on 2026-10-25
      '2026-11-06T10:00:00+01:00',
      '2026-11-13T10:00:00+01:00',
    ]);
    expect(r.events.every((e) => e.recurring)).toBe(true);
  });

  it('returns only occurrences within the range', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=Europe/Berlin:20260105T100000\r\nDTEND;TZID=Europe/Berlin:20260105T110000\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Every Monday\r\nEND:VEVENT'),
      cal,
      range('2026-10-12', '2026-10-26'),
    );
    expect(r.events.map((e) => e.start.slice(0, 10))).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('respects EXDATE and moved occurrences (RECURRENCE-ID)', () => {
    const body = [
      'BEGIN:VEVENT\r\nUID:s\r\nDTSTART;TZID=Europe/Berlin:20261005T100000\r\nDTEND;TZID=Europe/Berlin:20261005T110000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Europe/Berlin:20261012T100000\r\nSUMMARY:Series\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261019T100000\r\nDTSTART;TZID=Europe/Berlin:20261020T160000\r\nDTEND;TZID=Europe/Berlin:20261020T170000\r\nSUMMARY:Series (moved)\r\nEND:VEVENT',
    ].join('\r\n');
    const r = expandObject(obj(body), cal, range('2026-10-01', '2026-11-30'));
    expect(r.events.map((e) => `${e.start} ${e.title}`)).toEqual([
      '2026-10-05T10:00:00+02:00 Series',
      '2026-10-20T16:00:00+02:00 Series (moved)',
      '2026-10-26T10:00:00+01:00 Series',
    ]);
  });

  it('skips cancelled events', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events).toHaveLength(0);
  });

  it('detects attendees, organizer and "free"', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:p\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nORGANIZER:mailto:boss@example.com\r\nATTENDEE:mailto:me@example.com\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Meeting\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-11-01'),
    );
    expect(r.events[0]).toMatchObject({ hasAttendees: true, organizer: 'boss@example.com', free: true });
  });

  it('finds occurrences of a daily series that started 26 years ago', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:e\r\nDTSTART;TZID=Europe/Berlin:20000101T100000\r\nDTEND;TZID=Europe/Berlin:20000101T110000\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Daily\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-10-03'),
    );
    expect(r.truncated).toBe(false);
    expect(r.events.map((e) => e.start.slice(0, 10))).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('limits extreme series and reports it', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:e\r\nDTSTART;TZID=Europe/Berlin:20000101T100000\r\nDTEND;TZID=Europe/Berlin:20000101T100100\r\nRRULE:FREQ=MINUTELY\r\nSUMMARY:Every minute\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-10-03'),
    );
    expect(r.truncated).toBe(true);
  });

  it('truncates very long notes', () => {
    const long = 'x'.repeat(5000);
    const r = expandObject(obj(`BEGIN:VEVENT\r\nUID:l\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nDESCRIPTION:${long}\r\nSUMMARY:Long\r\nEND:VEVENT`), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]!.notes.length).toBeLessThan(2200);
    expect(r.events[0]!.notes).toContain('truncated');
  });
});
