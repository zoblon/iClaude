import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { UserError } from '../errors.js';
import { isoIn } from '../time.js';
import { clip } from '../untrusted.js';
import { toMs } from './events.js';

export interface InvitationEvent {
  uid: string;
  title: string;
  /** With time in the user's time zone; for all-day events only the date. */
  start: string;
  /** For all-day events the LAST day (inclusive). */
  end: string;
  allDay: boolean;
  location?: string;
  organizer?: { name?: string; email?: string };
  status?: string;
  /** Recurrence rule as plain text (RRULE). */
  recurrence?: string;
  /** Set for a changed single occurrence of a series (RECURRENCE-ID): the original start of that occurrence. */
  overridesOccurrence?: string;
  attendeeCount: number;
  alarmsMinutesBefore: number[];
  description?: string;
}

export interface InvitationSummary {
  /** iTIP method of the file (REQUEST, REPLY, CANCEL, PUBLISH, …), if present. */
  method?: string;
  events: InvitationEvent[];
  /** More events in the file than listed. */
  cut: boolean;
}

const MAX_EVENTS = 30;

function parseRoot(ics: string): ICAL.Component {
  try {
    const root = new ICAL.Component(ICAL.parse(ics));
    if (root.name !== 'vcalendar') throw new Error('not a calendar');
    return root;
  } catch {
    throw new UserError('The calendar file could not be read (invalid iCalendar format).');
  }
}

function registerTimezones(root: ICAL.Component): void {
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      /* unreadable time zone definition: fall back to the IANA name */
    }
  }
}

export function personOf(prop: ICAL.Property | null): { name?: string; email?: string } | undefined {
  if (!prop) return undefined;
  const email = String(prop.getFirstValue() ?? '').replace(/^mailto:/i, '').trim();
  const name = String(prop.getParameter('cn') ?? '').trim();
  if (!email && !name) return undefined;
  return { ...(name ? { name: clip(name, 200) } : {}), ...(email ? { email: clip(email, 200) } : {}) };
}

/** Alarms as "minutes before the start"; other forms (fixed time, after the start) are skipped. */
export function alarmMinutes(vevent: ICAL.Component): number[] {
  const out: number[] = [];
  for (const alarm of vevent.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstProperty('trigger');
    const value = trigger?.getFirstValue();
    const related = String(trigger?.getParameter('related') ?? 'START').toUpperCase();
    if (value instanceof ICAL.Duration && related === 'START') {
      const secs = value.toSeconds();
      const minutes = Math.round(-secs / 60);
      if (secs <= 0 && minutes <= 40320 && !out.includes(minutes)) out.push(minutes);
    }
  }
  return out;
}

/** Reads a calendar file (an invitation or any .ics) without changing anything. */
export function summarizeInvitation(ics: string, zone: string): InvitationSummary {
  const root = parseRoot(ics);
  registerTimezones(root);
  const method = String(root.getFirstPropertyValue('method') ?? '').toUpperCase();
  const all = root.getAllSubcomponents('vevent');
  const events: InvitationEvent[] = [];
  for (const v of all.slice(0, MAX_EVENTS)) {
    const ev = new ICAL.Event(v);
    const tzid = v.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
    const allDay = ev.startDate?.isDate ?? false;
    if (!ev.startDate) continue;
    const startMs = toMs(ev.startDate, tzid, zone);
    let endMs = ev.endDate ? toMs(ev.endDate, tzid, zone) : startMs;
    if (endMs <= startMs) endMs = allDay ? DateTime.fromMillis(startMs, { zone }).plus({ days: 1 }).toMillis() : startMs;
    const rrule = v.getFirstProperty('rrule')?.getFirstValue();
    const rid = v.getFirstPropertyValue('recurrence-id') as ICAL.Time | null;
    const organizer = personOf(v.getFirstProperty('organizer'));
    const location = String(v.getFirstPropertyValue('location') ?? '').trim();
    const description = String(v.getFirstPropertyValue('description') ?? '').trim();
    const status = String(v.getFirstPropertyValue('status') ?? '').toUpperCase();
    events.push({
      uid: String(v.getFirstPropertyValue('uid') ?? ''),
      title: clip(String(v.getFirstPropertyValue('summary') ?? ''), 300) || '(no title)',
      start: allDay ? (DateTime.fromMillis(startMs, { zone }).toISODate() ?? '') : isoIn(startMs, zone),
      end: allDay ? (DateTime.fromMillis(Math.max(startMs, endMs - 1), { zone }).toISODate() ?? '') : isoIn(endMs, zone),
      allDay,
      ...(location ? { location: clip(location, 300) } : {}),
      ...(organizer ? { organizer } : {}),
      ...(status ? { status } : {}),
      ...(rrule ? { recurrence: String(rrule) } : {}),
      ...(rid ? { overridesOccurrence: allDay ? (DateTime.fromMillis(toMs(rid, tzid, zone), { zone }).toISODate() ?? '') : isoIn(toMs(rid, tzid, zone), zone) } : {}),
      attendeeCount: v.getAllProperties('attendee').length,
      alarmsMinutesBefore: alarmMinutes(v),
      ...(description ? { description: clip(description, 3000) } : {}),
    });
  }
  return { ...(method ? { method } : {}), events, cut: all.length > MAX_EVENTS };
}
