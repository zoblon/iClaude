import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

describe('manifest.json', () => {
  it('is valid for the official tool (mcpb validate, as when packing with the icon in the same folder)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-validate-'));
    try {
      copyFileSync('manifest.json', join(dir, 'manifest.json'));
      copyFileSync(join('assets', 'icon.png'), join(dir, 'icon.png'));
      const r = spawnSync(resolve('node_modules', '.bin', 'mcpb'), ['validate', join(dir, 'manifest.json')], { encoding: 'utf8' });
      expect(r.stdout + r.stderr).toContain('Manifest schema validation passes');
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses manifest 0.3 and runs with the Node built into Claude Desktop', () => {
    expect(manifest.manifest_version).toBe('0.3');
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.entry_point).toBe('server/index.mjs');
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/server/index.mjs']);
  });

  it('the app password is sensitive (Keychain) and required; nothing sensitive has a default value', () => {
    const c = manifest.user_config;
    expect(c.app_password).toMatchObject({ type: 'string', sensitive: true, required: true });
    expect(c.app_password.default).toBeUndefined();
    for (const [k, v] of Object.entries<Record<string, unknown>>(c)) {
      if (v.default !== undefined) expect(k, 'only non-sensitive fields may have defaults').toMatch(/^(timezone)$/);
    }
  });

  it('every user_config setting is used, and every used one is defined', () => {
    const used = new Set([...JSON.stringify(manifest.server.mcp_config).matchAll(/\$\{user_config\.([a-z_]+)\}/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(Object.keys(manifest.user_config).sort());
  });

  it('the environment variables set are exactly those the code reads', () => {
    const code = readFileSync(join('src', 'core', 'config.ts'), 'utf8');
    const read = new Set([...code.matchAll(/get\('(ICLOUD_[A-Z_]+)'\)/g)].map((m) => m[1]));
    expect(Object.keys(manifest.server.mcp_config.env).sort()).toEqual([...read].sort());
  });

  it('the tool list in the manifest matches the tools registered in the code', () => {
    const registered = files('src').flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/registerTool\(\s*'([^']+)'/g)].map((m) => m[1]!));
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual([...registered].sort());
    expect(manifest.tools_generated).toBe(false);
    for (const t of manifest.tools) expect(t.description.length).toBeGreaterThan(5);
  });

  it('has required fields, an icon and a plausible runtime requirement', () => {
    for (const k of ['name', 'version', 'description', 'author', 'icon']) expect(manifest[k], k).toBeTruthy();
    expect(manifest.compatibility.runtimes.node).toMatch(/>=\s*20/); // imapflow requires Node 20
    expect(pkg.engines.node).toMatch(/>=\s*20/);
    expect(statSync(join('assets', 'icon.png')).size).toBeGreaterThan(1000);
  });

  it('the manifest version follows package.json (the build script syncs it)', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('the MCP server reports the same version as package.json', () => {
    const server = readFileSync(join('src', 'mcp', 'server.ts'), 'utf8');
    expect(/name: 'iClaude', version: '([^']+)'/.exec(server)?.[1]).toBe(pkg.version);
  });

  it('the description says exactly what is deleted and no longer claims "never deletes"', () => {
    const text = `${manifest.description}\n${manifest.long_description}`;
    expect(text).not.toMatch(/never deletes/i);
    expect(manifest.description).toMatch(/Never sends/);
    expect(manifest.description).toMatch(/Trash/);
    expect(manifest.description).toMatch(/backup/);
    expect(manifest.long_description).toMatch(/require approval/);
    expect(manifest.long_description).toMatch(/never deleted permanently|Nothing is ever deleted permanently/);
    expect(manifest.long_description).toMatch(/iCloud itself cannot restore individual deleted events/);
  });

  it('names the privacy policy, which exists in the repository and covers Reminders and Notes', () => {
    expect(manifest.privacy_policies).toEqual(['https://github.com/zoblon/iClaude/blob/main/PRIVACY.md']);
    const privacy = readFileSync('PRIVACY.md', 'utf8');
    expect(privacy).toMatch(/Reminders and Notes/);
    expect(privacy).toMatch(/no network connection/);
    expect(readFileSync('SECURITY.md', 'utf8')).toMatch(/Reminders/);
  });

  it('the descriptions mention Reminders and Notes and the Mac permission', () => {
    expect(manifest.description).toMatch(/Reminders and Notes/);
    expect(manifest.long_description).toMatch(/macOS asks once for permission/);
    expect(manifest.long_description).toMatch(/update_reminder/);
  });

  it('the display name is iClaude and the extension ID stays unchanged (otherwise a second extension without settings would appear next to the installed one)', () => {
    expect(manifest.display_name).toBe('iClaude');
    expect(manifest.name).toBe('icloud-connector');
    expect(manifest.author.name).toBe('Tobi Rehkopf');
  });

  it('delete_event and trash_message are in the tool list', () => {
    const names = manifest.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['delete_event', 'trash_message']));
  });
});
