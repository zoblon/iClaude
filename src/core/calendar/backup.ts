import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { UserError, log } from '../errors.js';

/** Ordner für Sicherungen gelöschter Termine (nur der Nutzer darf ihn lesen). */
export function defaultBackupDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'icloud-mcp', 'deleted');
}

export const BACKUP_MAX_AGE_DAYS = 90;
export const BACKUP_MAX_FILES = 200;

/** Dateien, die dieser Konnektor selbst anlegt: "2026-10-08_191530_Titel.ics". Alles andere im Ordner wird nie angefasst. */
const OWN_FILE = /^\d{4}-\d{2}-\d{2}_\d{6}_.*\.ics$/;

export interface BackupOptions {
  dir: string;
  zone: string;
  /** Jetzt in Millisekunden (für Tests änderbar). */
  now?: () => number;
  maxAgeDays?: number;
  maxFiles?: number;
}

export interface SavedBackup {
  file: string;
  path: string;
}

/** Titel für den Dateinamen: Buchstaben, Ziffern, Leerzeichen, Bindestrich; alles andere wird zu "_". */
export function fileSlug(title: string): string {
  const s = title
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .replace(/^[ _-]+|[ _-]+$/g, '')
    .slice(0, 50)
    .replace(/[ _-]+$/g, '');
  return s || 'Termin';
}

/**
 * Sicherung gelöschter Termine als .ics-Dateien (per Doppelklick in Apple Kalender wiederherstellbar).
 * Ordner nur für den Nutzer (0700), Dateien nur für den Nutzer (0600).
 */
export class BackupStore {
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly maxFiles: number;

  constructor(private readonly o: BackupOptions) {
    this.now = o.now ?? Date.now;
    this.maxAgeMs = (o.maxAgeDays ?? BACKUP_MAX_AGE_DAYS) * 86_400_000;
    this.maxFiles = o.maxFiles ?? BACKUP_MAX_FILES;
  }

  get dir(): string {
    return this.o.dir;
  }

  /** Schreibt die Sicherung und liest sie zur Kontrolle zurück. Jeder Fehler bricht ab (der Termin wird dann nicht gelöscht). */
  async save(title: string, ics: string): Promise<SavedBackup> {
    const fail = () =>
      new UserError('Die Sicherung des Termins konnte nicht angelegt werden. Der Termin wurde NICHT gelöscht. Bitte prüfen, ob der Ordner ~/Library/Application Support/icloud-mcp beschreibbar ist.');
    try {
      await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
      await chmod(this.o.dir, 0o700);
      const stamp = DateTime.fromMillis(this.now(), { zone: this.o.zone }).toFormat('yyyy-MM-dd_HHmmss');
      const base = `${stamp}_${fileSlug(title)}`;
      for (let n = 1; n <= 50; n++) {
        const file = `${base}${n === 1 ? '' : `-${n}`}.ics`;
        const path = join(this.o.dir, file);
        try {
          await writeFile(path, ics, { flag: 'wx', mode: 0o600, encoding: 'utf8' });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw e;
        }
        await chmod(path, 0o600);
        const back = await readFile(path, 'utf8');
        if (back !== ics) {
          await rm(path, { force: true });
          throw new Error('Kontrolle der Sicherung fehlgeschlagen');
        }
        return { file, path };
      }
      throw new Error('kein freier Dateiname');
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw fail();
    }
  }

  /** Entfernt eine soeben angelegte Sicherung wieder (wenn das Löschen nicht geklappt hat). */
  async discard(saved: SavedBackup): Promise<void> {
    try {
      await rm(saved.path, { force: true });
    } catch {
      /* unkritisch */
    }
  }

  /** Entfernt Sicherungen, die älter als die Höchstdauer sind, und behält von den übrigen höchstens die neuesten maxFiles. */
  async prune(): Promise<number> {
    try {
      const names = (await readdir(this.o.dir)).filter((f) => OWN_FILE.test(f));
      const files = await Promise.all(
        names.map(async (f) => {
          const p = join(this.o.dir, f);
          return { f, p, t: (await stat(p)).mtimeMs };
        }),
      );
      files.sort((a, b) => b.t - a.t || b.f.localeCompare(a.f)); // neueste zuerst
      const cutoff = this.now() - this.maxAgeMs;
      const doomed = files.filter((x, i) => x.t < cutoff || i >= this.maxFiles);
      for (const x of doomed) await rm(x.p, { force: true });
      return doomed.length;
    } catch {
      log('backup-prune-failed');
      return 0;
    }
  }
}
