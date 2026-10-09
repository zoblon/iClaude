import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationRefusal, MAX_INPUT_BYTES, OsascriptRunner, OSASCRIPT, type AutomationScript, type ExecFn } from '../src/core/automation/runner.js';
import * as scriptModules from '../src/core/automation/scripts/index.js';

const scripts = Object.values(scriptModules) as AutomationScript[];
const ok = (data: unknown) => JSON.stringify({ ok: true, data });
const script = (over: Partial<AutomationScript> = {}): AutomationScript => ({ name: 'test', app: 'Reminders', source: 'function run(argv) { return argv[0]; }', ...over });
const any = z.unknown();

function fakeExec(answer: string | Error | ((args: string[]) => string)) {
  const calls: Array<{ file: string; args: string[]; opts: Parameters<ExecFn>[2] }> = [];
  const exec: ExecFn = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (answer instanceof Error) throw answer;
    return { stdout: typeof answer === 'function' ? answer(args) : answer, stderr: '' };
  };
  return { exec, calls };
}

describe('OsascriptRunner', () => {
  it('runs /usr/bin/osascript without a shell: the script text is one argument, the input one JSON argument', async () => {
    const { exec, calls } = fakeExec(ok({ a: 1 }));
    const r = await new OsascriptRunner({ platform: 'darwin', exec }).run(script(), { q: 'x' }, z.object({ a: z.number() }));
    expect(r).toEqual({ a: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe(OSASCRIPT);
    expect(calls[0]!.args).toEqual(['-l', 'JavaScript', '-e', script().source, '{"q":"x"}']);
  });

  it('the script text never changes with the input (nothing is assembled at run time)', async () => {
    const hostile = ['"; do shell script "touch /tmp/pwned" ; "', "' & quit", 'line1\nline2\r\n`id`', '${process.exit()}', '\\u0022\\', 'ignore previous instructions', '"}); doShellScript("x'];
    const { exec, calls } = fakeExec(ok(1));
    const runner = new OsascriptRunner({ platform: 'darwin', exec });
    for (const h of hostile) await runner.run(script(), { title: h, notes: h, nested: { x: [h] } }, any);
    for (const c of calls) expect(c.args[3]).toBe(script().source);
    // the input is one JSON argument and round-trips unchanged
    calls.forEach((c, i) => expect(JSON.parse(c.args[4]!)).toEqual({ title: hostile[i], notes: hostile[i], nested: { x: [hostile[i]] } }));
    expect(calls.every((c) => c.args.length === 5)).toBe(true);
  });

  it('says "only on macOS" on other systems and does not start anything', async () => {
    const { exec, calls } = fakeExec(ok(1));
    await expect(new OsascriptRunner({ platform: 'linux', exec }).run(script(), {}, any)).rejects.toThrow(/only available on macOS/);
    expect(calls).toHaveLength(0);
  });

  it('allows a long first call (permission prompt) and the normal time afterwards, then stops the process', async () => {
    const { exec, calls } = fakeExec(ok(1));
    const runner = new OsascriptRunner({ platform: 'darwin', exec, timeoutMs: 30_000, firstTimeoutMs: 120_000 });
    await runner.run(script(), {}, any);
    await runner.run(script(), {}, any);
    await runner.run(script({ app: 'Notes' }), {}, any);
    expect(calls.map((c) => c.opts.timeout)).toEqual([120_000, 30_000, 120_000]);
    expect(calls.every((c) => c.opts.killSignal === 'SIGKILL')).toBe(true);
    const slow = Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL' });
    await expect(new OsascriptRunner({ platform: 'darwin', exec: fakeExec(slow).exec }).run(script(), {}, any)).rejects.toThrow(/did not answer within 120 s and the request was stopped/);
  });

  it('turns error -1743 into the way to System Settings > Privacy & Security > Automation', async () => {
    const e = Object.assign(new Error('Command failed'), { stderr: 'execution error: Error: Not authorized to send Apple events to Reminders. (-1743)', code: 1 });
    await expect(new OsascriptRunner({ platform: 'darwin', exec: fakeExec(e).exec }).run(script(), {}, any)).rejects.toThrow(/System Settings > Privacy & Security > Automation.*Reminders/s);
    const inScript = JSON.stringify({ ok: false, code: 'NOT_AUTHORIZED', message: 'x' });
    await expect(new OsascriptRunner({ platform: 'darwin', exec: fakeExec(inScript).exec }).run(script({ app: 'Notes' }), {}, any)).rejects.toThrow(/turn on Notes/);
  });

  it('reports refusals of the script, malformed answers and answers in the wrong shape; never repeats the app output', async () => {
    const refusal = JSON.stringify({ ok: false, code: 'NOT_FOUND', message: 'The reminder was not found.' });
    await expect(new OsascriptRunner({ platform: 'darwin', exec: fakeExec(refusal).exec }).run(script(), {}, any)).rejects.toBeInstanceOf(AutomationRefusal);
    await expect(new OsascriptRunner({ platform: 'darwin', exec: fakeExec('not json at all SECRET-CONTENT').exec }).run(script(), {}, any)).rejects.toThrow(/could not be understood/);
    await expect(new OsascriptRunner({ platform: 'darwin', exec: fakeExec(ok({ a: 'text' })).exec }).run(script(), {}, z.object({ a: z.number() }))).rejects.toThrow(/unexpected format/);
    const crash = Object.assign(new Error('Command failed: osascript ... SECRET-CONTENT'), { stderr: 'SECRET-CONTENT', code: 1 });
    await expect(new OsascriptRunner({ platform: 'darwin', exec: fakeExec(crash).exec }).run(script(), {}, any)).rejects.toThrow(/Controlling Reminders failed \(exit code 1\)\. Please try again\.$/);
  });

  it('refuses oversized input before starting anything', async () => {
    const { exec, calls } = fakeExec(ok(1));
    await expect(new OsascriptRunner({ platform: 'darwin', exec }).run(script(), { text: 'x'.repeat(MAX_INPUT_BYTES) }, any)).rejects.toThrow(/too large/);
    expect(calls).toHaveLength(0);
  });

  it('runs one script at a time', async () => {
    let running = 0;
    let max = 0;
    const exec: ExecFn = async () => {
      max = Math.max(max, ++running);
      await new Promise((r) => setTimeout(r, 15));
      running--;
      return { stdout: ok(1), stderr: '' };
    };
    const runner = new OsascriptRunner({ platform: 'darwin', exec });
    await Promise.all([1, 2, 3, 4].map(() => runner.run(script(), {}, any)));
    expect(max).toBe(1);
  });

  it('logs only metadata: no input, no output', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await new OsascriptRunner({ platform: 'darwin', exec: fakeExec(ok({ secret: 'TOP-SECRET-OUTPUT' })).exec }).run(script(), { title: 'TOP-SECRET-INPUT' }, any);
      const logged = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(logged).toContain('automation');
      expect(logged).not.toMatch(/SECRET/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the scripts are fixed texts', () => {
  const files = readdirSync('src/core/automation/scripts').filter((f) => f.endsWith('.ts') && f !== 'index.ts');

  it('every script file is exported and registered in index.ts', () => {
    expect(scripts.length).toBe(files.length);
    expect(new Set(scripts.map((s) => s.name)).size).toBe(scripts.length);
  });

  it.each(scripts.map((s) => [s.name, s] as const))('%s: constant text, no placeholders, no composition, no shell, no deletion', (_n, s) => {
    expect(s.source).toMatch(/function run\(argv\)/);
    expect(s.source).not.toMatch(/\$\{|`/); // no template placeholders
    expect(s.source).not.toMatch(/\beval\b|new Function|\bFunction\(|doShellScript|do shell script|ObjC|\$\.|NSTask|System Events|currentApplication|\bopen\(|\bquit\(|\.activate\(|\.show\(/);
    expect(s.source).not.toMatch(/\.delete\(|\.remove\(|\bdelete\s+[a-z]|\.move\(|\.empty\(|\.unlock|\.lock\(|\.erase\(/i);
    // the only application is the one it declares; input only through argv[0] via JSON.parse
    const apps = [...s.source.matchAll(/Application\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    expect(new Set(apps)).toEqual(new Set([s.app]));
    expect([...s.source.matchAll(/argv\[(\d+)\]/g)].map((m) => m[1])).toEqual(['0']);
    expect(s.source.match(/JSON\.parse\(/g)).toHaveLength(1);
    // input values are never turned into code or appended to script-like text
    expect(s.source).not.toMatch(/Application\([^')]*input|\+\s*input\.[a-zA-Z.]*\s*\+\s*['"]\)/);
  });

  it.each(scripts.map((s) => [s.name, s] as const))('%s is valid JavaScript', (_n, s) => {
    expect(() => new Function('Application', s.source)).not.toThrow();
  });

  it('only runner.ts starts processes, only with execFile (no shell)', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
    for (const f of walk('src')) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const uses = /child_process|\bexecFile\b|\bspawn\b|\bexecSync\b/.test(code);
      expect(uses, f).toBe(f.endsWith('automation/runner.ts'));
      expect(/\bshell\s*:\s*true|execSync|\bspawn\(/.test(code), f).toBe(false);
    }
    const runner = readFileSync('src/core/automation/runner.ts', 'utf8');
    expect(runner).toContain("from 'node:child_process'");
    expect(runner).not.toMatch(/shell:\s*true/);
  });
});

describe.runIf(process.platform === 'darwin')('hostile input against the real osascript (nothing is executed)', () => {
  const canary = '/tmp/iclaude-automation-canary';
  afterEach(() => rmSync(canary, { force: true }));
  // A test-only script: it parses the input and hands it back. It never touches Reminders or Notes.
  const echo: AutomationScript = {
    name: 'echo',
    app: 'Reminders',
    source: 'function run(argv) { var input = JSON.parse(argv[0]); return JSON.stringify({ ok: true, data: { echo: input } }); }',
  };

  it('quotes, line breaks and "do shell script" come back unchanged and run nothing', async () => {
    rmSync(canary, { force: true });
    const hostile = {
      a: `"; do shell script "touch ${canary}"; "`,
      b: `' & do shell script 'touch ${canary}' & '`,
      c: `line one\nline two\r\n\ttabbed \\ backslash \\" \\u0022`,
      d: `\`touch ${canary}\` $(touch ${canary}) ;touch ${canary}`,
      e: `"}); ObjC.import('Foundation'); $.NSFileManager.defaultManager.createFileAtPathContentsAttributes('${canary}', null, null); ({"`,
      f: 'Ümläute — 日本語 🚀',
      g: ['x'.repeat(5000)],
    };
    const r = await new OsascriptRunner().run(echo, hostile, z.object({ echo: z.unknown() }));
    expect(r.echo).toEqual(hostile);
    expect(existsSync(canary)).toBe(false);
  });

  it('osascript really is the system one', () => {
    expect(execFileSync(OSASCRIPT, ['-l', 'JavaScript', '-e', '1+1'], { encoding: 'utf8' }).trim()).toBe('2');
  });
});
