import type { Config } from '../src/core/config.js';
import { UserError } from '../src/core/errors.js';
import { WriteGrant } from '../src/core/permissions.js';
import type { CalendarInfo, CalendarStore, RawObject } from '../src/core/calendar/types.js';

export const cfg: Config = {
  appleId: 'me@example.com',
  mailUser: 'me@icloud.com',
  appPassword: 'test-password-never-real',
  timezone: 'Europe/Berlin',
  defaultCalendar: 'MCP-Test',
};

const mk = (name: string, slug: string, over: Partial<CalendarInfo> = {}): CalendarInfo => ({
  id: `/u/calendars/${slug}/`,
  name,
  kind: 'events',
  shared: false,
  subscribed: false,
  writable: true,
  url: `https://p1.example.com/u/calendars/${slug}/`,
  ...over,
});

export const calendars: CalendarInfo[] = [
  mk('MCP-Test', 'priv'),
  mk('Events', 'events'),
  mk('Shared', 'shared', { shared: true, sharedReason: 'owner has shared the calendar' }),
  mk('Holidays', 'abo', { subscribed: true, writable: false }),
  mk('Read only', 'ro', { writable: false }),
  mk('Family', 'fam', { kind: 'tasks', shared: true }),
];

/** Simulated in-memory calendar server. Counts writes and checks ETags like a real server. */
export class FakeStore implements CalendarStore {
  objects = new Map<string, RawObject>();
  creates = 0;
  updates = 0;
  deletes = 0;
  /** Last delete call (URL and the ETag that would be sent as If-Match). */
  lastDelete?: { url: string; etag: string };
  /** How often a query (partial copy) was read. */
  queries = 0;
  /** How often an event was loaded completely (GET). */
  gets = 0;
  private n = 1;
  /** Called after reading, to simulate changes by third parties. */
  afterGet?: (o: RawObject) => void;
  /** Order of the writing calls, e.g. "create:shared/abc.ics", "delete:priv/abc.ics". */
  calls: string[] = [];
  /** Refuse a new object whose UID already exists in another calendar (HTTP 409), like a server with a no-uid-conflict rule. */
  rejectSameUid = false;
  /** Make the next delete fail with this error. */
  deleteError?: Error;
  /** Alter what the server stores on create (to simulate a server that changes data). */
  onCreate?: (data: string) => string;

  constructor(private readonly cals: CalendarInfo[] = calendars) {}

  put(slug: string, name: string, ics: string): string {
    const url = `https://p1.example.com/u/calendars/${slug}/${name}.ics`;
    this.objects.set(url, { url, etag: `"e${this.n++}"`, data: ics });
    return `/u/calendars/${slug}/${name}.ics`;
  }

  async listCalendars() {
    return this.cals;
  }
  async fetchObjects(calendar?: CalendarInfo) {
    this.queries++;
    // A query deliberately returns only a partial copy without the unknown properties (except the ones the real query asks for).
    const partial = [...this.objects.values()]
      .filter((o) => !calendar || o.url.startsWith(calendar.url))
      .map((o) => ({ ...o, data: o.data.replace(/^X-(?!ICLAUDE-SOURCE-UID)[^\r\n]*\r\n/gm, '') }));
    return { objects: partial, truncated: false };
  }
  async getObject(_c: CalendarInfo, url: string) {
    this.gets++;
    const o = this.objects.get(url);
    if (o) this.afterGet?.(o);
    return o ? { ...o } : undefined;
  }
  async createObject(grant: WriteGrant, filename: string, ics: string) {
    if (!WriteGrant.isValid(grant, 'create')) throw new Error('Write access without grant');
    const url = new URL(filename, grant.calendar.url).href;
    if (this.objects.has(url)) throw new UserError('The event already exists.', 412);
    const uid = /^UID:(.*)$/m.exec(ics)?.[1]?.trim();
    if (this.rejectSameUid && uid && [...this.objects.values()].some((x) => new RegExp(`^UID:${uid}\\r?$`, 'm').test(x.data))) {
      throw new UserError('iCloud refused to save the event because of a conflict.', 409);
    }
    this.creates++;
    this.calls.push(`create:${url.split('/calendars/')[1]}`);
    const o = { url, etag: `"e${this.n++}"`, data: this.onCreate ? this.onCreate(ics) : ics };
    this.objects.set(url, o);
    return { ...o };
  }
  async updateObject(grant: WriteGrant, obj: RawObject & { etag: string }) {
    if (!WriteGrant.isValid(grant, 'update')) throw new Error('Write access without grant');
    const cur = this.objects.get(obj.url);
    if (!cur) throw new UserError('The event or calendar was not found.');
    if (cur.etag !== obj.etag) throw new UserError('The event has changed in the meantime (or already exists).');
    this.updates++;
    const o = { url: obj.url, etag: `"e${this.n++}"`, data: obj.data };
    this.objects.set(obj.url, o);
    return { ...o };
  }
  async deleteObject(grant: WriteGrant, obj: { url: string; etag: string }) {
    if (!WriteGrant.isValid(grant, 'delete')) throw new Error('Delete access without grant');
    this.lastDelete = { url: obj.url, etag: obj.etag };
    this.calls.push(`delete:${obj.url.split('/calendars/')[1]}`);
    if (this.deleteError) throw this.deleteError;
    const cur = this.objects.get(obj.url);
    if (!cur) throw new UserError('The event was not found.');
    if (cur.etag !== obj.etag) throw new UserError('The event has changed in the meantime. Nothing was deleted.');
    this.deletes++;
    this.objects.delete(obj.url);
  }
}

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iCloud//EN\r\nX-WR-CALNAME:Test\r\n${body}\r\nEND:VCALENDAR\r\n`;
const BASE = 'DTSTAMP:20261001T100000Z\r\nSEQUENCE:1\r\nDTSTART;TZID=Europe/Berlin:20261021T100000\r\nDTEND;TZID=Europe/Berlin:20261021T113000\r\nSUMMARY:Old title\r\nX-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:52.5,13.4\r\nX-MY-EXTENSION:important';

export const ev = (uid: string, extra = '') => wrap(`BEGIN:VEVENT\r\nUID:${uid}\r\n${BASE}${extra ? '\r\n' + extra : ''}\r\nEND:VEVENT`);
