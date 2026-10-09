import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { CalendarService } from '../core/calendar/service.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const calendars = z.array(z.string().min(1).max(100)).max(20).optional().describe('Calendar names (or IDs). If omitted: all event calendars.');
const when = (what: string) =>
  z
    .string()
    .min(8)
    .max(40)
    .describe(`${what} as ISO 8601: "2026-10-09" (whole day) or "2026-10-09T14:30:00". Without a time zone, the default time zone applies.`);

export function registerCalendarTools(server: McpServer, cal: CalendarService): void {
  server.registerTool(
    'list_calendars',
    {
      title: 'List calendars',
      description:
        'Lists all iCloud calendars with name, id, whether it is shared with other people (shared=true: entries appear immediately for others), writable, and kind (events or tasks). Read-only.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('list_calendars', async () => {
        const list = await cal.listCalendars();
        return dataResult({
          summary: `${list.length} calendar(s) found.`,
          source: 'the iCloud calendar (calendar names)',
          data: list.map((c) => ({
            name: c.name,
            id: c.id,
            kind: c.kind,
            shared: c.shared,
            writable: c.writable,
            subscribed: c.subscribed,
          })),
          notes: ['Calendars with kind=tasks are reminder lists and are not supported by this connector.'],
        });
      }),
  );

  server.registerTool(
    'list_events',
    {
      title: 'List events',
      description:
        'Lists calendar events in a time range, sorted by start time, with recurring events expanded into single occurrences. Searches all event calendars unless `calendars` is given. Maximum range: 366 days. Read-only.',
      inputSchema: z.object({
        start: when('Start of the range'),
        end: when('End of the range (for a plain date: including that day)'),
        calendars,
        limit: z.number().int().min(1).max(200).default(100).describe('Maximum number of events (default 100).'),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded('list_events', async () => {
        const r = await cal.listEvents(args);
        return dataResult({
          summary: `${r.total} event(s) in the range${r.cut ? `, showing the first ${r.events.length}` : ''}. Time zone: ${cal.timezone}.`,
          source: 'the iCloud calendar (events)',
          data: r.events,
          notes: [
            ...(r.cut ? ['Result truncated. Narrow the range or increase limit.'] : []),
            ...(r.seriesTruncated ? ['At least one recurring series was too large and was not fully evaluated.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'search_events',
    {
      title: 'Search events',
      description:
        'Searches event title, location, notes and organizer (case-insensitive substring) within a time range. Default range: 30 days back to about 6 months ahead. Maximum range: 366 days. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe('Search term'),
        start: when('Start of the search range').optional(),
        end: when('End of the search range').optional(),
        calendars,
        limit: z.number().int().min(1).max(200).default(50),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded('search_events', async () => {
        const r = await cal.searchEvents(args);
        return dataResult({
          summary: `${r.total} match(es) (searched: ${r.searchedFrom} to ${r.searchedTo}).`,
          source: 'the iCloud calendar (events)',
          data: r.events,
          notes: [
            ...(r.cut ? ['Result truncated. Narrow the search or increase limit.'] : []),
            ...(r.seriesTruncated ? ['At least one recurring series was too large and was not fully evaluated.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'find_free_slots',
    {
      title: 'Find free slots',
      description:
        'Finds free time slots of at least `duration_minutes` within daily time window (default 09:00-18:00). Busy = events in the selected calendars; all-day events and events marked "free" do not block unless all_day_blocks=true. Past times are never offered. Maximum range: 92 days. Read-only.',
      inputSchema: z.object({
        start: when('Start of the range'),
        end: when('End of the range (for a plain date: including that day)'),
        duration_minutes: z.number().int().min(5).max(720).describe('Required minimum duration in minutes.'),
        day_start: z.string().regex(/^\d{1,2}:\d{2}$/).default('09:00').describe('Earliest start per day, HH:MM.'),
        day_end: z.string().regex(/^\d{1,2}:\d{2}$/).default('18:00').describe('Latest end per day, HH:MM.'),
        weekdays_only: z.boolean().default(false).describe('Monday to Friday only.'),
        all_day_blocks: z.boolean().default(false).describe('All-day events block the day.'),
        calendars,
        max_slots: z.number().int().min(1).max(100).default(20),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('find_free_slots', async () => {
        const r = await cal.findFreeSlots({
          start: a.start,
          end: a.end,
          durationMinutes: a.duration_minutes,
          dayStart: a.day_start,
          dayEnd: a.day_end,
          weekdaysOnly: a.weekdays_only,
          allDayBlocks: a.all_day_blocks,
          ...(a.calendars ? { calendars: a.calendars } : {}),
          maxSlots: a.max_slots,
        });
        return dataResult({
          summary: `${r.slots.length} free slot(s)${r.more ? ' (more available)' : ''}. Time zone: ${cal.timezone}. Calendars considered: ${r.busyCalendars.join(', ')}.`,
          source: 'the iCloud calendar (busy times)',
          data: r.slots,
          notes: [...(r.more ? ['There are more free slots. Increase max_slots or narrow the range.'] : [])],
        });
      }),
  );
}
