import type { AutomationScript } from '../runner.js';

/** Lists the Reminders lists (id, name, default list); with countOpen also the number of open reminders (slower). Read-only. */
export const remindersLists: AutomationScript = {
  name: 'remindersLists',
  app: 'Reminders',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Reminders');
    var lists = app.lists();
    var defaultId = null;
    try { defaultId = app.defaultList().id(); } catch (e) { defaultId = null; }
    var out = [];
    for (var i = 0; i < lists.length; i++) {
      var l = lists[i];
      var open = input.countOpen ? l.reminders.whose({ completed: false }).id().length : 0;
      out.push({ id: l.id(), name: l.name(), open: open, isDefault: defaultId !== null && l.id() === defaultId });
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
