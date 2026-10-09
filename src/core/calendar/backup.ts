import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { UserError, log } from '../errors.js';

/** Folder for backups of deleted events (readable only by the user). */
export function defaultBackupDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'icloud-mcp', 'deleted');
}

export const BACKUP_MAX_AGE_DAYS = 90;
export const BACKUP_MAX_FILES = 200;

/** Files this connector creates itself: "2026-10-08_191530_Title.ics". Nothing else in the folder is ever touched. */
const ownFile = (ext: string) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}_\\d{6}_.*\\.${ext}$`);

/** Folder for backups of contacts before they are changed (readable only by the user). */
export function defaultContactBackupDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'icloud-mcp', 'contacts-backup');
}

export interface BackupOptions {
  dir: string;
  zone: string;
  /** Current time in milliseconds (overridable for tests). */
  now?: () => number;
  maxAgeDays?: number;
  maxFiles?: number;
  /** File extension without dot (default "ics"). */
  ext?: string;
  /** What is backed up, for error messages (default "event"). */
  what?: string;
  /** What did not happen when the backup fails (default "The event was NOT deleted."). */
  failure?: string;
}

export interface SavedBackup {
  file: string;
  path: string;
}

/** Title for the file name: letters, digits, spaces, hyphens; everything else becomes "_". */
export function fileSlug(title: string): string {
  const s = title
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} _-]+/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/_{2,}/g, '_')
    .replace(/^[ _-]+|[ _-]+$/g, '')
    .slice(0, 50)
    .replace(/[ _-]+$/g, '');
  return s || 'Event';
}

/**
 * Backup of deleted events as .ics files (restorable by double-clicking them, which opens Apple Calendar).
 * Folder accessible only by the user (0700), files only by the user (0600).
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

  /** Writes the backup and reads it back to verify. Any error aborts (the event is then not deleted). */
  async save(title: string, ics: string): Promise<SavedBackup> {
    const ext = this.o.ext ?? 'ics';
    const fail = () =>
      new UserError(
        `Could not create a backup of the ${this.o.what ?? 'event'}. ${this.o.failure ?? 'The event was NOT deleted.'} Please check that the folder ~/Library/Application Support/icloud-mcp is writable.`,
      );
    try {
      await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
      await chmod(this.o.dir, 0o700);
      const stamp = DateTime.fromMillis(this.now(), { zone: this.o.zone }).toFormat('yyyy-MM-dd_HHmmss');
      const base = `${stamp}_${fileSlug(title)}`;
      for (let n = 1; n <= 50; n++) {
        const file = `${base}${n === 1 ? '' : `-${n}`}.${ext}`;
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
          throw new Error('backup verification failed');
        }
        return { file, path };
      }
      throw new Error('no free file name');
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw fail();
    }
  }

  /** Removes a backup that was just created (when the delete did not succeed). */
  async discard(saved: SavedBackup): Promise<void> {
    try {
      await rm(saved.path, { force: true });
    } catch {
      /* not critical */
    }
  }

  /** Removes backups older than the maximum age and keeps at most the newest maxFiles of the rest. */
  async prune(): Promise<number> {
    try {
      const names = (await readdir(this.o.dir)).filter((f) => ownFile(this.o.ext ?? 'ics').test(f));
      const files = await Promise.all(
        names.map(async (f) => {
          const p = join(this.o.dir, f);
          return { f, p, t: (await stat(p)).mtimeMs };
        }),
      );
      files.sort((a, b) => b.t - a.t || b.f.localeCompare(a.f)); // newest first
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
