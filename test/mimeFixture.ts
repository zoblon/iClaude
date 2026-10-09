import type { MiniMessage } from './miniImap.js';

export interface FixturePart {
  type: string;
  /** Content as bytes; encoded according to `encoding`. */
  data: Buffer | string;
  encoding?: 'base64' | 'quoted-printable' | '7bit' | '8bit';
  filename?: string;
  disposition?: 'attachment' | 'inline';
  charset?: string;
}

const b64 = (b: Buffer) => b.toString('base64').replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');

/** A real multipart/mixed message for the test server. The first part is the text body. */
export function multipartMessage(o: {
  uid: number;
  flags?: string[];
  subject: string;
  from?: string;
  messageId: string;
  body?: string;
  parts: FixturePart[];
  to?: string;
}): MiniMessage {
  const from = o.from ?? 'Anna Example <anna@example.com>';
  const boundary = 'BOUNDARY-test-1';
  const date = 'Wed, 07 Oct 2026 10:00:00 +0200';
  const chunks: string[] = [`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${o.body ?? `Body of ${o.subject}`}\r\n`];
  for (const p of o.parts) {
    const enc = p.encoding ?? 'base64';
    const data = typeof p.data === 'string' ? Buffer.from(p.data, 'utf8') : p.data;
    const name = p.filename ? `; name="${p.filename}"` : '';
    const disp = p.disposition ?? (p.filename ? 'attachment' : undefined);
    const content = enc === 'base64' ? b64(data) : enc === 'quoted-printable' ? qp(data) : data.toString('latin1');
    chunks.push(
      `--${boundary}\r\nContent-Type: ${p.type}${p.charset ? `; charset=${p.charset}` : ''}${name}\r\n` +
        (disp ? `Content-Disposition: ${disp}${p.filename ? `; filename="${p.filename}"` : ''}\r\n` : '') +
        `Content-Transfer-Encoding: ${enc}\r\n\r\n${content}\r\n`,
    );
  }
  const raw = [
    `From: ${from}`,
    `To: ${o.to ?? 'Me <me@icloud.com>'}`,
    `Subject: ${o.subject}`,
    `Date: ${date}`,
    `Message-ID: <${o.messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    chunks.join('') + `--${boundary}--`,
    '',
  ].join('\r\n');
  return { uid: o.uid, flags: o.flags ?? [], subject: o.subject, from, messageId: `<${o.messageId}>`, date, raw };
}

function qp(data: Buffer): string {
  let out = '';
  for (const byte of data) out += (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 ? String.fromCharCode(byte) : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  return out;
}

export const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:invite-1@example.com',
  'DTSTAMP:20261001T100000Z',
  'DTSTART;TZID=Europe/Berlin:20261021T100000',
  'DTEND;TZID=Europe/Berlin:20261021T113000',
  'SUMMARY:Project kickoff',
  'LOCATION:Room 4',
  'DESCRIPTION:Agenda\\nand more',
  'ORGANIZER;CN=Boss:mailto:boss@company.example',
  'ATTENDEE;CN=Me:mailto:me@icloud.com',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:x',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
