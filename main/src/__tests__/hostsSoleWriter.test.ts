/**
 * Write chokepoint for the Environments tables: every INSERT / UPDATE / DELETE against hosts /
 * host_project_checkouts, and every write of projects.default_host_id, in PRODUCTION code lives in HostStore.
 * Production filter: same as persistentAgentsSoleWriter.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const ALLOWED = new Set([path.join('orchestrator', 'hosts', 'hostStore.ts')]);
const WRITE_RE = /(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(hosts|host_project_checkouts)\b/i;
const DEFAULT_HOST_WRITE_RE = /default_host_id\s*=/i;

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
  return listFiles(root).filter((rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf-8');
    return WRITE_RE.test(src) || DEFAULT_HOST_WRITE_RE.test(src);
  });
}

describe('hosts sole writer', () => {
  it('only HostStore writes hosts / host_project_checkouts / projects.default_host_id', () => {
    const offenders = findWriters(SRC).filter((rel) => !ALLOWED.has(rel));
    expect(offenders, `move these writes into HostStore: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the scan actually sees the store (guards against a vacuous pass)', () => {
    expect(findWriters(SRC)).toContain(path.join('orchestrator', 'hosts', 'hostStore.ts'));
  });

  it('the patterns catch each write form and ignore reads', () => {
    expect(WRITE_RE.test('db.prepare("update hosts set label = 1")')).toBe(true);
    expect(WRITE_RE.test('INSERT OR IGNORE INTO hosts (id) VALUES (?)')).toBe(true);
    expect(WRITE_RE.test('DELETE FROM host_project_checkouts WHERE x')).toBe(true);
    expect(WRITE_RE.test('SELECT * FROM hosts')).toBe(false);
    expect(DEFAULT_HOST_WRITE_RE.test('SET default_host_id = ?')).toBe(true);
    expect(DEFAULT_HOST_WRITE_RE.test('SELECT default_host_id AS h FROM projects')).toBe(false);
  });
});
