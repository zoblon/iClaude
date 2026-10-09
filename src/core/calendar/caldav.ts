import { IANAZone } from 'luxon';
import { calendarQuery, createDAVClient, getBasicAuthHeaders, type DAVCalendar } from 'tsdav';
import type { Config } from '../config.js';
import { UserError, withTimeout } from '../errors.js';
import { WriteGrant } from '../permissions.js';
import type { CalendarInfo, CalendarStore, RawObject } from './types.js';

type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

const TIMEOUT_MS = 20_000;
const CALENDAR_CACHE_MS = 5 * 60_000;
/** Obergrenze je Kalender und Abfrage, schützt vor riesigen Antworten. */
const MAX_OBJECTS_PER_CALENDAR = 3000;

/**
 * Eigenschaften, die für Anzeige, Suche und freie Zeiten gebraucht werden.
 * iCloud liefert bei allprop/allcomp keine Kalenderdaten (siehe docs/ICLOUD-NOTIZEN.md),
 * daher werden sie einzeln angefragt. Das ist zudem rund 70 % kleiner.
 */
const EVENT_PROPS = [
  'UID', 'SUMMARY', 'DTSTART', 'DTEND', 'DURATION', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID',
  'LOCATION', 'DESCRIPTION', 'STATUS', 'TRANSP', 'ORGANIZER', 'ATTENDEE', 'SEQUENCE',
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

/** CalDAV-Zeitformat YYYYMMDDTHHMMSSZ */
const caldavTime = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');

/** Zeitzonennamen in der .ics, die weder IANA noch UTC sind (dafür fehlt die Definition in der eingeschränkten Antwort). */
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
 * Erkennt anhand der Server-Eigenschaften, ob ein Kalender geteilt ist.
 * Im Zweifel gilt ein Kalender als geteilt (sicherer Standard).
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

  if ('sharedOwner' in rt || 'shared-owner' in rt) return { shared: true, reason: 'Eigentümer hat den Kalender geteilt', subscribed, writable };
  if ('shared' in rt) return { shared: true, reason: 'Mit mir geteilter Kalender', subscribed, writable };
  if (props.invite) return { shared: true, reason: 'Teilnehmerliste vorhanden', subscribed, writable };
  if (props.sharedUrl) return { shared: true, reason: 'Freigabe-URL vorhanden', subscribed, writable };
  if (!owner || !ownPrincipal || owner !== ownPrincipal) {
    return { shared: true, reason: 'Eigentümer nicht eindeutig der eigene Account', subscribed, writable };
  }
  return { shared: false, subscribed, writable };
}

/** Zugriff auf iCloud-CalDAV. Schreiben und Löschen nur mit passendem WriteGrant. */
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
        'der Anmeldung bei iCloud-Kalender',
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
    const raw = await withTimeout(client.fetchCalendars(), TIMEOUT_MS, 'dem Laden der Kalender');
    if (raw.length === 0) throw new UserError('Es wurden keine Kalender gefunden. Bitte in den iCloud-Einstellungen prüfen, ob Kalender aktiviert sind.');

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
      'dem Laden der Kalendereigenschaften',
    );
    const byPath = new Map<string, Props>();
    let ownPrincipal = '';
    for (const r of responses) {
      const path = new URL(r.href ?? '', homeUrl).pathname;
      const props = (r.props ?? {}) as Props;
      byPath.set(path, props);
      // Die Kalender-Sammlung selbst gehört dem eigenen Account.
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
   * Holt die Termine im Zeitraum mit einzeln angefragten Eigenschaften (nicht die vollständige Datei!).
   * Serien kommen als ganze Ressource zurück. Nicht zum Schreiben verwenden: dafür immer getObject (GET).
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
      `dem Laden der Termine aus "${calendar.name}"`,
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
      // Unbekannte Zeitzonennamen: den Termin vollständig (mit Zeitzonendefinition) nachladen.
      if (hasUnknownTzid(data)) obj = (await this.getObject(calendar, url)) ?? obj;
      objects.push(obj);
    }
    return { objects, truncated: list.length > MAX_OBJECTS_PER_CALENDAR };
  }

  /** Lädt den vollständigen Termin per GET (inklusive aller Eigenschaften, mit ETag aus der Antwort). */
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
        throw new UserError(`Zeitüberschreitung beim Laden des Termins (${Math.round(TIMEOUT_MS / 1000)} s). Bitte später erneut versuchen.`);
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
    if (!WriteGrant.isValid(grant, 'create')) throw new Error('Schreibzugriff ohne Freigabe');
    if (!/^[A-Za-z0-9-]{8,64}\.ics$/.test(filename)) throw new UserError('Interner Fehler: ungültiger Dateiname.');
    const client = await this.client();
    const cal = await this.rawCalendar(grant.calendar);
    // tsdav sendet "If-None-Match: *": ein vorhandener Termin wird nie überschrieben.
    const res = await withTimeout(client.createCalendarObject({ calendar: cal, filename, iCalString: ics }), TIMEOUT_MS, 'dem Anlegen des Termins');
    if (!res.ok) throw writeError(res.status);
    const url = new URL(filename, ensureSlash(grant.calendar.url)).href;
    return (await this.getObject(grant.calendar, url)) ?? { url, data: ics };
  }

  async updateObject(grant: WriteGrant, obj: RawObject & { etag: string }): Promise<RawObject> {
    if (!WriteGrant.isValid(grant, 'update')) throw new Error('Schreibzugriff ohne Freigabe');
    if (!obj.etag) throw new UserError('Ohne ETag wird nicht geschrieben.');
    // Nur Termine im freigegebenen Kalender
    if (!obj.url.startsWith(ensureSlash(grant.calendar.url))) throw new UserError('Der Termin gehört nicht zum freigegebenen Kalender.');
    const client = await this.client();
    // tsdav sendet "If-Match: <etag>": hat sich der Termin inzwischen geändert, lehnt der Server ab (412).
    const res = await withTimeout(
      client.updateCalendarObject({ calendarObject: { url: obj.url, data: obj.data, etag: obj.etag } }),
      TIMEOUT_MS,
      'dem Speichern des Termins',
    );
    if (!res.ok) throw writeError(res.status);
    return (await this.getObject(grant.calendar, obj.url)) ?? { url: obj.url, data: obj.data };
  }

  /**
   * Löscht genau einen Termin (HTTP DELETE mit If-Match auf den ETag). Hat sich der Termin inzwischen geändert, lehnt der Server mit 412 ab.
   * Nur mit einer Freigabe aus authorizeDelete; geteilte Kalender werden hier nochmals ausgeschlossen.
   */
  async deleteObject(grant: WriteGrant, obj: { url: string; etag: string }): Promise<void> {
    if (!WriteGrant.isValid(grant, 'delete')) throw new Error('Löschzugriff ohne Freigabe');
    if (grant.calendar.shared) throw new UserError('Termine in geteilten Kalendern werden nie gelöscht.');
    if (!obj.etag) throw new UserError('Ohne ETag wird nicht gelöscht.');
    const target = resourceIn(grant.calendar, obj.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(target, { method: 'DELETE', headers: { ...this.authHeaders(), 'If-Match': obj.etag }, signal: ctrl.signal, redirect: 'error' });
      if (!res.ok) throw deleteError(res.status);
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new UserError(`Zeitüberschreitung beim Löschen des Termins (${Math.round(TIMEOUT_MS / 1000)} s). Bitte in Apple Kalender prüfen, ob der Termin noch da ist.`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async rawCalendar(calendar: CalendarInfo): Promise<DAVCalendar> {
    await this.listCalendars();
    const cal = this.cache?.raw.get(calendar.url);
    if (!cal) throw new UserError(`Kalender "${calendar.name}" wurde nicht gefunden.`);
    return cal;
  }
}

const ensureSlash = (u: string) => (u.endsWith('/') ? u : `${u}/`);

/** Zugangsdaten nur an den Kalender-Server und nur für Ressourcen dieses Kalenders senden. */
function resourceIn(calendar: CalendarInfo, url: string): URL {
  const target = new URL(url);
  const base = new URL(ensureSlash(calendar.url));
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname) || target.pathname.includes('..')) {
    throw new UserError('Ungültige Termin-ID: sie gehört nicht zu diesem Kalender. Die ID unverändert aus list_events übernehmen.');
  }
  return target;
}

function deleteError(status: number): UserError {
  if (status === 412) return new UserError('Der Termin wurde inzwischen geändert. Es wurde nichts gelöscht. Bitte den Termin neu laden (list_events) und das Löschen erneut anfordern.');
  if (status === 404) return new UserError('Der Termin wurde nicht gefunden (vielleicht schon gelöscht). Bitte mit list_events prüfen.');
  if (status === 401) return new UserError('Anmeldung bei iCloud fehlgeschlagen. Apple-ID und App-spezifisches Passwort prüfen.');
  if (status === 403) return new UserError('iCloud verweigert das Löschen in diesem Kalender. Bitte in Apple Kalender prüfen, ob du dort Schreibrechte hast.');
  return new UserError(`iCloud hat das Löschen abgelehnt (HTTP ${status}). Der Termin ist vermutlich noch vorhanden; bitte in Apple Kalender prüfen.`);
}

function writeError(status: number): UserError {
  if (status === 412) return new UserError('Der Termin wurde inzwischen geändert (oder existiert bereits). Bitte neu laden und die Änderung erneut vornehmen.');
  if (status === 401) return new UserError('Anmeldung bei iCloud fehlgeschlagen. Apple-ID und App-spezifisches Passwort prüfen.');
  if (status === 403) return new UserError('iCloud verweigert den Schreibzugriff auf diesen Kalender. Bitte in Apple Kalender prüfen, ob du dort Schreibrechte hast.');
  if (status === 404) return new UserError('Der Termin oder Kalender wurde nicht gefunden. Bitte die Termin-ID mit list_events oder search_events neu abrufen.');
  return new UserError(`iCloud hat das Speichern abgelehnt (HTTP ${status}). Bitte die Eingaben prüfen und erneut versuchen; besteht der Fehler weiter, den Termin in Apple Kalender anlegen.`);
}
