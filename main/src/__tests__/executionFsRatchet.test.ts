/**
 * fs / child_process ratchet for execution paths.
 *
 * Code that runs agent work must reach the machine through ExecutionHost
 * (MachineFs / GitExecutor / exec) so remote environments work. Files under
 * the scoped trees that ALREADY import fs or child_process are frozen in
 * main/eslint/executionFsExemptions.json; that list may shrink, never grow.
 * The same list feeds the `no-restricted-imports` block in eslint.config.js.
 * This test additionally catches `require()` / dynamic `import()`, which no
 * eslint import rule sees (e.g. the inline require('fs') in taskQueue.ts).
 *
 * Type-only imports COUNT as violations, exactly like the eslint gate: the core
 * `no-restricted-imports` rule (no `allowTypeImports`) flags `import type`
 * from these modules too, and the two gates must agree on what a violation is.
 * (A type you need from fs belongs behind the ExecutionHost contract anyway.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

function locateMainRoot(): string {
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [dir, path.join(dir, 'main')]) {
      if (
        fs.existsSync(path.join(candidate, 'src', 'orchestrator', 'Orchestrator.ts')) &&
        fs.existsSync(path.join(candidate, 'eslint.config.js'))
      ) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate main/ from ${process.cwd()}`);
    dir = parent;
  }
}

const MAIN_ROOT = locateMainRoot();

/** Scoped trees (directories) and single files, relative to main/. */
const SCOPED_DIRS = ['src/orchestrator', 'src/services/panels'] as const;
const SCOPED_FILES = ['src/services/worktreeManager.ts', 'src/services/taskQueue.ts'] as const;

const FORBIDDEN_SPECS: ReadonlySet<string> = new Set([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
]);

const EXEMPTIONS_PATH = path.join(MAIN_ROOT, 'eslint', 'executionFsExemptions.json');

// Independent passes (see orchestrator/__tests__/standaloneInvariant.test.ts).
const MODULE_REFS = [
  /(?:^|\n)[ \t]*(?:import|export)(?<clause>[^;]*?)\bfrom\s*['"](?<spec>[^'"]+)['"]/g,
  /(?:^|\n)[ \t]*import\s*['"](?<spec>[^'"]+)['"]/g,
  /\b(?:require|import)\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/g,
] as const;

function isProductionFile(relPath: string): boolean {
  if (!relPath.endsWith('.ts')) return false;
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.itest.ts')) return false;
  const segments = relPath.split('/');
  return !segments.includes('__tests__') && !segments.includes('__test_fixtures__');
}

function listFiles(dirRel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(MAIN_ROOT, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(rel));
    else if (entry.isFile() && isProductionFile(rel)) out.push(rel);
  }
  return out;
}

function scopedFiles(): string[] {
  return [...SCOPED_DIRS.flatMap(listFiles), ...SCOPED_FILES].sort();
}

interface Violation {
  line: number;
  spec: string;
}

function findViolationsInSource(text: string): Violation[] {
  const byLine = new Map<string, Violation>();
  for (const re of MODULE_REFS) {
    for (const match of text.matchAll(re)) {
      const { spec } = match.groups ?? {};
      if (spec === undefined || !FORBIDDEN_SPECS.has(spec)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      byLine.set(`${line}:${spec}`, { line, spec });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

function findViolations(rel: string): Violation[] {
  return findViolationsInSource(fs.readFileSync(path.join(MAIN_ROOT, rel), 'utf8'));
}

function loadExemptions(): string[] {
  return JSON.parse(fs.readFileSync(EXEMPTIONS_PATH, 'utf8')) as string[];
}

describe('execution-path fs / child_process ratchet', () => {
  const files = scopedFiles();
  const exemptions = loadExemptions();
  const exempt = new Set(exemptions);

  it('finds production files to scan (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/orchestrator/Orchestrator.ts');
    expect(files).toContain('src/services/taskQueue.ts');
    expect(files).toContain('src/services/worktreeManager.ts');
    expect(files.some(f => f.startsWith('src/services/panels/'))).toBe(true);
  });

  it('has no importer outside the frozen exemption list', () => {
    const offenders = files
      .filter(f => !exempt.has(f))
      .flatMap(f => findViolations(f).map(v => `${f}:${v.line} imports '${v.spec}'`));
    expect(
      offenders,
      'Execution paths must go through ExecutionHost (MachineFs / GitExecutor / exec), not fs/child_process. Do NOT add to main/eslint/executionFsExemptions.json.'
    ).toEqual([]);
  });

  it('has no stale exemption (each listed file exists and still imports)', () => {
    const stale = exemptions.filter(rel => {
      const abs = path.join(MAIN_ROOT, rel);
      return !fs.existsSync(abs) || findViolations(rel).length === 0;
    });
    expect(stale, 'drop these entries from main/eslint/executionFsExemptions.json').toEqual([]);
  });

  it('keeps every exemption inside the scoped trees', () => {
    const scoped = new Set(files);
    expect(exemptions.filter(rel => !scoped.has(rel))).toEqual([]);
  });

  it('keeps the list sorted and unique', () => {
    expect(exemptions).toEqual([...new Set(exemptions)].sort());
  });

  describe('scanner self-check', () => {
    const flagged: Array<[string, string]> = [
      ['import fs from "fs";', 'fs'],
      ["import * as fs from 'node:fs';", 'node:fs'],
      ["import { mkdir } from 'fs/promises';", 'fs/promises'],
      ["import { readFile } from 'node:fs/promises';", 'node:fs/promises'],
      ["import { spawn } from 'child_process';", 'child_process'],
      ["import { type X, spawn } from 'node:child_process';", 'node:child_process'],
      ["export { readFileSync } from 'fs';", 'fs'],
      ["import 'fs';", 'fs'],
      ["const fs = require('fs');", 'fs'],
      ["const cp = await import('node:child_process');", 'node:child_process'],
      // Type-only imports are violations too (the eslint rule flags them; the gates agree).
      ["import type { Stats } from 'fs';", 'fs'],
      ["import { type Stats, type Dirent } from 'node:fs';", 'node:fs'],
      ["export type { Stats } from 'node:fs';", 'node:fs'],
    ];
    for (const [src, spec] of flagged) {
      it(`flags ${src}`, () => {
        expect(findViolationsInSource(src).map(v => v.spec)).toEqual([spec]);
      });
    }

    const clean = [
      "import path from 'path';",
      "import { x } from './fs';",
      "import fse from 'fs-extra';",
    ];
    for (const src of clean) {
      it(`ignores ${src}`, () => {
        expect(findViolationsInSource(src)).toEqual([]);
      });
    }
  });
});
