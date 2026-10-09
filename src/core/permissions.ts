/**
 * Central permission check for all write access.
 *
 * Writing gateway methods require a grant (WriteGrant, DraftGrant, TrashGrant). Grants only exist as the
 * result of the authorize* functions below, so anything that wants to write has to pass through here.
 *
 * Deleting is allowed in only three narrowly limited ways:
 *  - an event of the user's own (authorizeDelete; it is backed up as .ics first),
 *  - the SOURCE of an event that has been moved to another calendar (authorizeEventMove; backed up as .ics first, and only after the
 *    copy in the target calendar has been created and read back),
 *  - MOVING a message to the Trash (authorizeTrash). Messages are never deleted permanently.
 * Mail can also be moved to other folders (authorizeMove; never to the Trash, Drafts, Sent or Junk) and marked
 * read/unread and flagged/unflagged (authorizeFlags; only \\Seen and \\Flagged). Nothing is ever sent.
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

  /** Internal only; called exclusively by authorize*. */
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
    throw new UserError(`"${c.name}" is a reminders/tasks list. This connector only writes events.`);
  }
  if (c.subscribed) throw new UserError(`"${c.name}" is a subscribed calendar and read-only.`);
  if (!c.writable) throw new UserError(`"${c.name}" is read-only.`);
}

export interface CreateRequest {
  calendars: CalendarInfo[];
  /** Name of a private calendar. */
  calendar?: string | undefined;
  /** Exact name of a shared calendar (the only way to write to a shared calendar). */
  sharedCalendar?: string | undefined;
  defaultCalendar?: string | undefined;
}

export function authorizeCreate(r: CreateRequest): WriteGrant {
  if (r.calendar && r.sharedCalendar) {
    throw new UserError('Please specify only one of "calendar" (private calendar) and "shared_calendar" (shared calendar).');
  }
  const events = r.calendars.filter((c) => c.kind === 'events');
  const names = (list: CalendarInfo[]) => list.map((c) => `"${c.name}"`).join(', ') || '(none)';

  if (r.sharedCalendar) {
    const hit = r.calendars.find((c) => same(c.name, r.sharedCalendar!));
    if (!hit) throw new UserError(`Calendar "${r.sharedCalendar}" not found. Shared calendars: ${names(events.filter((c) => c.shared))}.`);
    if (!hit.shared) {
      throw new UserError(`"${hit.name}" is not a shared calendar. Please use "calendar" instead of "shared_calendar".`);
    }
    assertUsable(hit);
    return WriteGrant.issue('create', hit);
  }

  const wanted = r.calendar ?? r.defaultCalendar;
  if (!wanted) {
    throw new UserError(
      `No calendar specified and no default calendar configured. Choose a private calendar with "calendar". Private calendars: ${names(events.filter((c) => !c.shared))}.`,
    );
  }
  const hit = r.calendars.find((c) => same(c.name, wanted));
  if (!hit) throw new UserError(`Calendar "${wanted}" not found. Private calendars: ${names(events.filter((c) => !c.shared))}.`);
  assertUsable(hit);
  if (hit.shared) {
    const how = r.calendar
      ? `Events there appear immediately for other people. If that is intended, name the calendar explicitly with shared_calendar="${hit.name}".`
      : `The configured default calendar must not be shared. Please set a private calendar as the default or specify "calendar".`;
    throw new UserError(`"${hit.name}" is a shared calendar. ${how}`);
  }
  return WriteGrant.issue('create', hit);
}

/** Properties of the existing event that matter for the permission check. */
export interface EventFacts {
  hasMaster: boolean;
  hasAttendees: boolean;
  organizer?: string | undefined;
  recurring: boolean;
  /** EXDATE or individually moved occurrences (RECURRENCE-ID). */
  hasExceptions: boolean;
}

export interface UpdateRequest {
  calendar: CalendarInfo;
  facts: EventFacts;
  /** The user's addresses (Apple ID, iCloud address). */
  selfAddresses: string[];
  sharedCalendar?: string | undefined;
  /** If set, the caller wants to change a single occurrence of a series (an override with RECURRENCE-ID is written). */
  occurrenceStart?: string | undefined;
  /** Does the request change start, end or all-day status? */
  touchesTime: boolean;
}

export function authorizeUpdate(r: UpdateRequest): WriteGrant {
  const { calendar: c, facts: f } = r;
  assertUsable(c);

  if (c.shared) {
    if (!r.sharedCalendar || !same(r.sharedCalendar, c.name)) {
      throw new UserError(
        `The event is in the shared calendar "${c.name}". Changes there appear immediately for other people. ` +
          `To change it, name the calendar explicitly with shared_calendar="${c.name}".`,
      );
    }
  } else if (r.sharedCalendar) {
    throw new UserError(`"${c.name}" is not a shared calendar. Use shared_calendar only for shared calendars.`);
  }

  if (!f.hasMaster) {
    throw new UserError('This entry is only a single occurrence of a recurring series whose series is not stored here. Change refused; please change it directly in Apple Calendar.');
  }
  if (r.occurrenceStart && !f.recurring) {
    throw new UserError('This event is not part of a recurring series, so there is no single occurrence to change. Omit occurrence_start to change the event.');
  }
  if (f.hasAttendees) {
    throw new UserError('The event has attendees. Events with attendees are not changed because that can trigger invitations. Please make the change directly in Apple Calendar.');
  }
  if (f.organizer && !r.selfAddresses.some((a) => same(a, f.organizer!))) {
    throw new UserError('The event was organized by another person and is not changed. Please make the change directly in Apple Calendar.');
  }
  if (!r.occurrenceStart && f.recurring && f.hasExceptions && r.touchesTime) {
    throw new UserError(
      'This series contains exceptions (deleted or moved occurrences). The time of the whole series is not changed so the exceptions do not shift. Title, location, notes and alerts can be changed.',
    );
  }
  return WriteGrant.issue('update', c);
}

export interface DeleteRequest {
  calendar: CalendarInfo;
  facts: EventFacts;
  /** The user's addresses (Apple ID, iCloud address). */
  selfAddresses: string[];
  /** Never treated as permission; only so the refusal can state the reason. */
  sharedCalendar?: string | undefined;
  /** If set, the caller wants to delete a single occurrence. */
  occurrenceStart?: string | undefined;
}

/**
 * Deleting an event. Stricter than changing:
 *  - never in a shared calendar (not even with shared_calendar; that only applies to writing),
 *  - never with attendees or another organizer (iCloud could send cancellations),
 *  - never single occurrences of a series, only the whole series.
 */
export function authorizeDelete(r: DeleteRequest): WriteGrant {
  const { calendar: c, facts: f } = r;
  assertUsable(c);

  if (c.shared) {
    throw new UserError(
      `The event is in the shared calendar "${c.name}". Events in shared calendars are never deleted, not even with shared_calendar ` +
        '(that only applies to writing), because the deletion would be visible to other people immediately. Please delete it directly in Apple Calendar.',
    );
  }
  if (r.sharedCalendar) {
    throw new UserError('delete_event has no shared_calendar: events in shared calendars are never deleted. Omit the parameter.');
  }
  if (!f.hasMaster) {
    throw new UserError('This entry is only a single occurrence of a recurring series whose series is not stored here. Deletion refused; please delete it directly in Apple Calendar.');
  }
  if (r.occurrenceStart) {
    throw new UserError('Single occurrences of a recurring series are not deleted. Only the whole series can be deleted (omit occurrence_start); please delete single occurrences in Apple Calendar.');
  }
  if (f.hasAttendees) {
    throw new UserError('The event has attendees. Events with attendees are not deleted because iCloud could send cancellations. Please delete it directly in Apple Calendar.');
  }
  if (f.organizer && !r.selfAddresses.some((a) => same(a, f.organizer!))) {
    throw new UserError('The event was organized by another person and is not deleted. Please delete it directly in Apple Calendar.');
  }
  return WriteGrant.issue('delete', c);
}

export interface EventMoveRequest {
  calendars: CalendarInfo[];
  /** Calendar the event is in. */
  source: CalendarInfo;
  facts: EventFacts;
  /** The user's addresses (Apple ID, iCloud address). */
  selfAddresses: string[];
  /** Name of the target calendar. */
  target: string;
  /** Exact name of a shared target calendar (the only way to move into a shared calendar). */
  sharedCalendar?: string | undefined;
  /** If set, the caller wants to move a single occurrence. */
  occurrenceStart?: string | undefined;
}

/** The two grants of a move: create in the target calendar, delete the source after the copy was verified. */
export interface EventMoveGrants {
  create: WriteGrant;
  delete: WriteGrant;
  target: CalendarInfo;
}

/**
 * Moving an event to another calendar (create in the target, read back, then delete the source). Stricter than changing:
 *  - never out of a shared calendar (the deletion would be visible to other people immediately),
 *  - never with attendees or another organizer, never a single occurrence of a series,
 *  - into a shared calendar only when its exact name is given as shared_calendar.
 * This is the third (and last) way an event is deleted, see the guard test.
 */
export function authorizeEventMove(r: EventMoveRequest): EventMoveGrants {
  const { source: c, facts: f } = r;
  assertUsable(c);
  if (c.shared) {
    throw new UserError(`The event is in the shared calendar "${c.name}". Events are never moved out of shared calendars because the removal would be visible to other people immediately. Please move it directly in Apple Calendar.`);
  }
  if (r.occurrenceStart) throw new UserError('Single occurrences of a series cannot be moved to another calendar. Only the whole series can be moved (omit occurrence_start).');
  if (!f.hasMaster) throw new UserError('This entry is only a single occurrence of a recurring series whose series is not stored here. Move refused; please move it directly in Apple Calendar.');
  if (f.hasAttendees) throw new UserError('The event has attendees. Events with attendees are not moved because that can trigger invitations or cancellations. Please move it directly in Apple Calendar.');
  if (f.organizer && !r.selfAddresses.some((a) => same(a, f.organizer!))) {
    throw new UserError('The event was organized by another person and is not moved. Please move it directly in Apple Calendar.');
  }

  const events = r.calendars.filter((x) => x.kind === 'events');
  const names = (list: CalendarInfo[]) => list.map((x) => `"${x.name}"`).join(', ') || '(none)';
  const hits = r.calendars.filter((x) => same(x.name, r.target));
  if (hits.length === 0) throw new UserError(`Calendar "${r.target}" not found. Private calendars: ${names(events.filter((x) => !x.shared))}.`);
  if (hits.length > 1) throw new UserError(`The name "${r.target}" is ambiguous. Nothing was moved.`);
  const target = hits[0]!;
  assertUsable(target);
  if (target.id === c.id) throw new UserError('The event is already in this calendar. Nothing was moved.');
  if (target.shared) {
    if (!r.sharedCalendar || !same(r.sharedCalendar, target.name)) {
      throw new UserError(`"${target.name}" is a shared calendar. Events there appear immediately for other people. If that is intended, name the calendar explicitly with shared_calendar="${target.name}".`);
    }
  } else if (r.sharedCalendar) {
    throw new UserError(`"${target.name}" is not a shared calendar. Use shared_calendar only for shared calendars.`);
  }
  return { create: WriteGrant.issue('create', target), delete: WriteGrant.issue('delete', c), target };
}

/* ------------------------------------------------------------------ */
/* Mail: saving drafts                                                 */
/* ------------------------------------------------------------------ */

const draftIssued = new WeakSet<DraftGrant>();

/** Permission to save exactly one draft in the Drafts folder. The target folder cannot be chosen freely. */
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

/** The draft always goes to the folder with the \Drafts attribute (SPECIAL-USE), never to any other. */
export function authorizeDraft(mailboxes: MailboxInfo[]): DraftGrant {
  const drafts = mailboxes.filter((m) => m.role === 'drafts');
  if (drafts.length !== 1) {
    throw new UserError(
      drafts.length === 0
        ? 'No Drafts folder was found. Please check in Apple Mail that the Drafts folder is synced with iCloud.'
        : 'There are several Drafts folders; the target folder is ambiguous. Nothing was written.',
    );
  }
  return DraftGrant.issue(drafts[0]!.path);
}

/* ------------------------------------------------------------------ */
/* Mail: move to Trash (never delete permanently)                      */
/* ------------------------------------------------------------------ */

/** Maximum number of messages per call. */
export const MAX_TRASH_PER_CALL = 20;

const trashIssued = new WeakSet<TrashGrant>();

/**
 * Permission to MOVE messages from the given folders to the Trash. The target is fixed (folder with the \Trash attribute);
 * there are no other targets. The permission covers neither \Deleted nor EXPUNGE: neither exists in the code.
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
  /** Folders of the messages to be moved (one per message). */
  sourcePaths: string[];
}

/**
 * The Trash is found via the \Trash attribute (SPECIAL-USE), never by name.
 * Messages already in the Trash are not touched: there is no permanent deletion.
 */
export function authorizeTrash(r: TrashRequest): TrashGrant {
  const n = r.sourcePaths.length;
  if (n === 0) throw new UserError('No message specified. Please name at least one message.');
  if (n > MAX_TRASH_PER_CALL) {
    throw new UserError(`Too many messages at once (${n}, at most ${MAX_TRASH_PER_CALL} per call). Nothing was moved. Please split them into smaller groups.`);
  }
  const trash = r.mailboxes.filter((m) => m.role === 'trash' && m.roleBy === 'flag');
  if (trash.length !== 1) {
    throw new UserError(
      trash.length === 0
        ? 'No Trash folder with the \\Trash attribute was found. Nothing was moved. Please check in Apple Mail that the Trash is synced with iCloud.'
        : 'There are several folders with the \\Trash attribute; the Trash is ambiguous. Nothing was moved.',
    );
  }
  const target = trash[0]!;
  for (const path of new Set(r.sourcePaths)) {
    if (path === target.path) {
      throw new UserError('At least one message is already in the Trash. Messages there are never touched and never deleted permanently; please do that in Apple Mail. Nothing was moved.');
    }
    if (!r.mailboxes.some((m) => m.path === path)) {
      throw new UserError('The folder of a message is unknown. Nothing was moved. Please find the message again with list_recent or search_messages.');
    }
  }
  return TrashGrant.issue(target.path, r.sourcePaths, n);
}

/* ------------------------------------------------------------------ */
/* Contacts: creating and changing a single contact card               */
/* ------------------------------------------------------------------ */

export type ContactWriteOp = 'create' | 'update';

const contactIssued = new WeakSet<ContactWriteGrant>();

/**
 * Permission to create one contact card or to change one existing contact card.
 * There is no grant for deleting contacts or for touching groups: neither exists in the code.
 */
export class ContactWriteGrant {
  private constructor(
    readonly op: ContactWriteOp,
    /** Path of the .vcf resource (for 'create': the file name that will be created). */
    readonly target: string,
  ) {}

  static issue(op: ContactWriteOp, target: string): ContactWriteGrant {
    const g = new ContactWriteGrant(op, target);
    contactIssued.add(g);
    return g;
  }

  static isValid(g: unknown, op: ContactWriteOp): g is ContactWriteGrant {
    return g instanceof ContactWriteGrant && contactIssued.has(g) && g.op === op;
  }
}

/** Contact cards only; group cards (address book server kind "group") are never written. */
export function authorizeContactWrite(r: { op: ContactWriteOp; target: string; vcard: string }): ContactWriteGrant {
  if (/^\s*(?:[\w-]+\.)?(?:X-ADDRESSBOOKSERVER-KIND|KIND)\s*[;:][^\r\n]*group/im.test(r.vcard.replace(/\r?\n[ \t]/g, ''))) {
    throw new UserError('This entry is a contact group. Groups are never changed by this connector. Please change the group in Apple Contacts.');
  }
  if (r.op === 'create' && !/^[A-Za-z0-9-]{8,64}\.vcf$/.test(r.target)) throw new UserError('Internal error: invalid file name.');
  if (r.op === 'update' && (!/^\/[^?#\s]*\.vcf$/i.test(r.target) || r.target.includes('..'))) throw new UserError('Invalid contact ID. Use the id from search_contacts unchanged.');
  return ContactWriteGrant.issue(r.op, r.target);
}

/* ------------------------------------------------------------------ */
/* Mail: moving to another folder                                      */
/* ------------------------------------------------------------------ */

/** Maximum number of messages per call. */
export const MAX_MOVE_PER_CALL = 50;
export const MAX_FLAG_PER_CALL = 50;

const moveIssued = new WeakSet<MoveGrant>();

/** Permission to MOVE messages from the given folders into exactly one target folder. */
export class MoveGrant {
  private constructor(
    readonly target: string,
    readonly sources: ReadonlySet<string>,
    readonly count: number,
  ) {}

  static issue(target: string, sources: Iterable<string>, count: number): MoveGrant {
    const g = new MoveGrant(target, new Set(sources), count);
    moveIssued.add(g);
    return g;
  }

  static isValid(g: unknown): g is MoveGrant {
    return g instanceof MoveGrant && moveIssued.has(g);
  }
}

export interface MoveRequest {
  mailboxes: MailboxInfo[];
  /** Folders of the messages to be moved (one per message). */
  sourcePaths: string[];
  /** Path of the target folder (already resolved from a name or role by the caller). */
  targetPath: string;
}

/** Folder names that are never a target, whatever their attributes say (the Trash has its own tool). */
const FORBIDDEN_TARGET_NAMES = /^(deleted messages|deleted items|trash|bin|papierkorb|drafts?|entw(ü|ue)rfe|sent|sent messages|sent items|gesendet|gesendete objekte|junk|junk e-?mail|spam)$/i;
const FORBIDDEN_TARGET_ROLES = new Set(['trash', 'drafts', 'sent', 'junk']);

/**
 * Moving to a folder of the user's own. Not allowed as a target: the Trash (trash_message exists for that), Drafts, Sent and Junk,
 * recognised by attribute, by role and by name. The target must not be the folder the messages are already in.
 */
export function authorizeMove(r: MoveRequest): MoveGrant {
  const n = r.sourcePaths.length;
  if (n === 0) throw new UserError('No message specified. Please name at least one message.');
  if (n > MAX_MOVE_PER_CALL) {
    throw new UserError(`Too many messages at once (${n}, at most ${MAX_MOVE_PER_CALL} per call). Nothing was moved. Please split them into smaller groups.`);
  }
  const target = r.mailboxes.find((m) => m.path === r.targetPath);
  if (!target) throw new UserError('The target folder is unknown. Nothing was moved. Use list_mailboxes to check the available folders.');
  if (target.role === 'trash') {
    throw new UserError('The Trash is not a target for move_message. Use trash_message to move mails to the Trash. Nothing was moved.');
  }
  if ((target.role && FORBIDDEN_TARGET_ROLES.has(target.role)) || FORBIDDEN_TARGET_NAMES.test(target.name.trim()) || FORBIDDEN_TARGET_NAMES.test(target.path.trim())) {
    throw new UserError(`"${target.name}" (Drafts, Sent, Junk and Trash) is not a target for move_message. Nothing was moved.`);
  }
  for (const path of new Set(r.sourcePaths)) {
    if (path === target.path) throw new UserError('At least one message is already in the target folder. Nothing was moved.');
    if (!r.mailboxes.some((m) => m.path === path)) {
      throw new UserError('The folder of a message is unknown. Nothing was moved. Please find the message again with list_recent or search_messages.');
    }
  }
  return MoveGrant.issue(target.path, r.sourcePaths, n);
}

/* ------------------------------------------------------------------ */
/* Mail: marking read/unread and flagged/unflagged                     */
/* ------------------------------------------------------------------ */

/** The only flags this connector ever sets or clears with STORE. \\Deleted, \\Draft, \\Answered and keywords are not among them. */
export const ALLOWED_STORE_FLAGS = ['\\Seen', '\\Flagged'] as const;
export type StoreFlag = (typeof ALLOWED_STORE_FLAGS)[number];

const flagIssued = new WeakSet<FlagGrant>();

/** Permission to set/clear \\Seen and \\Flagged on messages in the given folders. */
export class FlagGrant {
  private constructor(
    readonly sources: ReadonlySet<string>,
    readonly count: number,
    readonly add: readonly StoreFlag[],
    readonly remove: readonly StoreFlag[],
  ) {}

  static issue(sources: Iterable<string>, count: number, add: readonly StoreFlag[], remove: readonly StoreFlag[]): FlagGrant {
    for (const f of [...add, ...remove]) if (!(ALLOWED_STORE_FLAGS as readonly string[]).includes(f)) throw new Error('Flag not allowed');
    const g = new FlagGrant(new Set(sources), count, [...add], [...remove]);
    flagIssued.add(g);
    return g;
  }

  static isValid(g: unknown): g is FlagGrant {
    return g instanceof FlagGrant && flagIssued.has(g);
  }
}

export interface FlagRequest {
  mailboxes: MailboxInfo[];
  sourcePaths: string[];
  /** true = mark as read, false = mark as unread, undefined = leave as is. */
  seen?: boolean | undefined;
  /** true = flag, false = remove the flag, undefined = leave as is. */
  flagged?: boolean | undefined;
}

export function authorizeFlags(r: FlagRequest): FlagGrant {
  const n = r.sourcePaths.length;
  if (n === 0) throw new UserError('No message specified. Please name at least one message.');
  if (n > MAX_FLAG_PER_CALL) {
    throw new UserError(`Too many messages at once (${n}, at most ${MAX_FLAG_PER_CALL} per call). Nothing was changed. Please split them into smaller groups.`);
  }
  if (r.seen === undefined && r.flagged === undefined) throw new UserError('Nothing to change. Please set read and/or flagged.');
  for (const path of new Set(r.sourcePaths)) {
    if (!r.mailboxes.some((m) => m.path === path)) {
      throw new UserError('The folder of a message is unknown. Nothing was changed. Please find the message again with list_recent or search_messages.');
    }
  }
  const add: StoreFlag[] = [];
  const remove: StoreFlag[] = [];
  if (r.seen !== undefined) (r.seen ? add : remove).push('\\Seen');
  if (r.flagged !== undefined) (r.flagged ? add : remove).push('\\Flagged');
  return FlagGrant.issue(r.sourcePaths, n, add, remove);
}
