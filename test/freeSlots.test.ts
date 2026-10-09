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
  it('returns the whole day when nothing is busy', () => {
    const r = findFreeSlots([], { ...base, rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots).toEqual([{ start: '2026-10-12T09:00:00+02:00', end: '2026-10-12T18:00:00+02:00', minutes: 540 }]);
  });

  it('leaves out busy times and discards gaps that are too short', () => {
    const busy = [
      { startMs: t('2026-10-12T10:00'), endMs: t('2026-10-12T12:00') },
      { startMs: t('2026-10-12T12:30'), endMs: t('2026-10-12T17:30') }, // 30 min gap before, 30 min after: too short
    ];
    const r = findFreeSlots(busy, { ...base, rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots.map((s) => `${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`)).toEqual(['09:00-10:00']);
  });

  it('merges overlapping events', () => {
    expect(mergeIntervals([{ startMs: 5, endMs: 10 }, { startMs: 1, endMs: 6 }, { startMs: 20, endMs: 30 }])).toEqual([
      { startMs: 1, endMs: 10 },
      { startMs: 20, endMs: 30 },
    ]);
  });

  it('respects weekdays and a custom daily window', () => {
    const r = findFreeSlots([], {
      ...base,
      dayStart: '14:00',
      dayEnd: '16:00',
      weekdaysOnly: true,
      rangeStartMs: t('2026-10-09'), // Friday
      rangeEndMs: t('2026-10-13'), // up to and including Monday
    });
    expect(r.slots.map((s) => s.start.slice(0, 16))).toEqual(['2026-10-09T14:00', '2026-10-12T14:00']);
  });

  it('offers nothing in the past', () => {
    const r = findFreeSlots([], { ...base, nowMs: t('2026-10-12T13:15'), rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots[0]?.start).toBe('2026-10-12T13:15:00+02:00');
  });

  it('rounds "now" up to the next 5 minutes', () => {
    const r = findFreeSlots([], { ...base, nowMs: t('2026-10-12T13:17:25'), rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-13') });
    expect(r.slots[0]?.start).toBe('2026-10-12T13:20:00+02:00');
  });

  it('limits the count and reports that there are more', () => {
    const r = findFreeSlots([], { ...base, maxSlots: 2, rangeStartMs: t('2026-10-12'), rangeEndMs: t('2026-10-20') });
    expect(r.slots).toHaveLength(2);
    expect(r.more).toBe(true);
  });

  it('rejects invalid times of day', () => {
    expect(() => findFreeSlots([], { ...base, dayStart: '25:00', rangeStartMs: 0, rangeEndMs: 1 })).toThrow(/is invalid/);
    expect(() => findFreeSlots([], { ...base, dayStart: '18:00', dayEnd: '09:00', rangeStartMs: 0, rangeEndMs: 1 })).toThrow(/after the day start/);
  });
});
