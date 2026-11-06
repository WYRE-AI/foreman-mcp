#!/usr/bin/env node
// Lint MCP tool definitions for missing destructive-action warnings.
// Usage: node scripts/lint-destructive-warnings.mjs [path ...]
// Exits 1 if any tool declared with createEndpoint("name", ...) whose name
// matches a destructive verb lacks a "⚠ DESTRUCTIVE" or "⚠ HIGH-IMPACT"
// prefix in its description. annotations.destructiveHint is computed at
// runtime in src/index.ts and is asserted by the tools/list test in
// src/__tests__/foreman-tools.test.ts, not here.
//
// Convention: see ~/.claude/skills/mcp-vendor-scaffolding/SKILL.md §2.7b.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DESTRUCTIVE_VERBS = [
  'delete', 'remove', 'destroy', 'wipe', 'purge', 'drop',
  'disable', 'deactivate', 'suspend',
  'revoke', 'reset_password', 'reset_mfa',
  'offboard', 'terminate',
  'archive', 'unarchive',
  'quarantine_delete', 'quarantine_release',
  'power', 'reset', 'rebuild', 'build', 'owner',
];

const SKIP_PATTERNS = [
  /_dropdown\b/, /_list\b/, /_search\b/, /_get\b/, /_get_/,
  /quarantine_list/, /quarantine_search/,
  /messages_blocked/, /clicks_blocked/,
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '.git', 'docs', 'docs-repo']);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walk(full);
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      !entry.endsWith('.test.ts')
    ) {
      yield full;
    }
  }
}

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push('.');

let violations = 0;

for (const root of roots) {
  for (const file of walk(resolve(root))) {
    const src = readFileSync(file, 'utf8');
    const nameRegex = /createEndpoint\(\s*['"]([a-z0-9_]+)['"]/g;
    let match;
    while ((match = nameRegex.exec(src)) !== null) {
      const toolName = match[1];
      const lower = toolName.toLowerCase();

      if (SKIP_PATTERNS.some(p => p.test(lower))) continue;
      if (!DESTRUCTIVE_VERBS.some(v => lower.includes(v))) continue;

      // createEndpoint(name, method, path, tier, description, ...): read-tier tools are exempt.
      const args = src.slice(match.index).match(/^createEndpoint\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"](\w+)['"]\s*,\s*['"]([^'"]*)/);
      if (args && args[1] === 'read') continue;
      const hasWarningPrefix = args !== null && /^⚠\s*(DESTRUCTIVE|HIGH-IMPACT)/.test(args[2]);

      if (!hasWarningPrefix) {
        violations++;
        const lineNum = src.slice(0, match.index).split('\n').length;
        console.error(`${file}:${lineNum}  ${toolName}  missing: description prefix (⚠ DESTRUCTIVE/HIGH-IMPACT)`);
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} destructive tool(s) missing warnings.`);
  console.error('See ~/.claude/skills/mcp-vendor-scaffolding/SKILL.md §2.7b for the convention.');
  process.exit(1);
}
console.log('All destructive tools carry the required warnings.');
