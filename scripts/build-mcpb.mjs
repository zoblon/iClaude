/**
 * Baut die Desktop Extension (.mcpb):
 *  1. Bündelt den Server zu einer einzigen Datei (kein node_modules in der Erweiterung nötig).
 *  2. Legt Manifest und Symbol daneben, gleicht die Version mit package.json ab.
 *  3. Prüft das Manifest und packt es mit dem offiziellen Werkzeug (mcpb).
 *  4. Prüft das Paket (nur erwartete Dateien, keine Zugangsdaten).
 * Aufruf: npm run build:mcpb
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'build', 'stage');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const bin = (name) => join(root, 'node_modules', '.bin', name);

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
mkdirSync(dist, { recursive: true });

// 1) Bündeln
await build({
  entryPoints: [join(root, 'src', 'stdio.ts')],
  outfile: join(stage, 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Einige Abhängigkeiten laden Node-Module per require(); im ESM-Bündel muss es require geben.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  legalComments: 'external',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

// 2) Manifest (Version aus package.json) und Symbol
manifest.version = pkg.version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
cpSync(join(root, 'assets', 'icon.png'), join(stage, 'icon.png'));

// 3) Prüfen und packen
execFileSync(bin('mcpb'), ['validate', join(stage, 'manifest.json')], { stdio: 'inherit' });
const out = join(dist, `icloud-mcp-${pkg.version}.mcpb`);
rmSync(out, { force: true });
execFileSync(bin('mcpb'), ['pack', stage, out], { stdio: 'inherit' });

// 4) Paket prüfen: nur erwartete Dateien
const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).split('\n').filter(Boolean);
const allowed = [/^manifest\.json$/, /^icon\.png$/, /^server\/index\.mjs(\.LEGAL\.txt)?$/];
const unexpected = listing.filter((f) => !allowed.some((re) => re.test(f)));
if (unexpected.length) {
  console.error(`Unerwartete Dateien im Paket: ${unexpected.join(', ')}`);
  process.exit(1);
}
if (/(^|\/)\.env/.test(listing.join('\n'))) {
  console.error('Das Paket enthält eine .env-Datei.');
  process.exit(1);
}

// Zugangsdaten dürfen nirgends im Paket stehen (Werte aus .env, falls vorhanden; es wird nichts ausgegeben).
if (existsSync(join(root, '.env'))) {
  const secrets = readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .map((l) => /^ICLOUD_(APP_PASSWORD|APPLE_ID|MAIL_USER)=(.+)$/.exec(l.trim())?.[2]?.trim())
    .filter((v) => v && v.length >= 4);
  const unpacked = execFileSync('unzip', ['-p', out], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  if (secrets.some((s) => unpacked.includes(s))) {
    console.error('Im Paket stehen Zugangsdaten aus .env. Abbruch.');
    rmSync(out, { force: true });
    process.exit(1);
  }
}

const kb = Math.round(statSync(out).size / 1024);
console.log(`\nFertig: ${out.replace(root + '/', '')} (${kb} KB, ${listing.length} Dateien: ${listing.join(', ')})`);
