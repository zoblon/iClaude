import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ContactService } from '../core/contacts/service.js';
import { dataOutputSchema, dataResult } from '../core/untrusted.js';
import { guarded } from './safe.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const labeledValue = (what: string) =>
  z.strictObject({
    value: z.string().min(1).max(500).describe(what),
    label: z.string().max(60).optional().describe('Label such as Home, Work, Mobile, Other, or your own text.'),
  });
const addressInput = z.strictObject({
  label: z.string().max(60).optional().describe('Label such as Home, Work, Other, or your own text.'),
  street: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().max(100).optional(),
});
const toAddress = (a: z.infer<typeof addressInput>) => ({ label: a.label, street: a.street, city: a.city, region: a.region, postalCode: a.postal_code, country: a.country });

const people = {
  given_name: z.string().max(100).optional(),
  family_name: z.string().max(100).optional(),
  organization: z.string().max(150).optional().describe('Company.'),
  department: z.string().max(150).optional(),
  job_title: z.string().max(150).optional(),
  nickname: z.string().max(100).optional(),
  birthday: z.string().max(12).optional().describe('YYYY-MM-DD, or --MM-DD (or MM-DD) when the year is unknown.'),
  notes: z.string().max(5000).optional(),
};

// strictObject: unknown fields such as "photo" or "group" are rejected, not silently ignored.
export const createContactSchema = z.strictObject({
  ...people,
  emails: z.array(labeledValue('Email address.')).max(10).optional(),
  phones: z.array(labeledValue('Phone number.')).max(10).optional(),
  addresses: z.array(addressInput).max(5).optional(),
  urls: z.array(labeledValue('Web address.')).max(10).optional(),
  allow_duplicate: z.boolean().default(false).describe('Create the contact even if one with the same email address, phone number or name exists.'),
});

export const updateContactSchema = z.strictObject({
  id: z.string().min(5).max(500).describe('ID of the contact from search_contacts / get_contact, unchanged.'),
  name: z.string().min(1).max(400).describe('Name of the contact as shown by search_contacts/get_contact. Checked against the stored contact; if it does not match, nothing is changed.'),
  etag: z.string().max(200).optional().describe('ETag from get_contact. If the contact has changed since, the change is refused.'),
  given_name: people.given_name.describe('An empty string removes the first name.'),
  family_name: people.family_name.describe('An empty string removes the last name.'),
  organization: people.organization.describe('Company. An empty string removes it.'),
  department: people.department.describe('An empty string removes it.'),
  job_title: people.job_title.describe('An empty string removes it.'),
  nickname: people.nickname.describe('An empty string removes it.'),
  birthday: people.birthday.describe('YYYY-MM-DD, or --MM-DD (or MM-DD) when the year is unknown. An empty string removes it.'),
  notes: people.notes.describe('Replaces the notes. An empty string removes them.'),
  add_emails: z.array(labeledValue('Email address.')).max(10).optional(),
  remove_emails: z.array(z.string().min(1).max(254)).max(10).optional().describe('Exact email addresses to remove.'),
  add_phones: z.array(labeledValue('Phone number.')).max(10).optional(),
  remove_phones: z.array(z.string().min(1).max(40)).max(10).optional().describe('Exact phone numbers to remove, as stored.'),
  add_addresses: z.array(addressInput).max(5).optional(),
  remove_addresses: z.array(addressInput).max(5).optional().describe('Addresses to remove: every given field must match the stored address.'),
  add_urls: z.array(labeledValue('Web address.')).max(10).optional(),
  remove_urls: z.array(z.string().min(1).max(500)).max(10).optional().describe('Exact web addresses to remove.'),
});

export function registerContactTools(server: McpServer, contacts: ContactService, zone = 'Europe/Berlin'): void {
  server.registerTool(
    'search_contacts',
    {
      title: 'Search contacts',
      description:
        'Searches the iCloud contacts by name, nickname, company, email address, phone number or address (street, city, postal code, country; case- and accent-insensitive; every word of the query must match; notes are not searched). ' +
        'With `group` only members of that contact group are searched; then `query` may be omitted to list all members. Returns a compact list; use get_contact with the id for full details. Read-only.',
      inputSchema: z.object({
        query: z.string().min(1).max(100).optional().describe('Search term(s), e.g. "Müller", "example.com", "Berlin" or "Anna Acme". May be omitted when `group` is given.'),
        group: z.string().min(1).max(100).optional().describe('Name of a contact group (see list_contact_groups).'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('search_contacts', async () => {
        const r = await contacts.search(a.query, a.limit, a.group);
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
        'Returns the full details of one contact (all emails, phones, addresses, company and department, birthday and further dates, relationships, social profiles, messengers, groups, notes; no photo) and its etag. Use the id from search_contacts. Read-only.',
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

  server.registerTool(
    'list_contact_groups',
    {
      title: 'List contact groups',
      description: 'Lists the contact groups with the number of members. Use search_contacts with `group` to list the members. Read-only; groups cannot be changed.',
      inputSchema: z.object({}),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async () =>
      guarded('list_contact_groups', async () => {
        const g = await contacts.listGroups();
        return dataResult({ summary: `${g.length} groups.`, source: 'the iCloud contacts (groups)', data: g });
      }),
  );

  server.registerTool(
    'upcoming_contact_dates',
    {
      title: 'Upcoming birthdays and dates',
      description:
        'Lists birthdays and further dates of contacts (such as anniversaries) falling on today or in the next `days` days (time zone of the extension), sorted by date, with contact name, label, date, weekday, days until, and the age or number of years when the year is known. ' +
        'Dates stored without a year give no age. 29 February counts as 28 February in years that are not leap years. Read-only.',
      inputSchema: z.object({ days: z.number().int().min(1).max(366).default(14).describe('How many days ahead, starting today (1–366).') }),
      outputSchema: dataOutputSchema,
      annotations: READ_ONLY,
    },
    async (a) =>
      guarded('upcoming_contact_dates', async () => {
        const r = await contacts.upcoming(a.days, zone);
        return dataResult({
          summary: `${r.dates.length} dates in the next ${a.days} days.`,
          source: 'the iCloud contacts',
          data: r.dates,
          notes: r.truncated ? ['The address book is very large; not all contacts were loaded.'] : [],
        });
      }),
  );

  server.registerTool(
    'create_contact',
    {
      title: 'Create contact',
      description:
        'Creates ONE new contact (name, company, department, job title, nickname, emails, phones, addresses, web addresses, birthday, notes; each email/phone/address/URL with an optional label). ' +
        'Before creating, existing contacts are checked: if one has the same email address, the same phone number (last 8 digits) or the same full name, NOTHING is created and the matches are returned, unless allow_duplicate is true. ' +
        'Never changes or deletes existing contacts; no photo, no groups. Use update_contact to change a contact.',
      inputSchema: createContactSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guarded('create_contact', async () => {
        const r = await contacts.createContact({
          givenName: a.given_name,
          familyName: a.family_name,
          organization: a.organization,
          department: a.department,
          jobTitle: a.job_title,
          nickname: a.nickname,
          emails: a.emails,
          phones: a.phones,
          addresses: a.addresses?.map(toAddress),
          urls: a.urls,
          birthday: a.birthday,
          notes: a.notes,
          allowDuplicate: a.allow_duplicate,
        });
        if (!r.created) {
          return dataResult({
            summary: `Nothing was created: ${r.duplicates!.length} existing contact(s) look like this one.`,
            source: 'the iCloud contacts',
            data: r,
            notes: ['Ask the user whether to use an existing contact (update_contact) or create it anyway (allow_duplicate=true).'],
          });
        }
        return dataResult({ summary: 'Contact created.', source: 'the contact just created', data: r });
      }),
  );

  server.registerTool(
    'update_contact',
    {
      title: 'Update contact',
      description:
        'Changes ONE existing contact (partial update). Set simple fields (first/last name, company, department, job title, nickname, birthday, notes; an empty string removes the field) and add or remove emails, phone numbers, addresses and web addresses (removal by exact value). ' +
        'Everything not named stays untouched, including the photo, group memberships and the UID. Requires the id and the name of the contact; the name is checked against the stored contact. ' +
        'Before writing, the card is saved as a .vcf backup in ~/Library/Application Support/icloud-mcp/contacts-backup/ (90 days / 200 newest); if the backup fails, nothing is changed. Returns before/after of the changed fields and the backup path. ' +
        'Cannot delete contacts and cannot change groups.',
      inputSchema: updateContactSchema,
      outputSchema: dataOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) =>
      guarded('update_contact', async () => {
        const r = await contacts.updateContact({
          id: a.id,
          name: a.name,
          etag: a.etag,
          givenName: a.given_name,
          familyName: a.family_name,
          organization: a.organization,
          department: a.department,
          jobTitle: a.job_title,
          nickname: a.nickname,
          birthday: a.birthday,
          notes: a.notes,
          addEmails: a.add_emails,
          removeEmails: a.remove_emails,
          addPhones: a.add_phones,
          removePhones: a.remove_phones,
          addAddresses: a.add_addresses?.map(toAddress),
          removeAddresses: a.remove_addresses?.map(toAddress),
          addUrls: a.add_urls,
          removeUrls: a.remove_urls,
        });
        return dataResult({
          summary: `Contact updated (${r.changes.map((c) => c.field).join(', ') || 'no visible field'}).`,
          source: 'the updated contact',
          data: { changes: r.changes, backup: { file: r.backup.file, path: r.backup.path }, contact: r.contact },
          notes: [
            `A backup of the previous card is stored in ${r.backup.folder} (file name and path under data.backup). Importing the .vcf file in Apple Contacts restores the previous state.`,
            ...r.notes,
          ],
        });
      }),
  );
}
