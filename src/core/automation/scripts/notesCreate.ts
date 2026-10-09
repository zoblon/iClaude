import type { AutomationScript } from '../runner.js';

/**
 * Creates ONE new note in the folder with the given id (the caller checked that the folder is the granted one). `html` is the finished body;
 * the first line becomes the title. Existing notes are never touched: nothing is changed, moved or deleted.
 */
export const notesCreate: AutomationScript = {
  name: 'notesCreate',
  app: 'Notes',
  timeoutMs: 60000,
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Notes');
    var folder = app.folders.byId(input.folderId);
    var name;
    try { name = folder.name(); } catch (e) { throw { code: 'FOLDER_NOT_FOUND', msg: 'The folder was not found.' }; }
    if (name !== input.folderName) throw { code: 'CHANGED', msg: 'The folder has changed in the meantime.' };
    var note = app.Note({ body: String(input.html) });
    folder.notes.push(note);
    var id = note.id();
    var back = app.notes.byId(id);
    return JSON.stringify({ ok: true, data: { id: id, title: back.name() || '', folder: back.container().name() } });
  } catch (e) {
    return fail(e);
  }
}
function fail(e) {
  if (e && e.code && e.msg) return JSON.stringify({ ok: false, code: e.code, message: e.msg });
  var m = String(e && e.message ? e.message : e);
  var n = /\((-?\d+)\)\s*$/.exec(m);
  if (n && n[1] === '-1743') return JSON.stringify({ ok: false, code: 'NOT_AUTHORIZED', message: 'Not authorized to control the app.' });
  return JSON.stringify({ ok: false, code: 'APP_ERROR', message: 'The app reported error ' + (n ? n[1] : 'unknown') + '.' });
}
`,
};
