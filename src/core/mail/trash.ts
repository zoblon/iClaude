import { UserError } from '../errors.js';
import { authorizeTrash, MAX_TRASH_PER_CALL } from '../permissions.js';
import { refsOf, senderMatches, verifyItems, type MessageItem } from './verify.js';
import type { Address, MailboxInfo, MailTrasher, MessageRef } from './types.js';

export type TrashItem = MessageItem;

export interface TrashResult {
  trashMailbox: string;
  count: number;
  moved: Array<{ id: string; mailbox: string; subject: string; from: Address[]; date: string }>;
  note: string;
}

export { senderMatches };

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

    const refs: MessageRef[] = refsOf(items);

    // Permissions first: the target (Trash with the \Trash attribute) and the folders are fixed before anything is loaded.
    const grant = authorizeTrash({ mailboxes: await this.mailboxes(), sourcePaths: refs.map((r) => r.path) });

    const summaries = await verifyItems(this.store, items, refs, 'Nothing was moved.');

    const done = await this.store.moveToTrash(grant, refs);
    return {
      trashMailbox: done.trash,
      count: done.moved,
      moved: summaries.map((s) => ({ id: s.id, mailbox: s.mailbox, subject: s.subject, from: s.from, date: s.date })),
      note: `The messages are now in the Trash and can be restored from there for ${WHEN} (in Apple Mail, move them out of the Trash). After that, iCloud deletes them permanently. This connector never deletes permanently.`,
    };
  }
}
