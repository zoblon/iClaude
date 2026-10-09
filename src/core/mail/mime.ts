import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { UserError } from '../errors.js';

export interface Mailbox {
  name?: string;
  address: string;
}

export interface DraftAttachment {
  filename: string;
  /** Media type such as application/pdf. */
  contentType: string;
  data: Buffer;
}

export interface DraftMessage {
  from: Mailbox;
  to: Mailbox[];
  cc: Mailbox[];
  subject: string;
  body: string;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  date: DateTime;
  /** Attachments (only for forwarded drafts). With attachments the message is multipart/mixed. */
  attachments?: DraftAttachment[] | undefined;
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;
const CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;
const NON_ASCII = /[^\x20-\x7E]/;

/** "a@b.com" or "Name <a@b.com>" (also "Name" <a@b.com>). Invalid input is rejected, never "repaired". */
export function parseMailbox(input: string): Mailbox {
  const s = input.trim();
  if (CONTROL.test(s)) throw new UserError('Invalid email address: control characters are not allowed. Please give only one address per entry.');
  const m = /^(?:(.*?)\s*)?<([^<>]+)>$/.exec(s);
  const address = (m ? m[2]! : s).trim();
  const name = (m?.[1] ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1');
  if (!ADDRESS.test(address)) {
    throw new UserError(`Invalid email address "${s.slice(0, 80)}". Expected: name@example.com or Name <name@example.com>.`);
  }
  if (name.length > 100) throw new UserError('The display name is too long (max. 100 characters).');
  return { ...(name ? { name } : {}), address };
}

/** RFC 2047: text with non-ASCII characters as encoded words, split at character boundaries. */
export function encodeText(text: string): string {
  const clean = text.replace(/[\r\n\t]+/g, ' ');
  if (!NON_ASCII.test(clean)) return clean;
  const words: string[] = [];
  let current = '';
  const flush = () => {
    if (current) words.push(`=?UTF-8?B?${Buffer.from(current, 'utf8').toString('base64')}?=`);
    current = '';
  };
  for (const ch of Array.from(clean)) {
    // at most 42 bytes of raw text per word, so the encoded word stays under 75 characters
    if (Buffer.byteLength(current + ch, 'utf8') > 42) flush();
    current += ch;
  }
  flush();
  return words.join('\r\n ');
}

function formatMailbox(m: Mailbox): string {
  if (!m.name) return m.address;
  if (NON_ASCII.test(m.name)) return `${encodeText(m.name)} <${m.address}>`;
  if (/^[A-Za-z0-9 !#$%&'*+/=?^_`{|}~-]+$/.test(m.name)) return `${m.name} <${m.address}>`;
  return `"${m.name.replace(/[\\"]/g, '\\$&')}" <${m.address}>`;
}

const list = (l: Mailbox[]) => l.map(formatMailbox).join(',\r\n ');

const idList = (ids: string[]) => ids.map((i) => `<${i.replace(/^<|>$/g, '')}>`).join('\r\n ');

const wrap76 = (b64: string) => b64.replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');

const ATTACHMENT_NAME_MAX = 150;

/** A file name that is safe in a header: no path, no control characters. */
export function safeFilename(name: string): string {
  const base = name.replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').split(/[\\/]/).pop()!.replace(/\s+/g, ' ').trim();
  const clipped = Array.from(base).slice(0, ATTACHMENT_NAME_MAX).join('');
  return clipped || 'attachment';
}

/** Media type that is safe in a header; anything unusual becomes application/octet-stream. */
export function safeMediaType(type: string): string {
  const t = type.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/.test(t) ? t : 'application/octet-stream';
}

/**
 * Header parameter for a file name. ASCII names are a quoted string. Other names get an RFC 2231 extended parameter
 * (name*=UTF-8''..., split into continuations when long) plus an RFC 2047 encoded-word fallback in the plain parameter.
 */
export function filenameParams(param: 'name' | 'filename', value: string): string[] {
  if (!NON_ASCII.test(value)) return [`${param}="${value.replace(/[\\"]/g, '\\$&')}"`];
  const pct = Array.from(value)
    .map((ch) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(ch) ? ch : Array.from(Buffer.from(ch, 'utf8')).map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')))
    .join('');
  const chunks: string[] = [];
  // continuation segments of at most about 40 encoded characters, never split inside a %XX triple or a multi-byte character
  const units = pct.match(/%[0-9A-F]{2}(?:%[0-9A-F]{2})*|./g) ?? [];
  let cur = '';
  for (const u of units) {
    if ((cur + u).length > 40 && cur) {
      chunks.push(cur);
      cur = '';
    }
    cur += u;
  }
  if (cur) chunks.push(cur);
  const extended = chunks.length === 1 ? [`${param}*=UTF-8''${chunks[0]}`] : chunks.map((c, i) => `${param}*${i}*=${i === 0 ? "UTF-8''" : ''}${c}`);
  return [`${param}="${encodeText(value)}"`, ...extended];
}

const wrapB64 = (data: Buffer) => wrap76(data.toString('base64'));

/** Builds a plain-text message (UTF-8, Base64); with attachments (forwarding) multipart/mixed. Deliberately no Bcc. */
export function buildDraft(m: DraftMessage, domain: string): { raw: Buffer; messageId: string } {
  if (!m.to.length && !m.cc.length) throw new UserError('Please specify at least one recipient (to or cc).');
  const messageId = `${randomUUID()}@${domain}`;
  const body = m.body.replace(/\r\n?|\n/g, '\r\n');
  const atts = m.attachments ?? [];
  const boundary = `----=_iClaude_${randomUUID().replace(/-/g, '')}`;
  const common = [
    `From: ${formatMailbox(m.from)}`,
    ...(m.to.length ? [`To: ${list(m.to)}`] : []),
    ...(m.cc.length ? [`Cc: ${list(m.cc)}`] : []),
    `Subject: ${encodeText(m.subject)}`,
    `Date: ${m.date.setLocale('en-US').toFormat('EEE, dd LLL yyyy HH:mm:ss ZZZ')}`,
    `Message-ID: <${messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo.replace(/^<|>$/g, '')}>`] : []),
    ...(m.references?.length ? [`References: ${idList(m.references)}`] : []),
    'MIME-Version: 1.0',
  ];
  const headers = atts.length
    ? [...common, `Content-Type: multipart/mixed;\r\n boundary="${boundary}"`]
    : [...common, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  for (const h of headers) {
    // Each header may consist only of itself and indented continuation lines (CRLF + whitespace).
    if (/[\r\n]/.test(h.replace(/\r\n[ \t]/g, ' '))) throw new UserError('Internal safeguard: invalid header. Nothing was written.');
  }
  if (!atts.length) {
    const raw = `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(body, 'utf8').toString('base64'))}\r\n`;
    return { raw: Buffer.from(raw, 'utf8'), messageId };
  }

  const parts: Buffer[] = [Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'utf8')];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(Buffer.from(body, 'utf8').toString('base64'))}\r\n`, 'utf8'));
  for (const a of atts) {
    const name = safeFilename(a.filename);
    const type = safeMediaType(a.contentType);
    const ct = [type, ...filenameParams('name', name)].join(';\r\n\t');
    const cd = ['attachment', ...filenameParams('filename', name)].join(';\r\n\t');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Type: ${ct}\r\nContent-Disposition: ${cd}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapB64(a.data)}\r\n`, 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { raw: Buffer.concat(parts), messageId };
}
