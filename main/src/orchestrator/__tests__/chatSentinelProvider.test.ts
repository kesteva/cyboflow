/**
 * Unit tests for the chat-gate sentinel provider + the gate-vehicle discriminator
 * (permission-mode redesign §6 — the pure gate vehicle, Slice 3).
 *
 * Covers:
 *  - resolveGateRunId: CHAT turn → provider; FLOW step → panelId / flowRunId
 *    (provider NEVER consulted); uninjected fallback → run_id ?? panelId.
 *  - chatSentinelProvider mint-on-read for a chat_run_id IS NULL session — the
 *    minted row is a __quick__ workflow run, advanced to 'running', worktree-stamped,
 *    and persisted to sessions.chat_run_id.
 *  - returns the EXISTING chat_run_id (no re-mint) and that sentinel revives:true
 *    via reviveQuickRunToRunning even when sessions.run_id points at a TERMINAL flow
 *    run (the #4 chat-after-terminal-flow fix).
 *  - chat-during-active-flow guard: rejects while a non-terminal NON-__quick__ flow
 *    run is pointed at by run_id; does NOT trip for a __quick__ run_id or a terminal flow.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  makeChatSentinelProvider,
  resolveGateRunId,
  ChatDuringActiveFlowError,
  type ChatSentinelProvider,
} from '../chatSentinelProvider';
import { WorkflowRegistry, QUICK_WORKFLOW_NAME, type WorkflowConfigProvider } from '../workflowRegistry';
import { reviveQuickRunToRunning } from '../../services/cyboflow/transitions';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { CliSubstrate } from '../../../../shared/types/substrate';

const PROJECT_ID = 1;

/** A stub config so createRun's substrate/mode ladders resolve deterministically. */
function makeConfig(substrate: CliSubstrate = 'sdk', mode: PermissionMode = 'default'): WorkflowConfigProvider {
  return {
    getDefaultAgentPermissionMode: () => mode,
    getDefaultSubstrate: () => substrate,
  };
}

/** Layer the createRun-required columns + sessions table onto the gate fixture. */
function buildDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true });
  db.exec(
    "ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))",
  );
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec(`
    CREATE TABLE workflow_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      spec_hash   TEXT NOT NULL,
      spec_json   TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (workflow_id, spec_hash),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    )
  `);
  // Minimal sessions table — only the columns chatSentinelProvider reads/writes.
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id INTEGER,
      substrate TEXT,
      worktree_path TEXT,
      agent_permission_mode TEXT,
      run_id TEXT,
      chat_run_id TEXT
    )
  `);
  return db;
}

interface SeedSessionOpts {
  id: string;
  projectId?: number;
  substrate?: CliSubstrate | null;
  worktreePath?: string | null;
  agentMode?: PermissionMode | null;
  runId?: string | null;
  chatRunId?: string | null;
}

function seedSession(db: Database.Database, opts: SeedSessionOpts): void {
  db.prepare(
    `INSERT INTO sessions (id, project_id, substrate, worktree_path, agent_permission_mode, run_id, chat_run_id)
     VALUES (@id, @projectId, @substrate, @worktreePath, @agentMode, @runId, @chatRunId)`,
  ).run({
    id: opts.id,
    projectId: opts.projectId ?? PROJECT_ID,
    substrate: opts.substrate ?? null,
    worktreePath: opts.worktreePath ?? '/tmp/wt',
    agentMode: opts.agentMode ?? null,
    runId: opts.runId ?? null,
    chatRunId: opts.chatRunId ?? null,
  });
}

/** Seed a NON-__quick__ workflow + run with the given status (a "flow" run). */
function seedFlowRun(db: Database.Database, runId: string, status: string): void {
  const wfId = `wf-flow-${runId}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'sprint', '{}')`,
  ).run(wfId, PROJECT_ID);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate)
     VALUES (?, ?, ?, ?, 'default', 'sdk')`,
  ).run(runId, wfId, PROJECT_ID, status);
}

/** Seed a __quick__ sentinel run (for the existing-chat_run_id cases). */
function seedQuickSentinel(db: Database.Database, runId: string, status: string): void {
  const wfId = `wf-${PROJECT_ID}-${QUICK_WORKFLOW_NAME}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, ?, '{}')`,
  ).run(wfId, PROJECT_ID, QUICK_WORKFLOW_NAME);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate)
     VALUES (?, ?, ?, ?, 'default', 'sdk')`,
  ).run(runId, wfId, PROJECT_ID, status);
}

function workflowNameForRun(db: Database.Database, runId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT w.name AS name FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?`,
    )
    .get(runId) as { name: string } | undefined;
  return row?.name;
}

function runStatus(db: Database.Database, runId: string): string | undefined {
  const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as
    | { status: string }
    | undefined;
  return row?.status;
}

// ---------------------------------------------------------------------------
// resolveGateRunId — the pure discriminator
// ---------------------------------------------------------------------------

describe('resolveGateRunId', () => {
  it('CHAT turn (session row resolves) → calls the provider and returns its sentinel', () => {
    const provider = vi.fn<ChatSentinelProvider>(() => 'chat-sentinel-1');
    const runId = resolveGateRunId({
      sessionRow: { run_id: 'flow-terminal-1' },
      panelId: 'panel-x',
      sessionId: 'sess-1',
      provider,
    });
    expect(runId).toBe('chat-sentinel-1');
    expect(provider).toHaveBeenCalledWith('sess-1');
  });

  it('FLOW step (no session row) → resolves panelId and NEVER consults the provider', () => {
    const provider = vi.fn<ChatSentinelProvider>(() => 'should-not-be-used');
    const runId = resolveGateRunId({
      sessionRow: undefined,
      panelId: 'run-flow-9',
      sessionId: 'run-flow-9', // sessionId === runId invariant for a flow step
      provider,
    });
    expect(runId).toBe('run-flow-9');
    expect(provider).not.toHaveBeenCalled();
  });

  it('PTY FLOW step → gates on options.runId (the flow run), NOT the sentinel', () => {
    const provider = vi.fn<ChatSentinelProvider>(() => 'should-not-be-used');
    const runId = resolveGateRunId({
      sessionRow: undefined,
      panelId: 'panel-p',
      sessionId: 'run-flow-77',
      provider,
      flowRunId: 'run-flow-77',
    });
    expect(runId).toBe('run-flow-77');
    expect(provider).not.toHaveBeenCalled();
  });

  it('uninjected provider (tests/boot) → falls back to run_id ?? panelId', () => {
    expect(
      resolveGateRunId({ sessionRow: { run_id: 'rid-1' }, panelId: 'p', sessionId: 's', provider: null }),
    ).toBe('rid-1');
    expect(
      resolveGateRunId({ sessionRow: { run_id: null }, panelId: 'p', sessionId: 's', provider: null }),
    ).toBe('p');
  });
});

// ---------------------------------------------------------------------------
// chatSentinelProvider — mint-on-read + existing-reuse + flow guard
// ---------------------------------------------------------------------------

describe('chatSentinelProvider', () => {
  let db: Database.Database;
  let registry: WorkflowRegistry;
  let provider: ChatSentinelProvider;

  beforeEach(() => {
    db = buildDb();
    registry = new WorkflowRegistry(dbAdapter(db), makeSpyLogger(), makeConfig('sdk', 'default'));
    provider = makeChatSentinelProvider({
      db: dbAdapter(db),
      workflowRegistry: registry,
      logger: makeSpyLogger(),
    });
  });

  afterEach(() => {
    db.close();
  });

  it('mints a __quick__ sentinel ON READ for a chat_run_id IS NULL session and persists it', () => {
    // Flow-hosted/legacy session: run_id points at a TERMINAL flow run, chat_run_id NULL.
    seedFlowRun(db, 'flow-done-1', 'completed');
    seedSession(db, { id: 'sess-mint', runId: 'flow-done-1', chatRunId: null, worktreePath: '/tmp/wt-mint' });

    const gateRunId = provider('sess-mint');

    // The minted row IS a __quick__ workflow run (so reviveQuickRunToRunning matches).
    expect(workflowNameForRun(db, gateRunId)).toBe(QUICK_WORKFLOW_NAME);
    // It is distinct from the terminal flow run (run_id is NOT hijacked).
    expect(gateRunId).not.toBe('flow-done-1');
    // Advanced to 'running' + worktree-stamped so the gate is live on both substrates.
    expect(runStatus(db, gateRunId)).toBe('running');
    const minted = db
      .prepare('SELECT worktree_path, session_id FROM workflow_runs WHERE id = ?')
      .get(gateRunId) as { worktree_path: string | null; session_id: string | null };
    expect(minted.worktree_path).toBe('/tmp/wt-mint');
    expect(minted.session_id).toBe('sess-mint');
    // Persisted to sessions.chat_run_id; run_id is left untouched (Role-D).
    const sess = db
      .prepare('SELECT run_id, chat_run_id FROM sessions WHERE id = ?')
      .get('sess-mint') as { run_id: string | null; chat_run_id: string | null };
    expect(sess.chat_run_id).toBe(gateRunId);
    expect(sess.run_id).toBe('flow-done-1');
  });

  it('mints on the SESSION substrate (interactive) so the sentinel is counted correctly', () => {
    seedSession(db, { id: 'sess-pty', substrate: 'interactive', chatRunId: null });
    const gateRunId = provider('sess-pty');
    const row = db
      .prepare('SELECT substrate FROM workflow_runs WHERE id = ?')
      .get(gateRunId) as { substrate: string };
    expect(row.substrate).toBe('interactive');
  });

  it('is idempotent within a session: a second call returns the SAME minted sentinel (no re-mint)', () => {
    seedSession(db, { id: 'sess-twice', chatRunId: null });
    const first = provider('sess-twice');
    const second = provider('sess-twice');
    expect(second).toBe(first);
    const count = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
            WHERE r.session_id = ? AND w.name = ?`,
        )
        .get('sess-twice', QUICK_WORKFLOW_NAME) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it('returns the EXISTING chat_run_id and that sentinel revives:true despite a TERMINAL flow run (#4)', () => {
    // run_id = terminal flow run; chat_run_id = a parked __quick__ sentinel.
    seedFlowRun(db, 'flow-terminal-2', 'completed');
    seedQuickSentinel(db, 'chat-parked-2', 'failed');
    seedSession(db, { id: 'sess-existing', runId: 'flow-terminal-2', chatRunId: 'chat-parked-2' });

    const gateRunId = provider('sess-existing');
    expect(gateRunId).toBe('chat-parked-2'); // reused, NOT re-minted

    // The chat sentinel is a __quick__ run, so reviveQuickRunToRunning matches.
    expect(workflowNameForRun(db, gateRunId)).toBe(QUICK_WORKFLOW_NAME);
    const revival = reviveQuickRunToRunning(db, gateRunId);
    expect(revival.revived).toBe(true);
    expect(runStatus(db, gateRunId)).toBe('running');

    // The terminal flow run (run_id) is untouched by the revive.
    expect(runStatus(db, 'flow-terminal-2')).toBe('completed');
  });

  it('REJECTS a chat turn while the session run_id flow run is non-terminal (chat-during-active-flow)', () => {
    seedFlowRun(db, 'flow-live-3', 'running');
    seedSession(db, { id: 'sess-blocked', runId: 'flow-live-3', chatRunId: 'chat-3' });
    seedQuickSentinel(db, 'chat-3', 'awaiting_review');

    expect(() => provider('sess-blocked')).toThrow(ChatDuringActiveFlowError);
  });

  it('does NOT reject when the flow run is awaiting_input/stuck → only terminal exempts; running blocks', () => {
    // A non-terminal flow run (awaiting_review) blocks — the guard is "non-terminal".
    seedFlowRun(db, 'flow-rest-4', 'awaiting_review');
    seedSession(db, { id: 'sess-rest', runId: 'flow-rest-4', chatRunId: 'chat-4' });
    seedQuickSentinel(db, 'chat-4', 'awaiting_review');
    expect(() => provider('sess-rest')).toThrow(ChatDuringActiveFlowError);
  });

  it('does NOT trip the guard for a TERMINAL flow run (chat proceeds)', () => {
    seedFlowRun(db, 'flow-done-5', 'canceled');
    seedSession(db, { id: 'sess-ok', runId: 'flow-done-5', chatRunId: 'chat-5' });
    seedQuickSentinel(db, 'chat-5', 'awaiting_review');
    expect(() => provider('sess-ok')).not.toThrow();
    expect(provider('sess-ok')).toBe('chat-5');
  });

  it('does NOT trip the guard when run_id IS the __quick__ chat sentinel itself (pure chat session)', () => {
    // A pure quick session: run_id === chat_run_id === a running __quick__ sentinel.
    seedQuickSentinel(db, 'chat-pure-6', 'running');
    seedSession(db, { id: 'sess-pure', runId: 'chat-pure-6', chatRunId: 'chat-pure-6' });
    expect(() => provider('sess-pure')).not.toThrow();
    expect(provider('sess-pure')).toBe('chat-pure-6');
  });

  it('throws a clear error when the session row is missing', () => {
    expect(() => provider('no-such-session')).toThrow(/session no-such-session not found/);
  });
});
