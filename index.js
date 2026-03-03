#!/usr/bin/env node

import { execSync } from 'child_process';
import { request } from 'https';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── CLI arg parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  ai:     args.includes('--ai'),
  copy:   args.includes('--copy'),
  open:   args.includes('--open'),
  help:   args.includes('--help') || args.includes('-h'),
  format: 'markdown',
  base:   'main',
};

const baseIdx = args.indexOf('--base');
if (baseIdx !== -1 && args[baseIdx + 1]) flags.base = args[baseIdx + 1];

const fmtIdx = args.indexOf('--format');
if (fmtIdx !== -1 && args[fmtIdx + 1]) flags.format = args[fmtIdx + 1];

// ── Help ─────────────────────────────────────────────────────────────────────

if (flags.help) {
  console.log(`
pr-summary  Auto-generate PR descriptions from your git diff.

Usage:
  npx pr-summary [options]

Options:
  --base <branch>       Base branch to compare against (default: main)
  --ai                  AI-polished summary via ANTHROPIC_API_KEY
  --copy                Copy output to clipboard
  --open                Open a draft PR using gh CLI
  --format <fmt>        Output format: markdown | github (default: markdown)
  --help, -h            Show this help

Examples:
  npx pr-summary
  npx pr-summary --ai --copy
  npx pr-summary --base develop --open
`);
  process.exit(0);
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function git(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function ensureGitRepo() {
  const result = git('git rev-parse --is-inside-work-tree');
  if (result !== 'true') {
    console.error('Error: not inside a git repository.');
    process.exit(1);
  }
}

function getCommits(base) {
  const raw = git(`git log origin/${base}..HEAD --format=%s`)
    || git(`git log ${base}..HEAD --format=%s`);
  return raw ? raw.split('\n').filter(Boolean) : [];
}

function getCommitCount(base) {
  const raw = git(`git rev-list --count origin/${base}..HEAD`)
    || git(`git rev-list --count ${base}..HEAD`);
  return parseInt(raw, 10) || 0;
}

function getDiffStat(base) {
  return git(`git diff origin/${base}..HEAD --stat`)
    || git(`git diff ${base}..HEAD --stat`);
}

function getNameStatus(base) {
  const raw = git(`git diff origin/${base}..HEAD --name-status`)
    || git(`git diff ${base}..HEAD --name-status`);
  return raw ? raw.split('\n').filter(Boolean) : [];
}

function getBranchName() {
  return git('git rev-parse --abbrev-ref HEAD') || 'unknown';
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function parseNameStatus(lines) {
  const added = [], modified = [], deleted = [], renamed = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0];
    const file = parts[parts.length - 1];
    if (!file) continue;
    if (status === 'A')              added.push(file);
    else if (status === 'M')         modified.push(file);
    else if (status === 'D')         deleted.push(file);
    else if (status.startsWith('R')) renamed.push(file);
  }
  return { added, modified, deleted, renamed };
}

function parseDiffStat(stat) {
  const match = stat.match(/(\d+) files? changed(?:,\s*(\d+) insertions?)?(?:,\s*(\d+) deletions?)?/);
  if (!match) return { files: 0, added: 0, deleted: 0 };
  return {
    files:   parseInt(match[1], 10) || 0,
    added:   parseInt(match[2], 10) || 0,
    deleted: parseInt(match[3], 10) || 0,
  };
}

function detectBreakingChanges(commits) {
  return commits.some(c =>
    c.includes('BREAKING CHANGE:') ||
    /^(feat|fix|refactor)!:/.test(c)
  );
}

function categoriseCommits(commits) {
  const cats = { feat: [], fix: [], refactor: [], docs: [], test: [], chore: [], other: [] };
  for (const c of commits) {
    const m = c.match(/^(\w+)(\(.+\))?!?:\s*/);
    const type = m ? m[1] : 'other';
    (cats[type] || cats.other).push(c);
  }
  return cats;
}

function buildSummaryLine(commits, cats) {
  if (!commits.length) return 'No commits ahead of base branch.';
  const parts = [];
  if (cats.feat.length)     parts.push(`adds ${cats.feat.length} feature${cats.feat.length > 1 ? 's' : ''}`);
  if (cats.fix.length)      parts.push(`fixes ${cats.fix.length} bug${cats.fix.length > 1 ? 's' : ''}`);
  if (cats.refactor.length) parts.push(`refactors ${cats.refactor.length} area${cats.refactor.length > 1 ? 's' : ''}`);
  if (cats.docs.length)     parts.push('updates docs');
  if (cats.test.length)     parts.push('improves tests');
  if (!parts.length) return commits[0] || 'Miscellaneous changes.';
  const sentence = parts.join(', ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

function buildTestSteps(commits, cats, files) {
  const steps = [];
  if (files.added.some(f => /test|spec/i.test(f)) || cats.test.length)
    steps.push('Run the test suite');
  if (cats.feat.length)
    steps.push(`Test new feature: ${cats.feat[0].replace(/^feat(\(.+\))?!?:\s*/, '')}`);
  if (cats.fix.length)
    steps.push(`Verify fix: ${cats.fix[0].replace(/^fix(\(.+\))?!?:\s*/, '')}`);
  if (!steps.length)
    steps.push('Smoke-test affected functionality');
  return steps;
}

// ── AI summary via Claude Haiku ───────────────────────────────────────────────

function aiSummary(commits, statSummary) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('  --ai: ANTHROPIC_API_KEY not set, skipping AI summary.');
    return Promise.resolve(null);
  }

  const prompt = `You are a senior engineer writing a concise PR description.
Given these commit messages and a brief diff stat, write a 1-2 sentence summary suitable for a PR description.
Be direct and technical. No fluff. Output plain text only, no markdown.

Commits:
${commits.join('\n')}

Diff stats: ${statSummary}`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed?.content?.[0]?.text?.trim() || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

function copyToClipboard(text) {
  try {
    const platform = process.platform;
    let cmd;
    if (platform === 'darwin')      cmd = 'pbcopy';
    else if (platform === 'linux')  cmd = 'xclip -selection clipboard';
    else return false;
    execSync(cmd, { input: text, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown({ summary, commits, stats, files, breaking, testSteps, base, count }) {
  const divider = '\u2501'.repeat(38);
  const header  = `pr-summary \u00B7 ${count} commit${count !== 1 ? 's' : ''} ahead of ${base}`;

  const fileLines = [];
  if (files.modified.length) fileLines.push(`Modified: ${files.modified.join(', ')}`);
  if (files.added.length)    fileLines.push(`Added: ${files.added.join(', ')}`);
  if (files.deleted.length)  fileLines.push(`Deleted: ${files.deleted.join(', ')}`);
  if (files.renamed.length)  fileLines.push(`Renamed: ${files.renamed.join(', ')}`);
  if (!fileLines.length)     fileLines.push('No file-level changes detected.');

  const statLine = `Modified: ${stats.files} files (+${stats.added}/-${stats.deleted} lines)`;

  const sections = [
    '## Summary',
    summary,
    '',
    ...(breaking ? ['> **BREAKING CHANGE** detected in commits.\n'] : []),
    '## What Changed',
    ...commits.map(c => `- ${c}`),
    '',
    '## Files Changed',
    statLine,
    ...fileLines,
    '',
    '## How to Test',
    ...testSteps.map(s => `- [ ] ${s}`),
    '',
    '## Checklist',
    '- [ ] Tests added or updated',
    '- [ ] No console.logs left in',
    '- [ ] README updated if needed',
    '- [ ] Self-reviewed the diff',
  ];

  const body = sections.join('\n');
  return { header, divider, body };
}

// ── Open draft PR ─────────────────────────────────────────────────────────────

function openDraftPR(title, body, base) {
  try {
    execSync('gh --version', { stdio: 'pipe' });
  } catch {
    console.error('  --open: gh CLI not found. Install from https://cli.github.com');
    return;
  }
  const tmp = join(tmpdir(), `pr-body-${Date.now()}.md`);
  try {
    writeFileSync(tmp, body, 'utf8');
    execSync(
      `gh pr create --draft --title ${JSON.stringify(title)} --body-file ${tmp} --base ${base}`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    console.error('  --open: Failed to create PR:', e.message);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  ensureGitRepo();

  const base    = flags.base;
  const branch  = getBranchName();
  const commits = getCommits(base);
  const count   = getCommitCount(base);

  if (count === 0) {
    console.log(`No commits ahead of ${base}. Nothing to summarise.`);
    process.exit(0);
  }

  const stat      = getDiffStat(base);
  const nameLines = getNameStatus(base);
  const stats     = parseDiffStat(stat);
  const files     = parseNameStatus(nameLines);
  const cats      = categoriseCommits(commits);
  const breaking  = detectBreakingChanges(commits);
  const testSteps = buildTestSteps(commits, cats, files);
  const statSummary = `${stats.files} files, +${stats.added}/-${stats.deleted} lines`;

  let summary = buildSummaryLine(commits, cats);

  if (flags.ai) {
    process.stdout.write('  Fetching AI summary... ');
    const aiResult = await aiSummary(commits, statSummary);
    if (aiResult) {
      summary = aiResult;
      process.stdout.write('done\n');
    } else {
      process.stdout.write('skipped\n');
    }
  }

  const { header, divider, body } = buildMarkdown({
    summary, commits, stats, files, breaking, testSteps, branch, base, count,
  });

  const output = ['\n', header, divider, '\n', body, '\n', divider].join('\n');
  console.log(output);

  if (flags.copy) {
    const copied = copyToClipboard(body);
    console.log(copied ? 'Copied to clipboard \u2713' : 'Copy failed \u2014 paste manually.');
  }

  if (flags.open) {
    const title = commits[0] || `${branch}: changes vs ${base}`;
    openDraftPR(title, body, base);
  }
}

main().catch(err => {
  console.error('pr-summary error:', err.message);
  process.exit(1);
});
