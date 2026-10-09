import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { authorizeCreate } from '../permissions.js';
import { decodeRef } from '../mail/ref.js';
import type { MailReader } from '../mail/types.js';
import { isoIn } from '../time.js';
import { clip } from '../untrusted.js';
import { expandObject, registerTimezones, toMs } from './events.js';
import { alarmMinutes, personOf } from './invitation.js';
import { assertSafeOutput, vtimezoneFor } from './ics.js';
import { toView, type EventView } from './service.js';
import type { CalendarInfo, CalendarStore, RawObject } from './types.js';

const MAX_ICS_BYTES = 2 * 1024 * 1024;
const MAX_VEVENTS = 60;
const PRODID = '-//icloud-mcp//local connector//EN';

/** Windows time zone names (as sent by Outlook/Exchange) and the IANA zones they stand for. */
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arab Standard Time': 'Asia/Riyadh',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'UTC': 'UTC',
};

const validZone = (z: string) => z === 'UTC' || DateTime.local().setZone(z).isValid;

type Mapped =
  | { kind: 'date'; year: number; month: number; day: number }
  | { kind: 'utc'; f: Fields }
  | { kind: 'tz'; tzid: string; f: Fields };
interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
const fieldsOf = (t: ICAL.Time): Fields => ({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second });

/** A time of the invitation as it is written into the new event: date, UTC, or wall-clock time in an IANA zone. */
function mapTime(time: ICAL.Time, tzidParam: string | undefined, zone: string, notes: Set<string>): Mapped {
  if (time.isDate) return { kind: 'date', year: time.year, month: time.month, day: time.day };
  if (time.zone === ICAL.Timezone.utcTimezone) return { kind: 'utc', f: fieldsOf(time) };
  const floating = !time.zone || time.zone === ICAL.Timezone.localTimezone;
  const name = tzidParam ?? (!floating ? time.zone.tzid : undefined);
  if (!name) return { kind: 'tz', tzid: zone, f: fieldsOf(time) }; // floating = local time of the user
  const iana = validZone(name) ? name : WINDOWS_ZONES[name];
  if (iana === 'UTC') return { kind: 'utc', f: fieldsOf(time) };
  if (iana) return { kind: 'tz', tzid: iana, f: fieldsOf(time) };
  // Unknown zone name: keep the instant, write it in the user's time zone.
  notes.add(`The invitation uses the time zone "${clip(name, 60)}", which is unknown here; times were converted to ${zone}.`);
  const dt = DateTime.fromMillis(toMs(time, name, zone), { zone });
  return { kind: 'tz', tzid: zone, f: { year: dt.year, month: dt.month, day: dt.day, hour: dt.hour, minute: dt.minute, second: dt.second } };
}

function timeValue(m: Mapped): ICAL.Time {
  if (m.kind === 'date') return ICAL.Time.fromData({ year: m.year, month: m.month, day: m.day, isDate: true });
  if (m.kind === 'utc') return ICAL.Time.fromData(m.f, ICAL.Timezone.utcTimezone);
  return ICAL.Time.fromData(m.f);
}

function timeProp(name: string, m: Mapped, root: ICAL.Component): ICAL.Property {
  const prop = new ICAL.Property(name);
  prop.setValue(timeValue(m));
  if (m.kind === 'tz') {
    prop.setParameter('tzid', m.tzid);
    if (!root.getAllSubcomponents('vtimezone').some((z) => z.getFirstPropertyValue('tzid') === m.tzid)) root.addSubcomponent(vtimezoneFor(m.tzid));
  }
  return prop;
}

export interface ImportPlan {
  uid: string;
  /** The new .ics file. */
  ics: string;
  /** What was dropped or converted, for the caller. */
  notes: string[];
  attendeesDropped: number;
  organizer?: { name?: string; email?: string };
  events: number;
}

const ACCEPTED_METHODS = new Set(['', 'REQUEST', 'PUBLISH']);

/**
 * Turns an invitation into an event of the user's own: only title, time, location, description (plus the organizer as text), recurrence and reminders
 * are taken over. ATTENDEE, ORGANIZER and METHOD are never written. A series with changed occurrences is taken over completely or refused, never in part.
 */
export function planImport(ics: string, zone: string): ImportPlan {
  let src: ICAL.Component;
  try {
    src = new ICAL.Component(ICAL.parse(ics));
    if (src.name !== 'vcalendar') throw new Error('x');
  } catch {
    throw new UserError('The calendar file could not be read (invalid iCalendar format). Nothing was imported.');
  }
  registerTimezones(src);
  const method = String(src.getFirstPropertyValue('method') ?? '').toUpperCase();
  if (!ACCEPTED_METHODS.has(method)) {
    throw new UserError(`This calendar file is a "${method}" message (a reply, cancellation or update), not an invitation. Nothing was imported.`);
  }
  const vevents = src.getAllSubcomponents('vevent');
  if (!vevents.length) throw new UserError('The calendar file contains no event. Nothing was imported.');
  if (vevents.length > MAX_VEVENTS) throw new UserError(`The calendar file contains too many events (${vevents.length}). Nothing was imported.`);
  const uids = new Set(vevents.map((v) => String(v.getFirstPropertyValue('uid') ?? '')));
  if (uids.size > 1) {
    throw new UserError(`The calendar file contains ${uids.size} different events. import_invitation takes over one event (with its changed occurrences) at a time. Nothing was imported.`);
  }
  const master = vevents.find((v) => !v.hasProperty('recurrence-id'));
  if (!master) {
    throw new UserError('The calendar file contains only changed occurrences of a series, not the series itself, so it cannot be imported completely. Nothing was imported.');
  }
  if (vevents.some((v) => String(v.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED')) {
    throw new UserError('The event (or an occurrence) is cancelled. Nothing was imported.');
  }
  if (vevents.filter((v) => !v.hasProperty('recurrence-id')).length > 1) {
    throw new UserError('The calendar file contains the same event twice. Nothing was imported.');
  }
  if (vevents.some((v) => !v.hasProperty('dtstart'))) throw new UserError('An event in the file has no start time. Nothing was imported.');

  const notes = new Set<string>();
  const uid = randomUUID().toUpperCase();
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.addPropertyWithValue('version', '2.0');
  root.addPropertyWithValue('prodid', PRODID);
  root.addPropertyWithValue('calscale', 'GREGORIAN');
  const now = ICAL.Time.fromJSDate(new Date(), true);
  const organizer = personOf(master.getFirstProperty('organizer'));
  let attendees = 0;
  let lostAlarms = 0;

  for (const v of vevents) {
    attendees += v.getAllProperties('attendee').length;
    const ev = new ICAL.Event(v);
    const isMaster = v === master;
    const out = new ICAL.Component('vevent');
    out.addPropertyWithValue('uid', uid);
    // Remembers which invitation this event came from, so importing the same invitation again finds it instead of creating a second event.
    if (isMaster && [...uids][0]) out.addPropertyWithValue('x-iclaude-source-uid', [...uids][0]!);
    out.addPropertyWithValue('dtstamp', now);
    out.addPropertyWithValue('created', now);
    out.addPropertyWithValue('last-modified', now);
    out.addPropertyWithValue('sequence', 0);
    const title = String(v.getFirstPropertyValue('summary') ?? '').trim() || String(master.getFirstPropertyValue('summary') ?? '').trim() || '(no title)';
    out.addPropertyWithValue('summary', clip(title, 300));

    const startTz = v.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
    const start = mapTime(ev.startDate, startTz, zone, notes);
    out.addProperty(timeProp('dtstart', start, root));
    const endProp = v.getFirstProperty('dtend');
    const endTz = (endProp?.getParameter('tzid') as string | undefined) ?? startTz;
    const endTime = ev.endDate;
    if (endProp || v.hasProperty('duration')) {
      let end = mapTime(endTime, endTz, zone, notes);
      // keep both ends in the same kind of zone as the start
      if (start.kind === 'tz' && end.kind === 'utc') end = { kind: 'tz', tzid: start.tzid, f: fieldsInZone(endTime, start.tzid) };
      out.addProperty(timeProp('dtend', end, root));
    }
    const rid = v.getFirstProperty('recurrence-id');
    if (rid) {
      const t = rid.getFirstValue() as ICAL.Time;
      out.addProperty(timeProp('recurrence-id', mapTime(t, (rid.getParameter('tzid') as string | undefined) ?? startTz, zone, notes), root));
    }

    const location = String(v.getFirstPropertyValue('location') ?? '').trim();
    if (location) out.addPropertyWithValue('location', clip(location, 300));
    let description = String(v.getFirstPropertyValue('description') ?? '').trim();
    const url = String(v.getFirstPropertyValue('url') ?? '').trim();
    if (isMaster) {
      if (url && !description.includes(url) && !location.includes(url)) description = [description, `Link: ${url}`].filter(Boolean).join('\n\n');
      if (organizer) {
        const who = [organizer.name, organizer.email ? `<${organizer.email}>` : ''].filter(Boolean).join(' ');
        description = [description, `Organizer: ${who}`].filter(Boolean).join('\n\n');
      }
    }
    if (description) out.addPropertyWithValue('description', clip(description, 5000));

    const status = String(v.getFirstPropertyValue('status') ?? '').toUpperCase();
    if (status === 'TENTATIVE' || status === 'CONFIRMED') out.addPropertyWithValue('status', status);
    const transp = String(v.getFirstPropertyValue('transp') ?? '').toUpperCase();
    out.addPropertyWithValue('transp', transp === 'TRANSPARENT' ? 'TRANSPARENT' : 'OPAQUE');

    if (isMaster) {
      for (const p of v.getAllProperties('rrule')) out.addPropertyWithValue('rrule', ICAL.Recur.fromString(String(p.getFirstValue())));
      for (const name of ['exdate', 'rdate'] as const) {
        for (const p of v.getAllProperties(name)) {
          const tz = (p.getParameter('tzid') as string | undefined) ?? startTz;
          for (const value of p.getValues()) {
            if (!(value instanceof ICAL.Time)) {
              notes.add('A date with a period (RDATE) was not taken over.');
              continue;
            }
            out.addProperty(timeProp(name, mapTime(value, tz, zone, notes), root));
          }
        }
      }
    }

    const total = v.getAllSubcomponents('valarm').length;
    const minutes = alarmMinutes(v).slice(0, 5);
    lostAlarms += total - minutes.length;
    for (const m of minutes) {
      const alarm = new ICAL.Component('valarm');
      alarm.addPropertyWithValue('action', 'DISPLAY');
      alarm.addPropertyWithValue('description', clip(title, 100));
      alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-m * 60));
      out.addSubcomponent(alarm);
    }
    root.addSubcomponent(out);
  }
  if (lostAlarms > 0) notes.add(`${lostAlarms} reminder(s) with a fixed time or another form were not taken over.`);
  if (attendees > 0) notes.add(`The ${attendees} invited participant(s) are not part of the new event. No reply is sent to the organizer.`);

  const out = root.toString();
  assertSafeOutput(out, { attendees: 0 });
  if (/^(ATTENDEE|ORGANIZER|METHOD)\b/m.test(out)) throw new UserError('Internal safeguard: the result would contain attendees, organizer or method. Aborted, nothing was written.');
  return { uid, ics: out, notes: [...notes], attendeesDropped: attendees, ...(organizer ? { organizer } : {}), events: vevents.length };
}

/** Wall-clock fields of a (UTC) time in the given zone. */
function fieldsInZone(t: ICAL.Time, tzid: string): Fields {
  const dt = DateTime.fromMillis(t.toUnixTime() * 1000, { zone: tzid });
  return { year: dt.year, month: dt.month, day: dt.day, hour: dt.hour, minute: dt.minute, second: dt.second };
}

export interface ImportInput {
  /** ID of the mail. */
  id: string;
  /** attachment_id of the .ics attachment. */
  attachmentId: string;
  /** Name of a private calendar; default: the default calendar. */
  calendar?: string | undefined;
}

export interface ImportResult {
  created: boolean;
  /** An event with the same UID exists already (nothing was created). */
  existing?: Array<{ calendar: string; shared: boolean; id: string; title: string; start: string }>;
  event?: EventView;
  calendar?: string;
  /** What the invitation contained and what was left out. */
  invitation: { title: string; organizer?: { name?: string; email?: string }; attendeesDropped: number; events: number };
  notes: string[];
}

const TEXT_TYPES = /^(text\/calendar|application\/ics|application\/octet-stream|text\/plain)$/i;

/** Imports an invitation from a mail as an event of the user's own. Sends nothing, no reply to the organizer. */
export class InvitationImportService {
  constructor(
    private readonly cfg: Config,
    private readonly mail: MailReader,
    private readonly store: CalendarStore,
  ) {}

  async import(a: ImportInput): Promise<ImportResult> {
    const zone = this.cfg.timezone;
    const { data, info, charset } = await this.mail.fetchPart(decodeRef(a.id), a.attachmentId.trim(), MAX_ICS_BYTES);
    const text = new TextDecoder((charset || 'utf-8').toLowerCase()).decode(data.subarray(data[0] === 0xef && data[1] === 0xbb ? 3 : 0));
    const looksLikeCalendar = /^\s*BEGIN:VCALENDAR/i.test(text);
    if (!looksLikeCalendar || !(TEXT_TYPES.test(info.contentType) || /\.ics$/i.test(info.filename))) {
      throw new UserError('This attachment is not a calendar invitation (.ics). Nothing was imported.');
    }
    const plan = planImport(text, zone);
    const first = summaryOf(plan.ics, zone);

    // Permissions first: a private calendar of the user (never a shared one).
    const calendars = await this.store.listCalendars();
    const grant = authorizeCreate({ calendars, calendar: a.calendar, defaultCalendar: this.cfg.defaultCalendar });

    // Does an event with the UID of the invitation exist already (iCloud sometimes adds invitations to the iCloud address by itself)?
    const sourceUid = String(new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent('vevent')?.getFirstPropertyValue('uid') ?? '');
    const existing = await this.findExisting(calendars, sourceUid, first.startMs);
    if (existing.length) {
      return {
        created: false,
        existing,
        invitation: { title: first.title, ...(plan.organizer ? { organizer: plan.organizer } : {}), attendeesDropped: plan.attendeesDropped, events: plan.events },
        notes: ['An event with the same UID already exists, so nothing was created.'],
      };
    }

    const saved = await this.store.createObject(grant, `${plan.uid}.ics`, plan.ics);
    const r = expandObject(saved, grant.calendar, { zone, rangeStartMs: first.startMs, rangeEndMs: Math.max(first.endMs, first.startMs + 1) });
    const hit = r.events.find((e) => !e.occurrenceStart || e.occurrenceStart === isoIn(first.startMs, zone)) ?? r.events[0];
    return {
      created: true,
      calendar: grant.calendar.name,
      ...(hit ? { event: toView(hit) } : {}),
      invitation: { title: first.title, ...(plan.organizer ? { organizer: plan.organizer } : {}), attendeesDropped: plan.attendeesDropped, events: plan.events },
      notes: plan.notes,
    };
  }

  /** Looks for the UID of the invitation (or of an earlier import of it) in a window around the start of the event in every event calendar (the time-range query returns whole series). */
  private async findExisting(calendars: CalendarInfo[], uid: string, startMs: number) {
    if (!uid) return [];
    const found: NonNullable<ImportResult['existing']> = [];
    const from = DateTime.fromMillis(startMs - 2 * 86_400_000).toUTC().toISO()!;
    const to = DateTime.fromMillis(startMs + 3 * 86_400_000).toUTC().toISO()!;
    for (const cal of calendars.filter((c) => c.kind === 'events')) {
      let objects: RawObject[];
      try {
        objects = (await this.store.fetchObjects(cal, from, to)).objects;
      } catch {
        continue; // a calendar that cannot be queried must not stop the import; the UID check is best effort for it
      }
      for (const o of objects) {
        const uids = [...o.data.replace(/\r?\n[ \t]/g, '').matchAll(/^(?:UID|X-ICLAUDE-SOURCE-UID):(.*)$/gm)].map((m) => m[1]!.trim());
        if (!uids.includes(uid)) continue;
        const ex = expandObject(o, cal, { zone: this.cfg.timezone, rangeStartMs: startMs - 2 * 86_400_000, rangeEndMs: startMs + 3 * 86_400_000 }).events[0];
        found.push({ calendar: cal.name, shared: cal.shared, id: new URL(o.url, 'https://x').pathname, title: ex?.title ?? '(event)', start: ex?.start ?? '' });
      }
    }
    return found;
  }
}

/** Title and times of the first event of a planned import (for lookups and the read-back). */
function summaryOf(ics: string, zone: string): { title: string; startMs: number; endMs: number } {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerTimezones(root);
  const v = root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'))!;
  const ev = new ICAL.Event(v);
  const tzid = v.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
  const startMs = toMs(ev.startDate, tzid, zone);
  let endMs = toMs(ev.endDate, tzid, zone);
  if (endMs <= startMs) endMs = ev.startDate.isDate ? DateTime.fromMillis(startMs, { zone }).plus({ days: 1 }).toMillis() : startMs + 1;
  return { title: String(v.getFirstPropertyValue('summary') ?? ''), startMs, endMs };
}
