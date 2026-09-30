/**
 * Spawn-marker chokepoint-enforcement gate.
 *
 * FALLBACK NOTE: most of these modules have no injectable spawner (the PTY
 * managers call node-pty directly, runConfig is a pure env builder), and their
 * behavioural env assertions live in each module's own test. This gate is a
 * deliberate source-layout check — the one place the requirement "every spawn
 * path routes its env through stampSpawnMarker instead of hand-writing the
 * marker keys" can be enforced across all modules at once. It does NOT count
 * as behavioural coverage of any single spawn site.
 *
 * MANUAL STEP: a new spawn module must be added to STAMPED_MODULES (or, if it
 * legitimately inherits the stamp from AbstractCliManager, to INHERITING_MODULES).
 * The discovery test below fails loudly if a file calls a PTY spawn directly and
 * is enumerated in neither list. Full automatic discovery of every spawn
 * flavour (child_process.spawn/execFile) is out of scope.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..');

/** Modules that build/own a spawn env and must call stampSpawnMarker themselves. */
const STAMPED_MODULES = [
  'services/panels/cli/AbstractCliManager.ts',
  'services/sessionManager.ts',
  'services/terminalSessionManager.ts',
  'services/terminalPanelManager.ts',
  'services/runShellManager.ts',
  'services/runCommandManager.ts',
  'services/panels/codex/appServer/runConfig.ts',
  'services/panels/logPanel/logsManager.ts',
  'services/visualVerify/devServerManager.ts',
  'orchestrator/verify/verificationAgentRunner.ts',
  'orchestrator/verify/verificationAgentQuery.ts',
  'orchestrator/mcpServer/mcpServerLifecycle.ts',
];

/**
 * Files that mention pty.spawn but only as an injected spawner for an enumerated
 * manager, which stamps the env itself before invoking it.
 */
const SPAWNER_INJECTION_ONLY = new Set(['index.ts']); // wires RunShellManager's ShellSpawner

/** Interactive PTY managers stamped via AbstractCliManager.spawnPtyProcess. */
const INHERITING_MODULES = [
  'services/panels/codex/codexPtyManager.ts',
  'services/panels/pi/piPtyManager.ts',
  'services/panels/omp/ompPtyManager.ts',
];

/**
 * Hand-written marker forms: a quoted key (`env['CYBOFLOW_INSTANCE']`), an object
 * literal key (`{ CYBOFLOW_INSTANCE: id }`) and a direct property write
 * (`env.CYBOFLOW_INSTANCE = id`, also `??=` / `||=`). Reads are not flagged.
 */
const MARKER_LITERAL =
  /['"`]CYBOFLOW_(INSTANCE|WORKTREE)['"`]|\bCYBOFLOW_(INSTANCE|WORKTREE)\s*:|\.CYBOFLOW_(INSTANCE|WORKTREE)\s*(?:\?\?|\|\|)?=(?!=)/;

/**
 * Per-site enforcement. `callsStamp` alone accepts ONE stamp anywhere in a module,
 * so a module with two spawn sites could lose the stamp at one and still pass.
 * Each entry names a spawn site by regex, how many such sites the module has, and
 * the site's call/object text is then checked for a stamped `env`.
 *  - `open: '('`  — anchor is a call; the args must carry a stamped `env` property.
 *  - `open: '{'`  — anchor opens an object literal (e.g. an MCP server block).
 *  - `open: 'return'` — anchor is `return stampSpawnMarker(` in a pure env builder.
 */
interface SpawnSite {
  anchor: RegExp;
  count: number;
  open: '(' | '{' | 'return';
}
const SPAWN_SITES: Record<string, SpawnSite[]> = {
  'services/panels/cli/AbstractCliManager.ts': [{ anchor: /\bpty\.spawn\(/g, count: 2, open: '(' }],
  'services/sessionManager.ts': [
    { anchor: /(?<![\w.])spawn\(/g, count: 1, open: '(' },
    { anchor: /\bexecAsync\(/g, count: 1, open: '(' },
  ],
  'services/terminalSessionManager.ts': [{ anchor: /\bpty\.spawn\(/g, count: 1, open: '(' }],
  'services/terminalPanelManager.ts': [{ anchor: /\bpty\.spawn\(/g, count: 1, open: '(' }],
  'services/runShellManager.ts': [{ anchor: /\bthis\.spawn\(/g, count: 1, open: '(' }],
  'services/runCommandManager.ts': [{ anchor: /\bpty\.spawn\(/g, count: 1, open: '(' }],
  'services/panels/codex/appServer/runConfig.ts': [
    { anchor: /\bcyboflow:\s*\{/g, count: 1, open: '{' },
    { anchor: /\breturn\s+stampSpawnMarker\(/g, count: 1, open: 'return' },
  ],
  'services/panels/logPanel/logsManager.ts': [{ anchor: /(?<![\w.])spawn\(/g, count: 1, open: '(' }],
  'services/visualVerify/devServerManager.ts': [{ anchor: /\bconst child = spawn\(/g, count: 2, open: '(' }],
  'orchestrator/verify/verificationAgentRunner.ts': [{ anchor: /\bawait queryFn\(/g, count: 1, open: '(' }],
  'orchestrator/verify/verificationAgentQuery.ts': [{ anchor: /\bconst q = query\(/g, count: 1, open: '(' }],
  'orchestrator/mcpServer/mcpServerLifecycle.ts': [{ anchor: /\bconst child = spawn\(/g, count: 1, open: '(' }],
};

/** Drop block and whole-line-ish `//` comments so parens/braces in prose can't unbalance extraction. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;,{(])\/\/.*$/gm, '$1');
}

/** Text between the bracket at `openIdx` and its match (exclusive), or null if unbalanced. */
function balanced(src: string, openIdx: number): string | null {
  const pairs: Record<string, string> = { '(': ')', '{': '}' };
  const open = src[openIdx];
  const close = pairs[open];
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(openIdx + 1, i);
  }
  return null;
}

/** Identifiers whose initializer is (transitively) the output of stampSpawnMarker. */
function stampedIdents(src: string): Set<string> {
  const decls = [...src.matchAll(/(?:const|let)\s+(\w+)[^=\n]*=\s*([^;]+);/g)];
  const stamped = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [, name, init] of decls) {
      if (stamped.has(name)) continue;
      const derived = /\bstampSpawnMarker\(/.test(init) || [...stamped].some((s) => new RegExp(`\\b${s}\\b`).test(init));
      if (derived) {
        stamped.add(name);
        grew = true;
      }
    }
  }
  return stamped;
}

/** True when the site's `env` property (explicit or shorthand) is a stamped value. */
function envIsStamped(block: string, stamped: Set<string>): boolean {
  const prop = /\benv\s*:\s*(stampSpawnMarker\s*\(|(\w+)\b)/.exec(block);
  if (prop) return prop[2] === undefined ? true : stamped.has(prop[2]);
  if (/[{,]\s*env\s*(?=[,}])|^\s*env\s*(?=[,}])/.test(block)) return stamped.has('env');
  return false;
}

/** One entry per anchored spawn site: whether that site's final env is stamped. */
export function spawnSiteStamps(rawSrc: string, sites: SpawnSite[]): { count: number; unstamped: number }[] {
  const src = stripComments(rawSrc);
  const stamped = stampedIdents(src);
  return sites.map((site) => {
    const matches = [...src.matchAll(site.anchor)];
    let unstamped = 0;
    for (const m of matches) {
      if (site.open === 'return') continue; // the anchor itself IS the stamp call
      const idx = m.index + m[0].length - 1;
      const block = balanced(src, idx);
      if (block === null || !envIsStamped(block, stamped)) unstamped++;
    }
    return { count: matches.length, unstamped };
  });
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

export function callsStamp(src: string): boolean {
  return /\bstampSpawnMarker\s*\(/.test(src) && /from\s+['"][^'"]*spawnMarker['"]/.test(src);
}
export function handWritesMarker(src: string): boolean {
  return MARKER_LITERAL.test(src);
}

describe('spawn marker chokepoint coverage', () => {
  it('enumerates all 15 epic modules', () => {
    expect(STAMPED_MODULES.length + INHERITING_MODULES.length).toBe(15);
  });

  it.each(STAMPED_MODULES)('%s calls stampSpawnMarker', (rel) => {
    expect(callsStamp(read(rel))).toBe(true);
  });

  it.each(Object.keys(SPAWN_SITES))('%s stamps the env at EVERY spawn site', (rel) => {
    const sites = SPAWN_SITES[rel];
    const results = spawnSiteStamps(read(rel), sites);
    results.forEach((r, i) => {
      // A count drift means a spawn site was added/removed: update SPAWN_SITES deliberately.
      expect(r.count, `${rel}: site ${sites[i].anchor} count`).toBe(sites[i].count);
      expect(r.unstamped, `${rel}: unstamped sites for ${sites[i].anchor}`).toBe(0);
    });
  });

  it('SPAWN_SITES covers every stamped module', () => {
    expect(Object.keys(SPAWN_SITES).sort()).toEqual([...STAMPED_MODULES].sort());
  });

  it.each([...STAMPED_MODULES, ...INHERITING_MODULES])('%s never hand-writes the marker keys', (rel) => {
    expect(handWritesMarker(read(rel))).toBe(false);
  });

  it.each(INHERITING_MODULES)('%s inherits the stamp via AbstractCliManager and never spawns a PTY itself', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/extends AbstractCliManager/);
    expect(src).not.toMatch(/\bpty\.spawn\s*\(/);
  });

  it('flags any non-enumerated production file that calls pty.spawn directly', () => {
    const known = new Set([...STAMPED_MODULES, ...INHERITING_MODULES, ...SPAWNER_INJECTION_ONLY]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.ts$/.test(entry.name) && !/\.(test|itest|spec)\.ts$/.test(entry.name)) {
          const rel = path.relative(SRC, full).split(path.sep).join('/');
          if (!known.has(rel) && /\bpty\.spawn\s*\(/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  describe('detectors can fail (negative controls on synthetic sources)', () => {
    it('rejects a module that spawns without stamping', () => {
      expect(callsStamp(`import * as pty from 'node-pty'; pty.spawn(sh, [], { env })`)).toBe(false);
    });
    it('rejects a module that hand-writes the marker literals', () => {
      expect(handWritesMarker(`const env = { CYBOFLOW_INSTANCE: 'x' };`)).toBe(true);
      expect(handWritesMarker(`env['CYBOFLOW_WORKTREE'] = cwd;`)).toBe(true);
    });
    it('rejects direct property writes of the marker keys', () => {
      expect(handWritesMarker(`env.CYBOFLOW_INSTANCE = id;`)).toBe(true);
      expect(handWritesMarker(`childEnv.CYBOFLOW_WORKTREE ??= cwd;`)).toBe(true);
      expect(handWritesMarker(`const v = process.env.CYBOFLOW_INSTANCE;`)).toBe(false);
    });
    it('rejects a module where only one of two spawn sites is stamped', () => {
      const site: SpawnSite = { anchor: /\bconst child = spawn\(/g, count: 2, open: '(' };
      const src = `import { stampSpawnMarker } from '../utils/spawnMarker';
        const a = spawn(cmd, { env: stampSpawnMarker({ ...process.env }, cwd) });
        const child = spawn(cmd, { env: { ...process.env, PORT: '1' } });`.replace('const a', 'const child');
      expect(callsStamp(src)).toBe(true); // the module-level check would wave this through
      expect(spawnSiteStamps(src, [site])).toEqual([{ count: 2, unstamped: 1 }]);
    });
    it('catches losing the stamp at ONE real devServerManager site (in-memory mutation)', () => {
      const rel = 'services/visualVerify/devServerManager.ts';
      const real = read(rel);
      expect(spawnSiteStamps(real, SPAWN_SITES[rel])[0].unstamped).toBe(0);
      const idx = real.lastIndexOf('env: stampSpawnMarker(');
      const mutated = real.slice(0, idx) + 'env: (' + real.slice(idx + 'env: stampSpawnMarker('.length);
      expect(spawnSiteStamps(mutated, SPAWN_SITES[rel])[0].unstamped).toBe(1);
    });
    it('accepts stamped sites via derived identifiers and shorthand env', () => {
      const site: SpawnSite = { anchor: /\bconst child = spawn\(/g, count: 2, open: '(' };
      const src = `import { stampSpawnMarker } from '../utils/spawnMarker';
        const marked = stampSpawnMarker(base, cwd);
        const derived = flag ? { ...marked, X: '1' } : marked;
        const child = spawn(cmd, { env: derived });
        const child = spawn(cmd, { cwd, env: marked, stdio: 'pipe' });`;
      expect(spawnSiteStamps(src, [site])).toEqual([{ count: 2, unstamped: 0 }]);
      const shorthand = `const env = stampSpawnMarker(base, cwd);\nconst child = spawn(cmd, { stdio: 'pipe', env });`;
      expect(spawnSiteStamps(shorthand, [site])).toEqual([{ count: 1, unstamped: 0 }]);
      const bare = `const env = base;\nconst child = spawn(cmd, { stdio: 'pipe', env });`;
      expect(spawnSiteStamps(bare, [site])).toEqual([{ count: 1, unstamped: 1 }]);
    });
    it('accepts a properly stamped module', () => {
      const ok = `import { stampSpawnMarker } from '../utils/spawnMarker';\nconst e = stampSpawnMarker(env, cwd);`;
      expect(callsStamp(ok)).toBe(true);
      expect(handWritesMarker(ok)).toBe(false);
    });
  });
});
