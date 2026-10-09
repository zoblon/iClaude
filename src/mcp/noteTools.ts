import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MAX_NOTE_CHARS } from '../core/notes/markdown.js';
import type { NoteService } from '../core/notes/service.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const folderName = z.string().min(1).max(100);

// strictObject: unknown fields (for example "id" to change a note, or "delete") are rejected, not silently ignored.
export const createNoteSchema = z.strictObject({
  title: z.string().min(1).max(200),
  text: z.string().max(MAX_NOTE_CHARS).default('').describe('Text of the note as Markdown (default) or plain text. HTML in it is shown as text, never interpreted.'),
  format: z.enum(['markdown', 'plain']).default('markdown'),
  folder: folderName.optional().describe('Name of the folder. If omitted: the default folder of the default account ("Notes").'),
  shared_folder: folderName.optional().describe('ONLY when deliberately writing into a SHARED folder: its exact name. Notes there appear immediately for other people. Without this, nothing is ever written to a shared folder.'),
});

export function registerNoteTools(server: McpServer, notes: NoteService): void {
  server.registerTool(
    'list_note_folders',
    {
      title: 'List note folders',
      description: 'Lists the folders of the Apple Notes app on this Mac with account, number of notes, whether the folder is shared, and which one is the default folder. Read-only.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('list_note_folders', async () => {
        const f = await notes.folders();
        return dataResult({ summary: `${f.length} note folders.`, source: 'the Apple Notes app (folder names)', data: f });
      }),
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description: 'Lists notes (title, folder, dates, locked or not; no content), newest change first, from one folder or all folders. Use get_note for the content. Read-only.',
      inputSchema: z.object({
        folder: folderName.optional().describe('Name of a folder. If omitted: all folders.'),
        limit: z.number().int().min(1).max(100).default(30),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('list_notes', async () => {
        const r = await notes.list({ folder: a.folder, limit: a.limit, offset: a.offset });
        return dataResult({
          summary: `${r.total} notes${r.cut ? `, showing ${r.notes.length} from offset ${a.offset}` : ''}.`,
          source: 'the Apple Notes app (titles)',
          data: r.notes,
          notes: r.cut ? [`More notes available: call again with offset=${a.offset + r.notes.length}.`] : [],
        });
      }),
  );

  server.registerTool(
    'search_notes',
    {
      title: 'Search notes',
      description:
        'Searches notes by title and, with full_text=true, also by their text (case-insensitive, locked notes are never searched inside). One folder or all. Returns title, folder and dates, not the content (use get_note). Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).max(100),
        full_text: z.boolean().default(false).describe('Also search inside the notes (slower).'),
        folder: folderName.optional(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('search_notes', async () => {
        const r = await notes.list({ query: a.query, fullText: a.full_text, folder: a.folder, limit: a.limit });
        return dataResult({
          summary: `${r.total} notes found${r.cut ? `, showing the first ${r.notes.length}` : ''}.`,
          source: 'the Apple Notes app (titles)',
          data: r.notes,
          notes: r.cut ? ['Result truncated. Narrow the search.'] : [],
        });
      }),
  );

  server.registerTool(
    'get_note',
    {
      title: 'Read note',
      description:
        'Returns one note: title, folder, dates and the content as plain text (default) or Markdown (converted from the note\'s HTML; images and attachments are only named). Long notes come in pages of about 8000 characters: use next_offset from the page info as offset. ' +
        'A note locked with a password is reported as locked and never opened. Read-only.',
      inputSchema: z.object({
        id: z.string().min(10).max(300).describe('ID from list_notes or search_notes, unchanged.'),
        format: z.enum(['text', 'markdown']).default('text'),
        offset: z.number().int().min(0).default(0).describe('Start position in characters; use next_offset from the previous page.'),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('get_note', async () => {
        const n = await notes.get(a.id, a.format, a.offset);
        const p = n.page;
        return dataResult({
          summary: p ? `Note read (characters ${p.offset}–${p.offset + p.pageLength} of ${p.totalLength}).` : 'The note is locked.',
          source: 'the Apple Notes app (note)',
          data: n,
          notes: p?.nextOffset !== undefined ? [`The text continues. For the next page, call get_note with offset=${p.nextOffset}.`] : [],
        });
      }),
  );

  server.registerTool(
    'create_note',
    {
      title: 'Create note',
      description:
        'Creates ONE new note in the Apple Notes app (title as the first line, then the text as Markdown or plain text; HTML in the text is not interpreted). Without `folder` it goes into the default folder. ' +
        'Existing notes are NEVER changed, moved or deleted by this connector (changing a note would destroy images, tables and formatting). A shared folder is only used when named in `shared_folder`.',
      inputSchema: createNoteSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) =>
      guarded('create_note', async () => {
        const r = await notes.create({ title: a.title, text: a.text, format: a.format, folder: a.folder, sharedFolder: a.shared_folder });
        return dataResult({
          summary: `Note created in folder "${r.folder}".`,
          source: 'the note just created',
          data: r,
          notes: r.shared ? [`"${r.folder}" is a SHARED folder: the note is immediately visible to other people.`] : [],
        });
      }),
  );
}
