import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CalDavGateway, classifyCalendar } from '../src/core/calendar/caldav.js';
import { CalendarWriteService } from '../src/core/calendar/writeService.js';
import { calendars, cfg, ev, FakeStore } from './fakeStore.js';
import { createEventSchema, updateEventSchema } from '../src/mcp/writeTools.js';
import { ALLOWED_STORE_FLAGS, authorizeFlags, FlagGrant } from '../src/core/permissions.js';

let store: FakeStore;
let svc: CalendarWriteService;
beforeEach(() => {
  store = new FakeStore();
  svc = new CalendarWriteService(cfg, store);
});

const base = { title: 'Test', start: '2026-10-20T14:00:00' };

describe('Creating: shared calendars only when explicitly named', () => {
  it('writes to the private default calendar when no calendar is given', async () => {
    const r = await svc.createEvent(base);
    expect(r.calendar).toBe('MCP-Test');
    expect(r.shared).toBe(false);
    expect(store.creates).toBe(1);
    expect([...store.objects.keys()][0]).toContain('/priv/');
  });

  it('refuses a shared calendar via "calendar" and names the right way', async () => {
    await expect(svc.createEvent({ ...base, calendar: 'Shared' })).rejects.toThrow(/is a shared calendar.*shared_calendar="Shared"/s);
    expect(store.creates).toBe(0);
  });

  it('also refuses case variants via "calendar"', async () => {
    await expect(svc.createEvent({ ...base, calendar: 'shared' })).rejects.toThrow(/is a shared calendar/);
    expect(store.creates).toBe(0);
  });

  it('writes to the shared calendar only with shared_calendar', async () => {
    const r = await svc.createEvent({ ...base, sharedCalendar: 'Shared' });
    expect(r.calendar).toBe('Shared');
    expect(r.shared).toBe(true);
    expect(store.creates).toBe(1);
  });

  it('refuses shared_calendar for a private calendar', async () => {
    await expect(svc.createEvent({ ...base, sharedCalendar: 'MCP-Test' })).rejects.toThrow(/is not a shared calendar/);
    expect(store.creates).toBe(0);
  });

  it('refuses calendar and shared_calendar together', async () => {
    await expect(svc.createEvent({ ...base, calendar: 'MCP-Test', sharedCalendar: 'Shared' })).rejects.toThrow(/only one of/);
    expect(store.creates).toBe(0);
  });

  it('refuses when the default calendar is a shared calendar', async () => {
    const s = new CalendarWriteService({ ...cfg, defaultCalendar: 'Shared' }, store);
    await expect(s.createEvent(base)).rejects.toThrow(/default calendar must not be shared/);
    expect(store.creates).toBe(0);
  });

  it('writes nowhere when neither a calendar nor a default calendar is known', async () => {
    const s = new CalendarWriteService({ ...cfg, defaultCalendar: undefined }, store);
    await expect(s.createEvent(base)).rejects.toThrow(/No calendar specified/);
    expect(store.creates).toBe(0);
  });

  it.each([
    ['Holidays', /subscribed/],
    ['Read only', /read-only/],
    ['Family', /tasks list/],
    ['DoesNotExist', /not found/],
  ])('refuses "%s"', async (name, msg) => {
    await expect(svc.createEvent({ ...base, calendar: name })).rejects.toThrow(msg);
    await expect(svc.createEvent({ ...base, sharedCalendar: name })).rejects.toThrow();
    expect(store.creates).toBe(0);
  });
});

describe('No invitations', () => {
  it('schema accepts no attendee or organizer fields', () => {
    const ok = createEventSchema.safeParse({ title: 'x', start: '2026-10-20T14:00:00' });
    expect(ok.success).toBe(true);
    for (const field of ['attendees', 'attendee', 'organizer', 'invitees', 'method']) {
      const r = createEventSchema.safeParse({ title: 'x', start: '2026-10-20T14:00:00', [field]: ['a@b.de'] });
      expect(r.success, field).toBe(false);
      const u = updateEventSchema.safeParse({ id: '/u/calendars/priv/a.ics', title: 'x', [field]: ['a@b.de'] });
      expect(u.success, field).toBe(false);
    }
  });

  it('attendees injected via text fields do not end up in the event', async () => {
    const evil = 'Hi\r\nATTENDEE;CN=X:mailto:victim@example.com\r\nORGANIZER:mailto:x@example.com';
    await svc.createEvent({ ...base, title: evil, location: evil, notes: evil });
    const data = [...store.objects.values()][0]!.data;
    expect(data).not.toMatch(/^ATTENDEE/m);
    expect(data).not.toMatch(/^ORGANIZER/m);
    expect(data).not.toMatch(/^METHOD/m);
  });
});

describe('Updating', () => {
  it('updates an own event, keeps unknown properties and changes the ETag', async () => {
    const id = store.put('priv', 'a', ev('A'));
    const before = [...store.objects.values()][0]!;
    const r = await svc.updateEvent({ id, etag: before.etag!, title: 'New title' });
    expect(r.event.title).toBe('New title');
    const after = [...store.objects.values()][0]!;
    expect(after.etag).not.toBe(before.etag);
    expect(after.data).toContain('X-APPLE-STRUCTURED-LOCATION');
    expect(after.data).toContain('X-MY-EXTENSION:important');
    expect(after.data).toContain('DTSTART;TZID=Europe/Berlin:20261021T100000');
  });

  it('loads the complete event via GET before every change and uses no query copy', async () => {
    const id = store.put('priv', 'a', ev('A'));
    store.gets = 0;
    store.queries = 0;
    await svc.updateEvent({ id, title: 'New' });
    expect(store.gets).toBeGreaterThanOrEqual(1);
    expect(store.queries).toBe(0);
    // The partial copy from a query would have lost the X- properties; the complete original was written.
    const stored = [...store.objects.values()][0]!.data;
    expect(stored).toContain('X-MY-EXTENSION:important');
    expect(stored).toContain('X-APPLE-STRUCTURED-LOCATION');
  });

  it('increments SEQUENCE by one and sets LAST-MODIFIED anew', async () => {
    const id = store.put('priv', 'a', ev('A')); // SEQUENCE:1, no LAST-MODIFIED
    const before = Date.now();
    await svc.updateEvent({ id, title: 'New' });
    const stored = [...store.objects.values()][0]!.data;
    expect(stored).toMatch(/^SEQUENCE:2$/m);
    const m = /^LAST-MODIFIED:(\d{8}T\d{6}Z)$/m.exec(stored);
    expect(m).not.toBeNull();
    const t = Date.parse(m![1]!.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'));
    expect(t).toBeGreaterThanOrEqual(before - 2000);
    expect(t).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it('moves with only "start" and keeps the duration (90 minutes)', async () => {
    const id = store.put('priv', 'a', ev('A'));
    const r = await svc.updateEvent({ id, start: '2026-10-22T09:00:00' });
    expect(r.event.start).toBe('2026-10-22T09:00:00+02:00');
    expect(r.event.end).toBe('2026-10-22T10:30:00+02:00');
  });

  it('refuses events with attendees and changes nothing', async () => {
    const id = store.put('priv', 'a', ev('A', 'ATTENDEE;CN=X:mailto:x@example.com\r\nORGANIZER:mailto:me@example.com'));
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/attendees/);
    expect(store.updates).toBe(0);
  });

  it('refuses events organized by someone else, allows own ones', async () => {
    const foreign = store.put('priv', 'f', ev('F', 'ORGANIZER:mailto:boss@company.example'));
    await expect(svc.updateEvent({ id: foreign, title: 'x' })).rejects.toThrow(/organized by another person/);
    expect(store.updates).toBe(0);
    const own = store.put('priv', 'o', ev('O', 'ORGANIZER:mailto:ME@example.com'));
    await expect(svc.updateEvent({ id: own, title: 'x' })).resolves.toBeTruthy();
    expect(store.updates).toBe(1);
  });

  it('requires explicit naming for events in shared calendars', async () => {
    const id = store.put('shared', 's', ev('S'));
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/shared_calendar="Shared"/);
    await expect(svc.updateEvent({ id, title: 'x', sharedCalendar: 'Events' })).rejects.toThrow(/shared_calendar="Shared"/);
    expect(store.updates).toBe(0);
    const r = await svc.updateEvent({ id, title: 'x', sharedCalendar: 'Shared' });
    expect(r.shared).toBe(true);
    expect(store.updates).toBe(1);
  });

  it('refuses shared_calendar for a private event', async () => {
    const id = store.put('priv', 'a', ev('A'));
    await expect(svc.updateEvent({ id, title: 'x', sharedCalendar: 'Shared' })).rejects.toThrow(/is not a shared calendar/);
  });

  it('refuses changes to single occurrences, allows the whole series', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5'));
    await expect(svc.updateEvent({ id, title: 'x', occurrenceStart: '2026-10-28T10:00:00+01:00' })).rejects.toThrow(/single occurrences/);
    expect(store.updates).toBe(0);
    const r = await svc.updateEvent({ id, title: 'Whole series' });
    expect(r.event.recurring).toBe(true);
    expect(store.updates).toBe(1);
  });

  it('does not change the time of a series with exceptions, but does change the title', async () => {
    const id = store.put('priv', 'r', ev('R', 'RRULE:FREQ=WEEKLY;COUNT=5\r\nEXDATE;TZID=Europe/Berlin:20261028T100000'));
    await expect(svc.updateEvent({ id, start: '2026-10-22T09:00:00' })).rejects.toThrow(/exceptions/);
    expect(store.updates).toBe(0);
    await expect(svc.updateEvent({ id, title: 'ok' })).resolves.toBeTruthy();
  });

  it('refuses when the given ETag no longer matches', async () => {
    const id = store.put('priv', 'a', ev('A'));
    await expect(svc.updateEvent({ id, etag: '"old"', title: 'x' })).rejects.toThrow(/changed since it was fetched/);
    expect(store.updates).toBe(0);
  });

  it('accepts the ETag without quotes or with W/, but refuses others', async () => {
    const id = store.put('priv', 'a', ev('A'));
    const etag = [...store.objects.values()][0]!.etag!; // e.g. "e1" with quotes
    const bare = etag.replace(/"/g, '');
    await expect(svc.updateEvent({ id, etag: bare, title: 'one' })).resolves.toBeTruthy();
    const next = [...store.objects.values()][0]!.etag!;
    await expect(svc.updateEvent({ id, etag: `W/${next}`, title: 'two' })).resolves.toBeTruthy();
    await expect(svc.updateEvent({ id, etag: bare, title: 'three' })).rejects.toThrow(/changed since it was fetched/);
  });

  it('refuses when someone else changed the event between reading and writing', async () => {
    const id = store.put('priv', 'a', ev('A'));
    store.afterGet = (o) => {
      // A third party changes the event right after we read it
      store.objects.set(o.url, { ...o, etag: '"changed-by-third-party"' });
    };
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/changed in the meantime/);
    expect(store.updates).toBe(0);
  });

  it('does not write without an ETag', async () => {
    const id = store.put('priv', 'a', ev('A'));
    store.objects.set([...store.objects.keys()][0]!, { url: [...store.objects.keys()][0]!, data: ev('A') });
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/ETag/);
  });

  it.each([
    ['https://evil.example.com/u/calendars/priv/a.ics'],
    ['/u/calendars/priv/../shared/a.ics'],
    ['/u/calendars/priv/a.txt'],
    ['/other/calendars/x/a.ics'],
  ])('refuses the invalid ID %s', async (id) => {
    await expect(svc.updateEvent({ id, title: 'x' })).rejects.toThrow(/ID/);
    expect(store.updates).toBe(0);
  });

  it('requires at least one change', async () => {
    const id = store.put('priv', 'a', ev('A'));
    await expect(svc.updateEvent({ id })).rejects.toThrow(/No change specified/);
  });
});

describe('Detecting shared calendars (shared when in doubt)', () => {
  const me = '/123/principal/';
  it('private only with own owner and no sharing markers', () => {
    expect(classifyCalendar({ resourcetype: { calendar: {} }, owner: { href: me }, currentUserPrivilegeSet: { privilege: [{ write: {} }] } }, me)).toMatchObject({ shared: false, writable: true });
  });
  it.each([
    ['sharedOwner', { resourcetype: { calendar: {}, sharedOwner: {} }, owner: me }],
    ['shared', { resourcetype: { calendar: {}, shared: {} }, owner: me }],
    ['invite', { resourcetype: { calendar: {} }, owner: me, invite: {} }],
    ['sharedUrl', { resourcetype: { calendar: {} }, owner: me, sharedUrl: 'x' }],
    ['foreign owner', { resourcetype: { calendar: {} }, owner: '/999/principal/' }],
    ['no recognizable owner', { resourcetype: { calendar: {} } }],
  ])('%s counts as shared', (_n, props) => {
    expect(classifyCalendar(props, me).shared).toBe(true);
  });
  it('counts as shared when the own account is unknown', () => {
    expect(classifyCalendar({ resourcetype: { calendar: {} }, owner: me }, '').shared).toBe(true);
  });
  it('subscribed calendars are not writable', () => {
    expect(classifyCalendar({ resourcetype: { calendar: {}, subscribed: {} }, owner: me }, me).subscribed).toBe(true);
  });
});

describe('Writing only with a grant', () => {
  it('the real gateway refuses forged grants before anything is sent', async () => {
    const gw = new CalDavGateway(cfg);
    const forged = { op: 'create', calendar: calendars[0] } as never;
    await expect(gw.createObject(forged, 'ABCDEFGH-1234.ics', 'x')).rejects.toThrow(/without grant/);
    await expect(gw.updateObject({ op: 'update', calendar: calendars[0] } as never, { url: 'https://x/', etag: '"1"', data: 'x' })).rejects.toThrow(/without grant/);
  });
});

describe('Deleting, sending and moving in the code: only the two allowed paths', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = files('src').map((f) => ({ f: f.split('\\').join('/'), text: readFileSync(f, 'utf8') }));
  const code = src.map(({ f, text }) => ({ f, code: strip(text) }));

  it('only delete_event, trash_message, move_message and set_message_flags have delete/move/flag names; there is no other tool of this kind', () => {
    const names = src.flatMap(({ text }) => [...text.matchAll(/registerTool\(\s*'([^']+)'/g)].map((m) => m[1]!));
    expect(names).toEqual(expect.arrayContaining(['list_calendars', 'list_events', 'search_events', 'find_free_slots', 'create_event', 'update_event', 'search_contacts', 'get_contact', 'delete_event', 'trash_message']));
    const risky = names.filter((n) => /delete|remove|cancel|send|move|mark|flag|archive|trash|expunge|forward|reply/i.test(n));
    expect(risky.sort()).toEqual(['delete_event', 'move_message', 'set_message_flags', 'trash_message']);
  });

  it('forbidden functions appear nowhere in the code (no sending, no deleting contacts, no flags, no EXPUNGE, no COPY fallback)', () => {
    const forbidden = [
      /deleteCalendarObject/, /deleteVCard/, /\bcreateVCard\b/, /\bupdateVCard\b/,
      /createTransport/, /sendMail/, /from 'nodemailer'/, /smtp/i,
      /messageDelete/, /messageCopy/, /messageFlagsSet/, /\.setFlagColor/, /mailboxDelete/, /mailboxRename/, /\.expunge/i, /\bEXPUNGE\b/,
    ];
    for (const { f, code: c } of code) for (const re of forbidden) expect(c, `${f}: ${re}`).not.toMatch(re);
    // The \\Deleted flag only appears in the tool description ("does not set it"), never in the rest of the code.
    for (const { f, code: c } of code) if (f !== 'src/mcp/trashTools.ts') expect(c, `${f}: \\Deleted`).not.toMatch(/\\+Deleted/);
  });

  it('events are deleted only in the CalDAV gateway (a single DELETE) and only via deleteObject', () => {
    for (const { f, code: c } of code) {
      const allowedFile = f === 'src/core/calendar/caldav.ts';
      expect(/method:\s*'DELETE'/.test(c), `${f}: DELETE`).toBe(allowedFile);
      expect(/\bdeleteObject\b/.test(c), `${f}: deleteObject`).toBe(['src/core/calendar/caldav.ts', 'src/core/calendar/types.ts', 'src/core/calendar/writeService.ts'].includes(f));
      expect(/\.delete\(/.test(c), `${f}: .delete(`).toBe(false);
    }
    const caldav = code.find((x) => x.f === 'src/core/calendar/caldav.ts')!.code;
    expect(caldav.match(/method:\s*'DELETE'/g)).toHaveLength(1);
    // The only DELETE is in deleteObject, after the grant check.
    const body = caldav.slice(caldav.indexOf('async deleteObject'));
    expect(body.indexOf("WriteGrant.isValid(grant, 'delete')")).toBeGreaterThan(-1);
    expect(body.indexOf("WriteGrant.isValid(grant, 'delete')")).toBeLessThan(body.indexOf("method: 'DELETE'"));
  });

  it('mails are moved only in moveToTrash: direct UID MOVE, never imapflow.messageMove (its fallback would be COPY + deleted flag + EXPUNGE)', () => {
    for (const { f, code: c } of code) {
      expect(/messageMove/.test(c), `${f}: messageMove`).toBe(false);
      // Raw IMAP commands (exec('UPPERCASE', …)) exist only in imap.ts; RegExp.exec is something else.
      expect(/\bexec\(\s*'[A-Z]/.test(c), `${f}: exec with IMAP command`).toBe(f === 'src/core/mail/imap.ts');
    }
    const imap = code.find((x) => x.f === 'src/core/mail/imap.ts')!.code;
    expect([...imap.matchAll(/exec\(\s*'([A-Z][^']*)'/g)].map((m) => m[1])).toEqual(['UID MOVE']); // exactly one call
    // The single MOVE sits in the private uidMove, which only moveToTrash and moveMessages call, each after its own grant check.
    const move = imap.slice(imap.indexOf('private async uidMove'), imap.indexOf('async setFlags'));
    expect(move).toMatch(/w\.exec\(\s*'UID MOVE'/);
    expect(imap.indexOf("w.exec(")).toBeGreaterThan(imap.indexOf('private async uidMove'));
    expect(imap.indexOf("w.exec(")).toBeLessThan(imap.indexOf('async setFlags'));
    const calls = [...imap.matchAll(/this\.uidMove\(/g)].length;
    expect(calls).toBe(2);
    const trash = imap.slice(imap.indexOf('async moveToTrash'), imap.indexOf('async moveMessages'));
    expect(trash).toContain('TrashGrant.isValid(grant)');
    expect(trash.indexOf('TrashGrant.isValid(grant)')).toBeLessThan(trash.indexOf('this.uidMove('));
    const moveMsg = imap.slice(imap.indexOf('async moveMessages'), imap.indexOf('private async uidMove'));
    expect(moveMsg.indexOf('MoveGrant.isValid(grant)')).toBeGreaterThan(-1);
    expect(moveMsg.indexOf('MoveGrant.isValid(grant)')).toBeLessThan(moveMsg.indexOf('this.uidMove('));
    expect(imap).toContain('private async uidMove');
    // The narrow read interface has no mutating methods.
    const like = imap.slice(imap.indexOf('export interface ImapLike'), imap.indexOf('interface ImapAppend'));
    expect(like).not.toMatch(/messageMove|messageDelete|append|messageFlags|store\(|exec\(/);
  });

  it('STORE: only \\Seen and \\Flagged, only in setFlags, folder opened read-write only there', () => {
    expect([...ALLOWED_STORE_FLAGS]).toEqual(['\\Seen', '\\Flagged']);
    const imap = code.find((x) => x.f === 'src/core/mail/imap.ts')!.code;
    const setFlags = imap.slice(imap.indexOf('async setFlags'), imap.indexOf('async close'));
    const iface = imap.slice(imap.indexOf('interface ImapFlags'), imap.indexOf('export function defaultImapFactory'));
    const rest = imap.replace(setFlags, '').replace(iface, '');
    expect(rest, 'flag changes outside setFlags').not.toMatch(/messageFlags(Add|Remove|Set)|\bSTORE\b/);
    expect(setFlags.indexOf('FlagGrant.isValid(grant)')).toBeGreaterThan(-1);
    expect(setFlags.indexOf('FlagGrant.isValid(grant)')).toBeLessThan(setFlags.indexOf('messageFlagsAdd'));
    expect(setFlags).toContain('ALLOWED_STORE_FLAGS');
    expect(setFlags).not.toMatch(/Deleted|Draft|Answered|\$Junk|NotJunk/);
    // opening a folder read-write exists only for MOVE, STORE and nothing else
    expect([...imap.matchAll(/readOnly:\s*false/g)]).toHaveLength(4); // 2 in the interfaces, 2 calls (uidMove, setFlags)
    for (const { f, code: c } of code) if (f !== 'src/core/mail/imap.ts') expect(c, f).not.toMatch(/readOnly:\s*false|messageFlags(Add|Remove|Set)/);
  });

  it('a flag grant can never carry another flag', () => {
    const boxes = [{ path: 'INBOX', name: 'INBOX', role: 'inbox' }];
    for (const seen of [true, false, undefined]) for (const flagged of [true, false, undefined]) {
      if (seen === undefined && flagged === undefined) {
        expect(() => authorizeFlags({ mailboxes: boxes, sourcePaths: ['INBOX'], seen, flagged })).toThrow(/Nothing to change/);
        continue;
      }
      const g = authorizeFlags({ mailboxes: boxes, sourcePaths: ['INBOX'], seen, flagged });
      for (const f of [...g.add, ...g.remove]) expect(['\\Seen', '\\Flagged']).toContain(f);
    }
    expect(() => FlagGrant.issue(['INBOX'], 1, ['\\Deleted' as never], [])).toThrow();
  });

  it('files are removed only in the backup store', () => {
    for (const { f, code: c } of code) {
      expect(/\b(unlink|unlinkSync|rmdir|rmSync)\b|\brm\(/.test(c), `${f}: file removal`).toBe(f === 'src/core/calendar/backup.ts');
    }
  });

  it('the store interface has deleteObject as its only delete method', () => {
    const types = readFileSync('src/core/calendar/types.ts', 'utf8');
    const hits = [...strip(types).matchAll(/\b\w*(delete|remove)\w*\b/gi)].map((m) => m[0]);
    expect(hits).toEqual(['deleteObject']);
  });

  it('contacts: no DELETE on CardDAV, no tool or function to delete contacts or groups, no writes to group cards', () => {
    const carddav = code.find((x) => x.f === 'src/core/contacts/carddav.ts')!.code;
    expect(carddav).not.toMatch(/DELETE/);
    expect([...carddav.matchAll(/method:\s*'([A-Z]+)'|method:\s*init\.method/g)].length).toBeGreaterThan(0);
    expect(carddav).toMatch(/method: 'GET' \| 'PUT'/); // the only methods the contact sender accepts
    for (const { f, code: c } of code) {
      if (!f.includes('/contacts/') && f !== 'src/mcp/contactTools.ts') continue;
      expect(c, `${f}: delete`).not.toMatch(/deleteCard|deleteContact|removeContact|deleteGroup|\.delete\(|DELETE/);
    }
    // Writing goes through the grant; group cards are refused by the grant itself.
    const body = carddav.slice(carddav.indexOf('async createCard'));
    expect(body.indexOf("ContactWriteGrant.isValid(grant, 'create')")).toBeLessThan(body.indexOf("method: 'PUT'"));
    expect(body.indexOf("ContactWriteGrant.isValid(grant, 'update')")).toBeLessThan(body.lastIndexOf("method: 'PUT'"));
    const tools = src.find((x) => x.f === 'src/mcp/contactTools.ts')!.text;
    expect([...tools.matchAll(/registerTool\(\s*'([^']+)'/g)].map((m) => m[1])).toEqual([
      'search_contacts', 'get_contact', 'list_contact_groups', 'upcoming_contact_dates', 'create_contact', 'update_contact',
    ]);
  });

  it('contact tool annotations are accurate', () => {
    const tools = src.find((x) => x.f === 'src/mcp/contactTools.ts')!.text;
    const annot = (name: string) => tools.slice(tools.indexOf(`'${name}'`)).match(/annotations:\s*(READ_ONLY|\{[^}]*\})/)![1]!;
    for (const n of ['search_contacts', 'get_contact', 'list_contact_groups', 'upcoming_contact_dates']) expect(annot(n), n).toBe('READ_ONLY');
    expect(annot('create_contact')).toMatch(/readOnlyHint: false, destructiveHint: false/);
    expect(annot('update_contact')).toMatch(/readOnlyHint: false, destructiveHint: true/);
  });

  it('the mail read interface still has no mutating method', () => {
    const types = readFileSync('src/core/mail/types.ts', 'utf8');
    const reader = types.slice(types.indexOf('export interface MailReader'), types.indexOf('/** Draft storage'));
    expect(reader).not.toMatch(/delete|remove|move|trash|flag|store|append/i);
  });

  it('gateways refuse forged delete grants before anything is sent', async () => {
    const gw = new CalDavGateway(cfg);
    await expect(gw.deleteObject({ op: 'delete', calendar: calendars[0] } as never, { url: 'https://p1.example.com/u/calendars/priv/a.ics', etag: '"1"' })).rejects.toThrow(/without grant/);
    const update = { op: 'update', calendar: calendars[0] } as never;
    await expect(gw.deleteObject(update, { url: 'https://p1.example.com/u/calendars/priv/a.ics', etag: '"1"' })).rejects.toThrow(/without grant/);
  });
});
