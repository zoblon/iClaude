import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MailService } from '../core/mail/service.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const mailbox = z
  .string()
  .min(1)
  .max(100)
  .describe('Folder: path or name from list_mailboxes, or a role: inbox, sent, drafts, archive, junk, trash.');
const day = (what: string) => z.string().min(10).max(10).describe(`${what} as YYYY-MM-DD (inclusive).`);

export function registerMailTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    'list_mailboxes',
    {
      title: 'List mail folders',
      description: 'Lists all mail folders with role (inbox, sent, drafts, archive, junk, trash), number of messages and unread messages. Read-only; nothing is marked as read.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('list_mailboxes', async () => {
        const list = await mail.mailboxes();
        return dataResult({ summary: `${list.length} folders.`, source: 'the iCloud mail account (folder names)', data: list });
      }),
  );

  server.registerTool(
    'unread_counts',
    {
      title: 'Count unread mails',
      description: 'Returns the number of unread messages per mail folder and the total (without junk and trash). Read-only; nothing is marked as read.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('unread_counts', async () => {
        const r = await mail.unreadCounts();
        return dataResult({ summary: `${r.total} unread mails (excluding junk and Trash).`, source: 'the iCloud mail account (folder names)', data: r });
      }),
  );

  server.registerTool(
    'list_recent',
    {
      title: 'List recent mails',
      description:
        'Lists the newest messages of a mail folder (default: inbox), newest first, with sender, recipients, subject, date and unread state. No message text: use get_message with the id. Read-only; nothing is marked as read.',
      inputSchema: z.object({ mailbox: mailbox.optional(), count: z.number().int().min(1).max(50).default(20) }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('list_recent', async () => {
        const r = await mail.listRecent(a.mailbox, a.count);
        return dataResult({ summary: `${r.messages.length} newest messages in "${r.mailbox}".`, source: 'the iCloud mail account (messages)', data: r.messages });
      }),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search mails',
      description:
        'Searches messages by sender, recipient, subject, full text and/or date range, optionally only unread. Without `mailbox` all folders except junk and trash are searched. At least one criterion is required. Returns summaries without text (use get_message). Full-text search in large folders can be slow. Read-only; nothing is marked as read.',
      inputSchema: z.object({
        from: z.string().min(1).max(200).optional().describe('Sender (name or address, substring).'),
        to: z.string().min(1).max(200).optional().describe('Recipient (To or Cc).'),
        subject: z.string().min(1).max(200).optional(),
        text: z.string().min(1).max(200).optional().describe('Full text in headers and body (slower).'),
        since: day('Earliest date').optional(),
        until: day('Latest date').optional(),
        unread_only: z.boolean().default(false),
        mailbox: mailbox.optional(),
        include_junk_and_trash: z.boolean().default(false).describe('When searching all folders, also search junk and Trash.'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('search_messages', async () => {
        const r = await mail.search({
          from: a.from,
          to: a.to,
          subject: a.subject,
          text: a.text,
          since: a.since,
          until: a.until,
          unreadOnly: a.unread_only,
          mailbox: a.mailbox,
          includeJunkAndTrash: a.include_junk_and_trash,
          limit: a.limit,
        });
        return dataResult({
          summary: `${r.total} hits in ${r.searched.length} folders${r.cut ? `, showing the newest ${r.messages.length}` : ''}.`,
          source: 'the iCloud mail account (messages)',
          data: r.messages,
          notes: [
            ...(r.cut ? ['Result truncated. Narrow the search with more criteria.'] : []),
            ...(r.skipped.length ? [`Not searched (timeout or error): ${r.skipped.join(', ')}. Search again with mailbox set to that folder.`] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Read mail',
      description:
        'Returns one message: headers, body as plain text or Markdown, and the attachment list (name, type, size; attachments themselves are never returned). Long bodies come in pages of about 8000 characters: use next_offset from the page info as offset for the next page. Read-only: opens the folder read-only and never marks the message as read.',
      inputSchema: z.object({
        id: z.string().min(5).max(600).describe('ID from list_recent, search_messages or get_thread, unchanged.'),
        format: z.enum(['text', 'markdown']).default('text').describe('markdown keeps links, lists and headings from HTML mails.'),
        offset: z.number().int().min(0).default(0).describe('Start position in characters (0 = beginning); use next_offset from the previous page.'),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('get_message', async () => {
        const m = await mail.getMessage(a.id, a.format, a.offset);
        const p = m.page;
        return dataResult({
          summary: `Message read (characters ${p.offset}–${p.offset + p.pageLength} of ${p.totalLength}).`,
          source: 'the iCloud mail account (message)',
          data: m,
          notes: [
            ...(p.nextOffset !== undefined ? [`The text continues. For the next page, call get_message with offset=${p.nextOffset}.`] : []),
            ...(m.sourceTruncated ? ['The message is very large (attachments); only the beginning was loaded.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Read conversation',
      description:
        'Finds the other messages of the conversation a message belongs to (via Message-ID, In-Reply-To and References, across inbox, sent, drafts and archive), oldest first, with a short excerpt of each text without quoted replies. Use get_message for the full text of one message. Read-only; nothing is marked as read.',
      inputSchema: z.object({
        id: z.string().min(5).max(600).describe('ID of a message in the conversation.'),
        include_text: z.boolean().default(true).describe('Include a short text excerpt for each message.'),
        excerpt_chars: z.number().int().min(200).max(4000).default(1500).describe('Excerpt length per message in characters.'),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('get_thread', async () => {
        const r = await mail.getThread(a.id, { includeText: a.include_text, excerptChars: a.excerpt_chars });
        return dataResult({
          summary: `${r.messages.length} messages in the conversation (oldest first).`,
          source: 'the iCloud mail account (messages)',
          data: r.messages,
          notes: r.cut ? ['The conversation is very long; at most 30 messages are shown.'] : [],
        });
      }),
  );
}
