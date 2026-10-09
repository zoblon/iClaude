import type { WriteGrant } from '../permissions.js';

export interface CalendarInfo {
  /** Stable ID (path of the calendar on the server). */
  id: string;
  name: string;
  /** events = events, tasks = reminders/tasks (not supported). */
  kind: 'events' | 'tasks' | 'other';
  /** Shared with other people (entries appear for them immediately). */
  shared: boolean;
  /** How the sharing was detected (diagnostics only). */
  sharedReason?: string;
  /** Subscribed, read-only calendar. */
  subscribed: boolean;
  /** Writable according to server privileges. */
  writable: boolean;
  url: string;
}

export interface RawObject {
  url: string;
  etag?: string;
  data: string;
}

export interface EventOccurrence {
  /** Path of the .ics resource; identifies the event (or the series). */
  id: string;
  uid: string;
  etag?: string;
  calendar: string;
  calendarId: string;
  calendarShared: boolean;
  title: string;
  location: string;
  notes: string;
  allDay: boolean;
  /** ISO time in the user's time zone; for all-day events only the date. */
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  recurring: boolean;
  /** For series: start of this occurrence (to tell them apart). */
  occurrenceStart?: string;
  status?: string;
  /** Shows as "free" (TRANSP:TRANSPARENT). */
  free: boolean;
  hasAttendees: boolean;
  organizer?: string;
  /** The same event (same UID and same occurrence) in other calendars. */
  alsoIn?: EventOccurrence[];
}

/** Read access to calendars (replaceable, e.g. for tests or a hosted connector). */
export interface CalendarReader {
  listCalendars(force?: boolean): Promise<CalendarInfo[]>;
  fetchObjects(calendar: CalendarInfo, startIso: string, endIso: string): Promise<{ objects: RawObject[]; truncated: boolean }>;
  getObject(calendar: CalendarInfo, url: string): Promise<RawObject | undefined>;
}

/**
 * Write access: creating, changing and deleting a single event.
 * All methods require a WriteGrant from permissions.ts (deleting only with the 'delete' grant).
 */
export interface CalendarStore extends CalendarReader {
  createObject(grant: WriteGrant, filename: string, ics: string): Promise<RawObject>;
  updateObject(grant: WriteGrant, obj: RawObject & { etag: string }): Promise<RawObject>;
  /** Deletes exactly this event, provided the ETag still matches (If-Match). */
  deleteObject(grant: WriteGrant, obj: { url: string; etag: string }): Promise<void>;
}
