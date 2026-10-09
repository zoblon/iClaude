import { UserError } from '../errors.js';
import { authorizeMove, MAX_MOVE_PER_CALL } from '../permissions.js';
import type { Address, MailboxInfo, MailMover, MessageSummary } from './types.js';
import { refsOf, verifyItems, type MessageItem } from './verify.js';

export interface MoveResult {
  /** Path of the target folder. */
  targetMailbox: string;
  count: number;
  moved: Array<{
    /** ID before the move (no longer valid). */
    oldId: string;
    /** ID in the target folder, if it could be determined. */
    newId?: string;
    subject: string;
    from: Address[];
    fromMailbox: string;
    toMailbox: string;
  }>;
  note: string;
}

/**
 * Moves messages into another folder of the user's own. The Trash (trash_message), Drafts, Sent and Junk are never a target.
 * Before moving, every message is checked to match the given subject and sender. If any does not match, nothing is moved.
 */
export class MoveService {
  constructor(
    private readonly store: MailMover,
    private readonly mailboxes: () => Promise<MailboxInfo[]>,
    /** Folder by path, name or role ("archive", …). */
    private readonly resolveMailbox: (ref: string) => Promise<MailboxInfo>,
    /** Finds messages in a folder by Message-ID (used to look up the new ID when the server does not report it). */
    private readonly findByMessageId?: (path: string, messageId: string) => Promise<MessageSummary[]>,
  ) {}

  async move(items: MessageItem[], target: string): Promise<MoveResult> {
    if (items.length === 0) throw new UserError('No message specified. Please name at least one message.');
    if (items.length > MAX_MOVE_PER_CALL) {
      throw new UserError(`Too many messages at once (${items.length}, at most ${MAX_MOVE_PER_CALL} per call). Nothing was moved. Please split them into smaller groups.`);
    }
    const refs = refsOf(items);

    // Permissions first: the target and the folders are fixed before anything is loaded.
    const dest = await this.resolveMailbox(target);
    const grant = authorizeMove({ mailboxes: await this.mailboxes(), sourcePaths: refs.map((r) => r.path), targetPath: dest.path });

    const summaries = await verifyItems(this.store, items, refs, 'Nothing was moved.');
    const done = await this.store.moveMessages(grant, refs);

    const newIds = [...done.newIds];
    if (this.findByMessageId) {
      for (let i = 0; i < summaries.length; i++) {
        const mid = summaries[i]!.messageId;
        if (newIds[i] || !mid) continue;
        try {
          const hits = (await this.findByMessageId(done.target, mid)).filter((m) => m.messageId === mid);
          if (hits.length === 1) newIds[i] = hits[0]!.id;
        } catch {
          /* the move has happened; the new ID is only a convenience */
        }
      }
    }
    return {
      targetMailbox: done.target,
      count: done.moved,
      moved: summaries.map((s, i) => ({
        oldId: s.id,
        ...(newIds[i] ? { newId: newIds[i] } : {}),
        subject: s.subject,
        from: s.from,
        fromMailbox: s.mailbox,
        toMailbox: done.target,
      })),
      note: 'To undo, call move_message again with the newId (or find the mail in the target folder) and the original folder (fromMailbox) as the target.',
    };
  }
}
