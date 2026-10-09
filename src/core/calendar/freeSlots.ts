import { DateTime } from 'luxon';
import { UserError } from '../errors.js';
import { isoIn } from '../time.js';

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface FreeSlot {
  start: string;
  end: string;
  minutes: number;
}

export interface FreeSlotOptions {
  zone: string;
  rangeStartMs: number;
  rangeEndMs: number;
  durationMinutes: number;
  /** Tageszeitfenster "HH:MM". */
  dayStart: string;
  dayEnd: string;
  weekdaysOnly: boolean;
  /** Zeitpunkte vor "jetzt" gelten nicht als frei. */
  nowMs: number;
  maxSlots: number;
}

function parseClock(s: string, label: string): { hour: number; minute: number } {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new UserError(`${label} "${s}" ist ungültig. Erwartet: HH:MM, z. B. 09:00.`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.startMs <= last.endMs) last.endMs = Math.max(last.endMs, iv.endMs);
    else out.push({ ...iv });
  }
  return out;
}

/** Freie Lücken von mindestens durationMinutes innerhalb des Tageszeitfensters. */
export function findFreeSlots(busy: Interval[], o: FreeSlotOptions): { slots: FreeSlot[]; more: boolean } {
  const from = parseClock(o.dayStart, 'Tagesbeginn');
  const to = parseClock(o.dayEnd, 'Tagesende');
  if (to.hour * 60 + to.minute <= from.hour * 60 + from.minute) throw new UserError('Das Tagesende muss nach dem Tagesbeginn liegen. Bitte day_end später als day_start wählen.');
  const merged = mergeIntervals(busy);
  // Angebotene Zeiten beginnen frühestens zur nächsten vollen 5 Minuten.
  const nowRounded = Math.ceil(o.nowMs / 300_000) * 300_000;
  const minMs = o.durationMinutes * 60_000;
  const slots: FreeSlot[] = [];
  let more = false;

  let day = DateTime.fromMillis(o.rangeStartMs, { zone: o.zone }).startOf('day');
  const lastMs = o.rangeEndMs;
  for (; day.toMillis() < lastMs; day = day.plus({ days: 1 })) {
    if (o.weekdaysOnly && day.weekday > 5) continue;
    let winStart = Math.max(day.set(from).toMillis(), o.rangeStartMs, nowRounded);
    const winEnd = Math.min(day.set(to).toMillis(), lastMs);
    if (winEnd - winStart < minMs) continue;
    for (const b of merged) {
      if (b.endMs <= winStart) continue;
      if (b.startMs >= winEnd) break;
      if (b.startMs - winStart >= minMs) {
        if (slots.length >= o.maxSlots) return { slots, more: true };
        slots.push(toSlot(winStart, b.startMs, o.zone));
      }
      winStart = Math.max(winStart, b.endMs);
    }
    if (winEnd - winStart >= minMs) {
      if (slots.length >= o.maxSlots) {
        more = true;
        break;
      }
      slots.push(toSlot(winStart, winEnd, o.zone));
    }
  }
  return { slots, more };
}

function toSlot(startMs: number, endMs: number, zone: string): FreeSlot {
  return { start: isoIn(startMs, zone), end: isoIn(endMs, zone), minutes: Math.round((endMs - startMs) / 60_000) };
}
