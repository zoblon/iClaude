import type { AutomationScript } from '../runner.js';

/**
 * Reads ONE note: title, folder, dates and, if the note is not locked, its plain text and its HTML. A locked note is reported as locked and its content
 * is never read. Attachments are only listed by name. Read-only.
 */
export const notesGet: AutomationScript = {
  name: 'notesGet',
  app: 'Notes',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Notes');
    var n = app.notes.byId(input.id);
    var title;
    try { title = n.name(); } catch (e) { throw { code: 'NOT_FOUND', msg: 'The note was not found.' }; }
    var locked = !!n.passwordProtected();
    var m = n.modificationDate(), c = n.creationDate();
    var out = { id: n.id(), title: title || '', folder: n.container().name(), locked: locked, modified: m ? m.toISOString() : null, created: c ? c.toISOString() : null, plaintext: null, html: null, attachments: [] };
    if (!locked) {
      out.plaintext = n.plaintext() || '';
      if (input.html) out.html = n.body() || '';
      try { out.attachments = n.attachments.name().map(function (x) { return String(x || ''); }); } catch (e) { out.attachments = []; }
    }
    return JSON.stringify({ ok: true, data: out });
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
