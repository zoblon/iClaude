import { IANAZone } from 'luxon';
import { calendarQuery, createDAVClient, getBasicAuthHeaders, type DAVCalendar } from 'tsdav';
import type { Config } from '../config.js';
import { UserError, withTimeout } from '../errors.js';
import { WriteGrant } from '../permissions.js';
import type { CalendarInfo, CalendarStore, RawObject } from './types.js';

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

const TIMEOUT_MS = 20_000;
const CALENDAR_CACHE_MS = 5 * 60_000;
/** Upper limit per calendar and query; protects against huge responses. */
const MAX_OBJECTS_PER_CALENDAR = 3000;

/**
 * Properties needed for display, search and free slots.
 * iCloud returns no calendar data for allprop/allcomp (see docs/ICLOUD-NOTES.md),
 * so they are requested individually. This is also about 70 % smaller.
 */
const EVENT_PROPS = [
  'UID', 'SUMMARY', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID',
  'LOCATION', 'DESCRIPTION', 'STATUS', 'TRANSP', 'ORGANIZER', 'ATTENDEE', 'SEQUENCE',
  // set by import_invitation: finds an invitation that was imported before
  'X-ICLAUDE-SOURCE-UID',
] as const;
const ALARM_PROPS = ['ACTION', 'TRIGGER'] as const;
const named = (name: string) => ({ _attributes: { name } });

const queryProps = {
  'd:getetag': {},
  'c:calendar-data': {
    'c:comp': {
      _attributes: { name: 'VCALENDAR' },
      'c:prop': named('VERSION'),
      'c:comp': {
        _attributes: { name: 'VEVENT' },
        'c:prop': EVENT_PROPS.map(named),
        'c:comp': { _attributes: { name: 'VALARM' }, 'c:prop': ALARM_PROPS.map(named) },
      },
    },
  },
};

/** CalDAV time format YYYYMMDDTHHMMSSZ */
const caldavTime = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');

/** Time zone names in the .ics that are neither IANA nor UTC (their definition is missing from the restricted response). */
export function hasUnknownTzid(ics: string): boolean {
  for (const m of ics.matchAll(/TZID[=:]([^:;\r\n]+)/gi)) {
    const id = m[1]!.trim();
    if (id !== 'UTC' && !IANAZone.isValidZone(id)) return true;
  }
  return false;
}

type Props = Record<string, any>;

const hrefOf = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'href' in v) return String((v as { href: unknown }).href);
  return '';
};

/**
 * Detects from the server properties whether a calendar is shared.
 * When in doubt, a calendar counts as shared (safe default).
 */
export function classifyCalendar(
  props: Props,
  ownPrincipal: string,
): { shared: boolean; reason?: string; subscribed: boolean; writable: boolean } {
  const rt = (props.resourcetype ?? {}) as Record<string, unknown>;
  const owner = hrefOf(props.owner);
  const privs = JSON.stringify(props.currentUserPrivilegeSet ?? {});
  const writable = /"(write|write-?content|bind|all)"/i.test(privs);
  const subscribed = 'subscribed' in rt || Boolean(props.source);

  if ('sharedOwner' in rt || 'shared-owner' in rt) return { shared: true, reason: 'owner has shared the calendar', subscribed, writable };
  if ('shared' in rt) return { shared: true, reason: 'calendar shared with me', subscribed, writable };
  if (props.invite) return { shared: true, reason: 'invite list present', subscribed, writable };
  if (props.sharedUrl) return { shared: true, reason: 'sharing URL present', subscribed, writable };
  if (!owner || !ownPrincipal || owner !== ownPrincipal) {
    return { shared: true, reason: 'owner is not clearly the own account', subscribed, writable };
  }
  return { shared: false, subscribed, writable };
}

/** Access to iCloud CalDAV. Writing and deleting only with a matching WriteGrant. */
export class CalDavGateway implements CalendarStore {
  private clientPromise?: Promise<DavClient>;
  private cache?: { at: number; calendars: CalendarInfo[]; raw: Map<string, DAVCalendar> };

  constructor(private readonly cfg: Config) {}

  private client(): Promise<DavClient> {
    if (!this.clientPromise) {
      this.clientPromise = withTimeout(
        createDAVClient({
          serverUrl: 'https://caldav.icloud.com',
          credentials: { username: this.cfg.appleId, password: this.cfg.appPassword },
          authMethod: 'Basic',
          defaultAccountType: 'caldav',
        }),
        TIMEOUT_MS,
        'signing in to iCloud Calendar',
      ).catch((e) => {
        this.clientPromise = undefined;
        throw e;
      });
    }
    return this.clientPromise;
  }

  async listCalendars(force = false): Promise<CalendarInfo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < CALENDAR_CACHE_MS) return this.cache.calendars;
    const client = await this.client();
    const raw = await withTimeout(client.fetchCalendars(), TIMEOUT_MS, 'loading the calendars');
    if (raw.length === 0) throw new UserError('No calendars found. Please check in the iCloud settings that Calendars is enabled.');

    const homeUrl = raw[0]!.url.replace(/[^/]+\/?$/, '');
    const responses = await withTimeout(
      client.propfind({
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
      }),
      TIMEOUT_MS,
      'loading the calendar properties',
    );
    const byPath = new Map<string, Props>();
    let ownPrincipal = '';
    for (const r of responses) {
      const path = new URL(r.href ?? '', homeUrl).pathname;
      const props = (r.props ?? {}) as Props;
      byPath.set(path, props);
      // The calendar home collection itself belongs to the own account.
      if (path === new URL(homeUrl).pathname) ownPrincipal = hrefOf(props.owner);
    }

    const calendars: CalendarInfo[] = raw.map((c) => {
      const path = new URL(c.url).pathname;
      const props = byPath.get(path) ?? {};
      const comps = Array.isArray(c.components) ? c.components : [];
      const kind: CalendarInfo['kind'] = comps.includes('VEVENT') ? 'events' : comps.includes('VTODO') ? 'tasks' : 'other';
      const cls = classifyCalendar(props, ownPrincipal);
      return {
        id: path,
        name: typeof c.displayName === 'string' ? c.displayName : path,
        kind,
        shared: cls.shared,
        ...(cls.reason ? { sharedReason: cls.reason } : {}),
        subscribed: cls.subscribed,
        writable: cls.writable && !cls.subscribed,
        url: c.url,
      };
    });
    this.cache = { at: Date.now(), calendars, raw: new Map(raw.map((c) => [c.url, c])) };
    return calendars;
  }

  /**
   * Fetches the events in the range with individually requested properties (not the complete file!).
   * Recurring series come back as a whole resource. Do not use for writing: always use getObject (GET) for that.
   */
  async fetchObjects(calendar: CalendarInfo, startIso: string, endIso: string): Promise<{ objects: RawObject[]; truncated: boolean }> {
    const results = await withTimeout(
      calendarQuery({
        url: calendar.url,
        props: queryProps,
        filters: {
          'comp-filter': {
            _attributes: { name: 'VCALENDAR' },
            'comp-filter': {
              _attributes: { name: 'VEVENT' },
              'time-range': { _attributes: { start: caldavTime(startIso), end: caldavTime(endIso) } },
            },
          },
        },
        depth: '1',
        headers: this.authHeaders(),
      }),
      TIMEOUT_MS,
      `loading events from "${calendar.name}"`,
    );
    const list = results.filter((r) => r.ok !== false && r.href);
    const objects: RawObject[] = [];
    for (const r of list.slice(0, MAX_OBJECTS_PER_CALENDAR)) {
      const p = (r.props ?? {}) as Props;
      const cd = p.calendarData;
      const data = typeof cd === 'string' ? cd : (cd?._cdata ?? cd?._text ?? '');
      if (typeof data !== 'string' || !data) continue;
      const tag = typeof p.getetag === 'string' ? p.getetag : (p.getetag?._text ?? p.getetag?._cdata);
      const url = new URL(r.href!, calendar.url).href;
      let obj: RawObject = { url, ...(tag ? { etag: String(tag) } : {}), data };
      // Unknown time zone names: load the complete event (with time zone definition).
      if (hasUnknownTzid(data)) obj = (await this.getObject(calendar, url)) ?? obj;
      objects.push(obj);
    }
    return { objects, truncated: list.length > MAX_OBJECTS_PER_CALENDAR };
  }

  /** Loads the complete event via GET (including all properties, with the ETag from the response). */
  async getObject(calendar: CalendarInfo, url: string): Promise<RawObject | undefined> {
    const target = resourceIn(calendar, url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(target, { method: 'GET', headers: this.authHeaders(), signal: ctrl.signal, redirect: 'error' });
      if (res.status === 404) return undefined;
      if (!res.ok) throw writeError(res.status);
      const data = await res.text();
      if (!data) return undefined;
      const etag = res.headers.get('etag');
      return { url: target.href, ...(etag ? { etag } : {}), data };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new UserError(`Timeout while loading the event (${Math.round(TIMEOUT_MS / 1000)} s). Please try again later.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private authHeaders(): Record<string, string> {
    return getBasicAuthHeaders({ username: this.cfg.appleId, password: this.cfg.appPassword });
  }

  async createObject(grant: WriteGrant, filename: string, ics: string): Promise<RawObject> {
    if (!WriteGrant.isValid(grant, 'create')) throw new Error('Write access without grant');
    if (!/^[A-Za-z0-9-]{8,64}\.ics$/.test(filename)) throw new UserError('Internal error: invalid file name.');
    const client = await this.client();
    const cal = await this.rawCalendar(grant.calendar);
    // tsdav sends "If-None-Match: *": an existing event is never overwritten.
    const res = await withTimeout(client.createCalendarObject({ calendar: cal, filename, iCalString: ics }), TIMEOUT_MS, 'creating the event');
    if (!res.ok) throw writeError(res.status);
    const url = new URL(filename, ensureSlash(grant.calendar.url)).href;
    return (await this.getObject(grant.calendar, url)) ?? { url, data: ics };
  }

  async updateObject(grant: WriteGrant, obj: RawObject & { etag: string }): Promise<RawObject> {
    if (!WriteGrant.isValid(grant, 'update')) throw new Error('Write access without grant');
    if (!obj.etag) throw new UserError('Not writing without an ETag.');
    // Only events in the granted calendar
    if (!obj.url.startsWith(ensureSlash(grant.calendar.url))) throw new UserError('The event does not belong to the granted calendar.');
    const client = await this.client();
    // tsdav sends "If-Match: <etag>": if the event has changed in the meantime, the server refuses (412).
    const res = await withTimeout(
      client.updateCalendarObject({ calendarObject: { url: obj.url, data: obj.data, etag: obj.etag } }),
      TIMEOUT_MS,
      'saving the event',
    );
    if (!res.ok) throw writeError(res.status);
    return (await this.getObject(grant.calendar, obj.url)) ?? { url: obj.url, data: obj.data };
  }

  /**
   * Deletes exactly one event (HTTP DELETE with If-Match on the ETag). If the event has changed in the meantime, the server refuses with 412.
   * Only with a grant from authorizeDelete; shared calendars are excluded here once more.
   */
  async deleteObject(grant: WriteGrant, obj: { url: string; etag: string }): Promise<void> {
    if (!WriteGrant.isValid(grant, 'delete')) throw new Error('Delete access without grant');
    if (grant.calendar.shared) throw new UserError('Events in shared calendars are never deleted.');
    if (!obj.etag) throw new UserError('Not deleting without an ETag.');
    const target = resourceIn(grant.calendar, obj.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(target, { method: 'DELETE', headers: { ...this.authHeaders(), 'If-Match': obj.etag }, signal: ctrl.signal, redirect: 'error' });
      if (!res.ok) throw deleteError(res.status);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new UserError(`Timeout while deleting the event (${Math.round(TIMEOUT_MS / 1000)} s). Please check in Apple Calendar whether the event still exists.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async rawCalendar(calendar: CalendarInfo): Promise<DAVCalendar> {
    await this.listCalendars();
    const cal = this.cache?.raw.get(calendar.url);
    if (!cal) throw new UserError(`Calendar "${calendar.name}" was not found.`);
    return cal;
  }
}

const ensureSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`);

/** Send credentials only to the calendar server and only for resources of this calendar. */
function resourceIn(calendar: CalendarInfo, url: string): URL {
  const target = new URL(url);
  const base = new URL(ensureSlash(calendar.url));
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.pathname.includes('..')) {
    throw new UserError('Invalid event ID: it does not belong to this calendar. Use the ID from list_events unchanged.');
  }
  return target;
}

function deleteError(status: number): UserError {
  if (status === 412) return new UserError('The event has changed in the meantime. Nothing was deleted. Please reload the event (list_events) and request the deletion again.');
  if (status === 404) return new UserError('The event was not found (perhaps already deleted). Please check with list_events.');
  if (status === 401) return new UserError('Sign-in to iCloud failed. Check the Apple ID and app-specific password.');
  if (status === 403) return new UserError('iCloud refuses deletion in this calendar. Please check in Apple Calendar that you have write access there.');
  return new UserError(`iCloud rejected the deletion (HTTP ${status}). The event probably still exists; please check in Apple Calendar.`);
}

function writeError(status: number): UserError {
  if (status === 412) return new UserError('The event has changed in the meantime (or already exists). Please reload it and make the change again.', status);
  if (status === 401) return new UserError('Sign-in to iCloud failed. Check the Apple ID and app-specific password.', status);
  if (status === 403) return new UserError('iCloud refuses write access to this calendar. Please check in Apple Calendar that you have write access there.', status);
  if (status === 404) return new UserError('The event or calendar was not found. Please fetch the event ID again with list_events or search_events.', status);
  if (status === 409) return new UserError('iCloud refused to save the event because of a conflict (for example the same UID already exists elsewhere).', status);
  return new UserError(`iCloud rejected the save (HTTP ${status}). Please check the input and try again; if the error persists, create the event in Apple Calendar.`, status);
}
