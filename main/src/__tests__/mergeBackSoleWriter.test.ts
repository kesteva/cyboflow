/**
 * Write chokepoint for session_merge_backs: every INSERT / UPDATE / DELETE against it in PRODUCTION code
 * lives in MergeBackStore. Pattern: hostsSoleWriter.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const ALLOWED = new Set([path.join('orchestrator', 'hosts', 'mergeBackStore.ts')]);
const WRITE_RE = /(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+session_merge_backs\b/i;

function isProductionFile(rel: string): boolean {
  if (!rel.endsWith('.ts')) return false;
  if (rel.endsWith('.test.ts') || rel.endsWith('.itest.ts')) return false;
  const segments = rel.split(path.sep);
  if (segments.includes('__tests__') || segments.includes('__test_fixtures__')) return false;
  return !rel.startsWith(path.join('database', 'migrations') + path.sep);
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...listFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && isProductionFile(rel)) {
      out.push(rel);
    }
  }
  return out;
}

function findWriters(root: string): string[] {
  return listFiles(root).filter((rel) => WRITE_RE.test(fs.readFileSync(path.join(root, rel), 'utf-8')));
}

describe('session_merge_backs sole writer', () => {
  it('only MergeBackStore writes session_merge_backs', () => {
    const offenders = findWriters(SRC).filter((rel) => !ALLOWED.has(rel));
    expect(offenders, `move these writes into MergeBackStore: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the scan actually sees the store (guards against a vacuous pass)', () => {
    expect(findWriters(SRC)).toContain(path.join('orchestrator', 'hosts', 'mergeBackStore.ts'));
  });

  it('the pattern catches each write form and ignores reads', () => {
    expect(WRITE_RE.test('update session_merge_backs set state = 1')).toBe(true);
    expect(WRITE_RE.test('INSERT OR REPLACE INTO session_merge_backs (x)')).toBe(true);
    expect(WRITE_RE.test('DELETE FROM session_merge_backs WHERE x')).toBe(true);
    expect(WRITE_RE.test('SELECT * FROM session_merge_backs')).toBe(false);
  });
});
