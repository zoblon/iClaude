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
    var ids = app.lists.id(), names = app.lists.name();
    var defaultId = null;
    try { defaultId = app.defaultList().id(); } catch (e) { defaultId = null; }
    var lists = input.countOpen ? app.lists() : null;
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var open = lists ? lists[i].reminders.whose({ completed: false }).id().length : 0;
      out.push({ id: ids[i], name: names[i], open: open, isDefault: defaultId !== null && ids[i] === defaultId });
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
