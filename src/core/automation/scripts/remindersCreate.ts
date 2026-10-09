import type { AutomationScript } from '../runner.js';

/**
 * Creates ONE reminder in the named list (or in the default list) and reads it back. The due date arrives as {date: "YYYY-MM-DD"} (all day)
 * or {iso: "<ISO 8601>"}; the Date objects are created here, never from localized date text.
 */
export const remindersCreate: AutomationScript = {
  name: 'remindersCreate',
  app: 'Reminders',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Reminders');
    var list = input.list === null ? app.defaultList() : findList(app, input.list);
    var props = { name: String(input.title) };
    if (input.notes) props.body = String(input.notes);
    if (input.priority !== null) props.priority = input.priority;
    if (input.due && input.due.date) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.due.date);
      if (!m) throw { code: 'BAD_DATE', msg: 'The date is invalid.' };
      props.alldayDueDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else if (input.due && input.due.iso) {
      var t = new Date(input.due.iso);
      if (isNaN(t.getTime())) throw { code: 'BAD_DATE', msg: 'The date is invalid.' };
      props.dueDate = t;
    }
    var r = app.Reminder(props);
    list.reminders.push(r);
    var id = r.id();
    var back = app.reminders.byId(id);
    var d = back.dueDate(), a = back.alldayDueDate();
    return JSON.stringify({ ok: true, data: {
      id: id, title: back.name() || '', notes: back.body() || '', list: back.container().name(), completed: !!back.completed(),
      completionDate: null, due: d ? d.toISOString() : null, alldayDue: a ? a.toISOString() : null, priority: back.priority() || 0
    } });
  } catch (e) {
    return fail(e);
  }
}
function findList(app, name) {
  var lists = app.lists();
  var want = String(name).trim().toLowerCase();
  var hits = [];
  for (var i = 0; i < lists.length; i++) if (String(lists[i].name()).trim().toLowerCase() === want) hits.push(lists[i]);
  if (hits.length === 0) throw { code: 'LIST_NOT_FOUND', msg: 'No reminder list with this name.' };
  if (hits.length > 1) throw { code: 'LIST_AMBIGUOUS', msg: 'Several reminder lists have this name.' };
  return hits[0];
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
