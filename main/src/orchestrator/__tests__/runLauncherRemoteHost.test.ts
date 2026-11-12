/**
 * RunLauncher on a remote environment (M2 C3): a session whose `sessions.host_id`
 * names a remote host is gated by the host's prelaunch check BEFORE createRun
 * (no run row on refusal, one deduped notification), reads its worktree's git
 * through the hosts facade, and skips the LOCAL project exclude. A local session
 * (NULL / 'local') takes the pre-M2 path untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { HostLaunchRefusedError, RunLauncher } from '../runLauncher';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { WorktreeManager } from '../../services/worktreeManager';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import { _resetHostsFacadeForTesting, setHostsFacade, type HostsFacade, type HostPrelaunchResult } from '../hostsBridge';
import { ReviewItemRouter } from '../reviewItemRouter';
import { classifyErrorPattern, isSystemicStepError } from '../programmatic/systemicError';
import type { CliSubstrate } from '../../../../shared/types/substrate';

const REMOTE_WT = '/home/u/cf-remote/h1/wt/sess-key';

function makeDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER,
      host_id TEXT,
      worktree_path TEXT,
      base_branch TEXT,
      run_id TEXT,
      in_place BOOLEAN DEFAULT 0,
      is_main_repo BOOLEAN DEFAULT 0
    )
  `);
  return db;
}

interface Harness {
  db: Database.Database;
  launcher: RunLauncher;
  workflowId: string;
  createRun: ReturnType<typeof vi.fn>;
  worktree: { getProjectMainBranch: ReturnType<typeof vi.fn>; getHeadCommit: ReturnType<typeof vi.fn> };
  ensureExclude: ReturnType<typeof vi.fn>;
}

function harness(hostId: string | null, stampedRuntime = 'claude-sdk'): Harness {
  const db = makeDb();
  const workflowId = randomUUID();
  db.prepare(
    "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 7, 'sprint', '/fake/path.md', 'default')",
  ).run(workflowId);
  db.prepare(
    "INSERT INTO sessions (id, project_id, host_id, worktree_path, base_branch) VALUES ('sess-1', 7, ?, ?, 'main')",
  ).run(hostId, hostId === null || hostId === 'local' ? '/local/wt' : REMOTE_WT);
  const createRun = vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
    const runId = randomUUID().replace(/-/g, '');
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id, agent_runtime) VALUES (?, ?, 7, 'queued', 'default', ?, ?)",
    ).run(runId, workflowId, sessionId ?? null, stampedRuntime);
    return { runId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
  });
  const registry = {
    getById: (id: string) =>
      db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
    createRun,
    resolveEffectiveTuningLevel: () => null,
  } as unknown as WorkflowRegistry;
  const worktree = {
    getProjectMainBranch: vi.fn().mockResolvedValue('local-branch'),
    getHeadCommit: vi.fn().mockResolvedValue('localsha'),
  };
  const launcher = new RunLauncher(dbAdapter(db), registry, worktree as unknown as WorktreeManager, makeSpyLogger());
  const ensureExclude = vi.spyOn(launcher, 'ensureGitExcludeEntry').mockResolvedValue(undefined);
  return { db, launcher, workflowId, createRun, worktree, ensureExclude: ensureExclude as unknown as ReturnType<typeof vi.fn> };
}

function fakeFacade(prelaunchResult: HostPrelaunchResult = { ok: true }): {
  facade: HostsFacade;
  prelaunch: ReturnType<typeof vi.fn>;
  gitCapture: ReturnType<typeof vi.fn>;
} {
  const prelaunch = vi.fn(async () => prelaunchResult);
  const gitCapture = vi.fn(async (_h: string, _cwd: string, args: string[]) =>
    args[0] === 'rev-parse' ? 'remotesha\n' : 'cyboflow/remote-branch\n',
  );
  const facade = {
    prelaunch,
    gitCapture,
    get: vi.fn(() => ({ label: 'Build box' })),
  } as unknown as HostsFacade;
  return { facade, prelaunch, gitCapture };
}

let createIfNoPending: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createIfNoPending = vi.fn(async () => ({ reviewItemId: 'ri-1', created: true, event: { id: 1, seq: 1 } }));
  vi.spyOn(ReviewItemRouter, 'getInstance').mockReturnValue({ createIfNoPending } as unknown as ReviewItemRouter);
});

afterEach(() => {
  _resetHostsFacadeForTesting();
  vi.restoreAllMocks();
});

const runCount = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number }).n;

describe('RunLauncher — remote environment launch gate', () => {
  it('a passing prelaunch launches, reading HEAD and the branch through the host and skipping the local exclude', async () => {
    const h = harness('h1');
    const f = fakeFacade();
    setHostsFacade(f.facade);

    const out = await h.launcher.launch(h.workflowId, '/local/project', undefined, undefined, undefined, 'sess-1');

    expect(f.prelaunch).toHaveBeenCalledWith('h1', 'claude-sdk');
    expect(f.prelaunch.mock.invocationCallOrder[0]).toBeLessThan(h.createRun.mock.invocationCallOrder[0]);
    expect(f.gitCapture).toHaveBeenCalledWith('h1', REMOTE_WT, ['branch', '--show-current']);
    expect(f.gitCapture).toHaveBeenCalledWith('h1', REMOTE_WT, ['rev-parse', 'HEAD']);
    expect(h.worktree.getHeadCommit).not.toHaveBeenCalled();
    expect(h.worktree.getProjectMainBranch).not.toHaveBeenCalled();
    expect(h.ensureExclude).not.toHaveBeenCalled();
    expect(out).toMatchObject({ worktreePath: REMOTE_WT, branchName: 'cyboflow/remote-branch' });
    const row = h.db.prepare('SELECT base_sha, status FROM workflow_runs WHERE id = ?').get(out.runId) as {
      base_sha: string;
      status: string;
    };
    expect(row).toEqual({ base_sha: 'remotesha', status: 'starting' });
    expect(createIfNoPending).not.toHaveBeenCalled();
  });

  it('gates the launch runtime: an explicit codex-sdk request is checked for codex', async () => {
    const h = harness('h1', 'codex-sdk');
    const f = fakeFacade();
    setHostsFacade(f.facade);
    await h.launcher.launch(
      h.workflowId, '/local/project', 'sdk', undefined, undefined, 'sess-1',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'codex', 'codex-sdk',
    );
    expect(f.prelaunch).toHaveBeenCalledTimes(1);
    expect(f.prelaunch).toHaveBeenCalledWith('h1', 'codex-sdk');
  });

  it('an unreachable host refuses with a host-unreachable: message (systemic), creates NO run, and files ONE notification', async () => {
    const h = harness('h1');
    const f = fakeFacade({ ok: false, code: 'unreachable', reason: 'ssh-reachable: timed out' });
    setHostsFacade(f.facade);

    const err = await h.launcher
      .launch(h.workflowId, '/local/project', undefined, undefined, undefined, 'sess-1')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HostLaunchRefusedError);
    expect((err as Error).message).toBe('host-unreachable: ssh-reachable: timed out');
    expect(isSystemicStepError((err as Error).message)).toBe(true);
    expect(classifyErrorPattern((err as Error).message)).toBe('host-unreachable');
    expect(h.createRun).not.toHaveBeenCalled();
    expect(runCount(h.db)).toBe(0);
    expect(createIfNoPending).toHaveBeenCalledTimes(1);
    expect(createIfNoPending).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        kind: 'finding',
        source: 'host-launch-failed:h1',
        blocking: false,
        severity: 'warning',
        audience: 'human',
        title: 'Run not started: Build box is unreachable',
      }),
    );
  });

  it('a link-down refusal is also prefixed host-unreachable:, a not-installed one is not', async () => {
    const h = harness('h1');
    setHostsFacade(fakeFacade({ ok: false, code: 'link-down', reason: 'The orchestrator link is down.' }).facade);
    await expect(h.launcher.launch(h.workflowId, '/p', undefined, undefined, undefined, 'sess-1')).rejects.toThrow(
      /^host-unreachable: The orchestrator link is down\.$/,
    );

    const h2 = harness('h1');
    setHostsFacade(fakeFacade({ ok: false, code: 'not-installed', reason: 'cyboflow tools are not installed' }).facade);
    const err = await h2.launcher.launch(h2.workflowId, '/p', undefined, undefined, undefined, 'sess-1').catch((e: unknown) => e);
    expect((err as HostLaunchRefusedError).code).toBe('not-installed');
    expect((err as Error).message).toBe('cyboflow tools are not installed');
    expect(runCount(h2.db)).toBe(0);
  });

  it('a failing notification write never masks the refusal', async () => {
    createIfNoPending.mockRejectedValue(new Error('db locked'));
    const h = harness('h1');
    setHostsFacade(fakeFacade({ ok: false, code: 'unreachable', reason: 'down' }).facade);
    await expect(h.launcher.launch(h.workflowId, '/p', undefined, undefined, undefined, 'sess-1')).rejects.toThrow(
      'host-unreachable: down',
    );
  });

  it('no facade wired: refuses with "Environments are not running" and creates no run', async () => {
    const h = harness('h1');
    await expect(h.launcher.launch(h.workflowId, '/p', undefined, undefined, undefined, 'sess-1')).rejects.toThrow(
      /Environments are not running/,
    );
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it('refuses a runtime a remote environment cannot run (interactive, OMP) before createRun', async () => {
    const h = harness('h1');
    const f = fakeFacade();
    setHostsFacade(f.facade);
    await expect(
      h.launcher.launch(h.workflowId, '/p', 'interactive', undefined, undefined, 'sess-1'),
    ).rejects.toThrow(/claude-interactive, which cannot run on a remote environment/);
    await expect(
      h.launcher.launch(
        h.workflowId, '/p', 'sdk', undefined, undefined, 'sess-1',
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        'omp', 'omp-sdk',
      ),
    ).rejects.toThrow(/omp-sdk, which cannot run on a remote environment/);
    expect(f.prelaunch).not.toHaveBeenCalled();
    expect(h.createRun).not.toHaveBeenCalled();
  });

  it('re-gates when createRun stamps a different SDK runtime than the one checked (e.g. a saved codex mix)', async () => {
    const h = harness('h1', 'codex-sdk');
    const f = fakeFacade();
    setHostsFacade(f.facade);
    await h.launcher.launch(h.workflowId, '/p', undefined, undefined, undefined, 'sess-1');
    expect(f.prelaunch.mock.calls).toEqual([
      ['h1', 'claude-sdk'],
      ['h1', 'codex-sdk'],
    ]);
  });
});

describe('RunLauncher — remote runtime drift after createRun', () => {
  it('a stamped non-SDK runtime fails the just-created run with a readable reason', async () => {
    const h = harness('h1', 'claude-interactive');
    setHostsFacade(fakeFacade().facade);
    await expect(h.launcher.launch(h.workflowId, '/p', undefined, undefined, undefined, 'sess-1')).rejects.toThrow(
      /claude-interactive, which cannot run on a remote environment/,
    );
    const row = h.db.prepare('SELECT status FROM workflow_runs').get() as { status: string };
    expect(row.status).toBe('failed');
  });
});

describe('RunLauncher — local sessions are untouched', () => {
  it.each([[null], ['local']])('host_id %s: no prelaunch, local git, local exclude', async (hostId) => {
    const h = harness(hostId);
    const f = fakeFacade();
    setHostsFacade(f.facade);

    const out = await h.launcher.launch(h.workflowId, '/local/project', undefined, undefined, undefined, 'sess-1');

    expect(f.prelaunch).not.toHaveBeenCalled();
    expect(f.gitCapture).not.toHaveBeenCalled();
    expect(h.ensureExclude).toHaveBeenCalledWith('/local/project');
    expect(h.worktree.getProjectMainBranch).toHaveBeenCalledWith('/local/wt');
    expect(h.worktree.getHeadCommit).toHaveBeenCalledWith('/local/wt');
    expect(out).toMatchObject({ worktreePath: '/local/wt', branchName: 'local-branch' });
  });
});
