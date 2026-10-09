import type { AutomationScript } from '../runner.js';

/**
 * Lists notes (titles and dates only, never the content), optionally of one folder and optionally filtered by title or by text, newest change first.
 * Read-only. Locked notes are listed as locked; the text filter never looks inside them.
 */
export const notesList: AutomationScript = {
  name: 'notesList',
  app: 'Notes',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Notes');
    // Bulk reads of a note's container do not work in Notes, so the folder names come from one read of the note ids per folder.
    var folders = input.folderId === null ? app.folders() : [app.folders.byId(input.folderId)];
    var folderOf = {};
    for (var fi = 0; fi < folders.length; fi++) {
      var fname = folders[fi].name();
      var fids = folders[fi].notes.id();
      for (var k = 0; k < fids.length; k++) folderOf[fids[k]] = fname;
    }
    var coll = input.folderId === null ? app.notes : folders[0].notes;
    var ids = coll.id();
    var items = [];
    if (ids.length > 0) {
      var names = coll.name(), mods = coll.modificationDate(), creates = coll.creationDate(), locked = coll.passwordProtected();
      var q = input.query ? String(input.query).toLowerCase() : null;
      var textHits = null;
      if (q !== null && input.inText) {
        textHits = {};
        var hit = coll.whose({ _and: [{ passwordProtected: false }, { plaintext: { _contains: input.query } }] }).id();
        for (var h = 0; h < hit.length; h++) textHits[hit[h]] = true;
      }
      for (var i = 0; i < ids.length; i++) {
        if (q !== null) {
          var inTitle = String(names[i] || '').toLowerCase().indexOf(q) >= 0;
          if (!inTitle && !(textHits && textHits[ids[i]])) continue;
        }
        items.push({ id: ids[i], title: names[i] || '', folder: folderOf[ids[i]] || '', locked: !!locked[i], modified: mods[i] ? mods[i].toISOString() : null, created: creates[i] ? creates[i].toISOString() : null });
      }
    }
    items.sort(function (a, b) { return String(b.modified || '').localeCompare(String(a.modified || '')); });
    var total = items.length;
    return JSON.stringify({ ok: true, data: { total: total, items: items.slice(input.offset, input.offset + input.limit) } });
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
