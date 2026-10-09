import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { DateTime } from 'luxon';
import { buildDraft, encodeText, parseMailbox } from '../src/core/mail/mime.js';

const now = DateTime.fromISO('2026-10-08T15:30:00', { zone: 'Europe/Berlin' });
const base = { from: { address: 'ich@icloud.com' }, to: [{ address: 'anna@beispiel.de' }], cc: [], subject: 'Hallo', body: 'Text', date: now };

describe('parseMailbox', () => {
  it.each([
    ['anna@beispiel.de', undefined, 'anna@beispiel.de'],
    ['Anna Müller <anna@beispiel.de>', 'Anna Müller', 'anna@beispiel.de'],
    ['"Müller, Anna" <anna@beispiel.de>', 'Müller, Anna', 'anna@beispiel.de'],
    ['  <anna@beispiel.de> ', undefined, 'anna@beispiel.de'],
  ])('liest %s', (input, name, address) => {
    const m = parseMailbox(input);
    expect(m.address).toBe(address);
    expect(m.name).toBe(name);
  });
  it.each(['', 'kein-at', 'a@b', 'a b@c.de', 'a@b.de, c@d.de', '<a@b.de', 'Name <a@b.de> x', 'a@b.de\r\nBcc: x@y.de', 'x@y.de\nbcc:z@z.de', 'a@@b.de'])('lehnt "%s" ab', (input) => {
    expect(() => parseMailbox(input)).toThrow(/Mailadresse|Steuerzeichen/);
  });
});

describe('encodeText', () => {
  it('lässt reines ASCII unverändert', () => expect(encodeText('Hallo Welt')).toBe('Hallo Welt'));
  it('kodiert Umlaute und Emoji in Wörter unter 75 Zeichen, ohne Zeichen zu zerschneiden', () => {
    const e = encodeText('Größenänderung für Müller – bitte prüfen 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀');
    for (const w of e.split('\r\n ')) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
  });
  it('macht aus Zeilenumbrüchen Leerzeichen (kein Einschleusen von Kopfzeilen)', () => {
    expect(encodeText('Hi\r\nBcc: x@y.de')).toBe('Hi Bcc: x@y.de');
  });
});

describe('buildDraft: Roundtrip über einen echten Parser', () => {
  it('Betreff, Namen, Text mit Umlauten, Emoji und langen Zeilen kommen unverändert an', async () => {
    const subject = 'Größenänderung für Müller – bitte prüfen 😀 ' + 'x'.repeat(150);
    const body = 'Liebe Anna,\r\n\r\nschöne Grüße aus Köln 😀\n' + 'Ein sehr langer Satz mit Umlauten äöüß '.repeat(30) + '\nhttps://beispiel.de/pfad?a=1&b=2\n\nGruß  \nTobi';
    const { raw, messageId } = buildDraft(
      { ...base, to: [{ name: 'Anna Müller', address: 'anna@beispiel.de' }, { name: 'Meier, Bob "Bobby"', address: 'bob@beispiel.de' }], cc: [{ address: 'c@beispiel.de' }], subject, body },
      'icloud.com',
    );
    const p = await simpleParser(raw);
    expect(p.subject).toBe(subject);
    expect(p.text?.replace(/\r\n/g, '\n').trimEnd()).toBe(body.replace(/\r\n/g, '\n').trimEnd());
    expect(p.from?.value[0]?.address).toBe('ich@icloud.com');
    expect(p.to && 'value' in p.to ? p.to.value.map((v) => [v.name, v.address]) : []).toEqual([['Anna Müller', 'anna@beispiel.de'], ['Meier, Bob "Bobby"', 'bob@beispiel.de']]);
    expect(p.cc && 'value' in p.cc ? p.cc.value[0]?.address : '').toBe('c@beispiel.de');
    expect(p.messageId).toBe(`<${messageId}>`);
    expect(p.date?.toISOString()).toBe('2026-10-08T13:30:00.000Z');
    // Zeilenlängen im Rohtext
    for (const line of raw.toString('utf8').split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    expect(raw.toString('utf8').split('\r\n\r\n')[0]!.split('\r\n').every((l) => l.length <= 78)).toBe(true);
  });

  it('setzt In-Reply-To und References', async () => {
    const { raw } = buildDraft({ ...base, inReplyTo: '<a1@x>', references: ['r0@x', '<a1@x>'] }, 'icloud.com');
    const p = await simpleParser(raw);
    expect(p.inReplyTo).toBe('<a1@x>');
    expect(p.references).toEqual(['<r0@x>', '<a1@x>']);
  });

  it('enthält nie Bcc, Reply-To oder Anhänge und nur eine Textnachricht', async () => {
    const { raw } = buildDraft(base, 'icloud.com');
    const p = await simpleParser(raw);
    for (const h of ['bcc', 'reply-to', 'sender', 'return-path']) expect(p.headers.has(h), h).toBe(false);
    expect(p.attachments).toHaveLength(0);
    expect(raw.toString('utf8')).toContain('Content-Type: text/plain; charset=UTF-8');
  });

  it('eingeschleuste Kopfzeilen im Betreff erzeugen keine echten Kopfzeilen', async () => {
    const { raw } = buildDraft({ ...base, subject: 'Hi\r\nBcc: boese@beispiel.de\r\nX-Evil: 1', body: 'x' }, 'icloud.com');
    const p = await simpleParser(raw);
    expect(p.headers.has('bcc')).toBe(false);
    expect(p.headers.has('x-evil')).toBe(false);
    expect(p.subject).toBe('Hi Bcc: boese@beispiel.de X-Evil: 1');
  });

  it('eingeschleuste Zeilenumbrüche im Anzeigenamen werden abgelehnt', () => {
    expect(() => parseMailbox('Evil\r\nBcc: x@y.de <a@b.de>')).toThrow(/Steuerzeichen/);
  });

  it('verlangt einen Empfänger', () => {
    expect(() => buildDraft({ ...base, to: [] }, 'icloud.com')).toThrow(/Empfänger/);
  });
});
