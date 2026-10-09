import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Config } from '../config.js';
import { UserError } from '../errors.js';
import { remindersComplete } from '../automation/scripts/remindersComplete.js';
import { remindersCreate } from '../automation/scripts/remindersCreate.js';
import { remindersGet } from '../automation/scripts/remindersGet.js';
import { remindersLists } from '../automation/scripts/remindersLists.js';
import { remindersQuery } from '../automation/scripts/remindersQuery.js';
import { remindersUpdate } from '../automation/scripts/remindersUpdate.js';
import { AutomationRefusal, type ScriptRunner } from '../automation/runner.js';
import { authorizeReminderComplete, authorizeReminderCreate, authorizeReminderUpdate, ReminderGrant, type ReminderListFacts } from '../permissions.js';
import { clip, sameText } from '../untrusted.js';

const MAX_LIMIT = 100;

export type Priority = 'none' | 'low' | 'medium' | 'high';
const PRIORITY_VALUE: Record<Priority, number> = { none: 0, high: 1, medium: 5, low: 9 };

/** Apple's priorities are 0 (none), 1-4 (high), 5 (medium), 6-9 (low). */
export function priorityOf(n: number): Priority {
  return n === 0 ? 'none' : n <= 4 ? 'high' : n === 5 ? 'medium' : 'low';
}

const iso = z.string().nullable();
const rawReminder = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string(),
  list: z.string(),
  completed: z.boolean(),
  completionDate: iso,
  due: iso,
  alldayDue: iso,
  priority: z.number(),
});
export type RawReminder = z.infer<typeof rawReminder>;
const rawList = z.object({ id: z.string(), name: z.string(), open: z.number(), isDefault: z.boolean() });
const queryOut = z.object({ total: z.number(), items: z.array(rawReminder) });
const rawBasic = z.object({ id: z.string(), title: z.string(), list: z.string(), completed: z.boolean() });
export type RawBasic = z.infer<typeof rawBasic>;
const dueState = z.object({ due: iso, alldayDue: iso });
const fieldMap = z.object({ title: z.string().optional(), notes: z.string().optional(), priority: z.number().optional(), due: dueState.optional() });
const updateOut = z.object({ id: z.string(), before: fieldMap, after: fieldMap });
export type UpdateOut = z.infer<typeof updateOut>;
const changedOut = z.object({ changed: z.number() });
const getOut = z.array(rawBasic.nullable());

/** What a due date looks like to the caller. */
export interface ReminderView {
  id: string;
  title: string;
  notes?: string;
  list: string;
  completed: boolean;
  completedAt?: string;
  /** "YYYY-MM-DD" for a reminder with a date only, otherwise a time in the configured time zone. */
  due?: string;
  dueHasTime?: boolean;
  priority: Priority;
}

export type DueInput = { date: string } | { iso: string };

/** Date only ("2026-10-20") or date with time ("2026-10-20T14:30:00", configured time zone unless an offset is given). */
export function parseDue(input: string, zone: string): DueInput {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (!DateTime.fromISO(s).isValid) throw new UserError(`The date "${s}" is invalid. Expected: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS.`);
    return { date: s };
  }
  const dt = DateTime.fromISO(s, { zone });
  if (!dt.isValid) throw new UserError(`The due date "${clip(s, 40)}" is invalid. Expected: 2026-10-20 (date only) or 2026-10-20T14:30:00 (with time).`);
  return { iso: dt.toUTC().toISO({ suppressMilliseconds: true })! };
}

/** The backend: all Apple Reminders access. Writing methods need a ReminderGrant. */
export interface ReminderBackend {
  lists(countOpen: boolean): Promise<Array<z.infer<typeof rawList>>>;
  query(a: { list: string | null; status: 'open' | 'completed' | 'all'; dueFrom: string | null; dueTo: string | null; text: string | null; limit: number }): Promise<{ total: number; items: RawReminder[] }>;
  get(ids: string[]): Promise<Array<RawBasic | null>>;
  create(grant: ReminderGrant, a: { title: string; notes: string | null; due: DueInput | null; priority: number | null }): Promise<RawReminder>;
  update(grant: ReminderGrant, a: { id: string; expectedTitle: string; patch: { title: string | null; notes: string | null; due: DueInput | false | null; priority: number | null } }): Promise<UpdateOut>;
  complete(grant: ReminderGrant, a: { items: Array<{ id: string; expectedTitle: string }>; completed: boolean }): Promise<{ changed: number }>;
}

const reword = (e: unknown): never => {
  if (e instanceof AutomationRefusal) {
    if (e.code === 'LIST_NOT_FOUND') throw new UserError('Reminder list not found. Use list_reminder_lists to see the lists.');
    if (e.code === 'NOT_FOUND') throw new UserError('The reminder was not found. It may have been deleted; please search again. Nothing was changed.');
    if (e.code === 'CHANGED') throw new UserError('The title does not match the reminder with this ID (or it changed in the meantime). Nothing was changed. Fetch the reminder again with list_reminders or search_reminders and copy the title unchanged.');
  }
  throw e;
};

export class JxaReminders implements ReminderBackend {
  constructor(private readonly runner: ScriptRunner) {}

  lists(countOpen: boolean) {
    return this.runner.run(remindersLists, { countOpen }, z.array(rawList));
  }
  query(a: Parameters<ReminderBackend['query']>[0]) {
    return this.runner.run(remindersQuery, a, queryOut).catch(reword);
  }
  get(ids: string[]) {
    return this.runner.run(remindersGet, { ids }, getOut);
  }
  async create(grant: ReminderGrant, a: Parameters<ReminderBackend['create']>[1]) {
    if (!ReminderGrant.isValid(grant, 'create')) throw new Error('Write access without a grant');
    return this.runner.run(remindersCreate, { list: grant.list, ...a }, rawReminder).catch(reword);
  }
  async update(grant: ReminderGrant, a: Parameters<ReminderBackend['update']>[1]) {
    if (!ReminderGrant.isValid(grant, 'update')) throw new Error('Write access without a grant');
    return this.runner.run(remindersUpdate, a, updateOut).catch(reword);
  }
  async complete(grant: ReminderGrant, a: Parameters<ReminderBackend['complete']>[1]) {
    if (!ReminderGrant.isValid(grant, 'complete') || a.items.length > grant.count) throw new Error('Write access without a grant');
    return this.runner.run(remindersComplete, a, changedOut).catch(reword);
  }
}

export interface ListInput {
  list?: string | undefined;
  status?: 'open' | 'completed' | 'all' | undefined;
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
  limit?: number | undefined;
}

export interface UpdateInput {
  id: string;
  /** Current title as shown; checked against the reminder. */
  title: string;
  newTitle?: string | undefined;
  notes?: string | undefined;
  /** New due date; an empty string removes it. */
  due?: string | undefined;
  priority?: Priority | undefined;
}

export class ReminderService {
  constructor(
    private readonly cfg: Config,
    private readonly backend: ReminderBackend,
  ) {}

  /** Timed due dates are shown in the configured time zone; a date without time is a local date of the Mac (stored as local midnight there). */
  private view(r: RawReminder): ReminderView {
    const zone = this.cfg.timezone;
    let due: string | undefined;
    let hasTime: boolean | undefined;
    if (r.due) {
      due = DateTime.fromISO(r.due).setZone(zone).toISO({ suppressMilliseconds: true }) ?? undefined;
      hasTime = true;
    } else if (r.alldayDue) {
      due = DateTime.fromISO(r.alldayDue).setZone('system').toISODate() ?? undefined;
      hasTime = false;
    }
    return {
      id: r.id,
      title: clip(r.title, 300),
      ...(r.notes ? { notes: clip(r.notes, 2000) } : {}),
      list: clip(r.list, 100),
      completed: r.completed,
      ...(r.completionDate ? { completedAt: DateTime.fromISO(r.completionDate).setZone(zone).toISO({ suppressMilliseconds: true })! } : {}),
      ...(due ? { due, dueHasTime: hasTime } : {}),
      priority: priorityOf(r.priority),
    };
  }

  async listLists() {
    const lists = await this.backend.lists(true);
    return lists.map((l) => ({ name: clip(l.name, 100), openReminders: l.open, ...(l.isDefault ? { isDefault: true as const } : {}) }));
  }

  async list(a: ListInput) {
    const zone = this.cfg.timezone;
    const from = a.dueFrom ? DateTime.fromISO(a.dueFrom.trim(), { zone }).startOf('day') : undefined;
    const to = a.dueTo ? DateTime.fromISO(a.dueTo.trim(), { zone }).startOf('day').plus({ days: 1 }) : undefined;
    if ((from && !from.isValid) || (to && !to.isValid)) throw new UserError('due_from and due_to must be dates like 2026-10-20.');
    const r = await this.backend.query({
      list: a.list?.trim() || null,
      status: a.status ?? 'open',
      dueFrom: from ? from.toUTC().toISO() : null,
      dueTo: to ? to.toUTC().toISO() : null,
      text: null,
      limit: Math.min(a.limit ?? 50, MAX_LIMIT),
    });
    return { total: r.total, reminders: r.items.map((x) => this.view(x)), cut: r.total > r.items.length };
  }

  async search(a: { query: string; list?: string | undefined; status?: 'open' | 'completed' | 'all' | undefined; limit?: number | undefined }) {
    const q = a.query.trim();
    if (!q) throw new UserError('The search term must not be empty. Please provide a search term.');
    const r = await this.backend.query({ list: a.list?.trim() || null, status: a.status ?? 'all', dueFrom: null, dueTo: null, text: q, limit: Math.min(a.limit ?? 30, MAX_LIMIT) });
    return { total: r.total, reminders: r.items.map((x) => this.view(x)), cut: r.total > r.items.length };
  }

  async create(a: { title: string; notes?: string | undefined; due?: string | undefined; priority?: Priority | undefined; list?: string | undefined }) {
    const title = a.title.trim();
    if (!title) throw new UserError('The title must not be empty. Please provide a title.');
    const due = a.due?.trim() ? parseDue(a.due, this.cfg.timezone) : null;
    // Permissions first: without a grant nothing is written.
    const lists = await this.backend.lists(false);
    const grant = authorizeReminderCreate({ lists: lists as ReminderListFacts[], list: a.list?.trim() || undefined });
    const made = await this.backend.create(grant, { title, notes: a.notes?.trim() || null, due, priority: a.priority ? PRIORITY_VALUE[a.priority] : null });
    return { reminder: this.view(made), list: made.list };
  }

  private checkId(id: string): void {
    if (!/^x-apple-reminder:\/\/[0-9A-Fa-f-]{8,64}$/.test(id)) throw new UserError('Invalid reminder ID. Use the id from list_reminders or search_reminders unchanged.');
  }

  async update(a: UpdateInput) {
    const touched = a.newTitle !== undefined || a.notes !== undefined || a.due !== undefined || a.priority !== undefined;
    if (!touched) throw new UserError('No change specified. Please provide at least one of new_title, notes, due or priority.');
    if (a.newTitle !== undefined && !a.newTitle.trim()) throw new UserError('The title must not be empty.');
    if (!a.title.trim()) throw new UserError('The title must not be empty. Please give the current title of the reminder as it is displayed.');
    this.checkId(a.id);
    const due: DueInput | false | null = a.due === undefined ? null : a.due.trim() === '' ? false : parseDue(a.due, this.cfg.timezone);
    const grant = authorizeReminderUpdate();
    // The script compares the title (ignoring case and spacing) before it changes anything.
    const r = await this.backend.update(grant, {
      id: a.id,
      expectedTitle: a.title,
      patch: { title: a.newTitle === undefined ? null : a.newTitle.trim(), notes: a.notes === undefined ? null : a.notes.trim(), due, priority: a.priority === undefined ? null : PRIORITY_VALUE[a.priority] },
    });
    const dueView = (d: { due: string | null; alldayDue: string | null }) => this.view({ id: a.id, title: '', notes: '', list: '', completed: false, completionDate: null, ...d, priority: 0 }).due ?? null;
    const show = (m: UpdateOut['before']) => ({
      ...(m.title !== undefined ? { title: clip(m.title, 300) } : {}),
      ...(m.notes !== undefined ? { notes: clip(m.notes, 2000) } : {}),
      ...(m.priority !== undefined ? { priority: priorityOf(m.priority) } : {}),
      ...(m.due !== undefined ? { due: dueView(m.due) } : {}),
    });
    return { id: r.id, before: show(r.before), after: show(r.after), changed: Object.keys(r.after) };
  }

  async complete(a: { items: Array<{ id: string; title: string }>; completed: boolean }) {
    const grant = authorizeReminderComplete(a.items.length);
    const ids = a.items.map((i) => i.id);
    if (new Set(ids).size !== ids.length) throw new UserError('The same reminder was specified more than once. Nothing was changed.');
    for (const id of ids) this.checkId(id);
    const found = await this.backend.get(ids);
    const problems: string[] = [];
    found.forEach((r, i) => {
      if (!r) problems.push(`Reminder ${i + 1}: not found`);
      else if (!sameText(a.items[i]!.title, r.title)) problems.push(`Reminder ${i + 1}: the title does not match the reminder with this ID`);
    });
    if (problems.length) throw new UserError(`${problems.join('; ')}. Nothing was changed. Fetch the reminders again with list_reminders or search_reminders and copy id and title unchanged.`);
    const raws = found as RawBasic[];
    const done = await this.backend.complete(grant, { items: raws.map((r) => ({ id: r.id, expectedTitle: r.title })), completed: a.completed });
    if (done.changed !== raws.length) throw new UserError(`Only ${done.changed} of ${raws.length} reminders show the new state. Please check in Reminders.`);
    return {
      count: raws.length,
      completed: a.completed,
      reminders: raws.map((r) => ({ id: r.id, title: clip(r.title, 300), list: clip(r.list, 100), wasCompleted: r.completed })),
    };
  }
}
