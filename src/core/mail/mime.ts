import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { UserError } from '../errors.js';

export interface Mailbox {
  name?: string;
  address: string;
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
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$/;
const CONTROL = /[\u0000-\u001F\u007F\u2028\u2029]/;
const NON_ASCII = /[^\x20-\x7E]/;

/** "a@b.de" oder "Name <a@b.de>" (auch "Name" <a@b.de>). Unzulässiges wird abgelehnt, nie "repariert". */
export function parseMailbox(input: string): Mailbox {
  const s = input.trim();
  if (CONTROL.test(s)) throw new UserError('Ungültige Mailadresse: Steuerzeichen sind nicht erlaubt. Bitte nur eine Adresse pro Eintrag angeben.');
  const m = /^(?:(.*?)\s*)?<([^<>]+)>$/.exec(s);
  const address = (m ? m[2]! : s).trim();
  const name = (m?.[1] ?? '').trim().replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1');
  if (!ADDRESS.test(address)) {
    throw new UserError(`Ungültige Mailadresse "${s.slice(0, 80)}". Erwartet: name@beispiel.de oder Name <name@beispiel.de>.`);
  }
  if (name.length > 100) throw new UserError('Der Anzeigename ist zu lang (höchstens 100 Zeichen).');
  return { ...(name ? { name } : {}), address };
}

/** RFC 2047: Text mit Nicht-ASCII-Zeichen als kodierte Wörter, an Zeichengrenzen getrennt. */
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
    // höchstens 42 Byte Rohtext je Wort, damit das kodierte Wort unter 75 Zeichen bleibt
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

/** Baut eine einfache Textnachricht (UTF-8, Base64). Es gibt bewusst weder Bcc noch Anhänge. */
export function buildDraft(m: DraftMessage, domain: string): { raw: Buffer; messageId: string } {
  if (!m.to.length && !m.cc.length) throw new UserError('Bitte mindestens einen Empfänger angeben (to oder cc).');
  const messageId = `${randomUUID()}@${domain}`;
  const body = m.body.replace(/\r\n?|\n/g, '\r\n');
  const headers = [
    `From: ${formatMailbox(m.from)}`,
    ...(m.to.length ? [`To: ${list(m.to)}`] : []),
    ...(m.cc.length ? [`Cc: ${list(m.cc)}`] : []),
    `Subject: ${encodeText(m.subject)}`,
    `Date: ${m.date.setLocale('en-US').toFormat('EEE, dd LLL yyyy HH:mm:ss ZZZ')}`,
    `Message-ID: <${messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: <${m.inReplyTo.replace(/^<|>$/g, '')}>`] : []),
    ...(m.references?.length ? [`References: ${idList(m.references)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  for (const h of headers) {
    // Jede Kopfzeile darf nur aus ihr selbst und eingerückten Fortsetzungen (CRLF + Leerzeichen) bestehen.
    if (/[\r\n]/.test(h.replace(/\r\n[ \t]/g, ' '))) throw new UserError('Interner Schutz: ungültige Kopfzeile. Es wurde nichts geschrieben.');
  }
  const raw = `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(body, 'utf8').toString('base64'))}\r\n`;
  return { raw: Buffer.from(raw, 'utf8'), messageId };
}
