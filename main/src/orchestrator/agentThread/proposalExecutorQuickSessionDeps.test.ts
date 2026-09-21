/**
 * Unit tests for proposalExecutorQuickSessionDeps — the boot-layer closures a
 * start-quick-session confirm runs through (TASK-295), driven against the REAL
 * createQuickSessionCore over an in-memory DB and fakes for every spawn seam.
 * What is pinned: the wizard's substrate default is inherited (never the SDK
 * pin the launch-run host session gets), the resolved substrate lands on the
 * session row, and the brief reaches each substrate the way a typed first
 * message would — SDK: registered panel + startPanel; PTY: facade seed +
 * un-awaited spawn with the brief as the positional prompt.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import {
  _resetClaimedQuickSessionIdsForTesting,
  createQuickSessionCore,
  stampQuickSessionRuntimeConfig,
} from '../../services/createQuickSessionCore';
import {
  buildProposalExecutorQuickSessionDeps,
  type ProposalExecutorQuickSessionCollaborators,
} from './proposalExecutorQuickSessionDeps';

const PROJECT_ID = 7;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      status TEXT,
      in_place INTEGER DEFAULT 0,
      run_id TEXT,
      chat_run_id TEXT,
      substrate TEXT,
      agent_runtime TEXT,
      agent_permission_mode TEXT
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued',
      worktree_path TEXT,
      started_at TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

function makePanel(sessionId: string, id: string): ToolPanel {
  return {
    id,
    sessionId,
    type: 'claude',
    title: 'Chat',
    state: { isActive: true, customState: {} },
    metadata: { createdAt: '2026-09-21T00:00:00Z', lastActiveAt: '2026-09-21T00:00:00Z', position: 0 },
  };
}

interface Recorder {
  createSessionArgs: Array<{ worktreeTemplate: string; inPlace?: boolean; agentProvider?: string }>;
  createRunArgs: Array<{ requestedSubstrate: CliSubstrate | undefined; sessionId: string | undefined }>;
  refreshed: string[];
  statusUpdates: Array<{ sessionId: string; status: string }>;
  outputs: Array<{ sessionId: string; data: string }>;
  panelMessages: Array<{ panelId: string; content: string }>;
  registered: Array<{ panelId: string; sessionId: string }>;
  sdkStarts: Array<{ panelId: string; worktreePath: string; prompt: string; permissionMode?: string }>;
  facadeSeeds: Array<{ runId: string; panelId: string }>;
  ptyStarts: unknown[][];
  errors: string[];
  sessionErrors: Array<{ sessionId: string; error: string; details?: string }>;
  seamReports: Array<{ substrate: string; cliTool: string; sessionId: string; message: string }>;
  dismissed: string[];
}

interface HarnessOptions {
  /** What the fake sentinel createRun resolves the substrate to (the wizard default). */
  resolvedSubstrate?: CliSubstrate;
  claudePanelManagerAbsent?: boolean;
  /** The spawn rejects on the next microtask (a cached "not available" probe). */
  ptySpawnRejects?: boolean;
  /** The spawn rejects only once the test resolves `latePtyFailure` (spawn-prep failure). */
  latePtyFailure?: { reject: (err: Error) => void };
  sdkStartThrows?: boolean;
  stampThrows?: boolean;
  permissionMode?: 'approve' | 'ignore';
}

function makeHarness(db: Database.Database, opts: HarnessOptions = {}): { c: ProposalExecutorQuickSessionCollaborators; rec: Recorder } {
  let sessionSeq = 0;
  let panelSeq = 0;
  const rec: Recorder = {
    createSessionArgs: [],
    createRunArgs: [],
    refreshed: [],
    statusUpdates: [],
    outputs: [],
    panelMessages: [],
    registered: [],
    sdkStarts: [],
    facadeSeeds: [],
    ptyStarts: [],
    errors: [],
    sessionErrors: [],
    seamReports: [],
    dismissed: [],
  };
  const c: ProposalExecutorQuickSessionCollaborators = {
    createQuickSessionCore,
    stampQuickSessionRuntimeConfig: (db_, sessionId, stamps) => {
      if (opts.stampThrows) throw new Error('stamp boom');
      stampQuickSessionRuntimeConfig(db_, sessionId, stamps);
    },
    reportEagerSpawnFailure: (err, substrate, cliTool, surface) => {
      rec.seamReports.push({ substrate, cliTool, sessionId: surface.sessionId, message: err instanceof Error ? err.message : String(err) });
      surface.sessionManager.addSessionError(surface.sessionId, `${cliTool} failed to start`, String(err));
    },
    quickSessionCore: {
      taskQueue: {
        onSessionJobFailed: () => () => {},
        createSession: async (data) => {
          sessionSeq += 1;
          rec.createSessionArgs.push({ worktreeTemplate: data.worktreeTemplate, inPlace: data.inPlace, agentProvider: data.agentProvider });
          db.prepare(`INSERT INTO sessions (id, name, status, in_place, agent_permission_mode) VALUES (?, ?, 'pending', ?, ?)`).run(
            `sess-${sessionSeq}`,
            data.worktreeTemplate,
            data.inPlace ? 1 : 0,
            opts.permissionMode ?? null,
          );
          return { id: `job-${sessionSeq}` };
        },
      },
      sessionManager: {
        on: (_event, listener) => {
          const row = db.prepare(`SELECT id, name, in_place FROM sessions WHERE id = ?`).get(`sess-${sessionSeq}`) as {
            id: string;
            name: string;
            in_place: number;
          };
          listener({
            id: row.id,
            name: row.name,
            worktreePath: row.in_place === 1 ? '/repo' : `/repo/.cyboflow/worktrees/${row.name}`,
          });
        },
        removeListener: () => {},
      },
      workflowRegistry: {
        ensureQuickWorkflow: () => 'wf-quick',
        createRun: (_workflowId, requestedSubstrate, sessionId) => {
          rec.createRunArgs.push({ requestedSubstrate, sessionId });
          const runId = `run-${sessionSeq}`;
          db.prepare(`INSERT INTO workflow_runs (id, status) VALUES (?, 'queued')`).run(runId);
          // The ladder: an explicit request wins, else the configured default.
          return { runId, substrate: requestedSubstrate ?? opts.resolvedSubstrate ?? 'interactive' };
        },
      },
      getDb: () => db,
      dismissHalfCreatedSession: async (sessionId) => {
        rec.dismissed.push(sessionId);
      },
    },
    newSessionName: () => 'sunny-lake-20260921',
    sessionManager: {
      getDbSession: (sessionId) => {
        const row = db.prepare(`SELECT agent_permission_mode FROM sessions WHERE id = ?`).get(sessionId) as
          | { agent_permission_mode: 'approve' | 'ignore' | null }
          | undefined;
        return row ? { permission_mode: row.agent_permission_mode ?? undefined } : undefined;
      },
      refreshSessionFromDatabase: (sessionId) => {
        rec.refreshed.push(sessionId);
      },
      updateSession: (sessionId, update) => {
        rec.statusUpdates.push({ sessionId, status: update.status });
      },
      addSessionOutput: (sessionId, output) => {
        rec.outputs.push({ sessionId, data: output.data });
      },
      addPanelConversationMessage: (panelId, _type, content) => {
        rec.panelMessages.push({ panelId, content });
      },
      addSessionError: (sessionId, error, details) => {
        rec.sessionErrors.push({ sessionId, error, details });
      },
    },
    panelManager: {
      createPanel: async (request) => {
        panelSeq += 1;
        return makePanel(request.sessionId, `panel-${panelSeq}`);
      },
    },
    getClaudePanelManager: () =>
      opts.claudePanelManagerAbsent
        ? undefined
        : {
            registerPanel: (panelId, sessionId) => {
              rec.registered.push({ panelId, sessionId });
            },
            startPanel: async (panelId, worktreePath, prompt, permissionMode) => {
              if (opts.sdkStartThrows) throw new Error('sdk boom');
              rec.sdkStarts.push({ panelId, worktreePath, prompt, permissionMode });
            },
          },
    substrateFacade: {
      registerInteractivePanel: (runId, panelId) => {
        rec.facadeSeeds.push({ runId, panelId });
      },
    },
    interactiveReplManager: {
      startPanel: (...args) => {
        rec.ptyStarts.push(args);
        if (opts.ptySpawnRejects) return Promise.reject(new Error('pty boom'));
        if (opts.latePtyFailure) {
          const late = opts.latePtyFailure;
          return new Promise<void>((_resolve, reject) => {
            late.reject = reject;
          });
        }
        // Persistent-REPL contract: resolves only when the REPL exits — never here.
        return new Promise<void>(() => {});
      },
    },
    ptyBriefing: 'BRIEFING',
    logger: {
      error: (message, context) => {
        rec.errors.push(`${message} ${JSON.stringify(context)}`);
      },
    },
  };
  return { c, rec };
}

describe('buildProposalExecutorQuickSessionDeps', () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('createQuickSession (launch-run host) stays SDK-pinned', async () => {
    const { c, rec } = makeHarness(db);
    const deps = buildProposalExecutorQuickSessionDeps(c);
    const r = await deps.createQuickSession({ projectId: PROJECT_ID, nameHint: 'agent-sprint-abc' });
    expect(r).toEqual({ sessionId: 'sess-1', worktreePath: '/repo/.cyboflow/worktrees/agent-sprint-abc' });
    expect(rec.createRunArgs).toEqual([{ requestedSubstrate: 'sdk', sessionId: 'sess-1' }]);
    // Host sessions get no runtime stamp / refresh — byte-identical to before.
    expect(rec.refreshed).toEqual([]);
  });

  it('startQuickSession inherits the quick-session default substrate, stamps the resolved one, and refreshes the row', async () => {
    const { c, rec } = makeHarness(db, { resolvedSubstrate: 'interactive' });
    const deps = buildProposalExecutorQuickSessionDeps(c);

    const created = await deps.startQuickSession({ projectId: PROJECT_ID, inPlace: false });

    expect(created).toEqual({
      sessionId: 'sess-1',
      runId: 'run-1',
      worktreePath: '/repo/.cyboflow/worktrees/sunny-lake-20260921',
      name: 'sunny-lake-20260921',
      substrate: 'interactive',
    });
    // No explicit substrate reaches the sentinel — the ladder decides, as for a wizard launch.
    expect(rec.createRunArgs).toEqual([{ requestedSubstrate: undefined, sessionId: 'sess-1' }]);
    expect(rec.createSessionArgs).toEqual([{ worktreeTemplate: 'sunny-lake-20260921', inPlace: false, agentProvider: 'claude' }]);
    expect(db.prepare(`SELECT substrate, agent_runtime, run_id, chat_run_id FROM sessions WHERE id = 'sess-1'`).get()).toEqual({
      substrate: 'interactive',
      agent_runtime: 'claude-interactive',
      run_id: 'run-1',
      chat_run_id: 'run-1',
    });
    expect(rec.refreshed).toEqual(['sess-1']);
  });

  it('startQuickSession honours an explicit name / substrate / inPlace', async () => {
    const { c, rec } = makeHarness(db, { resolvedSubstrate: 'interactive' });
    const deps = buildProposalExecutorQuickSessionDeps(c);

    const created = await deps.startQuickSession({ projectId: PROJECT_ID, name: 'findings-sweep', substrate: 'sdk', inPlace: true });

    expect(created).toEqual({ sessionId: 'sess-1', runId: 'run-1', worktreePath: '/repo', name: 'findings-sweep', substrate: 'sdk' });
    expect(rec.createRunArgs).toEqual([{ requestedSubstrate: 'sdk', sessionId: 'sess-1' }]);
    expect(rec.createSessionArgs[0]).toMatchObject({ worktreeTemplate: 'findings-sweep', inPlace: true });
    expect(db.prepare(`SELECT substrate FROM sessions WHERE id = 'sess-1'`).get()).toEqual({ substrate: 'sdk' });
  });

  it('SDK brief delivery: registered panel, persisted user turn, startPanel with the brief + session permission mode, running', async () => {
    const { c, rec } = makeHarness(db, { permissionMode: 'ignore' });
    const deps = buildProposalExecutorQuickSessionDeps(c);
    const created = await deps.startQuickSession({ projectId: PROJECT_ID, substrate: 'sdk', inPlace: false });

    const r = await deps.deliverQuickSessionBrief({ ...created, brief: 'Look at rvw_1' });

    expect(r).toEqual({ claudePanelId: 'panel-1' });
    expect(rec.registered).toEqual([{ panelId: 'panel-1', sessionId: 'sess-1' }]);
    expect(rec.panelMessages).toEqual([{ panelId: 'panel-1', content: 'Look at rvw_1' }]);
    expect(rec.sdkStarts).toEqual([
      { panelId: 'panel-1', worktreePath: created.worktreePath, prompt: 'Look at rvw_1', permissionMode: 'ignore' },
    ]);
    expect(rec.outputs).toEqual([{ sessionId: 'sess-1', data: '> Look at rvw_1\n' }]);
    expect(rec.statusUpdates).toEqual([{ sessionId: 'sess-1', status: 'running' }]);
    // Nothing PTY-shaped happened.
    expect(rec.facadeSeeds).toEqual([]);
    expect(rec.ptyStarts).toEqual([]);
  });

  it('SDK brief delivery throws when the Claude panel manager is not wired, and when startPanel rejects', async () => {
    const absent = buildProposalExecutorQuickSessionDeps(makeHarness(db, { claudePanelManagerAbsent: true }).c);
    const created = await absent.startQuickSession({ projectId: PROJECT_ID, substrate: 'sdk', inPlace: false });
    await expect(absent.deliverQuickSessionBrief({ ...created, brief: 'x' })).rejects.toThrow('Claude panel manager is not available');

    _resetClaimedQuickSessionIdsForTesting();
    const throwing = buildProposalExecutorQuickSessionDeps(makeHarness(makeDb(), { sdkStartThrows: true }).c);
    const created2 = await throwing.startQuickSession({ projectId: PROJECT_ID, substrate: 'sdk', inPlace: false });
    await expect(throwing.deliverQuickSessionBrief({ ...created2, brief: 'x' })).rejects.toThrow('sdk boom');
  });

  it('PTY brief delivery: facade seed BEFORE the spawn, the brief as the positional prompt, the briefing on the system prompt, never awaited', async () => {
    const { c, rec } = makeHarness(db, { permissionMode: 'approve' });
    const deps = buildProposalExecutorQuickSessionDeps(c);
    const created = await deps.startQuickSession({ projectId: PROJECT_ID, substrate: 'interactive', inPlace: false });

    // Resolves although the fake spawn promise never does (persistent-REPL contract).
    const r = await deps.deliverQuickSessionBrief({ ...created, brief: 'Look at rvw_1' });

    expect(r).toEqual({ claudePanelId: 'panel-1' });
    expect(rec.facadeSeeds).toEqual([{ runId: 'run-1', panelId: 'panel-1' }]);
    expect(rec.ptyStarts).toEqual([
      [
        'panel-1',
        'sess-1',
        created.worktreePath,
        'Look at rvw_1',
        'approve',
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        'BRIEFING',
      ],
    ]);
    expect(rec.statusUpdates).toEqual([{ sessionId: 'sess-1', status: 'running' }]);
    // The PTY panel is deliberately NOT registered with the Claude panel manager.
    expect(rec.registered).toEqual([]);
    expect(rec.sdkStarts).toEqual([]);
    expect(rec.panelMessages).toEqual([]);
  });

  it('an EARLY PTY spawn rejection (next-tick "not available") throws so the executor compensates', async () => {
    const { c, rec } = makeHarness(db, { ptySpawnRejects: true });
    const deps = buildProposalExecutorQuickSessionDeps(c);
    const created = await deps.startQuickSession({ projectId: PROJECT_ID, substrate: 'interactive', inPlace: false });

    await expect(deps.deliverQuickSessionBrief({ ...created, brief: 'x' })).rejects.toThrow(/interactive REPL spawn rejected: pty boom/);
    // Nothing was stamped 'running' over a dead terminal, and the session was
    // not error-surfaced either — the executor's saga dismisses it outright.
    expect(rec.statusUpdates).toEqual([]);
    expect(rec.sessionErrors).toEqual([]);
    expect(rec.seamReports).toEqual([]);
    expect(rec.errors).toEqual([]);
  });

  it('a LATE PTY spawn failure is fail-soft but VISIBLE: seam report + session error + status error', async () => {
    const late = { reject: (_err: Error) => {} };
    const { c, rec } = makeHarness(db, { latePtyFailure: late });
    const deps = buildProposalExecutorQuickSessionDeps(c);
    const created = await deps.startQuickSession({ projectId: PROJECT_ID, substrate: 'interactive', inPlace: false });

    await expect(deps.deliverQuickSessionBrief({ ...created, brief: 'x' })).resolves.toEqual({ claudePanelId: 'panel-1' });
    expect(rec.statusUpdates).toEqual([{ sessionId: 'sess-1', status: 'running' }]);

    late.reject(new Error('worktree prep boom'));
    await vi.waitFor(() => expect(rec.errors).toHaveLength(1));
    expect(rec.errors[0]).toMatch(/interactive REPL spawn failed.*worktree prep boom/);
    expect(rec.seamReports).toEqual([{ substrate: 'interactive', cliTool: 'claude', sessionId: 'sess-1', message: 'worktree prep boom' }]);
    expect(rec.sessionErrors).toEqual([{ sessionId: 'sess-1', error: 'claude failed to start', details: 'Error: worktree prep boom' }]);
    // 'running' was written BEFORE the late catch, so 'error' is the final word.
    expect(rec.statusUpdates).toEqual([
      { sessionId: 'sess-1', status: 'running' },
      { sessionId: 'sess-1', status: 'error' },
    ]);
  });

  it('a throw after the core persisted the session dismisses it before rejecting (no orphan outside the saga)', async () => {
    const { c, rec } = makeHarness(db, { stampThrows: true });
    const deps = buildProposalExecutorQuickSessionDeps(c);

    await expect(deps.startQuickSession({ projectId: PROJECT_ID, inPlace: false })).rejects.toThrow('stamp boom');
    expect(rec.dismissed).toEqual(['sess-1']);
    expect(rec.refreshed).toEqual([]);
  });
});
