import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './core/config.js';
import { log, toUserMessage } from './core/errors.js';
import { createServer } from './mcp/server.js';

try {
  const cfg = loadConfig();
  serveStdio(() => createServer(cfg), { onerror: (e) => log('transport-error', { kind: e.name }) });
  log('start', { timezone: cfg.timezone });
} catch (e) {
  process.stderr.write(`[icloud-mcp] Startup failed: ${toUserMessage(e)}\n`);
  process.exit(1);
}
