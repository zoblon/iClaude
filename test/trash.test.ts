import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapGateway, type ImapLike } from '../src/core/mail/imap.js';
import { MailService } from '../src/core/mail/service.js';
import { senderMatches } from '../src/core/mail/trash.js';
import { TrashService } from '../src/core/mail/trash.js';
import { decodeRef } from '../src/core/mail/ref.js';
import { authorizeTrash, MAX_TRASH_PER_CALL, TrashGrant } from '../src/core/permissions.js';
import { registerTrashTools, trashMessageSchema } from '../src/mcp/trashTools.js';
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

/** The test world: the Trash deliberately has an unusual name here, but carries the \Trash attribute. */
const boxes = (over: Record<string, MiniBox> = {}): Record<string, MiniBox> => ({
  INBOX: { uidValidity: 1700, messages: [msg(1, [], 'Payment October', 'a1@x'), msg(2, ['\\Seen'], 'Newsletter', 'a2@x', 'Shop <news@shop.example>'), msg(3, [], 'Urgent', 'a3@x', 'Boss <boss@company.example>')] },
  'Sent Messages': { special: '\\Sent', uidValidity: 1800, messages: [msg(1, ['\\Seen'], 'Sent', 's1@x')] },
  Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] },
  Archive: { special: '\\Archive', uidValidity: 2000, messages: [msg(1, ['\\Seen'], 'Archived', 'r1@x'), msg(2, [], 'Older one', 'r2@x')] },
  Binned: { special: '\\Trash', uidValidity: 2100, messages: [msg(1, ['\\Seen'], 'Trashed earlier', 't1@x')] },
  ...over,
});

let server: MiniImap;
let gateway: ImapGateway;
let mail: MailService;
let trash: TrashService;

async function setup(opts: { move?: boolean; advertiseMove?: boolean; boxes?: Record<string, MiniBox>; allowMoveTo?: string[] } = {}) {
  server = new MiniImap(opts.boxes ?? boxes(), { move: opts.move ?? true, ...(opts.advertiseMove !== undefined ? { advertiseMove: opts.advertiseMove } : {}) });
  for (const b of ['INBOX', 'Archive', 'Sent Messages', 'Drafts']) server.allowWriteSelect.add(b);
  for (const d of opts.allowMoveTo ?? ['Binned']) server.allowMove.add(d);
  await server.start();
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  mail = new MailService(cfg, gateway);
  trash = new TrashService(gateway, () => mail.mailboxes());
}

afterEach(async () => {
  await gateway?.close();
  await server?.stop();
});

const idOf = async (mailbox: string, subject: string) => {
  const r = await mail.listRecent(mailbox, 20);
  return r.messages.find((m) => m.subject === subject)!.id;
};
const item = async (mailbox: string, subject: string, from = 'anna@example.com') => ({ id: await idOf(mailbox, subject), subject, from });
const subjects = (box: string) => server.boxes[box]!.messages.map((m) => m.subject).sort();
const sent = () => server.commands.map((c) => c.split(' ').slice(0, 3).join(' '));
const dangerous = () => server.commands.filter((c) => /\\Deleted|\bEXPUNGE\b|\bSTORE\b|\bCOPY\b|\bAPPEND\b|\bDELETE\b|\bCREATE\b|\bRENAME\b/i.test(c));

describe('trash_message: moving to the Trash (real imapflow against the test server)', () => {
  beforeEach(() => setup());

  it('moves via UID MOVE into the Trash, which it recognises by the \\Trash attribute (not by name)', async () => {
    const r = await trash.trash([await item('INBOX', 'Payment October')]);
    expect(r.trashMailbox).toBe('Binned');
    expect(r.count).toBe(1);
    expect(r.moved[0]).toMatchObject({ mailbox: 'INBOX', subject: 'Payment October' });
    expect(subjects('INBOX')).toEqual(['Newsletter', 'Urgent']);
    expect(subjects('Binned')).toEqual(['Payment October', 'Trashed earlier']);
    expect(server.moves).toEqual([{ from: 'INBOX', to: 'Binned', uids: [1] }]);
    expect(sent().some((c) => c.startsWith('UID MOVE'))).toBe(true);
    expect(server.violations).toEqual([]);
  });

  it('never \\Deleted, EXPUNGE, STORE, COPY, APPEND, DELETE or CREATE on the wire', async () => {
    await trash.trash([await item('INBOX', 'Payment October'), await item('INBOX', 'Newsletter', 'news@shop.example')]);
    await trash.trash([await item('Archive', 'Archived')]);
    expect(dangerous()).toEqual([]);
    expect(server.violations).toEqual([]);
    // There were only read commands, SELECT/EXAMINE and the MOVE commands.
    for (const c of server.commands) expect(c, c).toMatch(/^(CAPABILITY|LOGIN|LIST|LSUB|STATUS|SELECT|EXAMINE|CLOSE|UNSELECT|NOOP|LOGOUT|ID|UID FETCH|FETCH|UID SEARCH|SEARCH|UID MOVE|ENABLE|NAMESPACE)\b/);
  });

  it('the result names what was moved and that it can be restored for about 30 days', async () => {
    const r = await trash.trash([await item('INBOX', 'Newsletter', 'Shop <news@shop.example>')]);
    expect(r.note).toMatch(/about 30 days/);
    expect(r.note).toMatch(/can be restored/);
    expect(r.moved.map((m) => m.subject)).toEqual(['Newsletter']);
  });

  it('the tool result summarises it', async () => {
    const tools: Record<string, { description: string; annotations: Record<string, boolean>; handler: (a: unknown) => Promise<{ structuredContent: { summary: string; notes: string[] } }> }> = {};
    registerTrashTools({ registerTool: (n: string, c: { description: string; annotations: Record<string, boolean> }, h: never) => (tools[n] = { ...c, handler: h }) } as never, trash);
    const res = await tools['trash_message']!.handler({ messages: [await item('INBOX', 'Urgent', 'boss@company.example')] });
    expect(res.structuredContent.summary).toBe('1 mail(s) moved to the Trash.');
    expect(res.structuredContent.notes.join(' ')).toMatch(/30 days/);
  });

  it('the inbox is opened read-only for the check; nothing is marked as read', async () => {
    const before = server.boxes['INBOX']!.messages.find((m) => m.subject === 'Urgent')!.flags.slice();
    await trash.trash([await item('INBOX', 'Urgent', 'boss@company.example')]);
    const moved = server.boxes['Binned']!.messages.find((m) => m.subject === 'Urgent')!;
    expect(moved.flags).toEqual(before); // unread stays unread
    expect(server.commands.filter((c) => /^(UID )?FETCH/.test(c)).every((c) => !/BODY\[|RFC822(?![.\w])/.test(c.replace(/BODY\.PEEK\[[^\]]*\]/g, '')))).toBe(true);
  });

  it('several mails from several folders in one call', async () => {
    const r = await trash.trash([await item('INBOX', 'Payment October'), await item('Archive', 'Archived'), await item('INBOX', 'Urgent', 'boss@company.example')]);
    expect(r.count).toBe(3);
    expect(subjects('INBOX')).toEqual(['Newsletter']);
    expect(subjects('Archive')).toEqual(['Older one']);
    expect(subjects('Binned')).toEqual(['Archived', 'Payment October', 'Trashed earlier', 'Urgent']);
    expect(dangerous()).toEqual([]);
  });

  describe('Rejections: nothing is moved', () => {
    const untouched = () => {
      expect(subjects('INBOX')).toEqual(['Newsletter', 'Payment October', 'Urgent']);
      expect(subjects('Binned')).toEqual(['Trashed earlier']);
      expect(server.moves).toEqual([]);
      expect(sent().filter((c) => c.startsWith('UID MOVE') || c.startsWith('MOVE'))).toEqual([]);
      expect(dangerous()).toEqual([]);
      expect(server.violations).toEqual([]);
    };

    it('wrong subject', async () => {
      const i = await item('INBOX', 'Payment October');
      await expect(trash.trash([{ ...i, subject: 'Something else entirely' }])).rejects.toThrow(/Message 1: the subject does not match/);
      untouched();
    });

    it('wrong sender (address, name)', async () => {
      const i = await item('INBOX', 'Payment October');
      await expect(trash.trash([{ ...i, from: 'evil@example.com' }])).rejects.toThrow(/Message 1: the sender does not match/);
      await expect(trash.trash([{ ...i, from: 'John Doe' }])).rejects.toThrow(/sender does not match/);
      await expect(trash.trash([{ ...i, from: 'Anna Example <anna@wrong.example>' }])).rejects.toThrow(/sender does not match/);
      untouched();
    });

    it('if only one of several mails does not match, not a single one is moved', async () => {
      const good = await item('INBOX', 'Payment October');
      const bad = { ...(await item('INBOX', 'Newsletter', 'news@shop.example')), subject: 'Wrong' };
      await expect(trash.trash([good, bad])).rejects.toThrow(/Message 2: the subject does not match/);
      untouched();
    });

    it('names all errors at once without revealing mail contents', async () => {
      const a = { ...(await item('INBOX', 'Payment October')), subject: 'x', from: 'y@z.de' };
      const e = await trash.trash([a]).catch((x: Error) => x);
      expect((e as Error).message).toMatch(/Message 1: the subject does not match.*Message 1: the sender does not match/s);
      expect((e as Error).message).not.toContain('Payment');
      expect((e as Error).message).not.toContain('anna@example.com');
    });

    it('more than 20 mails (service), before anything is loaded', async () => {
      const i = await item('INBOX', 'Payment October');
      const many = Array.from({ length: MAX_TRASH_PER_CALL + 1 }, (_, n) => ({ ...i, id: i.id.replace(/\|1$/, `|${n + 100}`) }));
      server.commands.length = 0;
      await expect(trash.trash(many)).rejects.toThrow(/Too many messages.*21.*at most 20/s);
      expect(server.commands).toEqual([]);
      untouched();
    });

    it('more than 20 mails (tool schema) and empty list', () => {
      const one = { id: 'INBOX|1700|1', subject: 's', from: 'f' };
      expect(trashMessageSchema.safeParse({ messages: Array.from({ length: 20 }, () => one) }).success).toBe(true);
      expect(trashMessageSchema.safeParse({ messages: Array.from({ length: 21 }, () => one) }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [] }).success).toBe(false);
    });

    it('the permission itself rejects more than 20', () => {
      const mailboxes = [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }, { path: 'T', name: 'T', role: 'trash', roleBy: 'flag' as const }];
      expect(() => authorizeTrash({ mailboxes, sourcePaths: Array.from({ length: 21 }, () => 'INBOX') })).toThrow(/at most 20/);
      expect(authorizeTrash({ mailboxes, sourcePaths: Array.from({ length: 20 }, () => 'INBOX') }).count).toBe(20);
    });

    it('required fields: subject and sender missing or empty', async () => {
      const i = await item('INBOX', 'Payment October');
      expect(trashMessageSchema.safeParse({ messages: [{ id: i.id }] }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ id: i.id, subject: 'x' }] }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ id: i.id, subject: '', from: 'x' }] }).success).toBe(false);
      await expect(trash.trash([{ ...i, subject: '  ' }])).rejects.toThrow(/the subject does not match/);
      await expect(trash.trash([{ ...i, from: '  ' }])).rejects.toThrow(/the sender does not match/);
      untouched();
    });

    it('unknown fields in the schema', () => {
      const ok = { id: 'INBOX|1700|1', subject: 's', from: 'f' };
      expect(trashMessageSchema.safeParse({ messages: [ok], permanent: true }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ ...ok, folder: 'Archive' }] }).success).toBe(false);
      expect(trashMessageSchema.safeParse({ messages: [{ ...ok, destination: 'Archive' }] }).success).toBe(false);
    });

    it('the same mail twice', async () => {
      const i = await item('INBOX', 'Payment October');
      await expect(trash.trash([i, i])).rejects.toThrow(/more than once/);
      untouched();
    });

    it('mails already in the Trash are never touched', async () => {
      const inTrash = await item('Binned', 'Trashed earlier');
      await expect(trash.trash([inTrash])).rejects.toThrow(/already in the Trash/);
      untouched();
    });

    it('stale ID (UIDVALIDITY changed)', async () => {
      const i = await item('INBOX', 'Payment October');
      await expect(trash.trash([{ ...i, id: i.id.replace('|1700|', '|999|') }])).rejects.toThrow(/stale/);
      untouched();
    });

    it('mail no longer exists', async () => {
      const i = await item('INBOX', 'Payment October');
      await expect(trash.trash([{ ...i, id: i.id.replace(/\|1$/, '|77') }])).rejects.toThrow(/not found/);
      untouched();
    });

    it.each(['', 'x', 'INBOX|1|', 'INBOX|a|1', '../../etc|1|1|2'])('invalid ID "%s"', async (id) => {
      await expect(trash.trash([{ id, subject: 's', from: 'f' }])).rejects.toThrow(/Invalid message ID/);
      untouched();
    });

    it('unknown folder in the ID', async () => {
      await expect(trash.trash([{ id: 'DoesNotExist|1|1', subject: 's', from: 'f' }])).rejects.toThrow(/folder of a message is unknown/);
      untouched();
    });

    it('the gateway itself rejects forged or too broad grants', async () => {
      const i = await item('INBOX', 'Payment October');
      const ref = decodeRef(i.id);
      await expect(gateway.moveToTrash({ trash: 'Binned', sources: new Set(['INBOX']), count: 1 } as never, [ref])).rejects.toThrow(/without a grant/);
      const grant = TrashGrant.issue('Binned', ['Archive'], 1); // the inbox is not granted
      await expect(gateway.moveToTrash(grant, [ref])).rejects.toThrow();
      await expect(gateway.moveToTrash(TrashGrant.issue('Binned', ['INBOX'], 1), [ref, ref])).rejects.toThrow(); // more than granted
      await expect(gateway.moveToTrash(TrashGrant.issue('Binned', ['INBOX', 'Binned'], 1), [{ ...ref, path: 'Binned' }])).rejects.toThrow();
      untouched();
    });
  });

  it('the move target is fixed: any other target folder is a violation in the test server', async () => {
    // Counter-check: if the target folder were not allowed, the test server would have recorded the MOVE as a violation.
    await gateway.close();
    await server.stop();
    await setup({ allowMoveTo: [] });
    await expect(trash.trash([await item('INBOX', 'Payment October')])).rejects.toThrow();
    expect(server.violations.some((v) => v.includes('MOVE'))).toBe(true);
  });
});

describe('trash_message: Trash only via the \\Trash attribute', () => {
  it('a folder named "Trash" without the attribute is not the Trash: nothing is moved', async () => {
    const b = boxes();
    delete b['Binned'];
    b['Trash'] = { uidValidity: 2100, messages: [] }; // named like a Trash folder, but carries no attribute
    await setup({ boxes: b, allowMoveTo: ['Trash'] });
    await expect(trash.trash([await item('INBOX', 'Payment October')])).rejects.toThrow(/\\Trash attribute/);
    expect(server.moves).toEqual([]);
    expect(server.commands.filter((c) => /MOVE/.test(c))).toEqual([]);
    expect(subjects('INBOX')).toContain('Payment October');
  });

  it('a folder with the attribute is used even if a "Trash" folder without the attribute exists', async () => {
    const b = boxes({ Trash: { uidValidity: 2200, messages: [] } });
    await setup({ boxes: b, allowMoveTo: ['Binned', 'Trash'] });
    await trash.trash([await item('INBOX', 'Payment October')]);
    expect(server.moves.map((m) => m.to)).toEqual(['Binned']);
    expect(subjects('Trash')).toEqual([]);
  });

  it('two folders with the attribute: ambiguous, nothing is moved', async () => {
    await setup({ boxes: boxes({ Second: { special: '\\Trash', uidValidity: 2300, messages: [] } }), allowMoveTo: ['Binned', 'Second'] });
    await expect(trash.trash([await item('INBOX', 'Payment October')])).rejects.toThrow(/ambiguous/);
    expect(server.moves).toEqual([]);
  });

  it('the usual iCloud name "Deleted Messages" with the attribute works', async () => {
    const b = boxes();
    delete b['Binned'];
    b['Deleted Messages'] = { special: '\\Trash', uidValidity: 2100, messages: [] };
    await setup({ boxes: b, allowMoveTo: ['Deleted Messages'] });
    const r = await trash.trash([await item('INBOX', 'Payment October')]);
    expect(r.trashMailbox).toBe('Deleted Messages');
    expect(subjects('Deleted Messages')).toEqual(['Payment October']);
  });
});

describe('trash_message: like iCloud (understands UID MOVE but does not list it in its capabilities)', () => {
  beforeEach(() => setup({ move: true, advertiseMove: false }));

  it('still moves, without ever falling back to the delete flag, COPY or EXPUNGE', async () => {
    expect(server.commands.some((c) => /^CAPABILITY/.test(c) && /\bMOVE\b/.test(c))).toBe(false);
    const r = await trash.trash([await item('INBOX', 'Payment October'), await item('Archive', 'Archived')]);
    expect(r.count).toBe(2);
    expect(subjects('Binned')).toEqual(['Archived', 'Payment October', 'Trashed earlier']);
    expect(server.commands.filter((c) => c.startsWith('UID MOVE'))).toHaveLength(2);
    expect(dangerous()).toEqual([]);
    expect(server.violations).toEqual([]);
  });
});

describe('trash_message: server that does not understand UID MOVE (no fallback to delete flag and EXPUNGE)', () => {
  beforeEach(() => setup({ move: false }));

  it('refuses without changing anything or even sending a modifying command', async () => {
    await expect(trash.trash([await item('INBOX', 'Payment October')])).rejects.toThrow(/rejected the move to the Trash \(UID MOVE\).*Nothing was moved and nothing was deleted/s);
    expect(subjects('INBOX')).toEqual(['Newsletter', 'Payment October', 'Urgent']);
    expect(subjects('Binned')).toEqual(['Trashed earlier']);
    // imapflow.messageMove would have sent COPY, STORE \Deleted and EXPUNGE here on its own. None of that was sent.
    expect(server.rejectedMoves).toHaveLength(1);
    expect(dangerous()).toEqual([]);
    expect(server.violations).toEqual([]);
  });

  it('also with several mails from several folders: nothing happens, and there is only a single attempt', async () => {
    await expect(trash.trash([await item('INBOX', 'Urgent', 'boss@company.example'), await item('Archive', 'Archived')])).rejects.toThrow(/rejected/);
    expect(dangerous()).toEqual([]);
    expect(server.rejectedMoves).toHaveLength(1); // no further attempts after the first rejection
    expect(subjects('Archive')).toEqual(['Archived', 'Older one']);
    expect(subjects('INBOX')).toEqual(['Newsletter', 'Payment October', 'Urgent']);
  });
});

describe('Helper functions for the check', () => {
  const from = [{ name: 'Anna Example', address: 'anna@example.com' }];
  it.each([
    ['anna@example.com', true],
    ['ANNA@Example.COM', true],
    ['Anna Example <anna@example.com>', true],
    ['Wrong Name <anna@example.com>', true], // the address decides
    ['Anna Example', true],
    ['  anna   example ', true],
    ['anna', false],
    ['example.com', false],
    ['anna@example.com.evil.com', false],
    ['xanna@example.com', false],
    ['Anna Example <evil@example.com>', false],
    ['evil@example.com', false],
    ['', false],
  ])('sender "%s" matches: %s', (expected, ok) => {
    expect(senderMatches(expected, from)).toBe(ok);
  });
  it('a mail without sender information can never be confirmed', () => {
    expect(senderMatches('anna@example.com', [])).toBe(false);
    expect(senderMatches('Anna', [{ address: 'anna@example.com' }])).toBe(false);
  });
});

describe('Tool trash_message', () => {
  it('is marked as destructive, not read-only, and clearly describes what happens and what does not', async () => {
    await setup();
    const tools: Record<string, { description: string; annotations: Record<string, boolean> }> = {};
    registerTrashTools({ registerTool: (n: string, c: never) => (tools[n] = c) } as never, trash);
    const t = tools['trash_message']!;
    expect(t.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(t.description).toMatch(/Moves one or more emails \(max 20 per call\) into the Trash/);
    expect(t.description).toMatch(/\\Trash attribute/);
    expect(t.description).toMatch(/Does NOT delete permanently/);
    expect(t.description).toMatch(/nothing is flagged \\Deleted or expunged/);
    expect(t.description).toMatch(/30 days/);
    expect(t.description).toMatch(/id, subject and sender/);
    expect(t.description).toMatch(/moves NOTHING if any mail does not match/);
  });
});
