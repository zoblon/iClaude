import { UserError } from '../errors.js';

/** Largest note body (in characters of the source text). */
export const MAX_NOTE_CHARS = 50_000;

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text for HTML. Everything that comes from the caller goes through this; no HTML of the caller is ever passed on. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const SAFE_URL = /^(?:https?:\/\/[^\s<>"'`]+|mailto:[^\s<>"'`]+)$/i;

/** Inline formatting on an already escaped line: `code`, **bold**, *italic*, [text](https://link). */
function inline(escaped: string): string {
  const codes: string[] = [];
  // code spans first and set aside, so nothing inside them is formatted
  let t = escaped.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<tt>${c}</tt>`) - 1}\u0000`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    // the URL was escaped with the text: undo only the ampersand so that it can be checked
    const raw = url.replace(/&amp;/g, '&');
    return SAFE_URL.test(raw) ? `<a href="${escapeHtml(raw)}">${text}</a>` : `${text} (${url})`;
  });
  t = t.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string | undefined, b: string | undefined) => `<b>${a ?? b}</b>`);
  t = t.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)|(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, (_m, p1: string | undefined, a: string | undefined, p2: string | undefined, b: string | undefined) =>
    a !== undefined ? `${p1}<i>${a}</i>` : `${p2}<i>${b}</i>`,
  );
  // eslint-disable-next-line no-control-regex
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

/** Markdown to the simple HTML that Apple Notes uses (div, h2, h3, ul, ol, li, b, i, tt, a). Only these tags are ever produced. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | undefined;
  const flushPara = () => {
    if (para.length) out.push(`<div>${para.map((l) => inline(escapeHtml(l))).join('<br>')}</div>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.kind}>${list.items.map((i) => `<li>${inline(escapeHtml(i))}</li>`).join('')}</${list.kind}>`);
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(`<div><tt>${code.map(escapeHtml).join('<br>') || '<br>'}</tt></div>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    const ul = /^\s*[-*+]\s+(.*\S)\s*$/.exec(line);
    const ol = /^\s*\d{1,3}[.)]\s+(.*\S)\s*$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      out.push(`<${h[1]!.length === 1 ? 'h2' : 'h3'}>${inline(escapeHtml(h[2]!))}</${h[1]!.length === 1 ? 'h2' : 'h3'}>`);
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list && list.kind !== kind) flushList();
      (list ??= { kind, items: [] }).items.push((ul ?? ol)![1]!);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

/** Plain text to HTML: line breaks stay, nothing else is interpreted. */
export function plainToHtml(text: string): string {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  return paras.map((p) => `<div>${p.split('\n').map(escapeHtml).join('<br>') || '<br>'}</div>`).join('');
}

/** The body of a new note: the title as the first line (Notes takes the title from it), then the text. */
export function noteHtml(title: string, text: string, format: 'markdown' | 'plain'): string {
  if (Array.from(text).length > MAX_NOTE_CHARS) throw new UserError(`The text is too long (at most ${MAX_NOTE_CHARS} characters).`);
  const body = format === 'markdown' ? markdownToHtml(text) : plainToHtml(text);
  return `<div><h1>${escapeHtml(title.trim())}</h1></div>${body}`;
}
