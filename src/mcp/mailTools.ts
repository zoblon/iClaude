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
  .describe('Ordner: Pfad oder Name aus list_mailboxes, oder eine Rolle: inbox, sent, drafts, archive, junk, trash.');
const day = (what: string) => z.string().min(10).max(10).describe(`${what} als JJJJ-MM-TT (einschließlich).`);

export function registerMailTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    'list_mailboxes',
    {
      title: 'Mailordner auflisten',
      description: 'Lists all mail folders with role (inbox, sent, drafts, archive, junk, trash), number of messages and unread messages. Read-only; nothing is marked as read.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('list_mailboxes', async () => {
        const list = await mail.mailboxes();
        return dataResult({ summary: `${list.length} Ordner.`, source: 'dem iCloud-Mailkonto (Ordnernamen)', data: list });
      }),
  );

  server.registerTool(
    'unread_counts',
    {
      title: 'Ungelesene Mails zählen',
      description: 'Returns the number of unread messages per mail folder and the total (without junk and trash). Read-only; nothing is marked as read.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('unread_counts', async () => {
        const r = await mail.unreadCounts();
        return dataResult({ summary: `${r.total} ungelesene Mails (ohne Spam und Papierkorb).`, source: 'dem iCloud-Mailkonto (Ordnernamen)', data: r });
      }),
  );

  server.registerTool(
    'list_recent',
    {
      title: 'Neueste Mails auflisten',
      description:
        'Lists the newest messages of a mail folder (default: inbox), newest first, with sender, recipients, subject, date and unread state. No message text: use get_message with the id. Read-only; nothing is marked as read.',
      inputSchema: z.object({ mailbox: mailbox.optional(), count: z.number().int().min(1).max(50).default(20) }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('list_recent', async () => {
        const r = await mail.listRecent(a.mailbox, a.count);
        return dataResult({ summary: `${r.messages.length} neueste Nachrichten in "${r.mailbox}".`, source: 'dem iCloud-Mailkonto (Nachrichten)', data: r.messages });
      }),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Mails suchen',
      description:
        'Searches messages by sender, recipient, subject, full text and/or date range, optionally only unread. Without `mailbox` all folders except junk and trash are searched. At least one criterion is required. Returns summaries without text (use get_message). Full-text search in large folders can be slow. Read-only; nothing is marked as read.',
      inputSchema: z.object({
        from: z.string().min(1).max(200).optional().describe('Absender (Name oder Adresse, Teilstring).'),
        to: z.string().min(1).max(200).optional().describe('Empfänger (An oder Cc).'),
        subject: z.string().min(1).max(200).optional(),
        text: z.string().min(1).max(200).optional().describe('Volltext in Kopfzeilen und Inhalt (langsamer).'),
        since: day('Frühestes Datum').optional(),
        until: day('Spätestes Datum').optional(),
        unread_only: z.boolean().default(false),
        mailbox: mailbox.optional(),
        include_junk_and_trash: z.boolean().default(false).describe('Bei der Suche in allen Ordnern auch Spam und Papierkorb durchsuchen.'),
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
          summary: `${r.total} Treffer in ${r.searched.length} Ordnern${r.cut ? `, die neuesten ${r.messages.length} werden angezeigt` : ''}.`,
          source: 'dem iCloud-Mailkonto (Nachrichten)',
          data: r.messages,
          notes: [
            ...(r.cut ? ['Ergebnis gekürzt. Suche mit weiteren Kriterien eingrenzen.'] : []),
            ...(r.skipped.length ? [`Nicht durchsucht (Zeitüberschreitung oder Fehler): ${r.skipped.join(', ')}. Mit mailbox gezielt erneut suchen.`] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Mail lesen',
      description:
        'Returns one message: headers, body as plain text or Markdown, and the attachment list (name, type, size; attachments themselves are never returned). Long bodies come in pages of about 8000 characters: use next_offset from the page info as offset for the next page. Read-only: opens the folder read-only and never marks the message as read.',
      inputSchema: z.object({
        id: z.string().min(5).max(600).describe('ID aus list_recent, search_messages oder get_thread, unverändert.'),
        format: z.enum(['text', 'markdown']).default('text').describe('markdown erhält Links, Listen und Überschriften aus HTML-Mails.'),
        offset: z.number().int().min(0).default(0).describe('Startposition in Zeichen (0 = Anfang); next_offset der vorherigen Seite verwenden.'),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('get_message', async () => {
        const m = await mail.getMessage(a.id, a.format, a.offset);
        const p = m.page;
        return dataResult({
          summary: `Nachricht gelesen (Zeichen ${p.offset}–${p.offset + p.pageLength} von ${p.totalLength}).`,
          source: 'dem iCloud-Mailkonto (Nachricht)',
          data: m,
          notes: [
            ...(p.nextOffset !== undefined ? [`Der Text geht weiter. Für die nächste Seite get_message mit offset=${p.nextOffset} aufrufen.`] : []),
            ...(m.sourceTruncated ? ['Die Nachricht ist sehr groß (Anhänge); nur der Anfang wurde geladen.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Konversation lesen',
      description:
        'Finds the other messages of the conversation a message belongs to (via Message-ID, In-Reply-To and References, across inbox, sent, drafts and archive), oldest first, with a short excerpt of each text without quoted replies. Use get_message for the full text of one message. Read-only; nothing is marked as read.',
      inputSchema: z.object({
        id: z.string().min(5).max(600).describe('ID einer Nachricht der Konversation.'),
        include_text: z.boolean().default(true).describe('Kurzen Textauszug je Nachricht mitliefern.'),
        excerpt_chars: z.number().int().min(200).max(4000).default(1500).describe('Länge des Auszugs je Nachricht in Zeichen.'),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('get_thread', async () => {
        const r = await mail.getThread(a.id, { includeText: a.include_text, excerptChars: a.excerpt_chars });
        return dataResult({
          summary: `${r.messages.length} Nachrichten in der Konversation (älteste zuerst).`,
          source: 'dem iCloud-Mailkonto (Nachrichten)',
          data: r.messages,
          notes: r.cut ? ['Die Konversation ist sehr lang; es werden höchstens 30 Nachrichten angezeigt.'] : [],
        });
      }),
  );
}
