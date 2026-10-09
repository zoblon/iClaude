import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { authorizeCreate, authorizeDelete, authorizeEventMove, authorizeUpdate } from '../permissions.js';
import { clip, sameText } from '../untrusted.js';
import type { BackupStore } from './backup.js';
import { applyOccurrencePatch, applyPatch, analyzeEvent, buildEventIcs, currentTimes, describeEvent, locateOccurrence, withNewUid, type RecurrenceInput, type RestorableEvent } from './ics.js';
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
  /** Start of one occurrence of a series (as list_events shows it in occurrenceStart): only that occurrence is changed. */
  occurrenceStart?: string | undefined;
  /** Name of another calendar: moves the whole event there (a step of its own, no other changes in the same call). */
  moveToCalendar?: string | undefined;
}

export interface DeleteInput {
  id: string;
  /** Title of the event; checked against the loaded event. */
  title: string;
  /** Start time of the event (for series: of the first occurrence); checked against the loaded event. */
  start: string;
  etag?: string | undefined;
  /** Only for a clear refusal: events in shared calendars are never deleted, not even with shared_calendar. */
  sharedCalendar?: string | undefined;
  /** Only for a clear refusal: single occurrences are never deleted. */
  occurrenceStart?: string | undefined;
}

export interface DeleteResult {
  calendar: string;
  deleted: RestorableEvent;
  backup: { file: string; path: string; folder: string };
  /** Number of old backups pruned in the process. */
  prunedBackups: number;
}

export interface WriteResult {
  event: EventView;
  calendar: string;
  shared: boolean;
  changed?: string[];
  /** Only for a move to another calendar. */
  moved?: {
    from: string;
    to: string;
    /** ID of the event before the move (no longer valid). */
    oldId: string;
    /** The target calendar did not accept the old UID, so the event got a new one. */
    uidChanged: boolean;
    backup: { file: string; path: string; folder: string };
    prunedBackups: number;
  };
}

/** HTTP statuses with which a server can refuse an event because of its content or a UID conflict. */
const CONTENT_REFUSALS = new Set([400, 403, 409, 412, 422]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Comparable form of an ETag: without W/ and without quotes (clients occasionally drop them). */
export const normEtag = (e: string) => e.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

function parseDay(s: string, zone: string, label: string): DateTime {
  const d = DateTime.fromISO(s.trim().slice(0, 10), { zone });
  if (!d.isValid) throw new UserError(`${label} "${s}" is invalid. Expected: YYYY-MM-DD.`);
  return d.startOf('day');
}

function parseInstant(s: string, zone: string, label: string): DateTime {
  const t = s.trim();
  if (DATE_ONLY.test(t)) throw new UserError(`${label} "${s}" has no time of day. For timed events give e.g. 2026-10-20T14:00:00; for all-day events set all_day=true.`);
  const d = DateTime.fromISO(t, { zone });
  if (!d.isValid) throw new UserError(`${label} "${s}" is invalid. Expected: ISO 8601, e.g. 2026-10-20T14:00:00.`);
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
    if (!title) throw new UserError('The title must not be empty. Please provide a title.');

    let start: DateTime;
    let end: DateTime;
    if (allDay) {
      start = parseDay(a.start, zone, 'Start');
      end = a.end ? parseDay(a.end, zone, 'End') : start;
      if (end < start) throw new UserError('The end must not be before the start. Please provide the same or a later end.');
    } else {
      start = parseInstant(a.start, zone, 'Start');
      end = a.end ? parseInstant(a.end, zone, 'End') : start.plus({ minutes: DEFAULT_DURATION_MIN });
      if (end <= start) throw new UserError('The end must be after the start. Please provide a later end.');
    }

    // Permissions first: without a grant nothing is built or written.
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
    if (a.moveToCalendar !== undefined) return this.moveEvent(a);
    const zone = this.cfg.timezone;
    const touchesTime = a.start !== undefined || a.end !== undefined || a.allDay !== undefined;
    const touchesAny = touchesTime || a.title !== undefined || a.location !== undefined || a.notes !== undefined || a.alertsMinutes !== undefined;
    if (!touchesAny) throw new UserError('No change specified. Please provide at least one of title, start, end, all_day, location, notes or alerts_minutes_before.');
    if (a.title !== undefined && !a.title.trim()) throw new UserError('The title must not be empty. Please provide a title.');

    const { calendar, url } = await this.locate(a.id);
    const current = await this.store.getObject(calendar, url);
    if (!current) throw new UserError('Event not found. It may have been deleted or moved.');
    const facts = analyzeEvent(current.data);

    const grant = authorizeUpdate({
      calendar,
      facts,
      selfAddresses: this.selfAddresses,
      sharedCalendar: a.sharedCalendar,
      occurrenceStart: a.occurrenceStart,
      touchesTime,
    });

    if (!current.etag) throw new UserError('The server returns no ETag for this event, so nothing is written for safety reasons. Please try again later or change the event in Apple Calendar.');
    if (a.etag && normEtag(a.etag) !== normEtag(current.etag)) {
      throw new UserError('The event has changed since it was fetched. Please reload the event (list_events) and make the change again.');
    }

    let time: { start: DateTime; end: DateTime; allDay: boolean } | undefined;
    const patch = { title: a.title?.trim(), location: a.location?.trim(), notes: a.notes?.trim(), alertsMinutes: a.alertsMinutes, zone };

    if (a.occurrenceStart) {
      // One occurrence of a series: an override with RECURRENCE-ID is written; the series and the other overrides stay as they are.
      const loc = locateOccurrence(current.data, a.occurrenceStart, zone);
      if (a.allDay !== undefined && a.allDay !== loc.allDay) {
        throw new UserError('A single occurrence cannot be switched between all-day and timed. Change the whole series for that.');
      }
      if (touchesTime) time = this.resolveTime(a, { startMs: loc.startMs, endMs: loc.endMs, allDay: loc.allDay }, zone);
      const data = applyOccurrencePatch(current.data, loc, { ...patch, time });
      const saved = await this.store.updateObject(grant, { url, etag: current.etag, data });
      const startMs = time ? time.start.toMillis() : loc.startMs;
      const endMs = time ? (time.allDay ? time.end.plus({ days: 1 }).toMillis() : time.end.toMillis()) : loc.endMs;
      const r = expandObject(saved, calendar, { zone, rangeStartMs: startMs, rangeEndMs: Math.max(endMs, startMs + 1) });
      const hit = r.events.find((e) => e.occurrenceStart === loc.key) ?? r.events[0];
      if (!hit) throw new UserError('The change was saved but the occurrence could not be read back. Please check with list_events.');
      return { event: toView(hit), calendar: calendar.name, shared: calendar.shared, changed: this.changedFields(a, touchesTime).concat('occurrence') };
    }

    if (touchesTime) time = this.resolveTime(a, currentTimes(current.data, zone), zone);

    const data = applyPatch(current.data, { ...patch, time });
    const saved = await this.store.updateObject(grant, { url, etag: current.etag, data });

    const t = currentTimes(saved.data, zone);
    return { event: this.firstView(saved, calendar, t.startMs, t.endMs), calendar: calendar.name, shared: calendar.shared, changed: this.changedFields(a, touchesTime) };
  }

  private changedFields(a: UpdateInput, touchesTime: boolean): string[] {
    return [
      ...(a.title !== undefined ? ['title'] : []),
      ...(touchesTime ? ['time'] : []),
      ...(a.location !== undefined ? ['location'] : []),
      ...(a.notes !== undefined ? ['notes'] : []),
      ...(a.alertsMinutes !== undefined ? ['alerts'] : []),
    ];
  }

  /**
   * Moves an event to another calendar. Order:
   *  1. permissions (not out of a shared calendar, no attendees, no foreign organizer, whole series only, shared target only when named),
   *  2. .ics backup of the event (if it fails, nothing happens),
   *  3. create in the target calendar (same UID; if the server refuses that, a new UID) and read back and compare,
   *  4. only then delete the source with If-Match on its ETag.
   * If the deletion fails, both places are reported and nothing more is done.
   */
  private async moveEvent(a: UpdateInput): Promise<WriteResult> {
    const zone = this.cfg.timezone;
    if (!this.backup) throw new UserError('Moving is not set up (no backup folder). Nothing was moved.');
    if (a.title !== undefined || a.start !== undefined || a.end !== undefined || a.allDay !== undefined || a.location !== undefined || a.notes !== undefined || a.alertsMinutes !== undefined) {
      throw new UserError('Moving an event to another calendar is a step of its own. Call update_event with move_to_calendar alone, and change title, time or other fields in a separate call.');
    }
    const target = a.moveToCalendar!.trim();
    if (!target) throw new UserError('move_to_calendar must name a calendar.');

    const { calendar, url } = await this.locate(a.id);
    const current = await this.store.getObject(calendar, url);
    if (!current) throw new UserError('Event not found. It may have been deleted or moved.');
    const facts = analyzeEvent(current.data);
    const calendars = await this.store.listCalendars();
    const grants = authorizeEventMove({ calendars, source: calendar, facts, selfAddresses: this.selfAddresses, target, sharedCalendar: a.sharedCalendar, occurrenceStart: a.occurrenceStart });

    if (!current.etag) throw new UserError('The server returns no ETag for this event, so nothing is moved for safety reasons. Please move the event in Apple Calendar.');
    if (a.etag && normEtag(a.etag) !== normEtag(current.etag)) {
      throw new UserError('The event has changed since it was fetched. Nothing was moved. Please reload the event (list_events) and try again.');
    }
    const restore = describeEvent(current.data, zone);
    if (!facts.uid) throw new UserError('The event has no UID. Nothing was moved.');

    const saved = await this.backup.save(restore.title, current.data);

    // Create the copy: same UID and file name first; a different UID only if the server refuses that.
    const base = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    const fileOk = /^[A-Za-z0-9-]{8,64}\.ics$/.test(base);
    let created: RawObject;
    let uid = facts.uid;
    let uidChanged = false;
    try {
      created = await this.store.createObject(grants.create, fileOk ? base : `${/^[A-Za-z0-9-]{8,64}$/.test(uid) ? uid : randomUUID().toUpperCase()}.ics`, current.data);
    } catch (e) {
      if (!(e instanceof UserError) || e.status === undefined || !CONTENT_REFUSALS.has(e.status)) {
        await this.backup.discard(saved);
        throw e;
      }
      uid = randomUUID().toUpperCase();
      try {
        created = await this.store.createObject(grants.create, `${uid}.ics`, withNewUid(current.data, uid));
        uidChanged = true;
      } catch (e2) {
        await this.backup.discard(saved);
        throw new UserError(`The event could not be created in "${grants.target.name}", so it was not moved and nothing was changed: ${e2 instanceof Error ? e2.message : 'unexpected error'}`);
      }
    }

    // Read back and compare before anything is deleted.
    const problem = this.copyProblem(restore, created, uid, current.data, zone);
    if (problem) {
      throw new UserError(
        `The copy in "${grants.target.name}" does not match the original (${problem}), so the original was NOT deleted. The event now exists in both "${calendar.name}" and "${grants.target.name}". Nothing else was done. Please check in Apple Calendar.`,
      );
    }

    try {
      await this.store.deleteObject(grants.delete, { url, etag: current.etag });
    } catch (e) {
      throw new UserError(
        `The event was copied to "${grants.target.name}" but could not be removed from "${calendar.name}" (${e instanceof Error ? e.message : 'unexpected error'}). It now exists in both calendars. Nothing else was done; please remove one of them in Apple Calendar. A backup is in ${saved.path}.`,
      );
    }
    const prunedBackups = await this.backup.prune();
    const t = currentTimes(created.data, zone);
    return {
      event: this.firstView(created, grants.target, t.startMs, t.endMs),
      calendar: grants.target.name,
      shared: grants.target.shared,
      changed: ['calendar'],
      moved: { from: calendar.name, to: grants.target.name, oldId: a.id, uidChanged, backup: { ...saved, folder: this.backup.dir }, prunedBackups },
    };
  }

  /** What differs between the original and the copy read back from the target calendar (undefined = identical in everything that matters). */
  private copyProblem(orig: RestorableEvent, created: RawObject, uid: string, origData: string, zone: string): string | undefined {
    try {
      const f = analyzeEvent(created.data);
      if (f.uid !== uid) return 'UID';
      if (f.hasAttendees) return 'attendees appeared';
      const a = describeEvent(created.data, zone);
      for (const k of ['title', 'start', 'end', 'allDay', 'location', 'notes', 'recurrenceRule'] as const) {
        if (JSON.stringify(a[k] ?? null) !== JSON.stringify(orig[k] ?? null)) return k;
      }
      const count = (d: string) => (d.match(/^BEGIN:VEVENT/gm) ?? []).length;
      if (count(created.data) !== count(origData)) return 'number of occurrences/overrides';
      return undefined;
    } catch {
      return 'the copy could not be read';
    }
  }

  /** Calendar and URL of the event from the ID (only paths inside known calendars). */
  private async locate(id: string): Promise<{ calendar: CalendarInfo; url: string }> {
    if (!/^\/[^?#\s]*\.ics$/.test(id) || id.includes('..')) {
      throw new UserError('Invalid event ID. Use the ID from list_events or search_events unchanged.');
    }
    const calendars = await this.store.listCalendars();
    const parent = id.slice(0, id.lastIndexOf('/') + 1);
    const calendar = calendars.find((c) => (c.id.endsWith('/') ? c.id : `${c.id}/`) === parent);
    if (!calendar) throw new UserError('The event ID does not belong to any known calendar. Please fetch the ID again with list_events or search_events.');
    return { calendar, url: new URL(id, calendar.url).href };
  }

  /**
   * Deletes one of the user's own events. Order:
   *  1. permissions (no shared calendar, no attendees, no foreign organizer, whole series only),
   *  2. check title and start time against the event loaded via GET,
   *  3. create the .ics backup (if it fails, nothing is deleted),
   *  4. DELETE with If-Match on the ETag,
   *  5. prune old backups.
   */
  async deleteEvent(a: DeleteInput): Promise<DeleteResult> {
    const zone = this.cfg.timezone;
    if (!this.backup) throw new UserError('Deleting is not set up (no backup folder). Nothing was deleted.');
    if (!a.title.trim()) throw new UserError('The title must not be empty. Please provide the title of the event as it is displayed.');

    const { calendar, url } = await this.locate(a.id);
    const current = await this.store.getObject(calendar, url);
    if (!current) throw new UserError('Event not found. It may already have been deleted or moved.');
    const facts = analyzeEvent(current.data);

    const grant = authorizeDelete({
      calendar,
      facts,
      selfAddresses: this.selfAddresses,
      sharedCalendar: a.sharedCalendar,
      occurrenceStart: a.occurrenceStart,
    });

    if (!current.etag) throw new UserError('The server returns no ETag for this event, so nothing is deleted for safety reasons. Please try again later or delete the event in Apple Calendar.');
    if (a.etag && normEtag(a.etag) !== normEtag(current.etag)) {
      throw new UserError('The event has changed since it was fetched. Nothing was deleted. Please reload the event (list_events) and request the deletion again.');
    }

    // Title and start time must match the loaded event so that the approval dialog shows readable, accurate details.
    const restore = describeEvent(current.data, zone);
    const cur = currentTimes(current.data, zone);
    if (!sameText(a.title, restore.title)) {
      throw new UserError('The title does not match the event with this ID. Nothing was deleted. Fetch the event again with list_events or search_events and copy title and start time unchanged.');
    }
    if (!this.startMatches(a.start, cur, zone)) {
      const hint = facts.recurring ? ' For a recurring series, the start is that of the FIRST occurrence of the series.' : '';
      throw new UserError(`The start time does not match the event with this ID (start according to the calendar: ${restore.start}).${hint} Nothing was deleted.`);
    }

    // Back up first, then delete. If the backup fails, nothing is deleted.
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

  /** Same start: for all-day the same day, otherwise the same minute. */
  private startMatches(expected: string, cur: { startMs: number; allDay: boolean }, zone: string): boolean {
    const s = expected.trim();
    if (cur.allDay) {
      const day = DateTime.fromISO(s.slice(0, 10), { zone });
      if (!DATE_ONLY.test(s.slice(0, 10)) || !day.isValid) throw new UserError(`Start "${clip(s, 40)}" is invalid. For this all-day event give the date as YYYY-MM-DD.`);
      return day.toISODate() === DateTime.fromMillis(cur.startMs, { zone }).toISODate();
    }
    const dt = parseInstant(s, zone, 'Start');
    return Math.floor(dt.toMillis() / 60_000) === Math.floor(cur.startMs / 60_000);
  }

  /** New times from the input and the existing times. Only start given: the duration is kept. */
  private resolveTime(a: UpdateInput, cur: { startMs: number; endMs: number; allDay: boolean }, zone: string) {
    const allDay = a.allDay ?? cur.allDay;
    const curStart = DateTime.fromMillis(cur.startMs, { zone });
    const curEnd = DateTime.fromMillis(cur.endMs, { zone });
    if (allDay) {
      const days = cur.allDay ? Math.max(1, Math.round((cur.endMs - cur.startMs) / DAY_MS)) : 1;
      const start = a.start ? parseDay(a.start, zone, 'Start') : curStart.startOf('day');
      const end = a.end ? parseDay(a.end, zone, 'End') : start.plus({ days: days - 1 });
      if (end < start) throw new UserError('The end must not be before the start. Please provide the same or a later end.');
      return { start, end, allDay: true };
    }
    if (cur.allDay && !a.start) throw new UserError('When switching from all-day to a timed event, please provide start with date and time.');
    const start = a.start ? parseInstant(a.start, zone, 'Start') : curStart;
    const end = a.end ? parseInstant(a.end, zone, 'End') : cur.allDay ? start.plus({ minutes: DEFAULT_DURATION_MIN }) : a.start ? start.plus({ milliseconds: cur.endMs - cur.startMs }) : curEnd;
    if (end <= start) throw new UserError('The end must be after the start. Please provide a later end.');
    return { start, end, allDay: false };
  }

  private firstView(obj: RawObject, calendar: CalendarInfo, startMs: number, endMs: number): EventView {
    const r = expandObject(obj, calendar, { zone: this.cfg.timezone, rangeStartMs: startMs, rangeEndMs: Math.max(endMs, startMs + 1) });
    const first = r.events[0];
    if (!first) throw new UserError('The event was saved but could not be read back. Please check with list_events.');
    return toView(first);
  }
}
