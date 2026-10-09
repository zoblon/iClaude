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

describe('Merging identical events from several calendars', () => {
  it('merges the same UID in the same occurrence into one entry and lists all calendars', async () => {
    const svc = new CalendarService(cfg, reader({ Events: [vevent('U1', 'Parents evening')], Shared: [vevent('U1', 'Parents evening')] }));
    const r = await svc.listEvents(range);
    expect(r.events).toHaveLength(1);
    expect(r.total).toBe(1);
    expect(r.events[0]!.calendars.sort()).toEqual(['Events', 'Shared']);
    expect(r.events[0]!.sources).toHaveLength(2);
    expect(r.events[0]!.sharedCalendar).toBe(true);
  });

  it('picks the non-shared calendar as the main entry, regardless of order', async () => {
    // "Shared" (shared) comes before/after "Events" in calendars - the ID always belongs to the private calendar
    const svc = new CalendarService(cfg, reader({ Shared: [vevent('U1', 'Parents evening')], Events: [vevent('U1', 'Parents evening')] }));
    const [e] = (await svc.listEvents(range)).events;
    expect(e!.id).toContain('/events/');
  });

  it('merges series per occurrence', async () => {
    const series = vevent('S1', 'Training', 'RRULE:FREQ=WEEKLY;COUNT=3\r\n');
    const svc = new CalendarService(cfg, reader({ Events: [series], Shared: [series] }));
    const r = await svc.listEvents({ start: '2026-10-01', end: '2026-11-30' });
    expect(r.events).toHaveLength(3);
    expect(r.events.every((e) => e.calendars.length === 2)).toBe(true);
  });

  it('keeps different UIDs and different occurrences separate', async () => {
    const a = vevent('A', 'One');
    const b = vevent('B', 'Two');
    const svc = new CalendarService(cfg, reader({ Events: [a, b], Shared: [a] }));
    const r = await svc.listEvents(range);
    expect(r.events.map((e) => `${e.title}:${e.calendars.length}`).sort()).toEqual(['One:2', 'Two:1']);
  });

  it('also applies to search', async () => {
    const svc = new CalendarService(cfg, reader({ Events: [vevent('U1', 'Parents evening')], Shared: [vevent('U1', 'Parents evening')] }));
    const r = await svc.searchEvents({ query: 'parents', ...range });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.calendars).toHaveLength(2);
  });
});

describe('hasUnknownTzid (safeguard, because iCloud returns no time zone definition for restricted queries)', () => {
  it.each([
    ['DTSTART;TZID=Europe/Berlin:20261021T100000', false],
    ['DTSTART;TZID=America/New_York:20261021T100000', false],
    ['DTSTART:20261021T100000Z', false],
    ['DTSTART;TZID=W. Europe Standard Time:20261021T100000', true],
    ['DTSTART;TZID=Central European Standard Time:20261021T100000', true],
    ['DTSTART;TZID=Nowhere/Fantasy:20261021T100000', true],
  ])('%s -> unknown=%s', (line, expected) => {
    expect(hasUnknownTzid(`BEGIN:VEVENT\r\n${line}\r\nEND:VEVENT`)).toBe(expected);
  });
});
