import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { AutomationRefusal, type ScriptRunner } from '../automation/runner.js';
import { notesCreate } from '../automation/scripts/notesCreate.js';
import { notesFolders } from '../automation/scripts/notesFolders.js';
import { notesGet } from '../automation/scripts/notesGet.js';
import { notesList } from '../automation/scripts/notesList.js';
import { htmlToMarkdown, paginate, tidy } from '../mail/body.js';
import { authorizeNoteCreate, NoteGrant, type NoteFolderFacts } from '../permissions.js';
import { clip } from '../untrusted.js';
import { noteHtml } from './markdown.js';

const MAX_LIMIT = 100;
const iso = z.string().nullable();

const rawFolder = z.object({ id: z.string(), name: z.string(), account: z.string(), shared: z.boolean(), count: z.number(), isDefault: z.boolean() });
const rawNote = z.object({ id: z.string(), title: z.string(), folder: z.string(), locked: z.boolean(), modified: iso, created: iso });
const listOut = z.object({ total: z.number(), items: z.array(rawNote) });
const getOut = z.object({ id: z.string(), title: z.string(), folder: z.string(), locked: z.boolean(), modified: iso, created: iso, plaintext: z.string().nullable(), html: z.string().nullable(), attachments: z.array(z.string()) });
const createOut = z.object({ id: z.string(), title: z.string(), folder: z.string() });
export type RawFolder = z.infer<typeof rawFolder>;
export type RawNote = z.infer<typeof rawNote>;
export type RawNoteDetail = z.infer<typeof getOut>;

/** The backend: all Apple Notes access. The only writing method needs a NoteGrant and creates a note. */
export interface NoteBackend {
  folders(): Promise<RawFolder[]>;
  list(a: { folderId: string | null; query: string | null; inText: boolean; offset: number; limit: number }): Promise<{ total: number; items: RawNote[] }>;
  get(id: string, html: boolean): Promise<RawNoteDetail>;
  create(grant: NoteGrant, html: string): Promise<{ id: string; title: string; folder: string }>;
}

const reword = (e: unknown): never => {
  if (e instanceof AutomationRefusal) {
    if (e.code === 'NOT_FOUND') throw new UserError('The note was not found. It may have been deleted or moved; please search again.');
    if (e.code === 'FOLDER_NOT_FOUND' || e.code === 'CHANGED') throw new UserError('The folder was not found or has changed. Nothing was created. Please list the folders again.');
  }
  throw e;
};

export class JxaNotes implements NoteBackend {
  constructor(private readonly runner: ScriptRunner) {}

  folders() {
    return this.runner.run(notesFolders, {}, z.array(rawFolder));
  }
  list(a: Parameters<NoteBackend['list']>[0]) {
    return this.runner.run(notesList, a, listOut);
  }
  get(id: string, html: boolean) {
    return this.runner.run(notesGet, { id, html }, getOut).catch(reword);
  }
  async create(grant: NoteGrant, html: string) {
    if (!NoteGrant.isValid(grant)) throw new Error('Write access without a grant');
    return this.runner.run(notesCreate, { folderId: grant.folderId, folderName: grant.folder, html }, createOut).catch(reword);
  }
}

/** What get_note returns; a locked note has no text. */
export interface NoteRead {
  id: string;
  title: string;
  folder: string;
  locked?: true;
  modified?: string;
  created?: string;
  note?: string;
  format?: 'text' | 'markdown';
  page?: { offset: number; pageLength: number; totalLength: number; truncated: boolean; nextOffset?: number };
  text?: string;
  attachments?: string[];
}

export class NoteService {
  constructor(
    private readonly cfg: Config,
    private readonly backend: NoteBackend,
  ) {}

  private when(s: string | null): string | undefined {
    return s ? (DateTime.fromISO(s).setZone(this.cfg.timezone).toISO({ suppressMilliseconds: true }) ?? undefined) : undefined;
  }

  private noteView(n: RawNote) {
    return {
      id: n.id,
      title: clip(n.title, 300) || '(no title)',
      folder: clip(n.folder, 100),
      ...(n.locked ? { locked: true as const } : {}),
      ...(this.when(n.modified) ? { modified: this.when(n.modified) } : {}),
      ...(this.when(n.created) ? { created: this.when(n.created) } : {}),
    };
  }

  async folders() {
    return (await this.backend.folders()).map((f) => ({
      name: clip(f.name, 100),
      account: clip(f.account, 100),
      notes: f.count,
      ...(f.shared ? { shared: true as const } : {}),
      ...(f.isDefault ? { isDefault: true as const } : {}),
    }));
  }

  private async folderId(name: string | undefined): Promise<string | null> {
    if (!name?.trim()) return null;
    const folders = await this.backend.folders();
    const hits = folders.filter((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (hits.length === 0) throw new UserError(`Folder "${clip(name, 60)}" not found. Folders: ${folders.map((f) => `"${f.name}"`).join(', ') || '(none)'}.`);
    if (hits.length > 1) throw new UserError(`Several folders are called "${clip(name, 60)}" (in different accounts). Nothing was read.`);
    return hits[0]!.id;
  }

  async list(a: { folder?: string | undefined; query?: string | undefined; fullText?: boolean | undefined; limit?: number | undefined; offset?: number | undefined }) {
    const query = a.query?.trim() || null;
    const folderId = await this.folderId(a.folder);
    const limit = Math.min(a.limit ?? 30, MAX_LIMIT);
    const r = await this.backend.list({ folderId, query, inText: Boolean(query && a.fullText), offset: a.offset ?? 0, limit });
    return { total: r.total, notes: r.items.map((n) => this.noteView(n)), cut: r.total > (a.offset ?? 0) + r.items.length };
  }

  async get(id: string, format: 'text' | 'markdown', offset = 0): Promise<NoteRead> {
    if (!/^x-coredata:\/\/[^\s]{5,200}$/.test(id)) throw new UserError('Invalid note ID. Use the id from list_notes or search_notes unchanged.');
    const n = await this.backend.get(id, format === 'markdown');
    const base = { ...this.noteView(n) };
    if (n.locked) {
      return { ...base, locked: true as const, note: 'This note is locked with a password. Its content is never read.' };
    }
    const source = format === 'markdown' && n.html ? htmlToMarkdown(n.html) : tidy(n.plaintext ?? '');
    const { text, ...page } = paginate(source, offset);
    return { ...base, format: format === 'markdown' && n.html ? ('markdown' as const) : ('text' as const), page, text, ...(n.attachments.length ? { attachments: n.attachments.map((x) => clip(x, 200)) } : {}) };
  }

  async create(a: { title: string; text: string; format?: 'markdown' | 'plain' | undefined; folder?: string | undefined; sharedFolder?: string | undefined }) {
    const title = a.title.replace(/\s+/g, ' ').trim();
    if (!title) throw new UserError('The title must not be empty. Please provide a title.');
    const html = noteHtml(title, a.text, a.format ?? 'markdown');
    const folders = await this.backend.folders();
    const defaultId = folders.find((f) => f.isDefault)?.id;
    // Permissions first: without a grant nothing is written.
    const grant = authorizeNoteCreate({ folders: folders as NoteFolderFacts[], defaultFolderId: defaultId, folder: a.folder?.trim() || undefined, sharedFolder: a.sharedFolder?.trim() || undefined });
    const made = await this.backend.create(grant, html);
    return { id: made.id, title: clip(made.title, 300), folder: clip(made.folder, 100), shared: grant.shared };
  }
}
