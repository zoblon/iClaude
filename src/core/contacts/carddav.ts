import { createDAVClient } from 'tsdav';
import type { Config } from '../config.js';
import { UserError, withTimeout } from '../errors.js';
import type { ContactReader } from './service.js';
import { parseVCard, type Contact } from './vcard.js';

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

const TIMEOUT_MS = 30_000;
const CACHE_MS = 5 * 60_000;
/** Upper limit for the number of contacts loaded. */
const MAX_CONTACTS = 5000;

/** Read-only access to iCloud CardDAV. There is no method to create, change or delete. */
export class CardDavGateway implements ContactReader {
  private clientPromise?: Promise<DavClient>;
  private cache?: { at: number; contacts: Contact[]; truncated: boolean };

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

  async loadAll(): Promise<{ contacts: Contact[]; truncated: boolean }> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache;
    const client = await this.client();
    const books = await withTimeout(client.fetchAddressBooks(), TIMEOUT_MS, 'loading the address books');
    if (!books.length) throw new UserError('No address book was found. Please check in the iCloud settings that Contacts is enabled.');

    const contacts: Contact[] = [];
    let truncated = false;
    for (const book of books) {
      const cards = await withTimeout(client.fetchVCards({ addressBook: book }), TIMEOUT_MS, 'loading the contacts');
      const bookName = typeof book.displayName === 'string' && book.displayName ? book.displayName : 'Contacts';
      for (const card of cards) {
        if (contacts.length >= MAX_CONTACTS) {
          truncated = true;
          break;
        }
        if (typeof card.data !== 'string') continue;
        const c = parseVCard(card.data, new URL(card.url).pathname, bookName);
        if (c) contacts.push(c);
      }
    }
    this.cache = { at: Date.now(), contacts, truncated };
    return this.cache;
  }
}
