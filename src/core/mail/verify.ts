import { UserError } from '../errors.js';
import { normText, sameText } from '../untrusted.js';
import { decodeRef } from './ref.js';
import type { Address, MailChecker, MessageRef, MessageSummary } from './types.js';

/** A message as the user sees it: ID plus the subject and sender shown for it. All three are checked before anything is changed. */
export interface MessageItem {
  /** ID from list_recent, search_messages, get_message or get_thread. */
  id: string;
  /** Subject of the message as shown there. Must match the message. */
  subject: string;
  /** Sender of the message (address, "Name <address>" or name). Must match the message. */
  from: string;
}

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
  const n = normText(e);
  return n !== '' && from.some((a) => a.name !== undefined && normText(a.name) === n);
}

/** Decodes the IDs and refuses duplicates. */
export function refsOf(items: MessageItem[]): MessageRef[] {
  const refs = items.map((i) => decodeRef(i.id));
  const keys = refs.map((r) => `${r.path}\u0000${r.uidValidity}\u0000${r.uid}`);
  if (new Set(keys).size !== keys.length) throw new UserError('The same message was specified more than once. Nothing was changed.');
  return refs;
}

/**
 * Loads the messages (headers and flags only, read-only) and checks that every one matches the given subject and sender.
 * If even one does not match, an error is thrown and the caller changes nothing.
 */
export async function verifyItems(store: MailChecker, items: MessageItem[], refs: MessageRef[], nothing: string): Promise<MessageSummary[]> {
  const found = await store.summaries(refs);
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
    throw new UserError(`${problems.join('; ')}. ${nothing} Fetch the messages again with list_recent or search_messages and copy ID, subject and sender unchanged.`);
  }
  return found as MessageSummary[];
}
