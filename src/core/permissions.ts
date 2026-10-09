/**
 * Central permission check for all write access.
 *
 * Writing gateway methods require a grant (WriteGrant, DraftGrant, TrashGrant). Grants only exist as the
 * result of the authorize* functions below, so anything that wants to write has to pass through here.
 *
 * Deletion is allowed in only two narrowly limited ways:
 *  - an event of the user's own (authorizeDelete; it is backed up as .ics first),
 *  - MOVING a message to the Trash (authorizeTrash). Messages are never deleted permanently.
 * Nothing is ever sent.
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
  /** If set, the caller wants to change a single occurrence. */
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
  if (r.occurrenceStart) {
    throw new UserError('Changing single occurrences of a recurring series is not supported. Only the whole series can be changed (omit occurrence_start).');
  }
  if (f.hasAttendees) {
    throw new UserError('The event has attendees. Events with attendees are not changed because that can trigger invitations. Please make the change directly in Apple Calendar.');
  }
  if (f.organizer && !r.selfAddresses.some((a) => same(a, f.organizer!))) {
    throw new UserError('The event was organized by another person and is not changed. Please make the change directly in Apple Calendar.');
  }
  if (f.recurring && f.hasExceptions && r.touchesTime) {
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
