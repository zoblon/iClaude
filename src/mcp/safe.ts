import { log, toUserMessage } from '../core/errors.js';
import { dataResult, textResult } from '../core/untrusted.js';

type ToolResult = ReturnType<typeof textResult> | ReturnType<typeof dataResult>;

/** Führt ein Tool aus: bereinigte Fehler statt Abstürze, Protokoll nur mit Metadaten. */
export async function guarded(tool: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const r = await fn();
    log('tool', { name: tool, ok: true, ms: Date.now() - t0 });
    return r;
  } catch (e) {
    log('tool', { name: tool, ok: false, ms: Date.now() - t0 });
    return textResult(toUserMessage(e), true);
  }
}
