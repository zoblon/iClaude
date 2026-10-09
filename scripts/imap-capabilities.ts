/**
 * Diagnose: meldet sich bei iCloud-Mail an und zeigt die Fähigkeiten des Servers nach der Anmeldung
 * (vor allem MOVE und SPECIAL-USE) sowie Ordnernamen mit ihren Spezialordner-Merkmalen.
 *
 * Rein lesend: nur CAPABILITY und LIST, keine Nachricht wird geöffnet oder verändert.
 * Ausgabe enthält nur Namen, keine Inhalte und keine Zugangsdaten.
 * Start: npm run imap-capabilities
 */
import { ImapFlow } from 'imapflow';

const env = (k: string) => (process.env[k] ?? '').trim();
const user = env('ICLOUD_MAIL_USER');
const pass = env('ICLOUD_APP_PASSWORD');
if (!user || !pass) {
  console.error('Fehlende Werte in .env: ICLOUD_MAIL_USER oder ICLOUD_APP_PASSWORD');
  process.exit(1);
}

const clean = (e: unknown) => {
  let m = e instanceof Error ? e.message : String(e);
  for (const s of [pass, user]) m = m.split(s).join('***');
  return m.slice(0, 300);
};

const client = new ImapFlow({ host: 'imap.mail.me.com', port: 993, secure: true, auth: { user, pass }, logger: false, disableAutoIdle: true });
client.on('error', () => undefined);
try {
  await client.connect();
  const caps = [...client.capabilities.keys()].sort();
  console.log(`Fähigkeiten nach der Anmeldung (${caps.length}):\n  ${caps.join(' ')}`);
  for (const c of ['MOVE', 'SPECIAL-USE', 'UIDPLUS', 'UNSELECT', 'XLIST']) console.log(`${c.padEnd(12)} ${client.capabilities.has(c) ? 'JA' : 'nein'}`);
  console.log('\nOrdner (Name | Merkmale | von imapflow erkannte Rolle):');
  for (const e of await client.list()) {
    console.log(`  ${e.path} | ${[...(e.flags ?? [])].join(' ') || '-'} | ${e.specialUse ?? '-'} (${e.specialUseSource ?? '-'})`);
  }
} catch (e) {
  console.log(`FEHLER: ${clean(e)}`);
  process.exitCode = 1;
} finally {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}
