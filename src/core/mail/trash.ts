import { UserError } from '../errors.js';
import { authorizeTrash, MAX_TRASH_PER_CALL } from '../permissions.js';
import { normText, sameText } from '../untrusted.js';
import { decodeRef } from './ref.js';
import type { Address, MailboxInfo, MailTrasher, MessageRef, MessageSummary } from './types.js';

export interface TrashItem {
  /** ID aus list_recent, search_messages, get_message oder get_thread. */
  id: string;
  /** Betreff der Mail, wie dort angezeigt. Muss zur Mail passen. */
  subject: string;
  /** Absender der Mail (Adresse, "Name <adresse>" oder Name). Muss zur Mail passen. */
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
 * Enthält die Angabe eine Mailadresse, muss genau diese Adresse unter den Absendern sein.
 * Sonst muss sie dem Anzeigenamen eines Absenders entsprechen.
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

const WHEN = 'etwa 30 Tage';

/**
 * Verschiebt Mails in den Papierkorb. Nie endgültig löschen: Die Mails bleiben im Papierkorb und lassen sich dort wiederherstellen.
 * Vor dem Verschieben wird für jede Mail geprüft, dass Betreff und Absender zur Angabe passen. Passt eine nicht, wird nichts verschoben.
 */
export class TrashService {
  constructor(
    private readonly store: MailTrasher,
    private readonly mailboxes: () => Promise<MailboxInfo[]>,
  ) {}

  async trash(items: TrashItem[]): Promise<TrashResult> {
    if (items.length === 0) throw new UserError('Keine Mail angegeben. Bitte mindestens eine Mail nennen.');
    if (items.length > MAX_TRASH_PER_CALL) {
      throw new UserError(`Zu viele Mails auf einmal (${items.length}, höchstens ${MAX_TRASH_PER_CALL} je Aufruf). Es wurde nichts verschoben. Bitte in kleinere Gruppen aufteilen.`);
    }

    const refs: MessageRef[] = items.map((i) => decodeRef(i.id));
    const keys = refs.map((r) => `${r.path}\u0000${r.uidValidity}\u0000${r.uid}`);
    if (new Set(keys).size !== keys.length) throw new UserError('Dieselbe Mail ist mehrfach angegeben. Es wurde nichts verschoben.');

    // Rechte zuerst: Ziel (Papierkorb mit Merkmal \Trash) und Ordner stehen fest, bevor irgendetwas geladen wird.
    const grant = authorizeTrash({ mailboxes: await this.mailboxes(), sourcePaths: refs.map((r) => r.path) });

    const found = await this.store.summaries(refs);
    const problems: string[] = [];
    found.forEach((s, i) => {
      const n = i + 1;
      const item = items[i]!;
      if (!s) {
        problems.push(`Mail ${n}: nicht gefunden (verschoben oder gelöscht?)`);
        return;
      }
      if (!sameText(item.subject, s.subject)) problems.push(`Mail ${n}: Der Betreff passt nicht zur Mail mit dieser ID`);
      if (!senderMatches(item.from, s.from)) problems.push(`Mail ${n}: Der Absender passt nicht zur Mail mit dieser ID`);
    });
    if (problems.length) {
      throw new UserError(
        `${problems.join('; ')}. Es wurde nichts verschoben. Die Mails mit list_recent oder search_messages neu abrufen und ID, Betreff und Absender unverändert übernehmen.`,
      );
    }

    const done = await this.store.moveToTrash(grant, refs);
    const summaries = found as MessageSummary[];
    return {
      trashMailbox: done.trash,
      count: done.moved,
      moved: summaries.map((s) => ({ id: s.id, mailbox: s.mailbox, subject: s.subject, from: s.from, date: s.date })),
      note: `Die Mails liegen jetzt im Papierkorb und sind dort ${WHEN} wiederherstellbar (in Apple Mail aus dem Papierkorb zurücklegen). Danach löscht iCloud sie endgültig. Dieser Konnektor löscht nie endgültig.`,
    };
  }
}
