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

export interface Contact {
  /** Pfad der .vcf-Ressource; identifiziert den Kontakt (für get_contact). */
  id: string;
  name: string;
  nickname?: string;
  organization?: string;
  jobTitle?: string;
  emails: Labeled[];
  phones: Labeled[];
  addresses: Address[];
  urls: Labeled[];
  birthday?: string;
  notes?: string;
  addressBook: string;
}

const MAX_ITEMS = 10;
const TEXT = 200;

/** "_$!<Work>!$_" -> "Work", "item" -> leer. */
function cleanLabel(raw: string): string {
  return raw.replace(/^_\$!<(.*)>!\$_$/, '$1').trim();
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

function typeLabel(p: ICAL.Property, labels: Map<string, string>): string {
  const group = p.getParameter('group') as string | undefined;
  if (group && labels.has(group)) return labels.get(group)!;
  const types = asList(p.getParameter('type'))
    .map((t) => t.toLowerCase())
    .filter((t) => !['pref', 'internet', 'voice', 'x-apple'].includes(t));
  return types.join(', ');
}

function birthdayOf(p: ICAL.Property | null): string | undefined {
  if (!p) return undefined;
  try {
    const v = p.getFirstValue() as unknown;
    if (v && typeof v === 'object' && 'month' in v) {
      const t = v as { year: number; month: number; day: number };
      const mmdd = `${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
      // Apple speichert Geburtstage ohne Jahr mit 1604 oder 1900
      return t.year <= 1900 ? `--${mmdd}` : `${t.year}-${mmdd}`;
    }
    return clip(String(v), 20);
  } catch {
    return undefined;
  }
}

/** Liest eine vCard. Gibt undefined für Gruppen und unlesbare Einträge zurück. Fotos werden bewusst ignoriert. */
export function parseVCard(data: string, id: string, addressBook: string): Contact | undefined {
  let card: ICAL.Component;
  try {
    card = new ICAL.Component(ICAL.parse(data));
  } catch {
    return undefined;
  }
  if (card.name !== 'vcard') return undefined;
  if (String(card.getFirstPropertyValue('x-addressbookserver-kind') ?? '').toLowerCase() === 'group') return undefined;
  if (String(card.getFirstPropertyValue('kind') ?? '').toLowerCase() === 'group') return undefined;

  const labels = new Map<string, string>();
  for (const p of card.getAllProperties('x-ablabel')) {
    const g = p.getParameter('group') as string | undefined;
    if (g) labels.set(g, cleanLabel(String(p.getFirstValue() ?? '')));
  }

  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const labeled = (prop: string): Labeled[] =>
    card
      .getAllProperties(prop)
      .slice(0, MAX_ITEMS)
      .map((p) => safe(() => ({ label: typeLabel(p, labels), value: clip(String(p.getFirstValue() ?? '').replace(/^mailto:|^tel:/i, ''), TEXT) })))
      .filter((x): x is Labeled => Boolean(x?.value));

  const n = asList(safe(() => card.getFirstPropertyValue('n')));
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] = n;
  const composed = [prefix, given, additional, family, suffix].map((s) => s.trim()).filter(Boolean).join(' ');
  const orgParts = asList(safe(() => card.getFirstPropertyValue('org'))).filter(Boolean);
  const organization = orgParts.join(', ');
  const fn = String(safe(() => card.getFirstPropertyValue('fn')) ?? '').trim();
  const name = clip(fn || composed || organization, TEXT) || '(ohne Namen)';

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

  const nickname = String(safe(() => card.getFirstPropertyValue('nickname')) ?? '').trim();
  const jobTitle = String(safe(() => card.getFirstPropertyValue('title')) ?? '').trim();
  const notes = String(safe(() => card.getFirstPropertyValue('note')) ?? '').trim();
  const birthday = birthdayOf(card.getFirstProperty('bday'));

  return {
    id,
    name,
    ...(nickname ? { nickname: clip(nickname, TEXT) } : {}),
    ...(organization ? { organization: clip(organization, TEXT) } : {}),
    ...(jobTitle ? { jobTitle: clip(jobTitle, TEXT) } : {}),
    emails: labeled('email'),
    phones: labeled('tel'),
    addresses,
    urls: labeled('url'),
    ...(birthday ? { birthday } : {}),
    ...(notes ? { notes: clip(notes, 2000) } : {}),
    addressBook,
  };
}
