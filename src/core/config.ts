import { DateTime } from 'luxon';
import { UserError, registerSecrets } from './errors.js';

export interface Config {
  /** Apple-ID (Login für CalDAV und CardDAV). */
  appleId: string;
  /** @icloud.com-Adresse (Login für IMAP, Absender von Entwürfen). */
  mailUser: string;
  appPassword: string;
  timezone: string;
  /** Name des Standardkalenders für neue Termine (muss privat sein). */
  defaultCalendar: string | undefined;
}

/** Liest die Konfiguration aus Umgebungsvariablen. Fehlermeldungen enthalten nie Werte. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (k: string) => {
    const v = (env[k] ?? '').trim();
    // Nicht ersetzte Platzhalter aus dem Extension-Manifest gelten als leer.
    return v.startsWith('${') ? '' : v;
  };
  const missing: string[] = [];
  const appleId = get('ICLOUD_APPLE_ID');
  const mailUser = get('ICLOUD_MAIL_USER');
  const appPassword = get('ICLOUD_APP_PASSWORD');
  if (!appleId) missing.push('Apple-ID');
  if (!mailUser) missing.push('iCloud-Mailadresse');
  if (!appPassword) missing.push('App-spezifisches Passwort');
  if (missing.length) {
    throw new UserError(`Konfiguration unvollständig: ${missing.join(', ')} fehlt. Bitte in den Einstellungen der Extension eintragen.`);
  }
  registerSecrets(appPassword, appleId, mailUser);

  const timezone = get('ICLOUD_TIMEZONE') || 'Europe/Berlin';
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new UserError(`Unbekannte Zeitzone "${timezone}". Beispiel: Europe/Berlin`);
  }
  return { appleId, mailUser, appPassword, timezone, defaultCalendar: get('ICLOUD_DEFAULT_CALENDAR') || undefined };
}
