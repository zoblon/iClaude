import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { parseRange, parseWhen } from '../time.js';
import { expandObject, sortEvents } from './events.js';
import { findFreeSlots, type FreeSlot } from './freeSlots.js';
import type { CalendarInfo, CalendarReader, EventOccurrence } from './types.js';

const MAX_RANGE_DAYS = 366;
const MAX_LIMIT = 200;

/** Output form of an event (without internal fields). */
export interface EventView {
  id: string;
  etag?: string;
  /** All calendars containing this event (usually one). */
  calendars: string[];
  sharedCalendar?: true;
  /** Only if the event is in several calendars: ID and ETag per calendar. */
  sources?: Array<{ calendar: string; id: string; etag?: string }>;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  recurring?: true;
  occurrenceStart?: string;
  status?: string;
  free?: true;
  hasAttendees?: true;
  organizer?: string;
}

export function toView(e: EventOccurrence): EventView {
  const all = [e, ...(e.alsoIn ?? [])];
  const calendars = [...new Set(all.map((x) => x.calendar))];
  return {
    id: e.id,
    ...(e.etag ? { etag: e.etag } : {}),
    calendars,
    ...(all.some((x) => x.calendarShared) ? { sharedCalendar: true as const } : {}),
    ...(all.length > 1 ? { sources: all.map((x) => ({ calendar: x.calendar, id: x.id, ...(x.etag ? { etag: x.etag } : {}) })) } : {}),
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    ...(e.location ? { location: e.location } : {}),
    ...(e.notes ? { notes: e.notes } : {}),
    ...(e.recurring ? { recurring: true as const } : {}),
    ...(e.occurrenceStart ? { occurrenceStart: e.occurrenceStart } : {}),
    ...(e.status ? { status: e.status } : {}),
    ...(e.free ? { free: true as const } : {}),
    ...(e.hasAttendees ? { hasAttendees: true as const } : {}),
    ...(e.organizer ? { organizer: e.organizer } : {}),
  };
}

/**
 * Merges events with the same UID and the same occurrence (RECURRENCE-ID) from several calendars.
 * The main entry is preferably in a non-shared calendar; the others are listed in `alsoIn`.
 */
export function mergeAcrossCalendars(list: EventOccurrence[]): EventOccurrence[] {
  const out: EventOccurrence[] = [];
  const byKey = new Map<string, EventOccurrence>();
  for (const e of list) {
    if (!e.uid) {
      out.push(e);
      continue;
    }
    const key = `${e.uid}\u0000${e.occurrenceStart ?? ''}`;
    const first = byKey.get(key);
    if (!first) {
      byKey.set(key, e);
      out.push(e);
      continue;
    }
    // The same calendar cannot contain the same resource twice; merging is only for other calendars.
    if (first.calendarId === e.calendarId) {
      out.push(e);
      continue;
    }
    if (first.calendarShared && !e.calendarShared) {
      // Prefer the non-shared calendar as the main entry
      const idx = out.indexOf(first);
      const merged: EventOccurrence = { ...e, alsoIn: [first, ...(first.alsoIn ?? [])] };
      out[idx] = merged;
      byKey.set(key, merged);
    } else {
      (first.alsoIn ??= []).push(e);
    }
  }
  return out;
}

export class CalendarService {
  constructor(
    private readonly cfg: Config,
    private readonly dav: CalendarReader,
  ) {}

  get timezone(): string {
    return this.cfg.timezone;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return this.dav.listCalendars();
  }

  /** Selects calendars by name or ID; without input, all event calendars. */
  async resolve(refs?: string[]): Promise<CalendarInfo[]> {
    const all = (await this.dav.listCalendars()).filter((c) => c.kind === 'events');
    if (!refs || refs.length === 0) return all;
    const picked: CalendarInfo[] = [];
    for (const ref of refs) {
      const r = ref.trim().toLowerCase();
      const hits = all.filter((c) => c.name.toLowerCase() === r || c.id === ref.trim());
      if (hits.length === 0) {
        throw new UserError(`Calendar "${ref}" not found. Available: ${all.map((c) => `"${c.name}"`).join(', ')}.`);
      }
      if (hits.length > 1) throw new UserError(`The name "${ref}" is ambiguous. Please use the ID (list_calendars).`);
      picked.push(hits[0]!);
    }
    return [...new Set(picked)];
  }

  private async load(calendars: CalendarInfo[], start: DateTime, end: DateTime) {
    const opts = { zone: this.cfg.timezone, rangeStartMs: start.toMillis(), rangeEndMs: end.toMillis() };
    const startIso = start.toUTC().toISO()!;
    const endIso = end.toUTC().toISO()!;
    const parts = await Promise.all(
      calendars.map(async (cal) => {
        const { objects, truncated } = await this.dav.fetchObjects(cal, startIso, endIso);
        let cut = truncated;
        const events: EventOccurrence[] = [];
        for (const o of objects) {
          const r = expandObject(o, cal, opts);
          events.push(...r.events);
          cut ||= r.truncated;
        }
        return { events, truncated: cut };
      }),
    );
    return { events: mergeAcrossCalendars(sortEvents(parts.flatMap((p) => p.events))), truncated: parts.some((p) => p.truncated) };
  }

  async listEvents(a: { start: string; end: string; calendars?: string[]; limit?: number }) {
    const range = parseRange(a.start, a.end, this.cfg.timezone, MAX_RANGE_DAYS);
    const cals = await this.resolve(a.calendars);
    const { events, truncated } = await this.load(cals, range.start, range.end);
    const limit = Math.min(a.limit ?? 100, MAX_LIMIT);
    return {
      calendarsQueried: cals.map((c) => c.name),
      total: events.length,
      events: events.slice(0, limit).map(toView),
      cut: events.length > limit,
      seriesTruncated: truncated,
    };
  }

  async searchEvents(a: { query: string; start?: string; end?: string; calendars?: string[]; limit?: number }) {
    const q = a.query.trim().toLowerCase();
    if (!q) throw new UserError('The search term must not be empty. Please provide a search term.');
    const now = DateTime.now().setZone(this.cfg.timezone);
    const start = a.start ? parseWhen(a.start, this.cfg.timezone, 'start', 'Start') : now.minus({ days: 30 }).startOf('day');
    const end = a.end ? parseWhen(a.end, this.cfg.timezone, 'end', 'End') : start.plus({ days: 210 });
    const range = parseRange(start.toISO()!, end.toISO()!, this.cfg.timezone, MAX_RANGE_DAYS);
    const cals = await this.resolve(a.calendars);
    const { events, truncated } = await this.load(cals, range.start, range.end);
    const hits = events.filter((e) => [e.title, e.location, e.notes, e.organizer ?? ''].some((t) => t.toLowerCase().includes(q)));
    const limit = Math.min(a.limit ?? 50, MAX_LIMIT);
    return {
      searchedFrom: range.start.toISODate()!,
      searchedTo: range.end.minus({ days: 1 }).toISODate()!,
      total: hits.length,
      events: hits.slice(0, limit).map(toView),
      cut: hits.length > limit,
      seriesTruncated: truncated,
    };
  }

  async findFreeSlots(a: {
    start: string;
    end: string;
    durationMinutes: number;
    dayStart?: string;
    dayEnd?: string;
    weekdaysOnly?: boolean;
    allDayBlocks?: boolean;
    calendars?: string[];
    maxSlots?: number;
  }): Promise<{ slots: FreeSlot[]; more: boolean; busyCalendars: string[]; ignoredFreeEvents: number }> {
    const range = parseRange(a.start, a.end, this.cfg.timezone, 92);
    const cals = await this.resolve(a.calendars);
    const { events } = await this.load(cals, range.start, range.end);
    let ignored = 0;
    const busy = events
      .filter((e) => {
        if (e.free) {
          ignored++;
          return false;
        }
        return a.allDayBlocks ? true : !e.allDay;
      })
      .map((e) => ({ startMs: e.startMs, endMs: e.endMs }));
    const r = findFreeSlots(busy, {
      zone: this.cfg.timezone,
      rangeStartMs: range.start.toMillis(),
      rangeEndMs: range.end.toMillis(),
      durationMinutes: a.durationMinutes,
      dayStart: a.dayStart ?? '09:00',
      dayEnd: a.dayEnd ?? '18:00',
      weekdaysOnly: a.weekdaysOnly ?? false,
      nowMs: Date.now(),
      maxSlots: Math.min(a.maxSlots ?? 20, 100),
    });
    return { ...r, busyCalendars: cals.map((c) => c.name), ignoredFreeEvents: ignored };
  }
}
