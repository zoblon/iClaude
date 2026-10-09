import { UserError } from '../errors.js';
import { authorizeTrash, MAX_TRASH_PER_CALL } from '../permissions.js';
import { normText, sameText } from '../untrusted.js';
import { decodeRef } from './ref.js';
import type { Address, MailboxInfo, MailTrasher, MessageRef, MessageSummary } from './types.js';

export interface TrashItem {
  /** ID from list_recent, search_messages, get_message or get_thread. */
  id: string;
  /** Subject of the message as shown there. Must match the message. */
  subject: string;
  /** Sender of the message (address, "Name <address>" or name). Must match the message. */
  from: string;
}

export interface TrashResult {
  trashMailbox: string;
  count: number;
  moved: Array<{ id: string; mailbox: string; subject: string; from: Address[]; date: string }>;
  note: string;
}

const norm = normText;

/**
 * If the input contains an email address, exactly that address must be among the senders.
 * Otherwise it must equal the display name of a sender.
 */
export function senderMatches(expected: string, from: Address[]): boolean {
  const e = expected.trim();
  const m = /<([^<>\s]+@[^<>\s]+)>|([^\s<>",;]+@[^\s<>",;]+)/.exec(e);
  if (m) {
    const addr = (m[1] ?? m[2])!.toLowerCase();
    return from.some((a) => a.address?.toLowerCase() === addr);
  }
  const n = norm(e);
  return n !== '' && from.some((a) => a.name !== undefined && norm(a.name) === n);
}

const WHEN = 'about 30 days';

/**
 * Moves messages to the Trash. Never deletes permanently: the messages stay in the Trash and can be restored from there.
 * Before moving, every message is checked to match the given subject and sender. If any does not match, nothing is moved.
 */
export class TrashService {
  constructor(
    private readonly store: MailTrasher,
    private readonly mailboxes: () => Promise<MailboxInfo[]>,
  ) {}

  async trash(items: TrashItem[]): Promise<TrashResult> {
    if (items.length === 0) throw new UserError('No message specified. Please name at least one message.');
    if (items.length > MAX_TRASH_PER_CALL) {
      throw new UserError(`Too many messages at once (${items.length}, at most ${MAX_TRASH_PER_CALL} per call). Nothing was moved. Please split them into smaller groups.`);
    }

    const refs: MessageRef[] = items.map((i) => decodeRef(i.id));
    const keys = refs.map((r) => `${r.path}\u0000${r.uidValidity}\u0000${r.uid}`);
    if (new Set(keys).size !== keys.length) throw new UserError('The same message was specified more than once. Nothing was moved.');

    // Permissions first: the target (Trash with the \Trash attribute) and the folders are fixed before anything is loaded.
    const grant = authorizeTrash({ mailboxes: await this.mailboxes(), sourcePaths: refs.map((r) => r.path) });

    const found = await this.store.summaries(refs);
    const problems: string[] = [];
    found.forEach((s, i) => {
      const n = i + 1;
      const item = items[i]!;
      if (!s) {
        problems.push(`Message ${n}: not found (moved or deleted?)`);
        return;
      }
      if (!sameText(item.subject, s.subject)) problems.push(`Message ${n}: the subject does not match the message with this ID`);
      if (!senderMatches(item.from, s.from)) problems.push(`Message ${n}: the sender does not match the message with this ID`);
    });
    if (problems.length) {
      throw new UserError(
        `${problems.join('; ')}. Nothing was moved. Fetch the messages again with list_recent or search_messages and copy ID, subject and sender unchanged.`,
      );
    }

    const done = await this.store.moveToTrash(grant, refs);
    const summaries = found as MessageSummary[];
    return {
      trashMailbox: done.trash,
      count: done.moved,
      moved: summaries.map((s) => ({ id: s.id, mailbox: s.mailbox, subject: s.subject, from: s.from, date: s.date })),
      note: `The messages are now in the Trash and can be restored from there for ${WHEN} (in Apple Mail, move them out of the Trash). After that, iCloud deletes them permanently. This connector never deletes permanently.`,
    };
  }
}
