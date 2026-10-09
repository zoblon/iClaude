import { DateTime } from 'luxon';
import { UserError } from '../errors.js';
import { authorizeContactWrite, type ContactWriteGrant } from '../permissions.js';
import { sameText } from '../untrusted.js';
import type { BackupStore } from '../calendar/backup.js';
import { upcomingDates, type UpcomingDate } from './dates.js';
import type { Contact, ContactGroup } from './vcard.js';
import { parseVCard } from './vcard.js';
import { applyEdits, buildVCard, type AddressInput, type ContactEdits, type LabeledInput, type NewContact } from './vcardEdit.js';

const MAX_LIMIT = 50;

export interface ContactData {
  contacts: Contact[];
  groups: ContactGroup[];
  truncated: boolean;
}

export interface ContactCard {
  id: string;
  etag?: string;
  data: string;
}

/** Read access to contacts (replaceable). */
export interface ContactReader {
  loadAll(opts?: { fresh?: boolean }): Promise<ContactData>;
}

/**
 * Write access: one contact card at a time. Requires a ContactWriteGrant from permissions.ts.
 * Deliberately has no method to delete contacts or to write group cards.
 */
export interface ContactStore extends ContactReader {
  getCard(id: string): Promise<ContactCard | undefined>;
  createCard(grant: ContactWriteGrant, filename: string, vcf: string): Promise<ContactCard>;
  updateCard(grant: ContactWriteGrant, card: { id: string; etag: string; data: string }): Promise<ContactCard>;
}

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Lower case, accents removed (ü -> u), ß -> ss. */
export function norm(s: string): string {
  return strip(s.toLowerCase().replace(/ß/g, 'ss'));
}

/** German transliteration: ü -> ue, ä -> ae, ö -> oe, ß -> ss (many people type "Mueller" for "Müller"). */
function normDe(s: string): string {
  return strip(s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'));
}

/** Both spellings of a text: query and data are converted the same way and compared. */
type Forms = readonly [string, string];
const forms = (s: string): Forms => [normDe(s), norm(s)];
const includes = (hay: Forms, t: Forms) => hay[0].includes(t[0]) || hay[1].includes(t[1]);
const equals = (hay: Forms, t: Forms) => hay[0] === t[0] || hay[1] === t[1];
const wordStarts = (hay: Forms, t: Forms) =>
  hay[0].split(/\s+/).some((w) => w.startsWith(t[0])) || hay[1].split(/\s+/).some((w) => w.startsWith(t[1]));

const digits = (s: string) => s.replace(/\D/g, '');
/** Phone numbers are compared by their last 8 digits (country code and leading zero do not matter). */
const phoneKey = (s: string) => digits(s).slice(-8);

/** Compact output for result lists. */
export interface ContactSummary {
  id: string;
  name: string;
  organization?: string;
  jobTitle?: string;
  emails: string[];
  phones: string[];
}

export function summarize(c: Contact): ContactSummary {
  return {
    id: c.id,
    name: c.name,
    ...(c.organization ? { organization: c.organization } : {}),
    ...(c.jobTitle ? { jobTitle: c.jobTitle } : {}),
    emails: c.emails.map((e) => e.value),
    phones: c.phones.map((p) => p.value),
  };
}

export interface GroupSummary {
  name: string;
  memberCount: number;
}

export interface CreateInput extends NewContact {
  allowDuplicate?: boolean | undefined;
}

export interface CreateResult {
  created: boolean;
  /** Existing contacts that look like the new one (only when nothing was created). */
  duplicates?: Array<ContactSummary & { reasons: string[] }>;
  contact?: Contact;
}

export interface UpdateInput extends ContactEdits {
  id: string;
  /** Name of the contact as shown by search_contacts/get_contact; checked against the stored contact. */
  name: string;
  etag?: string | undefined;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface UpdateResult {
  contact: Contact;
  changes: FieldChange[];
  backup: { file: string; path: string; folder: string };
  prunedBackups: number;
  notes: string[];
}

/** Comparable form of an ETag: without W/ and without quotes. */
const normEtag = (e: string) => e.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

const FIELDS = ['name', 'nickname', 'organization', 'department', 'jobTitle', 'birthday', 'notes', 'emails', 'phones', 'addresses', 'urls'] as const;

export class ContactService {
  constructor(
    private readonly reader: ContactReader,
    private readonly writer?: ContactStore,
    private readonly backup?: BackupStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async withGroups(fresh = false): Promise<{ contacts: Contact[]; groups: ContactGroup[]; truncated: boolean }> {
    const { contacts, groups, truncated } = await this.reader.loadAll(fresh ? { fresh: true } : {});
    const byUid = new Map<string, string[]>();
    for (const g of groups) for (const uid of g.memberUids) byUid.set(uid, [...(byUid.get(uid) ?? []), g.name]);
    const merged = contacts.map((c) => {
      const names = c.uid ? byUid.get(c.uid.toLowerCase()) : undefined;
      return names?.length ? { ...c, groups: names } : c;
    });
    return { contacts: merged, groups, truncated };
  }

  /** The members of a group, found by its name (exact, otherwise a single partial match). */
  private pickGroup(groups: ContactGroup[], name: string): ContactGroup {
    const want = forms(name.trim());
    const exact = groups.filter((g) => equals(forms(g.name), want));
    const hits = exact.length ? exact : groups.filter((g) => includes(forms(g.name), want));
    if (hits.length === 1) return hits[0]!;
    const list = groups.map((g) => `"${g.name}"`).join(', ') || '(none)';
    throw new UserError(
      hits.length > 1 ? `Several groups match "${name.slice(0, 60)}": ${hits.map((g) => `"${g.name}"`).join(', ')}. Please use the exact name.` : `No group "${name.slice(0, 60)}" found. Groups: ${list}.`,
    );
  }

  async listGroups(): Promise<GroupSummary[]> {
    const { contacts, groups } = await this.withGroups();
    const uids = new Set(contacts.map((c) => c.uid?.toLowerCase()).filter(Boolean));
    return groups.map((g) => ({ name: g.name, memberCount: g.memberUids.filter((u) => uids.has(u)).length })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /**
   * Every query word must occur in the name, nickname, company, email addresses, addresses (street, city, postal code, country)
   * or phone numbers. Notes are not searched. With `group`, only members of that group; then the query may be missing.
   */
  async search(query: string | undefined, limit = 20, group?: string): Promise<{ total: number; contacts: ContactSummary[]; cut: boolean; truncated: boolean }> {
    const tokens = (query ?? '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length && !group?.trim()) throw new UserError('Please provide a search term (query) or a group.');
    const { contacts: all, groups, truncated } = await this.withGroups();
    let contacts = all;
    if (group?.trim()) {
      const g = this.pickGroup(groups, group);
      const members = new Set(g.memberUids);
      contacts = all.filter((c) => c.uid && members.has(c.uid.toLowerCase()));
    }
    const tokenForms = tokens.map((t) => ({ f: forms(t), digits: digits(t), isNumber: digits(t) === t.replace(/[\s+()\-./]/g, '') }));

    const scored: Array<{ c: Contact; score: number }> = [];
    for (const c of contacts) {
      const name = forms(c.name);
      const hay = forms(
        [c.name, c.nickname ?? '', c.organization ?? '', ...c.emails.map((e) => e.value), ...c.addresses.flatMap((a) => [a.street, a.city, a.region, a.postalCode, a.country].filter(Boolean) as string[])].join(' \n '),
      );
      const phoneDigits = c.phones.map((p) => digits(p.value));
      let score = 0;
      let ok = true;
      for (const t of tokenForms) {
        const phoneHit = t.isNumber && t.digits.length >= 4 && phoneDigits.some((p) => p.includes(t.digits));
        if (equals(name, t.f)) score += 100;
        else if (wordStarts(name, t.f)) score += 40;
        else if (includes(hay, t.f) || phoneHit) score += 10;
        else {
          ok = false;
          break;
        }
      }
      if (ok) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name, 'de'));
    const max = Math.min(limit, MAX_LIMIT);
    return { total: scored.length, contacts: scored.slice(0, max).map((s) => summarize(s.c)), cut: scored.length > max, truncated };
  }

  async get(id: string): Promise<Contact> {
    if (!/^\/[^?#\s]*\.vcf$/i.test(id) || id.includes('..')) {
      throw new UserError('Invalid contact ID. Use the id from search_contacts unchanged.');
    }
    const { contacts } = await this.withGroups();
    const hit = contacts.find((c) => c.id === id);
    if (!hit) throw new UserError('Contact not found. The ID may come from an earlier query; please search again with search_contacts.');
    return hit;
  }

  /** Birthdays and further dates in the next `days` days (today included), sorted. */
  async upcoming(days: number, zone: string, now?: DateTime): Promise<{ dates: UpcomingDate[]; truncated: boolean }> {
    const { contacts, truncated } = await this.reader.loadAll();
    return { dates: upcomingDates(contacts, days, zone, now), truncated };
  }

  private requireWriter(): ContactStore {
    if (!this.writer) throw new UserError('Writing contacts is not set up.');
    return this.writer;
  }

  /** Existing contacts with the same email address, the same phone number (last 8 digits) or the same full name. */
  private findDuplicates(contacts: Contact[], c: { name: string; emails: string[]; phones: string[] }) {
    const emails = new Set(c.emails.map((e) => e.trim().toLowerCase()));
    const phones = new Set(c.phones.map(phoneKey).filter((k) => k.length >= 5));
    const name = norm(c.name).replace(/\s+/g, ' ').trim();
    const out: Array<ContactSummary & { reasons: string[] }> = [];
    for (const x of contacts) {
      const reasons: string[] = [];
      if (x.emails.some((e) => emails.has(e.value.trim().toLowerCase()))) reasons.push('same email address');
      if (x.phones.some((p) => phones.has(phoneKey(p.value)))) reasons.push('same phone number');
      if (name && norm(x.name).replace(/\s+/g, ' ').trim() === name) reasons.push('same name');
      if (reasons.length) out.push({ ...summarize(x), reasons });
    }
    return out;
  }

  async createContact(a: CreateInput): Promise<CreateResult> {
    const store = this.requireWriter();
    const { uid, data, name } = buildVCard(a, this.now());
    const filename = `${uid}.vcf`;
    const { contacts } = await this.withGroups(true);
    if (!a.allowDuplicate) {
      const dups = this.findDuplicates(contacts, {
        name,
        emails: (a.emails ?? []).map((e) => e.value),
        phones: (a.phones ?? []).map((p) => p.value),
      });
      if (dups.length) return { created: false, duplicates: dups.slice(0, 10) };
    }
    const grant = authorizeContactWrite({ op: 'create', target: filename, vcard: data });
    const saved = await store.createCard(grant, filename, data);
    const contact = parseVCard(saved.data, saved.id, 'Contacts', saved.etag);
    return { created: true, ...(contact ? { contact } : {}) };
  }

  async updateContact(a: UpdateInput): Promise<UpdateResult> {
    const store = this.requireWriter();
    if (!this.backup) throw new UserError('Changing contacts is not set up (no backup folder). Nothing was changed.');
    if (!a.name.trim()) throw new UserError('The name must not be empty. Please give the name of the contact as it is displayed.');
    if (!/^\/[^?#\s]*\.vcf$/i.test(a.id) || a.id.includes('..')) throw new UserError('Invalid contact ID. Use the id from search_contacts unchanged.');

    const card = await store.getCard(a.id);
    if (!card) throw new UserError('Contact not found. It may have been deleted; please search again with search_contacts.');
    const before = parseVCard(card.data, a.id, 'Contacts', card.etag);
    if (!before) throw new UserError('This entry is not a contact card (it may be a group). Nothing was changed.');
    if (!sameText(a.name, before.name)) {
      throw new UserError('The name does not match the contact with this ID. Nothing was changed. Fetch the contact again with search_contacts or get_contact and copy the name unchanged.');
    }
    const grant = authorizeContactWrite({ op: 'update', target: a.id, vcard: card.data });
    if (!card.etag) throw new UserError('The server returns no ETag for this contact, so nothing is written for safety reasons. Please change the contact in Apple Contacts.');
    if (a.etag && normEtag(a.etag) !== normEtag(card.etag)) {
      throw new UserError('The contact has changed since it was fetched. Please load it again with get_contact and repeat the change.');
    }

    const edited = applyEdits(card.data, a);
    if (edited.data === card.data) throw new UserError(edited.notes.length ? `Nothing to change. ${edited.notes.join(' ')}` : 'No change specified.');

    // Back up first. If the backup fails, nothing is changed.
    const saved = await this.backup.save(before.name, card.data);
    let written: ContactCard;
    try {
      written = await store.updateCard(grant, { id: a.id, etag: card.etag, data: edited.data });
    } catch (e) {
      await this.backup.discard(saved);
      throw e;
    }
    const prunedBackups = await this.backup.prune();
    const after = parseVCard(written.data, a.id, 'Contacts', written.etag) ?? before;
    const changes: FieldChange[] = FIELDS.filter((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null)).map((f) => ({
      field: f,
      before: before[f] ?? null,
      after: after[f] ?? null,
    }));
    return { contact: after, changes, backup: { ...saved, folder: this.backup.dir }, prunedBackups, notes: edited.notes };
  }
}

export type { AddressInput, LabeledInput };
