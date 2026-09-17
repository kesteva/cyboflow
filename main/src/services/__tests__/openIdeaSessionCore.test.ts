/**
 * openIdeaSessionCore — the find-or-create door behind the backlog idea card's
 * "Open" (idea sessions plan, Stage 1).
 *
 * Runs against a REAL in-memory sqlite carrying migration 113's partial-unique
 * index, so the concurrent-Open race is exercised by the actual constraint
 * rather than a simulated throw. Everything else (task queue, session manager,
 * workflow registry, panel managers, dismissal) is a fake, following the
 * createQuickSessionCore.stamp.test.ts fake-deps pattern.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import { _resetClaimedQuickSessionIdsForTesting } from '../createQuickSessionCore';
import {
  openIdeaSessionCore,
  OpenIdeaSessionError,
  OPEN_IDEA_SESSION_SCHEMA,
  resolveIdeaSessionIdentity,
  type OpenIdeaSessionCoreDeps,
} from '../openIdeaSessionCore';
import { validateInput } from '../../ipc/validateInput';
import type { ClaudeSdkPreflightResult } from '../claudeSdkSessionPreflight';

const PROJECT_ID = 7;
const IDEA_ID = 'idea-abc';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ideas (
      id            TEXT PRIMARY KEY,
      project_id    INTEGER NOT NULL,
      ref           TEXT,
      title         TEXT,
      decomposed_at TEXT,
      archived_at   TEXT
    );
    CREATE TABLE sessions (
      id                    TEXT PRIMARY KEY,
      name                  TEXT,
      status                TEXT,
      archived              INTEGER DEFAULT 0,
      in_place              INTEGER DEFAULT 0,
      run_id                TEXT,
      chat_run_id           TEXT,
      substrate             TEXT,
      agent_runtime         TEXT,
      agent_permission_mode TEXT,
      home_idea_id          TEXT,
      origin_idea_id        TEXT
    );
    CREATE UNIQUE INDEX idx_sessions_home_idea
      ON sessions(home_idea_id)
      WHERE home_idea_id IS NOT NULL AND (archived = 0 OR archived IS NULL);
    CREATE TABLE workflow_runs (
      id            TEXT PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'queued',
      worktree_path TEXT,
      started_at    TEXT,
      updated_at    TEXT
    );
  `);
  db.prepare(`INSERT INTO ideas (id, project_id, ref, title) VALUES (?, ?, ?, ?)`).run(
    IDEA_ID,
    PROJECT_ID,
    'IDEA-009',
    'Persistent idea sessions',
  );
  return db;
}

interface Recorder {
  createdSessionNames: string[];
  createdPanels: Array<{ sessionId: string }>;
  registered: Array<{ panelId: string; sessionId: string }>;
  refreshed: string[];
  dismissed: string[];
  quickCoreCalls: number;
}

interface HarnessOptions {
  /** Session id the fake task queue provisions. */
  newSessionId?: string;
  preflight?: ClaudeSdkPreflightResult;
  /** Panels the fake panel manager already holds, keyed by session id. */
  seedPanels?: Record<string, ToolPanel[]>;
  /** Fires inside the fake createRun — i.e. AFTER provisioning, BEFORE the stamp. */
  onCreateRun?: () => void;
  /** Substrate the fake sentinel createRun resolves to. */
  resolvedSubstrate?: 'sdk' | 'interactive';
  /** Make the panel-ensure step blow up (contract: NOT compensated). */
  createPanelThrows?: boolean;
}

function makePanel(sessionId: string, id: string): ToolPanel {
  return {
    id,
    sessionId,
    type: 'claude',
    title: 'Chat',
    state: { isActive: true, customState: {} },
    metadata: { createdAt: '2026-08-21T00:00:00Z', lastActiveAt: '2026-08-21T00:00:00Z', position: 0 },
  };
}

function makeHarness(
  db: Database.Database,
  opts: HarnessOptions = {},
): { deps: OpenIdeaSessionCoreDeps; rec: Recorder } {
  const newSessionId = opts.newSessionId ?? 'sess-new';
  const panels: Record<string, ToolPanel[]> = { ...(opts.seedPanels ?? {}) };
  let panelSeq = 0;
  const rec: Recorder = {
    createdSessionNames: [],
    createdPanels: [],
    registered: [],
    refreshed: [],
    dismissed: [],
    quickCoreCalls: 0,
  };

  const deps: OpenIdeaSessionCoreDeps = {
    getDb: () => db,
    quickSession: {
      taskQueue: {
        onSessionJobFailed: () => () => {},
        createSession: async (data) => {
          rec.quickCoreCalls += 1;
          rec.createdSessionNames.push(data.worktreeTemplate);
          db.prepare(
            `INSERT INTO sessions (id, name, status, in_place) VALUES (?, ?, 'pending', ?)`,
          ).run(newSessionId, data.worktreeTemplate, data.inPlace ? 1 : 0);
          return { id: 'job-1' };
        },
      },
      sessionManager: {
        // The core registers its listener after the createSession await, so an
        // immediate emit models `session-created` without timers. In-place
        // matching is by NAME, which is why the fake echoes the template.
        on: (_event, listener) => {
          const row = db
            .prepare(`SELECT id, name FROM sessions WHERE id = ?`)
            .get(newSessionId) as { id: string; name: string };
          listener({ id: row.id, worktreePath: '/repo', name: row.name });
        },
        removeListener: () => {},
      },
      workflowRegistry: {
        ensureQuickWorkflow: () => 'wf-quick',
        createRun: () => {
          db.prepare(`INSERT INTO workflow_runs (id, status) VALUES ('run-quick', 'queued')`).run();
          opts.onCreateRun?.();
          return { runId: 'run-quick', substrate: opts.resolvedSubstrate ?? 'sdk' };
        },
      },
      getDb: () => db,
      dismissHalfCreatedSession: async (sessionId) => {
        rec.dismissed.push(sessionId);
      },
    },
    runPreflights: async () => opts.preflight ?? { ok: true },
    panelManager: {
      getPanelsForSession: (sessionId) => panels[sessionId] ?? [],
      createPanel: async (request) => {
        if (opts.createPanelThrows) throw new Error('panel boom');
        panelSeq += 1;
        const panel = makePanel(request.sessionId, `panel-${panelSeq}`);
        panels[request.sessionId] = [...(panels[request.sessionId] ?? []), panel];
        rec.createdPanels.push({ sessionId: request.sessionId });
        return panel;
      },
    },
    getClaudePanelRegistrar: () => ({
      registerPanel: (panelId, sessionId) => {
        rec.registered.push({ panelId, sessionId });
      },
    }),
    refreshSession: (sessionId) => {
      rec.refreshed.push(sessionId);
    },
    dismissSession: async (sessionId) => {
      rec.dismissed.push(sessionId);
      db.prepare(`UPDATE sessions SET archived = 1, home_idea_id = NULL WHERE id = ?`).run(sessionId);
    },
  };

  return { deps, rec };
}

function readSession(db: Database.Database, id: string): {
  name: string | null;
  home_idea_id: string | null;
  origin_idea_id: string | null;
  substrate: string | null;
  agent_runtime: string | null;
  chat_run_id: string | null;
} {
  return db
    .prepare(
      `SELECT name, home_idea_id, origin_idea_id, substrate, agent_runtime, chat_run_id
         FROM sessions WHERE id = ?`,
    )
    .get(id) as ReturnType<typeof readSession>;
}

describe('OPEN_IDEA_SESSION_SCHEMA (the sessions:open-idea-session validateInput contract)', () => {
  const CHANNEL = 'sessions:open-idea-session';

  it('accepts a well-formed request', () => {
    const v = validateInput(OPEN_IDEA_SESSION_SCHEMA, { projectId: 7, ideaId: 'idea-abc' }, CHANNEL);

    expect(v).toEqual({ ok: true, value: { projectId: 7, ideaId: 'idea-abc' } });
  });

  it.each([
    ['undefined args', undefined],
    ['null args', null],
    ['missing projectId', { ideaId: 'idea-abc' }],
    ['missing ideaId', { projectId: 7 }],
    ['string projectId', { projectId: '7', ideaId: 'idea-abc' }],
    ['numeric ideaId', { projectId: 7, ideaId: 9 }],
    ['empty ideaId', { projectId: 7, ideaId: '' }],
    ['NaN projectId', { projectId: Number.NaN, ideaId: 'idea-abc' }],
  ])('rejects %s and names the offending field', (_label, args) => {
    const v = validateInput(OPEN_IDEA_SESSION_SCHEMA, args, CHANNEL);

    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/^sessions:open-idea-session: (projectId|ideaId)\b/);
  });
});

describe('resolveIdeaSessionIdentity', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });
  afterEach(() => db.close());

  it('derives the name + template from the display ref', () => {
    expect(resolveIdeaSessionIdentity(db, IDEA_ID)).toEqual({
      nameHint: 'idea-009',
      displayName: 'IDEA-009 · idea',
    });
  });

  it('falls back to a slug + truncated title when the idea has no ref', () => {
    db.prepare(`UPDATE ideas SET ref = NULL, title = ? WHERE id = ?`).run(
      'A very long idea title that will absolutely be truncated here',
      IDEA_ID,
    );

    const identity = resolveIdeaSessionIdentity(db, IDEA_ID);

    expect(identity.nameHint).toBe('a-very-long-idea-title-that-will');
    expect(identity.displayName).toMatch(/… · idea$/);
    expect(identity.displayName.length).toBeLessThanOrEqual(47);
  });

  it('never produces an empty template (regex-safe fallback)', () => {
    db.prepare(`UPDATE ideas SET ref = NULL, title = '///' WHERE id = ?`).run(IDEA_ID);

    expect(resolveIdeaSessionIdentity(db, IDEA_ID).nameHint).toBe('idea-session');
  });
});

describe('openIdeaSessionCore — validation', () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
    db = buildDb();
  });
  afterEach(() => db.close());

  it('rejects an archived idea WITHOUT provisioning anything', async () => {
    db.prepare(`UPDATE ideas SET archived_at = '2026-08-01' WHERE id = ?`).run(IDEA_ID);
    const { deps, rec } = makeHarness(db);

    await expect(openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID })).rejects.toThrow(
      OpenIdeaSessionError,
    );
    expect(rec.quickCoreCalls).toBe(0);
  });

  it('rejects an idea owned by another project', async () => {
    const { deps } = makeHarness(db);

    await expect(
      openIdeaSessionCore(deps, { projectId: PROJECT_ID + 1, ideaId: IDEA_ID }),
    ).rejects.toThrow(/different project/i);
  });

  it('surfaces a failed pre-flight with THIS door’s wording and provisions nothing', async () => {
    const { deps, rec } = makeHarness(db, { preflight: { ok: false, reason: 'provider_disabled' } });

    await expect(
      openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID }),
    ).rejects.toThrow(/Idea sessions require Claude/);
    expect(rec.quickCoreCalls).toBe(0);
  });
});

describe('openIdeaSessionCore — find path', () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
    db = buildDb();
    db.prepare(
      `INSERT INTO sessions (id, name, status, home_idea_id, origin_idea_id, chat_run_id)
       VALUES ('sess-home', 'IDEA-009 · idea', 'stopped', ?, ?, 'run-home')`,
    ).run(IDEA_ID, IDEA_ID);
  });
  afterEach(() => db.close());

  it('returns the existing home session and never runs the create path', async () => {
    const { deps, rec } = makeHarness(db);

    const result = await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(result).toEqual({
      sessionId: 'sess-home',
      chatRunId: 'run-home',
      claudePanelId: 'panel-1',
      created: false,
    });
    expect(rec.quickCoreCalls).toBe(0);
    // Pre-flights are skipped entirely — reopening must work with Claude offline.
    expect(rec.refreshed).toEqual([]);
  });

  // Panels are deletable — "the home already has one" is not an invariant.
  it('ENSURES the Claude panel on the found path when it was deleted', async () => {
    const { deps, rec } = makeHarness(db);

    await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(rec.createdPanels).toEqual([{ sessionId: 'sess-home' }]);
    expect(rec.registered).toEqual([{ panelId: 'panel-1', sessionId: 'sess-home' }]);
  });

  it('reuses an existing Claude panel instead of creating a second one', async () => {
    const { deps, rec } = makeHarness(db, {
      seedPanels: { 'sess-home': [makePanel('sess-home', 'panel-existing')] },
    });

    const result = await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(result.claudePanelId).toBe('panel-existing');
    expect(rec.createdPanels).toEqual([]);
    expect(rec.registered).toEqual([]);
  });

  it('an ARCHIVED home session releases the idea — Open mints a fresh one', async () => {
    db.prepare(`UPDATE sessions SET archived = 1 WHERE id = 'sess-home'`).run();
    const { deps, rec } = makeHarness(db);

    const result = await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(result.created).toBe(true);
    expect(result.sessionId).toBe('sess-new');
    expect(rec.quickCoreCalls).toBe(1);
  });

  it('falls back to run_id when chat_run_id was never backfilled', async () => {
    db.prepare(`UPDATE sessions SET chat_run_id = NULL, run_id = 'run-legacy' WHERE id = 'sess-home'`).run();
    const { deps } = makeHarness(db);

    const result = await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(result.chatRunId).toBe('run-legacy');
  });
});

describe('openIdeaSessionCore — create path', () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
    db = buildDb();
  });
  afterEach(() => db.close());

  it('mints an in-place SDK session, stamps the links, renames, refreshes, ensures a panel', async () => {
    const { deps, rec } = makeHarness(db);

    const result = await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(result).toEqual({
      sessionId: 'sess-new',
      chatRunId: 'run-quick',
      claudePanelId: 'panel-1',
      created: true,
    });

    // The worktree template is the REF-derived hint (the core's in-place
    // session-created matcher keys off it) — the display name lands only after.
    expect(rec.createdSessionNames).toEqual(['idea-009']);
    expect(readSession(db, 'sess-new')).toEqual({
      name: 'IDEA-009 · idea',
      home_idea_id: IDEA_ID,
      origin_idea_id: IDEA_ID,
      substrate: 'sdk',
      agent_runtime: 'claude-sdk',
      chat_run_id: 'run-quick',
    });
    expect(db.prepare(`SELECT in_place FROM sessions WHERE id = 'sess-new'`).get()).toEqual({ in_place: 1 });

    // Raw UPDATEs never reach the renderer without this.
    expect(rec.refreshed).toEqual(['sess-new']);
    expect(rec.registered).toEqual([{ panelId: 'panel-1', sessionId: 'sess-new' }]);
    expect(rec.dismissed).toEqual([]);
  });

  it('advances the sentinel run to running and stamps its worktree', async () => {
    const { deps } = makeHarness(db);

    await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(db.prepare(`SELECT status, worktree_path FROM workflow_runs WHERE id = 'run-quick'`).get()).toEqual({
      status: 'running',
      worktree_path: '/repo',
    });
  });

  it('fails closed + dismisses when the substrate belt-guard trips', async () => {
    const { deps, rec } = makeHarness(db, { resolvedSubstrate: 'interactive' });

    await expect(
      openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID }),
    ).rejects.toThrow(/Claude SDK substrate/);

    expect(rec.dismissed).toEqual(['sess-new']);
    // Nothing was linked — the swept session is an ordinary quick session.
    expect(readSession(db, 'sess-new').home_idea_id).toBeNull();
  });

  // The panel ensure is deliberately OUTSIDE the compensation window: by then
  // the session legitimately IS the idea's home and must not be swept.
  it('does NOT dismiss when the panel ensure fails after the stamp committed', async () => {
    const { deps, rec } = makeHarness(db, { createPanelThrows: true });

    await expect(openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID })).rejects.toThrow(
      'panel boom',
    );

    expect(rec.dismissed).toEqual([]);
    expect(readSession(db, 'sess-new').home_idea_id).toBe(IDEA_ID);
  });
});

describe('openIdeaSessionCore — concurrent-Open race', () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
    db = buildDb();
  });
  afterEach(() => db.close());

  it('dismisses the loser and returns the WINNER when migration 113 rejects the stamp', async () => {
    const { deps, rec } = makeHarness(db, {
      // Simulate the rival Open landing its claim between provisioning and our
      // stamp — the real partial-unique index does the rejecting.
      onCreateRun: () => {
        db.prepare(
          `INSERT INTO sessions (id, name, status, home_idea_id, chat_run_id)
           VALUES ('sess-winner', 'IDEA-009 · idea', 'stopped', ?, 'run-winner')`,
        ).run(IDEA_ID);
      },
    });

    const result = await openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID });

    expect(result).toEqual({
      sessionId: 'sess-winner',
      chatRunId: 'run-winner',
      claudePanelId: 'panel-1',
      created: false,
    });
    // The loser swept itself; the winner keeps its claim.
    expect(rec.dismissed).toEqual(['sess-new']);
    expect(rec.registered).toEqual([{ panelId: 'panel-1', sessionId: 'sess-winner' }]);
    expect(readSession(db, 'sess-winner').home_idea_id).toBe(IDEA_ID);
  });

  it('rethrows when the constraint fires but no winner can be re-queried', async () => {
    const { deps, rec } = makeHarness(db, {
      onCreateRun: () => {
        db.prepare(
          `INSERT INTO sessions (id, name, status, home_idea_id) VALUES ('sess-rival', 'x', 'stopped', ?)`,
        ).run(IDEA_ID);
      },
    });
    // The rival's own owner dismisses it in the same instant, so by the time we
    // re-query for a winner there is none — the original constraint error must
    // still surface rather than being swallowed.
    const originalDismiss = deps.dismissSession;
    deps.dismissSession = async (sessionId) => {
      await originalDismiss(sessionId);
      db.prepare(`UPDATE sessions SET archived = 1, home_idea_id = NULL WHERE id = 'sess-rival'`).run();
    };

    await expect(
      openIdeaSessionCore(deps, { projectId: PROJECT_ID, ideaId: IDEA_ID }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(rec.dismissed).toEqual(['sess-new']);
  });
});
