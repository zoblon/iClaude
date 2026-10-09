import ICAL from 'ical.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import { InvitationImportService, planImport } from '../src/core/calendar/invitationImport.js';
import { ImapGateway, type ImapLike } from '../src/core/mail/imap.js';
import { MailService } from '../src/core/mail/service.js';
import { importInvitationSchema } from '../src/mcp/importTools.js';
import { cfg, ev, FakeStore } from './fakeStore.js';
import { multipartMessage } from './mimeFixture.js';
import { MiniImap } from './miniImap.js';

const Z = 'Europe/Berlin';
const CAL = (body: string, method = 'REQUEST', tz = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//EN\r\n${method ? `METHOD:${method}\r\n` : ''}${tz}${body}\r\nEND:VCALENDAR\r\n`;
const BERLIN_TZ = 'BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16011028T030000\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010325T020000\r\nRRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n';
const VEVENT = (extra = '', uid = 'invite-1@example.com') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T100000Z\r\nSEQUENCE:2\r\nDTSTART;TZID=Europe/Berlin:20261021T100000\r\nDTEND;TZID=Europe/Berlin:20261021T113000\r\nSUMMARY:Project kickoff\r\nLOCATION:Room 4\r\nDESCRIPTION:Agenda\\nand more\r\nORGANIZER;CN=Boss:mailto:boss@company.example\r\nATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@icloud.com\r\nATTENDEE;CN=Other:mailto:other@example.com\r\nX-MICROSOFT-CDO-BUSYSTATUS:BUSY\r\n${extra}END:VEVENT`;
const ALARM = 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:x\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:EMAIL\r\nDESCRIPTION:y\r\nTRIGGER;VALUE=DATE-TIME:20261020T080000Z\r\nEND:VALARM\r\n';

let server: MiniImap;
let gateway: ImapGateway;
let mail: MailService;
let store: FakeStore;
let importer: InvitationImportService;
let seq = 0;

/** A mail with the given .ics attachment; returns its ID and the attachment_id. */
async function mailWith(ics: string, over: { type?: string; filename?: string } = {}) {
  const uid = ++seq;
  server.boxes.INBOX!.messages.push(
    multipartMessage({ uid, subject: `Invite ${uid}`, messageId: `inv${uid}@x`, parts: [{ type: over.type ?? 'text/calendar', filename: over.filename ?? 'invite.ics', data: ics, charset: 'UTF-8' }] }),
  );
  const list = (await mail.listRecent('inbox', 50)).messages.find((m) => m.subject === `Invite ${uid}`)!;
  return { id: list.id, attachmentId: '2' };
}

beforeAll(async () => {
  server = new MiniImap({ INBOX: { uidValidity: 1700, messages: [] }, Drafts: { special: '\\Drafts', uidValidity: 1900, messages: [] } });
  await server.start();
  const factory = () =>
    new ImapFlow({ host: '127.0.0.1', port: server.port, secure: false, doSTARTTLS: false, auth: { user: 'u', pass: 'p' }, logger: false, disableAutoIdle: true }) as unknown as ImapLike;
  gateway = new ImapGateway(cfg, factory);
  mail = new MailService(cfg, gateway);
}, 30_000);
afterAll(async () => {
  await gateway.close();
  await server.stop();
});
beforeEach(() => {
  store = new FakeStore();
  importer = new InvitationImportService(cfg, gateway, store);
});

const objs = () => [...store.objects.values()];
const vevents = (data: string) => ICAL.Component.fromString(data).getAllSubcomponents('vevent');

describe('import_invitation', () => {
  it('creates a plain event of the user: title, time, location, description, reminders; no attendees, organizer or METHOD; organizer as text', async () => {
    const m = await mailWith(CAL(VEVENT(ALARM)));
    const r = await importer.import(m);
    expect(r.created).toBe(true);
    expect(r.calendar).toBe('MCP-Test');
    expect(r.event).toMatchObject({ title: 'Project kickoff', start: '2026-10-21T10:00:00+02:00', end: '2026-10-21T11:30:00+02:00', location: 'Room 4' });
    expect(r.event!.notes).toBe('Agenda\nand more\n\nOrganizer: Boss <boss@company.example>');
    expect(r.invitation).toMatchObject({ attendeesDropped: 2, organizer: { name: 'Boss', email: 'boss@company.example' } });
    expect(r.notes.join(' ')).toMatch(/No reply is sent.*|not part of the new event/);

    expect(objs()).toHaveLength(1);
    const data = objs()[0]!.data;
    expect(data).not.toMatch(/^(ATTENDEE|ORGANIZER|METHOD)/m);
    expect(data).not.toMatch(/X-MICROSOFT|mailto:/);
    expect(data).not.toMatch(/^UID:invite-1/m);
    expect(data).toMatch(/^X-ICLAUDE-SOURCE-UID:invite-1@example.com$/m);
    expect(data).toMatch(/^UID:[0-9A-F-]{36}$/m);
    expect(data).toMatch(/^SEQUENCE:0$/m);
    expect(vevents(data)[0]!.getAllSubcomponents('valarm')).toHaveLength(1); // the e-mail alarm with a fixed time is not taken over
    expect(r.notes.join(' ')).toMatch(/1 reminder/);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatch(/^create:priv\//);
  });

  it('sends nothing: no reply, no draft, no change in any mail folder', async () => {
    const before = server.appends.length;
    const flags = JSON.stringify(server.flagsSnapshot());
    server.commands.length = 0;
    await importer.import(await mailWith(CAL(VEVENT())));
    expect(server.appends.length).toBe(before);
    expect(server.violations).toEqual([]);
    expect(server.commands.filter((c) => /^(UID )?(STORE|COPY|MOVE|APPEND|SELECT|EXPUNGE)\b/.test(c))).toEqual([]);
    // flags: only the new test mail was added, the others did not change
    expect(Object.keys(JSON.parse(JSON.stringify(server.flagsSnapshot()))).length).toBe(Object.keys(JSON.parse(flags)).length);
  });

  it('takes over a series with a changed occurrence completely, under one new UID', async () => {
    const series = VEVENT('RRULE:FREQ=WEEKLY;COUNT=4\r\nEXDATE;TZID=Europe/Berlin:20261104T100000\r\n') +
      '\r\nBEGIN:VEVENT\r\nUID:invite-1@example.com\r\nDTSTAMP:20261001T100000Z\r\nRECURRENCE-ID;TZID=Europe/Berlin:20261028T100000\r\nDTSTART;TZID=Europe/Berlin:20261029T150000\r\nDTEND;TZID=Europe/Berlin:20261029T163000\r\nSUMMARY:Kickoff (moved)\r\nORGANIZER;CN=Boss:mailto:boss@company.example\r\nATTENDEE:mailto:me@icloud.com\r\nEND:VEVENT';
    const r = await importer.import(await mailWith(CAL(series)));
    expect(r.created).toBe(true);
    const data = objs()[0]!.data;
    const ve = vevents(data);
    expect(ve).toHaveLength(2);
    expect(new Set(ve.map((v) => v.getFirstPropertyValue('uid'))).size).toBe(1);
    expect(data).toMatch(/RECURRENCE-ID;TZID=Europe\/Berlin:20261028T100000/);
    expect(data).toMatch(/EXDATE;TZID=Europe\/Berlin:20261104T100000/);
    expect(data).toMatch(/RRULE:FREQ=WEEKLY;COUNT=4/);
    expect(data).not.toMatch(/^(ATTENDEE|ORGANIZER)/m);
    expect(r.event!.recurring).toBe(true);
  });

  it('refuses what it cannot take over completely: several events, only an exception, replies and cancellations', async () => {
    const two = CAL(VEVENT('', 'a@x') + '\r\n' + VEVENT('', 'b@x'));
    await expect(importer.import(await mailWith(two))).rejects.toThrow(/2 different events/);
    const onlyOverride = CAL('BEGIN:VEVENT\r\nUID:o@x\r\nDTSTAMP:20261001T100000Z\r\nRECURRENCE-ID:20261028T080000Z\r\nDTSTART:20261029T080000Z\r\nDTEND:20261029T090000Z\r\nSUMMARY:Just one\r\nEND:VEVENT');
    await expect(importer.import(await mailWith(onlyOverride))).rejects.toThrow(/only changed occurrences/);
    await expect(importer.import(await mailWith(CAL(VEVENT(), 'CANCEL')))).rejects.toThrow(/"CANCEL" message/);
    await expect(importer.import(await mailWith(CAL(VEVENT(), 'REPLY')))).rejects.toThrow(/"REPLY" message/);
    await expect(importer.import(await mailWith(CAL(VEVENT('STATUS:CANCELLED\r\n'))))).rejects.toThrow(/cancelled/);
    await expect(importer.import(await mailWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'))).rejects.toThrow(/no event/);
    expect(objs()).toHaveLength(0);
    expect(store.calls).toEqual([]);
  });

  it('creates nothing when an event with the same UID exists in any calendar, and reports it', async () => {
    store.put('events', 'existing', ev('invite-1@example.com'));
    const r = await importer.import(await mailWith(CAL(VEVENT())));
    expect(r.created).toBe(false);
    expect(r.existing).toEqual([{ calendar: 'Events', shared: false, id: '/u/calendars/events/existing.ics', title: 'Old title', start: expect.any(String) }]);
    expect(store.calls).toEqual([]);
    store.objects.clear();
    store.put('shared', 'sh', ev('invite-1@example.com'));
    const s = await importer.import(await mailWith(CAL(VEVENT())));
    expect(s).toMatchObject({ created: false, existing: [{ calendar: 'Shared', shared: true }] });
    expect(store.calls).toEqual([]);
  });

  it('importing the same invitation twice creates one event', async () => {
    const m = await mailWith(CAL(VEVENT()));
    expect((await importer.import(m)).created).toBe(true);
    const again = await importer.import(m);
    expect(again.created).toBe(false);
    expect(again.existing).toHaveLength(1);
    expect(objs()).toHaveLength(1);
  });

  it('maps Windows time zone names, keeps UTC and all-day events, converts truly unknown zones with a note', async () => {
    const win = CAL(VEVENT().replace(/TZID=Europe\/Berlin/g, 'TZID=W. Europe Standard Time'), 'REQUEST', BERLIN_TZ);
    const r = await importer.import(await mailWith(win));
    expect(r.event!.start).toBe('2026-10-21T10:00:00+02:00');
    expect(objs()[0]!.data).toMatch(/DTSTART;TZID=Europe\/Berlin:20261021T100000/);
    expect(objs()[0]!.data).not.toContain('W. Europe');
    store.objects.clear();

    const utc = CAL('BEGIN:VEVENT\r\nUID:u@x\r\nDTSTAMP:20261001T100000Z\r\nDTSTART:20261021T080000Z\r\nDTEND:20261021T090000Z\r\nSUMMARY:UTC event\r\nEND:VEVENT');
    expect((await importer.import(await mailWith(utc))).event!.start).toBe('2026-10-21T10:00:00+02:00');
    expect(objs()[0]!.data).toMatch(/DTSTART:20261021T080000Z/);
    store.objects.clear();

    const day = CAL('BEGIN:VEVENT\r\nUID:d@x\r\nDTSTAMP:20261001T100000Z\r\nDTSTART;VALUE=DATE:20261103\r\nDTEND;VALUE=DATE:20261105\r\nSUMMARY:Conference\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT');
    const d = await importer.import(await mailWith(day));
    expect(d.event).toMatchObject({ allDay: true, start: '2026-11-03', end: '2026-11-04', free: true });
    store.objects.clear();

    const mars = 'BEGIN:VTIMEZONE\r\nTZID:Mars Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16010101T000000\r\nTZOFFSETFROM:+0300\r\nTZOFFSETTO:+0300\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';
    const unknown = CAL(VEVENT().replace(/TZID=Europe\/Berlin/g, 'TZID=Mars Standard Time'), 'REQUEST', mars);
    const u = await importer.import(await mailWith(unknown));
    expect(u.notes.join(' ')).toMatch(/Mars Standard Time.*unknown/);
    expect(u.event!.start).toBe('2026-10-21T09:00:00+02:00'); // 10:00 at +03:00 is 09:00 in Berlin
  });

  it('uses the named private calendar, refuses shared and unknown calendars', async () => {
    const m = await mailWith(CAL(VEVENT()));
    await expect(importer.import({ ...m, calendar: 'Shared' })).rejects.toThrow(/shared calendar/);
    await expect(importer.import({ ...m, calendar: 'Holidays' })).rejects.toThrow(/subscribed/);
    await expect(importer.import({ ...m, calendar: 'Nope' })).rejects.toThrow(/not found/);
    expect(store.calls).toEqual([]);
    const r = await importer.import({ ...m, calendar: 'events' });
    expect(r.calendar).toBe('Events');
    expect(store.calls[0]).toMatch(/^create:events\//);
  });

  it('refuses attachments that are not calendar files', async () => {
    const m = await mailWith('Just some text, not a calendar', { type: 'text/plain', filename: 'note.txt' });
    await expect(importer.import(m)).rejects.toThrow(/not a calendar invitation/);
    const wrong = await mailWith('BEGIN:VCALENDAR\r\nEND:VCALENDAR', { type: 'application/pdf', filename: 'x.pdf' });
    await expect(importer.import(wrong)).rejects.toThrow(/not a calendar invitation/);
  });

  it('texts in the invitation cannot add attendees or properties', async () => {
    const evil = VEVENT().replace('SUMMARY:Project kickoff', 'SUMMARY:Hi\\nATTENDEE;CN=X:mailto:victim@example.com').replace('Room 4', 'Room\\nORGANIZER:mailto:x@example.com');
    await importer.import(await mailWith(CAL(evil)));
    expect(objs()[0]!.data).not.toMatch(/^(ATTENDEE|ORGANIZER|METHOD)/m);
  });

  it('the schema takes only id, attachment_id and calendar', () => {
    expect(importInvitationSchema.safeParse({ id: 'INBOX|1|1', attachment_id: '2' }).success).toBe(true);
    for (const f of ['attendees', 'reply', 'respond', 'shared_calendar', 'method']) expect(importInvitationSchema.safeParse({ id: 'INBOX|1|1', attachment_id: '2', [f]: 'x' }).success, f).toBe(false);
  });

  it('planImport on its own: new UID every time, nothing but whitelisted properties', () => {
    const a = planImport(CAL(VEVENT(ALARM)), Z);
    const b = planImport(CAL(VEVENT(ALARM)), Z);
    expect(a.uid).not.toBe(b.uid);
    const names = vevents(a.ics)[0]!.getAllProperties().map((p) => p.name).sort();
    expect(names).toEqual(['created', 'description', 'dtend', 'dtstamp', 'dtstart', 'last-modified', 'location', 'sequence', 'summary', 'transp', 'uid', 'x-iclaude-source-uid']);
  });
});
