import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_MAX_AGE_DAYS, BACKUP_MAX_FILES, BackupStore, fileSlug } from '../src/core/calendar/backup.js';

const DAY = 86_400_000;
// Wednesday, 2026-10-07, 17:15:30 in Berlin (CEST)
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

/** Creates an own backup file with a given age. */
function aged(name: string, ageDays: number): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
}
const own = (i: number) => `2026-01-01_${String(i).padStart(6, '0')}_Event ${i}.ics`;

describe('Creating a backup', () => {
  it('creates the file with date, time and title in its name and stores the content unchanged', async () => {
    const ics = 'BEGIN:VCALENDAR\r\nX-MY-EXTENSION:important\r\nEND:VCALENDAR\r\n';
    const saved = await store.save('Dentist Dr. Müller', ics);
    expect(saved.file).toBe('2026-10-07_171530_Dentist Dr_ Müller.ics');
    expect(saved.path).toBe(join(dir, saved.file));
    expect(readFileSync(saved.path, 'utf8')).toBe(ics);
  });

  it('permissions: folder only for the user (0700), file only for the user (0600)', async () => {
    const saved = await store.save('Test', 'x');
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens an existing, too open folder back to 0700', async () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    await store.save('Test', 'x');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('never overwrites: the same title in the same second gets a suffix', async () => {
    const a = await store.save('Twice', 'one');
    const b = await store.save('Twice', 'two');
    expect(b.file).toBe('2026-10-07_171530_Twice-2.ics');
    expect(readFileSync(a.path, 'utf8')).toBe('one');
    expect(readFileSync(b.path, 'utf8')).toBe('two');
  });

  it.each([
    ['../../etc/passwd', 'etc_passwd'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j'],
    ['   ', 'Event'],
    ['\u0000\u0007', 'Event'],
    ['Ünïcödé 日本語 🎉', 'Ünïcödé 日本語'],
  ])('title "%s" becomes a harmless file name', (title, slug) => {
    expect(fileSlug(title)).toBe(slug);
    expect(fileSlug(title)).not.toMatch(/[\\/]/);
  });

  it('shortens very long titles', () => {
    expect(fileSlug('x'.repeat(500)).length).toBeLessThanOrEqual(50);
  });

  it('titles with path tricks still end up in the backup folder', async () => {
    const saved = await store.save('../../../../tmp/evil', 'x');
    expect(saved.path.startsWith(dir + '/')).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('reports an error when the folder cannot be created (a file is in the way)', async () => {
    writeFileSync(dir, 'I am a file, not a folder');
    await expect(store.save('Test', 'x')).rejects.toThrow(/NOT deleted/);
  });

  it('reports an error when the parent folder is not writable', async () => {
    const ro = join(root, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      // As an administrator the folder would be writable anyway; then there is nothing to check here.
      try {
        mkdirSync(join(ro, 'probe'));
        return;
      } catch {
        /* expected */
      }
      await expect(new BackupStore({ dir: join(ro, 'deleted'), zone: 'Europe/Berlin', now: () => NOW }).save('Test', 'x')).rejects.toThrow(/NOT deleted/);
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it('discard removes only the file just created', async () => {
    const keep = await store.save('Stays', 'a');
    const gone = await store.save('Goes', 'b');
    await store.discard(gone);
    expect(existsSync(gone.path)).toBe(false);
    expect(existsSync(keep.path)).toBe(true);
  });
});

describe('Pruning: older than 90 days and at most 200 files', () => {
  it('the defaults are 90 days and 200 files', () => {
    expect(BACKUP_MAX_AGE_DAYS).toBe(90);
    expect(BACKUP_MAX_FILES).toBe(200);
  });

  it('removes backups older than 90 days and keeps younger ones (boundary: 89 stays, 91 goes)', async () => {
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

  it('keeps at most the 200 newest; the oldest go first', async () => {
    // 205 files, all younger than 90 days; file i is i hours old.
    const paths: string[] = [];
    for (let i = 0; i < 205; i++) paths.push(aged(own(i), i / 24));
    expect(await store.prune()).toBe(5);
    const left = readdirSync(dir);
    expect(left).toHaveLength(200);
    for (let i = 0; i < 200; i++) expect(existsSync(paths[i]!), `file ${i} (newer) stays`).toBe(true);
    for (let i = 200; i < 205; i++) expect(existsSync(paths[i]!), `file ${i} (oldest) goes`).toBe(false);
  });

  it('applies both rules together', async () => {
    for (let i = 0; i < 210; i++) aged(own(i), i < 195 ? i / 24 : 100 + i); // 15 are older than 90 days
    expect(await store.prune()).toBe(15);
    expect(readdirSync(dir)).toHaveLength(195);
  });

  it('leaves foreign files in the folder untouched, even very old ones', async () => {
    const foreign = aged('notes.txt', 500);
    const ics = aged('my-file.ics', 500);
    const old = aged(own(1), 500);
    await store.prune();
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(ics)).toBe(true);
    expect(existsSync(old)).toBe(false);
  });

  it('the new backup always survives pruning', async () => {
    for (let i = 0; i < 200; i++) aged(own(i), i / 24);
    const saved = await store.save('New', 'x');
    await store.prune();
    expect(existsSync(saved.path)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(200);
  });

  it('a missing folder is not an error', async () => {
    expect(await store.prune()).toBe(0);
  });
});
