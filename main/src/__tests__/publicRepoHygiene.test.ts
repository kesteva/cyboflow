/**
 * Public-repo hygiene for the Agents & Environments build (persistent agents, cyboflow cloud sign-in,
 * the Bridge connector).
 *
 * This repository is public. The relay and the accounts service are described here only through the
 * vendored wire protocol (shared/types/relayProtocol.ts) and their observable HTTP behaviour, so none of
 * the files this feature added — code, comments, test names or doc sections — may cite the private
 * server repository's paths or name its server-side libraries or storage primitives.
 *
 * Shell equivalent for a quick manual check:
 *   rg -n 'remote:apps/|Better Auth|Durable Object' shared/ main/src frontend/src docs/
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(__dirname, '..', '..', '..');

/**
 * Case-sensitive on purpose: the repo's "DO NOT" comment idiom must never trip the standalone-`DO` arm.
 * Built from fragments so this file does not match itself if it is ever scanned.
 */
const FORBIDDEN = new RegExp(
  [
    'remote:apps\\/',
    'remote:packages\\/',
    'apps\\/(?:accounts|bridge-relay)\\/',
    'packages\\/accounts-contract',
    'Better' + ' Auth',
    'Durable' + ' Object',
    // Sentence-initial articles too ("Each DO …"); "DO NOT" never follows one of these words.
    '\\b(?:[Aa]|[Tt]he|[Bb]lank|[Ii]ts|[Ee]ach|per-connection|per-account) DOs?\\b',
  ].join('|'),
);

/** Single files added by this build (repo-relative). */
const FILES = [
  'shared/types/persistentAgents.ts',
  'shared/types/cloudAccountWire.ts',
  'shared/types/cloudOrigins.ts',
  'shared/types/relayProtocol.ts',
  'main/src/cloudAccountComposition.ts',
  'main/src/persistentAgentsComposition.ts',
  'main/src/orchestrator/cloudAccountBridge.ts',
  'main/src/orchestrator/persistentAgentsBridge.ts',
  'main/src/orchestrator/trpc/routers/cloud.ts',
  'main/src/orchestrator/trpc/routers/persistentAgents.ts',
  'main/src/orchestrator/trpc/routers/__tests__/persistentAgents.noSecrets.test.ts',
  'main/src/services/secrets/safeStorageSecret.ts',
  'main/src/database/migrations/150_cloud_account.sql',
  'main/src/database/migrations/151_persistent_agents.sql',
  'main/src/__tests__/agentsWiring.test.ts',
  'main/src/__tests__/bridgeConnector.store.test.ts',
  'main/src/__tests__/cloudAccountComposition.test.ts',
  'main/src/__tests__/persistentAgentsComposition.test.ts',
  'main/src/__tests__/persistentAgentsSoleWriter.test.ts',
  'frontend/src/stores/cloudAccountStore.ts',
  'frontend/src/stores/persistentAgentsStore.ts',
  'tests/agents-environments.spec.ts',
];

/** Directories added by this build: every .ts / .tsx file under them, recursively (tests included). */
const DIRS = [
  'main/src/services/cloud',
  'main/src/services/persistentAgents',
  'main/src/orchestrator/persistentAgents',
  'frontend/src/components/agentsEnv',
  'frontend/src/components/settings/agents',
  'frontend/src/components/settings/cloud',
];

/** Doc sections added by this build: [file, start marker (line prefix), end rule]. */
type SectionEnd = 'next-h3-or-h2' | 'next-h2' | 'bullet';
const DOC_SECTIONS: Array<{ file: string; start: string; end: SectionEnd }> = [
  { file: 'docs/ARCHITECTURE.md', start: '### Agents & Environments', end: 'next-h3-or-h2' },
  { file: 'docs/BACKUP-RESTORE.md', start: '## Secrets do not restore across machines', end: 'next-h2' },
  { file: 'docs/CODE-PATTERNS.md', start: '### `persistent_agent*` + `vendor_credentials` write chokepoint', end: 'next-h2' },
  { file: 'docs/SHELL-LAYOUT.md', start: '- **Agents & Environments**', end: 'bullet' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** The section starting at the first line that begins with `start`, up to (not including) its end. */
function sliceSection(text: string, start: string, end: SectionEnd): string | null {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.startsWith(start));
  if (from < 0) return null;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i += 1) {
    const l = lines[i];
    const isH2 = l.startsWith('## ');
    const isH3 = l.startsWith('### ');
    if (end === 'next-h2' && isH2) { to = i; break; }
    if (end === 'next-h3-or-h2' && (isH2 || isH3)) { to = i; break; }
    if (end === 'bullet' && (l.startsWith('- ') || l.startsWith('#') || l.trim() === '')) { to = i; break; }
  }
  return lines.slice(from, to).join('\n');
}

function violations(label: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    const m = FORBIDDEN.exec(line);
    if (m) hits.push(`${label}:${i + 1}: "${m[0]}"`);
  });
  return hits;
}

describe('public-repo hygiene (Agents & Environments)', () => {
  it('the forbidden pattern matches what it must and spares the "DO NOT" idiom', () => {
    expect(FORBIDDEN.test('see remote:apps/x')).toBe(true);
    expect(FORBIDDEN.test('apps/bridge-relay/src/protocol.ts')).toBe(true);
    expect(FORBIDDEN.test('packages/accounts-contract')).toBe(true);
    expect(FORBIDDEN.test('a blank DO is re-initialized')).toBe(true);
    expect(FORBIDDEN.test('each DOs state')).toBe(true);
    expect(FORBIDDEN.test('Each DO keeps its own cursor')).toBe(true);
    expect(FORBIDDEN.test('Durable' + ' Object')).toBe(true);
    expect(FORBIDDEN.test('DO NOT edit this file')).toBe(false);
    expect(FORBIDDEN.test('do not do this')).toBe(false);
  });

  it('every listed file and directory exists (the scan cannot silently shrink)', () => {
    const missing = [...FILES, ...DIRS].filter((p) => !existsSync(join(REPO, p)));
    expect(missing).toEqual([]);
  });

  it('no new code, comment or test file cites private server paths or internals', () => {
    const files = new Set<string>(FILES.map((f) => join(REPO, f)));
    for (const d of DIRS) for (const f of walk(join(REPO, d))) files.add(f);
    expect(files.size).toBeGreaterThan(FILES.length);
    const hits: string[] = [];
    for (const f of files) {
      if (f === __filename) continue;
      hits.push(...violations(relative(REPO, f), readFileSync(f, 'utf-8')));
    }
    expect(hits).toEqual([]);
  });

  it('the new doc sections describe the desktop side only', () => {
    const hits: string[] = [];
    const missing: string[] = [];
    for (const s of DOC_SECTIONS) {
      const section = sliceSection(readFileSync(join(REPO, s.file), 'utf-8'), s.start, s.end);
      if (section === null) {
        missing.push(`${s.file} → ${s.start}`);
        continue;
      }
      expect(section.length, s.file).toBeGreaterThan(s.start.length);
      hits.push(...violations(`${s.file} (${s.start})`, section));
    }
    expect(missing).toEqual([]);
    expect(hits).toEqual([]);
  });

  it('section slicing stops at the right boundary', () => {
    const md = ['## A', 'x', '### Agents & Environments (y)', 'body', '#### sub', 'more', '### Next', 'other', '## B'].join('\n');
    expect(sliceSection(md, '### Agents & Environments', 'next-h3-or-h2')).toBe('### Agents & Environments (y)\nbody\n#### sub\nmore');
    expect(sliceSection(md, '### Agents & Environments', 'next-h2')).toContain('### Next');
    const list = ['- **Other**', '- **Agents & Environments** (`agentsEnvOpen`): a', '  continued line', '- **Next**'].join('\n');
    expect(sliceSection(list, '- **Agents & Environments**', 'bullet')).toBe('- **Agents & Environments** (`agentsEnvOpen`): a\n  continued line');
  });
});
