/**
 * Zentrale Rechteprüfung für alle Schreibzugriffe.
 *
 * Schreibende Methoden der Gateways verlangen ein Grant (WriteGrant, DraftGrant, TrashGrant). Das gibt es nur als
 * Ergebnis der authorize*-Funktionen unten. Wer schreiben will, muss also hier durch.
 *
 * Gelöscht werden darf nur auf zwei eng begrenzten Wegen:
 *  - einen eigenen Termin (authorizeDelete; vorher wird er als .ics gesichert),
 *  - eine Mail in den Papierkorb VERSCHIEBEN (authorizeTrash). Mails werden nie endgültig gelöscht.
 * Gesendet wird nie.
 */
import type { CalendarInfo } from './calendar/types.js';
import type { MailboxInfo } from './mail/types.js';
import { UserError } from './errors.js';

const issued = new WeakSet<WriteGrant>();

export type WriteOp = 'create' | 'update' | 'delete';

export class WriteGrant {
  private constructor(
    readonly op: WriteOp,
    readonly calendar: CalendarInfo,
  ) {}

  /** Nur intern; wird ausschließlich von authorize* aufgerufen. */
  static issue(op: WriteOp, calendar: CalendarInfo): WriteGrant {
    const g = new WriteGrant(op, calendar);
    issued.add(g);
    return g;
  }

  static isValid(g: unknown, op: WriteOp): g is WriteGrant {
    return g instanceof WriteGrant && issued.has(g) && g.op === op;
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function assertUsable(c: CalendarInfo): void {
  if (c.kind !== 'events') {
    throw new UserError(`"${c.name}" ist eine Erinnerungs-/Aufgabenliste. Dieser Konnektor schreibt nur Termine.`);
  }
  if (c.subscribed) throw new UserError(`"${c.name}" ist ein abonnierter Kalender und schreibgeschützt.`);
  if (!c.writable) throw new UserError(`"${c.name}" ist schreibgeschützt.`);
}

export interface CreateRequest {
  calendars: CalendarInfo[];
  /** Name eines privaten Kalenders. */
  calendar?: string | undefined;
  /** Exakter Name eines geteilten Kalenders (nur so kann in einen geteilten Kalender geschrieben werden). */
  sharedCalendar?: string | undefined;
  defaultCalendar?: string | undefined;
}

export function authorizeCreate(r: CreateRequest): WriteGrant {
  if (r.calendar && r.sharedCalendar) {
    throw new UserError('Bitte nur eines von "calendar" (privater Kalender) und "shared_calendar" (geteilter Kalender) angeben.');
  }
  const events = r.calendars.filter((c) => c.kind === 'events');
  const names = (list: CalendarInfo[]) => list.map((c) => `"${c.name}"`).join(', ') || '(keine)';

  if (r.sharedCalendar) {
    const hit = r.calendars.find((c) => same(c.name, r.sharedCalendar!));
    if (!hit) throw new UserError(`Kalender "${r.sharedCalendar}" nicht gefunden. Geteilte Kalender: ${names(events.filter((c) => c.shared))}.`);
    if (!hit.shared) {
      throw new UserError(`"${hit.name}" ist kein geteilter Kalender. Bitte "calendar" statt "shared_calendar" verwenden.`);
    }
    assertUsable(hit);
    return WriteGrant.issue('create', hit);
  }

  const wanted = r.calendar ?? r.defaultCalendar;
  if (!wanted) {
    throw new UserError(
      `Kein Kalender angegeben und kein Standardkalender eingestellt. Privater Kalender mit "calendar" wählen. Private Kalender: ${names(events.filter((c) => !c.shared))}.`,
    );
  }
  const hit = r.calendars.find((c) => same(c.name, wanted));
  if (!hit) throw new UserError(`Kalender "${wanted}" nicht gefunden. Private Kalender: ${names(events.filter((c) => !c.shared))}.`);
  assertUsable(hit);
  if (hit.shared) {
    const how = r.calendar
      ? `Termine dort erscheinen sofort bei anderen Personen. Wenn das gewollt ist, den Kalender ausdrücklich mit shared_calendar="${hit.name}" nennen.`
      : `Der eingestellte Standardkalender darf nicht geteilt sein. Bitte einen privaten Kalender als Standard einstellen oder "calendar" angeben.`;
    throw new UserError(`"${hit.name}" ist ein geteilter Kalender. ${how}`);
  }
  return WriteGrant.issue('create', hit);
}

/** Eigenschaften des bestehenden Termins, die für die Rechteprüfung relevant sind. */
export interface EventFacts {
  hasMaster: boolean;
  hasAttendees: boolean;
  organizer?: string | undefined;
  recurring: boolean;
  /** EXDATE oder einzeln verschobene Vorkommen (RECURRENCE-ID). */
  hasExceptions: boolean;
}

export interface UpdateRequest {
  calendar: CalendarInfo;
  facts: EventFacts;
  /** Adressen des Nutzers (Apple-ID, iCloud-Adresse). */
  selfAddresses: string[];
  sharedCalendar?: string | undefined;
  /** Wenn gesetzt, will der Aufrufer ein einzelnes Vorkommen ändern. */
  occurrenceStart?: string | undefined;
  /** Ändert die Anfrage Start, Ende oder Ganztägigkeit? */
  touchesTime: boolean;
}

export function authorizeUpdate(r: UpdateRequest): WriteGrant {
  const { calendar: c, facts: f } = r;
  assertUsable(c);

  if (c.shared) {
    if (!r.sharedCalendar || !same(r.sharedCalendar, c.name)) {
      throw new UserError(
        `Der Termin liegt im geteilten Kalender "${c.name}". Änderungen dort erscheinen sofort bei anderen Personen. ` +
          `Zum Ändern den Kalender ausdrücklich mit shared_calendar="${c.name}" nennen.`,
      );
    }
  } else if (r.sharedCalendar) {
    throw new UserError(`"${c.name}" ist kein geteilter Kalender. shared_calendar nur für geteilte Kalender verwenden.`);
  }

  if (!f.hasMaster) {
    throw new UserError('Dieser Eintrag ist nur ein einzelnes Vorkommen einer Serie, dessen Serie hier nicht liegt. Änderung abgelehnt; bitte direkt in Apple Kalender ändern.');
  }
  if (r.occurrenceStart) {
    throw new UserError('Änderungen an einzelnen Vorkommen einer Terminserie werden nicht unterstützt. Es kann nur die ganze Serie geändert werden (occurrence_start weglassen).');
  }
  if (f.hasAttendees) {
    throw new UserError('Der Termin hat Teilnehmer. Termine mit Teilnehmern werden nicht geändert, weil das Einladungen auslösen kann. Bitte die Änderung direkt in Apple Kalender vornehmen.');
  }
  if (f.organizer && !r.selfAddresses.some((a) => same(a, f.organizer!))) {
    throw new UserError('Der Termin wurde von einer anderen Person organisiert und wird nicht geändert. Bitte die Änderung direkt in Apple Kalender vornehmen.');
  }
  if (f.recurring && f.hasExceptions && r.touchesTime) {
    throw new UserError(
      'Diese Serie enthält Ausnahmen (gelöschte oder verschobene Vorkommen). Die Zeit der ganzen Serie wird nicht geändert, damit die Ausnahmen nicht verrutschen. Titel, Ort, Notiz und Erinnerungen können geändert werden.',
    );
  }
  return WriteGrant.issue('update', c);
}

export interface DeleteRequest {
  calendar: CalendarInfo;
  facts: EventFacts;
  /** Adressen des Nutzers (Apple-ID, iCloud-Adresse). */
  selfAddresses: string[];
  /** Wird nie als Erlaubnis gewertet; nur damit die Ablehnung den Grund nennen kann. */
  sharedCalendar?: string | undefined;
  /** Wenn gesetzt, will der Aufrufer ein einzelnes Vorkommen löschen. */
  occurrenceStart?: string | undefined;
}

/**
 * Löschen eines Termins. Strenger als Ändern:
 *  - nie in einem geteilten Kalender (auch nicht mit shared_calendar; das gilt nur fürs Schreiben),
 *  - nie bei Teilnehmern oder fremdem Organisator (iCloud könnte Absagen verschicken),
 *  - nie einzelne Vorkommen einer Serie, nur die ganze Serie.
 */
export function authorizeDelete(r: DeleteRequest): WriteGrant {
  const { calendar: c, facts: f } = r;
  assertUsable(c);

  if (c.shared) {
    throw new UserError(
      `Der Termin liegt im geteilten Kalender "${c.name}". Termine in geteilten Kalendern werden nie gelöscht, auch nicht mit shared_calendar ` +
        '(das gilt nur fürs Schreiben), weil das Löschen sofort bei anderen Personen sichtbar wäre. Bitte direkt in Apple Kalender löschen.',
    );
  }
  if (r.sharedCalendar) {
    throw new UserError('delete_event kennt kein shared_calendar: Termine in geteilten Kalendern werden nie gelöscht. Den Parameter weglassen.');
  }
  if (!f.hasMaster) {
    throw new UserError('Dieser Eintrag ist nur ein einzelnes Vorkommen einer Serie, dessen Serie hier nicht liegt. Löschen abgelehnt; bitte direkt in Apple Kalender löschen.');
  }
  if (r.occurrenceStart) {
    throw new UserError('Einzelne Vorkommen einer Terminserie werden nicht gelöscht. Es kann nur die ganze Serie gelöscht werden (occurrence_start weglassen); einzelne Vorkommen bitte in Apple Kalender löschen.');
  }
  if (f.hasAttendees) {
    throw new UserError('Der Termin hat Teilnehmer. Termine mit Teilnehmern werden nicht gelöscht, weil iCloud dabei Absagen verschicken könnte. Bitte direkt in Apple Kalender löschen.');
  }
  if (f.organizer && !r.selfAddresses.some((a) => same(a, f.organizer!))) {
    throw new UserError('Der Termin wurde von einer anderen Person organisiert und wird nicht gelöscht. Bitte direkt in Apple Kalender löschen.');
  }
  return WriteGrant.issue('delete', c);
}

/* ------------------------------------------------------------------ */
/* Mail: Entwürfe ablegen                                               */
/* ------------------------------------------------------------------ */

const draftIssued = new WeakSet<DraftGrant>();

/** Erlaubnis, genau einen Entwurf im Entwürfe-Ordner abzulegen. Der Zielordner ist nicht frei wählbar. */
export class DraftGrant {
  private constructor(readonly mailbox: string) {}

  static issue(mailbox: string): DraftGrant {
    const g = new DraftGrant(mailbox);
    draftIssued.add(g);
    return g;
  }

  static isValid(g: unknown): g is DraftGrant {
    return g instanceof DraftGrant && draftIssued.has(g);
  }
}

/** Der Entwurf geht immer in den Ordner mit dem Merkmal \Drafts (SPECIAL-USE), nie in einen anderen. */
export function authorizeDraft(mailboxes: MailboxInfo[]): DraftGrant {
  const drafts = mailboxes.filter((m) => m.role === 'drafts');
  if (drafts.length !== 1) {
    throw new UserError(
      drafts.length === 0
        ? 'Es wurde kein Entwürfe-Ordner gefunden. Bitte in Apple Mail prüfen, ob der Ordner "Entwürfe" mit iCloud synchronisiert wird.'
        : 'Es gibt mehrere Entwürfe-Ordner; der Zielordner ist nicht eindeutig. Es wurde nichts geschrieben.',
    );
  }
  return DraftGrant.issue(drafts[0]!.path);
}

/* ------------------------------------------------------------------ */
/* Mail: in den Papierkorb verschieben (nie endgültig löschen)          */
/* ------------------------------------------------------------------ */

/** Höchstens so viele Mails je Aufruf. */
export const MAX_TRASH_PER_CALL = 20;

const trashIssued = new WeakSet<TrashGrant>();

/**
 * Erlaubnis, Mails aus den genannten Ordnern in den Papierkorb zu VERSCHIEBEN. Das Ziel steht fest (Ordner mit dem Merkmal \Trash),
 * andere Ziele gibt es nicht. Die Erlaubnis deckt weder \Deleted noch EXPUNGE ab: beides gibt es im Code nicht.
 */
export class TrashGrant {
  private constructor(
    readonly trash: string,
    readonly sources: ReadonlySet<string>,
    readonly count: number,
  ) {}

  static issue(trash: string, sources: Iterable<string>, count: number): TrashGrant {
    const g = new TrashGrant(trash, new Set(sources), count);
    trashIssued.add(g);
    return g;
  }

  static isValid(g: unknown): g is TrashGrant {
    return g instanceof TrashGrant && trashIssued.has(g);
  }
}

export interface TrashRequest {
  mailboxes: MailboxInfo[];
  /** Ordner der Mails, die verschoben werden sollen (je Mail einer). */
  sourcePaths: string[];
}

/**
 * Der Papierkorb wird über das Merkmal \Trash (SPECIAL-USE) gefunden, nie über den Namen.
 * Mails im Papierkorb selbst werden nicht angefasst: ein endgültiges Löschen gibt es nicht.
 */
export function authorizeTrash(r: TrashRequest): TrashGrant {
  const n = r.sourcePaths.length;
  if (n === 0) throw new UserError('Keine Mail angegeben. Bitte mindestens eine Mail nennen.');
  if (n > MAX_TRASH_PER_CALL) {
    throw new UserError(`Zu viele Mails auf einmal (${n}, höchstens ${MAX_TRASH_PER_CALL} je Aufruf). Es wurde nichts verschoben. Bitte in kleinere Gruppen aufteilen.`);
  }
  const trash = r.mailboxes.filter((m) => m.role === 'trash' && m.roleBy === 'flag');
  if (trash.length !== 1) {
    throw new UserError(
      trash.length === 0
        ? 'Es wurde kein Papierkorb-Ordner mit dem Merkmal \\Trash gefunden. Es wurde nichts verschoben. Bitte in Apple Mail prüfen, ob der Papierkorb mit iCloud synchronisiert wird.'
        : 'Es gibt mehrere Ordner mit dem Merkmal \\Trash; der Papierkorb ist nicht eindeutig. Es wurde nichts verschoben.',
    );
  }
  const target = trash[0]!;
  for (const path of new Set(r.sourcePaths)) {
    if (path === target.path) {
      throw new UserError('Mindestens eine Mail liegt bereits im Papierkorb. Mails werden dort nie angefasst und nie endgültig gelöscht; das bitte in Apple Mail erledigen. Es wurde nichts verschoben.');
    }
    if (!r.mailboxes.some((m) => m.path === path)) {
      throw new UserError('Der Ordner einer Mail ist nicht bekannt. Es wurde nichts verschoben. Bitte die Mail mit list_recent oder search_messages neu suchen.');
    }
  }
  return TrashGrant.issue(target.path, r.sourcePaths, n);
}
