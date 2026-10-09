import type { AutomationScript } from '../runner.js';

/** Lists the Notes folders with account, shared flag, number of notes and which one is the default folder. Read-only. */
export const notesFolders: AutomationScript = {
  name: 'notesFolders',
  app: 'Notes',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Notes');
    var defaultId = null;
    try { defaultId = app.defaultAccount().defaultFolder().id(); } catch (e) { defaultId = null; }
    var folders = app.folders();
    var out = [];
    for (var i = 0; i < folders.length; i++) {
      var f = folders[i];
      var account = '';
      try { account = f.container().name(); } catch (e) { account = ''; }
      out.push({ id: f.id(), name: f.name(), account: account, shared: !!f.shared(), count: f.notes.id().length, isDefault: defaultId !== null && f.id() === defaultId });
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
