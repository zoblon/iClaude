import { beforeEach, describe, expect, it } from 'vitest';
import type { AutomationScript, ScriptRunner } from '../src/core/automation/runner.js';
import { markdownToHtml, noteHtml, plainToHtml } from '../src/core/notes/markdown.js';
import { JxaNotes, NoteService, type NoteBackend, type RawFolder, type RawNote, type RawNoteDetail } from '../src/core/notes/service.js';
import { authorizeNoteCreate, NoteGrant } from '../src/core/permissions.js';
import { createNoteSchema } from '../src/mcp/noteTools.js';
import { cfg } from './fakeStore.js';

const folders: RawFolder[] = [
  { id: 'f1', name: 'Notes', account: 'iCloud', shared: false, count: 3, isDefault: true },
  { id: 'f2', name: 'iClaude Test', account: 'iCloud', shared: false, count: 0, isDefault: false },
  { id: 'f3', name: 'Family', account: 'iCloud', shared: true, count: 5, isDefault: false },
  { id: 'f4', name: 'Notes', account: 'On My Mac', shared: false, count: 1, isDefault: false },
];
const note = (n: number, over: Partial<RawNote> = {}): RawNote => ({ id: `x-coredata://AAAA-BBBB/ICNote/p${n}`, title: `Note ${n}`, folder: 'Notes', locked: false, modified: '2026-10-08T10:00:00.000Z', created: '2026-10-01T10:00:00.000Z', ...over });

class FakeNotes implements NoteBackend {
  details = new Map<string, RawNoteDetail>();
  created: Array<{ folderId: string; folder: string; html: string }> = [];
  lastList: unknown;
  async folders() {
    return folders;
  }
  async list(a: Parameters<NoteBackend['list']>[0]) {
    this.lastList = a;
    const items = [note(1), note(2, { locked: true })];
    return { total: items.length, items: items.slice(0, a.limit) };
  }
  async get(id: string) {
    const d = this.details.get(id);
    if (!d) throw new Error('not found');
    return d;
  }
  async create(grant: NoteGrant, html: string) {
    if (!NoteGrant.isValid(grant)) throw new Error('Write access without a grant');
    this.created.push({ folderId: grant.folderId, folder: grant.folder, html });
    return { id: 'x-coredata://AAAA-BBBB/ICNote/p99', title: 'T', folder: grant.folder };
  }
}

let backend: FakeNotes;
let svc: NoteService;
beforeEach(() => {
  backend = new FakeNotes();
  svc = new NoteService(cfg, backend);
});

describe('Markdown to Notes HTML', () => {
  it('converts headings, lists, emphasis, code and safe links', () => {
    const html = markdownToHtml('# Title\n\nSome **bold** and *italic* and `code <b>`.\nSecond line\n\n- one\n- two\n\n1. first\n2. second\n\n## Sub\n[Docs](https://example.com/a?b=1&c=2)\n\n```\nlet x = "<y>";\n```');
    expect(html).toBe(
      '<h2>Title</h2><div>Some <b>bold</b> and <i>italic</i> and <tt>code &lt;b&gt;</tt>.<br>Second line</div><ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>' +
        '<h3>Sub</h3><div><a href="https://example.com/a?b=1&amp;c=2">Docs</a></div><div><tt>let x = &quot;&lt;y&gt;&quot;;</tt></div>',
    );
  });

  it('never passes HTML, scripts, event handlers or unsafe links through', () => {
    const evil = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html;base64,AAAA) <a href="https://evil">z</a> **<b>**';
    for (const html of [markdownToHtml(evil), plainToHtml(evil), noteHtml('<b>T</b>', evil, 'markdown'), noteHtml('T', evil, 'plain')]) {
      expect(html).not.toMatch(/<script|<img|href="javascript|href="data|<a href="https:\/\/evil/i);
      // only the tags we produce
      expect([...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase()).filter((t) => !['div', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'b', 'i', 'tt', 'br', 'a'].includes(t))).toEqual([]);
    }
    expect(markdownToHtml('[x](javascript:alert(1))')).toBe('<div>x (javascript:alert(1))</div>');
  });

  it('puts the title first as an h1 and keeps plain text line breaks', () => {
    expect(noteHtml(' Shopping ', 'milk\neggs\n\nbread', 'plain')).toBe('<div><h1>Shopping</h1></div><div>milk<br>eggs</div><div>bread</div>');
    expect(noteHtml('Only a title', '', 'markdown')).toBe('<div><h1>Only a title</h1></div>');
    expect(() => noteHtml('T', 'x'.repeat(50_001), 'plain')).toThrow(/too long/);
  });
});

describe('reading notes', () => {
  it('lists folders, marks shared and default ones', async () => {
    const f = await svc.folders();
    expect(f.find((x) => x.name === 'Family')).toMatchObject({ shared: true });
    expect(f[0]).toMatchObject({ name: 'Notes', account: 'iCloud', isDefault: true, notes: 3 });
  });

  it('lists notes (titles only) and passes folder, query, full-text and paging on', async () => {
    const r = await svc.list({ folder: 'iclaude test', query: ' milk ', fullText: true, limit: 5, offset: 10 });
    expect(backend.lastList).toEqual({ folderId: 'f2', query: 'milk', inText: true, offset: 10, limit: 5 });
    expect(r.notes[1]).toMatchObject({ locked: true });
    expect(r.notes[0]).toMatchObject({ title: 'Note 1', modified: '2026-10-08T12:00:00+02:00' });
    await expect(svc.list({ folder: 'Nope' })).rejects.toThrow(/not found/);
    await expect(svc.list({ folder: 'Notes' })).rejects.toThrow(/Several folders are called/);
    await svc.list({});
    expect(backend.lastList).toMatchObject({ folderId: null, query: null, inText: false });
  });

  it('reads text or Markdown in pages; HTML garbage and images do not leak', async () => {
    const id = note(1).id;
    backend.details.set(id, {
      id, title: 'Note 1', folder: 'Notes', locked: false, modified: null, created: null,
      plaintext: Array.from({ length: 2500 }, (_, i) => `Line ${i}`).join('\n'),
      html: '<div><h1>Note 1</h1></div><div>Hello <b>you</b></div><img src="data:image/png;base64,AAAA"><div style="display:none">HIDDEN</div>',
      attachments: ['scan.pdf'],
    });
    const p1 = await svc.get(id, 'text');
    expect(p1).toMatchObject({ format: 'text', page: { offset: 0, pageLength: 8000, nextOffset: 8000 }, attachments: ['scan.pdf'] });
    expect((await svc.get(id, 'text', 8000)).page?.offset).toBe(8000);
    const md = await svc.get(id, 'markdown');
    expect(md.format).toBe('markdown');
    expect(md.text).toContain('Hello **you**');
    expect(md.text).not.toMatch(/base64|HIDDEN/);
  });

  it('reports a locked note as locked and returns no content', async () => {
    const id = note(2).id;
    backend.details.set(id, { id, title: 'Secret', folder: 'Notes', locked: true, modified: null, created: null, plaintext: 'MUST-NOT-APPEAR', html: 'MUST-NOT-APPEAR', attachments: [] });
    const r = await svc.get(id, 'text');
    expect(r).toMatchObject({ locked: true, note: expect.stringMatching(/locked.*never read/) });
    expect(JSON.stringify(r)).not.toContain('MUST-NOT-APPEAR');
  });

  it('refuses malformed IDs', async () => {
    await expect(svc.get('bogus', 'text')).rejects.toThrow(/Invalid note ID/);
  });
});

describe('create_note', () => {
  it('creates in the default folder (found by id, not by name), or in a named own folder', async () => {
    await svc.create({ title: 'Idea', text: 'Some **text**' });
    expect(backend.created[0]).toMatchObject({ folderId: 'f1', folder: 'Notes' });
    expect(backend.created[0]!.html).toBe('<div><h1>Idea</h1></div><div>Some <b>text</b></div>');
    await svc.create({ title: 'Test', text: '', folder: 'iClaude Test' });
    expect(backend.created[1]).toMatchObject({ folderId: 'f2', folder: 'iClaude Test' });
  });

  it('writes to a shared folder only with shared_folder, never via folder', async () => {
    await expect(svc.create({ title: 'x', text: 'y', folder: 'Family' })).rejects.toThrow(/shared folder.*shared_folder="Family"/s);
    await expect(svc.create({ title: 'x', text: 'y', sharedFolder: 'iClaude Test' })).rejects.toThrow(/not a shared folder/);
    await expect(svc.create({ title: 'x', text: 'y', folder: 'a', sharedFolder: 'Family' })).rejects.toThrow(/only one of/);
    expect(backend.created).toEqual([]);
    const r = await svc.create({ title: 'x', text: 'y', sharedFolder: 'family' });
    expect(r.shared).toBe(true);
    expect(backend.created).toHaveLength(1);
  });

  it('refuses ambiguous or unknown folders, empty titles; creates nothing', async () => {
    await expect(svc.create({ title: 'x', text: '', folder: 'Notes' })).rejects.toThrow(/Several folders/);
    await expect(svc.create({ title: 'x', text: '', folder: 'Nope' })).rejects.toThrow(/not found/);
    await expect(svc.create({ title: '  ', text: '' })).rejects.toThrow(/must not be empty/);
    expect(backend.created).toEqual([]);
  });

  it('without a determinable default folder it asks for a folder name', () => {
    expect(() => authorizeNoteCreate({ folders, defaultFolderId: undefined })).toThrow(/default folder.*could not be determined/);
  });

  it('there is no way to change, move or delete a note: schema, backend and scripts', async () => {
    for (const f of ['id', 'note_id', 'delete', 'move', 'append', 'replace', 'body']) expect(createNoteSchema.safeParse({ title: 'x', [f]: 'y' }).success, f).toBe(false);
    const be = new JxaNotes({ run: async () => { throw new Error('must not run'); } } as unknown as ScriptRunner);
    await expect(be.create({ folderId: 'f1', folder: 'Notes', shared: false } as never, '<div>x</div>')).rejects.toThrow(/without a grant/);
    const seen: Array<[string, unknown]> = [];
    const runner: ScriptRunner = { async run<T>(s: AutomationScript, i: unknown): Promise<T> { seen.push([s.name, i]); return { id: 'x-coredata://a/ICNote/p1', title: 'T', folder: 'iClaude Test' } as T; } } as never;
    const grant = authorizeNoteCreate({ folders, folder: 'iClaude Test' });
    await new JxaNotes(runner).create(grant, '<div>x</div>');
    expect(seen).toEqual([['notesCreate', { folderId: 'f2', folderName: 'iClaude Test', html: '<div>x</div>' }]]);
  });
});
