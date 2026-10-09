import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import TurndownService from 'turndown';
import { clip } from '../untrusted.js';
import type { Address } from './types.js';

/** Seitengröße in Zeichen (Unicode-Zeichen, nicht Bytes). */
export const PAGE_SIZE = 8000;
const MAX_HTML_CHARS = 1_000_000;

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface ParsedMessage {
  subject: string;
  from: Address[];
  replyTo: Address[];
  to: Address[];
  cc: Address[];
  date: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  attachments: Attachment[];
  text: string;
  /** Format, in dem der Text tatsächlich vorliegt. */
  format: 'text' | 'markdown';
}

const addrs = (a: AddressObject | AddressObject[] | undefined): Address[] => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list
    .flatMap((x) => x.value)
    .slice(0, 30)
    .map((v) => ({ ...(v.name ? { name: clip(v.name, 200) } : {}), ...(v.address ? { address: clip(v.address, 200) } : {}) }));
};

const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|(?:max-)?height\s*:\s*0(?![.\d])|(?:max-)?width\s*:\s*0(?![.\d])|mso-hide\s*:\s*all/i;

let turndown: TurndownService | undefined;
function td(): TurndownService {
  if (turndown) return turndown;
  const t = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', linkStyle: 'inlined' });
  t.remove(['script', 'style', 'head', 'title', 'meta', 'link', 'iframe', 'object', 'embed', 'svg', 'noscript', 'template'] as never);
  // Versteckte Elemente (häufiger Weg, unsichtbare Anweisungen in Mails zu verstecken) werden nicht übernommen.
  t.addRule('hidden', {
    filter: (node) => {
      const el = node as unknown as { getAttribute?: (n: string) => string | null };
      if (typeof el.getAttribute !== 'function') return false;
      return el.getAttribute('hidden') !== null || HIDDEN_STYLE.test(el.getAttribute('style') ?? '');
    },
    replacement: () => '',
  });
  // Bilder: nur der Alternativtext, keine Adressen (Tracking-Pixel).
  t.addRule('images', {
    filter: 'img',
    replacement: (_c, node) => {
      const alt = (node as unknown as { getAttribute(n: string): string | null }).getAttribute('alt')?.trim();
      return alt ? `[Bild: ${alt}]` : '';
    },
  });
  turndown = t;
  return t;
}

export function htmlToMarkdown(html: string): string {
  const input = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  return tidy(td().turndown(input));
}

/** Entfernt unsichtbare Zeichen und übermäßige Leerzeilen. */
export function tidy(text: string): string {
  return text
    .replace(/[﻿​-‏⁠­]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Liest eine Nachricht aus dem Rohtext. Nichts wird nachgeladen, keine Anhänge werden ausgegeben. */
export async function parseMessage(source: Buffer, format: 'text' | 'markdown'): Promise<ParsedMessage> {
  const p: ParsedMail = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const html = typeof p.html === 'string' ? p.html : '';
  const plain = typeof p.text === 'string' ? p.text : '';

  let text: string;
  let actual: 'text' | 'markdown';
  if (format === 'markdown' && html) {
    text = htmlToMarkdown(html);
    actual = 'markdown';
  } else if (plain.trim()) {
    text = tidy(plain);
    actual = 'text';
  } else if (html) {
    text = htmlToMarkdown(html);
    actual = 'markdown';
  } else {
    text = '';
    actual = 'text';
  }

  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  return {
    subject: clip(p.subject ?? '', 300) || '(ohne Betreff)',
    from: addrs(p.from),
    replyTo: addrs(p.replyTo),
    to: addrs(p.to),
    cc: addrs(p.cc),
    date: p.date instanceof Date && !Number.isNaN(p.date.getTime()) ? p.date.toISOString() : '',
    ...(p.messageId ? { messageId: p.messageId.replace(/^<|>$/g, '') } : {}),
    ...(p.inReplyTo ? { inReplyTo: String(p.inReplyTo).replace(/^<|>$/g, '') } : {}),
    references: refs.map((r) => r.replace(/^<|>$/g, '')).slice(0, 50),
    attachments: (p.attachments ?? []).slice(0, 50).map((a) => ({
      filename: clip(a.filename ?? '(ohne Namen)', 200),
      contentType: clip(a.contentType ?? 'application/octet-stream', 100),
      size: a.size ?? 0,
      inline: a.contentDisposition === 'inline' || Boolean(a.related),
    })),
    text,
    format: actual,
  };
}

export interface Page {
  text: string;
  offset: number;
  pageLength: number;
  totalLength: number;
  truncated: boolean;
  nextOffset?: number;
}

/** Seitenweise Ausgabe nach Unicode-Zeichen. Ein Offset hinter dem Ende wird auf das Ende begrenzt. */
export function paginate(text: string, offset = 0, size = PAGE_SIZE): Page {
  const chars = Array.from(text);
  const total = chars.length;
  const start = Math.min(Math.max(0, Math.floor(offset)), total);
  const end = Math.min(start + size, total);
  return {
    text: chars.slice(start, end).join(''),
    offset: start,
    pageLength: end - start,
    totalLength: total,
    truncated: end < total,
    ...(end < total ? { nextOffset: end } : {}),
  };
}

/** Entfernt zitierte Zeilen (beginnend mit ">") für knappe Auszüge. */
export function withoutQuotes(text: string): string {
  return tidy(
    text
      .split('\n')
      .filter((l) => !/^\s*>/.test(l))
      .join('\n'),
  );
}
