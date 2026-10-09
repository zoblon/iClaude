import type { Config } from '../src/core/config.js';
import { UserError } from '../src/core/errors.js';
import { WriteGrant } from '../src/core/permissions.js';
import type { CalendarInfo, CalendarStore, RawObject } from '../src/core/calendar/types.js';

export const cfg: Config = {
  appleId: 'me@example.com',
  mailUser: 'me@icloud.com',
  appPassword: 'test-passwort-nie-echt',
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
  mk('Termine', 'termine'),
  mk('Gemeinsam', 'gemeinsam', { shared: true, sharedReason: 'Eigentümer hat den Kalender geteilt' }),
  mk('Feiertage', 'abo', { subscribed: true, writable: false }),
  mk('Nur lesen', 'ro', { writable: false }),
  mk('Familie', 'fam', { kind: 'tasks', shared: true }),
];

/** Simulierter Kalenderserver im Speicher. Zählt Schreibvorgänge und prüft ETags wie ein echter Server. */
export class FakeStore implements CalendarStore {
  objects = new Map<string, RawObject>();
  creates = 0;
  updates = 0;
  deletes = 0;
  /** Letzter Löschaufruf (Adresse und ETag, der als If-Match gesendet würde). */
  lastDelete?: { url: string; etag: string };
  /** Wie oft aus einer Abfrage (Teilkopie) gelesen wurde. */
  queries = 0;
  /** Wie oft ein Termin vollständig geladen wurde (GET). */
  gets = 0;
  private n = 1;
  /** Wird nach dem Lesen aufgerufen, um Änderungen durch Dritte zu simulieren. */
  afterGet?: (o: RawObject) => void;

  constructor(private readonly cals: CalendarInfo[] = calendars) {}

  put(slug: string, name: string, ics: string): string {
    const url = `https://p1.example.com/u/calendars/${slug}/${name}.ics`;
    this.objects.set(url, { url, etag: `"e${this.n++}"`, data: ics });
    return `/u/calendars/${slug}/${name}.ics`;
  }

  async listCalendars() {
    return this.cals;
  }
  async fetchObjects() {
    this.queries++;
    // Eine Abfrage liefert bewusst nur eine Teilkopie ohne die unbekannten Eigenschaften.
    const partial = [...this.objects.values()].map((o) => ({ ...o, data: o.data.replace(/^X-[^\r\n]*\r\n/gm, '') }));
    return { objects: partial, truncated: false };
  }
  async getObject(_c: CalendarInfo, url: string) {
    this.gets++;
    const o = this.objects.get(url);
    if (o) this.afterGet?.(o);
    return o ? { ...o } : undefined;
  }
  async createObject(grant: WriteGrant, filename: string, ics: string) {
    if (!WriteGrant.isValid(grant, 'create')) throw new Error('Schreibzugriff ohne Freigabe');
    this.creates++;
    const url = new URL(filename, grant.calendar.url).href;
    const o = { url, etag: `"e${this.n++}"`, data: ics };
    this.objects.set(url, o);
    return { ...o };
  }
  async updateObject(grant: WriteGrant, obj: RawObject & { etag: string }) {
    if (!WriteGrant.isValid(grant, 'update')) throw new Error('Schreibzugriff ohne Freigabe');
    const cur = this.objects.get(obj.url);
    if (!cur) throw new UserError('Der Termin oder Kalender wurde nicht gefunden.');
    if (cur.etag !== obj.etag) throw new UserError('Der Termin wurde inzwischen geändert (oder existiert bereits).');
    this.updates++;
    const o = { url: obj.url, etag: `"e${this.n++}"`, data: obj.data };
    this.objects.set(obj.url, o);
    return { ...o };
  }
  async deleteObject(grant: WriteGrant, obj: { url: string; etag: string }) {
    if (!WriteGrant.isValid(grant, 'delete')) throw new Error('Löschzugriff ohne Freigabe');
    this.lastDelete = { url: obj.url, etag: obj.etag };
    const cur = this.objects.get(obj.url);
    if (!cur) throw new UserError('Der Termin wurde nicht gefunden.');
    if (cur.etag !== obj.etag) throw new UserError('Der Termin wurde inzwischen geändert. Es wurde nichts gelöscht.');
    this.deletes++;
    this.objects.delete(obj.url);
  }
}

const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iCloud//EN\r\nX-WR-CALNAME:Test\r\n${body}\r\nEND:VCALENDAR\r\n`;
const BASE = 'DTSTAMP:20261001T100000Z\r\nSEQUENCE:1\r\nDTSTART;TZID=Europe/Berlin:20261021T100000\r\nDTEND;TZID=Europe/Berlin:20261021T113000\r\nSUMMARY:Alter Titel\r\nX-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:52.5,13.4\r\nX-MEINE-ERWEITERUNG:wichtig';

export const ev = (uid: string, extra = '') => wrap(`BEGIN:VEVENT\r\nUID:${uid}\r\n${BASE}${extra ? '\r\n' + extra : ''}\r\nEND:VEVENT`);
