import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DraftService } from '../core/mail/draft.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const address = z.string().min(3).max(300).describe('Email address "name@example.com" or "Name <name@example.com>".');

// strictObject: fields like "bcc", "from" or "attachments" are rejected, not silently ignored.
export const createDraftSchema = z.strictObject({
  to: z.array(address).max(20).optional().describe('Recipients. Optional for a reply (reply_to_id): then the sender of the original message.'),
  cc: z.array(address).max(20).optional(),
  subject: z.string().max(300).optional().describe('Subject. Optional for a reply: then "Re: " plus the original subject.'),
  body: z.string().min(1).max(20000).describe('Text of the draft (plain text).'),
  reply_to_id: z.string().min(5).max(600).optional().describe('ID of the message being replied to (from list_recent, search_messages, get_message).'),
  quote: z.boolean().default(true).describe('Quote the original message in a reply.'),
});

export function registerDraftTools(server: McpServer, drafts: DraftService): void {
  server.registerTool(
    'create_draft',
    {
      title: 'Create mail draft',
      description:
        'Creates an email DRAFT in the Drafts folder of the iCloud account (sender is always the user\'s own iCloud address). The mail is NEVER sent: the user reviews and sends it in Apple Mail. ' +
        'Optionally a reply to an existing message (reply_to_id sets In-Reply-To/References and quotes the original). No Bcc, no attachments. Cannot delete, move or send anything. Each call creates a new draft.',
      inputSchema: createDraftSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guarded('create_draft', async () => {
        const d = await drafts.createDraft({ to: a.to, cc: a.cc, subject: a.subject, body: a.body, replyToId: a.reply_to_id, quote: a.quote });
        return dataResult({
          summary: `Draft "${d.subject}" created in folder "${d.mailbox}". It was not sent.`,
          source: 'the draft just created',
          data: d,
          notes: ['The draft was NOT sent. Tell the user to review it in Apple Mail and send it themselves.'],
        });
      }),
  );
}
