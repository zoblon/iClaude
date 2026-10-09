/** Fehler mit einer Meldung, die dem Nutzer (und Claude) unverändert angezeigt werden darf. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Gesetzte Zugangsdaten; werden aus jeder Fehlermeldung entfernt. */
const secrets = new Set<string>();

export function registerSecrets(...values: Array<string | undefined>): void {
  for (const v of values) if (v && v.length >= 4) secrets.add(v);
}

/** Entfernt Zugangsdaten und URLs mit Login aus Text und kürzt ihn. */
export function sanitize(text: string, max = 300): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  out = out
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***:***@')
    .replace(/authorization["':=\s]+(?:(?:basic|bearer)\s+)?[^\s,"']+/gi, 'authorization=***')
    .replace(/\b(?:basic|bearer)\s+[A-Za-z0-9+/=._-]{8,}/gi, '***')
    .replace(/(password|passwd|pass)["':=\s]+[^\s,"']+/gi, '$1=***')
    // Mailadressen in Fehlertexten sind nicht nötig
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '***@***');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Wandelt beliebige Fehler in eine bereinigte, nutzbare Meldung um. */
export function toUserMessage(e: unknown): string {
  if (e instanceof UserError) return sanitize(e.message, 600);
  const raw = e instanceof Error ? e.message : String(e);
  const status = /\b(401|403)\b/.test(raw)
    ? 'Anmeldung bei iCloud fehlgeschlagen. Apple-ID und App-spezifisches Passwort in den Einstellungen der Extension prüfen.'
    : /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(raw)
      ? 'iCloud ist nicht erreichbar. Netzwerkverbindung prüfen und erneut versuchen.'
      : `Unerwarteter Fehler: ${sanitize(raw, 200)}. Bitte erneut versuchen. Tritt der Fehler wieder auf, die Extension in Claude Desktop aus- und wieder einschalten.`;
  return status;
}

/** Protokoll nur auf stderr, nur Metadaten (nie Inhalte oder Zugangsdaten). */
export function log(event: string, meta: Record<string, string | number | boolean> = {}): void {
  const parts = Object.entries(meta).map(([k, v]) => `${k}=${typeof v === 'string' ? sanitize(v, 80) : v}`);
  process.stderr.write(`[icloud-mcp] ${event}${parts.length ? ' ' + parts.join(' ') : ''}\n`);
}

/** Bricht ein Promise nach ms ab (die Anfrage selbst läuft ggf. im Hintergrund aus). */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new UserError(`Zeitüberschreitung bei ${what} (${Math.round(ms / 1000)} s). Bitte später erneut versuchen.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
