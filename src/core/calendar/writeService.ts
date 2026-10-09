import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { authorizeCreate, authorizeDelete, authorizeUpdate } from '../permissions.js';
import { clip, sameText } from '../untrusted.js';
import type { BackupStore } from './backup.js';
import { applyPatch, analyzeEvent, buildEventIcs, currentTimes, describeEvent, type RecurrenceInput, type RestorableEvent } from './ics.js';
import { expandObject } from './events.js';
import { toView, type EventView } from './service.js';
import type { CalendarInfo, CalendarStore, RawObject } from './types.js';

const DAY_MS = 86_400_000;
const DEFAULT_DURATION_MIN = 60;

export interface CreateInput {
  title: string;
  start: string;
  end?: string | undefined;
  allDay?: boolean | undefined;
  location?: string | undefined;
  notes?: string | undefined;
  alertsMinutes?: number[] | undefined;
  recurrence?: RecurrenceInput | undefined;
  calendar?: string | undefined;
  sharedCalendar?: string | undefined;
}

export interface UpdateInput {
  id: string;
  etag?: string | undefined;
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  allDay?: boolean | undefined;
  location?: string | undefined;
  notes?: string | undefined;
  alertsMinutes?: number[] | undefined;
  sharedCalendar?: string | undefined;
  /** Nur zum klaren Ablehnen: einzelne Vorkommen werden nicht geändert. */
  occurrenceStart?: string | undefined;
}

export interface DeleteInput {
  id: string;
  /** Titel des Termins; wird gegen den geladenen Termin geprüft. */
  title: string;
  /** Startzeit des Termins (bei Serien: des ersten Termins); wird gegen den geladenen Termin geprüft. */
  start: string;
  etag?: string | undefined;
  /** Nur zum klaren Ablehnen: Termine in geteilten Kalendern werden nie gelöscht, auch nicht mit shared_calendar. */
  sharedCalendar?: string | undefined;
  /** Nur zum klaren Ablehnen: einzelne Vorkommen werden nie gelöscht. */
  occurrenceStart?: string | undefined;
}

export interface DeleteResult {
  calendar: string;
  deleted: RestorableEvent;
  backup: { file: string; path: string; folder: string };
  /** Anzahl alter Sicherungen, die dabei aufgeräumt wurden. */
  prunedBackups: number;
}

export interface WriteResult {
  event: EventView;
  calendar: string;
  shared: boolean;
  changed?: string[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Vergleichsform eines ETags: ohne W/ und ohne Anführungszeichen (Clients verlieren diese gelegentlich). */
export const normEtag = (e: string) => e.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

function parseDay(s: string, zone: string, label: string): DateTime {
  const d = DateTime.fromISO(s.trim().slice(0, 10), { zone });
  if (!d.isValid) throw new UserError(`${label} "${s}" ist ungültig. Erwartet: JJJJ-MM-TT.`);
  return d.startOf('day');
}

function parseInstant(s: string, zone: string, label: string): DateTime {
  const t = s.trim();
  if (DATE_ONLY.test(t)) throw new UserError(`${label} "${s}" enthält keine Uhrzeit. Für Termine mit Uhrzeit z. B. 2026-10-20T14:00:00 angeben, für ganztägige Termine all_day=true.`);
  const d = DateTime.fromISO(t, { zone });
  if (!d.isValid) throw new UserError(`${label} "${s}" ist ungültig. Erwartet: ISO 8601, z. B. 2026-10-20T14:00:00.`);
  return d;
}

export class CalendarWriteService {
  constructor(
    private readonly cfg: Config,
    private readonly store: CalendarStore,
    private readonly backup?: BackupStore,
  ) {}

  private get selfAddresses(): string[] {
    return [this.cfg.appleId, this.cfg.mailUser];
  }

  async createEvent(a: CreateInput): Promise<WriteResult> {
    const zone = this.cfg.timezone;
    const allDay = a.allDay ?? false;
    const title = a.title.trim();
    if (!title) throw new UserError('Der Titel darf nicht leer sein. Bitte einen Titel angeben.');

    let start: DateTime;
    let end: DateTime;
    if (allDay) {
      start = parseDay(a.start, zone, 'Start');
      end = a.end ? parseDay(a.end, zone, 'Ende') : start;
      if (end < start) throw new UserError('Das Ende darf nicht vor dem Start liegen. Bitte ein gleiches oder späteres Ende angeben.');
    } else {
      start = parseInstant(a.start, zone, 'Start');
      end = a.end ? parseInstant(a.end, zone, 'Ende') : start.plus({ minutes: DEFAULT_DURATION_MIN });
      if (end <= start) throw new UserError('Das Ende muss nach dem Start liegen. Bitte ein späteres Ende angeben.');
    }

    // Rechte zuerst: ohne Freigabe wird weder gebaut noch geschrieben.
    const calendars = await this.store.listCalendars();
    const grant = authorizeCreate({ calendars, calendar: a.calendar, sharedCalendar: a.sharedCalendar, defaultCalendar: this.cfg.defaultCalendar });

    const { uid, ics } = buildEventIcs({
      title,
      start,
      end,
      allDay,
      zone,
      location: a.location?.trim() || undefined,
      notes: a.notes?.trim() || undefined,
      alertsMinutes: a.alertsMinutes,
      recurrence: a.recurrence,
    });
    const saved = await this.store.createObject(grant, `${uid}.ics`, ics);
    return { event: this.firstView(saved, grant.calendar, start.toMillis(), end.toMillis()), calendar: grant.calendar.name, shared: grant.calendar.shared };
  }

  async updateEvent(a: UpdateInput): Promise<WriteResult> {
    const zone = this.cfg.timezone;
    const touchesTime = a.start !== undefined || a.end !== undefined || a.allDay !== undefined;
    const touchesAny = touchesTime || a.title !== undefined || a.location !== undefined || a.notes !== undefined || a.alertsMinutes !== undefined;
    if (!touchesAny) throw new UserError('Keine Änderung angegeben. Bitte mindestens eines von title, start, end, all_day, location, notes oder alerts_minutes_before angeben.');
    if (a.title !== undefined && !a.title.trim()) throw new UserError('Der Titel darf nicht leer sein. Bitte einen Titel angeben.');

    const { calendar, url } = await this.locate(a.id);
    const current = await this.store.getObject(calendar, url);
    if (!current) throw new UserError('Termin nicht gefunden. Er wurde möglicherweise gelöscht oder verschoben.');
    const facts = analyzeEvent(current.data);

    const grant = authorizeUpdate({
      calendar,
      facts,
      selfAddresses: this.selfAddresses,
      sharedCalendar: a.sharedCalendar,
      occurrenceStart: a.occurrenceStart,
      touchesTime,
    });

    if (!current.etag) throw new UserError('Der Server liefert keinen ETag zu diesem Termin, daher wird aus Sicherheitsgründen nicht geschrieben. Bitte später erneut versuchen oder den Termin in Apple Kalender ändern.');
    if (a.etag && normEtag(a.etag) !== normEtag(current.etag)) {
      throw new UserError('Der Termin wurde seit dem Abruf geändert. Bitte den Termin neu laden (list_events) und die Änderung erneut vornehmen.');
    }

    let time: { start: DateTime; end: DateTime; allDay: boolean } | undefined;
    if (touchesTime) time = this.resolveTime(a, currentTimes(current.data, zone), zone);

    const data = applyPatch(current.data, {
      title: a.title?.trim(),
      location: a.location?.trim(),
      notes: a.notes?.trim(),
      time,
      alertsMinutes: a.alertsMinutes,
      zone,
    });
    const saved = await this.store.updateObject(grant, { url, etag: current.etag, data });

    const t = currentTimes(saved.data, zone);
    const changed = [
      ...(a.title !== undefined ? ['title'] : []),
      ...(touchesTime ? ['time'] : []),
      ...(a.location !== undefined ? ['location'] : []),
      ...(a.notes !== undefined ? ['notes'] : []),
      ...(a.alertsMinutes !== undefined ? ['alerts'] : []),
    ];
    return { event: this.firstView(saved, calendar, t.startMs, t.endMs), calendar: calendar.name, shared: calendar.shared, changed };
  }

  /** Kalender und Adresse des Termins aus der ID (nur Pfade innerhalb bekannter Kalender). */
  private async locate(id: string): Promise<{ calendar: CalendarInfo; url: string }> {
    if (!/^\/[^?#\s]*\.ics$/.test(id) || id.includes('..')) {
      throw new UserError('Ungültige Termin-ID. Die ID aus list_events oder search_events unverändert verwenden.');
    }
    const calendars = await this.store.listCalendars();
    const parent = id.slice(0, id.lastIndexOf('/') + 1);
    const calendar = calendars.find((c) => (c.id.endsWith('/') ? c.id : `${c.id}/`) === parent);
    if (!calendar) throw new UserError('Die Termin-ID gehört zu keinem bekannten Kalender. Bitte die ID mit list_events oder search_events neu abrufen.');
    return { calendar, url: new URL(id, calendar.url).href };
  }

  /**
   * Löscht einen eigenen Termin. Reihenfolge:
   *  1. Rechte (kein geteilter Kalender, keine Teilnehmer, kein fremder Organisator, nur ganze Serien),
   *  2. Titel und Startzeit gegen den per GET geladenen Termin prüfen,
   *  3. Sicherung als .ics anlegen (schlägt sie fehl, wird nicht gelöscht),
   *  4. DELETE mit If-Match auf den ETag,
   *  5. alte Sicherungen aufräumen.
   */
  async deleteEvent(a: DeleteInput): Promise<DeleteResult> {
    const zone = this.cfg.timezone;
    if (!this.backup) throw new UserError('Löschen ist nicht eingerichtet (kein Sicherungsordner). Es wurde nichts gelöscht.');
    if (!a.title.trim()) throw new UserError('Der Titel darf nicht leer sein. Bitte den Titel des Termins angeben, wie er angezeigt wird.');

    const { calendar, url } = await this.locate(a.id);
    const current = await this.store.getObject(calendar, url);
    if (!current) throw new UserError('Termin nicht gefunden. Er wurde möglicherweise schon gelöscht oder verschoben.');
    const facts = analyzeEvent(current.data);

    const grant = authorizeDelete({
      calendar,
      facts,
      selfAddresses: this.selfAddresses,
      sharedCalendar: a.sharedCalendar,
      occurrenceStart: a.occurrenceStart,
    });

    if (!current.etag) throw new UserError('Der Server liefert keinen ETag zu diesem Termin, daher wird aus Sicherheitsgründen nicht gelöscht. Bitte später erneut versuchen oder den Termin in Apple Kalender löschen.');
    if (a.etag && normEtag(a.etag) !== normEtag(current.etag)) {
      throw new UserError('Der Termin wurde seit dem Abruf geändert. Es wurde nichts gelöscht. Bitte den Termin neu laden (list_events) und das Löschen erneut anfordern.');
    }

    // Titel und Startzeit müssen zum geladenen Termin passen, damit der Freigabedialog lesbare, zutreffende Angaben zeigt.
    const restore = describeEvent(current.data, zone);
    const cur = currentTimes(current.data, zone);
    if (!sameText(a.title, restore.title)) {
      throw new UserError('Der Titel passt nicht zum Termin mit dieser ID. Es wurde nichts gelöscht. Den Termin mit list_events oder search_events neu abrufen und Titel und Startzeit unverändert übernehmen.');
    }
    if (!this.startMatches(a.start, cur, zone)) {
      const hint = facts.recurring ? ' Bei einer Terminserie ist der Start der des ERSTEN Termins der Serie' : '';
      throw new UserError(`Die Startzeit passt nicht zum Termin mit dieser ID (Start laut Kalender: ${restore.start}).${hint} Es wurde nichts gelöscht.`);
    }

    // Erst sichern, dann löschen. Schlägt die Sicherung fehl, wird nicht gelöscht.
    const saved = await this.backup.save(restore.title, current.data);
    try {
      await this.store.deleteObject(grant, { url, etag: current.etag });
    } catch (e) {
      await this.backup.discard(saved);
      throw e;
    }
    const prunedBackups = await this.backup.prune();
    return { calendar: calendar.name, deleted: restore, backup: { file: saved.file, path: saved.path, folder: this.backup.dir }, prunedBackups };
  }

  /** Gleicher Beginn: bei ganztägig derselbe Tag, sonst dieselbe Minute. */
  private startMatches(expected: string, cur: { startMs: number; allDay: boolean }, zone: string): boolean {
    const s = expected.trim();
    if (cur.allDay) {
      const day = DateTime.fromISO(s.slice(0, 10), { zone });
      if (!DATE_ONLY.test(s.slice(0, 10)) || !day.isValid) throw new UserError(`Start "${clip(s, 40)}" ist ungültig. Für diesen ganztägigen Termin das Datum JJJJ-MM-TT angeben.`);
      return day.toISODate() === DateTime.fromMillis(cur.startMs, { zone }).toISODate();
    }
    const dt = parseInstant(s, zone, 'Start');
    return Math.floor(dt.toMillis() / 60_000) === Math.floor(cur.startMs / 60_000);
  }

  /** Neue Zeiten aus Angaben und bisherigen Zeiten. Nur Start angegeben: Dauer bleibt. */
  private resolveTime(a: UpdateInput, cur: { startMs: number; endMs: number; allDay: boolean }, zone: string) {
    const allDay = a.allDay ?? cur.allDay;
    const curStart = DateTime.fromMillis(cur.startMs, { zone });
    const curEnd = DateTime.fromMillis(cur.endMs, { zone });
    if (allDay) {
      const days = cur.allDay ? Math.max(1, Math.round((cur.endMs - cur.startMs) / DAY_MS)) : 1;
      const start = a.start ? parseDay(a.start, zone, 'Start') : curStart.startOf('day');
      const end = a.end ? parseDay(a.end, zone, 'Ende') : start.plus({ days: days - 1 });
      if (end < start) throw new UserError('Das Ende darf nicht vor dem Start liegen. Bitte ein gleiches oder späteres Ende angeben.');
      return { start, end, allDay: true };
    }
    if (cur.allDay && !a.start) throw new UserError('Beim Wechsel von ganztägig zu einem Termin mit Uhrzeit bitte start mit Datum und Uhrzeit angeben.');
    const start = a.start ? parseInstant(a.start, zone, 'Start') : curStart;
    const end = a.end ? parseInstant(a.end, zone, 'Ende') : cur.allDay ? start.plus({ minutes: DEFAULT_DURATION_MIN }) : a.start ? start.plus({ milliseconds: cur.endMs - cur.startMs }) : curEnd;
    if (end <= start) throw new UserError('Das Ende muss nach dem Start liegen. Bitte ein späteres Ende angeben.');
    return { start, end, allDay: false };
  }

  private firstView(obj: RawObject, calendar: CalendarInfo, startMs: number, endMs: number): EventView {
    const r = expandObject(obj, calendar, { zone: this.cfg.timezone, rangeStartMs: startMs, rangeEndMs: Math.max(endMs, startMs + 1) });
    const first = r.events[0];
    if (!first) throw new UserError('Der Termin wurde gespeichert, konnte aber nicht erneut gelesen werden. Bitte mit list_events prüfen.');
    return toView(first);
  }
}
