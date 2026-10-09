import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { findFreeSlots, mergeIntervals } from '../src/core/calendar/freeSlots.js';

const Z = 'Europe/Berlin';
const t = (s: string) => DateTime.fromISO(s, { zone: Z }).toMillis();
const base = {
  zone: Z,
  durationMinutes: 60,
  dayStart: '09:00',
  dayEnd: '18:00',
  weekdaysOnly: false,
  nowMs: 0,
  maxSlots: 50,
};

describe('findFreeSlots', () => {
  it('liefert den ganzen Tag, wenn nichts belegt ist', () => {
    const r = findFreeSlots([], { ...base, rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots).toEqual([{ start: '2026-10-12T09:00:00+02:00', end: '2026-10-12T18:00:00+02:00', minutes: 540 }]);
  });

  it('spart belegte Zeiten aus und verwirft zu kurze Lücken', () => {
    const busy = [
      { startMs: t('2026-10-12T10:00'), endMs: t('2026-10-12T12:00') },
      { startMs: t('2026-10-12T12:30'), endMs: t('2026-10-12T17:30') }, // 30 min Lücke davor, 30 min danach: zu kurz
    ];
    const r = findFreeSlots(busy, { ...base, rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots.map((s) => `${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`)).toEqual(['09:00-10:00']);
  });

  it('verschmilzt überlappende Termine', () => {
    expect(mergeIntervals([{ startMs: 5, endMs: 10 }, { startMs: 1, endMs: 6 }, { startMs: 20, endMs: 30 }])).toEqual([
      { startMs: 1, endMs: 10 },
      { startMs: 20, endMs: 30 },
    ]);
  });

  it('beachtet Wochentage und eigenes Tagesfenster', () => {
    const r = findFreeSlots([], {
      ...base,
      dayStart: '14:00',
      dayEnd: '16:00',
      weekdaysOnly: true,
      rangeStartMs: t('2026-10-09'), // Freitag
      rangeEndMs: t('2026-10-13'), // bis inkl. Montag
    });
    expect(r.slots.map((s) => s.start.slice(0, 16))).toEqual(['2026-10-09T14:00', '2026-10-12T14:00']);
  });

  it('bietet nichts in der Vergangenheit an', () => {
    const r = findFreeSlots([], { ...base, nowMs: t('2026-10-12T13:15'), rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots[0]?.start).toBe('2026-10-12T13:15:00+02:00');
  });

  it('rundet "jetzt" auf die nächsten 5 Minuten auf', () => {
    const r = findFreeSlots([], { ...base, nowMs: t('2026-10-12T13:17:25'), rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots[0]?.start).toBe('2026-10-12T13:20:00+02:00');
  });

  it('begrenzt die Anzahl und meldet, dass es mehr gibt', () => {
    const r = findFreeSlots([], { ...base, maxSlots: 2, rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-20') });
    expect(r.slots).toHaveLength(2);
    expect(r.more).toBe(true);
  });

  it('lehnt ungültige Uhrzeiten ab', () => {
    expect(() => findFreeSlots([], { ...base, dayStart: '25:00', rangeStartMs: 0, rangeEndMs: 1 })).toThrow(/ungültig/);
    expect(() => findFreeSlots([], { ...base, dayStart: '18:00', dayEnd: '09:00', rangeStartMs: 0, rangeEndMs: 1 })).toThrow(/nach dem Tagesbeginn/);
  });
});
