import type { DraftGrant, FlagGrant, MoveGrant, TrashGrant } from '../permissions.js';

export interface Address {
  name?: string;
  address?: string;
}

export interface MailboxInfo {
  /** Full path on the server, e.g. "INBOX" or "Sent Messages". */
  path: string;
  name: string;
  /** inbox, sent, drafts, archive, junk, trash or empty. */
  role?: string;
  /** Where the role comes from: attribute in the server's LIST response (\\Trash, \\Drafts, …) or just the folder name. The Trash only counts with the attribute. */
  roleBy?: 'flag' | 'name';
  messages?: number;
  unseen?: number;
}

export interface MessageRef {
  path: string;
  uidValidity: string;
  uid: number;
}

export interface MessageSummary {
  /** Reference to the message (for get_message / get_thread). */
  id: string;
  mailbox: string;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  /** ISO time; empty if unknown. */
  date: string;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  /** Draft (flag \\Draft). */
  draft?: true;
  hasAttachments: boolean;
  size?: number;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SearchCriteria {
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  /** Full text (headers and body). */
  text?: string | undefined;
  /** From (inclusive). */
  since?: Date | undefined;
  /** Before (exclusive). */
  before?: Date | undefined;
  unreadOnly?: boolean | undefined;
}

/** An attachment of a message. `id` is the IMAP body part (e.g. "2" or "2.1"), stable for as long as the message stays where it is. */
export interface AttachmentInfo {
  id: string;
  filename: string;
  contentType: string;
  /** Decoded size in bytes (estimated from the encoded size). */
  size: number;
  inline: boolean;
}

/** Read access to mail (replaceable). Deliberately has no method that changes anything. */
export interface MailReader {
  listMailboxes(): Promise<MailboxInfo[]>;
  listRecent(path: string, count: number): Promise<MessageSummary[]>;
  search(path: string, criteria: SearchCriteria, caps: { limit: number; localPass: number }): Promise<{ total: number; messages: MessageSummary[] }>;
  /** Full message (raw source) including its state. Marks nothing as read. */
  fetchSource(ref: MessageRef): Promise<{ source: Buffer; summary: MessageSummary; truncated: boolean; attachments: AttachmentInfo[] }>;
  /** One attachment, decoded (BODY.PEEK of just this part; marks nothing as read). Refuses parts larger than maxBytes. */
  fetchPart(ref: MessageRef, part: string, maxBytes: number): Promise<{ data: Buffer; info: AttachmentInfo; charset?: string }>;
  /** Messages in a folder that belong to one of the Message-IDs (Message-ID, In-Reply-To or References). */
  findRelated(path: string, messageIds: string[], limit: number): Promise<MessageSummary[]>;
}

/** Draft storage. This is the only mail operation that writes; it requires a DraftGrant from permissions.ts. */
export interface DraftStore {
  appendDraft(grant: DraftGrant, raw: Buffer): Promise<{ mailbox: string; id?: string }>;
}

/** Checks messages before they are changed. Reads read-only. */
export interface MailChecker {
  /** Summaries of the messages (in the order of the refs, undefined = not found). Reads read-only. */
  summaries(refs: MessageRef[]): Promise<Array<MessageSummary | undefined>>;
}

/**
 * Moving to the Trash (IMAP MOVE). Requires a TrashGrant from permissions.ts.
 * Deliberately has nothing for permanent deletion: no \\Deleted, no EXPUNGE.
 */
export interface MailTrasher extends MailChecker {
  moveToTrash(grant: TrashGrant, refs: MessageRef[]): Promise<{ trash: string; moved: number }>;
}

/** Moving messages to another folder (IMAP UID MOVE). Requires a MoveGrant from permissions.ts. */
export interface MailMover extends MailChecker {
  moveMessages(grant: MoveGrant, refs: MessageRef[]): Promise<{ target: string; moved: number; newIds: Array<string | undefined> }>;
}

/** Marking messages read/unread and flagged/unflagged. Requires a FlagGrant from permissions.ts. */
export interface MailFlagger extends MailChecker {
  setFlags(grant: FlagGrant, refs: MessageRef[]): Promise<{ changed: number }>;
}
