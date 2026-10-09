import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_MAX_AGE_DAYS, BACKUP_MAX_FILES, BackupStore, fileSlug } from '../src/core/calendar/backup.js';

const DAY = 86_400_000;
// Mittwoch, 7.10.2026, 17:15:30 Uhr in Berlin (MESZ)
const NOW = Date.UTC(2026, 9, 7, 15, 15, 30);

let root: string;
let dir: string;
let store: BackupStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icloud-mcp-backup-'));
  dir = join(root, 'deleted');
  store = new BackupStore({ dir, zone: 'Europe/Berlin', now: () => NOW });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Legt eine eigene Sicherungsdatei mit bestimmtem Alter an. */
function aged(name: string, ageDays: number): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
}
const own = (i: number) => `2026-01-01_${String(i).padStart(6, '0')}_Termin ${i}.ics`;

describe('Sicherung anlegen', () => {
  it('legt die Datei mit Datum, Uhrzeit und Titel im Namen an und speichert den Inhalt unverändert', async () => {
    const ics = 'BEGIN:VCALENDAR\r\nX-MEINE-ERWEITERUNG:wichtig\r\nEND:VCALENDAR\r\n';
    const saved = await store.save('Zahnarzt Dr. Müller', ics);
    expect(saved.file).toBe('2026-10-07_171530_Zahnarzt Dr_ Müller.ics');
    expect(saved.path).toBe(join(dir, saved.file));
    expect(readFileSync(saved.path, 'utf8')).toBe(ics);
  });

  it('Rechte: Ordner nur für den Nutzer (0700), Datei nur für den Nutzer (0600)', async () => {
    const saved = await store.save('Test', 'x');
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('zieht einen schon vorhandenen, zu offenen Ordner auf 0700 zurück', async () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    await store.save('Test', 'x');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('überschreibt nie: gleicher Titel in derselben Sekunde bekommt ein Suffix', async () => {
    const a = await store.save('Doppelt', 'eins');
    const b = await store.save('Doppelt', 'zwei');
    expect(b.file).toBe('2026-10-07_171530_Doppelt-2.ics');
    expect(readFileSync(a.path, 'utf8')).toBe('eins');
    expect(readFileSync(b.path, 'utf8')).toBe('zwei');
  });

  it.each([
    ['../../etc/passwd', 'etc_passwd'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j'],
    ['   ', 'Termin'],
    ['\u0000\u0007', 'Termin'],
    ['Ünïcödé 日本語 🎉', 'Ünïcödé 日本語'],
  ])('Titel "%s" wird zu einem harmlosen Dateinamen', (title, slug) => {
    expect(fileSlug(title)).toBe(slug);
    expect(fileSlug(title)).not.toMatch(/[\\/]/);
  });

  it('kürzt sehr lange Titel', () => {
    expect(fileSlug('x'.repeat(500)).length).toBeLessThanOrEqual(50);
  });

  it('Titel mit Pfadtricks landen trotzdem im Sicherungsordner', async () => {
    const saved = await store.save('../../../../tmp/boese', 'x');
    expect(saved.path.startsWith(dir + '/')).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('meldet einen Fehler, wenn der Ordner nicht angelegt werden kann (Hindernis ist eine Datei)', async () => {
    writeFileSync(dir, 'ich bin eine Datei, kein Ordner');
    await expect(store.save('Test', 'x')).rejects.toThrow(/NICHT gelöscht/);
  });

  it('meldet einen Fehler, wenn der übergeordnete Ordner nicht beschreibbar ist', async () => {
    const ro = join(root, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      // Als Administrator wäre der Ordner trotzdem beschreibbar; dann gibt es hier nichts zu prüfen.
      try {
        mkdirSync(join(ro, 'probe'));
        return;
      } catch {
        /* erwartet */
      }
      await expect(new BackupStore({ dir: join(ro, 'deleted'), zone: 'Europe/Berlin', now: () => NOW }).save('Test', 'x')).rejects.toThrow(/NICHT gelöscht/);
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it('discard entfernt nur die soeben angelegte Datei', async () => {
    const keep = await store.save('Bleibt', 'a');
    const gone = await store.save('Geht', 'b');
    await store.discard(gone);
    expect(existsSync(gone.path)).toBe(false);
    expect(existsSync(keep.path)).toBe(true);
  });
});

describe('Aufräumen: älter als 90 Tage und höchstens 200 Dateien', () => {
  it('die Vorgaben sind 90 Tage und 200 Dateien', () => {
    expect(BACKUP_MAX_AGE_DAYS).toBe(90);
    expect(BACKUP_MAX_FILES).toBe(200);
  });

  it('entfernt Sicherungen älter als 90 Tage, behält jüngere (Grenze: 89 bleibt, 91 geht)', async () => {
    const a = aged(own(1), 91);
    const b = aged(own(2), 89);
    const c = aged(own(3), 400);
    const d = aged(own(4), 0);
    expect(await store.prune()).toBe(2);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(c)).toBe(false);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(d)).toBe(true);
  });

  it('behält höchstens die 200 neuesten, die ältesten gehen zuerst', async () => {
    // 205 Dateien, alle jünger als 90 Tage; Datei i ist i Stunden alt.
    const paths: string[] = [];
    for (let i = 0; i < 205; i++) paths.push(aged(own(i), i / 24));
    expect(await store.prune()).toBe(5);
    const left = readdirSync(dir);
    expect(left).toHaveLength(200);
    for (let i = 0; i < 200; i++) expect(existsSync(paths[i]!), `Datei ${i} (neuer) bleibt`).toBe(true);
    for (let i = 200; i < 205; i++) expect(existsSync(paths[i]!), `Datei ${i} (ältester) geht`).toBe(false);
  });

  it('wendet beide Regeln zusammen an', async () => {
    for (let i = 0; i < 210; i++) aged(own(i), i < 195 ? i / 24 : 100 + i); // 15 sind älter als 90 Tage
    expect(await store.prune()).toBe(15);
    expect(readdirSync(dir)).toHaveLength(195);
  });

  it('lässt fremde Dateien im Ordner unangetastet, auch uralte', async () => {
    const fremd = aged('notizen.txt', 500);
    const ics = aged('meine-datei.ics', 500);
    const alt = aged(own(1), 500);
    await store.prune();
    expect(existsSync(fremd)).toBe(true);
    expect(existsSync(ics)).toBe(true);
    expect(existsSync(alt)).toBe(false);
  });

  it('die neue Sicherung bleibt beim Aufräumen immer erhalten', async () => {
    for (let i = 0; i < 200; i++) aged(own(i), i / 24);
    const saved = await store.save('Neu', 'x');
    await store.prune();
    expect(existsSync(saved.path)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(200);
  });

  it('ein fehlender Ordner ist kein Fehler', async () => {
    expect(await store.prune()).toBe(0);
  });
});
