#!/usr/bin/env node
// Builds CHANGELOG.md from the git history. The file is never edited by hand, so two branches can't
// conflict over its content: if a rebase conflicts on it, take either side and run `pnpm changelog` again.
//
// Only user-facing commit types are listed (feat, fix, perf, security). docs/chore/ci/test/refactor commits are
// skipped, which is also why committing the regenerated file as `docs(changelog): ...` doesn't make it stale.
// Entries are grouped by author date in WIB. Author dates survive rebase merges, so the output is the same on a
// branch and on main after the merge.
//
//   node scripts/changelog.mjs           write CHANGELOG.md
//   node scripts/changelog.mjs --check   exit 1 if CHANGELOG.md is out of date (used by docs-check / CI)
//
// This file is identical in both Sampai Mana repos (api-sampaimana and sampaimana). Change both together.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'CHANGELOG.md');
const SECTIONS = [
  ['security', 'Keamanan'],
  ['feat', 'Fitur'],
  ['fix', 'Perbaikan'],
  ['perf', 'Performa'],
];
const SUBJECT = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;
const wib = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' });

export function readCommits(cwd = ROOT) {
  const out = execFileSync('git', ['log', '--no-merges', '--format=%aI%x1f%s%x1e', 'HEAD'], { cwd, encoding: 'utf8' });
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [date, subject] = r.split('\x1f');
      return { date, subject };
    });
}

export function render(commits) {
  const days = new Map();
  for (const c of commits) {
    const m = SUBJECT.exec(c.subject);
    if (!m) continue;
    const [, rawType, scope, bang, text] = m;
    // fix(security) is listed under Keamanan.
    const type = rawType === 'fix' && scope === 'security' ? 'security' : rawType;
    if (!SECTIONS.some(([t]) => t === type)) continue;
    const day = wib.format(new Date(c.date));
    if (!days.has(day)) days.set(day, []);
    days.get(day).push({ type, scope, breaking: Boolean(bang), text, at: Date.parse(c.date) });
  }

  const lines = [
    '# Changelog',
    '',
    '<!-- Dibuat otomatis oleh scripts/changelog.mjs dari commit feat/fix/perf/security. Jangan diedit manual: jalankan `pnpm changelog`. -->',
    '',
    'Perubahan yang terasa bagi pengguna, dikelompokkan per tanggal (WIB). Detail teknis ada di riwayat commit.',
  ];
  for (const day of [...days.keys()].sort().reverse()) {
    lines.push('', `## ${day}`);
    const entries = days.get(day).sort((a, b) => b.at - a.at || a.text.localeCompare(b.text));
    for (const [type, title] of SECTIONS) {
      const list = entries.filter((e) => e.type === type);
      if (!list.length) continue;
      lines.push('', `### ${title}`, '');
      for (const e of list) {
        const scope = e.scope && e.scope !== 'security' ? `**${e.scope}:** ` : '';
        lines.push(`- ${e.breaking ? '**BREAKING** ' : ''}${scope}${e.text}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function checkChangelog(cwd = ROOT) {
  const expected = render(readCommits(cwd));
  const file = path.join(cwd, 'CHANGELOG.md');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return current === expected;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (!checkChangelog()) {
      console.error('CHANGELOG.md belum sesuai riwayat commit. Jalankan `pnpm changelog` lalu commit hasilnya (docs(changelog): ...).');
      process.exit(1);
    }
    console.log('CHANGELOG.md sesuai riwayat commit.');
  } else {
    writeFileSync(FILE, render(readCommits()));
    console.log('CHANGELOG.md diperbarui.');
  }
}
