import { UserError } from '../errors.js';
import type { MessageRef } from './types.js';

/** "<Ordner>|<UIDVALIDITY>|<UID>" mit URL-codiertem Ordnernamen. */
export function encodeRef(r: MessageRef): string {
  return `${encodeURIComponent(r.path)}|${r.uidValidity}|${r.uid}`;
}

export function decodeRef(id: string): MessageRef {
  const m = /^([^|]{1,500})\|(\d{1,20})\|(\d{1,12})$/.exec(id.trim());
  if (!m) throw new UserError('Ungültige Nachrichten-ID. Die ID aus list_recent, search_messages oder get_thread unverändert verwenden.');
  let path: string;
  try {
    path = decodeURIComponent(m[1]!);
  } catch {
    throw new UserError('Ungültige Nachrichten-ID. Die ID aus list_recent, search_messages oder get_thread unverändert verwenden.');
  }
  return { path, uidValidity: m[2]!, uid: Number(m[3]) };
}
