import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupStore } from '../src/core/calendar/backup.js';
import { upcomingDates } from '../src/core/contacts/dates.js';
import { ContactService, type ContactCard, type ContactData, type ContactStore } from '../src/core/contacts/service.js';
import { parseGroupCard, parseVCard } from '../src/core/contacts/vcard.js';
import { applyEdits, buildVCard, foldLine, VCardText } from '../src/core/contacts/vcardEdit.js';
import { ContactWriteGrant, authorizeContactWrite } from '../src/core/permissions.js';
import { UserError } from '../src/core/errors.js';
import { createContactSchema, updateContactSchema } from '../src/mcp/contactTools.js';

const CRLF = '\r\n';
const PHOTO = 'PHOTO;ENCODING=b;TYPE=JPEG:' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(6);
const foldedPhoto = foldLine(PHOTO);

/** A realistic Apple card: itemN groups, X-ABLabel, PHOTO, BDAY with 1604, X-ABDATE, X-ABRELATEDNAMES, X-SOCIALPROFILE, multi-line NOTE. */
const APPLE = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
  'N:Muster;Max;Paul;Dr.;jun.',
  'FN:Dr. Max Paul Muster jun.',
  'NICKNAME:Maxi',
  'ORG:Beispiel GmbH;Vertrieb;',
  'TITLE:Leiter',
  'item1.EMAIL;type=INTERNET;type=pref:max@beispiel.de',
  'item1.X-ABLabel:_$!<Work>!$_',
  'EMAIL;type=INTERNET;type=HOME:max@privat.de',
  'TEL;type=CELL;type=VOICE;type=pref:+49 170 1234567',
  'item2.TEL:030 123456',
  'item2.X-ABLabel:Büro',
  'item3.ADR;type=HOME;type=pref:;;Hauptstr. 1;Berlin;BE;10115;Deutschland',
  'item3.X-ABADR:de',
  'item4.URL;type=pref:https\\://beispiel.de',
  'item4.X-ABLabel:_$!<HomePage>!$_',
  'BDAY;VALUE=date:1604-03-15',
  'item5.X-ABDATE;type=pref:2010-06-12',
  'item5.X-ABLabel:_$!<Anniversary>!$_',
  'item6.X-ABRELATEDNAMES;type=pref:Anna Muster',
  'item6.X-ABLabel:_$!<Spouse>!$_',
  'X-SOCIALPROFILE;type=twitter;x-user=maxmuster:http\\://twitter.com/maxmuster',
  'IMPP;X-SERVICE-TYPE=Skype;type=HOME;type=pref:skype:max.muster',
  'NOTE:Erste Zeile\\nZweite Zeile\\, mit Komma',
  PHOTO,
  'X-ABUID:11111111-2222-3333-4444-555555555555\\:ABPerson',
  'UID:11111111-2222-3333-4444-555555555555',
  'REV:2026-10-01T08:00:00Z',
  'END:VCARD',
]
  .map((l) => foldLine(l))
  .join(CRLF) + CRLF;

const lines = (t: string) => t.split(CRLF);

describe('line-level editing keeps Apple vCards byte for byte', () => {
  it('a no-op edit returns the identical text', () => {
    expect(applyEdits(APPLE, {}).data).toBe(APPLE);
    expect(VCardText.parse(APPLE).toString()).toBe(APPLE);
  });

  it('changing one phone number changes only that number; all other lines are byte-identical', () => {
    const r = applyEdits(APPLE, { removePhones: ['+49 170 1234567'], addPhones: [{ value: '+49 171 7654321', label: 'Mobile' }] });
    const before = lines(APPLE);
    const after = lines(r.data);
    const gone = before.filter((l) => !after.includes(l));
    const added = after.filter((l) => !before.includes(l));
    expect(gone).toEqual(['TEL;type=CELL;type=VOICE;type=pref:+49 170 1234567']);
    expect(added).toEqual(['TEL;type=CELL;type=VOICE;type=pref:+49 171 7654321']);
    // all remaining lines in the original order, byte for byte (the PHOTO keeps Apple's folding)
    expect(after.filter((l) => before.includes(l))).toEqual(before.filter((l) => after.includes(l)));
    expect(r.data).toContain(foldedPhoto + CRLF);
    expect(r.data).toContain('item1.EMAIL;type=INTERNET;type=pref:max@beispiel.de');
    expect(r.data).toContain('BDAY;VALUE=date:1604-03-15');
    expect(r.data).not.toMatch(/ITEM\d/);
  });

  it('adding a phone number leaves everything else identical and does not collide with existing itemN groups', () => {
    const r = applyEdits(APPLE, { addPhones: [{ value: '+49 30 99999', label: 'Other' }] });
    const before = lines(APPLE);
    const after = lines(r.data);
    expect(before.every((l) => after.includes(l))).toBe(true);
    expect(after.filter((l) => !before.includes(l))).toEqual(['item7.TEL:+49 30 99999', 'item7.X-ABLabel:_$!<Other>!$_']);
  });

  it('removing a labeled value removes its group lines too, nothing else', () => {
    const r = applyEdits(APPLE, { removePhones: ['030 123456'] });
    const before = lines(APPLE);
    expect(before.filter((l) => !lines(r.data).includes(l))).toEqual(['item2.TEL:030 123456', 'item2.X-ABLabel:Büro']);
  });

  it('sets and removes simple fields in place', () => {
    const r = applyEdits(APPLE, { organization: 'Neue AG', jobTitle: '', notes: 'Neu, mit; Zeichen\nZeile 2', birthday: '1980-05-17', nickname: 'M' });
    expect(r.data).toContain('ORG:Neue AG;Vertrieb;'); // department part untouched
    expect(r.data).not.toContain('TITLE:');
    expect(r.data.replace(/\r\n /g, '')).toContain('NOTE:Neu\\, mit\\; Zeichen\\nZeile 2');
    expect(r.data).toContain('BDAY;VALUE=date:1980-05-17');
    expect(r.data).toContain('NICKNAME:M');
    const c = parseVCard(r.data, '/x.vcf', 'K')!;
    expect(c).toMatchObject({ organization: 'Neue AG', department: 'Vertrieb', notes: 'Neu, mit; Zeichen\nZeile 2', birthday: '1980-05-17' });
    expect(c.jobTitle).toBeUndefined();
  });

  it('a birthday without a year is written with the placeholder year 1604, as Apple does', () => {
    const r = applyEdits(APPLE, { birthday: '--07-04' });
    expect(r.data).toContain('BDAY;VALUE=date:1604-07-04');
    expect(parseVCard(r.data, '/x.vcf', 'K')!.birthday).toBe('--07-04');
  });

  it('changing the name recomputes FN and keeps prefix, additional name and suffix', () => {
    const r = applyEdits(APPLE, { givenName: 'Moritz' });
    expect(r.data).toContain('N:Muster;Moritz;Paul;Dr.;jun.');
    expect(r.data).toContain('FN:Dr. Moritz Paul Muster jun.');
  });

  it('folds long new lines at 75 octets without splitting characters, and escapes special characters', () => {
    const note = 'äöü,;\\ '.repeat(40);
    const r = applyEdits(APPLE, { notes: note });
    for (const l of lines(r.data)) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    expect(parseVCard(r.data, '/x.vcf', 'K')!.notes).toBe(note.trim());
  });

  it('adds nothing twice and says so', () => {
    const r = applyEdits(APPLE, { addEmails: [{ value: 'MAX@privat.de' }] });
    expect(r.data).toBe(APPLE);
    expect(r.notes[0]).toMatch(/already stored/);
  });

  it('refuses removing a value the contact does not have, and invalid values', () => {
    expect(() => applyEdits(APPLE, { removeEmails: ['nobody@example.com'] })).toThrow(UserError);
    expect(() => applyEdits(APPLE, { addEmails: [{ value: 'not-an-email' }] })).toThrow(/valid email/);
    expect(() => applyEdits(APPLE, { addPhones: [{ value: 'abc' }] })).toThrow(/valid phone/);
    expect(() => applyEdits(APPLE, { birthday: '1980-13-40' })).toThrow(/Birthday/);
  });

  it('keeps LF-terminated cards LF-terminated', () => {
    const lf = APPLE.replace(/\r\n/g, '\n');
    const r = applyEdits(lf, { addPhones: [{ value: '+49 1 23456', label: 'Work' }] });
    expect(r.data).not.toContain('\r');
    expect(r.data).toContain('TEL;type=WORK;type=VOICE:+49 1 23456');
  });

  it('removes and adds addresses', () => {
    const r = applyEdits(APPLE, { removeAddresses: [{ street: 'hauptstr. 1' }], addAddresses: [{ label: 'Work', street: 'Weg 2', city: 'Köln', postalCode: '50667', country: 'Deutschland' }] });
    expect(r.data).not.toContain('item3.');
    expect(r.data).toContain('ADR;type=WORK;type=pref:;;Weg 2;Köln;;50667;Deutschland');
  });

  it('does not let a contact lose both name and company', () => {
    const only = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Solo;Han;;;', 'FN:Han Solo', 'END:VCARD', ''].join(CRLF);
    expect(() => applyEdits(only, { givenName: '', familyName: '' })).toThrow(/needs at least a name/);
  });
});

describe('reading the Apple-specific fields', () => {
  const c = parseVCard(APPLE, '/u/card/x.vcf', 'K', '"e1"')!;
  it('parses department, relations, dates, social profiles, messengers, uid and etag', () => {
    expect(c).toMatchObject({
      organization: 'Beispiel GmbH',
      department: 'Vertrieb',
      birthday: '--03-15',
      dates: [{ label: 'Anniversary', value: '2010-06-12' }],
      relations: [{ label: 'Spouse', name: 'Anna Muster' }],
      socialProfiles: [{ service: 'twitter', user: 'maxmuster', url: 'http://twitter.com/maxmuster' }],
      messengers: [{ service: 'Skype', handle: 'max.muster', label: 'home' }],
      uid: '11111111-2222-3333-4444-555555555555',
      etag: '"e1"',
      notes: 'Erste Zeile\nZweite Zeile, mit Komma',
    });
    expect(c.urls[0]).toEqual({ label: 'HomePage', value: 'https://beispiel.de' });
    expect(JSON.stringify(c)).not.toContain('QUJDREVG');
  });
  it('reads X-AIM style messengers and skips groups', () => {
    const x = parseVCard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:A', 'X-JABBER;type=WORK:a@jabber.org', 'END:VCARD', ''].join(CRLF), '/x.vcf', 'K')!;
    expect(x.messengers).toEqual([{ service: 'jabber', handle: 'a@jabber.org', label: 'work' }]);
  });
  it('parses group cards', () => {
    const g = parseGroupCard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Family', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:AAA-1', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:BBB-2', 'END:VCARD', ''].join(CRLF), '/g.vcf')!;
    expect(g).toEqual({ id: '/g.vcf', name: 'Family', memberUids: ['aaa-1', 'bbb-2'] });
    expect(parseGroupCard(APPLE, '/x.vcf')).toBeUndefined();
  });
});

describe('upcoming dates', () => {
  const mk = (name: string, birthday?: string, dates: Array<{ label: string; value: string }> = []) => ({ id: `/${name}.vcf`, name, emails: [], phones: [], addresses: [], urls: [], addressBook: 'K', ...(birthday ? { birthday } : {}), dates });
  const now = DateTime.fromISO('2027-02-20T12:00:00', { zone: 'Europe/Berlin' });
  it('lists birthdays and other dates sorted, with age/years only when the year is known', () => {
    const r = upcomingDates(
      [mk('B', '--02-24'), mk('A', '1990-02-21'), mk('C', undefined, [{ label: 'Anniversary', value: '2017-03-01' }]), mk('Far', '1980-08-08'), mk('Today', '2000-02-20')],
      14,
      'Europe/Berlin',
      now,
    );
    expect(r.map((x) => [x.name, x.date, x.daysUntil])).toEqual([['Today', '2027-02-20', 0], ['A', '2027-02-21', 1], ['B', '2027-02-24', 4], ['C', '2027-03-01', 9]]);
    expect(r[0]).toMatchObject({ age: 27, label: 'Birthday', weekday: 'Saturday' });
    expect(r[2]!.age).toBeUndefined();
    expect(r[3]).toMatchObject({ years: 10, label: 'Anniversary' });
  });
  it('29 February counts on 28 February in years that are not leap years, and on the 29th in leap years', () => {
    expect(upcomingDates([mk('L', '2000-02-29')], 14, 'Europe/Berlin', now)[0]).toMatchObject({ date: '2027-02-28', age: 27 });
    const leap = DateTime.fromISO('2028-02-20T12:00:00', { zone: 'Europe/Berlin' });
    expect(upcomingDates([mk('L', '2000-02-29')], 14, 'Europe/Berlin', leap)[0]).toMatchObject({ date: '2028-02-29', age: 28 });
  });
  it('wraps into the next year', () => {
    const dec = DateTime.fromISO('2026-12-28T08:00:00', { zone: 'Europe/Berlin' });
    expect(upcomingDates([mk('N', '1999-01-02')], 14, 'Europe/Berlin', dec)[0]).toMatchObject({ date: '2027-01-02', daysUntil: 5, age: 28 });
  });
  it('the time zone decides what "today" is', () => {
    const late = DateTime.fromISO('2027-02-20T23:30:00Z');
    expect(upcomingDates([mk('X', '--02-21')], 3, 'Europe/Berlin', late)[0]!.daysUntil).toBe(0);
    expect(upcomingDates([mk('X', '--02-21')], 3, 'America/New_York', late)[0]!.daysUntil).toBe(1);
  });
});

/** In-memory CardDAV server with ETags. */
class FakeCards implements ContactStore {
  cards = new Map<string, { etag: string; data: string }>();
  creates = 0;
  updates = 0;
  lastCreate?: { filename: string; data: string };
  private n = 1;
  constructor(public groups: ContactData['groups'] = []) {}
  put(name: string, data: string) {
    const id = `/1/carddavhome/card/${name}.vcf`;
    this.cards.set(id, { etag: `"c${this.n++}"`, data });
    return id;
  }
  async loadAll() {
    const contacts = [...this.cards].map(([id, c]) => parseVCard(c.data, id, 'Contacts', c.etag)).filter((c): c is NonNullable<typeof c> => Boolean(c));
    return { contacts, groups: this.groups, truncated: false };
  }
  async getCard(id: string) {
    const c = this.cards.get(id);
    return c ? { id, ...c } : undefined;
  }
  async createCard(grant: ContactWriteGrant, filename: string, vcf: string): Promise<ContactCard> {
    if (!ContactWriteGrant.isValid(grant, 'create')) throw new Error('Write access without grant');
    this.creates++;
    this.lastCreate = { filename, data: vcf };
    const id = this.put(filename.replace(/\.vcf$/, ''), vcf);
    return { id, ...this.cards.get(id)! };
  }
  async updateCard(grant: ContactWriteGrant, card: { id: string; etag: string; data: string }): Promise<ContactCard> {
    if (!ContactWriteGrant.isValid(grant, 'update')) throw new Error('Write access without grant');
    const cur = this.cards.get(card.id);
    if (!cur || cur.etag !== card.etag) throw new UserError('The contact has changed in the meantime.');
    this.updates++;
    this.cards.set(card.id, { etag: `"c${this.n++}"`, data: card.data });
    return { id: card.id, ...this.cards.get(card.id)! };
  }
}

let root: string;
let fake: FakeCards;
let svc: ContactService;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'icloud-mcp-contacts-'));
  fake = new FakeCards();
  svc = new ContactService(fake, fake, new BackupStore({ dir: join(root, 'contacts-backup'), zone: 'Europe/Berlin', ext: 'vcf', what: 'contact', failure: 'The contact was NOT changed.' }), () => new Date('2026-10-09T10:00:00Z'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const backups = () => (existsSync(join(root, 'contacts-backup')) ? readdirSync(join(root, 'contacts-backup')) : []);

describe('groups', () => {
  it('lists groups with member counts and finds members by group, with or without a query', async () => {
    fake.put('a', APPLE);
    fake.put('b', ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Bea Beispiel', 'UID:BBB-2', 'END:VCARD', ''].join(CRLF));
    fake.put('g', ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Familie', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:11111111-2222-3333-4444-555555555555', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:GONE', 'END:VCARD', ''].join(CRLF));
    fake.groups = [parseGroupCard(fake.cards.get('/1/carddavhome/card/g.vcf')!.data, '/g.vcf')!];
    expect(await svc.listGroups()).toEqual([{ name: 'Familie', memberCount: 1 }]);
    expect((await svc.search(undefined, 20, 'familie')).contacts.map((c) => c.name)).toEqual(['Dr. Max Paul Muster jun.']);
    expect((await svc.search('muster', 20, 'Familie')).total).toBe(1);
    expect((await svc.search('bea', 20, 'Familie')).total).toBe(0);
    await expect(svc.search(undefined, 20, 'Nope')).rejects.toThrow(/No group/);
    await expect(svc.search(undefined, 20)).rejects.toThrow(/search term/);
    const c = await svc.get('/1/carddavhome/card/a.vcf');
    expect(c.groups).toEqual(['Familie']);
  });

  it('search also finds by street, city, postal code and country, but not by notes', async () => {
    fake.put('a', APPLE);
    for (const q of ['hauptstr', 'berlin', '10115', 'deutschland']) expect((await svc.search(q)).total, q).toBe(1);
    expect((await svc.search('zweite')).total).toBe(0);
  });
});

describe('create_contact', () => {
  it('writes an Apple-style vCard 3.0 with labels, a new UID and the file name <UID>.vcf', async () => {
    const r = await svc.createContact({
      givenName: 'Erika', familyName: 'Mustermann', organization: 'Acme', department: 'Einkauf', jobTitle: 'Leiterin', nickname: 'Eri',
      emails: [{ value: 'erika@acme.example', label: 'Work' }, { value: 'erika@privat.example', label: 'Other' }],
      phones: [{ value: '+49 170 111', label: 'Mobile' }, { value: '030 222' }],
      addresses: [{ label: 'Home', street: 'Weg 1', city: 'Köln', postalCode: '50667', country: 'Deutschland' }],
      urls: [{ value: 'https://acme.example', label: 'Homepage' }],
      birthday: '--03-09', notes: 'Zeile 1\nZeile 2, ok',
    });
    expect(r.created).toBe(true);
    const { filename, data } = fake.lastCreate!;
    expect(filename).toMatch(/^[0-9A-F-]{36}\.vcf$/);
    expect(data).toContain(`UID:${filename.replace('.vcf', '')}`);
    for (const l of [
      'N:Mustermann;Erika;;;', 'FN:Erika Mustermann', 'NICKNAME:Eri', 'ORG:Acme;Einkauf', 'TITLE:Leiterin',
      'EMAIL;type=INTERNET;type=WORK;type=pref:erika@acme.example', 'item1.EMAIL;type=INTERNET:erika@privat.example', 'item1.X-ABLabel:_$!<Other>!$_',
      'TEL;type=CELL;type=VOICE;type=pref:+49 170 111', 'TEL:030 222', 'ADR;type=HOME;type=pref:;;Weg 1;Köln;;50667;Deutschland',
      'item2.URL;type=pref:https://acme.example', 'item2.X-ABLabel:_$!<HomePage>!$_', 'BDAY;VALUE=date:1604-03-09', 'NOTE:Zeile 1\\nZeile 2\\, ok',
    ]) expect(data.split(CRLF), l).toContain(l);
    const c = parseVCard(data, '/x.vcf', 'K')!;
    expect(c).toMatchObject({ name: 'Erika Mustermann', department: 'Einkauf', birthday: '--03-09', notes: 'Zeile 1\nZeile 2, ok' });
    expect(c.emails.map((e) => e.label)).toEqual(['work', 'Other']);
    expect(r.contact?.name).toBe('Erika Mustermann');
  });

  it('a company-only contact is shown as a company', async () => {
    await svc.createContact({ organization: 'Nur Firma AG' });
    expect(fake.lastCreate!.data).toContain('FN:Nur Firma AG');
    expect(fake.lastCreate!.data).toContain('X-ABShowAs:COMPANY');
  });

  it.each([
    ['email', { givenName: 'Neu', emails: [{ value: 'MAX@privat.de' }] }, 'same email address'],
    ['phone (last 8 digits)', { givenName: 'Neu', phones: [{ value: '0170 1234567' }] }, 'same phone number'],
    ['name', { givenName: 'dr. max paul muster jun.', familyName: '' }, 'same name'],
  ])('creates nothing and returns the match when the %s already exists', async (_n, input, reason) => {
    fake.put('a', APPLE);
    const r = await svc.createContact(input);
    expect(r.created).toBe(false);
    expect(r.duplicates![0]!.reasons).toContain(reason);
    expect(fake.creates).toBe(0);
    const forced = await svc.createContact({ ...input, allowDuplicate: true });
    expect(forced.created).toBe(true);
    expect(fake.creates).toBe(1);
  });

  it('needs a name or a company, and validates values', async () => {
    await expect(svc.createContact({ notes: 'x' })).rejects.toThrow(/at least a first name/);
    await expect(svc.createContact({ givenName: 'A', emails: [{ value: 'bad' }] })).rejects.toThrow(/valid email/);
    await expect(svc.createContact({ givenName: 'A', department: 'X' })).rejects.toThrow(/needs a company/);
    expect(fake.creates).toBe(0);
  });

  it('control characters cannot add properties', () => {
    const { data } = buildVCard({ givenName: 'A', notes: 'x\r\nTEL:+49 1 2345', nickname: 'y' });
    expect(data.split(CRLF).filter((l) => l.startsWith('TEL'))).toEqual([]);
    expect(() => buildVCard({ givenName: 'A\u0000' })).toThrow(/control characters/);
  });
});

describe('update_contact', () => {
  const ID = '/1/carddavhome/card/a.vcf';
  beforeEach(() => fake.put('a', APPLE));
  const NAME = 'Dr. Max Paul Muster jun.';

  it('backs up the previous card, writes with the ETag and reports before/after', async () => {
    const etag = fake.cards.get(ID)!.etag;
    const r = await svc.updateContact({ id: ID, name: NAME, etag, addPhones: [{ value: '+49 30 555', label: 'Work' }], notes: 'Neu' });
    expect(fake.updates).toBe(1);
    expect(r.changes.map((c) => c.field)).toEqual(['notes', 'phones']);
    expect(r.changes[0]).toMatchObject({ before: 'Erste Zeile\nZweite Zeile, mit Komma', after: 'Neu' });
    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}_.*\.vcf$/);
    expect(readFileSync(r.backup.path, 'utf8')).toBe(APPLE);
    expect(statSync(r.backup.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'contacts-backup')).mode & 0o777).toBe(0o700);
    const stored = fake.cards.get(ID)!.data;
    expect(stored).toContain('UID:11111111-2222-3333-4444-555555555555');
    expect(stored).toContain(foldedPhoto);
  });

  it('refuses a wrong name, a stale ETag and unknown or invalid IDs; changes and backs up nothing', async () => {
    await expect(svc.updateContact({ id: ID, name: 'Someone Else', notes: 'x' })).rejects.toThrow(/name does not match/);
    await expect(svc.updateContact({ id: ID, name: NAME, etag: '"old"', notes: 'x' })).rejects.toThrow(/changed since it was fetched/);
    await expect(svc.updateContact({ id: '/1/carddavhome/card/zzz.vcf', name: NAME, notes: 'x' })).rejects.toThrow(/not found/);
    await expect(svc.updateContact({ id: 'https://evil.example/a.vcf', name: NAME, notes: 'x' })).rejects.toThrow(/Invalid contact ID/);
    await expect(svc.updateContact({ id: ID, name: NAME })).rejects.toThrow(/No change/);
    expect(fake.updates).toBe(0);
    expect(backups()).toEqual([]);
  });

  it('accepts the ETag without quotes', async () => {
    const etag = fake.cards.get(ID)!.etag.replace(/"/g, '');
    await expect(svc.updateContact({ id: ID, name: NAME, etag, notes: 'x' })).resolves.toBeTruthy();
  });

  it('refuses group cards', async () => {
    const gid = fake.put('g', ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Familie', 'X-ADDRESSBOOKSERVER-KIND:group', 'END:VCARD', ''].join(CRLF));
    await expect(svc.updateContact({ id: gid, name: 'Familie', notes: 'x' })).rejects.toThrow(/group|not a contact card/);
    expect(fake.updates).toBe(0);
  });

  it('writes nothing when the backup fails', async () => {
    const blocked = join(root, 'file');
    (await import('node:fs')).writeFileSync(blocked, 'x');
    const s = new ContactService(fake, fake, new BackupStore({ dir: join(blocked, 'sub'), zone: 'Europe/Berlin', ext: 'vcf', what: 'contact', failure: 'The contact was NOT changed.' }));
    await expect(s.updateContact({ id: ID, name: NAME, notes: 'x' })).rejects.toThrow(/backup.*NOT changed/);
    expect(fake.updates).toBe(0);
  });

  it('removes the backup again when the write is refused', async () => {
    fake.updateCard = async () => {
      throw new UserError('The contact has changed in the meantime.');
    };
    await expect(svc.updateContact({ id: ID, name: NAME, notes: 'x' })).rejects.toThrow(/changed in the meantime/);
    expect(backups()).toEqual([]);
  });
});

describe('grants and schemas', () => {
  it('the gateway-facing store refuses forged grants', async () => {
    const fake2 = new FakeCards();
    await expect(fake2.createCard({ op: 'create', target: 'x.vcf' } as never, 'x.vcf', 'x')).rejects.toThrow(/without grant/);
    await expect(fake2.updateCard({ op: 'update', target: '/a.vcf' } as never, { id: '/a.vcf', etag: '"1"', data: 'x' })).rejects.toThrow(/without grant/);
    const g = authorizeContactWrite({ op: 'create', target: 'ABCDEFGH-1234.vcf', vcard: 'BEGIN:VCARD\r\nEND:VCARD\r\n' });
    await expect(fake2.updateCard(g, { id: '/a.vcf', etag: '"1"', data: 'x' })).rejects.toThrow(/without grant/);
  });

  it('authorizeContactWrite refuses group cards and bad targets', () => {
    expect(() => authorizeContactWrite({ op: 'update', target: '/a.vcf', vcard: 'BEGIN:VCARD\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nEND:VCARD\r\n' })).toThrow(/group/);
    expect(() => authorizeContactWrite({ op: 'update', target: '/a/../b.vcf', vcard: 'BEGIN:VCARD\r\nEND:VCARD\r\n' })).toThrow(/Invalid contact ID/);
    expect(() => authorizeContactWrite({ op: 'create', target: '../x.vcf', vcard: 'BEGIN:VCARD\r\nEND:VCARD\r\n' })).toThrow(/file name/);
  });

  it('schemas reject unknown fields such as photo, group or uid', () => {
    expect(createContactSchema.safeParse({ given_name: 'A' }).success).toBe(true);
    for (const f of ['photo', 'group', 'groups', 'uid', 'kind']) {
      expect(createContactSchema.safeParse({ given_name: 'A', [f]: 'x' }).success, f).toBe(false);
      expect(updateContactSchema.safeParse({ id: '/a/b.vcf', name: 'A', [f]: 'x' }).success, f).toBe(false);
    }
  });
});
