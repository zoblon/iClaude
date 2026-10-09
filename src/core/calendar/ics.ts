import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { UserError } from '../errors.js';
import type { EventFacts } from '../permissions.js';
import { toMs } from './events.js';
import { isoIn } from '../time.js';

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RecurrenceInput {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval?: number | undefined;
  count?: number | undefined;
  /** Letzter Tag der Serie (Datum). */
  until?: string | undefined;
  weekdays?: Weekday[] | undefined;
}

export interface NewEvent {
  title: string;
  start: DateTime;
  /** Ende (bei ganztägig: letzter Tag, einschließlich). */
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
  /** Neue Zeiten; fehlt eines von beiden, bleibt die Dauer bzw. der andere Wert. */
  time?: { start: DateTime; end: DateTime; allDay: boolean } | undefined;
  alertsMinutes?: number[] | undefined;
  zone: string;
}

const PRODID = '-//icloud-mcp//lokaler Konnektor//DE';

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

/** Zeitzonendefinition für eine IANA-Zone: Vorlage für Berlin, sonst aus den tatsächlichen Umstellungen erzeugt. */
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
      // Wandzeit unmittelbar vor der Umstellung (in der alten Zeit)
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
    alarm.addPropertyWithValue('description', title || 'Erinnerung');
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-m * 60));
    vevent.addSubcomponent(alarm);
  }
}

function buildRecurrence(r: RecurrenceInput, ev: NewEvent): ICAL.Recur {
  if (r.count !== undefined && r.until !== undefined) throw new UserError('Wiederholung: entweder count oder until angeben, nicht beides.');
  const data: Record<string, unknown> = { freq: r.frequency, interval: r.interval ?? 1 };
  if (r.count !== undefined) data.count = r.count;
  if (r.until !== undefined) {
    const d = DateTime.fromISO(r.until, { zone: ev.zone });
    if (!d.isValid) throw new UserError(`Wiederholung: until "${r.until}" ist ungültig. Erwartet: JJJJ-MM-TT.`);
    if (d.endOf('day') < ev.start) throw new UserError('Wiederholung: until liegt vor dem Beginn des Termins.');
    data.until = ev.allDay
      ? ICAL.Time.fromData({ year: d.year, month: d.month, day: d.day, isDate: true })
      : ICAL.Time.fromJSDate(d.endOf('day').toJSDate(), true);
  }
  if (r.weekdays?.length) {
    if (r.frequency !== 'WEEKLY') throw new UserError('Wiederholung: weekdays gibt es nur bei frequency=WEEKLY.');
    data.parts = { BYDAY: r.weekdays };
  }
  return ICAL.Recur.fromData(data);
}

/** Baut die .ics-Datei für einen neuen Termin. Setzt nie Teilnehmer oder Organisator. */
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
  // Ganztägig: DTEND ist exklusiv.
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
    throw new UserError('Der Termin konnte nicht gelesen werden (ungültiges iCalendar-Format). Bitte den Termin in Apple Kalender prüfen.');
  }
}

function masterOf(root: ICAL.Component): ICAL.Component | undefined {
  return root.getAllSubcomponents('vevent').find((c) => !c.hasProperty('recurrence-id'));
}

/** Eigenschaften des bestehenden Termins für die Rechteprüfung. */
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

/** Bestehende Zeiten als Millisekunden (für "nur Start verschieben, Dauer behalten"). */
export function currentTimes(ics: string, zone: string): { startMs: number; endMs: number; allDay: boolean } {
  const master = masterOf(parse(ics));
  if (!master) throw new UserError('Kein Haupttermin gefunden. Bitte den Termin in Apple Kalender prüfen.');
  const ev = new ICAL.Event(master);
  const tzid = master.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined;
  const allDay = ev.startDate.isDate;
  const startMs = toMs(ev.startDate, tzid, zone);
  let endMs = toMs(ev.endDate, tzid, zone);
  if (endMs <= startMs) endMs = allDay ? DateTime.fromMillis(startMs, { zone }).plus({ days: 1 }).toMillis() : startMs + 3600_000;
  return { startMs, endMs, allDay };
}

/** Ein gelöschter Termin in der Form, die create_event versteht. */
export interface RestorableEvent {
  title: string;
  /** Mit Uhrzeit "2026-10-20T14:00:00+02:00"; bei ganztägig nur das Datum. */
  start: string;
  /** Bei ganztägig der LETZTE Tag (einschließlich), wie create_event ihn erwartet. */
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  alertsMinutesBefore?: number[];
  /** Wiederholung im Format von create_event (nur wenn die Regel vollständig darstellbar ist). */
  recurrence?: { frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval?: number; count?: number; until?: string; weekdays?: Weekday[] };
  /** Die ursprüngliche Wiederholungsregel (RRULE) im Klartext, falls vorhanden. */
  recurrenceRule?: string;
  /** Was sich mit create_event nicht vollständig wiederherstellen lässt (dann hilft die .ics-Sicherung). */
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
    hints.push('Die Wiederholungsregel lässt sich mit create_event nicht darstellen (siehe recurrenceRule und die .ics-Sicherung).');
    return { rule };
  }
  // Alle BY…-Teile, die nicht schon dem Beginn des Termins entsprechen (das ist bei create_event der Normalfall), machen die Regel nicht darstellbar.
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
    hints.push('Die Wiederholungsregel hat Besonderheiten, die create_event nicht kennt (siehe recurrenceRule und die .ics-Sicherung).');
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

/** Beschreibt einen (zu löschenden) Termin so, dass er mit create_event neu angelegt werden kann. Hinweise nennen, was dabei verloren ginge. */
export function describeEvent(ics: string, zone: string): RestorableEvent {
  const root = parse(ics);
  const master = masterOf(root);
  if (!master) throw new UserError('Kein Haupttermin gefunden. Bitte den Termin in Apple Kalender prüfen.');
  const t = currentTimes(ics, zone);
  const hints: string[] = [];
  const startDt = DateTime.fromMillis(t.startMs, { zone });
  const title = String(master.getFirstPropertyValue('summary') ?? '').trim() || '(ohne Titel)';
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
  if (lost) hints.push(`${lost} Erinnerung(en) haben eine Form, die create_event nicht kennt (z. B. feste Uhrzeit).`);
  if (alerts.length > 5) {
    hints.push('Es gab mehr als 5 Erinnerungen; create_event nimmt höchstens 5.');
    alerts.length = 5;
  }

  const { recurrence, rule } = recurrenceOf(master, startDt, zone, hints);
  if (master.hasProperty('rdate')) hints.push('Die Serie hat zusätzliche Einzeltermine (RDATE), die create_event nicht kennt.');
  if (master.hasProperty('exdate') || root.getAllSubcomponents('vevent').some((e) => e.hasProperty('recurrence-id'))) {
    hints.push('Die Serie hatte Ausnahmen (gelöschte oder verschobene Vorkommen). Sie lassen sich mit create_event nicht abbilden; die .ics-Sicherung enthält sie.');
  }
  if (title.length > 300 || location.length > 300 || notes.length > 5000) hints.push('Ein Text ist länger als create_event erlaubt (Titel und Ort 300, Notiz 5000 Zeichen). Der volle Text steht in der .ics-Sicherung.');
  if (t.allDay) {
    // Ende bei ganztägig: letzter Tag einschließlich
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

/**
 * Wendet eine Teiländerung auf die bestehende .ics an. Das Dokument wird in-place bearbeitet,
 * daher bleiben alle nicht angefassten (auch unbekannte) Eigenschaften erhalten.
 */
export function applyPatch(ics: string, patch: EventPatch): string {
  const root = parse(ics);
  const master = masterOf(root);
  if (!master) throw new UserError('Kein Haupttermin gefunden. Bitte den Termin in Apple Kalender prüfen.');
  const before = names(master);
  const removable = new Set<string>();

  if (patch.title !== undefined) master.updatePropertyWithValue('summary', patch.title);
  if (patch.location !== undefined) {
    removable.add('location');
    setText(master, 'location', patch.location);
  }
  if (patch.notes !== undefined) {
    removable.add('description');
    setText(master, 'description', patch.notes);
  }
  if (patch.time) {
    const { start, end, allDay } = patch.time;
    if (!allDay) ensureTimezone(root, patch.zone);
    for (const n of ['dtstart', 'dtend', 'duration']) master.removeAllProperties(n);
    master.addProperty(dateProp('dtstart', start, allDay, patch.zone));
    master.addProperty(dateProp('dtend', allDay ? end.plus({ days: 1 }) : end, allDay, patch.zone));
    removable.add('dtend').add('duration').add('dtstart');
  }
  if (patch.alertsMinutes) {
    setAlarms(master, patch.alertsMinutes, String(master.getFirstPropertyValue('summary') ?? ''));
    removable.add('#valarm');
  }

  const now = ICAL.Time.fromJSDate(new Date(), true);
  master.updatePropertyWithValue('dtstamp', now);
  master.updatePropertyWithValue('last-modified', now);
  const seq = Number(master.getFirstPropertyValue('sequence') ?? 0);
  master.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1);

  // Nichts außer dem Gewollten darf verloren gehen.
  const after = names(master);
  const lost = before.filter((n) => !removable.has(n) && !after.includes(n));
  if (lost.length) throw new UserError(`Interner Schutz: Die Änderung hätte Eigenschaften entfernt (${[...new Set(lost)].join(', ')}). Abgebrochen.`);

  const out = root.toString();
  assertSafeOutput(out, { attendees: analyzeEvent(ics).hasAttendees ? -1 : 0, organizerFrom: ics });
  return out;
}

/**
 * Letzte Sicherung vor dem Schreiben: keine Teilnehmer, keine Einladungsmethode,
 * Organisator unverändert.
 */
export function assertSafeOutput(ics: string, rule: { attendees: number; organizerFrom?: string }): void {
  const root = parse(ics);
  if (root.hasProperty('method')) throw new UserError('Interner Schutz: METHOD (Einladung) ist nicht erlaubt. Abgebrochen, es wurde nichts geschrieben.');
  const events = root.getAllSubcomponents('vevent');
  if (!events.length) throw new UserError('Interner Schutz: Kein Termin im Ergebnis. Abgebrochen, es wurde nichts geschrieben.');
  const attendees = events.reduce((n, e) => n + e.getAllProperties('attendee').length, 0);
  if (rule.attendees >= 0 && attendees !== rule.attendees) {
    throw new UserError('Interner Schutz: Der Termin enthielte Teilnehmer. Abgebrochen, es wurde nichts geschrieben. Bitte die Eingaben ohne Teilnehmer wiederholen.');
  }
  const orgBefore = rule.organizerFrom ? analyzeEvent(rule.organizerFrom).organizer : undefined;
  const orgAfter = analyzeEvent(ics).organizer;
  if (rule.organizerFrom ? orgBefore !== orgAfter : orgAfter) {
    throw new UserError('Interner Schutz: Der Organisator würde verändert. Abgebrochen, es wurde nichts geschrieben. Bitte die Änderung direkt in Apple Kalender vornehmen.');
  }
}
