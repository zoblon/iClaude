import ICAL from 'ical.js';
import { clip } from '../untrusted.js';

export interface Labeled {
  label: string;
  value: string;
}

export interface Address {
  label: string;
  street?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface Relation {
  label: string;
  name: string;
}

export interface SocialProfile {
  service: string;
  user?: string;
  url?: string;
}

export interface Messenger {
  service: string;
  handle: string;
  label?: string;
}

export interface Contact {
  /** Path of the .vcf resource; identifies the contact (for get_contact). */
  id: string;
  /** UID inside the vCard (links the contact to the groups it is in). */
  uid?: string;
  /** ETag of the resource at the time it was loaded (for update_contact). */
  etag?: string;
  name: string;
  nickname?: string;
  organization?: string;
  department?: string;
  jobTitle?: string;
  emails: Labeled[];
  phones: Labeled[];
  addresses: Address[];
  urls: Labeled[];
  birthday?: string;
  /** Further dates (X-ABDATE) such as an anniversary, with their label. */
  dates?: Labeled[];
  relations?: Relation[];
  socialProfiles?: SocialProfile[];
  messengers?: Messenger[];
  /** Names of the groups the contact is in (filled in by the service from the group cards). */
  groups?: string[];
  notes?: string;
  addressBook: string;
}

/** A contact group: an iCloud vCard with X-ADDRESSBOOKSERVER-KIND:group. Groups are only ever read. */
export interface ContactGroup {
  id: string;
  name: string;
  /** UIDs of the member contacts (from X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<UID>). */
  memberUids: string[];
}

const MAX_ITEMS = 10;
const TEXT = 200;

/** "_$!<Work>!$_" -> "Work", "item" -> empty. */
export function cleanLabel(raw: string): string {
  return raw.replace(/^_\$!<(.*)>!\$_$/, '$1').trim();
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/** vCard text unescaping for values ical.js hands over raw (unknown and URI types). */
export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,:nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

function typeLabel(p: ICAL.Property, labels: Map<string, string>): string {
  const group = p.getParameter('group') as string | undefined;
  if (group && labels.has(group)) return labels.get(group)!;
  const types = asList(p.getParameter('type'))
    .map((t) => t.toLowerCase())
    .filter((t) => !['pref', 'internet', 'voice', 'x-apple'].includes(t));
  return types.join(', ');
}

/** A date from a card; year is undefined when Apple's placeholder (1604, 1900) or X-APPLE-OMIT-YEAR says so. */
export interface CardDate {
  year?: number;
  month: number;
  day: number;
}

const daysIn = (month: number) => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

/** Parses "1980-05-17", "19800517", "--05-17", "--0517", "1604-03-15" and the like. Undefined for anything else. */
export function parseCardDate(raw: string, omitYear?: string): CardDate | undefined {
  const s = raw.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ].*)?$/.exec(s);
  let year: number | undefined;
  let month: number;
  let day: number;
  if (m) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else {
    m = /^--(\d{2})-?(\d{2})$/.exec(s);
    if (!m) return undefined;
    month = Number(m[1]);
    day = Number(m[2]);
  }
  if (month < 1 || month > 12 || day < 1 || day > daysIn(month)) return undefined;
  // Apple stores dates without a year as 1604 (or 1900); X-APPLE-OMIT-YEAR names the placeholder year.
  if (year !== undefined && (year <= 1900 || (omitYear !== undefined && String(year) === omitYear.trim()))) year = undefined;
  return { ...(year !== undefined ? { year } : {}), month, day };
}

const two = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD", or "--MM-DD" when the year is unknown. */
export function formatCardDate(d: CardDate): string {
  return d.year !== undefined ? `${String(d.year).padStart(4, '0')}-${two(d.month)}-${two(d.day)}` : `--${two(d.month)}-${two(d.day)}`;
}

function dateOf(p: ICAL.Property | null): string | undefined {
  if (!p) return undefined;
  try {
    const raw = String((p.toJSON() as unknown[])[3] ?? '');
    const omit = p.getParameter('x-apple-omit-year') as string | undefined;
    const d = parseCardDate(raw, omit);
    return d ? formatCardDate(d) : clip(raw, 20) || undefined;
  } catch {
    return undefined;
  }
}

const safe = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

function parseCard(data: string): ICAL.Component | undefined {
  try {
    const card = new ICAL.Component(ICAL.parse(data));
    return card.name === 'vcard' ? card : undefined;
  } catch {
    return undefined;
  }
}

function isGroup(card: ICAL.Component): boolean {
  return (
    String(card.getFirstPropertyValue('x-addressbookserver-kind') ?? '').toLowerCase() === 'group' ||
    String(card.getFirstPropertyValue('kind') ?? '').toLowerCase() === 'group'
  );
}

/** Parses a group card. Undefined for anything that is not a group. */
export function parseGroupCard(data: string, id: string): ContactGroup | undefined {
  const card = parseCard(data);
  if (!card || !isGroup(card)) return undefined;
  const name = clip(String(safe(() => card.getFirstPropertyValue('fn')) ?? '').trim(), TEXT) || '(unnamed group)';
  const memberUids = card
    .getAllProperties('x-addressbookserver-member')
    .map((p) => String(safe(() => p.getFirstValue()) ?? '').replace(/^urn:uuid:/i, '').trim().toLowerCase())
    .filter(Boolean);
  return { id, name, memberUids: [...new Set(memberUids)] };
}

/** Messenger properties besides IMPP: X-AIM, X-JABBER, X-ICQ, X-MSN, X-YAHOO, X-SKYPE, … */
const X_MESSENGER = /^x-(aim|jabber|icq|msn|yahoo|skype|skype-username|gadugadu|groupwise|qq|googletalk|facebook|twitter)$/i;

/** Parses a vCard. Returns undefined for groups and unreadable entries. Photos are deliberately ignored. */
export function parseVCard(data: string, id: string, addressBook: string, etag?: string): Contact | undefined {
  const card = parseCard(data);
  if (!card || isGroup(card)) return undefined;

  const labels = new Map<string, string>();
  for (const p of card.getAllProperties('x-ablabel')) {
    const g = p.getParameter('group') as string | undefined;
    if (g) labels.set(g, cleanLabel(unescapeText(String(p.getFirstValue() ?? ''))));
  }

  const labeled = (prop: string): Labeled[] =>
    card
      .getAllProperties(prop)
      .slice(0, MAX_ITEMS)
      .map((p) => safe(() => ({ label: typeLabel(p, labels), value: clip(String(p.getFirstValue() ?? '').replace(/^mailto:|^tel:/i, ''), TEXT) })))
      .filter((x): x is Labeled => Boolean(x?.value));

  const n = asList(safe(() => card.getFirstPropertyValue('n')));
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] = n;
  const composed = [prefix, given, additional, family, suffix].map((s) => s.trim()).filter(Boolean).join(' ');
  // ORG is "Company;Department;…": the first part is the company, the rest the department.
  const orgParts = asList(safe(() => card.getFirstPropertyValue('org'))).map((s) => s.trim());
  const organization = orgParts[0] ?? '';
  const department = orgParts.slice(1).filter(Boolean).join(', ');
  const fn = String(safe(() => card.getFirstPropertyValue('fn')) ?? '').trim();
  const name = clip(fn || composed || organization, TEXT) || '(no name)';

  const addresses: Address[] = card
    .getAllProperties('adr')
    .slice(0, 5)
    .map((p) => {
      const [, , street = '', city = '', region = '', postalCode = '', country = ''] = asList(safe(() => p.getFirstValue()));
      return {
        label: typeLabel(p, labels),
        ...(street ? { street: clip(street, TEXT) } : {}),
        ...(city ? { city: clip(city, TEXT) } : {}),
        ...(region ? { region: clip(region, TEXT) } : {}),
        ...(postalCode ? { postalCode: clip(postalCode, 20) } : {}),
        ...(country ? { country: clip(country, TEXT) } : {}),
      };
    })
    .filter((a) => a.street || a.city || a.postalCode || a.country);

  const urls = card
    .getAllProperties('url')
    .slice(0, MAX_ITEMS)
    .map((p) => safe(() => ({ label: typeLabel(p, labels), value: clip(unescapeText(String(p.getFirstValue() ?? '')), TEXT) })))
    .filter((x): x is Labeled => Boolean(x?.value));

  const dates: Labeled[] = card
    .getAllProperties('x-abdate')
    .slice(0, MAX_ITEMS)
    .map((p) => {
      const v = dateOf(p);
      return v ? { label: typeLabel(p, labels), value: v } : undefined;
    })
    .filter((x): x is Labeled => Boolean(x));

  const relations: Relation[] = card
    .getAllProperties('x-abrelatednames')
    .slice(0, MAX_ITEMS)
    .map((p) => safe(() => ({ label: typeLabel(p, labels), name: clip(unescapeText(String(p.getFirstValue() ?? '')), TEXT) })))
    .filter((x): x is Relation => Boolean(x?.name));

  const socialProfiles: SocialProfile[] = card
    .getAllProperties('x-socialprofile')
    .slice(0, MAX_ITEMS)
    .map((p) => {
      const service = asList(p.getParameter('type'))
        .filter((t) => t.toLowerCase() !== 'pref')
        .join(', ');
      const user = String(p.getParameter('x-user') ?? '').trim();
      const url = clip(unescapeText(String(safe(() => p.getFirstValue()) ?? '')), TEXT);
      return { service: clip(service, 60), ...(user ? { user: clip(user, TEXT) } : {}), ...(url ? { url } : {}) };
    })
    .filter((s) => s.user || s.url);

  const messengers: Messenger[] = [];
  for (const p of card.getAllProperties()) {
    if (messengers.length >= MAX_ITEMS) break;
    const nameLower = p.name.toLowerCase();
    const value = clip(unescapeText(String(safe(() => p.getFirstValue()) ?? '')), TEXT);
    if (!value) continue;
    const kind = asList(p.getParameter('type')).filter((t) => t.toLowerCase() !== 'pref').join(', ');
    if (nameLower === 'impp') {
      const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value);
      const service = String(p.getParameter('x-service-type') ?? '') || scheme?.[1] || '';
      messengers.push({ service: clip(service, 60), handle: scheme ? scheme[2]! : value, ...(kind ? { label: kind.toLowerCase() } : {}) });
    } else if (X_MESSENGER.test(nameLower)) {
      messengers.push({ service: nameLower.slice(2), handle: value, ...(kind ? { label: kind.toLowerCase() } : {}) });
    }
  }

  const nickname = String(safe(() => card.getFirstPropertyValue('nickname')) ?? '').trim();
  const jobTitle = String(safe(() => card.getFirstPropertyValue('title')) ?? '').trim();
  // ical.js does not unescape "\\;" in vCard 3.0 text, so the note is decoded here from the raw line.
  const rawNote = /^NOTE(?:;[^:\r\n]*)?:(.*)$/im.exec(data.replace(/\r?\n[ \t]/g, ''))?.[1];
  const notes = (rawNote !== undefined ? unescapeText(rawNote) : '').trim();
  const birthday = dateOf(card.getFirstProperty('bday'));
  const uid = String(safe(() => card.getFirstPropertyValue('uid')) ?? '').trim();

  return {
    id,
    ...(uid ? { uid } : {}),
    ...(etag ? { etag } : {}),
    name,
    ...(nickname ? { nickname: clip(nickname, TEXT) } : {}),
    ...(organization ? { organization: clip(organization, TEXT) } : {}),
    ...(department ? { department: clip(department, TEXT) } : {}),
    ...(jobTitle ? { jobTitle: clip(jobTitle, TEXT) } : {}),
    emails: labeled('email'),
    phones: labeled('tel'),
    addresses,
    urls,
    ...(birthday ? { birthday } : {}),
    ...(dates.length ? { dates } : {}),
    ...(relations.length ? { relations } : {}),
    ...(socialProfiles.length ? { socialProfiles } : {}),
    ...(messengers.length ? { messengers } : {}),
    ...(notes ? { notes: clip(notes, 2000) } : {}),
    addressBook,
  };
}
