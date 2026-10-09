import { describe, expect, it } from 'vitest';
import { CalendarService } from '../src/core/calendar/service.js';
import { hasUnknownTzid } from '../src/core/calendar/caldav.js';
import type { CalendarInfo, CalendarReader, RawObject } from '../src/core/calendar/types.js';
import { calendars, cfg } from './fakeStore.js';

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
const vevent = (uid: string, summary: string, extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=Europe/Berlin:20261021T100000\r\nDTEND;TZID=Europe/Berlin:20261021T110000\r\nSUMMARY:${summary}\r\n${extra}END:VEVENT`;

function reader(perCalendar: Record<string, string[]>): CalendarReader {
  return {
    listCalendars: async () => calendars,
    fetchObjects: async (c: CalendarInfo) => ({
      objects: (perCalendar[c.name] ?? []).map((data, i): RawObject => ({ url: `${c.url}${i}.ics`, etag: `"${c.name}${i}"`, data: wrap(data) })),
      truncated: false,
    }),
    getObject: async () => undefined,
  };
}
const range = { start: '2026-10-01', end: '2026-11-01' };

describe('Zusammenführen gleicher Termine aus mehreren Kalendern', () => {
  it('führt gleiche UID im selben Vorkommen zu einem Eintrag zusammen und nennt alle Kalender', async () => {
    const svc = new CalendarService(cfg, reader({ Termine: [vevent('U1', 'Elternabend')], Gemeinsam: [vevent('U1', 'Elternabend')] }));
    const r = await svc.listEvents(range);
    expect(r.events).toHaveLength(1);
    expect(r.total).toBe(1);
    expect(r.events[0]!.calendars.sort()).toEqual(['Gemeinsam', 'Termine']);
    expect(r.events[0]!.sources).toHaveLength(2);
    expect(r.events[0]!.sharedCalendar).toBe(true);
  });

  it('wählt als Haupteintrag den nicht geteilten Kalender, egal in welcher Reihenfolge', async () => {
    // "Gemeinsam" (geteilt) steht in calendars vor/nach "Termine" - die ID gehört immer zum privaten Kalender
    const svc = new CalendarService(cfg, reader({ Gemeinsam: [vevent('U1', 'Elternabend')], Termine: [vevent('U1', 'Elternabend')] }));
    const [e] = (await svc.listEvents(range)).events;
    expect(e!.id).toContain('/termine/');
  });

  it('führt Serien je Vorkommen zusammen', async () => {
    const series = vevent('S1', 'Training', 'RRULE:FREQ=WEEKLY;COUNT=3\r\n');
    const svc = new CalendarService(cfg, reader({ Termine: [series], Gemeinsam: [series] }));
    const r = await svc.listEvents({ start: '2026-10-01', end: '2026-11-30' });
    expect(r.events).toHaveLength(3);
    expect(r.events.every((e) => e.calendars.length === 2)).toBe(true);
  });

  it('lässt verschiedene UIDs und verschiedene Vorkommen getrennt', async () => {
    const a = vevent('A', 'Eins');
    const b = vevent('B', 'Zwei');
    const svc = new CalendarService(cfg, reader({ Termine: [a, b], Gemeinsam: [a] }));
    const r = await svc.listEvents(range);
    expect(r.events.map((e) => `${e.title}:${e.calendars.length}`).sort()).toEqual(['Eins:2', 'Zwei:1']);
  });

  it('wirkt auch in der Suche', async () => {
    const svc = new CalendarService(cfg, reader({ Termine: [vevent('U1', 'Elternabend')], Gemeinsam: [vevent('U1', 'Elternabend')] }));
    const r = await svc.searchEvents({ query: 'eltern', ...range });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.calendars).toHaveLength(2);
  });
});

describe('hasUnknownTzid (Absicherung, weil iCloud bei eingeschränkten Abfragen keine Zeitzonendefinition liefert)', () => {
  it.each([
    ['DTSTART;TZID=Europe/Berlin:20261021T100000', false],
    ['DTSTART;TZID=America/New_York:20261021T100000', false],
    ['DTSTART:20261021T100000Z', false],
    ['DTSTART;TZID=W. Europe Standard Time:20261021T100000', true],
    ['DTSTART;TZID=Central European Standard Time:20261021T100000', true],
    ['DTSTART;TZID=Nirgendwo/Fantasie:20261021T100000', true],
  ])('%s -> unbekannt=%s', (line, expected) => {
    expect(hasUnknownTzid(`BEGIN:VEVENT\r\n${line}\r\nEND:VEVENT`)).toBe(expected);
  });
});
