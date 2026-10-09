import type { AutomationScript } from '../runner.js';

/**
 * Reads reminders: optionally from one list, open/completed/all, with a due range and a text filter, with a limit. Read-only.
 * Each Apple event to Reminders takes about half a second, so it filters by completion with `whose` and reads only the needed properties as
 * bulk arrays over the whole selection (one event per property, never one per reminder).
 */
export const remindersQuery: AutomationScript = {
  name: 'remindersQuery',
  app: 'Reminders',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Reminders');
    var coll = input.list === null ? app.reminders : findList(app, input.list).reminders;
    var sel = input.status === 'open' ? coll.whose({ completed: false }) : (input.status === 'completed' ? coll.whose({ completed: true }) : coll);
    var ids = sel.id();
    var items = [];
    if (ids.length > 0) {
      var names = sel.name(), bodies = sel.body(), dues = sel.dueDate(), alldays = sel.alldayDueDate(), prios = sel.priority(), lists = sel.container.name();
      var dones = input.status === 'all' ? sel.completed() : null;
      var compl = input.status === 'open' ? null : sel.completionDate();
      var from = input.dueFrom ? new Date(input.dueFrom).getTime() : null;
      var to = input.dueTo ? new Date(input.dueTo).getTime() : null;
      var text = input.text ? String(input.text).toLowerCase() : null;
      for (var i = 0; i < ids.length; i++) {
        var due = dues[i] ? dues[i].getTime() : null;
        var ad = alldays[i] ? alldays[i].getTime() : null;
        var when = due !== null ? due : ad;
        if (from !== null && (when === null || when < from)) continue;
        if (to !== null && (when === null || when >= to)) continue;
        if (text !== null) {
          var hay = String(names[i] || '').toLowerCase() + '\n' + String(bodies[i] || '').toLowerCase();
          if (hay.indexOf(text) < 0) continue;
        }
        items.push({
          id: ids[i], title: names[i] || '', notes: bodies[i] || '', list: lists[i] || '',
          completed: dones ? !!dones[i] : input.status === 'completed',
          completionDate: compl && compl[i] ? compl[i].toISOString() : null,
          due: dues[i] ? dues[i].toISOString() : null, alldayDue: alldays[i] ? alldays[i].toISOString() : null,
          priority: prios[i] || 0
        });
      }
    }
    var total = items.length;
    var key = function (r) { return r.due !== null ? r.due : (r.alldayDue !== null ? r.alldayDue : null); };
    items.sort(function (a, b) {
      if (input.status === 'completed') return String(b.completionDate || '').localeCompare(String(a.completionDate || ''));
      var ka = key(a), kb = key(b);
      if (ka === null && kb === null) return String(a.title).localeCompare(String(b.title));
      if (ka === null) return 1;
      if (kb === null) return -1;
      return ka < kb ? -1 : (ka > kb ? 1 : String(a.title).localeCompare(String(b.title)));
    });
    return JSON.stringify({ ok: true, data: { total: total, items: items.slice(0, input.limit) } });
  } catch (e) {
    return fail(e);
  }
}
function findList(app, name) {
  var names = app.lists.name();
  var want = String(name).trim().toLowerCase();
  var idx = [];
  for (var i = 0; i < names.length; i++) if (String(names[i]).trim().toLowerCase() === want) idx.push(i);
  if (idx.length === 0) throw { code: 'LIST_NOT_FOUND', msg: 'No reminder list with this name.' };
  if (idx.length > 1) throw { code: 'LIST_AMBIGUOUS', msg: 'Several reminder lists have this name.' };
  return app.lists()[idx[0]];
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
