/**
 * Feasibility test: signs in to iCloud and lists
 * calendars, address books and mail folders.
 *
 * Output contains only names and numbers, no content, no credentials.
 * Run: npm run feasibility
 */
import { createDAVClient } from 'tsdav';
import { ImapFlow } from 'imapflow';

const env = (k: string) => (process.env[k] ?? '').trim();
const appleId = env('ICLOUD_APPLE_ID');
const mailUser = env('ICLOUD_MAIL_USER');
const password = env('ICLOUD_APP_PASSWORD');

const missing = ['ICLOUD_APPLE_ID', 'ICLOUD_MAIL_USER', 'ICLOUD_APP_PASSWORD'].filter((k) => !env(k));
if (missing.length) {
  console.error(`Missing values in .env: ${missing.join(', ')}`);
  process.exit(1);
}

/** Removes credentials from error messages. */
function clean(e: unknown): string {
  let m = e instanceof Error ? e.message : String(e);
  for (const secret of [password, appleId, mailUser]) if (secret) m = m.split(secret).join('***');
  return m.slice(0, 300);
}

async function step(name: string, fn: () => Promise<void>) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (e) {
    console.log(`ERROR: ${clean(e)}`);
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

await step('CalDAV', async () => {
  const client = await createDAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: { username: appleId, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  const calendars = await client.fetchCalendars();
  console.log(`${calendars.length} calendars found:`);
  for (const c of calendars) {
    const comps = Array.isArray(c.components) ? c.components.join(',') : '';
    console.log(`- ${text(c.displayName)}  [${comps}]`);
  }

  // Raw data for detecting shared calendars: owner, privileges, invitations.
  console.log('\nProperties for detecting shared calendars:');
  const homeUrl = calendars[0]?.url?.replace(/[^/]+\/?$/, '');
  if (homeUrl) {
    const res = await client.propfind({
      url: homeUrl,
      depth: '1',
      props: {
        'd:displayname': {},
        'd:resourcetype': {},
        'd:owner': {},
        'd:current-user-privilege-set': {},
        'cs:shared-url': {},
        'cs:invite': {},
        'cs:source': {},
      },
    });
    for (const r of res) {
      const p = (r.props ?? {}) as Record<string, any>;
      const rt = JSON.stringify(p.resourcetype ?? {});
      const priv = JSON.stringify(p.currentUserPrivilegeSet ?? {}).match(/write|bind|unbind|all/g);
      console.log(
        `- ${text(p.displayname)} | resourcetype=${rt.slice(0, 120)} | owner=${text(p.owner?.href ?? p.owner).slice(0, 60)}` +
          ` | invite=${p.invite ? 'yes' : 'no'} | shared-url=${p.sharedUrl ? 'yes' : 'no'}` +
          ` | write-privileges=${priv ? [...new Set(priv)].join('/') : 'none'}`,
      );
    }
  }
});

await step('CardDAV', async () => {
  const client = await createDAVClient({
    serverUrl: 'https://contacts.icloud.com',
    credentials: { username: appleId, password },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  });
  const books = await client.fetchAddressBooks();
  console.log(`${books.length} address book(s):`);
  for (const b of books) {
    const objs = await client.fetchVCards({ addressBook: b });
    console.log(`- ${text(b.displayName)}  (${objs.length} contacts)`);
  }
});

await step('IMAP', async () => {
  const imap = new ImapFlow({
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    auth: { user: mailUser, pass: password },
    logger: false,
  });
  imap.on('error', () => {});
  await imap.connect();
  try {
    const boxes = await imap.list({ statusQuery: { messages: true, unseen: true } });
    console.log(`${boxes.length} folders:`);
    for (const b of boxes) {
      const su = b.specialUse ? `  [${b.specialUse}]` : '';
      console.log(`- ${b.path}${su}  (${b.status?.messages ?? '?'} messages, ${b.status?.unseen ?? '?'} unread)`);
    }
    console.log(`\nServer capabilities: ${['SPECIAL-USE', 'THREAD=REFERENCES', 'THREAD=ORDEREDSUBJECT', 'UIDPLUS', 'MOVE']
      .map((c) => `${c}=${imap.capabilities.has(c) ? 'yes' : 'no'}`)
      .join(', ')}`);
  } finally {
    await imap.logout();
  }
});

console.log('\nDone.');
