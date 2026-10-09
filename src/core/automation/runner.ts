import { execFile } from 'node:child_process';
import { z } from 'zod';
import { UserError, log } from '../errors.js';

/**
 * A fixed JavaScript for Automation (JXA) script. The text is a constant of the program, never assembled at run time.
 * Input reaches it only as ONE JSON argument of `function run(argv)`; it answers with ONE JSON text.
 */
export interface AutomationScript {
  /** For log lines and error messages (no content). */
  readonly name: string;
  /** The app the script controls; the first call per app may wait for the macOS permission prompt. */
  readonly app: 'Reminders' | 'Notes';
  /** Longer limit for scripts that make many Apple events (every event to Reminders takes about half a second). */
  readonly timeoutMs?: number;
  readonly source: string;
}

/** Runs scripts and returns their validated answer. Replaceable (the unit tests use a fake). */
export interface ScriptRunner {
  run<T>(script: AutomationScript, input: unknown, schema: z.ZodType<T>): Promise<T>;
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; killSignal: NodeJS.Signals },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // execFile: no shell, so nothing in the arguments is ever interpreted by a shell.
    execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });

/** Largest input (JSON text) handed to a script. Arguments are limited by the operating system anyway. */
export const MAX_INPUT_BYTES = 400_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

/** The envelope every script answers with. */
const envelope = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.string().max(40), message: z.string().max(300) }),
]);

export const OSASCRIPT = '/usr/bin/osascript';

export function permissionHelp(app: string): string {
  return (
    `macOS has not allowed iClaude to control ${app}. Open System Settings > Privacy & Security > Automation, ` +
    `find Claude (or the app that runs the extension) and turn on ${app}. If there is no entry yet, call the tool again and answer the macOS question "wants to control ${app}" with OK.`
  );
}

/** Codes a script reports itself; the message is written by the script and contains no user content. */
export class AutomationRefusal extends UserError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs JXA scripts with /usr/bin/osascript. Only on macOS. One script at a time.
 * The script text goes in as `-e <text>`, the input as the single argument that arrives in `run(argv)`.
 */
export class OsascriptRunner implements ScriptRunner {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly warm = new Set<string>();

  constructor(
    private readonly opts: { platform?: string; exec?: ExecFn; timeoutMs?: number; firstTimeoutMs?: number } = {},
  ) {}

  async run<T>(script: AutomationScript, input: unknown, schema: z.ZodType<T>): Promise<T> {
    const platform = this.opts.platform ?? process.platform;
    if (platform !== 'darwin') {
      throw new UserError('Apple Reminders and Notes are only available on macOS. This connector controls those apps on the Mac it runs on.');
    }
    const json = JSON.stringify(input ?? {});
    if (Buffer.byteLength(json) > MAX_INPUT_BYTES) throw new UserError('The input is too large. Please shorten the text.');

    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    await prev.catch(() => undefined);
    const t0 = Date.now();
    try {
      const timeout = this.warm.has(script.app) ? Math.max(this.opts.timeoutMs ?? 30_000, script.timeoutMs ?? 0) : Math.max(this.opts.firstTimeoutMs ?? 120_000, script.timeoutMs ?? 0);
      let stdout: string;
      try {
        ({ stdout } = await (this.opts.exec ?? defaultExec)(OSASCRIPT, ['-l', 'JavaScript', '-e', script.source, json], { timeout, maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL' }));
      } catch (e) {
        throw this.explain(e, script, timeout);
      }
      this.warm.add(script.app);
      let parsed: z.infer<typeof envelope>;
      try {
        parsed = envelope.parse(JSON.parse(stdout.trim()));
      } catch {
        throw new UserError(`${script.app} gave an answer that could not be understood. Please try again.`);
      }
      if (!parsed.ok) {
        if (parsed.code === 'NOT_AUTHORIZED') throw new UserError(permissionHelp(script.app));
        throw new AutomationRefusal(parsed.code, parsed.message);
      }
      const out = schema.safeParse(parsed.data);
      if (!out.success) throw new UserError(`${script.app} gave an answer in an unexpected format. Please try again.`);
      return out.data;
    } finally {
      log('automation', { script: script.name, ms: Date.now() - t0 });
      release();
    }
  }

  private explain(e: unknown, script: AutomationScript, timeout: number): UserError {
    const err = e as { killed?: boolean; signal?: string; code?: unknown; stderr?: string; message?: string };
    const text = `${err.stderr ?? ''} ${err.message ?? ''}`;
    if (err.killed || err.signal === 'SIGKILL') {
      return new UserError(
        `${script.app} did not answer within ${Math.round(timeout / 1000)} s and the request was stopped. ` +
          `If macOS is asking for permission to control ${script.app}, answer it and try again; otherwise try again later.`,
      );
    }
    if (/-1743|Not authorized to send Apple events|nicht berechtigt/i.test(text)) return new UserError(permissionHelp(script.app));
    if (/-1712/.test(text)) return new UserError(`${script.app} did not answer in time (Apple event timeout). Please try again. If macOS asks for permission, answer it first.`);
    if (/-600\b|isn.t running|nicht geöffnet|läuft nicht/i.test(text)) return new UserError(`${script.app} could not be started. Please open it once and try again.`);
    if (err.code === 'ENOENT') return new UserError('osascript was not found. This connector needs macOS.');
    // Never repeat the output of the script or of the app: it may contain content.
    return new UserError(`Controlling ${script.app} failed${typeof err.code === 'number' ? ` (exit code ${err.code})` : ''}. Please try again.`);
  }
}
