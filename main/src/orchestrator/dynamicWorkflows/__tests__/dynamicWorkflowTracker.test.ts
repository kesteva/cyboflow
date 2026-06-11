/**
 * Unit tests for DynamicWorkflowTracker — launch detection through a REAL
 * EventRouter, journal-tail state emissions, record/notification finalization,
 * review-item creation via ReviewItemRouter, the per-session cap, and the
 * merge/dismiss auto-resolve sweep.
 *
 * DB setup mirrors reviewItemRouter.test.ts (better-sqlite3 :memory: +
 * migrations via the shared dbAdapter fixture) plus a minimal sessions table
 * carrying the columns the tracker reads (name, project_id, run_id).
 * Timer-driven paths use vi.useFakeTimers() (mirroring stuckDetector.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventRouter } from '../../../services/streamParser/eventRouter';
import { ReviewItemRouter } from '../../reviewItemRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { DynamicWorkflowTracker, dynamicWorkflowEvents } from '../dynamicWorkflowTracker';
import {
  DYNAMIC_WORKFLOW_REVIEW_SOURCE,
} from '../../../../../shared/types/dynamicWorkflows';
import type { DynamicWorkflowChangedEvent } from '../../../../../shared/types/dynamicWorkflows';
import type { AssistantEvent, UserEvent } from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Test DB builder: projects + minimal sessions + 006/011/014/015/016.
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Minimal sessions shape: just the columns the tracker reads
    -- (schema.sql name + legacy add_project_support project_id + migration 009 run_id).
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id INTEGER,
      run_id TEXT
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));

  // Seed the run hosting the session (review_items.run_id FK) + the session.
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES ('run-1', 'wf-1', 1, 'running', 'default')`,
  ).run();
  db.prepare(`INSERT INTO sessions (id, name, project_id, run_id) VALUES ('sess-1', 'My Session', 1, 'run-1')`).run();
  return db;
}

// ---------------------------------------------------------------------------
// Synthetic events + on-disk workflow artifacts
// ---------------------------------------------------------------------------

const SCRIPT_SOURCE = `export const meta = {
  name: 'Parallel refactor',
  description: 'Refactors the API layer in parallel',
  phases: [
    { title: 'Analyze', detail: 'Map the modules' },
    { title: 'Execute' },
  ],
};
export default async function run() {}
`;

function assistantToolUse(id: string): AssistantEvent {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      model: 'claude-test',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Workflow', input: {} }],
    },
  };
}

function userToolResult(toolUseId: string, text: string): UserEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
  };
}

function launchText(taskId: string, transcriptDir: string, scriptPath: string, wfRunId: string): string {
  return [
    `Workflow launched in background. Task ID: ${taskId}`,
    'Summary: x',
    `Transcript dir: ${transcriptDir}`,
    `Script file: ${scriptPath}`,
    `Run ID: ${wfRunId}`,
  ].join('\n');
}

function notificationText(taskId: string, status: string): string {
  return `<task-notification><task-id>${taskId}</task-id><status>${status}</status></task-notification>`;
}

describe('DynamicWorkflowTracker', () => {
  let db: Database.Database;
  let router: EventRouter;
  let tracker: DynamicWorkflowTracker;
  let base: string;
  let transcriptDir: string;
  let scriptPath: string;
  let recordPath: string;
  let journalPath: string;
  let changed: DynamicWorkflowChangedEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    db = buildDb();
    ReviewItemRouter.initialize(dbAdapter(db));
    tracker = DynamicWorkflowTracker.initialize(dbAdapter(db));
    router = new EventRouter();

    base = mkdtempSync(join(tmpdir(), 'cyboflow-dynwf-'));
    transcriptDir = join(base, 'subagents', 'workflows', 'wf_aa11-2b');
    mkdirSync(transcriptDir, { recursive: true });
    mkdirSync(join(base, 'workflows', 'scripts'), { recursive: true });
    scriptPath = join(base, 'workflows', 'scripts', 'foo-wf_aa11-2b.js');
    writeFileSync(scriptPath, SCRIPT_SOURCE);
    recordPath = join(base, 'workflows', 'wf_aa11-2b.json');
    journalPath = join(transcriptDir, 'journal.jsonl');

    changed = [];
    dynamicWorkflowEvents.on('changed', (e: DynamicWorkflowChangedEvent) => changed.push(e));
  });

  afterEach(() => {
    dynamicWorkflowEvents.removeAllListeners('changed');
    DynamicWorkflowTracker._resetForTesting();
    ReviewItemRouter._resetForTesting();
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  /** Run the detect-a-launch flow for the default wf_aa11-2b artifacts. */
  function emitLaunch(): void {
    tracker.attachToRouter(router, { runId: 'run-1', sessionId: 'sess-1' });
    router.emitForRun('run-1', assistantToolUse('tu1'));
    router.emitForRun('run-1', userToolResult('tu1', launchText('wabc123', transcriptDir, scriptPath, 'wf_aa11-2b')));
  }

  function pendingReviewItems(): Array<{ title: string; body: string; kind: string; run_id: string; blocking: number; source: string; status: string }> {
    return db
      .prepare('SELECT title, body, kind, run_id, blocking, source, status FROM review_items')
      .all() as Array<{ title: string; body: string; kind: string; run_id: string; blocking: number; source: string; status: string }>;
  }

  // -------------------------------------------------------------------------
  // launch detection
  // -------------------------------------------------------------------------

  it('detects a launch and emits a running state with script meta + session info', () => {
    emitLaunch();

    expect(changed).toHaveLength(1);
    const { state } = changed[0];
    expect(state).toMatchObject({
      wfRunId: 'wf_aa11-2b',
      taskId: 'wabc123',
      runId: 'run-1',
      sessionId: 'sess-1',
      projectId: 1,
      sessionName: 'My Session',
      name: 'Parallel refactor',
      description: 'Refactors the API layer in parallel',
      status: 'running',
      agents: [],
    });
    expect(state.phases).toEqual([
      { title: 'Analyze', detail: 'Map the modules' },
      { title: 'Execute' },
    ]);
    expect(state.startedAt).toBeTruthy();

    expect(tracker.list()).toHaveLength(1);
    expect(tracker.list('sess-1')).toHaveLength(1);
    expect(tracker.list('sess-other')).toHaveLength(0);
  });

  it('a replayed launch for an already-tracked wfRunId is ignored', () => {
    emitLaunch();
    router.emitForRun('run-1', assistantToolUse('tu2'));
    router.emitForRun('run-1', userToolResult('tu2', launchText('wabc123', transcriptDir, scriptPath, 'wf_aa11-2b')));
    expect(tracker.list()).toHaveLength(1);
    expect(changed).toHaveLength(1);
  });

  it('falls back to the script filename (minus -wf_<id>) when the script is unreadable', () => {
    rmSync(scriptPath);
    emitLaunch();
    const { state } = changed[0];
    expect(state.name).toBe('foo');
    expect(state.phases).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // journal tailing
  // -------------------------------------------------------------------------

  it('tails the journal and emits agent updates', async () => {
    emitLaunch();

    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed.at(-1)?.state.agents).toEqual([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a2', status: 'running' },
    ]);

    appendFileSync(journalPath, '{"type":"result","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed.at(-1)?.state.agents).toEqual([
      { agentId: 'a1', status: 'done' },
      { agentId: 'a2', status: 'running' },
    ]);
    expect(changed.at(-1)?.state.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // finalization: terminal record (authoritative)
  // -------------------------------------------------------------------------

  it('finalizes from the terminal record and creates a review item', async () => {
    emitLaunch();
    writeFileSync(
      recordPath,
      JSON.stringify({ status: 'completed', summary: 'All done', agentCount: 3, totalTokens: 999 }),
    );
    await vi.advanceTimersByTimeAsync(1000);

    const final = changed.at(-1)?.state;
    expect(final?.status).toBe('completed');
    expect(final?.summary).toBe('All done');
    expect(final?.totals).toEqual({ agentCount: 3, totalTokens: 999 });
    expect(final?.completedAt).toBeTruthy();

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    const items = pendingReviewItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Dynamic workflow finished: Parallel refactor',
      kind: 'human_task',
      run_id: 'run-1',
      blocking: 0,
      source: DYNAMIC_WORKFLOW_REVIEW_SOURCE,
      status: 'pending',
    });
    expect(items[0].body).toContain('All done');
    expect(items[0].body).toContain('3 subagents');
    expect(items[0].body).toContain('My Session');
  });

  // -------------------------------------------------------------------------
  // finalization: notification accelerator
  // -------------------------------------------------------------------------

  it('a terminal notification without a record finalizes (killed -> failed)', async () => {
    emitLaunch();
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'killed')));

    const final = changed.at(-1)?.state;
    expect(final?.status).toBe('failed');
    expect(final?.completedAt).toBeTruthy();

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    expect(pendingReviewItems()[0].title).toBe('Dynamic workflow finished: Parallel refactor');
  });

  it('a terminal notification prefers the record data when the record exists', async () => {
    emitLaunch();
    writeFileSync(recordPath, JSON.stringify({ status: 'completed', summary: 'Record wins' }));
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'failed')));

    const final = changed.at(-1)?.state;
    expect(final?.status).toBe('completed');
    expect(final?.summary).toBe('Record wins');
  });

  it('non-terminal notifications and unknown task ids are ignored', () => {
    emitLaunch();
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'running')));
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('w-unknown', 'completed')));
    expect(tracker.list()[0].status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // stall detection
  // -------------------------------------------------------------------------

  it('marks a stalled workflow failed and creates a "stalled" review item', async () => {
    emitLaunch();
    // No journal, no record — let the default 1h idle timeout elapse.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 2000);

    const final = changed.at(-1)?.state;
    expect(final?.status).toBe('failed');
    expect(final?.completedAt).toBeTruthy();

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    expect(pendingReviewItems()[0].title).toBe('Dynamic workflow stalled: Parallel refactor');
  });

  // -------------------------------------------------------------------------
  // router attachment lifecycle
  // -------------------------------------------------------------------------

  it('re-attaching for the same runId replaces the previous subscription', () => {
    tracker.attachToRouter(router, { runId: 'run-1', sessionId: 'sess-1' });
    tracker.attachToRouter(router, { runId: 'run-1', sessionId: 'sess-1' });
    expect(router.listenerCount('run-1')).toBe(1);
  });

  it('detachRun removes the subscription but the tailer keeps running', async () => {
    emitLaunch();
    tracker.detachRun('run-1');
    expect(router.listenerCount('run-1')).toBe(0);

    // The file-based tailer is still live after detach.
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed.at(-1)?.state.agents).toEqual([{ agentId: 'a1', status: 'running' }]);
  });

  // -------------------------------------------------------------------------
  // per-session cap
  // -------------------------------------------------------------------------

  it('caps tracked states at 5 per session, dropping the oldest terminal one', () => {
    tracker.attachToRouter(router, { runId: 'run-1', sessionId: 'sess-1' });
    const launchNth = (n: number): void => {
      const tDir = join(base, 'subagents', 'workflows', `wf_cap${n}`);
      const sPath = join(base, 'workflows', 'scripts', `flow${n}-wf_cap${n}.js`);
      router.emitForRun('run-1', assistantToolUse(`tu-cap${n}`));
      router.emitForRun('run-1', userToolResult(`tu-cap${n}`, launchText(`w${n}`, tDir, sPath, `wf_cap${n}`)));
    };

    for (let n = 1; n <= 5; n++) launchNth(n);
    // Terminate #1 so it becomes droppable (running states are never dropped).
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('w1', 'killed')));
    launchNth(6);

    const ids = tracker.list('sess-1').map((s) => s.wfRunId);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain('wf_cap1');
    expect(ids).toContain('wf_cap6');
  });

  // -------------------------------------------------------------------------
  // merge/dismiss auto-resolve sweep
  // -------------------------------------------------------------------------

  it('resolveReviewItemsForSession resolves pending dynamic-workflow items for the session run', async () => {
    emitLaunch();
    writeFileSync(recordPath, JSON.stringify({ status: 'completed', summary: 'Done' }));
    await vi.advanceTimersByTimeAsync(1000);
    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    expect(pendingReviewItems()).toHaveLength(1);

    const resolved = await tracker.resolveReviewItemsForSession('sess-1', 'user');
    expect(resolved).toBe(1);

    const row = db
      .prepare('SELECT status, resolution FROM review_items')
      .get() as { status: string; resolution: string };
    expect(row.status).toBe('resolved');
    expect(row.resolution).toBe('session closed (merge/dismiss)');

    // Idempotent: nothing pending remains.
    expect(await tracker.resolveReviewItemsForSession('sess-1', 'user')).toBe(0);
    // Unknown session / session without a run resolves nothing.
    expect(await tracker.resolveReviewItemsForSession('sess-nope', 'user')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // fail-soft paths
  // -------------------------------------------------------------------------

  it('session lookup failure uses the sentinel and skips review-item creation', async () => {
    tracker.attachToRouter(router, { runId: 'run-2', sessionId: 'ghost' });
    router.emitForRun('run-2', assistantToolUse('tu-g'));
    router.emitForRun('run-2', userToolResult('tu-g', launchText('wg1', transcriptDir, scriptPath, 'wf_aa11-2b')));

    const { state } = changed[0];
    expect(state.sessionName).toBe('');
    expect(state.projectId).toBe(-1);

    router.emitForRun('run-2', userToolResult('tu-x', notificationText('wg1', 'completed')));
    expect(changed.at(-1)?.state.status).toBe('completed');
    expect(pendingReviewItems()).toHaveLength(0);
  });

  it('finalization is fail-soft when ReviewItemRouter is uninitialized', async () => {
    ReviewItemRouter._resetForTesting();
    const warn = vi.fn();
    DynamicWorkflowTracker._resetForTesting();
    tracker = DynamicWorkflowTracker.initialize(dbAdapter(db), {
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    emitLaunch();
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'completed')));
    expect(changed.at(-1)?.state.status).toBe('completed');
    expect(warn).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // singleton lifecycle
  // -------------------------------------------------------------------------

  it('getInstance throws and tryGetInstance returns null before initialize', () => {
    DynamicWorkflowTracker._resetForTesting();
    expect(() => DynamicWorkflowTracker.getInstance()).toThrow(/not been initialized/);
    expect(DynamicWorkflowTracker.tryGetInstance()).toBeNull();
    const instance = DynamicWorkflowTracker.initialize(dbAdapter(db));
    expect(DynamicWorkflowTracker.getInstance()).toBe(instance);
    expect(DynamicWorkflowTracker.tryGetInstance()).toBe(instance);
  });
});
