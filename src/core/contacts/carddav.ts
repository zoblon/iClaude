import { createDAVClient, getBasicAuthHeaders, type DAVAddressBook } from 'tsdav';
import type { Config } from '../config.js';
import { UserError, withTimeout } from '../errors.js';
import { ContactWriteGrant } from '../permissions.js';
import type { ContactCard, ContactStore, ContactData } from './service.js';
import { parseGroupCard, parseVCard, type Contact, type ContactGroup } from './vcard.js';

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

const TIMEOUT_MS = 30_000;
const CACHE_MS = 5 * 60_000;
/** Upper limit for the number of contacts loaded. */
const MAX_CONTACTS = 5000;

const ensureSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`);

/**
 * Access to iCloud CardDAV. Reads everything; writes only single contact cards (create with If-None-Match, update with If-Match)
 * and only with a ContactWriteGrant. There is no method to delete a contact or to write a group card.
 */
export class CardDavGateway implements ContactStore {
  private clientPromise?: Promise<DavClient>;
  private cache?: { at: number; data: ContactData };
  private books: DAVAddressBook[] = [];

  constructor(private readonly cfg: Config) {}

  private client(): Promise<DavClient> {
    if (!this.clientPromise) {
      this.clientPromise = withTimeout(
        createDAVClient({
          serverUrl: 'https://contacts.icloud.com',
          credentials: { username: this.cfg.appleId, password: this.cfg.appPassword },
          authMethod: 'Basic',
          defaultAccountType: 'carddav',
        }),
        TIMEOUT_MS,
        'signing in to iCloud Contacts',
      ).catch((e) => {
        this.clientPromise = undefined;
        throw e;
      });
    }
    return this.clientPromise;
  }

  private authHeaders(): Record<string, string> {
    return getBasicAuthHeaders({ username: this.cfg.appleId, password: this.cfg.appPassword });
  }

  async loadAll(opts: { fresh?: boolean } = {}): Promise<ContactData> {
    if (!opts.fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;
    const client = await this.client();
    const books = await withTimeout(client.fetchAddressBooks(), TIMEOUT_MS, 'loading the address books');
    if (!books.length) throw new UserError('No address book was found. Please check in the iCloud settings that Contacts is enabled.');
    this.books = books;

    const contacts: Contact[] = [];
    const groups: ContactGroup[] = [];
    let truncated = false;
    for (const book of books) {
      const cards = await withTimeout(client.fetchVCards({ addressBook: book }), TIMEOUT_MS, 'loading the contacts');
      const bookName = typeof book.displayName === 'string' && book.displayName ? book.displayName : 'Contacts';
      for (const card of cards) {
        if (typeof card.data !== 'string') continue;
        const id = new URL(card.url).pathname;
        const etag = typeof card.etag === 'string' ? card.etag : undefined;
        const g = parseGroupCard(card.data, id);
        if (g) {
          groups.push(g);
          continue;
        }
        if (contacts.length >= MAX_CONTACTS) {
          truncated = true;
          continue;
        }
        const c = parseVCard(card.data, id, bookName, etag);
        if (c) contacts.push(c);
      }
    }
    const data = { contacts, groups, truncated };
    this.cache = { at: Date.now(), data };
    return data;
  }

  /** Empties the contact cache (after every write). */
  invalidate(): void {
    this.cache = undefined;
  }

  private async bookUrl(): Promise<URL> {
    if (!this.books.length) await this.loadAll();
    const first = this.books[0];
    if (!first) throw new UserError('No address book was found.');
    return new URL(ensureSlash(first.url));
  }

  /** Credentials only go to the contacts server and only for .vcf resources inside the address book. */
  private async resource(id: string): Promise<URL> {
    const book = await this.bookUrl();
    if (!/^\/[^?#\s]*\.vcf$/i.test(id) || id.includes('..')) throw new UserError('Invalid contact ID. Use the id from search_contacts unchanged.');
    const target = new URL(id, book);
    if (target.origin !== book.origin || !target.pathname.startsWith(book.pathname)) {
      throw new UserError('Invalid contact ID: it does not belong to the address book. Use the id from search_contacts unchanged.');
    }
    return target;
  }

  private async send(url: URL, init: { method: 'GET' | 'PUT'; headers?: Record<string, string>; body?: string }): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { method: init.method, headers: { ...this.authHeaders(), ...init.headers }, body: init.body, signal: ctrl.signal, redirect: 'error' });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new UserError(`Timeout while talking to iCloud Contacts (${Math.round(TIMEOUT_MS / 1000)} s). Please check in Apple Contacts whether the change arrived.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The complete card via GET (with the ETag from the response). */
  async getCard(id: string): Promise<ContactCard | undefined> {
    const url = await this.resource(id);
    const res = await this.send(url, { method: 'GET' });
    if (res.status === 404) return undefined;
    if (!res.ok) throw writeError(res.status);
    const data = await res.text();
    if (!data) return undefined;
    const etag = res.headers.get('etag');
    return { id: url.pathname, ...(etag ? { etag } : {}), data };
  }

  async createCard(grant: ContactWriteGrant, filename: string, vcf: string): Promise<ContactCard> {
    if (!ContactWriteGrant.isValid(grant, 'create') || grant.target !== filename) throw new Error('Write access without grant');
    const book = await this.bookUrl();
    const url = new URL(filename, book);
    // If-None-Match: * -> an existing card is never overwritten
    const res = await this.send(url, { method: 'PUT', headers: { 'Content-Type': 'text/vcard; charset=utf-8', 'If-None-Match': '*' }, body: vcf });
    if (!res.ok) throw writeError(res.status);
    this.invalidate();
    return (await this.getCard(url.pathname)) ?? { id: url.pathname, data: vcf };
  }

  async updateCard(grant: ContactWriteGrant, card: { id: string; etag: string; data: string }): Promise<ContactCard> {
    if (!ContactWriteGrant.isValid(grant, 'update') || grant.target !== card.id) throw new Error('Write access without grant');
    if (!card.etag) throw new UserError('Not writing without an ETag.');
    const url = await this.resource(card.id);
    // If-Match: if the card has changed in the meantime, the server refuses (412)
    const res = await this.send(url, { method: 'PUT', headers: { 'Content-Type': 'text/vcard; charset=utf-8', 'If-Match': card.etag }, body: card.data });
    if (!res.ok) throw writeError(res.status);
    this.invalidate();
    return (await this.getCard(url.pathname)) ?? { id: url.pathname, data: card.data };
  }
}

function writeError(status: number): UserError {
  if (status === 412) return new UserError('The contact has changed in the meantime (or already exists). Please load it again with get_contact and repeat the change.');
  if (status === 401) return new UserError('Sign-in to iCloud failed. Check the Apple ID and app-specific password.');
  if (status === 403) return new UserError('iCloud refuses write access to the contacts.');
  if (status === 404) return new UserError('The contact was not found. Please search again with search_contacts.');
  return new UserError(`iCloud rejected the request (HTTP ${status}). Please check the input and try again.`);
}

export type { ContactCard };
