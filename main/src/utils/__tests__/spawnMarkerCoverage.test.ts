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

const MARKER_LITERAL = /['"`]CYBOFLOW_(INSTANCE|WORKTREE)['"`]|\bCYBOFLOW_(INSTANCE|WORKTREE)\s*:/;

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
    it('accepts a properly stamped module', () => {
      const ok = `import { stampSpawnMarker } from '../utils/spawnMarker';\nconst e = stampSpawnMarker(env, cwd);`;
      expect(callsStamp(ok)).toBe(true);
      expect(handWritesMarker(ok)).toBe(false);
    });
  });
});
