/**
 * Write chokepoint for the persistent-agents tables: every INSERT / UPDATE / DELETE against
 * persistent_agent* or vendor_credentials in PRODUCTION code lives in PersistentAgentStore.
 *
 * Production = `.ts`, not `.test.ts` / `.itest.ts`, no `__tests__` / `__test_fixtures__` path segment
 * (the same filter as standaloneInvariant.test.ts), and never the migrations directory. Test fixtures
 * seed rows directly and are deliberately out of scope.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const ALLOWED = new Set([path.join('orchestrator', 'persistentAgents', 'persistentAgentStore.ts')]);
const WRITE_RE = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(persistent_agent\w*|vendor_credentials)\b/i;

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

export function findWriters(root: string): string[] {
  return listFiles(root).filter((rel) => WRITE_RE.test(fs.readFileSync(path.join(root, rel), 'utf-8')));
}

describe('persistent-agents sole writer', () => {
  it('only PersistentAgentStore writes the persistent_agent* / vendor_credentials tables', () => {
    const offenders = findWriters(SRC).filter((rel) => !ALLOWED.has(rel));
    expect(offenders, `move these writes into PersistentAgentStore: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the scan actually sees the store (guards against a vacuous pass)', () => {
    expect(findWriters(SRC)).toContain(path.join('orchestrator', 'persistentAgents', 'persistentAgentStore.ts'));
  });

  it('the pattern catches each write form and ignores reads', () => {
    expect(WRITE_RE.test('db.prepare("update persistent_agent_messages set x = 1")')).toBe(true);
    expect(WRITE_RE.test('INSERT INTO vendor_credentials (id) VALUES (?)')).toBe(true);
    expect(WRITE_RE.test('DELETE FROM persistent_agents WHERE id = ?')).toBe(true);
    expect(WRITE_RE.test('SELECT * FROM persistent_agent_connections')).toBe(false);
  });
});
