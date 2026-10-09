import { DateTime } from 'luxon';
import { UserError } from './errors.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a date or date-time. Without a time zone, the default time zone applies.
 * Date only: start of the day ('start') or end of the day ('end', i.e. start of the next day).
 */
export function parseWhen(input: string, zone: string, edge: 'start' | 'end', label = 'Time'): DateTime {
  const s = input.trim();
  let dt = DateTime.fromISO(s, { zone });
  if (!dt.isValid) {
    throw new UserError(`${label} "${s}" is invalid. Expected: ISO 8601, e.g. 2026-10-09 or 2026-10-09T14:30:00.`);
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
  const end = parseWhen(endIn, zone, 'end', 'End');
  if (end <= start) throw new UserError('The end must be after the start. Please specify a later end.');
  const days = end.diff(start, 'days').days;
  if (days > maxDays) throw new UserError(`The time range is too large (${Math.ceil(days)} days, at most ${maxDays} allowed). Please choose a smaller range.`);
  return { start, end };
}

/** ISO text in the target time zone, without milliseconds. */
export function isoIn(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toISO({ suppressMilliseconds: true }) ?? '';
}
