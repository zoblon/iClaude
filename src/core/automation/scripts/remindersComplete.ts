import type { AutomationScript } from '../runner.js';

/**
 * Marks reminders as completed or open again. Each item carries the title the caller saw; if one reminder is missing or its title differs
 * (ignoring case and spacing), nothing is changed. Verifies the result.
 */
export const remindersComplete: AutomationScript = {
  name: 'remindersComplete',
  app: 'Reminders',
  timeoutMs: 60000,
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Reminders');
    var all = app.reminders;
    var ids = all.id(), names = all.name();
    var pos = {};
    for (var i = 0; i < ids.length; i++) pos[ids[i]] = i;
    for (var j = 0; j < input.items.length; j++) {
      var k = pos[input.items[j].id];
      if (k === undefined) throw { code: 'NOT_FOUND', msg: 'A reminder was not found. Nothing was changed.' };
      if (norm(names[k] || '') !== norm(input.items[j].expectedTitle)) throw { code: 'CHANGED', msg: 'A title does not match. Nothing was changed.' };
    }
    for (var n = 0; n < input.items.length; n++) app.reminders.byId(input.items[n].id).completed = !!input.completed;
    var dones = all.completed();
    var ok = 0;
    for (var q = 0; q < input.items.length; q++) if (!!dones[pos[input.items[q].id]] === !!input.completed) ok++;
    return JSON.stringify({ ok: true, data: { changed: ok } });
  } catch (e) {
    return fail(e);
  }
}
function norm(s) { return String(s).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }
function fail(e) {
  if (e && e.code && e.msg) return JSON.stringify({ ok: false, code: e.code, message: e.msg });
  var m = String(e && e.message ? e.message : e);
  var n = /\((-?\d+)\)\s*$/.exec(m);
  if (n && n[1] === '-1743') return JSON.stringify({ ok: false, code: 'NOT_AUTHORIZED', message: 'Not authorized to control the app.' });
  return JSON.stringify({ ok: false, code: 'APP_ERROR', message: 'The app reported error ' + (n ? n[1] : 'unknown') + '.' });
}
`,
};
