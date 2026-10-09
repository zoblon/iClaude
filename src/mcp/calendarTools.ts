import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { CalendarService } from '../core/calendar/service.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const calendars = z.array(z.string().min(1).max(100)).max(20).optional().describe('Kalendernamen (oder IDs). Ohne Angabe: alle Termin-Kalender.');
const when = (what: string) =>
  z
    .string()
    .min(8)
    .max(40)
    .describe(`${what} als ISO 8601: "2026-10-09" (ganzer Tag) oder "2026-10-09T14:30:00". Ohne Zeitzone gilt die Standardzeitzone.`);

export function registerCalendarTools(server: McpServer, cal: CalendarService): void {
  server.registerTool(
    'list_calendars',
    {
      title: 'Kalender auflisten',
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
          summary: `${list.length} Kalender gefunden.`,
          source: 'dem iCloud-Kalender (Kalendernamen)',
          data: list.map((c) => ({
            name: c.name,
            id: c.id,
            kind: c.kind,
            shared: c.shared,
            writable: c.writable,
            subscribed: c.subscribed,
          })),
          notes: ['Kalender mit kind=tasks sind Erinnerungslisten und werden von diesem Konnektor nicht unterstützt.'],
        });
      }),
  );

  server.registerTool(
    'list_events',
    {
      title: 'Termine auflisten',
      description:
        'Lists calendar events in a time range, sorted by start time, with recurring events expanded into single occurrences. Searches all event calendars unless `calendars` is given. Maximum range: 366 days. Read-only.',
      inputSchema: z.object({
        start: when('Beginn des Zeitraums'),
        end: when('Ende des Zeitraums (bei reinem Datum: einschließlich dieses Tages)'),
        calendars,
        limit: z.number().int().min(1).max(200).default(100).describe('Maximale Anzahl Termine (Standard 100).'),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded('list_events', async () => {
        const r = await cal.listEvents(args);
        return dataResult({
          summary: `${r.total} Termine im Zeitraum${r.cut ? `, die ersten ${r.events.length} werden angezeigt` : ''}. Zeitzone: ${cal.timezone}.`,
          source: 'dem iCloud-Kalender (Termine)',
          data: r.events,
          notes: [
            ...(r.cut ? ['Ergebnis gekürzt. Zeitraum verkleinern oder limit erhöhen.'] : []),
            ...(r.seriesTruncated ? ['Mindestens eine Terminserie war zu umfangreich und wurde nicht vollständig ausgewertet.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'search_events',
    {
      title: 'Termine suchen',
      description:
        'Searches event title, location, notes and organizer (case-insensitive substring) within a time range. Default range: 30 days back to about 6 months ahead. Maximum range: 366 days. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe('Suchbegriff'),
        start: when('Beginn des Suchzeitraums').optional(),
        end: when('Ende des Suchzeitraums').optional(),
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
          summary: `${r.total} Treffer (durchsucht: ${r.searchedFrom} bis ${r.searchedTo}).`,
          source: 'dem iCloud-Kalender (Termine)',
          data: r.events,
          notes: [
            ...(r.cut ? ['Ergebnis gekürzt. Suche eingrenzen oder limit erhöhen.'] : []),
            ...(r.seriesTruncated ? ['Mindestens eine Terminserie war zu umfangreich und wurde nicht vollständig ausgewertet.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'find_free_slots',
    {
      title: 'Freie Zeiten finden',
      description:
        'Finds free time slots of at least `duration_minutes` within daily time window (default 09:00-18:00). Busy = events in the selected calendars; all-day events and events marked "free" do not block unless all_day_blocks=true. Past times are never offered. Maximum range: 92 days. Read-only.',
      inputSchema: z.object({
        start: when('Beginn des Zeitraums'),
        end: when('Ende des Zeitraums (bei reinem Datum: einschließlich dieses Tages)'),
        duration_minutes: z.number().int().min(5).max(720).describe('Gewünschte Mindestdauer in Minuten.'),
        day_start: z.string().regex(/^\d{1,2}:\d{2}$/).default('09:00').describe('Frühester Beginn pro Tag, HH:MM.'),
        day_end: z.string().regex(/^\d{1,2}:\d{2}$/).default('18:00').describe('Spätestes Ende pro Tag, HH:MM.'),
        weekdays_only: z.boolean().default(false).describe('Nur Montag bis Freitag.'),
        all_day_blocks: z.boolean().default(false).describe('Ganztägige Termine blockieren den Tag.'),
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
          summary: `${r.slots.length} freie Zeitfenster${r.more ? ' (weitere vorhanden)' : ''}. Zeitzone: ${cal.timezone}. Berücksichtigte Kalender: ${r.busyCalendars.join(', ')}.`,
          source: 'dem iCloud-Kalender (Terminbelegung)',
          data: r.slots,
          notes: [...(r.more ? ['Es gibt weitere freie Zeiten. max_slots erhöhen oder Zeitraum verkleinern.'] : [])],
        });
      }),
  );
}
