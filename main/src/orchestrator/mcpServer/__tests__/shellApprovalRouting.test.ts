/**
 * Tests for the INTERACTIVE-substrate shell-approval gate (IDEA-013 S5 /
 * TASK-810, PRIMARY body; Probe A = PASS).
 *
 * Two units under test:
 *   1. McpQueryHandler's NET-NEW async-deferred `shell-approval-request` branch
 *      — the first handler that does NOT writeResponse synchronously. It applies
 *      the allow-list short-circuit (SDK parity), rejects the orchestrator
 *      sentinel, routes everything else through ApprovalRouter on a held-open
 *      socket, cleans up on disconnect, exposes a cancel affordance, and fails
 *      closed (logged precondition) on a non-real runId.
 *   2. preToolUseShellHook.ts's stdin→socket→stdout flow — allow → exit 0, deny
 *      → exit 2, fail-closed on socket disconnect, and a multi-minute idle (fake
 *      timers) that STILL yields the real verdict (no timer-based deny).
 *
 * Held-open integration cases connect a REAL net client to a live
 * OrchSocketServer (TASK-798) over an os.tmpdir() socket — the load-bearing
 * check that TASK-798's fire-and-forget dispatch tolerates a branch that never
 * responds synchronously and keeps the socket alive across the human wait.
 *
 * Reuses the shared fixtures (dbAdapter, createTestDb/seedRun/seedApproval,
 * makeSpyLogger) exactly as mcpQueryHandler.test.ts does. ApprovalRouter is
 * initialized with the test DB and reset in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { McpQueryHandler, type McpQueryResponse } from '../mcpQueryHandler';
import { OrchSocketServer } from '../orchSocketServer';
import { ApprovalRouter } from '../../approvalRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../../__test_fixtures__/orchestratorTestDb';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
import {
  runShellHook,
  type ShellHookLogger,
  type ShellHookResult,
} from '../../shellHooks/preToolUseShellHook';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A writes-capturing net.Socket double (mirrors mcpQueryHandler.test.ts). */
function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    end: () => undefined,
    on: () => socket,
    off: () => socket,
  } as unknown as net.Socket;
  return { socket, writes };
}

/**
 * An EventEmitter-backed net.Socket double so the handler's per-socket
 * 'close'/'error' listeners and the cancel affordance's end() can be driven.
 */
function makeEmitterSocketDouble(): {
  socket: net.Socket;
  writes: string[];
  emitClose: () => void;
  emitError: (err: Error) => void;
  ended: () => boolean;
} {
  const writes: string[] = [];
  const closeHandlers: Array<() => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];
  let didEnd = false;

  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    end: () => {
      didEnd = true;
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') closeHandlers.push(cb as () => void);
      if (event === 'error') errorHandlers.push(cb as (err: Error) => void);
      return socket;
    },
    off: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') {
        const i = closeHandlers.indexOf(cb as () => void);
        if (i >= 0) closeHandlers.splice(i, 1);
      }
      if (event === 'error') {
        const i = errorHandlers.indexOf(cb as (err: Error) => void);
        if (i >= 0) errorHandlers.splice(i, 1);
      }
      return socket;
    },
  } as unknown as net.Socket;

  return {
    socket,
    writes,
    emitClose: () => closeHandlers.slice().forEach((h) => h()),
    emitError: (err: Error) => errorHandlers.slice().forEach((h) => h(err)),
    ended: () => didEnd,
  };
}

function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}

function decisionOf(writes: string[]): string | undefined {
  const data = parseLastWrite(writes).data as { permissionDecision?: string } | undefined;
  return data?.permissionDecision;
}

/** Flush the microtask queue so the async requestApproval transaction commits. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const silentHookLogger: ShellHookLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// ---------------------------------------------------------------------------
// Handler-branch tests (isolated, socket doubles)
// ---------------------------------------------------------------------------

describe('shell-approval-request handler branch', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;
  const worktrees: string[] = [];
  // Hermetic HOME: loadMergedPermissionRules reads os.homedir()/.claude — point
  // it at an empty temp dir so the developer's real ~/.claude allow-list (which
  // grants e.g. Bash(ls:*)) cannot leak into the gate decision under test.
  let realHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    db = createTestDb({ disableForeignKeys: true });
    // resolveRunPermissionMode now joins the owning SESSION (permission-mode
    // redesign §3c#3); the GATE_SCHEMA carries neither, so layer the run.session_id
    // link column + a minimal sessions table the join reads.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
    ApprovalRouter.initialize(dbAdapter(db));
    handler = new McpQueryHandler(dbAdapter(db), makeSpyLogger());
    realHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-home-${process.pid}-`));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
    for (const w of worktrees.splice(0)) fs.rmSync(w, { recursive: true, force: true });
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function seedWorktreeWithAllow(runId: string, allow: string[]): string {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-wt-${process.pid}-`));
    worktrees.push(worktree);
    fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow } }),
      'utf8',
    );
    seedRun(db, { id: runId, worktreePath: worktree, status: 'running' });
    return worktree;
  }

  function pendingApprovalCount(runId: string): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND status = 'pending'`)
      .get(runId) as { n: number };
    return row.n;
  }

  /**
   * Seed a run with an empty allow-list whose OWNING SESSION carries the given
   * 4-mode value (the execution authority the handler reads via the run→session
   * join for the acceptEdits fast-path — permission-mode redesign §3c#3). The
   * `permission_mode_snapshot` column is demoted to audit-only and no longer read.
   */
  function seedRunWithMode(runId: string, mode: string): string {
    const worktree = seedWorktreeWithAllow(runId, []);
    const sessionId = `sess-${runId}`;
    db.prepare(`INSERT INTO sessions (id, agent_permission_mode) VALUES (?, ?)`).run(sessionId, mode);
    db.prepare(`UPDATE workflow_runs SET session_id = ? WHERE id = ?`).run(sessionId, runId);
    return worktree;
  }

  it('(a) auto-allows an allow-listed tool with ZERO approvals rows (SDK parity, no router round-trip)', async () => {
    seedWorktreeWithAllow('run-allow', ['Bash(git status:*)']);
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-allow',
        runId: 'run-allow',
        toolName: 'Bash',
        toolInput: { command: 'git status' },
      },
      socket,
    );
    await flush();

    expect(decisionOf(writes)).toBe('allow');
    expect(pendingApprovalCount('run-allow')).toBe(0);
  });

  it('(a2) acceptEdits fast-path: auto-allows Edit/Write/MultiEdit with ZERO approvals rows (no allow-list entry needed)', async () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const runId = `run-ae-${tool}`;
      seedRunWithMode(runId, 'acceptEdits');
      const { socket, writes } = makeSocketDouble();

      await handler.handleMessage(
        {
          type: 'shell-approval-request',
          requestId: `req-ae-${tool}`,
          runId,
          toolName: tool,
          toolInput: { file_path: '/tmp/x.ts', content: 'x' },
        },
        socket,
      );
      await flush();

      expect(decisionOf(writes)).toBe('allow');
      expect(pendingApprovalCount(runId)).toBe(0);
    }
  });

  it('(a3) acceptEdits does NOT fast-path a non-edit tool — it routes through the normal gate (one pending approval)', async () => {
    seedRunWithMode('run-ae-bash', 'acceptEdits');
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-ae-bash',
        runId: 'run-ae-bash',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/x' },
      },
      socket,
    );
    await flush();

    // Non-edit tool under acceptEdits: held open, one pending approval row.
    expect(writes).toHaveLength(0);
    expect(pendingApprovalCount('run-ae-bash')).toBe(1);
  });

  it('(a4) under "default" mode an Edit is NOT fast-pathed — it routes through the normal gate', async () => {
    seedRunWithMode('run-default-edit', 'default');
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-default-edit',
        runId: 'run-default-edit',
        toolName: 'Edit',
        toolInput: { file_path: '/tmp/x.ts', content: 'x' },
      },
      socket,
    );
    await flush();

    // No acceptEdits fast-path; the edit needs a human (one pending approval).
    expect(writes).toHaveLength(0);
    expect(pendingApprovalCount('run-default-edit')).toBe(1);
  });

  it('(a5) JOIN-MISS arm: a run whose session_id is NULL (legacy sentinel) does NOT acceptEdits-fast-path — it routes through the gate (conservative null→router-gate contract)', async () => {
    // seedWorktreeWithAllow leaves session_id NULL: the run→session join misses,
    // resolveRunPermissionMode returns null, and an Edit MUST NOT be auto-allowed.
    // This is the legacy-sentinel arm — it prompts (router gate) rather than
    // stranding the run; the sentinel's session_id is stamped at creation so the
    // miss never persists beyond the first mint-on-read turn.
    seedWorktreeWithAllow('run-joinmiss-edit', []);
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-joinmiss-edit',
        runId: 'run-joinmiss-edit',
        toolName: 'Edit',
        toolInput: { file_path: '/tmp/x.ts', content: 'x' },
      },
      socket,
    );
    await flush();

    // Null mode ⇒ no fast-path ⇒ the edit needs a human (one pending approval).
    expect(writes).toHaveLength(0);
    expect(pendingApprovalCount('run-joinmiss-edit')).toBe(1);
  });

  it('(b) rejects the "orchestrator" sentinel runId with a deny and NO approvals row', async () => {
    const { socket, writes } = makeSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-orch',
        runId: 'orchestrator',
        toolName: 'Bash',
        toolInput: { command: 'echo hi' },
      },
      socket,
    );

    const resp = parseLastWrite(writes);
    expect(resp.ok).toBe(true);
    expect(decisionOf(writes)).toBe('deny');
    expect(pendingApprovalCount('orchestrator')).toBe(0);
  });

  it('(c) a non-allow-listed tool creates exactly one pending approval and writes NO synchronous response', async () => {
    seedWorktreeWithAllow('run-pending', []);
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-pending',
        runId: 'run-pending',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/x' },
      },
      socket,
    );
    await flush();

    // Async-deferred: NO response yet — the socket is held open for the human.
    expect(writes).toHaveLength(0);
    expect(pendingApprovalCount('run-pending')).toBe(1);
    expect(ApprovalRouter.getInstance().getPending()).toHaveLength(1);
  });

  it('(d) allow round-trip: respond({allow}) writes permissionDecision:"allow" on the held-open socket', async () => {
    seedWorktreeWithAllow('run-rt-allow', []);
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-rt-allow',
        runId: 'run-rt-allow',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      },
      socket,
    );
    await flush();
    expect(writes).toHaveLength(0);

    const approvalId = ApprovalRouter.getInstance().getPending()[0].id;
    await ApprovalRouter.getInstance().respond(approvalId, { behavior: 'allow' });
    await flush();

    expect(decisionOf(writes)).toBe('allow');
    const resp = parseLastWrite(writes);
    expect(resp.requestId).toBe('req-rt-allow');
  });

  it('(e) deny round-trip: respond({deny, message}) writes permissionDecision:"deny" with the reason', async () => {
    seedWorktreeWithAllow('run-rt-deny', []);
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-rt-deny',
        runId: 'run-rt-deny',
        toolName: 'Bash',
        toolInput: { command: 'curl evil.example' },
      },
      socket,
    );
    await flush();

    const approvalId = ApprovalRouter.getInstance().getPending()[0].id;
    await ApprovalRouter.getInstance().respond(approvalId, { behavior: 'deny', message: 'nope' });
    await flush();

    expect(decisionOf(writes)).toBe('deny');
    const data = parseLastWrite(writes).data as { permissionDecisionReason?: string };
    expect(data.permissionDecisionReason).toBe('nope');
  });

  it('(f) socket disconnect before a verdict clears the pending approval (no awaiting_review leak)', async () => {
    seedWorktreeWithAllow('run-disc', []);
    const { socket, emitClose } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-disc',
        runId: 'run-disc',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      },
      socket,
    );
    await flush();
    expect(pendingApprovalCount('run-disc')).toBe(1);

    emitClose();
    await flush();

    // The pending approval row is cleared (via clearPendingForRun) so it no
    // longer leaks into the cross-run review queue. The in-memory pending entry
    // is gone too. (The workflow_runs.status reset is the teardown path's job,
    // not clearPendingForRun's — see approvalRouter.ts:415-473.)
    expect(pendingApprovalCount('run-disc')).toBe(0);
    expect(ApprovalRouter.getInstance().getPending()).toHaveLength(0);
  });

  it('(g) cancel affordance denies + closes every in-flight socket for a runId and clears the pending row', async () => {
    seedWorktreeWithAllow('run-cancel', []);
    const { socket, writes, ended } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-cancel',
        runId: 'run-cancel',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      },
      socket,
    );
    await flush();
    expect(writes).toHaveLength(0);

    const count = handler.cancelInFlightShellApprovals('run-cancel');
    await flush();

    expect(count).toBe(1);
    expect(decisionOf(writes)).toBe('deny');
    expect(ended()).toBe(true);
    // The cancel affordance settles the held-open socket; the manager then calls
    // clearPendingForRun to settle the DB row (TASK-808). The in-flight set is empty.
    expect(handler.cancelInFlightShellApprovals('run-cancel')).toBe(0);
  });

  it('(h) CYBOFLOW_RUN_ID precondition: a non-real runId fails closed (deny) and logs the precondition failure, not a silent swallow', async () => {
    // No seedRun → the runId is not a real workflow_runs.id (the TASK-800
    // failure mode: CYBOFLOW_RUN_ID is the session UUID). requestApproval's
    // guarded UPDATE finds changes===0 → RunNotRunningError → fail closed.
    const logger = makeSpyLogger();
    const preconHandler = new McpQueryHandler(dbAdapter(db), logger);
    const { socket, writes } = makeEmitterSocketDouble();

    await preconHandler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-precon',
        runId: 'not-a-real-run',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      },
      socket,
    );
    await flush();

    expect(decisionOf(writes)).toBe('deny');
    // Surfaced loudly via the error logger — not silently swallowed.
    const loggedPrecondition = logger.calls.some(
      (c) => c.level === 'error' && /precondition/i.test(c.message),
    );
    expect(loggedPrecondition).toBe(true);
  });

  it('does NOT route AskUserQuestion through QuestionRouter (native-TUI-only) — it routes as a normal gate with no awaiting_input leak', async () => {
    seedWorktreeWithAllow('run-auq', []);
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-auq',
        runId: 'run-auq',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [{ question: 'pick' }] },
      },
      socket,
    );
    await flush();

    // Routed as a normal approval gate (one pending approvals row), NOT a
    // questions row — no QuestionRouter wiring on this substrate.
    expect(pendingApprovalCount('run-auq')).toBe(1);
    expect(writes).toHaveLength(0);
    const status = (
      db.prepare(`SELECT status FROM workflow_runs WHERE id = ?`).get('run-auq') as { status: string }
    ).status;
    expect(status).not.toBe('awaiting_input');
  });
});

// ---------------------------------------------------------------------------
// P4: the interactive shell-approval path folds a permission review_item while
// preserving the socket-held-open invariant. Uses a migration-backed DB so the
// co-write (which is a no-op on the GATE_SCHEMA DB the block above uses) is
// observable.
// ---------------------------------------------------------------------------

describe('shell-approval-request review_item fold (P4, socket still held)', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;
  const worktrees: string[] = [];
  let realHome: string | undefined;
  let fakeHome: string;

  function buildReviewDb(): Database.Database {
    const reviewDb = new BetterSqlite3(':memory:');
    reviewDb.pragma('foreign_keys = ON');
    reviewDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    reviewDb.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
    const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
    reviewDb.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    reviewDb.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    reviewDb.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    reviewDb.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    reviewDb.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
    // resolveRunPermissionMode joins the owning SESSION (permission-mode redesign
    // §3c#3); migrations 019 (session_id) / 021 (agent_permission_mode) are not in
    // this fixture's set, so add the minimal join surface. These review-fold runs
    // carry no mode ⇒ the join yields null ⇒ the conservative router gate (the
    // existing behavior under test).
    reviewDb.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    reviewDb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
    return reviewDb;
  }

  function seedReviewRun(runId: string): string {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-wt-${process.pid}-`));
    worktrees.push(worktree);
    fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }), 'utf8');
    db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status) VALUES (?, 'wf-1', 1, ?, 'running')`,
    ).run(runId, worktree);
    return worktree;
  }

  beforeEach(() => {
    db = buildReviewDb();
    ApprovalRouter.initialize(dbAdapter(db));
    handler = new McpQueryHandler(dbAdapter(db), makeSpyLogger());
    realHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-home-${process.pid}-`));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
    for (const w of worktrees.splice(0)) fs.rmSync(w, { recursive: true, force: true });
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('writes a blocking permission review_item (source approval:interactive), holds the socket, and resolves on respond', async () => {
    seedReviewRun('run-iv');
    const { socket, writes } = makeEmitterSocketDouble();

    await handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'req-iv',
        runId: 'run-iv',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /tmp/x' },
      },
      socket,
    );
    await flush();

    // Socket-held-open invariant: NO synchronous verdict yet.
    expect(writes).toHaveLength(0);

    // The folded permission review_item is present, blocking, and tagged with the
    // interactive provenance.
    const row = db
      .prepare("SELECT kind, blocking, status, source FROM review_items WHERE run_id = 'run-iv'")
      .get() as { kind: string; blocking: number; status: string; source: string };
    expect(row.kind).toBe('permission');
    expect(row.blocking).toBe(1);
    expect(row.status).toBe('pending');
    expect(row.source).toBe('approval:interactive');

    // Resolve via the router — the verdict is delivered on the held-open socket
    // AND the folded review_item is resolved.
    const approvalId = ApprovalRouter.getInstance().getPending()[0].id;
    await ApprovalRouter.getInstance().respond(approvalId, { behavior: 'allow' });
    await flush();

    expect(decisionOf(writes)).toBe('allow');
    const resolved = db
      .prepare("SELECT status FROM review_items WHERE run_id = 'run-iv'")
      .get() as { status: string };
    expect(resolved.status).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// Held-open round-trip over a REAL OrchSocketServer + net client (integration)
// ---------------------------------------------------------------------------

describe('shell-approval-request over a live OrchSocketServer (held-open socket)', () => {
  let db: Database.Database;
  let server: OrchSocketServer;
  let socketPath: string;
  const openClients: net.Socket[] = [];
  const worktrees: string[] = [];
  let realHome: string | undefined;
  let fakeHome: string;

  beforeEach(async () => {
    db = createTestDb({ disableForeignKeys: true });
    // Run→session join surface for resolveRunPermissionMode (§3c#3); these runs
    // carry no mode ⇒ the join yields null ⇒ the conservative router gate.
    db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');
    ApprovalRouter.initialize(dbAdapter(db));
    realHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-home-${process.pid}-`));
    process.env.HOME = fakeHome;
    socketPath = path.join(os.tmpdir(), `shell-appr-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
    server = new OrchSocketServer(socketPath, dbAdapter(db), makeSpyLogger());
    await server.start();
  });

  afterEach(async () => {
    for (const c of openClients.splice(0)) c.destroy();
    await server.stop();
    ApprovalRouter._resetForTesting();
    db.close();
    for (const w of worktrees.splice(0)) fs.rmSync(w, { recursive: true, force: true });
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function seedRunForServer(runId: string): void {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `cyboflow-srv-wt-${process.pid}-`));
    worktrees.push(worktree);
    seedRun(db, { id: runId, worktreePath: worktree, status: 'running' });
  }

  function connectClient(): { client: net.Socket; lines: string[] } {
    const lines: string[] = [];
    let recv = '';
    const client = net.createConnection(socketPath);
    openClients.push(client);
    client.on('data', (buf: Buffer) => {
      recv += buf.toString('utf8');
      let nl: number;
      while ((nl = recv.indexOf('\n')) !== -1) {
        const line = recv.slice(0, nl).trim();
        recv = recv.slice(nl + 1);
        if (line) lines.push(line);
      }
    });
    return { client, lines };
  }

  function waitForConnect(client: net.Socket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
  }

  it('holds the socket open with NO response until ApprovalRouter.respond is called, then delivers the verdict', async () => {
    seedRunForServer('run-srv-allow');
    const { client, lines } = connectClient();
    await waitForConnect(client);

    client.write(
      JSON.stringify({
        type: 'shell-approval-request',
        requestId: 'srv-req-1',
        runId: 'run-srv-allow',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf x' },
      }) + '\n',
    );

    // Give the server time to commit the approval; no response must arrive yet.
    await new Promise((r) => setTimeout(r, 150));
    expect(lines).toHaveLength(0);
    expect(ApprovalRouter.getInstance().getPending()).toHaveLength(1);

    // Now the human decides — the verdict must arrive on the SAME held-open socket.
    const approvalId = ApprovalRouter.getInstance().getPending()[0].id;
    await ApprovalRouter.getInstance().respond(approvalId, { behavior: 'allow' });

    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(1));
    const resp = JSON.parse(lines[0]) as McpQueryResponse;
    expect(resp.requestId).toBe('srv-req-1');
    const data = resp.data as { permissionDecision: string };
    expect(data.permissionDecision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// preToolUseShellHook script flow (stdin→stubbed socket→stdout)
// ---------------------------------------------------------------------------

describe('preToolUseShellHook runShellHook', () => {
  /**
   * A stubbed net.Socket whose lifecycle the test drives: it captures the
   * request written to it and lets the test push a verdict or emit close/error.
   */
  function makeStubSocket(): {
    socket: net.Socket;
    requests: string[];
    pushVerdict: (requestId: string, decision: 'allow' | 'deny', reason?: string) => void;
    emitClose: () => void;
    emitError: (err: Error) => void;
  } {
    const requests: string[] = [];
    const handlers = new Map<string, Array<(arg?: unknown) => void>>();
    const on = (event: string, cb: (arg?: unknown) => void): net.Socket => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return socket;
    };
    const emit = (event: string, arg?: unknown): void => {
      (handlers.get(event) ?? []).slice().forEach((h) => h(arg));
    };
    const socket = {
      on,
      once: on,
      write: (chunk: string | Buffer) => {
        requests.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return true;
      },
      end: () => undefined,
      destroy: () => undefined,
    } as unknown as net.Socket;

    // Fire 'connect' on the next tick so the hook writes its request.
    queueMicrotask(() => emit('connect'));

    return {
      socket,
      requests,
      pushVerdict: (requestId, decision, reason) => {
        const data: Record<string, unknown> = { permissionDecision: decision };
        if (reason) data['permissionDecisionReason'] = reason;
        const line = JSON.stringify({ type: 'mcp-query-response', requestId, ok: true, data }) + '\n';
        emit('data', Buffer.from(line, 'utf8'));
      },
      emitClose: () => emit('close'),
      emitError: (err: Error) => emit('error', err),
    };
  }

  /** Extract the requestId the hook generated from its written request line. */
  function requestIdOf(requests: string[]): string {
    const msg = JSON.parse(requests[0].trim()) as { requestId: string };
    return msg.requestId;
  }

  it('allow verdict → exit 0 + permissionDecision:"allow"', async () => {
    const stub = makeStubSocket();
    const promise = runShellHook({
      socketPath: '/unused.sock',
      runId: 'run-1',
      payload: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      logger: silentHookLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.pushVerdict(requestIdOf(stub.requests), 'allow');

    const result: ShellHookResult = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.output.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('deny verdict → exit 2 + permissionDecision:"deny" with the reason', async () => {
    const stub = makeStubSocket();
    const promise = runShellHook({
      socketPath: '/unused.sock',
      runId: 'run-2',
      payload: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
      logger: silentHookLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.pushVerdict(requestIdOf(stub.requests), 'deny', 'blocked by human');

    const result = await promise;
    expect(result.exitCode).toBe(2);
    expect(result.output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.output.hookSpecificOutput.permissionDecisionReason).toBe('blocked by human');
  });

  it('socket close before a verdict → fail-closed deny (exit 2), distinguished by liveness not a timer', async () => {
    const stub = makeStubSocket();
    const promise = runShellHook({
      socketPath: '/unused.sock',
      runId: 'run-3',
      payload: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      logger: silentHookLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.emitClose();

    const result = await promise;
    expect(result.exitCode).toBe(2);
    expect(result.output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('socket error before a verdict → fail-closed deny (exit 2)', async () => {
    const stub = makeStubSocket();
    const promise = runShellHook({
      socketPath: '/unused.sock',
      runId: 'run-3b',
      payload: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      logger: silentHookLogger,
      connect: () => stub.socket,
    });

    await vi.waitFor(() => expect(stub.requests.length).toBeGreaterThanOrEqual(1));
    stub.emitError(new Error('ECONNRESET'));

    const result = await promise;
    expect(result.exitCode).toBe(2);
    expect(result.output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('a multi-minute idle (fake timers) still yields the REAL verdict — no timer-based deny', async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStubSocket();
      const promise = runShellHook({
        socketPath: '/unused.sock',
        runId: 'run-4',
        payload: { tool_name: 'Bash', tool_input: { command: 'ls' } },
        logger: silentHookLogger,
        connect: () => stub.socket,
      });

      // Let the queued 'connect' microtask fire and the request be written.
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.requests.length).toBeGreaterThanOrEqual(1);

      // Simulate the human cooking for 6 minutes. With a 30s timer this would
      // have produced a deny; with liveness-only it must stay pending.
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

      // Now the human finally allows — the real verdict must come through.
      stub.pushVerdict(requestIdOf(stub.requests), 'allow');

      const result = await promise;
      expect(result.exitCode).toBe(0);
      expect(result.output.hookSpecificOutput.permissionDecision).toBe('allow');
    } finally {
      vi.useRealTimers();
    }
  });
});
