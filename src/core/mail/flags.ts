import { UserError } from '../errors.js';
import { authorizeFlags, MAX_FLAG_PER_CALL } from '../permissions.js';
import type { Address, MailboxInfo, MailFlagger } from './types.js';
import { refsOf, verifyItems, type MessageItem } from './verify.js';

export interface FlagChange {
  /** true = mark as read, false = mark as unread. */
  read?: boolean | undefined;
  /** true = flag, false = remove the flag. */
  flagged?: boolean | undefined;
}

export interface FlagResult {
  count: number;
  change: FlagChange;
  messages: Array<{ id: string; mailbox: string; subject: string; from: Address[]; before: { read: boolean; flagged: boolean } }>;
  note: string;
}

/**
 * Marks messages read/unread and flagged/unflagged (only \Seen and \Flagged). Nothing else about a message changes.
 * Before changing, every message is checked to match the given subject and sender. If any does not match, nothing is changed.
 */
export class FlagService {
  constructor(
    private readonly store: MailFlagger,
    private readonly mailboxes: () => Promise<MailboxInfo[]>,
  ) {}

  async set(items: MessageItem[], change: FlagChange): Promise<FlagResult> {
    if (items.length === 0) throw new UserError('No message specified. Please name at least one message.');
    if (items.length > MAX_FLAG_PER_CALL) {
      throw new UserError(`Too many messages at once (${items.length}, at most ${MAX_FLAG_PER_CALL} per call). Nothing was changed. Please split them into smaller groups.`);
    }
    const refs = refsOf(items);
    const grant = authorizeFlags({ mailboxes: await this.mailboxes(), sourcePaths: refs.map((r) => r.path), seen: change.read, flagged: change.flagged });
    const summaries = await verifyItems(this.store, items, refs, 'Nothing was changed.');
    const done = await this.store.setFlags(grant, refs);
    return {
      count: done.changed,
      change,
      messages: summaries.map((s) => ({ id: s.id, mailbox: s.mailbox, subject: s.subject, from: s.from, before: { read: !s.unread, flagged: s.flagged } })),
      note: 'Only the read and flagged marks were changed. To undo, call set_message_flags again with the previous values (data.messages[].before).',
    };
  }
}
