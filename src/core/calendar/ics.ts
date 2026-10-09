import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { UserError } from '../errors.js';
import type { EventFacts } from '../permissions.js';
import { registerTimezones, toMs } from './events.js';
import { isoIn } from '../time.js';

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RecurrenceInput {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval?: number | undefined;
  count?: number | undefined;
  /** Last day of the series (date). */
  until?: string | undefined;
  weekdays?: Weekday[] | undefined;
}

export interface NewEvent {
  title: string;
  start: DateTime;
  /** End (for all-day: last day, inclusive). */
  end: DateTime;
  allDay: boolean;
  zone: string;
  location?: string | undefined;
  notes?: string | undefined;
  alertsMinutes?: number[] | undefined;
  recurrence?: RecurrenceInput | undefined;
}

export interface EventPatch {
  title?: string | undefined;
  location?: string | undefined;
  notes?: string | undefined;
  /** New times; if one of the two is missing, the duration or the other value is kept. */
  time?: { start: DateTime; end: DateTime; allDay: boolean } | undefined;
  alertsMinutes?: number[] | undefined;
  zone: string;
}

const PRODID = '-//icloud-mcp//local connector//EN';

const BERLIN_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

const offsetText = (minutes: number) => {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
};

/** Time zone definition for an IANA zone: template for Berlin, otherwise generated from the actual transitions. */
export function vtimezoneFor(zone: string): ICAL.Component {
  if (zone === 'Europe/Berlin') return new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${BERLIN_VTIMEZONE}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone')!;
  const year = DateTime.now().year;
  const parts: string[] = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  let prev = DateTime.fromObject({ year: year - 1, month: 1, day: 1 }, { zone: 'utc' }).setZone(zone);
  const base = prev.offset;
  let sawTransition = false;
  for (let d = prev.plus({ hours: 12 }); d.year <= year + 10; d = d.plus({ hours: 12 })) {
    if (d.offset !== prev.offset) {
      sawTransition = true;
      // Wall-clock time immediately before the transition (in the old offset)
      const wall = DateTime.fromMillis(d.toMillis() - 12 * 3600_000, { zone }).plus({ hours: 12 });
      const isDst = d.isInDST;
      const kind = isDst ? 'DAYLIGHT' : 'STANDARD';
      parts.push(
        `BEGIN:${kind}`,
        `TZOFFSETFROM:${offsetText(prev.offset)}`,
        `TZOFFSETTO:${offsetText(d.offset)}`,
        `TZNAME:${d.offsetNameShort ?? kind}`,
        `DTSTART:${wall.toFormat("yyyyMMdd'T'HHmmss")}`,
        `END:${kind}`,
      );
    }
    prev = d;
  }
  if (!sawTransition) {
    parts.push('BEGIN:STANDARD', `TZOFFSETFROM:${offsetText(base)}`, `TZOFFSETTO:${offsetText(base)}`, 'DTSTART:19700101T000000', 'END:STANDARD');
  }
  parts.push('END:VTIMEZONE');
  return new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${parts.join('\r\n')}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone')!;
}

function ensureTimezone(root: ICAL.Component, zone: string): void {
  if (zone === 'UTC') return;
  const has = root.getAllSubcomponents('vtimezone').some((z) => z.getFirstPropertyValue('tzid') === zone);
  if (!has) root.addSubcomponent(vtimezoneFor(zone));
}

function dateProp(name: string, dt: DateTime, allDay: boolean, zone: string): ICAL.Property {
  const prop = new ICAL.Property(name);
  if (allDay) {
    prop.setValue(ICAL.Time.fromData({ year: dt.year, month: dt.month, day: dt.day, isDate: true }));
  } else if (zone === 'UTC') {
    prop.setValue(ICAL.Time.fromData({ year: dt.year, month: dt.month, day: dt.day, hour: dt.hour, minute: dt.minute, second: dt.second }, ICAL.Timezone.utcTimezone));
  } else {
    prop.setValue(ICAL.Time.fromData({ year: dt.year, month: dt.month, day: dt.day, hour: dt.hour, minute: dt.minute, second: dt.second }));
    prop.setParameter('tzid', zone);
  }
  return prop;
}

function setText(comp: ICAL.Component, name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value === '') comp.removeProperty(name);
  else comp.updatePropertyWithValue(name, value);
}

function setAlarms(vevent: ICAL.Component, minutes: number[], title: string): void {
  for (const a of vevent.getAllSubcomponents('valarm')) vevent.removeSubcomponent(a);
  for (const m of [...new Set(minutes)]) {
    const alarm = new ICAL.Component('valarm');
    alarm.addPropertyWithValue('action', 'DISPLAY');
    alarm.addPropertyWithValue('description', title || 'Reminder');
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-m * 60));
    vevent.addSubcomponent(alarm);
  }
}

function buildRecurrence(r: RecurrenceInput, ev: NewEvent): ICAL.Recur {
  if (r.count !== undefined && r.until !== undefined) throw new UserError('Recurrence: specify either count or until, not both.');
  const data: Record<string, unknown> = { freq: r.frequency, interval: r.interval ?? 1 };
  if (r.count !== undefined) data.count = r.count;
  if (r.until !== undefined) {
    const d = DateTime.fromISO(r.until, { zone: ev.zone });
    if (!d.isValid) throw new UserError(`Recurrence: until "${r.until}" is invalid. Expected: YYYY-MM-DD.`);
    if (d.endOf('day') < ev.start) throw new UserError('Recurrence: until is before the start of the event.');
    data.until = ev.allDay
      ? ICAL.Time.fromData({ year: d.year, month: d.month, day: d.day, isDate: true })
      : ICAL.Time.fromJSDate(d.endOf('day').toJSDate(), true);
  }
  if (r.weekdays?.length) {
    if (r.frequency !== 'WEEKLY') throw new UserError('Recurrence: weekdays is only allowed with frequency=WEEKLY.');
    data.parts = { BYDAY: r.weekdays };
  }
  return ICAL.Recur.fromData(data);
}

/** Builds the .ics file for a new event. Never sets attendees or organizer. */
export function buildEventIcs(ev: NewEvent): { uid: string; ics: string } {
  const uid = randomUUID().toUpperCase();
  const root = new ICAL.Component(['vcalendar', [], []]);
  root.addPropertyWithValue('version', '2.0');
  root.addPropertyWithValue('prodid', PRODID);
  root.addPropertyWithValue('calscale', 'GREGORIAN');
  if (!ev.allDay) ensureTimezone(root, ev.zone);

  const v = new ICAL.Component('vevent');
  const now = ICAL.Time.fromJSDate(new Date(), true);
  v.addPropertyWithValue('uid', uid);
  v.addPropertyWithValue('dtstamp', now);
  v.addPropertyWithValue('created', now);
  v.addPropertyWithValue('last-modified', now);
  v.addPropertyWithValue('sequence', 0);
  v.addPropertyWithValue('summary', ev.title);
  v.addProperty(dateProp('dtstart', ev.start, ev.allDay, ev.zone));
  // All-day: DTEND is exclusive.
  v.addProperty(dateProp('dtend', ev.allDay ? ev.end.plus({ days: 1 }) : ev.end, ev.allDay, ev.zone));
  setText(v, 'location', ev.location);
  setText(v, 'description', ev.notes);
  v.addPropertyWithValue('transp', 'OPAQUE');
  if (ev.recurrence) v.addPropertyWithValue('rrule', buildRecurrence(ev.recurrence, ev));
  if (ev.alertsMinutes?.length) setAlarms(v, ev.alertsMinutes, ev.title);
  root.addSubcomponent(v);

  const ics = root.toString();
  assertSafeOutput(ics, { attendees: 0 });
  return { uid, ics };
}

function parse(ics: string): ICAL.Component {
  try {
    return new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new UserError('The event could not be read (invalid iCalendar format). Please check the event in Apple Calendar.');
  }
}

function masterOf(root: ICAL.Component): ICAL.Component | undefined {
  return root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'));
}

/** Properties of the existing event for the permission check. */
export function analyzeEvent(ics: string): EventFacts & { uid: string; allDay: boolean } {
  const root = parse(ics);
  const events = root.getAllSubcomponents('vevent');
  const master = masterOf(root);
  const organizer = events
    .map((c) => c.getFirstPropertyValue('organizer'))
    .find((o) => o)
    ?.toString()
    .replace(/^mailto:/i, '');
  return {
    hasMaster: Boolean(master),
    hasAttendees: events.some((c) => c.hasProperty('attendee')),
    organizer,
    recurring: Boolean(master && (master.hasProperty('rrule') || master.hasProperty('rdate'))),
    hasExceptions: events.some((c) => c.hasProperty('recurrence-id')) || Boolean(master?.hasProperty('exdate')),
    uid: String(master?.getFirstPropertyValue('uid') ?? ''),
    allDay: Boolean((master?.getFirstPropertyValue('dtstart') as ICAL.Time | null)?.isDate),
  };
}

/** Existing times in milliseconds (for "move only the start, keep the duration"). */
export function currentTimes(ics: string, zone: string): { startMs: number; endMs: number; allDay: boolean } {
  const master = masterOf(parse(ics));
  if (!master) throw new UserError('No master event found. Please check the event in Apple Calendar.');
  const ev = new ICAL.Event(master);
  const tzid = master.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
  const allDay = ev.startDate.isDate;
  const startMs = toMs(ev.startDate, tzid, zone);
  let endMs = toMs(ev.endDate, tzid, zone);
  if (endMs <= startMs) endMs = allDay ? DateTime.fromMillis(startMs, { zone }).plus({ days: 1 }).toMillis() : startMs + 3600_000;
  return { startMs, endMs, allDay };
}

/** A deleted event in the form create_event understands. */
export interface RestorableEvent {
  title: string;
  /** With time "2026-10-20T14:00:00+02:00"; for all-day only the date. */
  start: string;
  /** For all-day the LAST day (inclusive), as create_event expects it. */
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  alertsMinutesBefore?: number[];
  /** Recurrence in the create_event format (only if the rule can be fully represented). */
  recurrence?: { frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval?: number; count?: number; until?: string; weekdays?: Weekday[] };
  /** The original recurrence rule (RRULE) as plain text, if present. */
  recurrenceRule?: string;
  /** What cannot be fully restored with create_event (the .ics backup helps then). */
  restoreHints: string[];
}

const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const asArray = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

function recurrenceOf(master: ICAL.Component, start: DateTime, zone: string, hints: string[]): { recurrence?: RestorableEvent['recurrence']; rule?: string } {
  const prop = master.getFirstProperty('rrule');
  if (!prop) return {};
  const recur = prop.getFirstValue() as ICAL.Recur;
  const rule = recur.toString();
  const freq = String(recur.freq ?? '');
  if (!(FREQS as readonly string[]).includes(freq)) {
    hints.push('The recurrence rule cannot be represented with create_event (see recurrenceRule and the .ics backup).');
    return { rule };
  }
  // Any BY… part that does not just match the event start (the normal case for create_event) makes the rule unrepresentable.
  let representable = true;
  let weekdays: Weekday[] | undefined;
  for (const [name, raw] of Object.entries(recur.parts ?? {})) {
    const values = asArray(raw as unknown as string | number | Array<string | number>);
    const key = name.toUpperCase();
    const only = (n: number) => values.length === 1 && Number(values[0]) === n;
    if (key === 'BYDAY' && freq === 'WEEKLY' && values.every((v) => (WEEKDAYS as readonly string[]).includes(String(v)))) weekdays = values.map(String) as Weekday[];
    else if (key === 'BYMONTHDAY' && (freq === 'MONTHLY' || freq === 'YEARLY') && only(start.day)) continue;
    else if (key === 'BYMONTH' && freq === 'YEARLY' && only(start.month)) continue;
    else representable = false;
  }
  if (!representable) {
    hints.push('The recurrence rule has special parts that create_event does not support (see recurrenceRule and the .ics backup).');
    return { rule };
  }
  let until: string | undefined;
  if (recur.until) {
    const u = recur.until;
    until = u.isDate ? `${String(u.year).padStart(4, '0')}-${String(u.month).padStart(2, '0')}-${String(u.day).padStart(2, '0')}` : DateTime.fromMillis(u.toUnixTime() * 1000, { zone }).toISODate() ?? undefined;
  }
  const out: NonNullable<RestorableEvent['recurrence']> = {
    frequency: freq as (typeof FREQS)[number],
    ...(recur.interval && recur.interval > 1 ? { interval: recur.interval } : {}),
    ...(recur.count ? { count: recur.count } : {}),
    ...(until ? { until } : {}),
    ...(weekdays?.length ? { weekdays } : {}),
  };
  return { recurrence: out, rule };
}

/** Describes an event (about to be deleted) so that it can be re-created with create_event. Hints name what would be lost. */
export function describeEvent(ics: string, zone: string): RestorableEvent {
  const root = parse(ics);
  const master = masterOf(root);
  if (!master) throw new UserError('No master event found. Please check the event in Apple Calendar.');
  const t = currentTimes(ics, zone);
  const hints: string[] = [];
  const startDt = DateTime.fromMillis(t.startMs, { zone });
  const title = String(master.getFirstPropertyValue('summary') ?? '').trim() || '(no title)';
  const location = String(master.getFirstPropertyValue('location') ?? '').trim();
  const notes = String(master.getFirstPropertyValue('description') ?? '').trim();

  const alerts: number[] = [];
  let lost = 0;
  for (const alarm of master.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstProperty('trigger');
    const value = trigger?.getFirstValue();
    const related = String(trigger?.getParameter('related') ?? 'START').toUpperCase();
    if (value instanceof ICAL.Duration && related === 'START') {
      const secs = value.toSeconds();
      const minutes = Math.round(-secs / 60);
      if (secs <= 0 && Number.isInteger(minutes) && minutes <= 40320) {
        if (!alerts.includes(minutes)) alerts.push(minutes);
        continue;
      }
    }
    lost++;
  }
  if (lost) hints.push(`${lost} reminder(s) have a form that create_event does not support (e.g. a fixed time).`);
  if (alerts.length > 5) {
    hints.push('There were more than 5 reminders; create_event accepts at most 5.');
    alerts.length = 5;
  }

  const { recurrence, rule } = recurrenceOf(master, startDt, zone, hints);
  if (master.hasProperty('rdate')) hints.push('The series has additional single dates (RDATE) that create_event does not support.');
  if (master.hasProperty('exdate') || root.getAllSubcomponents('vevent').some((e) => e.hasProperty('recurrence-id'))) {
    hints.push('The series had exceptions (deleted or moved occurrences). They cannot be represented with create_event; the .ics backup contains them.');
  }
  if (title.length > 300 || location.length > 300 || notes.length > 5000) hints.push('A text is longer than create_event allows (title and location 300, notes 5000 characters). The full text is in the .ics backup.');
  if (t.allDay) {
    // End for all-day: last day, inclusive
    return {
      title,
      start: startDt.toISODate() ?? '',
      end: DateTime.fromMillis(Math.max(t.startMs, t.endMs - 1), { zone }).toISODate() ?? '',
      allDay: true,
      ...(location ? { location } : {}),
      ...(notes ? { notes } : {}),
      ...(alerts.length ? { alertsMinutesBefore: alerts } : {}),
      ...(recurrence ? { recurrence } : {}),
      ...(rule ? { recurrenceRule: rule } : {}),
      restoreHints: hints,
    };
  }
  return {
    title,
    start: isoIn(t.startMs, zone),
    end: isoIn(t.endMs, zone),
    allDay: false,
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    ...(alerts.length ? { alertsMinutesBefore: alerts } : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(rule ? { recurrenceRule: rule } : {}),
    restoreHints: hints,
  };
}

function names(c: ICAL.Component): string[] {
  return [...c.getAllProperties().map((p) => p.name), ...c.getAllSubcomponents().map((s) => `#${s.name}`)];
}

/** Title, location, notes, times and reminders on one VEVENT (the master, or an override of a single occurrence). */
function applyFields(root: ICAL.Component, target: ICAL.Component, patch: EventPatch, removable: Set<string>, zone: string = patch.zone): void {
  if (patch.title !== undefined) target.updatePropertyWithValue('summary', patch.title);
  if (patch.location !== undefined) {
    removable.add('location');
    setText(target, 'location', patch.location);
  }
  if (patch.notes !== undefined) {
    removable.add('description');
    setText(target, 'description', patch.notes);
  }
  if (patch.time) {
    const { allDay } = patch.time;
    const start = allDay ? patch.time.start : patch.time.start.setZone(zone);
    const end = allDay ? patch.time.end : patch.time.end.setZone(zone);
    if (!allDay) ensureTimezone(root, zone);
    for (const n of ['dtstart', 'dtend', 'duration']) target.removeAllProperties(n);
    target.addProperty(dateProp('dtstart', start, allDay, zone));
    target.addProperty(dateProp('dtend', allDay ? end.plus({ days: 1 }) : end, allDay, zone));
    removable.add('dtend').add('duration').add('dtstart');
  }
  if (patch.alertsMinutes) {
    setAlarms(target, patch.alertsMinutes, String(target.getFirstPropertyValue('summary') ?? ''));
    removable.add('#valarm');
  }
}

/**
 * Applies a partial change to the existing .ics. The document is edited in place,
 * so all untouched (including unknown) properties are preserved.
 */
export function applyPatch(ics: string, patch: EventPatch): string {
  const root = parse(ics);
  const master = masterOf(root);
  if (!master) throw new UserError('No master event found. Please check the event in Apple Calendar.');
  const before = names(master);
  const removable = new Set<string>();

  applyFields(root, master, patch, removable);

  const now = ICAL.Time.fromJSDate(new Date(), true);
  master.updatePropertyWithValue('dtstamp', now);
  master.updatePropertyWithValue('last-modified', now);
  const seq = Number(master.getFirstPropertyValue('sequence') ?? 0);
  master.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1);

  // Nothing except what was intended may be lost.
  const after = names(master);
  const lost = before.filter((n) => !removable.has(n) && !after.includes(n));
  if (lost.length) throw new UserError(`Internal safeguard: the change would have removed properties (${[...new Set(lost)].join(', ')}). Aborted.`);

  const out = root.toString();
  assertSafeOutput(out, { attendees: analyzeEvent(ics).hasAttendees ? -1 : 0, organizerFrom: ics });
  return out;
}

/**
 * Last safeguard before writing: no attendees, no invitation method,
 * organizer unchanged.
 */
export function assertSafeOutput(ics: string, rule: { attendees: number; organizerFrom?: string }): void {
  const root = parse(ics);
  if (root.hasProperty('method')) throw new UserError('Internal safeguard: METHOD (invitation) is not allowed. Aborted, nothing was written.');
  const events = root.getAllSubcomponents('vevent');
  if (!events.length) throw new UserError('Internal safeguard: no event in the result. Aborted, nothing was written.');
  const attendees = events.reduce((n, e) => n + e.getAllProperties('attendee').length, 0);
  if (rule.attendees >= 0 && attendees !== rule.attendees) {
    throw new UserError('Internal safeguard: the event would contain attendees. Aborted, nothing was written. Please repeat the input without attendees.');
  }
  const orgBefore = rule.organizerFrom ? analyzeEvent(rule.organizerFrom).organizer : undefined;
  const orgAfter = analyzeEvent(ics).organizer;
  if (rule.organizerFrom ? orgBefore !== orgAfter : orgAfter) {
    throw new UserError('Internal safeguard: the organizer would be changed. Aborted, nothing was written. Please make the change directly in Apple Calendar.');
  }
}

/* ------------------------------------------------------------------ */
/* Single occurrences of a series                                      */
/* ------------------------------------------------------------------ */

/** Deep copy: ical.js hands out its internal arrays, which must not be shared between components. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const MAX_OCCURRENCE_ITERATIONS = 20_000;
const OVERRIDE_SKIP = new Set(['rrule', 'rdate', 'exrule', 'exdate', 'recurrence-id', 'dtstart', 'dtend', 'duration', 'dtstamp', 'sequence', 'last-modified']);

/** The occurrence a change refers to. */
export interface LocatedOccurrence {
  /** Current start and end (of the override, if there is one). */
  startMs: number;
  endMs: number;
  allDay: boolean;
  /** The original start of the occurrence according to the rule (RECURRENCE-ID), as shown by list_events in `occurrenceStart`. */
  key: string;
  /** Original start (RECURRENCE-ID value). */
  original: ICAL.Time;
  /** TZID of the master's DTSTART, if any. */
  tzid: string | undefined;
  /** An override for this occurrence already exists. */
  hasOverride: boolean;
}

function minuteOf(ms: number) {
  return Math.floor(ms / 60_000);
}

/**
 * Finds the occurrence that starts at `occurrenceStart` (as list_events shows it: the original start of the occurrence;
 * the current start of a moved occurrence is accepted too). Refuses occurrences the rule does not produce, also deleted ones (EXDATE).
 */
export function locateOccurrence(ics: string, occurrenceStart: string, zone: string): LocatedOccurrence {
  const root = parse(ics);
  registerTimezones(root);
  const master = masterOf(root);
  if (!master || !(master.hasProperty('rrule') || master.hasProperty('rdate'))) throw new UserError('This event is not part of a recurring series.');
  const tzid = master.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
  const ev = new ICAL.Event(master);
  const isDay = /^\d{4}-\d{2}-\d{2}$/.test(occurrenceStart.trim());
  const dt = DateTime.fromISO(occurrenceStart.trim(), { zone });
  if (!dt.isValid) throw new UserError(`occurrence_start "${occurrenceStart.slice(0, 40)}" is invalid. Use the occurrenceStart exactly as list_events shows it, e.g. 2026-10-28T10:00:00+01:00 (all-day: 2026-10-28).`);
  const wantMs = dt.toMillis();
  const sameInstant = (ms: number, allDay: boolean) =>
    allDay ? DateTime.fromMillis(ms, { zone }).toISODate() === dt.toISODate() : !isDay && minuteOf(ms) === minuteOf(wantMs);
  // the same form list_events shows in occurrenceStart
  const keyOf = (ms: number) => isoIn(ms, zone);

  // 1. an existing override: matched by its RECURRENCE-ID or by its current start
  for (const o of root.getAllSubcomponents('vevent')) {
    const rid = o.getFirstPropertyValue('recurrence-id') as ICAL.Time | null;
    if (!rid) continue;
    const ridTz = (o.getFirstProperty('recurrence-id')?.getParameter('tzid') as string | undefined) ?? tzid;
    const ridMs = toMs(rid, ridTz, zone);
    const oev = new ICAL.Event(o);
    const oTz = (o.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined) ?? ridTz;
    const sMs = toMs(oev.startDate, oTz, zone);
    if (sameInstant(ridMs, rid.isDate) || sameInstant(sMs, oev.startDate.isDate)) {
      let eMs = toMs(oev.endDate, oTz, zone);
      if (eMs <= sMs) eMs = oev.startDate.isDate ? DateTime.fromMillis(sMs, { zone }).plus({ days: 1 }).toMillis() : sMs + 3_600_000;
      return { startMs: sMs, endMs: eMs, allDay: oev.startDate.isDate, key: keyOf(ridMs), original: rid.clone(), tzid: ridTz, hasOverride: true };
    }
  }

  // 2. an occurrence the rule produces
  const it = ev.iterator();
  let n = 0;
  for (let next = it.next(); next; next = it.next()) {
    if (++n > MAX_OCCURRENCE_ITERATIONS) break;
    const ms = toMs(next, tzid, zone);
    if (ms > wantMs + 2 * 86_400_000) break;
    if (!sameInstant(ms, next.isDate)) continue;
    const d = ev.getOccurrenceDetails(next);
    const sMs = toMs(d.startDate, tzid, zone);
    let eMs = toMs(d.endDate, tzid, zone);
    if (eMs <= sMs) eMs = d.startDate.isDate ? DateTime.fromMillis(sMs, { zone }).plus({ days: 1 }).toMillis() : sMs + 3_600_000;
    return { startMs: sMs, endMs: eMs, allDay: d.startDate.isDate, key: keyOf(ms), original: next.clone(), tzid, hasOverride: false };
  }
  throw new UserError(
    'The series has no occurrence starting at that time (it may have been deleted, or the time is not part of the rule). Use occurrence_start exactly as list_events shows it in occurrenceStart.',
  );
}

/**
 * Changes one occurrence of a series: writes (or updates) an override VEVENT with RECURRENCE-ID in the same resource.
 * The master and the other overrides stay exactly as they are; the override gets SEQUENCE and LAST-MODIFIED like any change.
 */
export function applyOccurrencePatch(ics: string, loc: LocatedOccurrence, patch: EventPatch): string {
  const root = parse(ics);
  registerTimezones(root);
  const master = masterOf(root);
  if (!master) throw new UserError('No master event found. Please check the event in Apple Calendar.');
  const others = root.getAllSubcomponents('vevent').filter((c) => c !== master);
  const masterBefore = JSON.stringify(master.toJSON());

  // Time zone for new times: that of the series; UTC series stay UTC; floating series use the configured zone.
  const masterStart = master.getFirstPropertyValue('dtstart') as ICAL.Time | null;
  const zone = loc.tzid && DateTime.local().setZone(loc.tzid).isValid ? loc.tzid : masterStart?.zone === ICAL.Timezone.utcTimezone ? 'UTC' : patch.zone;

  let target: ICAL.Component | undefined;
  let untouchedOverrides: string[];
  if (loc.hasOverride) {
    target = others.find((o) => {
      const rid = o.getFirstPropertyValue('recurrence-id') as ICAL.Time | null;
      return rid ? rid.compare(loc.original) === 0 : false;
    });
    if (!target) throw new UserError('The override of this occurrence could not be found. Nothing was changed.');
    untouchedOverrides = others.filter((o) => o !== target).map((o) => JSON.stringify(o.toJSON()));
  } else {
    untouchedOverrides = others.map((o) => JSON.stringify(o.toJSON()));
    const ov = new ICAL.Component('vevent');
    for (const p of master.getAllProperties()) if (!OVERRIDE_SKIP.has(p.name)) ov.addProperty(new ICAL.Property(clone(p.toJSON())));
    for (const a of master.getAllSubcomponents('valarm')) ov.addSubcomponent(new ICAL.Component(clone(a.toJSON())));
    const rid = new ICAL.Property('recurrence-id');
    rid.setValue(loc.original.clone());
    if (loc.tzid && !loc.original.isDate) rid.setParameter('tzid', loc.tzid);
    ov.addProperty(rid);
    // The override starts out with the original times of the occurrence.
    const mk = (name: string, t: ICAL.Time) => {
      const prop = new ICAL.Property(name);
      prop.setValue(t.clone());
      if (loc.tzid && !t.isDate) prop.setParameter('tzid', loc.tzid);
      return prop;
    };
    const d = new ICAL.Event(master).getOccurrenceDetails(loc.original);
    ov.addProperty(mk('dtstart', d.startDate));
    ov.addProperty(mk('dtend', d.endDate));
    ov.addPropertyWithValue('sequence', Number(master.getFirstPropertyValue('sequence') ?? 0));
    root.addSubcomponent(ov);
    target = ov;
  }

  const removable = new Set<string>();
  const before = names(target);
  applyFields(root, target, patch, removable, zone);
  const now = ICAL.Time.fromJSDate(new Date(), true);
  target.updatePropertyWithValue('dtstamp', now);
  target.updatePropertyWithValue('last-modified', now);
  const seq = Number(target.getFirstPropertyValue('sequence') ?? 0);
  target.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1);

  const lost = before.filter((n) => !removable.has(n) && !names(target!).includes(n));
  if (lost.length) throw new UserError(`Internal safeguard: the change would have removed properties (${[...new Set(lost)].join(', ')}). Aborted.`);
  // The master and the other overrides must be exactly as before.
  const masterAfter = JSON.stringify(master.toJSON());
  const othersAfter = root.getAllSubcomponents('vevent').filter((c) => c !== master && c !== target).map((o) => JSON.stringify(o.toJSON()));
  if (masterAfter !== masterBefore || JSON.stringify(othersAfter) !== JSON.stringify(untouchedOverrides)) {
    throw new UserError('Internal safeguard: the series or another occurrence would have been changed. Aborted, nothing was written.');
  }

  const out = root.toString();
  assertSafeOutput(out, { attendees: analyzeEvent(ics).hasAttendees ? -1 : 0, organizerFrom: ics });
  return out;
}

/** The same event data with a new UID (the master and all overrides of a series share it). */
export function withNewUid(ics: string, uid: string): string {
  const root = parse(ics);
  for (const v of root.getAllSubcomponents('vevent')) v.updatePropertyWithValue('uid', uid);
  return root.toString();
}
