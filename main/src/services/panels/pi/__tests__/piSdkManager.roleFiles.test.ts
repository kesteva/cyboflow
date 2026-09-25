/**
 * Pins the WORKFLOW-spawn role-overlay install on the pi sdk lane
 * (PiSdkManager.spawnCliProcess -> installRoleOverlayIfWorkflowSpawn): pi has
 * no delegation tool, so its runtime-adapter prompt tells it to read the SAME
 * `.claude/agents/cyboflow-<key>.md` files the Claude substrate writes and
 * follow that role's instructions in-turn. This suite proves cyboflow makes
 * that statement true — and that the install is fail-soft on every axis
 * (missing db, missing runId, a throwing install) so a broken overlay never
 * breaks a turn.
 *
 * `installAgentOverlay`/`ensureBundleExcluded` are wrapped with `vi.fn()` spies
 * that DEFAULT to calling straight through to the real implementation (via
 * `importOriginal`) — so the "installs" test below exercises the REAL writer
 * against a real (in-memory) test DB + a real temp git worktree and asserts
 * actual files land on disk, while the negative-control tests only need to
 * assert the spies were (not) called, or override one to throw.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { ClaudeSpawnerOptions } from '../../../../orchestrator/runExecutor';
import { PiSdkManager } from '../piSdkManager';
import { createTestDb, seedRun } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { makeProdLoggerSpy } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

// ── Spies over the two overlay-install seams ────────────────────────────────
// Declared with vi.hoisted so the vi.mock factories below (themselves hoisted
// above these imports at runtime) can close over them.
const installAgentOverlaySpy = vi.hoisted(() => vi.fn());
const ensureBundleExcludedSpy = vi.hoisted(() => vi.fn());

vi.mock('../../claude/agentOverlayWriter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../claude/agentOverlayWriter')>();
  // Default behavior: the REAL writer. Individual tests override with
  // mockImplementationOnce to simulate a failure.
  installAgentOverlaySpy.mockImplementation(actual.installAgentOverlay);
  return { ...actual, installAgentOverlay: installAgentOverlaySpy };
});

vi.mock('../../claude/workflowBundleInstall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../claude/workflowBundleInstall')>();
  ensureBundleExcludedSpy.mockImplementation(actual.ensureBundleExcluded);
  return { ...actual, ensureBundleExcluded: ensureBundleExcludedSpy };
});

/**
 * Same child_process stub as piSdkManager.gateMode.test.ts: settle every turn
 * asynchronously with a clean exit — no real `pi` binary is ever spawned, so
 * this suite is only exercising the overlay-install wiring around the turn,
 * not the turn's own event projection.
 */
const spawnMock = vi.hoisted(() =>
  vi.fn((_exe: string, _args: string[], _opts: unknown) => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill: vi.fn(),
    });
    queueMicrotask(() => emitter.emit('close', 0));
    return child;
  }),
);
// `execFileSync` is used FOR REAL by the git-repo test helpers below (git
// init / rev-parse) — only `spawn` needs faking, so this partially mocks the
// module rather than replacing it wholesale.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock, exec: vi.fn() };
});

/** Bypass the PATH/version-probe ladder; the spawn itself is fully mocked. */
class TestablePiSdk extends PiSdkManager {
  protected override getCliExecutablePath(): Promise<string> {
    return Promise.resolve('/fake/pi');
  }
}

function makeManager(db?: Database.Database, logger?: unknown): TestablePiSdk {
  return new TestablePiSdk(
    { getDbSession: () => null } as never,
    logger as never,
    { getDefaultAgentPermissionMode: () => 'default' } as never,
    db,
  );
}

/** A real (empty) git repo so ensureBundleExcluded has an actual exclude file to write. */
function tmpGitWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-role-overlay-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function readGitExclude(worktree: string): string {
  const rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: worktree,
    encoding: 'utf8',
  }).trim();
  return fs.readFileSync(path.join(worktree, rel), 'utf8');
}

describe('PiSdkManager — workflow role overlay (spawnCliProcess)', () => {
  let worktree: string;

  beforeEach(() => {
    spawnMock.mockClear();
    installAgentOverlaySpy.mockClear();
    ensureBundleExcludedSpy.mockClear();
    worktree = tmpGitWorktree();
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it("installs the run's role-overlay files when a db + runId + worktree are all present", async () => {
    const db = createTestDb();
    const { runId } = seedRun(db, { worktreePath: worktree });

    const mgr = makeManager(db, makeProdLoggerSpy());
    await mgr.spawnCliProcess({
      panelId: 'panel-install',
      sessionId: 'sess-install',
      worktreePath: worktree,
      prompt: 'do the task',
      runId,
    } satisfies ClaudeSpawnerOptions);

    expect(installAgentOverlaySpy).toHaveBeenCalledWith(db, runId, worktree, expect.anything());
    expect(ensureBundleExcludedSpy).toHaveBeenCalledWith(worktree, [], expect.anything());

    // NEGATIVE CONTROL: this is not just "the spy was called" — the REAL
    // installAgentOverlay ran (see the vi.mock factory above), so the ACTUAL
    // built-in `implement` role prompt must exist on disk, verbatim frontmatter
    // and all. Removing the wiring in spawnCliProcess (or inverting the guard)
    // makes this assertion fail because the file is simply never written.
    const implementFile = path.join(worktree, '.claude', 'agents', 'cyboflow-implement.md');
    expect(fs.existsSync(implementFile)).toBe(true);
    expect(fs.readFileSync(implementFile, 'utf8')).toContain('name: cyboflow-implement');

    // The generated files must be excluded from the worktree's LOCAL git
    // exclude ($GIT_DIR/info/exclude), never the tracked .gitignore.
    expect(readGitExclude(worktree)).toContain('.claude/agents/cyboflow-*.md');

    db.close();
  });

  it('does NOT install when there is no db, and the turn still proceeds', async () => {
    const outcome = await makeManager(undefined).spawnCliProcess({
      panelId: 'panel-no-db',
      sessionId: 'sess-no-db',
      worktreePath: worktree,
      prompt: 'do the task',
      runId: 'run-no-db',
    } satisfies ClaudeSpawnerOptions);

    // NEGATIVE CONTROL: a manager constructed WITH a db (see the test above)
    // installs; only dropping the db here must flip this to "not called" — if
    // the guard were missing (or always-true), this would fail.
    expect(installAgentOverlaySpy).not.toHaveBeenCalled();
    expect(ensureBundleExcludedSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ resultText: null });
  });

  it('does NOT install when runId is absent (quick-session-shaped spawn)', async () => {
    const db = createTestDb();

    const outcome = await makeManager(db).spawnCliProcess({
      panelId: 'panel-no-runid',
      sessionId: 'sess-no-runid',
      worktreePath: worktree,
      prompt: 'do the task',
      // runId intentionally omitted.
    } satisfies ClaudeSpawnerOptions);

    expect(installAgentOverlaySpy).not.toHaveBeenCalled();
    expect(ensureBundleExcludedSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ resultText: null });

    db.close();
  });

  it('an install failure never breaks the spawn (fail-soft, warns)', async () => {
    installAgentOverlaySpy.mockImplementationOnce(() => {
      throw new Error('boom: simulated overlay failure');
    });
    const db = createTestDb();
    const logger = makeProdLoggerSpy();

    const outcome = await makeManager(db, logger as unknown as never).spawnCliProcess({
      panelId: 'panel-throws',
      sessionId: 'sess-throws',
      worktreePath: worktree,
      prompt: 'do the task',
      runId: 'run-throws',
    } satisfies ClaudeSpawnerOptions);

    // The turn still ran and resolved normally...
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ resultText: null });
    // The install must actually have been ATTEMPTED (proving the throw was
    // exercised, not skipped) — without this, a guard that silently never
    // calls installAgentOverlay would also leave `outcome` and `spawnMock`
    // untouched and pass the rest of this test.
    expect(installAgentOverlaySpy).toHaveBeenCalledTimes(1);
    // ...and the failure was surfaced via a SPECIFIC logger.warn call naming
    // this runId and the thrown message — not just "warn was called at all".
    // The mocked child always closes with code 0 and no stdout, so runTurn's
    // OWN "exited 0 without agent_end" warn (piSdkManager.ts) fires on every
    // turn in this suite regardless of the overlay outcome; a bare
    // `toHaveBeenCalled()` would pass even if the catch block swallowed the
    // error without ever calling logger.warn.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[PI] role overlay install failed for runId=run-throws'),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('boom: simulated overlay failure'),
    );

    db.close();
  });

  it('does NOT install when worktreePath is not explicit (guards the process.cwd() fallback)', async () => {
    const db = createTestDb();

    // worktreePath intentionally OMITTED (cast around the required-field type,
    // the same way a caller that skipped it would reach this code at runtime):
    // spawnCliProcess falls back to `process.cwd()` for the TURN's own cwd,
    // but the overlay install must NOT follow that fallback — installing into
    // whatever directory happens to host the Electron/test process (this
    // package's real git checkout, under `pnpm dev`) would scribble
    // `cyboflow-*.md` files and a git-exclude edit into unrelated repo state.
    const outcome = await makeManager(db).spawnCliProcess({
      panelId: 'panel-no-worktree',
      sessionId: 'sess-no-worktree',
      prompt: 'do the task',
      runId: 'run-no-worktree',
    } as unknown as ClaudeSpawnerOptions);

    // NEGATIVE CONTROL: the "installs" test above proves a db + runId +
    // EXPLICIT worktreePath installs. Only removing worktreePath here must
    // flip this to "not called" — a guard that checked `state.cwd` (which
    // absorbs the `?? process.cwd()` fallback and is therefore always a
    // non-empty string) instead of `options.worktreePath` would fail this,
    // because it would treat the fallback directory as a "real" worktree.
    expect(installAgentOverlaySpy).not.toHaveBeenCalled();
    expect(ensureBundleExcludedSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ resultText: null });

    db.close();
  });
});
