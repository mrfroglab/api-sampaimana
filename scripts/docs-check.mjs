#!/usr/bin/env node
// Catches documentation drift that a machine can see. Runs in CI and in the pre-commit hook: `pnpm docs:check`.
// The map of every doc in both repos lives in the web repo: docs/README.md.
//
//   --no-changelog   skip the CHANGELOG freshness check (pre-commit and local runs mid-branch)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChangelog } from './changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const problems = [];
const fail = (check, msg) => problems.push(`[${check}] ${msg}`);

const mdFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && existsSync(path.join(ROOT, f)));

// 1. Relative links in Markdown point to files that exist.
for (const file of mdFiles) {
  const text = read(file).replace(/```[\s\S]*?```/g, '');
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
    const rel = decodeURI(target.split('#')[0]);
    if (!existsSync(path.resolve(ROOT, path.dirname(file), rel))) fail('links', `${file}: tautan rusak → ${target}`);
  }
}

// 2. No hand-written counts that go stale (test totals and the like). Point to the command instead.
for (const file of mdFiles.filter((f) => f !== 'CHANGELOG.md')) {
  const m = read(file).match(/\b\d+\s+(?:unit\s+|integration\s+)?test\b/i);
  if (m) fail('counts', `${file}: hindari angka yang cepat basi ("${m[0]}"); sebut perintahnya saja`);
}

// 3. Every Markdown file is listed in the README "Dokumentasi" section (and, by hand, in the web repo's docs map).
const readme = read('README.md');
for (const file of mdFiles.filter((f) => f !== 'README.md')) {
  if (!readme.includes(`](${file})`)) fail('docs-map', `${file} belum tercantum di bagian "Dokumentasi" README.md`);
}

// 4. .env.example lists exactly the variables validated in src/config/env.js.
const envSchema = read('src/config/env.js');
const schemaKeys = new Set([...envSchema.matchAll(/^ {4}([A-Z][A-Z0-9_]+):\s*z/gm)].map((m) => m[1]));
const exampleKeys = new Set(
  [...read('.env.example').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]).filter((k) => !k.startsWith('SEED_')),
);
for (const k of schemaKeys) if (!exampleKeys.has(k)) fail('env', `${k} ada di src/config/env.js tetapi belum di .env.example`);
for (const k of exampleKeys) if (!schemaKeys.has(k)) fail('env', `${k} ada di .env.example tetapi tidak divalidasi di src/config/env.js`);

// 5. Every Express route is described in src/docs/openapi.js, and nothing described there is gone.
const mounts = new Map(); // module file -> URL prefix
for (const [, prefix, mod] of read('src/app.js').matchAll(/app\.use\('([^']+)',\s*require\('\.\/modules\/([\w-]+)'\)\)/g)) {
  mounts.set(mod, prefix);
}
for (const [mod, prefix] of [...mounts]) {
  for (const [, child] of read(`src/modules/${mod}.js`).matchAll(/router\.use\(require\('\.\/([\w-]+)'\)\)/g)) mounts.set(child, prefix);
}
const routes = new Set();
for (const [mod, prefix] of mounts) {
  for (const [, method, p] of read(`src/modules/${mod}.js`).matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
    const full = `${prefix}${p === '/' ? '' : p}`.replace(/:(\w+)/g, '{$1}');
    routes.add(`${method.toUpperCase()} ${full}`);
  }
}
const openapi = createRequire(import.meta.url)(path.join(ROOT, 'src/docs/openapi.js'));
const documented = new Set(
  Object.entries(openapi.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)),
);
for (const r of routes) if (!documented.has(r)) fail('openapi', `${r} belum dideskripsikan di src/docs/openapi.js`);
for (const d of documented) if (!routes.has(d)) fail('openapi', `${d} ada di src/docs/openapi.js tetapi rutenya tidak ditemukan`);

// 6. CHANGELOG.md is regenerated from history.
if (!process.argv.includes('--no-changelog') && !checkChangelog(ROOT)) {
  fail('changelog', 'CHANGELOG.md belum sesuai riwayat commit; jalankan `pnpm changelog` lalu commit hasilnya');
}

if (problems.length) {
  console.error(`docs-check: ${problems.length} masalah\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('docs-check: dokumentasi sinkron.');
