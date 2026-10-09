import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MAX_COMPLETE_PER_CALL } from '../core/permissions.js';
import type { ReminderService } from '../core/reminders/service.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const status = z.enum(['open', 'completed', 'all']);
const priority = z.enum(['none', 'low', 'medium', 'high']);
const listName = z.string().min(1).max(100);
const dueText = (what: string) => z.string().min(1).max(40).describe(what);

// strictObject: unknown fields (for example "delete" or "shared_list") are rejected, not silently ignored.
export const createReminderSchema = z.strictObject({
  title: z.string().min(1).max(300),
  notes: z.string().max(5000).optional(),
  due: dueText('Due date: "2026-10-20" (date only) or "2026-10-20T14:30:00" (with time; without a time zone the default time zone applies).').optional(),
  priority: priority.optional(),
  list: listName.optional().describe('Name of the reminder list. If omitted: the default list of the Reminders app.'),
});

export const updateReminderSchema = z.strictObject({
  id: z.string().min(10).max(100).describe('ID of the reminder from list_reminders / search_reminders, unchanged.'),
  title: z.string().min(1).max(400).describe('CURRENT title of the reminder as shown by list_reminders/search_reminders. Checked against the reminder; if it does not match, nothing is changed.'),
  new_title: z.string().min(1).max(300).optional(),
  notes: z.string().max(5000).optional().describe('Replaces the notes. An empty string removes them.'),
  due: z.string().max(40).optional().describe('New due date ("2026-10-20" or "2026-10-20T14:30:00"). An empty string removes the due date.'),
  priority: priority.optional(),
});

export const completeReminderSchema = z.strictObject({
  reminders: z
    .array(
      z.strictObject({
        id: z.string().min(10).max(100).describe('ID of the reminder, unchanged.'),
        title: z.string().min(1).max(400).describe('Title of the reminder as shown. Checked against the reminder; if it does not match, nothing is changed.'),
      }),
    )
    .min(1)
    .max(MAX_COMPLETE_PER_CALL),
  completed: z.boolean().default(true).describe('true = mark as completed, false = open again.'),
});

export function registerReminderTools(server: McpServer, reminders: ReminderService): void {
  server.registerTool(
    'list_reminder_lists',
    {
      title: 'List reminder lists',
      description: 'Lists the lists of the Apple Reminders app on this Mac with the number of open reminders and which one is the default list. Whether a list is shared cannot be determined. Read-only. Takes a few seconds.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('list_reminder_lists', async () => {
        const l = await reminders.listLists();
        return dataResult({ summary: `${l.length} reminder lists.`, source: 'the Apple Reminders app (list names)', data: l });
      }),
  );

  server.registerTool(
    'list_reminders',
    {
      title: 'List reminders',
      description:
        'Lists reminders of the Apple Reminders app, from one list or all lists: open (default), completed or all, optionally with a due date between due_from and due_to (inclusive days), soonest first. ' +
        'Each reminder has id, title, notes, list, completed, due (a date, or a time with due_has_time) and priority. Read-only. Takes a few seconds.',
      inputSchema: z.object({
        list: listName.optional().describe('Name of a list. If omitted: all lists.'),
        status: status.default('open'),
        due_from: z.string().min(10).max(10).optional().describe('First due day as YYYY-MM-DD.'),
        due_to: z.string().min(10).max(10).optional().describe('Last due day as YYYY-MM-DD.'),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('list_reminders', async () => {
        const r = await reminders.list({ list: a.list, status: a.status, dueFrom: a.due_from, dueTo: a.due_to, limit: a.limit });
        return dataResult({
          summary: `${r.total} reminders${r.cut ? `, showing the first ${r.reminders.length}` : ''}.`,
          source: 'the Apple Reminders app',
          data: r.reminders,
          notes: r.cut ? ['Result truncated. Narrow it with list, status or a due range.'] : [],
        });
      }),
  );

  server.registerTool(
    'search_reminders',
    {
      title: 'Search reminders',
      description: 'Searches the titles and notes of reminders (case-insensitive), in one list or all lists, open, completed or all (default). Read-only. Takes a few seconds.',
      inputSchema: z.object({
        query: z.string().min(1).max(100),
        list: listName.optional(),
        status: status.default('all'),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('search_reminders', async () => {
        const r = await reminders.search({ query: a.query, list: a.list, status: a.status, limit: a.limit });
        return dataResult({
          summary: `${r.total} reminders found${r.cut ? `, showing the first ${r.reminders.length}` : ''}.`,
          source: 'the Apple Reminders app',
          data: r.reminders,
          notes: r.cut ? ['Result truncated. Narrow the search.'] : [],
        });
      }),
  );

  server.registerTool(
    'create_reminder',
    {
      title: 'Create reminder',
      description:
        'Creates ONE reminder in the Apple Reminders app, with an optional due date (date only or with time), notes, priority and list. Without `list` it goes into the default list. ' +
        'Because Apple does not tell whether a list is shared, name the list explicitly when the user means a particular one. Does not change or delete anything else.',
      inputSchema: createReminderSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (a) =>
      guarded('create_reminder', async () => {
        const r = await reminders.create({ title: a.title, notes: a.notes, due: a.due, priority: a.priority, list: a.list });
        return dataResult({ summary: `Reminder created in list "${r.list}".`, source: 'the reminder just created', data: r.reminder });
      }),
  );

  server.registerTool(
    'update_reminder',
    {
      title: 'Update reminder',
      description:
        'Changes ONE reminder: title (new_title), notes, due date or priority. Requires the id and the CURRENT title; the title is checked against the reminder and nothing is changed if it does not match. ' +
        'Returns before and after of the changed fields. Cannot complete or delete reminders (see complete_reminder).',
      inputSchema: updateReminderSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a) =>
      guarded('update_reminder', async () => {
        const r = await reminders.update({ id: a.id, title: a.title, newTitle: a.new_title, notes: a.notes, due: a.due, priority: a.priority });
        return dataResult({ summary: `Reminder updated (${r.changed.join(', ')}).`, source: 'the updated reminder', data: r });
      }),
  );

  server.registerTool(
    'complete_reminder',
    {
      title: 'Complete reminders',
      description:
        `Marks reminders as completed (default) or open again (completed=false), up to ${MAX_COMPLETE_PER_CALL} per call. Requires id and title of every reminder; if one does not match, NOTHING is changed. Cannot delete reminders.`,
      inputSchema: completeReminderSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) =>
      guarded('complete_reminder', async () => {
        const r = await reminders.complete({ items: a.reminders, completed: a.completed });
        return dataResult({ summary: `${r.count} reminder(s) marked ${r.completed ? 'completed' : 'open'}.`, source: 'the reminders just changed', data: r });
      }),
  );
}
