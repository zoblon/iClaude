/**
 * Builds the Desktop Extension (.mcpb):
 *  1. Bundles the server into a single file (no node_modules needed in the extension).
 *  2. Places the manifest and icon next to it and syncs the version with package.json.
 *  3. Validates the manifest and packs it with the official tool (mcpb).
 *  4. Checks the package (only expected files, no credentials).
 * Usage: npm run build:mcpb
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

// 1) Bundle
await build({
  entryPoints: [join(root, 'src', 'stdio.ts')],
  outfile: join(stage, 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Some dependencies load Node modules via require(); the ESM bundle has to provide require.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  legalComments: 'external',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

// Notices for bundled code whose license asks for them (esbuild only keeps license comments).
const legalFile = join(stage, 'server', 'index.mjs.LEGAL.txt');
const notices = [
  '\n\n==== unpdf (MIT) — bundles PDF.js ====\n',
  readFileSync(join(root, 'node_modules', 'unpdf', 'LICENSE'), 'utf8'),
  '\n==== PDF.js (Apache-2.0), bundled inside unpdf ====',
  'Copyright Mozilla Foundation and contributors. Licensed under the Apache License, Version 2.0',
  '(https://www.apache.org/licenses/LICENSE-2.0). PDF.js: https://github.com/mozilla/pdf.js',
  '',
].join('\n');
writeFileSync(legalFile, (existsSync(legalFile) ? readFileSync(legalFile, 'utf8') : '') + notices);

// 2) Manifest (version from package.json) and icon
manifest.version = pkg.version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
cpSync(join(root, 'assets', 'icon.png'), join(stage, 'icon.png'));

// 3) Validate and pack
execFileSync(bin('mcpb'), ['validate', join(stage, 'manifest.json')], { stdio: 'inherit' });
const out = join(dist, `icloud-mcp-${pkg.version}.mcpb`);
rmSync(out, { force: true });
execFileSync(bin('mcpb'), ['pack', stage, out], { stdio: 'inherit' });

// 4) Check the package: only expected files
const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).split('\n').filter(Boolean);
const allowed = [/^manifest\.json$/, /^icon\.png$/, /^server\/index\.mjs(\.LEGAL\.txt)?$/];
const unexpected = listing.filter((f) => !allowed.some((re) => re.test(f)));
if (unexpected.length) {
  console.error(`Unexpected files in the package: ${unexpected.join(', ')}`);
  process.exit(1);
}
if (/(^|\/)\.env/.test(listing.join('\n'))) {
  console.error('The package contains a .env file.');
  process.exit(1);
}

// The packaged icon must be the current repository asset, byte for byte.
const packedIcon = execFileSync('unzip', ['-p', out, 'icon.png']);
if (!packedIcon.equals(readFileSync(join(root, 'assets', 'icon.png')))) {
  console.error('The packaged icon differs from assets/icon.png.');
  process.exit(1);
}

// Credentials must not appear anywhere in the package (values from .env, if present; nothing is printed).
if (existsSync(join(root, '.env'))) {
  const secrets = readFileSync(join(root, '.env'), 'utf8')
    .split('\n')
    .map((l) => /^ICLOUD_(APP_PASSWORD|APPLE_ID|MAIL_USER)=(.+)$/.exec(l.trim())?.[2]?.trim())
    .filter((v) => v && v.length >= 4);
  const unpacked = execFileSync('unzip', ['-p', out], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  if (secrets.some((s) => unpacked.includes(s))) {
    console.error('The package contains credentials from .env. Aborting.');
    rmSync(out, { force: true });
    process.exit(1);
  }
}

const kb = Math.round(statSync(out).size / 1024);
console.log(`\nDone: ${out.replace(root + '/', '')} (${kb} KB, ${listing.length} files: ${listing.join(', ')})`);
