import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DraftService } from '../core/mail/draft.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const address = z.string().min(3).max(300).describe('Mailadresse "name@beispiel.de" oder "Name <name@beispiel.de>".');

// strictObject: Felder wie "bcc", "from" oder "attachments" werden abgelehnt, nicht stillschweigend ignoriert.
export const createDraftSchema = z.strictObject({
  to: z.array(address).max(20).optional().describe('Empfänger. Bei einer Antwort (reply_to_id) optional: dann der Absender der Originalnachricht.'),
  cc: z.array(address).max(20).optional(),
  subject: z.string().max(300).optional().describe('Betreff. Bei einer Antwort optional: dann "Re: " plus Original-Betreff.'),
  body: z.string().min(1).max(20000).describe('Text des Entwurfs (Klartext).'),
  reply_to_id: z.string().min(5).max(600).optional().describe('ID der Nachricht (aus list_recent, search_messages, get_message), auf die geantwortet wird.'),
  quote: z.boolean().default(true).describe('Bei einer Antwort die Originalnachricht zitieren.'),
});

export function registerDraftTools(server: McpServer, drafts: DraftService): void {
  server.registerTool(
    'create_draft',
    {
      title: 'Mail-Entwurf anlegen',
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
          summary: `Entwurf "${d.subject}" im Ordner "${d.mailbox}" angelegt. Er wurde nicht gesendet.`,
          source: 'dem soeben angelegten Entwurf',
          data: d,
          notes: ['Der Entwurf wurde NICHT gesendet. Dem Nutzer sagen, dass er ihn in Apple Mail prüfen und selbst senden muss.'],
        });
      }),
  );
}
