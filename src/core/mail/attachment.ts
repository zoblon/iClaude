import { getDocumentProxy, extractText } from 'unpdf';
import type { Config } from '../config.js';
import { UserError, withTimeout } from '../errors.js';
import { summarizeInvitation, type InvitationSummary } from '../calendar/invitation.js';
import { clip } from '../untrusted.js';
import { htmlToMarkdown, paginate, tidy, type Page } from './body.js';
import { decodeRef } from './ref.js';
import type { MailReader } from './types.js';

/** Largest attachment that will be downloaded. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const MAX_TEXT_CHARS = 2_000_000;
const PDF_TIMEOUT_MS = 40_000;

export type AttachmentKind = 'text' | 'pdf' | 'calendar' | 'unsupported';

export interface AttachmentView {
  id: string;
  attachmentId: string;
  filename: string;
  contentType: string;
  size: number;
  kind: AttachmentKind;
  /** Format of `text`: plain text, or Markdown for HTML attachments. */
  format?: 'text' | 'markdown';
  page?: Omit<Page, 'text'>;
  text?: string;
  pdf?: { pages: number; textLayer: boolean; pagesRead: number };
  calendar?: InvitationSummary;
  note?: string;
}

const TEXT_TYPES = /^(text\/.+|application\/(json|xml|x-ndjson|csv|x-yaml|yaml|javascript|rtf))$/i;
const TEXT_EXT = /\.(txt|csv|tsv|md|markdown|json|xml|html?|log|yaml|yml|ini|conf|vcf)$/i;

function decodeText(data: Buffer, charset: string | undefined): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  const body = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? data.subarray(3) : data;
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '')).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

async function extractPdf(data: Buffer): Promise<{ text: string; pages: number; pagesRead: number; chars: number }> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await withTimeout(getDocumentProxy(new Uint8Array(data), { isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 } as never), PDF_TIMEOUT_MS, 'opening the PDF');
  } catch (e) {
    if (e instanceof UserError) throw e;
    const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    if (/password/i.test(msg)) throw new UserError('The PDF is password-protected and cannot be read.');
    throw new UserError('The PDF could not be read (damaged or not a valid PDF).');
  }
  try {
    const pages = pdf.numPages;
    const { text } = await withTimeout(extractText(pdf, { mergePages: false }), PDF_TIMEOUT_MS, 'reading the PDF text');
    const list = (Array.isArray(text) ? text : [String(text)]).slice(0, MAX_PDF_PAGES);
    const body = list.length > 1 ? list.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}`).join('\n\n') : (list[0] ?? '').trim();
    return { text: body, pages, pagesRead: list.length, chars: list.join('').replace(/\s+/g, '').length };
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError('The text of the PDF could not be extracted.');
  } finally {
    try {
      await (pdf as unknown as { cleanup?: () => Promise<void> }).cleanup?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Reads one attachment of a message. Only that part is downloaded (BODY.PEEK, nothing is marked as read), nothing is fetched from the network,
 * nothing is executed. Text, PDF (text layer) and calendar invitations are supported; everything else returns metadata only.
 */
export class AttachmentService {
  constructor(
    private readonly cfg: Config,
    private readonly reader: MailReader,
  ) {}

  async read(id: string, attachmentId: string, offset = 0): Promise<AttachmentView> {
    const ref = decodeRef(id);
    const { data, info, charset } = await this.reader.fetchPart(ref, attachmentId.trim(), MAX_ATTACHMENT_BYTES);
    const type = info.contentType.toLowerCase();
    const base = { id, attachmentId: info.id, filename: info.filename, contentType: info.contentType, size: data.length };

    const isPdf = type === 'application/pdf' || (data.subarray(0, 5).toString('latin1') === '%PDF-' && (type === 'application/octet-stream' || /\.pdf$/i.test(info.filename)));
    const isCalendar = type === 'text/calendar' || type === 'application/ics' || /\.ics$/i.test(info.filename) || (type === 'application/octet-stream' && data.subarray(0, 15).toString('latin1').toUpperCase().startsWith('BEGIN:VCALENDAR'));
    const isText = TEXT_TYPES.test(type) || (type === 'application/octet-stream' && TEXT_EXT.test(info.filename));

    if (isCalendar) {
      const summary = summarizeInvitation(decodeText(data, charset), this.cfg.timezone);
      return {
        ...base,
        kind: 'calendar',
        calendar: summary,
        note: 'Calendar invitation. To add it to a calendar of the user, use import_invitation (it creates a plain event without attendees and sends no reply).',
      };
    }

    if (isPdf) {
      const r = await extractPdf(data);
      const textLayer = r.chars >= 10;
      const text = textLayer ? tidy(r.text).slice(0, MAX_TEXT_CHARS) : '';
      const { text: pageText, ...page } = paginate(text, offset);
      return {
        ...base,
        kind: 'pdf',
        format: 'text',
        text: pageText,
        page,
        pdf: { pages: r.pages, textLayer, pagesRead: r.pagesRead },
        ...(!textLayer
          ? { note: 'This PDF has no text layer (probably a scan or only images). Text recognition (OCR) is not supported, so no text could be extracted.' }
          : r.pagesRead < r.pages
            ? { note: `Only the first ${r.pagesRead} of ${r.pages} pages were read.` }
            : {}),
      };
    }

    if (isText) {
      const isHtml = type === 'text/html' || /\.html?$/i.test(info.filename);
      const raw = decodeText(data, charset);
      const text = (isHtml ? htmlToMarkdown(raw) : tidy(raw)).slice(0, MAX_TEXT_CHARS);
      const { text: pageText, ...page } = paginate(text, offset);
      return { ...base, kind: 'text', format: isHtml ? 'markdown' : 'text', text: pageText, page };
    }

    return {
      ...base,
      kind: 'unsupported',
      note: `Attachments of type ${clip(info.contentType, 60)} are not read by this connector (only text, PDF and calendar invitations). Only the metadata is shown; the user can open the attachment in Apple Mail.`,
    };
  }
}
