import type { AutomationScript } from '../runner.js';

/**
 * Changes ONE reminder: title, notes, due date, priority. `expectedTitle` is the title the caller saw; it must match (ignoring case and spacing),
 * otherwise nothing is changed. A due of null leaves it (JXA cannot clear a due date; setting it to undefined writes the year 1903). Returns before and after of every touched field. Never deletes anything.
 */
export const remindersUpdate: AutomationScript = {
  name: 'remindersUpdate',
  app: 'Reminders',
  source: String.raw`
function run(argv) {
  try {
    var input = JSON.parse(argv[0]);
    var app = Application('Reminders');
    var r = app.reminders.byId(input.id);
    var name;
    try { name = r.name(); } catch (e) { throw { code: 'NOT_FOUND', msg: 'The reminder was not found.' }; }
    if (norm(name) !== norm(input.expectedTitle)) throw { code: 'CHANGED', msg: 'The title does not match the reminder.' };
    var p = input.patch;
    var due = null;
    if (p.due && p.due.date) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.due.date);
      if (!m) throw { code: 'BAD_DATE', msg: 'The date is invalid.' };
      due = { all: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) };
    } else if (p.due && p.due.iso) {
      var t = new Date(p.due.iso);
      if (isNaN(t.getTime())) throw { code: 'BAD_DATE', msg: 'The date is invalid.' };
      due = { at: t };
    }
    var before = {}, after = {};
    var dueState = function () { var d = r.dueDate(), a = r.alldayDueDate(); return { due: d ? d.toISOString() : null, alldayDue: a ? a.toISOString() : null }; };
    if (p.title !== null) { before.title = name; r.name = String(p.title); after.title = r.name(); }
    if (p.notes !== null) { before.notes = r.body() || ''; r.body = String(p.notes); after.notes = r.body() || ''; }
    if (p.priority !== null) { before.priority = r.priority() || 0; r.priority = p.priority; after.priority = r.priority() || 0; }
    if (due !== null) {
      before.due = dueState();
      if (due.at) { r.dueDate = due.at; }
      else { r.alldayDueDate = due.all; }
      after.due = dueState();
    }
    return JSON.stringify({ ok: true, data: { id: r.id(), before: before, after: after } });
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
