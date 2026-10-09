import type { DraftGrant, TrashGrant } from '../permissions.js';

export interface Address {
  name?: string;
  address?: string;
}

export interface MailboxInfo {
  /** Voller Pfad auf dem Server, z. B. "INBOX" oder "Sent Messages". */
  path: string;
  name: string;
  /** inbox, sent, drafts, archive, junk, trash oder leer. */
  role?: string;
  /** Woher die Rolle stammt: Merkmal der Serverliste (\\Trash, \\Drafts, …) oder nur der Ordnername. Der Papierkorb gilt nur mit Merkmal. */
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
  /** Referenz auf die Nachricht (für get_message / get_thread). */
  id: string;
  mailbox: string;
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  /** ISO-Zeit; leer, wenn unbekannt. */
  date: string;
  unread: boolean;
  flagged: boolean;
  answered: boolean;
  /** Entwurf (Flag \\Draft). */
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
  /** Volltext (Kopfzeilen und Inhalt). */
  text?: string | undefined;
  /** Von (einschließlich). */
  since?: Date | undefined;
  /** Vor (ausschließlich). */
  before?: Date | undefined;
  unreadOnly?: boolean | undefined;
}

/** Lesender Zugriff auf Mail (austauschbar). Es gibt bewusst keine Methode, die etwas verändert. */
export interface MailReader {
  listMailboxes(): Promise<MailboxInfo[]>;
  listRecent(path: string, count: number): Promise<MessageSummary[]>;
  search(path: string, criteria: SearchCriteria, caps: { limit: number; localPass: number }): Promise<{ total: number; messages: MessageSummary[] }>;
  /** Vollständige Nachricht (Rohtext) samt Zustand. Markiert nichts als gelesen. */
  fetchSource(ref: MessageRef): Promise<{ source: Buffer; summary: MessageSummary; truncated: boolean }>;
  /** Nachrichten eines Ordners, die zu einer der Message-IDs gehören (Message-ID, In-Reply-To oder References). */
  findRelated(path: string, messageIds: string[], limit: number): Promise<MessageSummary[]>;
}

/** Ablegen von Entwürfen. Das ist die einzige schreibende Mail-Operation; sie verlangt eine DraftGrant aus permissions.ts. */
export interface DraftStore {
  appendDraft(grant: DraftGrant, raw: Buffer): Promise<{ mailbox: string; id?: string }>;
}

/**
 * In den Papierkorb verschieben (IMAP MOVE). Verlangt eine TrashGrant aus permissions.ts.
 * Es gibt bewusst nichts zum endgültigen Löschen: kein \\Deleted, kein EXPUNGE.
 */
export interface MailTrasher {
  /** Zusammenfassungen zu den Nachrichten (in der Reihenfolge der Referenzen, undefined = nicht gefunden). Liest schreibgeschützt. */
  summaries(refs: MessageRef[]): Promise<Array<MessageSummary | undefined>>;
  moveToTrash(grant: TrashGrant, refs: MessageRef[]): Promise<{ trash: string; moved: number }>;
}
