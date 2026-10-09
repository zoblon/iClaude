import { DateTime } from 'luxon';
import { UserError, registerSecrets } from './errors.js';

export interface Config {
  /** Apple ID (login for CalDAV and CardDAV). */
  appleId: string;
  /** @icloud.com address (login for IMAP, sender of drafts). */
  mailUser: string;
  appPassword: string;
  timezone: string;
  /** Name of the default calendar for new events (must be private). */
  defaultCalendar: string | undefined;
}

/** Reads the configuration from environment variables. Error messages never contain values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (k: string) => {
    const v = (env[k] ?? '').trim();
    // Unreplaced placeholders from the extension manifest count as empty.
    return v.startsWith('${') ? '' : v;
  };
  const missing: string[] = [];
  const appleId = get('ICLOUD_APPLE_ID');
  const mailUser = get('ICLOUD_MAIL_USER');
  const appPassword = get('ICLOUD_APP_PASSWORD');
  if (!appleId) missing.push('Apple ID');
  if (!mailUser) missing.push('iCloud email address');
  if (!appPassword) missing.push('app-specific password');
  if (missing.length) {
    throw new UserError(`Configuration incomplete: missing ${missing.join(', ')}. Please fill it in in the extension settings.`);
  }
  registerSecrets(appPassword, appleId, mailUser);

  const timezone = get('ICLOUD_TIMEZONE') || 'Europe/Berlin';
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new UserError(`Unknown time zone "${timezone}". Example: Europe/Berlin`);
  }
  return { appleId, mailUser, appPassword, timezone, defaultCalendar: get('ICLOUD_DEFAULT_CALENDAR') || undefined };
}
