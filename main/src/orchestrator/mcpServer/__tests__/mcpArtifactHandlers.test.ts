/**
 * Unit tests for McpQueryHandler.handleReportArtifact (`mcp-report-artifact`) and
 * handleCommitArtifact (`mcp-commit-artifact`) — the two run-artifact write seams
 * routing through the ArtifactRouter chokepoint.
 *
 * These retire the "opaque artifact error regression" the plan calls out: every
 * ArtifactError REACHABLE through this seam must surface as `${code}: ${message}`
 * so the agent (and rail UI) can distinguish a bad atype from an
 * already-committed artifact.
 *
 * Reachability note (documented as a deviation): the run-context guard
 * (resolveReviewItemRunContext) resolves projectId + a valid `agent:<label>`
 * actor from the SAME run the router then re-reads, so the router's own
 * `run_not_found` and `wrong_project` codes — and the `actor === 'linear'`
 * coercion — are structurally UNREACHABLE via this handler (the ctx guard fires
 * first / the actor is never 'linear'). Only not_found / invalid_atype /
 * already_committed are reachable, and are covered below.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as net from 'net';
import { McpQueryHandler, type McpQueryMessage, type McpQueryResponse } from '../mcpQueryHandler';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { ArtifactRouter, artifactChangeEvents } from '../../artifactRouter';
import type { ArtifactType } from '../../../../../shared/types/artifacts';

function makeSocketDouble(): { socket: net.Socket; writes: string[] } {
  const writes: string[] = [];
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
  } as unknown as net.Socket;
  return { socket, writes };
}
function parseLastWrite(writes: string[]): McpQueryResponse {
  return JSON.parse(writes[writes.length - 1]) as McpQueryResponse;
}

// DB: projects + 006 + 011 + 014 + 015 + 016 + 035 (mirrors artifactRouter.test.ts).
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
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '035_artifacts.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  // workflow_runs.session_id (migration 019) — added directly here; migration 019
  // itself backfills from the Crystal-legacy `sessions` table, which this entity
  // test DB doesn't create. ArtifactRouter's emitChange resolves this column on
  // every write, so it must exist even though these tests don't assert on it.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  return db;
}

/** Seed a run whose current_step_id + snapshot derive actor = 'agent:extractor'. */
function seedRun(db: Database.Database, runId: string, status = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json)
     VALUES (?, 'wf-1', 1, ?, 'extract', '{"extract":"extractor"}')`,
  ).run(runId, status);
}

function artifactRow(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}
function artifactEventActor(db: Database.Database, artifactId: string): string {
  const row = db
    .prepare("SELECT actor FROM entity_events WHERE entity_type = 'artifact' AND entity_id = ? ORDER BY seq ASC LIMIT 1")
    .get(artifactId) as { actor: string } | undefined;
  return row?.actor ?? '';
}

describe('McpQueryHandler artifact handlers', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;

  beforeEach(() => {
    db = buildDb();
    ArtifactRouter.initialize(dbAdapter(db));
    handler = new McpQueryHandler(dbAdapter(db));
  });

  afterEach(() => {
    ArtifactRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    db.close();
  });

  // -------------------------------------------------------------------------
  // report-artifact
  // -------------------------------------------------------------------------

  describe('mcp-report-artifact', () => {
    it('happy path: replies { artifactId, atype }, writes the row with the run-derived agent actor', async () => {
      seedRun(db, 'run-1');
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-report-artifact',
          requestId: 'a-1',
          runId: 'run-1',
          atype: 'idea-spec',
          label: 'IDEA-018 · wizard',
        },
        socket,
      );

      expect(writes[writes.length - 1].endsWith('\n')).toBe(true);
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as { artifactId: string; atype: string };
      expect(data.atype).toBe('idea-spec');
      expect(typeof data.artifactId).toBe('string');

      // Row persisted, minted isNew, and the audit event is attributed to the
      // actor resolved from the run's current step (NOT coerced to unknown).
      const row = artifactRow(db, data.artifactId);
      expect(row).toMatchObject({ run_id: 'run-1', atype: 'idea-spec', label: 'IDEA-018 · wizard' });
      expect(row!.is_new).toBe(1);
      expect(artifactEventActor(db, data.artifactId)).toBe('agent:extractor');
    });

    it('is idempotent per (run, atype): a re-report returns the SAME artifact id', async () => {
      seedRun(db, 'run-1');
      const first = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'a-1', runId: 'run-1', atype: 'idea-spec', label: 'v1' },
        first.socket,
      );
      const id1 = (parseLastWrite(first.writes).data as { artifactId: string }).artifactId;

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'a-2', runId: 'run-1', atype: 'idea-spec', label: 'v2' },
        socket,
      );
      const id2 = (parseLastWrite(writes).data as { artifactId: string }).artifactId;
      expect(id2).toBe(id1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(1);
    });

    it('surfaces an invalid atype as ok:false "invalid_atype: ..."', async () => {
      seedRun(db, 'run-1');
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-report-artifact',
          requestId: 'a-1',
          runId: 'run-1',
          // Deliberately-bogus atype (cast past the compile-time union) exercises
          // the router's runtime VALID_ATYPES guard.
          atype: 'not-a-real-atype' as ArtifactType,
          label: 'x',
        },
        socket,
      );

      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^invalid_atype: /);
      expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(0);
    });

    it('rejects the orchestrator sentinel via the run-context guard (finding_requires_real_run)', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'a-1', runId: 'orchestrator', atype: 'idea-spec', label: 'x' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      // Bare ctx error (no code:message wrap — this rejection is pre-router).
      expect(res.error).toBe('finding_requires_real_run');
    });

    it('rejects a terminal run (run_not_active) before touching the router', async () => {
      seedRun(db, 'run-done', 'failed');
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'a-1', runId: 'run-done', atype: 'idea-spec', label: 'x' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('run_not_active');
    });
  });

  // -------------------------------------------------------------------------
  // commit-artifact
  // -------------------------------------------------------------------------

  describe('mcp-commit-artifact', () => {
    /** Create an artifact via the report handler and return its id. */
    async function reportArtifact(runId: string, atype: ArtifactType = 'idea-spec'): Promise<string> {
      const s = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: `r-${atype}`, runId, atype, label: 'seed' },
        s.socket,
      );
      return (parseLastWrite(s.writes).data as { artifactId: string }).artifactId;
    }

    it('happy path: flips committed and replies { artifactId, committed:true }', async () => {
      seedRun(db, 'run-1');
      const artifactId = await reportArtifact('run-1');

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-commit-artifact', requestId: 'c-1', runId: 'run-1', artifactId },
        socket,
      );

      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ artifactId, committed: true });
      expect(artifactRow(db, artifactId)!.committed).toBe(1);
    });

    it('surfaces a double-commit as ok:false "already_committed: ..."', async () => {
      seedRun(db, 'run-1');
      const artifactId = await reportArtifact('run-1');
      const first = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-commit-artifact', requestId: 'c-1', runId: 'run-1', artifactId }, first.socket);
      expect(parseLastWrite(first.writes).ok).toBe(true);

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage({ type: 'mcp-commit-artifact', requestId: 'c-2', runId: 'run-1', artifactId }, socket);

      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^already_committed: /);
    });

    it('surfaces an unknown artifact id as ok:false "not_found: ..."', async () => {
      seedRun(db, 'run-1');
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-commit-artifact', requestId: 'c-1', runId: 'run-1', artifactId: 'art_deadbeef' },
        socket,
      );

      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^not_found: /);
    });

    it('rejects the orchestrator sentinel via the run-context guard', async () => {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-commit-artifact', requestId: 'c-1', runId: 'orchestrator', artifactId: 'art_x' },
        socket,
      );
      const res = parseLastWrite(writes);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('finding_requires_real_run');
    });
  });

  // -------------------------------------------------------------------------
  // quick-session ('__quick__' sentinel) runs
  // -------------------------------------------------------------------------

  // Quick sessions have no flow steps driving them — they report artifacts
  // against their persistent '__quick__' chat sentinel run (sessions.chat_run_id),
  // a workflow_runs row with a '__quick__'-named workflow and a NULL
  // current_step_id. Code reading shows neither handler checks workflow name or
  // kind anywhere, so this locks in the acceptance the UI-side quick-session
  // artifact surface (center-pane tabs + right-rail Artifacts panel) depends on.
  describe("quick-session ('__quick__' sentinel) runs", () => {
    /** Seed a '__quick__'-workflow run with NO current step (chat sentinel shape). */
    function seedQuickRun(db: Database.Database, runId: string): void {
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-quick', 1, '__quick__', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json)
         VALUES (?, 'wf-quick', 1, 'running', NULL, NULL)`,
      ).run(runId);
    }

    it('handleReportArtifact succeeds for a __quick__ run, writing the row against the sentinel run id', async () => {
      seedQuickRun(db, 'quick-1');
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-report-artifact',
          requestId: 'q-1',
          runId: 'quick-1',
          atype: 'idea-spec',
          label: 'quick chat artifact',
        },
        socket,
      );

      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      const data = res.data as { artifactId: string; atype: string };
      expect(data.atype).toBe('idea-spec');
      expect(typeof data.artifactId).toBe('string');

      const row = artifactRow(db, data.artifactId);
      expect(row).toMatchObject({ run_id: 'quick-1', atype: 'idea-spec', label: 'quick chat artifact' });
      // NULL current_step_id (no flow steps drive a quick session) resolves to
      // the 'unknown' label, i.e. the same 'agent:unknown' fallback the
      // handler's ctx.actor === 'linear' coercion produces for any run lacking
      // step context — not a quick-session-specific code path.
      expect(artifactEventActor(db, data.artifactId)).toBe('agent:unknown');
    });

    it("is idempotent per (run, atype) for a __quick__ run: a re-report returns the SAME artifact id", async () => {
      seedQuickRun(db, 'quick-1');
      const first = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'q-1', runId: 'quick-1', atype: 'idea-spec', label: 'v1' },
        first.socket,
      );
      const id1 = (parseLastWrite(first.writes).data as { artifactId: string }).artifactId;

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'q-2', runId: 'quick-1', atype: 'idea-spec', label: 'v2' },
        socket,
      );
      const id2 = (parseLastWrite(writes).data as { artifactId: string }).artifactId;
      expect(id2).toBe(id1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(1);
    });

    it('handleCommitArtifact then succeeds and flips committed for a __quick__ run', async () => {
      seedQuickRun(db, 'quick-1');
      const reportSocket = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'q-1', runId: 'quick-1', atype: 'idea-spec', label: 'seed' },
        reportSocket.socket,
      );
      const artifactId = (parseLastWrite(reportSocket.writes).data as { artifactId: string }).artifactId;

      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-commit-artifact', requestId: 'q-2', runId: 'quick-1', artifactId },
        socket,
      );

      const res = parseLastWrite(writes);
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ artifactId, committed: true });
      expect(artifactRow(db, artifactId)!.committed).toBe(1);
    });
  });
});
