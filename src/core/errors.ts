/** Error whose message may be shown to the user (and Claude) unchanged. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Configured credentials; removed from every error message. */
const secrets = new Set<string>();

export function registerSecrets(...values: Array<string | undefined>): void {
  for (const v of values) if (v && v.length >= 4) secrets.add(v);
}

/** Removes credentials and URLs with embedded logins from text and truncates it. */
export function sanitize(text: string, max = 300): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  out = out
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***:***@')
    .replace(/authorization["':=\s]+(?:(?:basic|bearer)\s+)?[^\s,"']+/gi, 'authorization=***')
    .replace(/\b(?:basic|bearer)\s+[A-Za-z0-9+/=._-]{8,}/gi, '***')
    .replace(/(password|passwd|pass)["':=\s]+[^\s,"']+/gi, '$1=***')
    // Email addresses are not needed in error texts
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '***@***');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Turns any error into a sanitised, actionable message. */
export function toUserMessage(e: unknown): string {
  if (e instanceof UserError) return sanitize(e.message, 600);
  const raw = e instanceof Error ? e.message : String(e);
  const status = /\b(401|403)\b/.test(raw)
    ? 'iCloud sign-in failed. Check the Apple ID and app-specific password in the extension settings.'
    : /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(raw)
      ? 'iCloud is not reachable. Check the network connection and try again.'
      : `Unexpected error: ${sanitize(raw, 200)}. Please try again. If the error persists, turn the extension off and on again in Claude Desktop.`;
  return status;
}

/** Logs to stderr only, metadata only (never content or credentials). */
export function log(event: string, meta: Record<string, string | number | boolean> = {}): void {
  const parts = Object.entries(meta).map(([k, v]) => `${k}=${typeof v === 'string' ? sanitize(v, 80) : v}`);
  process.stderr.write(`[icloud-mcp] ${event}${parts.length ? ' ' + parts.join(' ') : ''}\n`);
}

/**
 * Rejects after ms (the request itself may keep running in the background).
 * `what` is an -ing phrase such as "loading the calendars"; the message always contains "Timeout".
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new UserError(`Timeout while ${what} (${Math.round(ms / 1000)} s). Please try again later.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
