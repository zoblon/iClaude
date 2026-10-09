import { DateTime } from 'luxon';
import { parseCardDate } from './vcard.js';
import type { Contact } from './vcard.js';

export interface UpcomingDate {
  contactId: string;
  name: string;
  /** "Birthday" or the label of the date (e.g. "Anniversary"). */
  label: string;
  /** The coming occurrence, YYYY-MM-DD. */
  date: string;
  weekday: string;
  daysUntil: number;
  /** Original date as stored ("--MM-DD" when the year is unknown). */
  original: string;
  /** Age, for birthdays whose year is known. */
  age?: number;
  /** Number of years since the date, for other dates whose year is known (e.g. the 10th anniversary). */
  years?: number;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The date in the given year; 29 February counts as 28 February in years that are not leap years. */
function inYear(year: number, month: number, day: number, zone: string): DateTime {
  const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
  return DateTime.fromObject({ year, month, day: d }, { zone });
}

/**
 * Birthdays and further dates (X-ABDATE) falling on today or in the next `days` days, sorted by date.
 * Each stored date yields only its next occurrence.
 */
export function upcomingDates(contacts: Contact[], days: number, zone: string, now: DateTime = DateTime.now()): UpcomingDate[] {
  const today = now.setZone(zone).startOf('day');
  const out: UpcomingDate[] = [];
  for (const c of contacts) {
    const entries = [
      ...(c.birthday ? [{ label: 'Birthday', value: c.birthday, birthday: true }] : []),
      ...(c.dates ?? []).map((d) => ({ label: d.label || 'Date', value: d.value, birthday: false })),
    ];
    for (const e of entries) {
      const d = parseCardDate(e.value);
      if (!d) continue;
      let next = inYear(today.year, d.month, d.day, zone);
      if (next < today) next = inYear(today.year + 1, d.month, d.day, zone);
      const daysUntil = Math.round(next.diff(today, 'days').days);
      if (daysUntil > days) continue;
      const diff = d.year !== undefined ? next.year - d.year : undefined;
      out.push({
        contactId: c.id,
        name: c.name,
        label: e.label,
        date: next.toISODate()!,
        weekday: next.setLocale('en').toFormat('cccc'),
        daysUntil,
        original: e.value,
        ...(diff !== undefined && diff >= 0 ? (e.birthday ? { age: diff } : { years: diff }) : {}),
      });
    }
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name, 'de') || a.label.localeCompare(b.label));
}
