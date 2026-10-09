import type { AutomationScript } from '../runner.js';

/** Reads id, title, list and completion state of the given reminders (for the checks before a change). Read-only; null for an unknown id. */
export const remindersGet: AutomationScript = {
  name: 'remindersGet',
  app: 'Reminders',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Reminders');
    var all = app.reminders;
    var ids = all.id(), names = all.name(), dones = all.completed(), lists = all.container.name();
    var pos = {};
    for (var i = 0; i < ids.length; i++) pos[ids[i]] = i;
    var out = [];
    for (var j = 0; j < input.ids.length; j++) {
      var k = pos[input.ids[j]];
      out.push(k === undefined ? null : { id: ids[k], title: names[k] || '', list: lists[k] || '', completed: !!dones[k] });
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
