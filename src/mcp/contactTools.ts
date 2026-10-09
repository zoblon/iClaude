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
      title: 'Search contacts',
      description:
        'Searches the iCloud contacts by name, nickname, company, email address or phone number (case- and accent-insensitive; every word of the query must match). Returns a compact list; use get_contact with the id for full details. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).max(100).describe('Search term(s), e.g. "Müller", "example.com" or "Anna Acme".'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('search_contacts', async () => {
        const r = await contacts.search(a.query, a.limit);
        return dataResult({
          summary: `${r.total} contacts found${r.cut ? `, showing the first ${r.contacts.length}` : ''}.`,
          source: 'the iCloud contacts',
          data: r.contacts,
          notes: [
            ...(r.cut ? ['Result truncated. Narrow the search.'] : []),
            ...(r.truncated ? ['The address book is very large; not all contacts were loaded.'] : []),
          ],
        });
      }),
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Get contact',
      description:
        'Returns the full details of one contact (all emails, phones, addresses, birthday, notes; no photo). Use the id from search_contacts. Read-only.',
      inputSchema: z.object({ id: z.string().min(5).max(500).describe('ID from search_contacts, unchanged.') }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('get_contact', async () => {
        const c = await contacts.get(a.id);
        return dataResult({ summary: 'Contact found.', source: 'the iCloud contacts', data: c });
      }),
  );
}
