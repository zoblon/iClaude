import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { isoIn } from '../time.js';
import { clip } from '../untrusted.js';
import type { CalendarInfo, EventOccurrence, RawObject } from './types.js';

/** Obergrenze an Schleifendurchläufen je Serie (Schutz vor endlosen Regeln). */
const MAX_ITERATIONS = 40_000;
const NOTES_MAX = 2000;
const TEXT_MAX = 300;

export interface ExpandOptions {
  zone: string;
  rangeStartMs: number;
  rangeEndMs: number;
}

export interface ExpandResult {
  events: EventOccurrence[];
  /** true, wenn eine Serie wegen der Obergrenze nicht vollständig durchlaufen wurde. */
  truncated: boolean;
}

function registerTimezones(root: ICAL.Component): void {
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      /* unlesbare Zeitzonendefinition: Fallback über IANA-Namen */
    }
  }
}

/** Wandelt eine iCal-Zeit in Millisekunden. Schwebende Zeiten und IANA-Zonen werden über luxon aufgelöst. */
export function toMs(time: ICAL.Time, tzidHint: string | undefined, zone: string): number {
  if (time.isDate) {
    return DateTime.fromObject({ year: time.year, month: time.month, day: time.day }, { zone }).toMillis();
  }
  const tz = time.zone;
  const isUtc = tz === ICAL.Timezone.utcTimezone;
  const isFloating = !tz || tz === ICAL.Timezone.localTimezone;
  if (isUtc) return time.toUnixTime() * 1000;
  const fields = { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second };
  const name = (!isFloating && tz.tzid) || tzidHint;
  if (name) {
    const dt = DateTime.fromObject(fields, { zone: name });
    if (dt.isValid) return dt.toMillis();
  }
  if (isFloating) return DateTime.fromObject(fields, { zone }).toMillis();
  return time.toUnixTime() * 1000;
}

function personOf(prop: ICAL.Property | null): string | undefined {
  if (!prop) return undefined;
  const v = String(prop.getFirstValue() ?? '');
  return v.replace(/^mailto:/i, '') || undefined;
}

/** Zerlegt eine .ics-Ressource in Vorkommen innerhalb des Zeitraums. */
export function expandObject(obj: RawObject, calendar: CalendarInfo, opts: ExpandOptions): ExpandResult {
  const out: EventOccurrence[] = [];
  let truncated = false;
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(obj.data));
  } catch {
    return { events: [], truncated: false };
  }
  registerTimezones(root);

  const byUid = new Map<string, { master?: ICAL.Component; exceptions: ICAL.Component[] }>();
  for (const comp of root.getAllSubcomponents('vevent')) {
    const uid = String(comp.getFirstPropertyValue('uid') ?? obj.url);
    const slot = byUid.get(uid) ?? { exceptions: [] };
    if (comp.hasProperty('recurrence-id')) slot.exceptions.push(comp);
    else slot.master = comp;
    byUid.set(uid, slot);
  }

  const make = (
    uid: string,
    item: ICAL.Component,
    start: ICAL.Time,
    end: ICAL.Time,
    tzid: string | undefined,
    recurring: boolean,
    occurrenceKey?: string,
  ): EventOccurrence | undefined => {
    const status = String(item.getFirstPropertyValue('status') ?? '').toUpperCase();
    if (status === 'CANCELLED') return undefined;
    const allDay = start.isDate;
    const startMs = toMs(start, tzid, opts.zone);
    let endMs = toMs(end, tzid, opts.zone);
    if (endMs <= startMs) endMs = allDay ? DateTime.fromMillis(startMs, { zone: opts.zone }).plus({ days: 1 }).toMillis() : startMs;
    if (!(endMs > opts.rangeStartMs && startMs < opts.rangeEndMs) && !(endMs === startMs && startMs >= opts.rangeStartMs && startMs < opts.rangeEndMs)) {
      return undefined;
    }
    const day = (ms: number) => DateTime.fromMillis(ms, { zone: opts.zone }).toISODate() ?? '';
    // Ganztägig: Ende ist in iCal exklusiv; für Menschen den letzten Tag ausgeben.
    const endOut = allDay ? day(Math.max(startMs, endMs - 1)) : isoIn(endMs, opts.zone);
    const attendees = item.getAllProperties('attendee');
    const organizer = personOf(item.getFirstProperty('organizer'));
    return {
      id: new URL(obj.url, 'https://x').pathname,
      uid,
      ...(obj.etag ? { etag: obj.etag } : {}),
      calendar: calendar.name,
      calendarId: calendar.id,
      calendarShared: calendar.shared,
      title: clip(String(item.getFirstPropertyValue('summary') ?? ''), TEXT_MAX) || '(ohne Titel)',
      location: clip(String(item.getFirstPropertyValue('location') ?? ''), TEXT_MAX),
      notes: clip(String(item.getFirstPropertyValue('description') ?? ''), NOTES_MAX),
      allDay,
      start: allDay ? day(startMs) : isoIn(startMs, opts.zone),
      end: endOut,
      startMs,
      endMs,
      recurring,
      ...(occurrenceKey ? { occurrenceStart: occurrenceKey } : {}),
      ...(status ? { status } : {}),
      free: String(item.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT',
      hasAttendees: attendees.length > 0,
      ...(organizer ? { organizer: clip(organizer, TEXT_MAX) } : {}),
    };
  };

  for (const [uid, { master, exceptions }] of byUid) {
    if (!master) {
      // Nur Ausnahmen ohne Serie in dieser Ressource: wie Einzeltermine behandeln.
      for (const ex of exceptions) {
        const ev = new ICAL.Event(ex);
        const tzid = ex.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
        const o = make(uid, ex, ev.startDate, ev.endDate, tzid, true);
        if (o) out.push(o);
      }
      continue;
    }
    const ev = new ICAL.Event(master);
    const tzid = master.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
    if (!ev.isRecurring()) {
      const o = make(uid, master, ev.startDate, ev.endDate, tzid, false);
      if (o) out.push(o);
      continue;
    }
    for (const ex of exceptions) ev.relateException(ex);
    const seen = new Set<string>();
    const it = ev.iterator();
    let n = 0;
    for (let next = it.next(); next; next = it.next()) {
      if (++n > MAX_ITERATIONS) {
        truncated = true;
        break;
      }
      const startMs = toMs(next, tzid, opts.zone);
      if (startMs >= opts.rangeEndMs && !exceptions.length) break;
      if (startMs >= opts.rangeEndMs + 400 * 86400_000) break;
      const key = next.toString();
      seen.add(key);
      const d = ev.getOccurrenceDetails(next);
      const itemTz = d.item.component.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
      const o = make(uid, d.item.component, d.startDate, d.endDate, itemTz ?? tzid, true, isoIn(startMs, opts.zone));
      if (o) out.push(o);
    }
    // Ausnahmen, deren ursprüngliches Datum außerhalb lag, die aber in den Zeitraum verschoben wurden.
    for (const ex of exceptions) {
      const rid = ex.getFirstPropertyValue('recurrence-id');
      if (rid && seen.has(String(rid))) continue;
      const exEv = new ICAL.Event(ex);
      const exTz = ex.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
      const o = make(uid, ex, exEv.startDate, exEv.endDate, exTz ?? tzid, true, isoIn(toMs(exEv.startDate, exTz ?? tzid, opts.zone), opts.zone));
      if (o) out.push(o);
    }
  }
  return { events: out, truncated };
}

export function sortEvents(list: EventOccurrence[]): EventOccurrence[] {
  return list.sort((a, b) => a.startMs - b.startMs || a.title.localeCompare(b.title));
}
