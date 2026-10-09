/**
 * Line-level vCard editing for Apple (iCloud) contacts.
 *
 * ical.js must NOT re-serialize a vCard: ICAL.stringify capitalises group prefixes (item1 -> ITEM1), merges several
 * `type` parameters and turns `BDAY;VALUE=date:1604-03-15` into `16040315`. So the card is kept as text: it is split
 * into logical lines (a folded property stays one logical line with its original bytes), only the lines that are
 * touched are changed, added or removed, and every other line is written out byte for byte as it was read.
 */
import { randomUUID } from 'node:crypto';
import { UserError } from '../errors.js';
import { parseCardDate, unescapeText, type CardDate } from './vcard.js';

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

/** Escapes a vCard 3.0 text value: backslash, semicolon, comma and line breaks. */
export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds a content line at 75 octets (continuation lines start with one space), never inside a UTF-8 character. */
export function foldLine(text: string, eol = '\r\n'): string {
  const parts: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // the leading space of a continuation line counts as one octet
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join(`${eol} `);
}

/** Splits a structured value (N, ORG, ADR) at unescaped semicolons. The parts keep their escaping. */
export function splitStructured(value: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\' && i + 1 < value.length) {
      cur += c + value[i + 1]!;
      i++;
    } else if (c === ';') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/;

function cleanInput(s: string, max: number, what: string): string {
  const t = s.replace(/\r\n|\r/g, '\n').trim();
  if (CONTROL.test(t)) throw new UserError(`${what} contains control characters. Nothing was changed.`);
  if (Array.from(t).length > max) throw new UserError(`${what} is too long (max. ${max} characters). Nothing was changed.`);
  return t;
}

const oneLine = (s: string, max: number, what: string) => cleanInput(s, max, what).replace(/\s*\n\s*/g, ' ');

/* ------------------------------------------------------------------ */
/* The card as text                                                    */
/* ------------------------------------------------------------------ */

export interface VLine {
  /** Exact original text of the logical line, including the line breaks of its folds. Not including the line terminator. */
  raw: string;
  /** Line terminator that followed this line in the original ('' for a last line without one). */
  eol: string;
  /** Unfolded content. */
  text: string;
  group?: string;
  /** Property name in upper case. */
  name: string;
  /** Parameters including their leading semicolons, e.g. ";type=INTERNET;type=pref". */
  params: string;
  /** Raw value (still escaped). */
  value: string;
}

/** Splits "group.NAME;params:value". The colon in quoted parameter values does not end the parameters. */
export function parseLine(text: string): Omit<VLine, 'raw' | 'eol' | 'text'> {
  let i = 0;
  while (i < text.length && text[i] !== ':' && text[i] !== ';') i++;
  const head = text.slice(0, i);
  const dot = head.indexOf('.');
  const group = dot > 0 ? head.slice(0, dot) : undefined;
  const name = (dot > 0 ? head.slice(dot + 1) : head).toUpperCase();
  const paramsStart = i;
  let quoted = false;
  while (i < text.length && (quoted || text[i] !== ':')) {
    if (text[i] === '"') quoted = !quoted;
    i++;
  }
  return { ...(group ? { group } : {}), name, params: text.slice(paramsStart, i), value: text.slice(i + 1) };
}

export class VCardText {
  private constructor(
    public lines: VLine[],
    private readonly eol: string,
  ) {}

  static parse(text: string): VCardText {
    const pieces = text.split(/(\r\n|\n|\r)/);
    const eol = /\r\n|\n|\r/.exec(text)?.[0] ?? '\r\n';
    const lines: VLine[] = [];
    for (let k = 0; k < pieces.length; k += 2) {
      const phys = pieces[k]!;
      const term = pieces[k + 1] ?? '';
      const prev = lines[lines.length - 1];
      if (prev && (phys.startsWith(' ') || phys.startsWith('\t'))) {
        prev.raw += prev.eol + phys;
        prev.eol = term;
        continue;
      }
      if (phys === '' && term === '' && k > 0) continue; // text ends with a line terminator
      lines.push({ raw: phys, eol: term, text: '', name: '', params: '', value: '' });
    }
    for (const l of lines) {
      l.text = l.raw.replace(/(?:\r\n|\n|\r)[ \t]/g, '');
      Object.assign(l, parseLine(l.text));
    }
    return new VCardText(lines, eol);
  }

  toString(): string {
    return this.lines.map((l) => l.raw + l.eol).join('');
  }

  /** The line terminator used when adding lines (that of the original card). */
  get newline(): string {
    return this.eol;
  }

  all(name: string): VLine[] {
    const n = name.toUpperCase();
    return this.lines.filter((l) => l.name === n);
  }

  first(name: string): VLine | undefined {
    return this.all(name)[0];
  }

  /** A new line object (folded) that is not yet part of the card. */
  make(text: string): VLine {
    const raw = foldLine(text, this.eol);
    const l: VLine = { raw, eol: this.eol, text, name: '', params: '', value: '' };
    Object.assign(l, parseLine(text));
    return l;
  }

  private ensureTerminated(index: number): void {
    // a card whose last line has no terminator gets one when something follows it
    const l = this.lines[index];
    if (l && l.eol === '') l.eol = this.eol;
  }

  replace(line: VLine, text: string): void {
    const i = this.lines.indexOf(line);
    if (i < 0) throw new Error('line not in card');
    const n = this.make(text);
    n.eol = line.eol;
    this.lines[i] = n;
  }

  insertAfter(anchor: VLine | undefined, texts: string[]): VLine[] {
    const made = texts.map((t) => this.make(t));
    if (!made.length) return made;
    let at: number;
    if (anchor) {
      at = this.lines.indexOf(anchor) + 1;
    } else {
      const end = this.lines.map((l) => l.name).lastIndexOf('END');
      at = end >= 0 ? end : this.lines.length;
    }
    this.ensureTerminated(at - 1);
    this.lines.splice(at, 0, ...made);
    return made;
  }

  /** The last line of a property block: the property and the lines of its group (X-ABLabel, X-ABADR, …). */
  lastOfBlock(name: string): VLine | undefined {
    const props = this.all(name);
    let last: VLine | undefined;
    for (const p of props) {
      const block = p.group ? this.lines.filter((l) => l.group?.toLowerCase() === p.group!.toLowerCase()) : [p];
      for (const b of block) if (!last || this.lines.indexOf(b) > this.lines.indexOf(last)) last = b;
    }
    return last;
  }

  /** Removes a property and, if it has a group prefix, the other lines of its group (labels). */
  removeBlock(line: VLine): void {
    const g = line.group?.toLowerCase();
    const doomed = new Set(g ? this.lines.filter((l) => l.group?.toLowerCase() === g) : [line]);
    this.lines = this.lines.filter((l) => !doomed.has(l));
  }

  /** Next free "itemN" group name (never collides with an existing one). */
  itemAllocator(): () => string {
    let max = 0;
    for (const l of this.lines) {
      const m = /^item(\d+)$/i.exec(l.group ?? '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return () => `item${++max}`;
  }
}

/* ------------------------------------------------------------------ */
/* Labels the way Apple writes them                                    */
/* ------------------------------------------------------------------ */

export type Kind = 'email' | 'tel' | 'adr' | 'url';

export interface LabeledInput {
  value: string;
  label?: string | undefined;
}

export interface AddressInput {
  label?: string | undefined;
  street?: string | undefined;
  city?: string | undefined;
  region?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
}

interface LabelSpec {
  /** Written as type=… parameters. */
  types: string[];
  /** Written as itemN.X-ABLabel:… (Apple's way for other and custom labels). */
  itemLabel?: string;
}

/** "Home"/"Work" become type parameters; Other, Main, HomePage and custom labels go through itemN.X-ABLabel. */
export function labelSpec(kind: Kind, label: string | undefined): LabelSpec {
  const l = (label ?? '').trim();
  const k = l.toLowerCase().replace(/[\s_-]+/g, '');
  if (!l) return { types: [] };
  if (k === 'home') return { types: kind === 'tel' ? ['HOME', 'VOICE'] : ['HOME'] };
  if (k === 'work') return { types: kind === 'tel' ? ['WORK', 'VOICE'] : ['WORK'] };
  if (kind === 'tel') {
    if (k === 'mobile' || k === 'cell') return { types: ['CELL', 'VOICE'] };
    if (k === 'homefax') return { types: ['HOME', 'FAX'] };
    if (k === 'workfax') return { types: ['WORK', 'FAX'] };
    if (k === 'pager') return { types: ['PAGER'] };
    if (k === 'iphone') return { types: [], itemLabel: 'iPhone' };
    if (k === 'main') return { types: [], itemLabel: '_$!<Main>!$_' };
  }
  if (kind === 'url' && k === 'homepage') return { types: [], itemLabel: '_$!<HomePage>!$_' };
  if (k === 'other') return { types: [], itemLabel: '_$!<Other>!$_' };
  return { types: [], itemLabel: escapeText(oneLine(l, 60, 'A label')) };
}

/* ------------------------------------------------------------------ */
/* Building property lines                                             */
/* ------------------------------------------------------------------ */

const typeParams = (kind: Kind, types: string[], pref: boolean): string => {
  const all = [...(kind === 'email' ? ['INTERNET'] : []), ...types, ...(pref ? ['pref'] : [])];
  return all.map((t) => `;type=${t}`).join('');
};

export function validateEmail(v: string): string {
  const t = oneLine(v, 254, 'An email address');
  if (!/^[^\s@;,<>"]+@[^\s@;,<>"]+\.[^\s@;,<>"]+$/.test(t)) throw new UserError(`"${t.slice(0, 60)}" is not a valid email address. Nothing was changed.`);
  return t;
}

export function validatePhone(v: string): string {
  const t = oneLine(v, 40, 'A phone number');
  if (!/^[+()\d][\d\s()+./\-#*;,pwPW]*$/.test(t) || t.replace(/\D/g, '').length < 3) {
    throw new UserError(`"${t.slice(0, 40)}" is not a valid phone number. Nothing was changed.`);
  }
  return t;
}

export function validateUrl(v: string): string {
  const t = oneLine(v, 500, 'A web address');
  if (/\s/.test(t) || !/^[a-z][a-z0-9+.-]*:\/?\/?\S+$|^www\.\S+$/i.test(t)) throw new UserError(`"${t.slice(0, 60)}" is not a valid web address. Nothing was changed.`);
  return t;
}

/** Lines for one labeled value: the property and, for itemN labels, the X-ABLabel line. */
function propertyLines(kind: Kind, value: string, label: string | undefined, pref: boolean, nextItem: () => string): string[] {
  const spec = labelSpec(kind, label);
  const name = kind === 'tel' ? 'TEL' : kind === 'adr' ? 'ADR' : kind === 'url' ? 'URL' : 'EMAIL';
  if (spec.itemLabel !== undefined) {
    const g = nextItem();
    return [`${g}.${name}${typeParams(kind, [], pref)}:${value}`, `${g}.X-ABLabel:${spec.itemLabel}`];
  }
  return [`${name}${typeParams(kind, spec.types, pref)}:${value}`];
}

const adrValue = (a: AddressInput): string =>
  [
    '',
    '',
    escapeText(oneLine(a.street ?? '', 200, 'The street')),
    escapeText(oneLine(a.city ?? '', 100, 'The city')),
    escapeText(oneLine(a.region ?? '', 100, 'The region')),
    escapeText(oneLine(a.postalCode ?? '', 20, 'The postal code')),
    escapeText(oneLine(a.country ?? '', 100, 'The country')),
  ].join(';');

const hasAddressData = (a: AddressInput) => Boolean(a.street?.trim() || a.city?.trim() || a.region?.trim() || a.postalCode?.trim() || a.country?.trim());

/** "1980-05-17", "--05-17" or "05-17" -> card date; throws on anything else. */
export function parseBirthdayInput(s: string): CardDate {
  const t = s.trim();
  const d = parseCardDate(/^\d{2}-\d{2}$/.test(t) ? `--${t}` : t);
  if (!d || (/^\d{4}/.test(t) && d.year === undefined)) {
    throw new UserError(`Birthday "${t.slice(0, 20)}" is invalid. Use YYYY-MM-DD, or --MM-DD (or MM-DD) when the year is unknown.`);
  }
  return d;
}

/** Apple writes dates without a year with the placeholder year 1604: "BDAY;VALUE=date:1604-03-15". */
export function birthdayLine(d: CardDate): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `BDAY;VALUE=date:${d.year !== undefined ? String(d.year).padStart(4, '0') : '1604'}-${two(d.month)}-${two(d.day)}`;
}

/* ------------------------------------------------------------------ */
/* Creating a card                                                     */
/* ------------------------------------------------------------------ */

export interface NewContact {
  givenName?: string | undefined;
  familyName?: string | undefined;
  organization?: string | undefined;
  department?: string | undefined;
  jobTitle?: string | undefined;
  nickname?: string | undefined;
  emails?: LabeledInput[] | undefined;
  phones?: LabeledInput[] | undefined;
  addresses?: AddressInput[] | undefined;
  urls?: LabeledInput[] | undefined;
  birthday?: string | undefined;
  notes?: string | undefined;
}

const MAX_PER_KIND = 10;

/** FN: how Apple composes the display name. */
const composeFn = (prefix: string, given: string, additional: string, family: string, suffix: string) =>
  [prefix, given, additional, family, suffix].map((s) => s.trim()).filter(Boolean).join(' ');

export function buildVCard(c: NewContact, now: Date = new Date(), uid: string = randomUUID().toUpperCase()): { uid: string; data: string; name: string } {
  const given = oneLine(c.givenName ?? '', 100, 'The first name');
  const family = oneLine(c.familyName ?? '', 100, 'The last name');
  const org = oneLine(c.organization ?? '', 150, 'The company');
  const dept = oneLine(c.department ?? '', 150, 'The department');
  if (!given && !family && !org) throw new UserError('A contact needs at least a first name, a last name or a company.');
  if (dept && !org) throw new UserError('A department needs a company. Please also give the company.');
  const lists = { emails: c.emails ?? [], phones: c.phones ?? [], addresses: c.addresses ?? [], urls: c.urls ?? [] };
  for (const [k, v] of Object.entries(lists)) if (v.length > MAX_PER_KIND) throw new UserError(`Too many ${k} (max. ${MAX_PER_KIND}).`);

  const display = composeFn('', given, '', family, '') || org;
  let item = 0;
  const nextItem = () => `item${++item}`;
  const out: string[] = ['BEGIN:VCARD', 'VERSION:3.0'];
  out.push(`N:${escapeText(family)};${escapeText(given)};;;`);
  out.push(`FN:${escapeText(display)}`);
  const nick = oneLine(c.nickname ?? '', 100, 'The nickname');
  if (nick) out.push(`NICKNAME:${escapeText(nick)}`);
  if (org) out.push(`ORG:${escapeText(org)}${dept ? `;${escapeText(dept)}` : ''}`);
  const job = oneLine(c.jobTitle ?? '', 150, 'The job title');
  if (job) out.push(`TITLE:${escapeText(job)}`);
  lists.emails.forEach((e, i) => out.push(...propertyLines('email', validateEmail(e.value), e.label, i === 0, nextItem)));
  lists.phones.forEach((p, i) => out.push(...propertyLines('tel', validatePhone(p.value), p.label, i === 0, nextItem)));
  lists.addresses.filter(hasAddressData).forEach((a, i) => out.push(...propertyLines('adr', adrValue(a), a.label, i === 0, nextItem)));
  lists.urls.forEach((u, i) => out.push(...propertyLines('url', escapeText(validateUrl(u.value)), u.label, i === 0, nextItem)));
  if (c.birthday?.trim()) out.push(birthdayLine(parseBirthdayInput(c.birthday)));
  const notes = cleanInput(c.notes ?? '', 5000, 'The notes');
  if (notes) out.push(`NOTE:${escapeText(notes)}`);
  if (!given && !family) out.push('X-ABShowAs:COMPANY');
  out.push(`UID:${uid}`);
  out.push(`REV:${now.toISOString().replace(/\.\d+Z$/, 'Z')}`);
  out.push('END:VCARD');
  return { uid, data: out.map((l) => foldLine(l)).join('\r\n') + '\r\n', name: display };
}

/* ------------------------------------------------------------------ */
/* Changing a card                                                     */
/* ------------------------------------------------------------------ */

export interface ContactEdits {
  givenName?: string | undefined;
  familyName?: string | undefined;
  organization?: string | undefined;
  department?: string | undefined;
  jobTitle?: string | undefined;
  nickname?: string | undefined;
  birthday?: string | undefined;
  notes?: string | undefined;
  addEmails?: LabeledInput[] | undefined;
  removeEmails?: string[] | undefined;
  addPhones?: LabeledInput[] | undefined;
  removePhones?: string[] | undefined;
  addAddresses?: AddressInput[] | undefined;
  removeAddresses?: AddressInput[] | undefined;
  addUrls?: LabeledInput[] | undefined;
  removeUrls?: string[] | undefined;
}

export interface EditOutcome {
  data: string;
  /** Remarks for the caller: additions that were already present, etc. */
  notes: string[];
}

const digitsOf = (s: string) => s.replace(/\D/g, '');
const lc = (s: string) => s.trim().toLowerCase();

/** Value of a simple text property, unescaped. */
const textOf = (l: VLine) => unescapeText(l.value);

function setSimple(card: VCardText, name: string, value: string | undefined): void {
  if (value === undefined) return;
  const existing = card.all(name);
  const v = cleanInput(value, name === 'NOTE' ? 5000 : 150, `The ${name.toLowerCase()}`);
  if (!v) {
    for (const l of existing) card.removeBlock(l);
    return;
  }
  const text = `${name}:${escapeText(name === 'NOTE' ? v : v.replace(/\s*\n\s*/g, ' '))}`;
  if (existing[0]) card.replace(existing[0], existing[0].group ? `${existing[0].group}.${text}` : text);
  else card.insertAfter(undefined, [text]);
}

/** Rebuilds a structured line (N, ORG) with one part replaced; keeps group, parameters and all other parts as they were. */
function setPart(card: VCardText, name: 'N' | 'ORG', index: number, value: string, minParts: number): void {
  const line = card.first(name);
  const parts = line ? splitStructured(line.value) : [];
  while (parts.length < Math.max(minParts, index + 1)) parts.push('');
  parts[index] = escapeText(value);
  const prefix = line ? line.text.slice(0, line.text.length - line.value.length) : `${name}:`;
  const text = `${prefix}${parts.join(';')}`;
  if (line) card.replace(line, text);
  else card.insertAfter(undefined, [text]);
}

function applyNames(card: VCardText, e: ContactEdits): void {
  if (e.givenName === undefined && e.familyName === undefined) return;
  if (e.familyName !== undefined) setPart(card, 'N', 0, oneLine(e.familyName, 100, 'The last name'), 5);
  if (e.givenName !== undefined) setPart(card, 'N', 1, oneLine(e.givenName, 100, 'The first name'), 5);
  const n = splitStructured(card.first('N')?.value ?? '').map(unescapeText);
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] = n;
  const org = splitStructured(card.first('ORG')?.value ?? '').map(unescapeText)[0]?.trim() ?? '';
  const display = composeFn(prefix, given, additional, family, suffix) || org;
  const fn = card.first('FN');
  const text = `FN:${escapeText(display)}`;
  if (fn) card.replace(fn, fn.group ? `${fn.group}.${text}` : text);
  else card.insertAfter(card.first('N'), [text]);
  if (!composeFn(prefix, given, additional, family, suffix) && org && !card.first('X-ABShowAs')) card.insertAfter(undefined, ['X-ABShowAs:COMPANY']);
}

function applyOrg(card: VCardText, e: ContactEdits): void {
  if (e.organization === undefined && e.department === undefined) return;
  if (e.organization !== undefined) setPart(card, 'ORG', 0, oneLine(e.organization, 150, 'The company'), 1);
  if (e.department !== undefined) setPart(card, 'ORG', 1, oneLine(e.department, 150, 'The department'), 2);
  const line = card.first('ORG')!;
  const parts = splitStructured(line.value);
  if (parts.every((p) => p === '')) {
    card.removeBlock(line);
  } else if (parts[0] === '' && parts.slice(1).some((p) => p !== '')) {
    throw new UserError('A department needs a company. Please also give (or keep) the company.');
  }
}

function applyBirthday(card: VCardText, e: ContactEdits): void {
  if (e.birthday === undefined) return;
  const existing = card.all('BDAY');
  if (!e.birthday.trim()) {
    for (const l of existing) card.removeBlock(l);
    return;
  }
  const text = birthdayLine(parseBirthdayInput(e.birthday));
  if (existing[0]) card.replace(existing[0], text);
  else card.insertAfter(undefined, [text]);
}

function applyList(
  card: VCardText,
  kind: Kind,
  adds: LabeledInput[] | undefined,
  removes: string[] | undefined,
  nextItem: () => string,
  notes: string[],
): void {
  const name = kind === 'tel' ? 'TEL' : kind === 'url' ? 'URL' : 'EMAIL';
  const valueOf = (l: VLine) => (kind === 'url' ? unescapeText(l.value) : unescapeText(l.value).replace(/^mailto:|^tel:/i, ''));
  const same = (a: string, b: string) => (kind === 'tel' ? lc(a) === lc(b) || (digitsOf(a).length >= 5 && digitsOf(a) === digitsOf(b)) : lc(a) === lc(b));
  const exact = (a: string, b: string) => lc(a) === lc(b);

  for (const raw of removes ?? []) {
    const wanted = raw.trim();
    if (!wanted) continue;
    let hits = card.all(name).filter((l) => exact(valueOf(l), wanted));
    if (!hits.length) hits = card.all(name).filter((l) => same(valueOf(l), wanted));
    if (!hits.length) throw new UserError(`The contact has no ${kind === 'tel' ? 'phone number' : kind === 'url' ? 'web address' : 'email address'} "${wanted.slice(0, 60)}". Nothing was changed.`);
    for (const h of hits) card.removeBlock(h);
  }

  for (const add of adds ?? []) {
    const value = kind === 'email' ? validateEmail(add.value) : kind === 'tel' ? validatePhone(add.value) : validateUrl(add.value);
    if (card.all(name).some((l) => same(valueOf(l), value))) {
      notes.push(`"${value}" is already stored for this contact; not added again.`);
      continue;
    }
    const pref = !card.all(name).some((l) => /;type=pref\b/i.test(l.params));
    const lines = propertyLines(kind, kind === 'url' ? escapeText(value) : value, add.label, pref, nextItem);
    card.insertAfter(card.lastOfBlock(name), lines);
  }
}

const adrParts = (l: VLine) => {
  const [, , street = '', city = '', region = '', postalCode = '', country = ''] = splitStructured(l.value).map(unescapeText);
  return { street, city, region, postalCode, country };
};

function applyAddresses(card: VCardText, e: ContactEdits, nextItem: () => string, notes: string[]): void {
  for (const r of e.removeAddresses ?? []) {
    if (!hasAddressData(r)) throw new UserError('To remove an address, give at least one of street, city, postal_code or country. Nothing was changed.');
    const hits = card.all('ADR').filter((l) => {
      const p = adrParts(l);
      return (['street', 'city', 'region', 'postalCode', 'country'] as const).every((k) => !r[k]?.trim() || lc(p[k]) === lc(r[k]!));
    });
    if (!hits.length) throw new UserError('The contact has no matching address. Nothing was changed.');
    if (hits.length > 1 && !hits.every((h) => h.value === hits[0]!.value)) {
      throw new UserError('Several different addresses match. Please give more fields (street, city, postal code, country). Nothing was changed.');
    }
    for (const h of hits) card.removeBlock(h);
  }
  for (const a of e.addAddresses ?? []) {
    if (!hasAddressData(a)) continue;
    const value = adrValue(a);
    if (card.all('ADR').some((l) => splitStructured(l.value).slice(2).join(';').toLowerCase() === value.split(';').slice(2).join(';').toLowerCase())) {
      notes.push('This address is already stored for this contact; not added again.');
      continue;
    }
    const lines = propertyLines('adr', value, a.label, !card.all('ADR').some((l) => /;type=pref\b/i.test(l.params)), nextItem);
    card.insertAfter(card.lastOfBlock('ADR'), lines);
  }
}

/** Applies the changes to the card text. Everything that is not named stays byte for byte as it was. */
export function applyEdits(original: string, e: ContactEdits): EditOutcome {
  const card = VCardText.parse(original);
  if (!card.first('BEGIN') || !card.first('END')) throw new UserError('The stored card is not a valid vCard. Nothing was changed.');
  const nextItem = card.itemAllocator();
  const notes: string[] = [];

  applyNames(card, e);
  applyOrg(card, e);
  setSimple(card, 'TITLE', e.jobTitle);
  setSimple(card, 'NICKNAME', e.nickname);
  applyBirthday(card, e);
  setSimple(card, 'NOTE', e.notes);
  applyList(card, 'email', e.addEmails, e.removeEmails, nextItem, notes);
  applyList(card, 'tel', e.addPhones, e.removePhones, nextItem, notes);
  applyAddresses(card, e, nextItem, notes);
  applyList(card, 'url', e.addUrls, e.removeUrls, nextItem, notes);

  // A contact must keep a name or a company.
  const n = splitStructured(card.first('N')?.value ?? '').map(unescapeText);
  const org = splitStructured(card.first('ORG')?.value ?? '').map(unescapeText)[0]?.trim() ?? '';
  const fn = unescapeText(card.first('FN')?.value ?? '').trim();
  if (!n.some((p) => p.trim()) && !org && !fn) throw new UserError('A contact needs at least a name or a company. Nothing was changed.');
  return { data: card.toString(), notes };
}
