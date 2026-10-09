import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { DateTime } from 'luxon';
import { buildDraft, encodeText, parseMailbox } from '../src/core/mail/mime.js';

const now = DateTime.fromISO('2026-10-08T15:30:00', { zone: 'Europe/Berlin' });
const base = { from: { address: 'me@icloud.com' }, to: [{ address: 'anna@example.com' }], cc: [], subject: 'Hello', body: 'Text', date: now };

describe('parseMailbox', () => {
  it.each([
    ['anna@example.com', undefined, 'anna@example.com'],
    ['Anna Müller <anna@example.com>', 'Anna Müller', 'anna@example.com'],
    ['"Müller, Anna" <anna@example.com>', 'Müller, Anna', 'anna@example.com'],
    ['  <anna@example.com> ', undefined, 'anna@example.com'],
  ])('parses %s', (input, name, address) => {
    const m = parseMailbox(input);
    expect(m.address).toBe(address);
    expect(m.name).toBe(name);
  });
  it.each(['', 'no-at', 'a@b', 'a b@c.de', 'a@b.de, c@d.de', '<a@b.de', 'Name <a@b.de> x', 'a@b.de\r\nBcc: x@y.de', 'x@y.de\nbcc:z@z.de', 'a@@b.de'])('rejects "%s"', (input) => {
    expect(() => parseMailbox(input)).toThrow(/email address|control characters/);
  });
});

describe('encodeText', () => {
  it('leaves plain ASCII unchanged', () => expect(encodeText('Hello world')).toBe('Hello world'));
  it('encodes umlauts and emoji as words under 75 characters without splitting characters', () => {
    const e = encodeText('Größenänderung für Müller – bitte prüfen 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀');
    for (const w of e.split('\r\n ')) {
      expect(w.length).toBeLessThanOrEqual(75);
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
  });
  it('turns line breaks into spaces (no header injection)', () => {
    expect(encodeText('Hi\r\nBcc: x@y.de')).toBe('Hi Bcc: x@y.de');
  });
});

describe('buildDraft: round trip through a real parser', () => {
  it('subject, names, text with umlauts, emoji and long lines arrive unchanged', async () => {
    const subject = 'Größenänderung für Müller – bitte prüfen 😀 ' + 'x'.repeat(150);
    const body = 'Liebe Anna,\r\n\r\nschöne Grüße aus Köln 😀\n' + 'Ein sehr langer Satz mit Umlauten äöüß '.repeat(30) + '\nhttps://example.com/pfad?a=1&b=2\n\nGruß  \nTobi';
    const { raw, messageId } = buildDraft(
      { ...base, to: [{ name: 'Anna Müller', address: 'anna@example.com' }, { name: 'Meier, Bob "Bobby"', address: 'bob@example.com' }], cc: [{ address: 'c@example.com' }], subject, body },
      'icloud.com',
    );
    const p = await simpleParser(raw);
    expect(p.subject).toBe(subject);
    expect(p.text?.replace(/\r\n/g, '\n').trimEnd()).toBe(body.replace(/\r\n/g, '\n').trimEnd());
    expect(p.from?.value[0]?.address).toBe('me@icloud.com');
    expect(p.to && 'value' in p.to ? p.to.value.map((v) => [v.name, v.address]) : []).toEqual([['Anna Müller', 'anna@example.com'], ['Meier, Bob "Bobby"', 'bob@example.com']]);
    expect(p.cc && 'value' in p.cc ? p.cc.value[0]?.address : '').toBe('c@example.com');
    expect(p.messageId).toBe(`<${messageId}>`);
    expect(p.date?.toISOString()).toBe('2026-10-08T13:30:00.000Z');
    // Line lengths in the raw source
    for (const line of raw.toString('utf8').split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    expect(raw.toString('utf8').split('\r\n\r\n')[0]!.split('\r\n').every((l) => l.length <= 78)).toBe(true);
  });

  it('sets In-Reply-To and References', async () => {
    const { raw } = buildDraft({ ...base, inReplyTo: '<a1@x>', references: ['r0@x', '<a1@x>'] }, 'icloud.com');
    const p = await simpleParser(raw);
    expect(p.inReplyTo).toBe('<a1@x>');
    expect(p.references).toEqual(['<r0@x>', '<a1@x>']);
  });

  it('never contains Bcc, Reply-To or attachments, only a plain-text message', async () => {
    const { raw } = buildDraft(base, 'icloud.com');
    const p = await simpleParser(raw);
    for (const h of ['bcc', 'reply-to', 'sender', 'return-path']) expect(p.headers.has(h), h).toBe(false);
    expect(p.attachments).toHaveLength(0);
    expect(raw.toString('utf8')).toContain('Content-Type: text/plain; charset=UTF-8');
  });

  it('injected headers in the subject do not create real headers', async () => {
    const { raw } = buildDraft({ ...base, subject: 'Hi\r\nBcc: evil@example.com\r\nX-Evil: 1', body: 'x' }, 'icloud.com');
    const p = await simpleParser(raw);
    expect(p.headers.has('bcc')).toBe(false);
    expect(p.headers.has('x-evil')).toBe(false);
    expect(p.subject).toBe('Hi Bcc: evil@example.com X-Evil: 1');
  });

  it('injected line breaks in the display name are rejected', () => {
    expect(() => parseMailbox('Evil\r\nBcc: x@y.de <a@b.de>')).toThrow(/control characters/);
  });

  it('requires a recipient', () => {
    expect(() => buildDraft({ ...base, to: [] }, 'icloud.com')).toThrow(/recipient/);
  });
});
