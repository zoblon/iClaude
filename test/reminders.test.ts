import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AutomationScript, ScriptRunner } from '../src/core/automation/runner.js';
import { AutomationRefusal } from '../src/core/automation/runner.js';
import { UserError } from '../src/core/errors.js';
import { JxaReminders, ReminderService, parseDue, priorityOf, type RawBasic, type RawReminder, type ReminderBackend, type UpdateOut } from '../src/core/reminders/service.js';
import { authorizeReminderComplete, authorizeReminderCreate, ReminderGrant } from '../src/core/permissions.js';
import { completeReminderSchema, createReminderSchema, updateReminderSchema } from '../src/mcp/reminderTools.js';
import { cfg } from './fakeStore.js';

const id = (n: number) => `x-apple-reminder://0000000${n}-AAAA-BBBB-CCCC-DDDDEEEEFFFF`;
const raw = (n: number, over: Partial<RawReminder> = {}): RawReminder => ({
  id: id(n), title: `Reminder ${n}`, notes: '', list: 'Home', completed: false, completionDate: null, due: null, alldayDue: null, priority: 0, ...over,
});

/** In-memory Reminders: records what would be written. */
class FakeBackend implements ReminderBackend {
  items: RawReminder[] = [raw(1), raw(2, { list: 'Work', due: '2026-10-20T12:30:00.000Z', priority: 1 }), raw(3, { completed: true, completionDate: '2026-10-01T08:00:00.000Z' })];
  lists_ = [{ id: 'l1', name: 'Home', open: 1, isDefault: true }, { id: 'l2', name: 'Work', open: 1, isDefault: false }, { id: 'l3', name: 'iClaude Test', open: 0, isDefault: false }];
  writes: string[] = [];
  lastQuery: unknown;
  async lists() {
    return this.lists_;
  }
  async query(a: Parameters<ReminderBackend['query']>[0]) {
    this.lastQuery = a;
    return { total: this.items.length, items: this.items.slice(0, a.limit) };
  }
  async get(ids: string[]): Promise<Array<RawBasic | null>> {
    return ids.map((i) => this.items.find((x) => x.id === i) ?? null).map((x) => (x ? { id: x.id, title: x.title, list: x.list, completed: x.completed } : null));
  }
  async create(grant: ReminderGrant, a: Parameters<ReminderBackend['create']>[1]) {
    if (!ReminderGrant.isValid(grant, 'create')) throw new Error('Write access without a grant');
    this.writes.push(`create:${grant.list}`);
    const r = raw(9, { title: a.title, notes: a.notes ?? '', list: grant.list ?? 'Home', priority: a.priority ?? 0, ...(a.due && 'iso' in a.due ? { due: a.due.iso } : a.due ? { alldayDue: `${a.due.date}T00:00:00.000Z` } : {}) });
    this.items.push(r);
    return r;
  }
  async update(grant: ReminderGrant, a: Parameters<ReminderBackend['update']>[1]): Promise<UpdateOut> {
    if (!ReminderGrant.isValid(grant, 'update')) throw new Error('Write access without a grant');
    const r = this.items.find((x) => x.id === a.id);
    if (!r) throw new UserError('The reminder was not found. Nothing was changed.');
    if (r.title.toLowerCase() !== a.expectedTitle.trim().toLowerCase()) throw new UserError('The title does not match the reminder with this ID. Nothing was changed.');
    this.writes.push('update');
    const before: UpdateOut['before'] = {};
    const after: UpdateOut['after'] = {};
    if (a.patch.title !== null) { before.title = r.title; r.title = a.patch.title; after.title = r.title; }
    if (a.patch.notes !== null) { before.notes = r.notes; r.notes = a.patch.notes; after.notes = r.notes; }
    if (a.patch.priority !== null) { before.priority = r.priority; r.priority = a.patch.priority; after.priority = r.priority; }
    return { id: r.id, before, after };
  }
  async complete(grant: ReminderGrant, a: Parameters<ReminderBackend['complete']>[1]) {
    if (!ReminderGrant.isValid(grant, 'complete')) throw new Error('Write access without a grant');
    this.writes.push(`complete:${a.items.length}:${a.completed}`);
    for (const i of a.items) this.items.find((x) => x.id === i.id)!.completed = a.completed;
    return { changed: a.items.length };
  }
}

let backend: FakeBackend;
let svc: ReminderService;
beforeEach(() => {
  backend = new FakeBackend();
  svc = new ReminderService(cfg, backend);
});

describe('reading', () => {
  it('shows due dates in the configured time zone, date-only reminders as dates, and priorities in words', async () => {
    backend.items.push(raw(4, { alldayDue: '2026-10-21T22:00:00.000Z', priority: 5 }));
    backend.items.push(raw(5, { due: '2026-10-22T22:00:00.000Z', alldayDue: '2026-10-22T22:00:00.000Z' }));
    const r = await svc.list({});
    const two = r.reminders.find((x) => x.title === 'Reminder 2')!;
    expect(two).toMatchObject({ due: '2026-10-20T14:30:00+02:00', dueHasTime: true, priority: 'high', list: 'Work' });
    const four = r.reminders.find((x) => x.title === 'Reminder 4')!;
    expect(four.dueHasTime).toBe(false);
    expect(four.due).toMatch(/^2026-10-2[12]$/); // a local date of the Mac
    expect(four.priority).toBe('medium');
    // dueDate and alldayDueDate are the same moment: a date without a time, as Reminders stores it
    expect(r.reminders.find((x) => x.title === 'Reminder 5')!.dueHasTime).toBe(false);
    expect([0, 1, 4, 5, 6, 9].map(priorityOf)).toEqual(['none', 'high', 'high', 'medium', 'low', 'low']);
  });

  it('passes list, status, due range (whole days) and limit to the script', async () => {
    await svc.list({ list: ' Work ', status: 'completed', dueFrom: '2026-10-20', dueTo: '2026-10-21', limit: 7 });
    expect(backend.lastQuery).toEqual({ list: 'Work', status: 'completed', dueFrom: '2026-10-19T22:00:00.000Z', dueTo: '2026-10-21T22:00:00.000Z', text: null, limit: 7 });
    await svc.search({ query: ' milk ' });
    expect(backend.lastQuery).toMatchObject({ text: 'milk', status: 'all', list: null });
    await expect(svc.search({ query: '  ' })).rejects.toThrow(/must not be empty/);
    await expect(svc.list({ dueFrom: 'soon' })).rejects.toThrow(/due_from/);
  });

  it('lists the lists with open counts and the default list', async () => {
    expect(await svc.listLists()).toEqual([{ name: 'Home', openReminders: 1, isDefault: true }, { name: 'Work', openReminders: 1 }, { name: 'iClaude Test', openReminders: 0 }]);
  });
});

describe('create_reminder', () => {
  it('creates in the named list or, without a name, in the default list', async () => {
    const a = await svc.create({ title: ' Buy milk ', list: 'iclaude test', due: '2026-10-22T09:00:00', priority: 'high', notes: 'Oat' });
    expect(backend.writes).toEqual(['create:iclaude test']); // the script finds the list ignoring case
    expect(a.reminder).toMatchObject({ title: 'Buy milk', list: 'iclaude test', due: '2026-10-22T09:00:00+02:00', priority: 'high', notes: 'Oat' });
    await svc.create({ title: 'Default' });
    expect(backend.writes[1]).toBe('create:null');
  });

  it('turns dates into ISO instants (time) or plain dates (all day), never into localized text', () => {
    expect(parseDue('2026-10-22T09:00:00', 'Europe/Berlin')).toEqual({ iso: '2026-10-22T07:00:00Z' });
    expect(parseDue('2026-10-22T09:00:00+00:00', 'Europe/Berlin')).toEqual({ iso: '2026-10-22T09:00:00Z' });
    expect(parseDue('2026-10-22', 'Europe/Berlin')).toEqual({ date: '2026-10-22' });
    for (const bad of ['tomorrow', '2026-13-40', '22.10.2026', '']) expect(() => parseDue(bad, 'Europe/Berlin'), bad).toThrow();
  });

  it('refuses empty titles, bad dates and empty list names, and writes nothing', async () => {
    await expect(svc.create({ title: '  ' })).rejects.toThrow(/must not be empty/);
    await expect(svc.create({ title: 'x', due: 'garbage' })).rejects.toThrow(/invalid/);
    await expect(svc.create({ title: 'x', list: '   ' })).resolves.toBeTruthy(); // a blank name counts as no name: the default list
    expect(backend.writes).toEqual(['create:null']);
  });

  it('the schema takes no fields for deleting, sharing or the id', () => {
    expect(createReminderSchema.safeParse({ title: 'x', list: 'Home' }).success).toBe(true);
    for (const f of ['delete', 'shared_list', 'id', 'completed', 'url']) expect(createReminderSchema.safeParse({ title: 'x', [f]: 'x' }).success, f).toBe(false);
  });
});

describe('update_reminder and complete_reminder', () => {
  it('updates only after the title matches and returns before and after', async () => {
    const r = await svc.update({ id: id(1), title: ' reminder 1 ', newTitle: 'Renamed', priority: 'low', notes: 'Hello' });
    expect(r.changed.sort()).toEqual(['notes', 'priority', 'title']);
    expect(r.before).toEqual({ title: 'Reminder 1', notes: '', priority: 'none' });
    expect(r.after).toEqual({ title: 'Renamed', notes: 'Hello', priority: 'low' });
  });

  it('changes nothing for a wrong title, an unknown or malformed ID, or an empty change', async () => {
    await expect(svc.update({ id: id(1), title: 'Something else', newTitle: 'x' })).rejects.toThrow(/title does not match/);
    await expect(svc.update({ id: id(7), title: 'Reminder 7', newTitle: 'x' })).rejects.toThrow(/not found/);
    await expect(svc.update({ id: 'bogus', title: 'x', newTitle: 'x' })).rejects.toThrow(/Invalid reminder ID/);
    await expect(svc.update({ id: id(1), title: 'Reminder 1' })).rejects.toThrow(/No change specified/);
    await expect(svc.update({ id: id(1), title: 'Reminder 1', newTitle: ' ' })).rejects.toThrow(/must not be empty/);
    await expect(svc.update({ id: id(1), title: 'Reminder 1', due: '' })).rejects.toThrow(/Removing a due date is not possible/);
    expect(backend.items[0]!.title).toBe('Reminder 1');
    expect(backend.writes).toEqual([]);
  });

  it('completes several reminders after checking every title; one mismatch changes nothing', async () => {
    const ok = await svc.complete({ items: [{ id: id(1), title: 'Reminder 1' }, { id: id(2), title: 'reminder 2' }], completed: true });
    expect(ok).toMatchObject({ count: 2, completed: true });
    expect(ok.reminders.map((r) => r.wasCompleted)).toEqual([false, false]);
    expect(backend.items.filter((i) => i.completed)).toHaveLength(3);
    backend.writes.length = 0;
    await expect(svc.complete({ items: [{ id: id(1), title: 'Reminder 1' }, { id: id(2), title: 'Wrong' }], completed: false })).rejects.toThrow(/Reminder 2: the title does not match.*Nothing was changed/s);
    await expect(svc.complete({ items: [{ id: id(1), title: 'Reminder 1' }, { id: id(1), title: 'Reminder 1' }], completed: true })).rejects.toThrow(/more than once/);
    expect(backend.writes).toEqual([]);
  });

  it('allows at most 20 per call and needs at least one', async () => {
    expect(() => authorizeReminderComplete(21)).toThrow(/Too many/);
    expect(() => authorizeReminderComplete(0)).toThrow(/No reminder/);
    const many = Array.from({ length: 21 }, (_, i) => ({ id: id(i), title: 't' }));
    expect(completeReminderSchema.safeParse({ reminders: many }).success).toBe(false);
    expect(updateReminderSchema.safeParse({ id: id(1), title: 'x', delete: true }).success).toBe(false);
  });
});

describe('rights', () => {
  it('writing methods of the real backend refuse forged or wrong grants before any script runs', async () => {
    const calls: string[] = [];
    const runner: ScriptRunner = {
      async run<T>(script: AutomationScript, _i: unknown, _s: z.ZodType<T>): Promise<T> {
        calls.push(script.name);
        throw new Error('must not run');
      },
    };
    const be = new JxaReminders(runner);
    const forged = { op: 'create', list: null, count: 1 } as never;
    await expect(be.create(forged, { title: 'x', notes: null, due: null, priority: null })).rejects.toThrow(/without a grant/);
    await expect(be.update(authorizeReminderComplete(1), { id: id(1), expectedTitle: 'x', patch: { title: 'x', notes: null, due: null, priority: null } })).rejects.toThrow(/without a grant/);
    await expect(be.complete(authorizeReminderCreate({}), { items: [{ id: id(1), expectedTitle: 'x' }], completed: true })).rejects.toThrow(/without a grant/);
    expect(calls).toEqual([]);
  });

  it('the real backend words the refusals of the script', async () => {
    const refuse = (code: string): ScriptRunner => ({
      async run() {
        throw new AutomationRefusal(code, 'raw script text');
      },
    });
    const grant = authorizeReminderComplete(1);
    const items = { items: [{ id: id(1), expectedTitle: 'x' }], completed: true };
    await expect(new JxaReminders(refuse('CHANGED')).complete(grant, items)).rejects.toThrow(/does not match the reminder.*Nothing was changed/s);
    await expect(new JxaReminders(refuse('NOT_FOUND')).complete(grant, items)).rejects.toThrow(/was not found/);
    await expect(new JxaReminders(refuse('LIST_NOT_FOUND')).query({ list: 'x', status: 'open', dueFrom: null, dueTo: null, text: null, limit: 1 })).rejects.toThrow(/list not found/i);
  });

  it('a create grant names its list; the real backend sends exactly that list to the script', async () => {
    const seen: unknown[] = [];
    const runner: ScriptRunner = {
      async run<T>(script: AutomationScript, input: unknown, schema: z.ZodType<T>): Promise<T> {
        seen.push([script.name, input]);
        return schema.parse(raw(5, { list: 'Work' }));
      },
    };
    const grant = authorizeReminderCreate({ list: ' Work ' });
    await new JxaReminders(runner).create(grant, { title: 'T', notes: null, due: null, priority: null });
    expect(seen).toEqual([['remindersCreate', { list: 'Work', title: 'T', notes: null, due: null, priority: null }]]);
  });
});
