import type { WriteGrant } from '../permissions.js';

export interface CalendarInfo {
  /** Stabile ID (Pfad des Kalenders auf dem Server). */
  id: string;
  name: string;
  /** events = Termine, tasks = Erinnerungen/Aufgaben (nicht unterstützt). */
  kind: 'events' | 'tasks' | 'other';
  /** Mit anderen Personen geteilt (Einträge erscheinen bei diesen sofort). */
  shared: boolean;
  /** Woran die Freigabe erkannt wurde (nur für Diagnose). */
  sharedReason?: string;
  /** Abonnierter, schreibgeschützter Kalender. */
  subscribed: boolean;
  /** Nach Serverrechten beschreibbar. */
  writable: boolean;
  url: string;
}

export interface RawObject {
  url: string;
  etag?: string;
  data: string;
}

export interface EventOccurrence {
  /** Pfad der .ics-Ressource; identifiziert den Termin (bzw. die Serie). */
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
  /** ISO-Zeit in Nutzer-Zeitzone, bei ganztägigen Terminen nur das Datum. */
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  recurring: boolean;
  /** Bei Serien: Beginn dieses Vorkommens (zur Unterscheidung). */
  occurrenceStart?: string;
  status?: string;
  /** Zeigt "frei" an (TRANSP:TRANSPARENT). */
  free: boolean;
  hasAttendees: boolean;
  organizer?: string;
  /** Derselbe Termin (gleiche UID und gleiches Vorkommen) in weiteren Kalendern. */
  alsoIn?: EventOccurrence[];
}

/** Lesender Zugriff auf Kalender (austauschbar, z. B. für Tests oder einen gehosteten Konnektor). */
export interface CalendarReader {
  listCalendars(force?: boolean): Promise<CalendarInfo[]>;
  fetchObjects(calendar: CalendarInfo, startIso: string, endIso: string): Promise<{ objects: RawObject[]; truncated: boolean }>;
  getObject(calendar: CalendarInfo, url: string): Promise<RawObject | undefined>;
}

/**
 * Schreibender Zugriff: Anlegen, Ändern und Löschen eines einzelnen Termins.
 * Alle Methoden verlangen ein WriteGrant aus permissions.ts (Löschen nur mit dem Grant 'delete').
 */
export interface CalendarStore extends CalendarReader {
  createObject(grant: WriteGrant, filename: string, ics: string): Promise<RawObject>;
  updateObject(grant: WriteGrant, obj: RawObject & { etag: string }): Promise<RawObject>;
  /** Löscht genau diesen Termin, sofern der ETag noch passt (If-Match). */
  deleteObject(grant: WriteGrant, obj: { url: string; etag: string }): Promise<void>;
}
