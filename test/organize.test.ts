import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { FlagService } from '../src/core/mail/flags.js';
import { ImapGateway, type ImapLike } from '../src/core/mail/imap.js';
import { MoveService } from '../src/core/mail/move.js';
import { MailService } from '../src/core/mail/service.js';
import { authorizeMove, MoveGrant } from '../src/core/permissions.js';
import { moveMessageSchema, setMessageFlagsSchema } from '../src/mcp/organizeTools.js';
import { cfg } from './fakeStore.js';
import { MiniImap, rfc822, type MiniBox, type MiniMessage } from './miniImap.js';

const FROM = 'Anna Example <anna@example.com>';
const msg = (uid: number, flags: string[], subject: string, mid: string, from = FROM): MiniMessage => ({
  uid,
  flags,
  subject,
  from,
  messageId: `<${mid}>`,
  date: 'Wed, 07 Oct 2026 10:00:00 +0200',
  raw: rfc822({ from, subject, messageId: `<${mid}>`, date: 'Wed, 07 Oct 2026 10:00:00 +0200', body: `Content of ${subject}` }),
});

const boxes = (): Record<string, MiniBox> => ({
  INBOX: { uidValidity: 1700, messages: [msg(1, [], 'Payment October', 'a1@x'), msg(2, ['\\Seen'], 'Newsletter', 'a2@x', 'Shop <news@shop.example>'), msg(3, [], 'Urgent', 'a3@x', 'Boss <boss@company.example>')] },
  'Sent Messages': { special: '\\Sent', uidValidity: 1800, messages: [msg(1, ['\\Seen'], 'Sent', 's1@x')] },
  Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [msg(1, ['\\Seen', '\\Draft'], 'A draft', 'd1@x')] },
  Archive: { special: '\\Archive', uidValidity: 2000, messages: [msg(1, ['\\Seen'], 'Archived', 'r1@x')] },
  Junk: { special: '\\Junk', uidValidity: 2050, messages: [] },
  'Deleted Messages': { special: '\\Trash', uidValidity: 2100, messages: [msg(1, ['\\Seen'], 'Trashed earlier', 't1@x')] },
  'iClaude-Test': { uidValidity: 2200, messages: [] },
  Büro: { uidValidity: 2300, messages: [] },
  Entwürfe: { uidValidity: 2400, messages: [] },
});

let server: MiniImap;
let gateway: ImapGateway;
let mail: MailService;
let mover: MoveService;
let flagger: FlagService;

async function setup(opts: { noCopyUid?: boolean } = {}) {
  server = new MiniImap(boxes(), { move: true, advertiseMove: false, ...opts });
  for (const b of ['INBOX', 'Archive', 'Sent Messages', 'Drafts', 'Deleted Messages', 'Junk', 'iClaude-Test']) server.allowWriteSelect.add(b);
  for (const d of ['Archive', 'iClaude-Test', 'INBOX']) server.allowMove.add(d);
  server.allowStoreFlags = new Set(['\\Seen', '\\Flagged']);
  await server.start();
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  mail = new MailService(cfg, gateway);
  mover = new MoveService(gateway, () => mail.mailboxes(), (r) => mail.resolveMailbox(r), (p, mid) => gateway.findRelated(p, [mid], 10));
  flagger = new FlagService(gateway, () => mail.mailboxes());
}
afterEach(async () => {
  await gateway?.close();
  await server?.stop();
});

const idOf = async (mailbox: string, subject: string) => (await mail.listRecent(mailbox, 20)).messages.find((m) => m.subject === subject)!.id;
const item = async (mailbox: string, subject: string, from = 'anna@example.com') => ({ id: await idOf(mailbox, subject), subject, from });
const subjects = (box: string) => server.boxes[box]!.messages.map((m) => m.subject).sort();
const flagsOf = (box: string, subject: string) => [...server.boxes[box]!.messages.find((m) => m.subject === subject)!.flags].sort();
const dangerous = () => server.commands.filter((c) => /\\Deleted|\bEXPUNGE\b|\bCOPY\b|\bAPPEND\b|\bDELETE\b|\bCREATE\b|\bRENAME\b/i.test(c));

describe('move_message', () => {
  beforeEach(() => setup());

  it('moves several mails via UID MOVE into the Archive (found by role) and returns the new IDs', async () => {
    const r = await mover.move([await item('INBOX', 'Payment October'), await item('INBOX', 'Urgent', 'boss@company.example')], 'archive');
    expect(r.targetMailbox).toBe('Archive');
    expect(r.count).toBe(2);
    expect(subjects('INBOX')).toEqual(['Newsletter']);
    expect(subjects('Archive')).toEqual(['Archived', 'Payment October', 'Urgent']);
    expect(server.moves).toEqual([{ from: 'INBOX', to: 'Archive', uids: [1, 3] }]);
    expect(r.moved.every((m) => m.newId && m.toMailbox === 'Archive' && m.fromMailbox === 'INBOX')).toBe(true);
    // the new ID is valid: the mail can be read at its new place, and moved back with it
    const back = await mover.move([{ id: r.moved[0]!.newId!, subject: 'Payment October', from: 'anna@example.com' }], 'INBOX');
    expect(back.targetMailbox).toBe('INBOX');
    expect(subjects('INBOX')).toEqual(['Newsletter', 'Payment October']);
    expect(server.violations).toEqual([]);
    expect(dangerous()).toEqual([]);
    expect(server.commands.filter((c) => /\bSTORE\b/.test(c))).toEqual([]);
  });

  it('finds the new ID by Message-ID when the server does not report COPYUID', async () => {
    await gateway.close();
    await server.stop();
    await setup({ noCopyUid: true });
    const r = await mover.move([await item('INBOX', 'Payment October')], 'iClaude-Test');
    expect(r.moved[0]!.newId).toBeTruthy();
    expect((await mail.getMessage(r.moved[0]!.newId!)).subject).toBe('Payment October');
  });

  it('moves nothing when one mail does not match (subject or sender)', async () => {
    const ok = await item('INBOX', 'Payment October');
    await expect(mover.move([ok, { ...(await item('INBOX', 'Urgent')), subject: 'Something else' }], 'archive')).rejects.toThrow(/Message 2: the subject does not match.*Nothing was moved/s);
    await expect(mover.move([ok, { ...(await item('INBOX', 'Urgent')), from: 'someone@else.example' }], 'archive')).rejects.toThrow(/Message 2: the sender does not match/);
    expect(server.moves).toEqual([]);
    expect(subjects('INBOX')).toHaveLength(3);
  });

  it.each([
    ['the Trash by role', 'trash', /Trash is not a target/],
    ['the Trash by name', 'Deleted Messages', /Trash is not a target/],
    ['the Trash by German name', 'Papierkorb', /not found|Trash/],
    ['Drafts', 'drafts', /not a target/],
    ['Sent', 'Sent Messages', /not a target/],
    ['Junk', 'junk', /not a target/],
    ['an unknown folder', 'Nope', /not found/],
  ])('refuses %s as a target', async (_n, target, msgRe) => {
    await expect(mover.move([await item('INBOX', 'Payment October')], target)).rejects.toThrow(msgRe);
    expect(server.moves).toEqual([]);
    expect(subjects('INBOX')).toHaveLength(3);
  });

  it('refuses the source folder as the target, duplicates and too many mails', async () => {
    const one = await item('INBOX', 'Payment October');
    await expect(mover.move([one], 'inbox')).rejects.toThrow(/already in the target folder/);
    await expect(mover.move([one, one], 'archive')).rejects.toThrow(/more than once/);
    const many = Array.from({ length: 51 }, () => one);
    await expect(mover.move(many, 'archive')).rejects.toThrow(/Too many/);
    expect(moveMessageSchema.safeParse({ messages: many, to_mailbox: 'archive' }).success).toBe(false);
    expect(server.moves).toEqual([]);
  });

  it('can move mails out of the Trash and from other folders (to undo trash_message)', async () => {
    const trashed = await item('Deleted Messages', 'Trashed earlier');
    const r = await mover.move([trashed], 'INBOX');
    expect(r.count).toBe(1);
    expect(subjects('Deleted Messages')).toEqual([]);
  });

  it('handles folder names with umlauts (modified UTF-7 on the wire) and a rejecting server', async () => {
    server.allowMove.add('B&APw-ro');
    await mover.move([await item('INBOX', 'Payment October')], 'Büro').catch(() => undefined);
    // the test server knows the folder only under its decoded name, so only the encoded command matters here
    expect(server.commands.some((c) => /UID MOVE 1 "?B&APw-ro/.test(c))).toBe(true);
    // German drafts folder names are never a target, whatever their attributes say
    await expect(mover.move([await item('INBOX', 'Urgent', 'boss@company.example')], 'Entwürfe')).rejects.toThrow(/not a target/);
  });

  it('the grant is the only way: forged grants are refused by the gateway', async () => {
    const ref = (await mail.listRecent('inbox', 5)).messages[0]!;
    const { decodeRef } = await import('../src/core/mail/ref.js');
    await expect(gateway.moveMessages({ target: 'Archive', sources: new Set(['INBOX']), count: 1 } as never, [decodeRef(ref.id)])).rejects.toThrow(/without a grant/);
    const grant = authorizeMove({ mailboxes: await mail.mailboxes(), sourcePaths: ['INBOX'], targetPath: 'Archive' });
    expect(MoveGrant.isValid(grant)).toBe(true);
    await expect(gateway.moveMessages(grant, [{ path: 'Archive', uidValidity: '2000', uid: 1 }])).rejects.toThrow(/Folder not granted/);
    await expect(gateway.moveMessages(grant, [{ path: 'Sent Messages', uidValidity: '1800', uid: 1 }])).rejects.toThrow(/Folder not granted/);
    expect(server.moves).toEqual([]);
  });
});

describe('set_message_flags', () => {
  beforeEach(() => setup());

  it('marks mails as read and flagged, reports the previous state, and sends only STORE with \\Seen/\\Flagged', async () => {
    const r = await flagger.set([await item('INBOX', 'Payment October'), await item('INBOX', 'Urgent', 'boss@company.example')], { read: true, flagged: true });
    expect(r.count).toBe(2);
    expect(r.messages.map((m) => m.before)).toEqual([{ read: false, flagged: false }, { read: false, flagged: false }]);
    expect(flagsOf('INBOX', 'Payment October')).toEqual(['\\Flagged', '\\Seen']);
    expect(flagsOf('INBOX', 'Newsletter')).toEqual(['\\Seen']); // untouched
    const stores = server.stores.flatMap((s) => s.flags);
    expect(new Set(stores)).toEqual(new Set(['\\Seen', '\\Flagged']));
    expect(server.violations).toEqual([]);
    expect(dangerous()).toEqual([]);
    expect(server.commands.some((c) => /\bUID MOVE\b/.test(c))).toBe(false);
  });

  it('marks as unread and removes the flag again, leaving other flags alone', async () => {
    await flagger.set([await item('Drafts', 'A draft')], { read: false });
    expect(flagsOf('Drafts', 'A draft')).toEqual(['\\Draft']); // \Draft stays
    await flagger.set([await item('INBOX', 'Newsletter', 'news@shop.example')], { flagged: true });
    await flagger.set([await item('INBOX', 'Newsletter', 'news@shop.example')], { flagged: false });
    expect(flagsOf('INBOX', 'Newsletter')).toEqual(['\\Seen']);
    expect(server.stores.map((s) => `${s.op}${s.flags.join()}`)).toEqual(['-\\Seen', '+\\Flagged', '-\\Flagged']);
  });

  it('changes nothing when one mail does not match, or nothing is asked for, or too many are given', async () => {
    const ok = await item('INBOX', 'Payment October');
    await expect(flagger.set([ok, { ...(await item('INBOX', 'Urgent')), subject: 'Other' }], { read: true })).rejects.toThrow(/Nothing was changed/);
    await expect(flagger.set([ok], {})).rejects.toThrow(/Nothing to change/);
    await expect(flagger.set(Array.from({ length: 51 }, () => ok), { read: true })).rejects.toThrow(/Too many/);
    expect(setMessageFlagsSchema.safeParse({ messages: Array.from({ length: 51 }, () => ok), read: true }).success).toBe(false);
    expect(setMessageFlagsSchema.safeParse({ messages: [ok], read: true, deleted: true }).success).toBe(false);
    expect(server.stores).toEqual([]);
    expect(flagsOf('INBOX', 'Payment October')).toEqual([]);
  });

  it('reading tools afterwards still only use EXAMINE and BODY.PEEK', async () => {
    await flagger.set([await item('INBOX', 'Payment October')], { read: true });
    server.commands.length = 0;
    await mail.listRecent('inbox', 5);
    await mail.search({ subject: 'Payment' });
    await mail.getMessage(await idOf('INBOX', 'Payment October'));
    expect(server.commands.filter((c) => /^(UID )?(SELECT|STORE|COPY|MOVE|APPEND|EXPUNGE)\b/.test(c))).toEqual([]);
  });

  it('forged flag grants are refused', async () => {
    const { decodeRef } = await import('../src/core/mail/ref.js');
    const m = (await mail.listRecent('inbox', 5)).messages[0]!;
    await expect(gateway.setFlags({ sources: new Set(['INBOX']), count: 1, add: ['\\Deleted'], remove: [] } as never, [decodeRef(m.id)])).rejects.toThrow(/without a grant/);
    expect(server.stores).toEqual([]);
  });
});
