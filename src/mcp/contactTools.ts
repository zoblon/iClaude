import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ContactService } from '../core/contacts/service.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerContactTools(server: McpServer, contacts: ContactService): void {
  server.registerTool(
    'search_contacts',
    {
      title: 'Kontakte suchen',
      description:
        'Searches the iCloud contacts by name, nickname, company, email address or phone number (case- and accent-insensitive; every word of the query must match). Returns a compact list; use get_contact with the id for full details. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).max(100).describe('Suchbegriff(e), z. B. "Müller", "beispiel.de" oder "Anna Firma".'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('search_contacts', async () => {
        const r = await contacts.search(a.query, a.limit);
        return dataResult({
          summary: `${r.total} Kontakte gefunden${r.cut ? `, die ersten ${r.contacts.length} werden angezeigt` : ''}.`,
          source: 'den iCloud-Kontakten',
          data: r.contacts,
          notes: [
            ...(r.cut ? ['Ergebnis gekürzt. Suche eingrenzen.'] : []),
            ...(r.truncated ? ['Das Adressbuch ist sehr groß; nicht alle Kontakte wurden geladen.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Kontakt abrufen',
      description:
        'Returns the full details of one contact (all emails, phones, addresses, birthday, notes; no photo). Use the id from search_contacts. Read-only.',
      inputSchema: z.object({ id: z.string().min(5).max(500).describe('ID aus search_contacts, unverändert.') }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('get_contact', async () => {
        const c = await contacts.get(a.id);
        return dataResult({ summary: 'Kontakt gefunden.', source: 'den iCloud-Kontakten', data: c });
      }),
  );
}
