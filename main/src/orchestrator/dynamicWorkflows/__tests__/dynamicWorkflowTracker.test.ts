/**
 * Unit tests for DynamicWorkflowTracker — launch detection through a REAL
 * EventRouter, journal-tail state emissions, record/notification finalization,
 * review-item creation via ReviewItemRouter, the per-session cap, and the
 * merge-only auto-resolve sweep.
 *
 * DB setup mirrors reviewItemRouter.test.ts (better-sqlite3 :memory: +
 * migrations via the shared dbAdapter fixture) plus a minimal sessions table
 * carrying the columns the tracker reads (name, project_id, run_id).
 * Timer-driven paths use vi.useFakeTimers() (mirroring stuckDetector.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventRouter } from '../../../services/streamParser/eventRouter';
import { ReviewItemRouter } from '../../reviewItemRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { DynamicWorkflowTracker, dynamicWorkflowEvents } from '../dynamicWorkflowTracker';
import { JournalTailer } from '../journalTailer';
import {
  DYNAMIC_WORKFLOW_REVIEW_SOURCE,
} from '../../../../../shared/types/dynamicWorkflows';
import type { DynamicWorkflowChangedEvent } from '../../../../../shared/types/dynamicWorkflows';
import type { AssistantEvent, UserEvent } from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Test DB builder: projects + minimal sessions + 006/011/014/015/016/034/046.
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
  db.exec(readFileSync(join(migDir, '026_run_usage_spec_hash_revisions.sql'), 'utf-8'));
  // 034 adds the finding-triage columns the 046 rebuild copies across; 046 widens
  // the kind CHECK so the tracker's `notification` items pass the constraint.
  db.exec(readFileSync(join(migDir, '034_findings_triage.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '046_notification_kind.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '071_raw_events_dedup.sql'), 'utf-8'));

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
  let removed: string[];

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
    removed = [];
    dynamicWorkflowEvents.on('changed', (e: DynamicWorkflowChangedEvent) => changed.push(e));
    dynamicWorkflowEvents.on('removed', (e: { wfRunId: string }) => removed.push(e.wfRunId));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dynamicWorkflowEvents.removeAllListeners('changed');
    dynamicWorkflowEvents.removeAllListeners('removed');
    DynamicWorkflowTracker._resetForTesting();
    ReviewItemRouter._resetForTesting();
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  /**
   * The tailer's async fs/promises ticks/drains and the tracker's async
   * finalize/stall cascade run through serialized promise queues; fake timers do
   * NOT advance the libuv poll phase, so we turn the real event loop via bounded
   * real-fs `stat()` calls to let that IO settle. Use after advancing the fake
   * interval, and after a terminal `<task-notification>` (which kicks off an
   * un-awaited async finalize).
   */
  async function flushIo(): Promise<void> {
    for (let i = 0; i < 40; i++) await stat(base);
  }

  /** Advance the fake interval, then drain the real fs IO the ticks kicked off. */
  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flushIo();
  }

  /** Run the detect-a-launch flow for the default wf_aa11-2b artifacts. */
  function emitLaunch(): void {
    tracker.attachToRouter(router, { runId: 'run-1', sessionId: 'sess-1' });
    router.emitForRun('run-1', assistantToolUse('tu1'));
    router.emitForRun('run-1', userToolResult('tu1', launchText('wabc123', transcriptDir, scriptPath, 'wf_aa11-2b')));
  }

  function pendingReviewItems(): Array<{ title: string; body: string; kind: string; run_id: string; blocking: number; source: string; status: string; payload_json: string | null }> {
    return db
      .prepare('SELECT title, body, kind, run_id, blocking, source, status, payload_json FROM review_items')
      .all() as Array<{ title: string; body: string; kind: string; run_id: string; blocking: number; source: string; status: string; payload_json: string | null }>;
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
    await advance(1000);
    expect(changed.at(-1)?.state.agents).toEqual([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a2', status: 'running' },
    ]);

    appendFileSync(journalPath, '{"type":"result","agentId":"a1"}\n');
    await advance(1000);
    expect(changed.at(-1)?.state.agents).toEqual([
      { agentId: 'a1', status: 'done' },
      { agentId: 'a2', status: 'running' },
    ]);
    expect(changed.at(-1)?.state.status).toBe('running');
  });

  it('merges agent transcript stats into the emitted state (absent before any parse)', async () => {
    emitLaunch();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(1000);

    // Before the transcript lands, the optional stats fields are absent.
    const before = changed.at(-1)?.state.agents[0];
    expect(before).toMatchObject({ agentId: 'a1', status: 'running' });
    expect(before?.model).toBeUndefined();
    expect(before?.inputTokens).toBeUndefined();
    expect(before?.outputTokens).toBeUndefined();
    expect(before?.cacheReadInputTokens).toBeUndefined();
    expect(before?.cacheCreationInputTokens).toBeUndefined();
    expect(before?.toolUses).toBeUndefined();
    expect(before?.startedAt).toBeUndefined();
    expect(before?.lastActivityAt).toBeUndefined();
    expect(before?.promptExcerpt).toBeUndefined();

    const emitsBefore = changed.length;
    writeFileSync(
      join(transcriptDir, 'agent-a1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Do the thing' },
          timestamp: '2026-06-11T10:00:00.000Z',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-fable-5',
            usage: { input_tokens: 4, output_tokens: 12 },
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
          },
          timestamp: '2026-06-11T10:00:04.000Z',
        }),
        '',
      ].join('\n'),
    );
    await advance(1000);
    expect(changed.length).toBe(emitsBefore + 1); // a stats-only change also emits onChanged
    expect(changed.at(-1)?.state.agents).toEqual([
      {
        agentId: 'a1',
        status: 'running',
        model: 'claude-fable-5',
        inputTokens: 4,
        outputTokens: 12,
        toolUses: 1,
        startedAt: '2026-06-11T10:00:00.000Z',
        lastActivityAt: '2026-06-11T10:00:04.000Z',
        promptExcerpt: 'Do the thing',
      },
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
    await advance(1000);

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
      kind: 'notification',
      run_id: 'run-1',
      blocking: 0,
      source: DYNAMIC_WORKFLOW_REVIEW_SOURCE,
      status: 'pending',
    });
    expect(JSON.parse(items[0].payload_json ?? '{}')).toEqual({
      kind: 'notification',
      notificationType: 'dynamic-workflow-finished',
    });
    expect(items[0].body).toContain('All done');
    expect(items[0].body).toContain('3 subagents');
    expect(items[0].body).toContain('My Session');
  });

  it('drains transcripts, persists nested cumulative usage, then rolls up', async () => {
    const order: string[] = [];
    const persisted: Array<{ runId: string; event: unknown; dedupKey: string }> = [];
    const originalDrainToEof = JournalTailer.prototype.drainToEof;
    vi.spyOn(JournalTailer.prototype, 'drainToEof').mockImplementation(async function (this: JournalTailer) {
      order.push('drain');
      await originalDrainToEof.call(this);
    });

    DynamicWorkflowTracker._resetForTesting();
    tracker = DynamicWorkflowTracker.initialize(dbAdapter(db), {
      rawEventsSink: {
        persistSubagentUsage: (runId, event, dedupKey) => {
          order.push('persist');
          persisted.push({ runId, event, dedupKey });
        },
      },
      rollupUsage: (_database, runId) => {
        order.push(`rollup:${runId}`);
      },
    });
    emitLaunch();

    writeFileSync(
      journalPath,
      '{"type":"started","agentId":"a1"}\n{"type":"started","agentId":"a2"}\n',
    );
    await advance(1000);
    writeFileSync(
      join(transcriptDir, 'agent-a1.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-test',
          usage: {
            input_tokens: 11,
            output_tokens: 13,
            cache_read_input_tokens: 17,
            cache_creation_input_tokens: 19,
          },
          content: [],
        },
      })}\n`,
    );
    writeFileSync(
      join(transcriptDir, 'agent-a2.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-haiku-test',
          usage: {
            input_tokens: 23,
            output_tokens: 29,
            cache_read_input_tokens: 31,
            cache_creation_input_tokens: 37,
          },
          content: [],
        },
      })}\n`,
    );

    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'completed')));
    await flushIo(); // finalize -> drain -> persist -> rollup runs async off the notification

    expect(order).toEqual(['drain', 'persist', 'persist', 'rollup:run-1']);
    expect(persisted).toEqual([
      {
        runId: 'run-1',
        dedupKey: 'subagent:wf_aa11-2b:a1',
        event: {
          type: 'subagent_usage',
          subagent: { wfRunId: 'wf_aa11-2b', agentId: 'a1' },
          message: {
            model: 'claude-sonnet-test',
            usage: {
              input_tokens: 11,
              output_tokens: 13,
              cache_read_input_tokens: 17,
              cache_creation_input_tokens: 19,
            },
          },
        },
      },
      {
        runId: 'run-1',
        dedupKey: 'subagent:wf_aa11-2b:a2',
        event: {
          type: 'subagent_usage',
          subagent: { wfRunId: 'wf_aa11-2b', agentId: 'a2' },
          message: {
            model: 'claude-haiku-test',
            usage: {
              input_tokens: 23,
              output_tokens: 29,
              cache_read_input_tokens: 31,
              cache_creation_input_tokens: 37,
            },
          },
        },
      },
    ]);
  });

  it('uses the real sink with unknown/zero fallbacks at the finalize seam', async () => {
    emitLaunch();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(1000);

    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'completed')));
    await flushIo();

    const row = db
      .prepare(`SELECT event_type, payload_json, dedup_key FROM raw_events WHERE event_type = 'subagent_usage'`)
      .get() as { event_type: string; payload_json: string; dedup_key: string };
    expect(row.event_type).toBe('subagent_usage');
    expect(row.dedup_key).toBe('subagent:wf_aa11-2b:a1');
    expect(JSON.parse(row.payload_json)).toEqual({
      type: 'subagent_usage',
      subagent: { wfRunId: 'wf_aa11-2b', agentId: 'a1' },
      message: {
        model: 'unknown',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });
    expect(db.prepare('SELECT run_id FROM run_usage WHERE run_id = ?').get('run-1')).toEqual({ run_id: 'run-1' });
  });

  // -------------------------------------------------------------------------
  // finalization: notification accelerator
  // -------------------------------------------------------------------------

  it('a terminal notification without a record finalizes (killed -> failed)', async () => {
    emitLaunch();
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'killed')));
    await flushIo();

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
    await flushIo();

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
    await advance(60 * 60 * 1000 + 2000);

    const final = changed.at(-1)?.state;
    expect(final?.status).toBe('failed');
    expect(final?.completedAt).toBeTruthy();

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    const stalled = pendingReviewItems()[0];
    expect(stalled.title).toBe('Dynamic workflow stalled: Parallel refactor');
    expect(stalled.kind).toBe('notification');
    expect(JSON.parse(stalled.payload_json ?? '{}')).toEqual({
      kind: 'notification',
      notificationType: 'dynamic-workflow-stalled',
    });
  });

  it('uses the same drain-persist-rollup ordering at the stalled seam', async () => {
    const order: string[] = [];
    const persisted: Array<{ runId: string; event: unknown; dedupKey: string }> = [];
    const originalDrainToEof = JournalTailer.prototype.drainToEof;
    vi.spyOn(JournalTailer.prototype, 'drainToEof').mockImplementation(async function (this: JournalTailer) {
      order.push('drain');
      await originalDrainToEof.call(this);
    });
    DynamicWorkflowTracker._resetForTesting();
    tracker = DynamicWorkflowTracker.initialize(dbAdapter(db), {
      rawEventsSink: {
        persistSubagentUsage: (runId, event, dedupKey) => {
          order.push('persist');
          persisted.push({ runId, event, dedupKey });
        },
      },
      rollupUsage: () => {
        order.push('rollup');
      },
    });
    emitLaunch();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(1000);
    writeFileSync(
      join(transcriptDir, 'agent-a1.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-stalled-test',
          usage: {
            input_tokens: 41,
            output_tokens: 43,
            cache_read_input_tokens: 47,
            cache_creation_input_tokens: 53,
          },
          content: [],
        },
      })}\n`,
    );

    await advance(60 * 60 * 1000 + 1000);

    expect(order).toEqual(['drain', 'persist', 'rollup']);
    expect(persisted).toEqual([
      {
        runId: 'run-1',
        dedupKey: 'subagent:wf_aa11-2b:a1',
        event: {
          type: 'subagent_usage',
          subagent: { wfRunId: 'wf_aa11-2b', agentId: 'a1' },
          message: {
            model: 'claude-stalled-test',
            usage: {
              input_tokens: 41,
              output_tokens: 43,
              cache_read_input_tokens: 47,
              cache_creation_input_tokens: 53,
            },
          },
        },
      },
    ]);
    expect(tracker.list()[0].status).toBe('failed');
  });

  it('late finalize after a stall overwrites the partial cumulative snapshot', async () => {
    emitLaunch();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    const transcriptPath = join(transcriptDir, 'agent-a1.jsonl');
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-test',
          usage: {
            input_tokens: 2,
            output_tokens: 3,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 7,
          },
          content: [],
        },
      })}\n`,
    );
    await advance(1000);
    await advance(60 * 60 * 1000 + 1000);

    const readPersistedUsage = (): {
      count: number;
      usage: Record<string, number>;
    } => {
      const rows = db
        .prepare(`SELECT payload_json FROM raw_events WHERE event_type = 'subagent_usage'`)
        .all() as Array<{ payload_json: string }>;
      const payload = JSON.parse(rows[0].payload_json) as {
        message: { usage: Record<string, number> };
      };
      return { count: rows.length, usage: payload.message.usage };
    };

    expect(readPersistedUsage()).toEqual({
      count: 1,
      usage: {
        input_tokens: 2,
        output_tokens: 3,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
      },
    });

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-test',
          usage: {
            input_tokens: 11,
            output_tokens: 13,
            cache_read_input_tokens: 17,
            cache_creation_input_tokens: 19,
          },
          content: [],
        },
      })}\n`,
    );
    router.emitForRun('run-1', userToolResult('tu-late', notificationText('wabc123', 'completed')));
    await flushIo();

    expect(readPersistedUsage()).toEqual({
      count: 1,
      usage: {
        input_tokens: 13,
        output_tokens: 16,
        cache_read_input_tokens: 22,
        cache_creation_input_tokens: 26,
      },
    });
    expect(tracker.list()[0].status).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // terminal-transition race (dismiss / stall vs. an in-flight async finalize)
  // -------------------------------------------------------------------------

  it('a normal finalize still emits exactly one terminal change and one review item', async () => {
    // Regression guard for the non-racing path: the claim + identity re-validation
    // must not change the single-transition behavior.
    emitLaunch();
    const before = changed.length;
    writeFileSync(recordPath, JSON.stringify({ status: 'completed', summary: 'Done once' }));
    await advance(1000);

    const terminalChanges = changed.slice(before).filter((e) => e.state.status === 'completed');
    expect(terminalChanges).toHaveLength(1);
    expect(tracker.list()[0].status).toBe('completed');

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    expect(pendingReviewItems()).toHaveLength(1);
    expect(pendingReviewItems()[0].title).toBe('Dynamic workflow finished: Parallel refactor');
  });

  it('a dismiss during an in-flight finalize drain emits no terminal event and no review item', async () => {
    // Dismiss the run WHILE finalize is parked in its usage drain. The finalize
    // continuation must re-validate object identity and drop its side effects — no
    // ghost card, no ghost review item.
    const originalDrainToEof = JournalTailer.prototype.drainToEof;
    vi.spyOn(JournalTailer.prototype, 'drainToEof').mockImplementation(async function (this: JournalTailer) {
      tracker.dismiss('wf_aa11-2b'); // operator dismisses mid-drain
      await originalDrainToEof.call(this);
    });

    emitLaunch();
    const before = changed.length;
    writeFileSync(recordPath, JSON.stringify({ status: 'completed', summary: 'All done' }));
    await advance(1000); // tailer reads the record -> finalize -> drain dismisses mid-flight

    // The dismissal fired 'removed' and dropped the state.
    expect(removed).toEqual(['wf_aa11-2b']);
    expect(tracker.list()).toHaveLength(0);

    // No terminal 'changed' after the dismissal (the only emits are the launch's
    // 'running' snapshots), and no review item was ever created.
    const after = changed.slice(before);
    expect(after.every((e) => e.state.status === 'running')).toBe(true);

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    expect(pendingReviewItems()).toHaveLength(0);
  });

  it('a stall racing an in-flight finalize does not overwrite it (finalize wins, single review item)', async () => {
    // Gate finalize's usage drain so the 1h stall timer fires while finalize is
    // still in flight. finalize claimed the transition first (synchronously, on the
    // notification emit), so the stall must defer without overwriting the status to
    // 'failed' or creating a second review item.
    let releaseDrain: () => void = () => {};
    const drainGate = new Promise<void>((resolve) => {
      releaseDrain = () => resolve();
    });
    let drainCalls = 0;
    const originalDrainToEof = JournalTailer.prototype.drainToEof;
    vi.spyOn(JournalTailer.prototype, 'drainToEof').mockImplementation(async function (this: JournalTailer) {
      drainCalls += 1;
      if (drainCalls === 1) {
        await drainGate;
      }
      await originalDrainToEof.call(this);
    });

    emitLaunch();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(1000);

    // 1) finalize claims synchronously, then parks in its gated drain (call #1).
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('wabc123', 'completed')));
    expect(drainCalls).toBe(1);

    // 2) the stall fires while finalize is parked — handleStalled claims 2nd and,
    //    being a non-claimant, defers without overwriting.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 2000);
    expect(tracker.list()[0].status).toBe('running'); // finalize still gated, stall deferred

    // 3) release finalize's drain; it applies the 'completed' terminal transition.
    releaseDrain();
    await flushIo();

    expect(tracker.list()[0].status).toBe('completed'); // finalize won — NOT 'failed'

    await ReviewItemRouter.getInstance()._queueForProject(1).onIdle();
    const items = pendingReviewItems();
    expect(items).toHaveLength(1); // exactly one — the stall created no duplicate
    expect(items[0].title).toBe('Dynamic workflow finished: Parallel refactor');
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
    await advance(1000);
    expect(changed.at(-1)?.state.agents).toEqual([{ agentId: 'a1', status: 'running' }]);
  });

  // -------------------------------------------------------------------------
  // per-session cap
  // -------------------------------------------------------------------------

  it('caps tracked states at 5 per session, dropping the oldest terminal one', async () => {
    tracker.attachToRouter(router, { runId: 'run-1', sessionId: 'sess-1' });
    const launchNth = (n: number): void => {
      const tDir = join(base, 'subagents', 'workflows', `wf_cap${n}`);
      const sPath = join(base, 'workflows', 'scripts', `flow${n}-wf_cap${n}.js`);
      router.emitForRun('run-1', assistantToolUse(`tu-cap${n}`));
      router.emitForRun('run-1', userToolResult(`tu-cap${n}`, launchText(`w${n}`, tDir, sPath, `wf_cap${n}`)));
    };

    for (let n = 1; n <= 5; n++) launchNth(n);
    // Terminate #1 so it becomes droppable (running states are never dropped).
    // finalize is async now — settle it before the next launch triggers the cap.
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('w1', 'killed')));
    await flushIo();
    launchNth(6);

    const ids = tracker.list('sess-1').map((s) => s.wfRunId);
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain('wf_cap1');
    expect(ids).toContain('wf_cap6');
  });

  // -------------------------------------------------------------------------
  // merge-only auto-resolve sweep
  // -------------------------------------------------------------------------

  it('resolveReviewItemsForSession resolves pending dynamic-workflow items for the session run', async () => {
    emitLaunch();
    writeFileSync(recordPath, JSON.stringify({ status: 'completed', summary: 'Done' }));
    await advance(1000);
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
  // dismissal
  // -------------------------------------------------------------------------

  it('dismiss forgets a tracked run and emits removed; idempotent', async () => {
    emitLaunch();
    writeFileSync(recordPath, JSON.stringify({ status: 'completed', summary: 'Done' }));
    await advance(1000);
    expect(tracker.list()).toHaveLength(1);

    expect(tracker.dismiss('wf_aa11-2b')).toBe(true);
    expect(removed).toEqual(['wf_aa11-2b']);
    expect(tracker.list()).toHaveLength(0);

    // Second dismiss is a no-op (already gone) — no extra removed event.
    expect(tracker.dismiss('wf_aa11-2b')).toBe(false);
    expect(removed).toEqual(['wf_aa11-2b']);
  });

  it('dismissed wfRunIds are not re-tracked by a replayed launch (detector dedup retains the id)', () => {
    emitLaunch();
    expect(tracker.dismiss('wf_aa11-2b')).toBe(true);

    // A replayed launch tool_result for the same id must NOT resurrect the card.
    router.emitForRun('run-1', assistantToolUse('tu-replay'));
    router.emitForRun('run-1', userToolResult('tu-replay', launchText('wabc123', transcriptDir, scriptPath, 'wf_aa11-2b')));
    expect(tracker.list()).toHaveLength(0);
  });

  it('dismissTerminalForSession dismisses only terminal runs, leaving a running one', async () => {
    tracker.attachToRouter(router, { runId: 'run-1', sessionId: 'sess-1' });
    const launchNth = (n: number): void => {
      const tDir = join(base, 'subagents', 'workflows', `wf_d${n}`);
      const sPath = join(base, 'workflows', 'scripts', `flow${n}-wf_d${n}.js`);
      router.emitForRun('run-1', assistantToolUse(`tu-d${n}`));
      router.emitForRun('run-1', userToolResult(`tu-d${n}`, launchText(`w${n}`, tDir, sPath, `wf_d${n}`)));
    };
    launchNth(1);
    launchNth(2);
    // Terminate #1 only; #2 stays running. finalize is async — settle it first.
    router.emitForRun('run-1', userToolResult('tu-x', notificationText('w1', 'completed')));
    await flushIo();

    const dismissedCount = tracker.dismissTerminalForSession('sess-1');
    expect(dismissedCount).toBe(1);
    expect(removed).toEqual(['wf_d1']);
    const ids = tracker.list('sess-1').map((s) => s.wfRunId);
    expect(ids).toEqual(['wf_d2']);
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
    await flushIo();
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
    await flushIo();
    expect(changed.at(-1)?.state.status).toBe('completed');
    expect(warn).toHaveBeenCalled();
  });

  it('finalization is fail-soft after the run was cascade-deleted', async () => {
    emitLaunch();
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('run-1');

    expect(() => {
      router.emitForRun('run-1', userToolResult('tu-late', notificationText('wabc123', 'completed')));
    }).not.toThrow();
    await flushIo();
    expect(changed.at(-1)?.state.status).toBe('completed');
    expect(db.prepare('SELECT * FROM run_usage WHERE run_id = ?').get('run-1')).toBeUndefined();
  });

  it('finalization is fail-soft when usage tables are unavailable', async () => {
    const warn = vi.fn();
    DynamicWorkflowTracker._resetForTesting();
    tracker = DynamicWorkflowTracker.initialize(dbAdapter(db), {
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    emitLaunch();
    writeFileSync(journalPath, '{"type":"started","agentId":"a1"}\n');
    await advance(1000);
    db.exec('DROP TABLE run_usage; DROP TABLE raw_events;');

    expect(() => {
      router.emitForRun('run-1', userToolResult('tu-unmigrated', notificationText('wabc123', 'completed')));
    }).not.toThrow();
    await flushIo();
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
