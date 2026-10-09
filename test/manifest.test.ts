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
  it('ist für das offizielle Werkzeug gültig (mcpb validate, wie beim Packen mit Symbol im selben Ordner)', () => {
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

  it('nutzt Manifest 0.3 und läuft mit dem eingebauten Node von Claude Desktop', () => {
    expect(manifest.manifest_version).toBe('0.3');
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.entry_point).toBe('server/index.mjs');
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/server/index.mjs']);
  });

  it('das App-Passwort ist sensitiv (Schlüsselbund) und Pflicht, nichts Sensibles hat einen Vorgabewert', () => {
    const c = manifest.user_config;
    expect(c.app_password).toMatchObject({ type: 'string', sensitive: true, required: true });
    expect(c.app_password.default).toBeUndefined();
    for (const [k, v] of Object.entries<Record<string, unknown>>(c)) {
      if (v.default !== undefined) expect(k, 'nur unkritische Felder dürfen Vorgaben haben').toMatch(/^(timezone)$/);
    }
  });

  it('jede Einstellung aus user_config wird verwendet, und jede verwendete ist definiert', () => {
    const used = new Set([...JSON.stringify(manifest.server.mcp_config).matchAll(/\$\{user_config\.([a-z_]+)\}/g)].map((m) => m[1]));
    expect([...used].sort()).toEqual(Object.keys(manifest.user_config).sort());
  });

  it('die gesetzten Umgebungsvariablen sind genau die, die der Code liest', () => {
    const code = readFileSync(join('src', 'core', 'config.ts'), 'utf8');
    const read = new Set([...code.matchAll(/get\('(ICLOUD_[A-Z_]+)'\)/g)].map((m) => m[1]));
    expect(Object.keys(manifest.server.mcp_config.env).sort()).toEqual([...read].sort());
  });

  it('die Werkzeugliste im Manifest entspricht den im Code registrierten Werkzeugen', () => {
    const registered = files('src').flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/registerTool\(\s*'([^']+)'/g)].map((m) => m[1]!));
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual([...registered].sort());
    expect(manifest.tools_generated).toBe(false);
    for (const t of manifest.tools) expect(t.description.length).toBeGreaterThan(5);
  });

  it('hat Pflichtangaben, Symbol und eine plausible Laufzeitvorgabe', () => {
    for (const k of ['name', 'version', 'description', 'author', 'icon']) expect(manifest[k], k).toBeTruthy();
    expect(manifest.compatibility.runtimes.node).toMatch(/>=\s*20/); // imapflow verlangt Node 20
    expect(pkg.engines.node).toMatch(/>=\s*20/);
    expect(statSync(join('assets', 'icon.png')).size).toBeGreaterThan(1000);
  });

  it('die Version im Manifest folgt package.json (das Build-Skript gleicht sie ab)', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('der MCP-Server meldet dieselbe Version wie package.json', () => {
    const server = readFileSync(join('src', 'mcp', 'server.ts'), 'utf8');
    expect(/name: 'iClaude', version: '([^']+)'/.exec(server)?.[1]).toBe(pkg.version);
  });

  it('die Beschreibung sagt genau, was gelöscht wird, und behauptet nicht mehr "löscht nie"', () => {
    const text = `${manifest.description}\n${manifest.long_description}`;
    expect(text).not.toMatch(/Löscht und sendet nie/i);
    expect(manifest.description).toMatch(/Sendet nie/);
    expect(manifest.description).toMatch(/Papierkorb/);
    expect(manifest.description).toMatch(/Sicherung/);
    expect(manifest.long_description).toMatch(/Nachfragen/);
    expect(manifest.long_description).toMatch(/nie endgültig|Endgültig gelöscht wird nie/);
    expect(manifest.long_description).toMatch(/iCloud selbst kann einzelne gelöschte Termine nicht wiederherstellen/);
  });

  it('der Anzeigename ist iClaude, die Kennung der Erweiterung bleibt unverändert (sonst entstünde neben der installierten eine zweite Erweiterung ohne Einstellungen)', () => {
    expect(manifest.display_name).toBe('iClaude');
    expect(manifest.name).toBe('icloud-connector');
    expect(manifest.author.name).toBe('Tobi Rehkopf');
  });

  it('delete_event und trash_message stehen in der Werkzeugliste', () => {
    const names = manifest.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['delete_event', 'trash_message']));
  });
});
