import { DateTime } from 'luxon';
import { UserError } from './errors.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Liest Datum oder Zeitpunkt. Ohne Zeitzonenangabe gilt die Standardzeitzone.
 * Reines Datum: Beginn des Tages ('start') bzw. Ende des Tages ('end', also Beginn des Folgetags).
 */
export function parseWhen(input: string, zone: string, edge: 'start' | 'end', label = 'Zeitangabe'): DateTime {
  const s = input.trim();
  let dt = DateTime.fromISO(s, { zone });
  if (!dt.isValid) {
    throw new UserError(`${label} "${s}" ist ungültig. Erwartet: ISO 8601, z. B. 2026-10-09 oder 2026-10-09T14:30:00.`);
  }
  if (DATE_ONLY.test(s)) dt = edge === 'start' ? dt.startOf('day') : dt.startOf('day').plus({ days: 1 });
  return dt;
}

export interface TimeRange {
  start: DateTime;
  end: DateTime;
}

export function parseRange(startIn: string, endIn: string, zone: string, maxDays: number): TimeRange {
  const start = parseWhen(startIn, zone, 'start', 'Start');
  const end = parseWhen(endIn, zone, 'end', 'Ende');
  if (end <= start) throw new UserError('Das Ende muss nach dem Start liegen. Bitte ein späteres Ende angeben.');
  const days = end.diff(start, 'days').days;
  if (days > maxDays) throw new UserError(`Der Zeitraum ist zu groß (${Math.ceil(days)} Tage, erlaubt sind ${maxDays}). Bitte kleiner wählen.`);
  return { start, end };
}

/** ISO-Text in der Zielzeitzone, ohne Millisekunden. */
export function isoIn(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toISO({ suppressMilliseconds: true }) ?? '';
}
