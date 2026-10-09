import { UserError } from '../errors.js';
import type { MessageRef } from './types.js';

/** "<folder>|<UIDVALIDITY>|<UID>" with a URL-encoded folder name. */
export function encodeRef(r: MessageRef): string {
  return `${encodeURIComponent(r.path)}|${r.uidValidity}|${r.uid}`;
}

export function decodeRef(id: string): MessageRef {
  const m = /^([^|]{1,500})\|(\d{1,20})\|(\d{1,12})$/.exec(id.trim());
  if (!m) throw new UserError('Invalid message ID. Use the ID from list_recent, search_messages or get_thread unchanged.');
  let path: string;
  try {
    path = decodeURIComponent(m[1]!);
  } catch {
    throw new UserError('Invalid message ID. Use the ID from list_recent, search_messages or get_thread unchanged.');
  }
  return { path, uidValidity: m[2]!, uid: Number(m[3]) };
}
