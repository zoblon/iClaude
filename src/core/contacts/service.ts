import { UserError } from '../errors.js';
import type { Contact } from './vcard.js';

const MAX_LIMIT = 50;

/** Lesender Zugriff auf Kontakte (austauschbar). Es gibt bewusst keine Schreibmethoden. */
export interface ContactReader {
  loadAll(): Promise<{ contacts: Contact[]; truncated: boolean }>;
}

const strip = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Kleinbuchstaben, Akzente entfernt (ü -> u), ß -> ss. */
export function norm(s: string): string {
  return strip(s.toLowerCase().replace(/ß/g, 'ss'));
}

/** Deutsche Schreibweise: ü -> ue, ä -> ae, ö -> oe, ß -> ss (so tippen viele "Mueller" für "Müller"). */
function normDe(s: string): string {
  return strip(s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'));
}

/** Beide Schreibweisen eines Textes: Suchbegriff und Daten werden jeweils gleich umgewandelt und verglichen. */
type Forms = readonly [string, string];
const forms = (s: string): Forms => [normDe(s), norm(s)];
const includes = (hay: Forms, t: Forms) => hay[0].includes(t[0]) || hay[1].includes(t[1]);
const equals = (hay: Forms, t: Forms) => hay[0] === t[0] || hay[1] === t[1];
const wordStarts = (hay: Forms, t: Forms) =>
  hay[0].split(/\s+/).some((w) => w.startsWith(t[0])) || hay[1].split(/\s+/).some((w) => w.startsWith(t[1]));

const digits = (s: string) => s.replace(/\D/g, '');

/** Kompakte Ausgabe für Trefferlisten. */
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

export class ContactService {
  constructor(private readonly reader: ContactReader) {}

  /** Alle Suchwörter müssen in Name, Spitzname, Firma, Mailadressen oder Telefonnummern vorkommen. */
  async search(query: string, limit = 20): Promise<{ total: number; contacts: ContactSummary[]; cut: boolean; truncated: boolean }> {
    const tokens = query.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new UserError('Der Suchbegriff darf nicht leer sein. Bitte einen Suchbegriff angeben.');
    const { contacts, truncated } = await this.reader.loadAll();
    const tokenForms = tokens.map((t) => ({ f: forms(t), digits: digits(t), isNumber: digits(t) === t.replace(/[\s+()\-./]/g, '') }));

    const scored: Array<{ c: Contact; score: number }> = [];
    for (const c of contacts) {
      const name = forms(c.name);
      const hay = forms([c.name, c.nickname ?? '', c.organization ?? '', ...c.emails.map((e) => e.value)].join(' \n '));
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
      throw new UserError('Ungültige Kontakt-ID. Die ID aus search_contacts unverändert verwenden.');
    }
    const { contacts } = await this.reader.loadAll();
    const hit = contacts.find((c) => c.id === id);
    if (!hit) throw new UserError('Kontakt nicht gefunden. Die ID stammt evtl. aus einer früheren Abfrage; bitte erneut mit search_contacts suchen.');
    return hit;
  }
}
