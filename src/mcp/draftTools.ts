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
  quote: z.boolean().default(true).describe('Quote the original message in a reply, or include its text in a forwarded message (false: only the forwarding header).'),
  forward_of_id: z.string().min(5).max(600).optional().describe('ID of the message to forward (from list_recent, search_messages, get_message). Cannot be combined with reply_to_id. Needs at least one recipient.'),
  forward_attachment_ids: z.array(z.string().min(1).max(40)).max(50).optional().describe('Only with forward_of_id: the attachment_ids (from get_message) to take along. Default: all attachments of the original. An empty list: none.'),
});

export function registerDraftTools(server: McpServer, drafts: DraftService): void {
  server.registerTool(
    'create_draft',
    {
      title: 'Create mail draft',
      description:
        'Creates an email DRAFT in the Drafts folder of the iCloud account (sender is always the user\'s own iCloud address). The mail is NEVER sent: the user reviews and sends it in Apple Mail. ' +
        'Optionally a reply to an existing message (reply_to_id sets In-Reply-To/References and quotes the original), or a forward (forward_of_id: subject "Fwd: …", forwarding header and text of the original like Apple Mail, and the original\'s attachments, all by default or those in forward_attachment_ids; at most 20 MB in total). ' +
        'No Bcc, and no attachments other than those of a forwarded message. Cannot delete, move or send anything. Each call creates a new draft.',
      inputSchema: createDraftSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guarded('create_draft', async () => {
        const d = await drafts.createDraft({ to: a.to, cc: a.cc, subject: a.subject, body: a.body, replyToId: a.reply_to_id, quote: a.quote, forwardOfId: a.forward_of_id, forwardAttachmentIds: a.forward_attachment_ids });
        return dataResult({
          summary: `Draft "${d.subject}" created in folder "${d.mailbox}"${d.attachments?.length ? ` with ${d.attachments.length} attachment(s)` : ''}. It was not sent.`,
          source: 'the draft just created',
          data: d,
          notes: ['The draft was NOT sent. Tell the user to review it in Apple Mail and send it themselves.'],
        });
      }),
  );
}
