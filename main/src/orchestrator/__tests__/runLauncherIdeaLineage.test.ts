/**
 * RunLauncher — the two idea-session behaviours added in Stage 1 of the idea
 * sessions plan:
 *
 *   1. `assertIdeaNotBusy` gates a SINGULAR idea-seeded launch BEFORE createRun,
 *      so a rejection never leaves a half-created run row behind.
 *   2. `sessions.origin_idea_id` (migration 112) records which idea minted the
 *      host session — first-writer-wins, singular launches only, fail-soft — and
 *      the session is refreshed so the sidebar regroups immediately.
 *
 * Multi-idea `ideaIds` batches are exempt from BOTH (they would otherwise all
 * land under idea #1, and a parked batch would block
 * `runs.separatePlannerForIdea`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { RunLauncher } from '../runLauncher';
import type { SessionRefresherLike } from '../runLauncher';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { WorktreeManager } from '../../services/worktreeManager';
import { IdeaBusyError } from '../ideaBusy';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import type { CliSubstrate } from '../../../../shared/types/substrate';

beforeEach(() => vi.clearAllMocks());

/** A session-hosted DB carrying the migration-111/112 session columns. */
function ideaLineageDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_finding_ids TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_idea_ids TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_prompt TEXT');
  db.exec(`
    CREATE TABLE sessions (
      id             TEXT PRIMARY KEY,
      worktree_path  TEXT,
      base_branch    TEXT,
      run_id         TEXT,
      status         TEXT,
      archived       INTEGER DEFAULT 0,
      in_place       BOOLEAN DEFAULT 0,
      is_main_repo   BOOLEAN DEFAULT 0,
      home_idea_id   TEXT,
      origin_idea_id TEXT
    )
  `);
  return db;
}

interface Fixture {
  launcher: RunLauncher;
  db: Database.Database;
  workflowId: string;
  sessionId: string;
  cannedRunId: string;
  refreshed: string[];
  createRun: ReturnType<typeof vi.fn>;
}

function makeFixture(db: Database.Database, tmpDir: string, workflowName = 'planner'): Fixture {
  const adapter = dbAdapter(db);
  const workflowId = randomUUID();
  db.prepare(
    'INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, ?, ?, ?)',
  ).run(workflowId, workflowName, `/fake/${workflowName}.md`, 'default');

  const cannedRunId = randomUUID().replace(/-/g, '');
  const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', workflowName, cannedRunId.slice(0, 8));
  const sessionId = 'sess-host';
  db.prepare('INSERT INTO sessions (id, worktree_path, base_branch, status) VALUES (?, ?, ?, ?)').run(
    sessionId,
    cannedWorktreePath,
    'main',
    'stopped',
  );

  const createRun = vi.fn((_id: string, substrate?: CliSubstrate, sid?: string) => {
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
    ).run(cannedRunId, workflowId, 1, sid ?? null);
    return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
  });

  const fakeRegistry = {
    getById: (id: string) =>
      db
        .prepare(
          'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
        )
        .get(id) ?? null,
    createRun,
    resolveEffectiveTuningLevel: () => null,
  } as unknown as WorkflowRegistry;

  const fakeWorktree = {
    createDeterministicWorktree: vi.fn(),
    getProjectMainBranch: vi.fn().mockResolvedValue('cyboflow/planner/abc'),
    getHeadCommit: vi.fn().mockResolvedValue('abc123def456'),
  } as unknown as WorktreeManager;

  const refreshed: string[] = [];
  const sessionRefresher: SessionRefresherLike = {
    refreshSessionFromDatabase: (id) => {
      refreshed.push(id);
      return undefined;
    },
  };

  const launcher = new RunLauncher(
    adapter,
    fakeRegistry,
    fakeWorktree,
    makeSpyLogger(),
    undefined, // publisher
    undefined, // runExecutor
    undefined, // runQueueRegistry
    undefined, // taskStageDeriver
    undefined, // sprintLanes
    undefined, // sessionPermissionModeDeps
    undefined, // variantResolver
    sessionRefresher, // 16th: idea-lineage refresh seam
  );

  return { launcher, db, workflowId, sessionId, cannedRunId, refreshed, createRun };
}

function readOrigin(db: Database.Database, sessionId: string): string | null {
  return (
    db.prepare('SELECT origin_idea_id FROM sessions WHERE id = ?').get(sessionId) as {
      origin_idea_id: string | null;
    }
  ).origin_idea_id;
}

describe('RunLauncher.launch — origin_idea_id lineage (migration 112)', () => {
  it('stamps the host session and refreshes it for a SINGULAR idea seed', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId, refreshed } = makeFixture(db, tmpDir);

      await launcher.launch(workflowId, tmpDir, undefined, undefined, 'idea-1', sessionId);

      expect(readOrigin(db, sessionId)).toBe('idea-1');
      expect(refreshed).toEqual([sessionId]);
    });
  });

  it('does NOT stamp for a multi-idea ideaIds batch (batches stay ungrouped)', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId, refreshed } = makeFixture(db, tmpDir);

      await launcher.launch(
        workflowId,
        tmpDir,
        undefined,
        undefined,
        undefined,
        sessionId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { ideaIds: ['idea-1', 'idea-2'] },
      );

      expect(readOrigin(db, sessionId)).toBeNull();
      expect(refreshed).toEqual([]);
    });
  });

  it('leaves an EXISTING origin untouched (first writer wins)', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId, refreshed } = makeFixture(db, tmpDir);
      db.prepare('UPDATE sessions SET origin_idea_id = ? WHERE id = ?').run('idea-first', sessionId);

      await launcher.launch(workflowId, tmpDir, undefined, undefined, 'idea-second', sessionId);

      expect(readOrigin(db, sessionId)).toBe('idea-first');
      expect(refreshed).toEqual([]);
    });
  });

  it('leaves the session alone when no idea seeds the launch', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId } = makeFixture(db, tmpDir);

      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, sessionId);

      expect(readOrigin(db, sessionId)).toBeNull();
    });
  });
});

describe('RunLauncher.launch — max-one-running-per-idea guard', () => {
  it('rejects a singular idea launch while the idea already holds a non-terminal run', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId, cannedRunId, createRun } = makeFixture(db, tmpDir);
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id) VALUES ('run-live', ?, 1, 'running', 'default', 'idea-1')",
      ).run(workflowId);

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, 'idea-1', sessionId),
      ).rejects.toBeInstanceOf(IdeaBusyError);

      // Rejected BEFORE createRun — no half-created run row.
      expect(createRun).not.toHaveBeenCalled();
      expect(db.prepare('SELECT id FROM workflow_runs WHERE id = ?').get(cannedRunId)).toBeUndefined();
    });
  });

  it("rejects while the idea's home session is mid-turn", async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId, createRun } = makeFixture(db, tmpDir);
      db.prepare(
        "INSERT INTO sessions (id, status, home_idea_id) VALUES ('sess-home', 'running', 'idea-1')",
      ).run();

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, 'idea-1', sessionId),
      ).rejects.toBeInstanceOf(IdeaBusyError);
      expect(createRun).not.toHaveBeenCalled();
    });
  });

  // The exemption keeping runs.separatePlannerForIdea alive.
  it('ALLOWS a singular launch while a MULTI-idea batch seeded with the same idea is parked', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId } = makeFixture(db, tmpDir);
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id, seed_idea_ids)
         VALUES ('run-batch', ?, 1, 'awaiting_review', 'default', 'idea-1', ?)`,
      ).run(workflowId, JSON.stringify(['idea-1', 'idea-2']));

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, 'idea-1', sessionId),
      ).resolves.toMatchObject({ worktreePath: expect.any(String) });
      expect(readOrigin(db, sessionId)).toBe('idea-1');
    });
  });

  it('does not gate a launch that seeds no idea at all', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const { launcher, workflowId, sessionId } = makeFixture(db, tmpDir);
      db.prepare(
        "INSERT INTO sessions (id, status, origin_idea_id) VALUES ('sess-child', 'running', 'idea-1')",
      ).run();

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, sessionId),
      ).resolves.toMatchObject({ runId: expect.any(String) });
    });
  });
});

/**
 * The NON-SEED lineage variant (idea canvas "Launch sprint"): a taskIds-seeded
 * launch carries `launchOptions.originIdeaId` — same origin stamp + same busy
 * guard as a singular idea seed, but seed_idea_id stays NULL (no `# Selected
 * idea` block in the run prompt).
 */
describe('RunLauncher.launch — launchOptions.originIdeaId (non-seed lineage)', () => {
  const launchWithOrigin = (
    f: Fixture,
    tmpDir: string,
    originIdeaId: string,
  ): ReturnType<RunLauncher['launch']> =>
    f.launcher.launch(
      f.workflowId,
      tmpDir,
      undefined,
      undefined,
      undefined, // no ideaId seed
      f.sessionId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { originIdeaId },
    );

  it('stamps origin_idea_id + refreshes, WITHOUT writing seed_idea_id', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const f = makeFixture(db, tmpDir);

      await launchWithOrigin(f, tmpDir, 'idea-1');

      expect(readOrigin(db, f.sessionId)).toBe('idea-1');
      expect(f.refreshed).toEqual([f.sessionId]);
      const run = db
        .prepare('SELECT seed_idea_id FROM workflow_runs WHERE id = ?')
        .get(f.cannedRunId) as { seed_idea_id: string | null };
      expect(run.seed_idea_id).toBeNull();
    });
  });

  it('rejects with IdeaBusyError while the idea already holds a non-terminal run', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const f = makeFixture(db, tmpDir);
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id) VALUES ('run-live', ?, 1, 'running', 'default', 'idea-1')",
      ).run(f.workflowId);

      await expect(launchWithOrigin(f, tmpDir, 'idea-1')).rejects.toBeInstanceOf(IdeaBusyError);
      expect(f.createRun).not.toHaveBeenCalled();
    });
  });

  it('a singular idea seed WINS over a disagreeing originIdeaId (seed path stamps)', async () => {
    await withTempDir('runlauncher-lineage-', async (tmpDir) => {
      const db = ideaLineageDb();
      const f = makeFixture(db, tmpDir);

      await f.launcher.launch(
        f.workflowId,
        tmpDir,
        undefined,
        undefined,
        'idea-seed',
        f.sessionId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { originIdeaId: 'idea-origin' },
      );

      expect(readOrigin(db, f.sessionId)).toBe('idea-seed');
    });
  });
});
