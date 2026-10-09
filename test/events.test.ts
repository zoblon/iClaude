import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { expandObject } from '../src/core/calendar/events.js';
import type { CalendarInfo } from '../src/core/calendar/types.js';

const cal: CalendarInfo = { id: '/c/1/', name: 'Termine', kind: 'events', shared: false, subscribed: false, writable: true, url: 'https://x/c/1/' };
const Z = 'Europe/Berlin';
const range = (a: string, b: string) => ({
  zone: Z,
  rangeStartMs: DateTime.fromISO(a, { zone: Z }).toMillis(),
  rangeEndMs: DateTime.fromISO(b, { zone: Z }).toMillis(),
});
const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
const obj = (body: string) => ({ url: 'https://x/c/1/abc.ics', etag: '"e1"', data: wrap(body) });

describe('expandObject', () => {
  it('liest einen Einzeltermin mit Zeitzone', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=Europe/Berlin:20261009T140000\r\nDTEND;TZID=Europe/Berlin:20261009T150000\r\nSUMMARY:Zahnarzt\r\nLOCATION:Praxis\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-11-01'),
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ title: 'Zahnarzt', location: 'Praxis', allDay: false, start: '2026-10-09T14:00:00+02:00', end: '2026-10-09T15:00:00+02:00', recurring: false });
  });

  it('liest UTC-Zeiten und rechnet in die Nutzer-Zeitzone um', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:u\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nSUMMARY:UTC\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]?.start).toBe('2026-10-09T14:00:00+02:00');
  });

  it('behandelt schwebende Zeiten als Ortszeit des Nutzers', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:f\r\nDTSTART:20261009T090000\r\nDTEND:20261009T100000\r\nSUMMARY:Schwebend\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]?.start).toBe('2026-10-09T09:00:00+02:00');
  });

  it('gibt ganztägige Termine mit letztem Tag aus (Ende exklusiv in iCal)', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:d\r\nDTSTART;VALUE=DATE:20261010\r\nDTEND;VALUE=DATE:20261012\r\nSUMMARY:Ausflug\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]).toMatchObject({ allDay: true, start: '2026-10-10', end: '2026-10-11' });
  });

  it('ganztägig ohne DTEND dauert einen Tag', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:d2\r\nDTSTART;VALUE=DATE:20261010\r\nSUMMARY:Feiertag\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]).toMatchObject({ allDay: true, start: '2026-10-10', end: '2026-10-10' });
  });

  it('expandiert wöchentliche Wiederholung über den Sommerzeitwechsel hinweg (Ortszeit bleibt 10:00)', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=Europe/Berlin:20261016T100000\r\nDTEND;TZID=Europe/Berlin:20261016T110000\r\nRRULE:FREQ=WEEKLY;COUNT=5\r\nSUMMARY:Jour fixe\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-12-31'),
    );
    expect(r.events.map((e) => e.start)).toEqual([
      '2026-10-16T10:00:00+02:00',
      '2026-10-23T10:00:00+02:00',
      '2026-10-30T10:00:00+01:00', // Sommerzeit endet am 25.10.2026
      '2026-11-06T10:00:00+01:00',
      '2026-11-13T10:00:00+01:00',
    ]);
    expect(r.events.every((e) => e.recurring)).toBe(true);
  });

  it('liefert nur Vorkommen im Zeitraum', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:w\r\nDTSTART;TZID=Europe/Berlin:20260105T100000\r\nDTEND;TZID=Europe/Berlin:20260105T110000\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Immer montags\r\nEND:VEVENT'),
      cal,
      range('2026-10-12', '2026-10-26'),
    );
    expect(r.events.map((e) => e.start.slice(0, 10))).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('beachtet EXDATE und verschobene Einzeltermine (RECURRENCE-ID)', () => {
    const body = [
      'BEGIN:VEVENT\r\nUID:s\r\nDTSTART;TZID=Europe/Berlin:20261005T100000\r\nDTEND;TZID=Europe/Berlin:20261005T110000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Europe/Berlin:20261012T100000\r\nSUMMARY:Serie\r\nEND:VEVENT',
      'BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261019T100000\r\nDTSTART;TZID=Europe/Berlin:20261020T160000\r\nDTEND;TZID=Europe/Berlin:20261020T170000\r\nSUMMARY:Serie (verschoben)\r\nEND:VEVENT',
    ].join('\r\n');
    const r = expandObject(obj(body), cal, range('2026-10-01', '2026-11-30'));
    expect(r.events.map((e) => `${e.start} ${e.title}`)).toEqual([
      '2026-10-05T10:00:00+02:00 Serie',
      '2026-10-20T16:00:00+02:00 Serie (verschoben)',
      '2026-10-26T10:00:00+01:00 Serie',
    ]);
  });

  it('überspringt abgesagte Termine', () => {
    const r = expandObject(obj('BEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Abgesagt\r\nEND:VEVENT'), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events).toHaveLength(0);
  });

  it('erkennt Teilnehmer, Organisator und "frei"', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:p\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nORGANIZER:mailto:chef@example.com\r\nATTENDEE:mailto:ich@example.com\r\nTRANSP:TRANSPARENT\r\nSUMMARY:Meeting\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-11-01'),
    );
    expect(r.events[0]).toMatchObject({ hasAttendees: true, organizer: 'chef@example.com', free: true });
  });

  it('findet Termine einer täglichen Serie, die vor 26 Jahren begann', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:e\r\nDTSTART;TZID=Europe/Berlin:20000101T100000\r\nDTEND;TZID=Europe/Berlin:20000101T110000\r\nRRULE:FREQ=DAILY\r\nSUMMARY:Täglich\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-10-03'),
    );
    expect(r.truncated).toBe(false);
    expect(r.events.map((e) => e.start.slice(0, 10))).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('begrenzt extreme Serien und meldet es', () => {
    const r = expandObject(
      obj('BEGIN:VEVENT\r\nUID:e\r\nDTSTART;TZID=Europe/Berlin:20000101T100000\r\nDTEND;TZID=Europe/Berlin:20000101T100100\r\nRRULE:FREQ=MINUTELY\r\nSUMMARY:Minütlich\r\nEND:VEVENT'),
      cal,
      range('2026-10-01', '2026-10-03'),
    );
    expect(r.truncated).toBe(true);
  });

  it('kürzt sehr lange Notizen', () => {
    const long = 'x'.repeat(5000);
    const r = expandObject(obj(`BEGIN:VEVENT\r\nUID:l\r\nDTSTART:20261009T120000Z\r\nDTEND:20261009T130000Z\r\nDESCRIPTION:${long}\r\nSUMMARY:Lang\r\nEND:VEVENT`), cal, range('2026-10-01', '2026-11-01'));
    expect(r.events[0]!.notes.length).toBeLessThan(2200);
    expect(r.events[0]!.notes).toContain('gekürzt');
  });
});
