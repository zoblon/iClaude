import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { analyzeEvent, applyPatch, assertSafeOutput, buildEventIcs, currentTimes, vtimezoneFor } from '../src/core/calendar/ics.js';
import { expandObject } from '../src/core/calendar/events.js';
import type { CalendarInfo } from '../src/core/calendar/types.js';

const Z = 'Europe/Berlin';
const dt = (s: string) => DateTime.fromISO(s, { zone: Z });
const cal: CalendarInfo = { id: '/c/1/', name: 'MCP-Test', kind: 'events', shared: false, subscribed: false, writable: true, url: 'https://x/c/1/' };
const expand = (ics: string, a: string, b: string) =>
  expandObject({ url: 'https://x/c/1/e.ics', data: ics }, cal, { zone: Z, rangeStartMs: dt(a).toMillis(), rangeEndMs: dt(b).toMillis() }).events;

describe('buildEventIcs', () => {
  it('erzeugt einen Termin mit Zeitzone, Ort, Notiz und Erinnerungen, der sich wieder korrekt lesen lässt', () => {
    const { ics, uid } = buildEventIcs({
      title: 'Zahnarzt', start: dt('2026-10-20T14:00'), end: dt('2026-10-20T15:00'), allDay: false, zone: Z,
      location: 'Praxis; Hauptstr. 1, Berlin', notes: 'Zeile 1\nZeile 2', alertsMinutes: [15, 60],
    });
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toMatch(/DTSTART;TZID=Europe\/Berlin:20261020T140000/);
    expect(ics).not.toContain('ATTENDEE');
    expect(ics).not.toContain('ORGANIZER');
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
    const [e] = expand(ics, '2026-10-01', '2026-11-01');
    expect(e).toMatchObject({ uid, title: 'Zahnarzt', location: 'Praxis; Hauptstr. 1, Berlin', notes: 'Zeile 1\nZeile 2', start: '2026-10-20T14:00:00+02:00', end: '2026-10-20T15:00:00+02:00' });
  });

  it('erzeugt ganztägige Termine mit exklusivem Ende', () => {
    const { ics } = buildEventIcs({ title: 'Urlaub', start: dt('2026-10-20'), end: dt('2026-10-22'), allDay: true, zone: Z });
    expect(ics).toContain('DTSTART;VALUE=DATE:20261020');
    expect(ics).toContain('DTEND;VALUE=DATE:20261023');
    expect(expand(ics, '2026-10-01', '2026-11-01')[0]).toMatchObject({ allDay: true, start: '2026-10-20', end: '2026-10-22' });
  });

  it('erzeugt Wiederholungen', () => {
    const { ics } = buildEventIcs({
      title: 'Jour fixe', start: dt('2026-10-26T10:00'), end: dt('2026-10-26T11:00'), allDay: false, zone: Z,
      recurrence: { frequency: 'WEEKLY', count: 3, weekdays: ['MO', 'WE'] },
    });
    expect(ics).toMatch(/RRULE:.*FREQ=WEEKLY/);
    expect(expand(ics, '2026-10-01', '2026-12-01').map((e) => e.start.slice(0, 10))).toEqual(['2026-10-26', '2026-10-28', '2026-11-02']);
  });

  it('kann Teilnehmer nicht über Textfelder einschleusen (Zeilenumbruch-Injektion)', () => {
    const evil = 'Hallo\r\nATTENDEE;CN=Opfer:mailto:opfer@example.com\r\nORGANIZER:mailto:ich@example.com';
    const { ics } = buildEventIcs({ title: evil, start: dt('2026-10-20T14:00'), end: dt('2026-10-20T15:00'), allDay: false, zone: Z, location: evil, notes: evil });
    const vevent = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent')!;
    expect(vevent.getAllProperties('attendee')).toHaveLength(0);
    expect(vevent.getAllProperties('organizer')).toHaveLength(0);
    expect(() => assertSafeOutput(ics, { attendees: 0 })).not.toThrow();
  });

  it('lehnt widersprüchliche oder falsche Wiederholungen ab', () => {
    const base = { title: 'x', start: dt('2026-10-20T14:00'), end: dt('2026-10-20T15:00'), allDay: false, zone: Z };
    expect(() => buildEventIcs({ ...base, recurrence: { frequency: 'DAILY', count: 3, until: '2026-12-01' } })).toThrow(/count oder until/);
    expect(() => buildEventIcs({ ...base, recurrence: { frequency: 'DAILY', weekdays: ['MO'] } })).toThrow(/WEEKLY/);
    expect(() => buildEventIcs({ ...base, recurrence: { frequency: 'DAILY', until: '2020-01-01' } })).toThrow(/vor dem Beginn/);
  });
});

describe('assertSafeOutput', () => {
  const withAttendee = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261009T120000Z\r\nSUMMARY:x\r\nATTENDEE:mailto:a@b.de\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  it('lehnt Teilnehmer und METHOD ab', () => {
    expect(() => assertSafeOutput(withAttendee, { attendees: 0 })).toThrow(/Teilnehmer/);
    expect(() => assertSafeOutput(withAttendee.replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:REQUEST'), { attendees: -1 })).toThrow(/METHOD/);
  });
});

const existing = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iCloud//EN', 'X-WR-CALNAME:Testkalender',
  'BEGIN:VEVENT', 'UID:EXIST-1', 'DTSTAMP:20261001T100000Z', 'SEQUENCE:2',
  'DTSTART;TZID=Europe/Berlin:20261021T100000', 'DTEND;TZID=Europe/Berlin:20261021T113000',
  'SUMMARY:Alter Titel', 'LOCATION:Alter Ort', 'DESCRIPTION:Alte Notiz',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC', 'X-MEINE-ERWEITERUNG;X-PARAM=1:wichtig', 'URL:https://example.com/x',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Erinnerung', 'TRIGGER:-PT30M', 'X-APPLE-DEFAULT-ALARM:TRUE', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

describe('applyPatch', () => {
  it('ändert nur den Titel und erhält alle unbekannten Eigenschaften und Erinnerungen', () => {
    const out = applyPatch(existing, { title: 'Neuer Titel', zone: Z });
    expect(out).toContain('SUMMARY:Neuer Titel');
    expect(out).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
    expect(out).toContain('X-MEINE-ERWEITERUNG;X-PARAM=1:wichtig');
    expect(out).toContain('URL:https://example.com/x');
    expect(out).toContain('X-WR-CALNAME:Testkalender');
    expect(out).toContain('X-APPLE-DEFAULT-ALARM:TRUE');
    expect(out).toContain('TRIGGER:-PT30M');
    expect(out).toContain('LOCATION:Alter Ort');
    expect(out).toContain('SEQUENCE:3');
    expect(out).toContain('UID:EXIST-1');
  });

  it('verschiebt Start und behält die Dauer', () => {
    const cur = currentTimes(existing, Z);
    const start = dt('2026-10-22T09:00');
    const end = start.plus({ milliseconds: cur.endMs - cur.startMs });
    const out = applyPatch(existing, { time: { start, end, allDay: false }, zone: Z });
    expect(out).toContain('DTSTART;TZID=Europe/Berlin:20261022T090000');
    expect(out).toContain('DTEND;TZID=Europe/Berlin:20261022T103000');
    expect(out).toContain('X-MEINE-ERWEITERUNG');
  });

  it('ersetzt Erinnerungen nur, wenn welche übergeben werden', () => {
    const out = applyPatch(existing, { alertsMinutes: [10], zone: Z });
    expect(out).toContain('TRIGGER:-PT10M');
    expect(out).not.toContain('TRIGGER:-PT30M');
  });

  it('kann Ort und Notiz leeren', () => {
    const out = applyPatch(existing, { location: '', notes: '', zone: Z });
    expect(out).not.toContain('LOCATION');
    expect(out).not.toContain('DESCRIPTION:Alte Notiz');
  });

  it('fügt eine fehlende Zeitzonendefinition hinzu', () => {
    const out = applyPatch(existing, { time: { start: dt('2026-10-22T09:00'), end: dt('2026-10-22T10:00'), allDay: false }, zone: Z });
    expect(out).toContain('BEGIN:VTIMEZONE');
    expect(out.match(/BEGIN:VTIMEZONE/g)).toHaveLength(1);
  });
});

describe('analyzeEvent', () => {
  it('erkennt Teilnehmer, Organisator, Serien und Ausnahmen', () => {
    const f = analyzeEvent(
      existing.replace('SUMMARY:Alter Titel', 'SUMMARY:x\r\nATTENDEE:mailto:a@b.de\r\nORGANIZER:mailto:chef@example.com\r\nRRULE:FREQ=WEEKLY\r\nEXDATE;TZID=Europe/Berlin:20261028T100000'),
    );
    expect(f).toMatchObject({ hasMaster: true, hasAttendees: true, organizer: 'chef@example.com', recurring: true, hasExceptions: true });
  });
});

describe('vtimezoneFor', () => {
  it.each(['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Australia/Sydney', 'UTC'])('%s liefert eine lesbare Zone mit korrektem Offset', (zone) => {
    const tz = new ICAL.Timezone(vtimezoneFor(zone));
    for (const when of ['2026-01-15T12:00:00', '2026-07-15T12:00:00']) {
      const d = DateTime.fromISO(when, { zone });
      const t = ICAL.Time.fromData({ year: d.year, month: d.month, day: d.day, hour: d.hour, minute: d.minute, second: 0 }, tz);
      expect(tz.utcOffset(t) / 60).toBe(d.offset);
    }
  });
});
