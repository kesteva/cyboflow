/**
 * Unit tests for the Design Mode v0 design-scoped MCP handlers
 * (docs/ideas/design-mode.md): McpQueryHandler.handleDesignGetIdea
 * (`mcp-design-get-idea`) + handleDesignUpdateDraft (`mcp-design-update-draft`),
 * the shared resolveDesignRunContext integrity re-validation behind both, and
 * the server-side source_ref stamp handleReportArtifact applies from the
 * session's validated design_idea_id.
 *
 * Harness mirrors mcpArtifactHandlers.test.ts (socket double + McpQueryHandler +
 * dbAdapter); the DB layers a minimal Crystal-legacy `sessions` table plus
 * migration 082 (design_idea_id, artifacts.revision, design_spec_drafts) onto
 * the entity-model subset.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as net from 'net';

import { McpQueryHandler, type McpQueryMessage, type McpQueryResponse } from '../mcpQueryHandler';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { ArtifactRouter, artifactChangeEvents } from '../../artifactRouter';
import { FeedbackRouter } from '../../feedbackRouter';
import { feedbackEvents } from '../../trpc/routers/events';
import type { ElementCommentAnchor } from '../../../../../shared/types/feedback';

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

/**
 * Entity-model subset + a minimal `sessions` table + migration 082. FKs OFF so
 * an idea can be inserted without seeding real boards/stages (resolveDesign-
 * RunContext reads by raw SELECT — no FK enforcement matters).
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj2', '/tmp/p2');
  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '035_artifacts.sql',
    // Design Mode v1 feedback outbox — the ack handler's tables. 092 carries its
    // own PRAGMA foreign_keys=OFF/ON pair around the table recreate, and db.exec
    // runs outside a transaction, so the file's own toggles take effect.
    '077_artifact_feedback.sql',
    '092_design_feedback_outbox.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  // ideas.archived_at (024) + decomposed_at (042) — resolveDesignRunContext
  // reads both; add the additive columns directly (this DB hand-picks a subset).
  db.exec('ALTER TABLE ideas ADD COLUMN archived_at TEXT');
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT');
  // Crystal-legacy `sessions` table (created outside migrations); migration 082
  // then layers design_idea_id + artifacts.revision + the design tables onto it.
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id INTEGER)');
  db.exec(readFileSync(join(migDir, '082_design_mode_v0.sql'), 'utf-8'));
  // 084 recreates artifacts with the interactive-prototype CHECK (the family
  // selection tests insert that atype). 083 (revision-ensure) is SKIPPED: 082
  // already added `revision`, and a raw exec of its ALTER would throw the
  // duplicate-column error the ledger runner tolerates but db.exec does not.
  db.exec(readFileSync(join(migDir, '089_interactive_prototype.sql'), 'utf-8'));
  // artifacts.reported_at (migration 143) — the LAST report's instant, which
  // ArtifactRouter's create path now names in both its INSERT and its enrich
  // UPDATE. Added directly (like the columns above) since this DB hand-picks a
  // migration subset predating 143; MUST come after every atype-CHECK recreate
  // above, since a recreate carries only the columns it names.
  db.exec('ALTER TABLE artifacts ADD COLUMN reported_at TEXT');
  // OFF *after* the migrations (some set PRAGMA foreign_keys=ON) so an idea can
  // be inserted with placeholder board_id/stage_id — the design handlers read
  // ideas by raw SELECT, where FK enforcement is irrelevant.
  db.pragma('foreign_keys = OFF');
  return db;
}

interface SeedIdeaOpts {
  id: string;
  projectId?: number;
  ref?: string;
  title?: string;
  body?: string | null;
  version?: number;
  decomposedAt?: string | null;
  archivedAt?: string | null;
}
function seedIdea(db: Database.Database, opts: SeedIdeaOpts): void {
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, version, archived_at, decomposed_at)
     VALUES (?, ?, ?, ?, ?, 'board-x', 'stage-x', ?, ?, ?)`,
  ).run(
    opts.id,
    opts.projectId ?? 1,
    opts.ref ?? 'IDEA-001',
    opts.title ?? 'An idea',
    opts.body ?? null,
    opts.version ?? 1,
    opts.archivedAt ?? null,
    opts.decomposedAt ?? null,
  );
}

function seedSession(db: Database.Database, sessionId: string, projectId: number, designIdeaId: string | null): void {
  db.prepare('INSERT INTO sessions (id, project_id, design_idea_id) VALUES (?, ?, ?)').run(sessionId, projectId, designIdeaId);
}

/** Seed a __quick__-shaped chat-sentinel run (NULL current step) with a session link. */
function seedRun(db: Database.Database, runId: string, projectId: number, sessionId: string | null): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-quick', 1, '__quick__', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, steps_snapshot_json, session_id)
     VALUES (?, 'wf-quick', ?, 'running', NULL, NULL, ?)`,
  ).run(runId, projectId, sessionId);
}

/**
 * Full happy-path wiring: idea (proj1) + design session linked to it + a run
 * bound to that session. Returns the ids.
 */
function seedDesignSession(
  db: Database.Database,
  opts: { runId: string; sessionId: string; ideaId: string; ideaOpts?: Partial<SeedIdeaOpts> },
): void {
  seedIdea(db, { id: opts.ideaId, projectId: 1, ...opts.ideaOpts });
  seedSession(db, opts.sessionId, 1, opts.ideaId);
  seedRun(db, opts.runId, 1, opts.sessionId);
}

function artifactRow(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

describe('McpQueryHandler design-scope handlers', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;

  beforeEach(() => {
    db = buildDb();
    ArtifactRouter.initialize(dbAdapter(db));
    FeedbackRouter.initialize(dbAdapter(db));
    handler = new McpQueryHandler(dbAdapter(db));
  });

  afterEach(() => {
    ArtifactRouter._resetForTesting();
    FeedbackRouter._resetForTesting();
    artifactChangeEvents.removeAllListeners();
    feedbackEvents.removeAllListeners();
    db.close();
  });

  async function getIdea(runId: string): Promise<McpQueryResponse> {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-design-get-idea', requestId: 'g-1', runId }, socket);
    return parseLastWrite(writes);
  }
  async function updateDraft(runId: string, specMarkdown: string): Promise<McpQueryResponse> {
    const { socket, writes } = makeSocketDouble();
    await handler.handleMessage({ type: 'mcp-design-update-draft', requestId: 'u-1', runId, specMarkdown }, socket);
    return parseLastWrite(writes);
  }

  // -------------------------------------------------------------------------
  // mcp-design-get-idea + resolveDesignRunContext rejection matrix
  // -------------------------------------------------------------------------

  describe('mcp-design-get-idea', () => {
    it('happy path: returns { ref, title, body, version } for the linked idea', async () => {
      seedDesignSession(db, {
        runId: 'run-1',
        sessionId: 'sess-1',
        ideaId: 'ide_1',
        ideaOpts: { ref: 'IDEA-042', title: 'Left rail redesign', body: '# rail\n\nnotes', version: 3 },
      });
      const res = await getIdea('run-1');
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ ref: 'IDEA-042', title: 'Left rail redesign', body: '# rail\n\nnotes', version: 3 });
    });

    it('rejects the orchestrator sentinel (design_requires_real_run)', async () => {
      const res = await getIdea('orchestrator');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('design_requires_real_run');
    });

    it('rejects an unknown run (run_not_found)', async () => {
      const res = await getIdea('run-ghost');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('run_not_found');
    });

    it('rejects a non-design session (design_idea_id NULL → not_a_design_session)', async () => {
      seedSession(db, 'sess-plain', 1, null);
      seedRun(db, 'run-plain', 1, 'sess-plain');
      const res = await getIdea('run-plain');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('not_a_design_session');
    });

    it('rejects a run with no session at all (not_a_design_session — join miss)', async () => {
      seedRun(db, 'run-nosess', 1, null);
      const res = await getIdea('run-nosess');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('not_a_design_session');
    });

    it('fails soft on a missing idea (deleted mid-session → idea_link_broken)', async () => {
      seedSession(db, 'sess-missing', 1, 'ide_ghost'); // points at a non-existent idea
      seedRun(db, 'run-missing', 1, 'sess-missing');
      const res = await getIdea('run-missing');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^idea_link_broken:/);
      expect(res.error).toContain('relink or end the design session');
    });

    it('fails soft on a decomposed idea (idea_link_broken)', async () => {
      seedDesignSession(db, {
        runId: 'run-dec',
        sessionId: 'sess-dec',
        ideaId: 'ide_dec',
        ideaOpts: { decomposedAt: '2026-07-22T00:00:00.000Z' },
      });
      const res = await getIdea('run-dec');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^idea_link_broken:/);
    });

    it('fails soft on an archived idea (idea_link_broken)', async () => {
      seedDesignSession(db, {
        runId: 'run-arch',
        sessionId: 'sess-arch',
        ideaId: 'ide_arch',
        ideaOpts: { archivedAt: '2026-07-22T00:00:00.000Z' },
      });
      const res = await getIdea('run-arch');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^idea_link_broken:/);
    });

    it('rejects a cross-project idea id (wrong_project)', async () => {
      // Idea lives in project 2, but the session + run are in project 1.
      seedIdea(db, { id: 'ide_x', projectId: 2, ref: 'IDEA-999' });
      seedSession(db, 'sess-x', 1, 'ide_x');
      seedRun(db, 'run-x', 1, 'sess-x');
      const res = await getIdea('run-x');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('wrong_project');
    });
  });

  // -------------------------------------------------------------------------
  // mcp-design-update-draft — revision monotonicity + prototype binding
  // -------------------------------------------------------------------------

  describe('mcp-design-update-draft', () => {
    it('first draft → draftRevision 1, boundArtifactRevision null (no prototype yet); persists the row', async () => {
      seedDesignSession(db, { runId: 'run-d', sessionId: 'sess-d', ideaId: 'ide_d' });
      const res = await updateDraft('run-d', '### Design\n\nfirst pass');
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ draftRevision: 1, boundArtifactRevision: null });

      const row = db
        .prepare('SELECT * FROM design_spec_drafts WHERE session_id = ? ORDER BY draft_revision DESC LIMIT 1')
        .get('sess-d') as Record<string, unknown>;
      expect(row).toMatchObject({
        session_id: 'sess-d',
        idea_id: 'ide_d',
        draft_revision: 1,
        spec_markdown: '### Design\n\nfirst pass',
        bound_artifact_id: null,
        bound_artifact_revision: null,
      });
    });

    it('draft_revision is per-session monotonic across successive updates (1 → 2 → 3)', async () => {
      seedDesignSession(db, { runId: 'run-m', sessionId: 'sess-m', ideaId: 'ide_m' });
      expect((await updateDraft('run-m', 'a')).data).toMatchObject({ draftRevision: 1 });
      expect((await updateDraft('run-m', 'b')).data).toMatchObject({ draftRevision: 2 });
      expect((await updateDraft('run-m', 'c')).data).toMatchObject({ draftRevision: 3 });
      expect((db.prepare('SELECT COUNT(*) AS n FROM design_spec_drafts WHERE session_id = ?').get('sess-m') as { n: number }).n).toBe(3);
    });

    it("binds the draft to the session's CURRENT ui-prototype artifact revision", async () => {
      seedDesignSession(db, { runId: 'run-b', sessionId: 'sess-b', ideaId: 'ide_b' });
      // A prototype artifact for this run at revision 3.
      db.prepare(
        `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, created_at)
         VALUES ('art_proto', 'run-b', 'ui-prototype', 'mockup', 'canvas', 3, '2026-07-22T00:00:00.000Z')`,
      ).run();

      const res = await updateDraft('run-b', '### Design\n\nbound to p3');
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ draftRevision: 1, boundArtifactRevision: 3 });

      const row = db
        .prepare('SELECT bound_artifact_id AS id, bound_artifact_revision AS rev FROM design_spec_drafts WHERE session_id = ?')
        .get('sess-b') as { id: string; rev: number };
      expect(row).toEqual({ id: 'art_proto', rev: 3 });
    });

    it('prototype-family selection: a payload-bearing interactive-prototype beats the bytes-less ui-prototype re-entry stub', async () => {
      seedDesignSession(db, { runId: 'run-fam', sessionId: 'sess-fam', ideaId: 'ide_fam' });
      // The re-entry stub: bytes-less ui-prototype (payload_json NULL), minted at
      // session creation. The agent's real report landed as interactive-prototype.
      db.prepare(
        `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, payload_json, created_at)
         VALUES ('art_stub', 'run-fam', 'ui-prototype', 'Prototype', 'canvas', 1, NULL, '2026-07-22T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, payload_json, created_at)
         VALUES ('art_live', 'run-fam', 'interactive-prototype', 'mockup', 'canvas', 2,
                 '{"fileName":"prototype/index.html"}', '2026-07-22T01:00:00.000Z')`,
      ).run();

      const res = await updateDraft('run-fam', '### Design\n\nbound to the interactive prototype');
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ draftRevision: 1, boundArtifactRevision: 2 });
      const row = db
        .prepare('SELECT bound_artifact_id AS id, bound_artifact_revision AS rev FROM design_spec_drafts WHERE session_id = ?')
        .get('sess-fam') as { id: string; rev: number };
      expect(row).toEqual({ id: 'art_live', rev: 2 });
    });

    it('prototype-family selection: interactive-prototype beats a payload-bearing ui-prototype with a HIGHER revision (mid-session tier switch)', async () => {
      seedDesignSession(db, { runId: 'run-tier', sessionId: 'sess-tier', ideaId: 'ide_tier' });
      // A mid-session tier switch leaves BOTH rows payload-bearing: the lo-fi
      // ui-prototype iterated to revision 2 in its earlier life, then the user
      // asked for interactive (revision 1). Revision alone must never break
      // this tie — the interactive tier is the live canvas, and binding the
      // lo-fi row makes the approve CAS guard the wrong artifact.
      db.prepare(
        `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, payload_json, created_at)
         VALUES ('art_lofi', 'run-tier', 'ui-prototype', 'mockup', 'canvas', 2,
                 '{"fileName":"prototype/index.html"}', '2026-07-22T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, payload_json, created_at)
         VALUES ('art_hifi', 'run-tier', 'interactive-prototype', 'mockup', 'canvas', 1,
                 '{"fileName":"prototype/index.html"}', '2026-07-22T01:00:00.000Z')`,
      ).run();

      const res = await updateDraft('run-tier', '### Design\n\nbound to the interactive tier');
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ draftRevision: 1, boundArtifactRevision: 1 });
      const row = db
        .prepare('SELECT bound_artifact_id AS id, bound_artifact_revision AS rev FROM design_spec_drafts WHERE session_id = ?')
        .get('sess-tier') as { id: string; rev: number };
      expect(row).toEqual({ id: 'art_hifi', rev: 1 });
    });

    it('propagates a broken idea link and writes NO draft row', async () => {
      seedDesignSession(db, {
        runId: 'run-brk',
        sessionId: 'sess-brk',
        ideaId: 'ide_brk',
        ideaOpts: { decomposedAt: '2026-07-22T00:00:00.000Z' },
      });
      const res = await updateDraft('run-brk', 'anything');
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^idea_link_broken:/);
      expect((db.prepare('SELECT COUNT(*) AS n FROM design_spec_drafts').get() as { n: number }).n).toBe(0);
    });

    it('rejects a non-design session without writing a draft', async () => {
      seedSession(db, 'sess-nd', 1, null);
      seedRun(db, 'run-nd', 1, 'sess-nd');
      const res = await updateDraft('run-nd', 'x');
      expect(res.ok).toBe(false);
      expect(res.error).toBe('not_a_design_session');
      expect((db.prepare('SELECT COUNT(*) AS n FROM design_spec_drafts').get() as { n: number }).n).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // mcp-design-ack-feedback — the outbox's one-result CAS, session-scoped
  // -------------------------------------------------------------------------

  describe('mcp-design-ack-feedback', () => {
    const ELEMENT_ANCHOR: ElementCommentAnchor = {
      kind: 'element',
      designId: 'hero-cta',
      ancestorStack: [
        { tag: 'button', designId: 'hero-cta', label: 'Get started' },
        { tag: 'body', designId: null, label: null },
      ],
      pickedIndex: 0,
    };

    async function ack(
      runId: string,
      args: { batchId: string; attemptId?: string; prototypeRevision?: number },
    ): Promise<McpQueryResponse> {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        {
          type: 'mcp-design-ack-feedback',
          requestId: 'a-1',
          runId,
          batchId: args.batchId,
          attemptId: args.attemptId ?? 'fba_1',
          prototypeRevision: args.prototypeRevision ?? 4,
        },
        socket,
      );
      return parseLastWrite(writes);
    }

    /** Mint a design batch bound to `sessionId` and drive it to 'dispatched'. */
    async function dispatchedBatch(opts: {
      runId: string;
      sessionId: string;
      sourceRef: string;
    }): Promise<{ batchId: string; commentId: string }> {
      const router = FeedbackRouter.getInstance();
      const { commentId } = await router.apply(1, {
        op: 'create-comment',
        runId: opts.runId,
        atype: 'interactive-prototype',
        sourceRef: opts.sourceRef,
        anchor: ELEMENT_ANCHOR,
        body: 'make the CTA bigger',
      });
      const { batchId } = await router.createDesignBatch({
        projectId: 1,
        runId: opts.runId,
        sessionId: opts.sessionId,
        atype: 'interactive-prototype',
        sourceRef: opts.sourceRef,
        commentIds: [commentId],
      });
      await router.recordDispatchAttempt({ batchId, attemptId: 'fba_1' });
      await router.transitionBatch({ batchId, from: 'dispatching', to: 'dispatched' });
      return { batchId, commentId };
    }

    it('applies the batch: { applied: true }, batch → applied with the revision, comments → addressed', async () => {
      seedDesignSession(db, { runId: 'run-ack', sessionId: 'sess-ack', ideaId: 'ide_ack' });
      const { batchId, commentId } = await dispatchedBatch({
        runId: 'run-ack',
        sessionId: 'sess-ack',
        sourceRef: 'ide_ack',
      });

      const res = await ack('run-ack', { batchId, prototypeRevision: 6 });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ applied: true });

      expect(
        db.prepare('SELECT status, applied_prototype_revision AS rev, current_attempt_id AS att FROM feedback_batches WHERE id = ?').get(batchId),
      ).toMatchObject({ status: 'applied', rev: 6, att: 'fba_1' });
      expect(
        (db.prepare('SELECT status FROM feedback_comments WHERE id = ?').get(commentId) as { status: string }).status,
      ).toBe('addressed');
    });

    it('a SECOND ack is acknowledged-and-discarded: { applied: false } with a note, never an error', async () => {
      seedDesignSession(db, { runId: 'run-dup', sessionId: 'sess-dup', ideaId: 'ide_dup' });
      const { batchId } = await dispatchedBatch({
        runId: 'run-dup',
        sessionId: 'sess-dup',
        sourceRef: 'ide_dup',
      });

      expect((await ack('run-dup', { batchId, prototypeRevision: 6 })).data).toEqual({ applied: true });

      const second = await ack('run-dup', { batchId, attemptId: 'fba_2', prototypeRevision: 9 });
      expect(second.ok).toBe(true);
      expect(second.data).toMatchObject({ applied: false });
      expect((second.data as { note: string }).note).toContain('already resolved');
      // The first result stands — the loser never overwrites the recorded revision.
      expect(
        db.prepare('SELECT applied_prototype_revision AS rev FROM feedback_batches WHERE id = ?').get(batchId),
      ).toMatchObject({ rev: 6 });
    });

    it("rejects a batch belonging to ANOTHER design session (batch_not_in_session)", async () => {
      seedDesignSession(db, { runId: 'run-mine', sessionId: 'sess-mine', ideaId: 'ide_mine' });
      seedDesignSession(db, {
        runId: 'run-theirs',
        sessionId: 'sess-theirs',
        ideaId: 'ide_theirs',
        ideaOpts: { ref: 'IDEA-002' },
      });
      const { batchId } = await dispatchedBatch({
        runId: 'run-theirs',
        sessionId: 'sess-theirs',
        sourceRef: 'ide_theirs',
      });

      const res = await ack('run-mine', { batchId });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^batch_not_in_session:/);
      // Untouched — the other session's batch is still awaiting its own ack.
      expect(
        (db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string }).status,
      ).toBe('dispatched');
    });

    it('rejects an unknown batch id (batch_not_found)', async () => {
      seedDesignSession(db, { runId: 'run-nb', sessionId: 'sess-nb', ideaId: 'ide_nb' });
      const res = await ack('run-nb', { batchId: 'fbb_ghost' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^batch_not_found:/);
    });

    it('re-runs the design-session integrity check first: a broken idea link rejects without touching the batch', async () => {
      seedDesignSession(db, { runId: 'run-brk2', sessionId: 'sess-brk2', ideaId: 'ide_brk2' });
      const { batchId } = await dispatchedBatch({
        runId: 'run-brk2',
        sessionId: 'sess-brk2',
        sourceRef: 'ide_brk2',
      });
      db.prepare("UPDATE ideas SET decomposed_at = '2026-07-28T00:00:00.000Z' WHERE id = 'ide_brk2'").run();

      const res = await ack('run-brk2', { batchId });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/^idea_link_broken:/);
      expect(
        (db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as { status: string }).status,
      ).toBe('dispatched');
    });

    it('rejects a non-design session (not_a_design_session)', async () => {
      seedSession(db, 'sess-nd2', 1, null);
      seedRun(db, 'run-nd2', 1, 'sess-nd2');
      const res = await ack('run-nd2', { batchId: 'fbb_anything' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('not_a_design_session');
    });
  });

  // -------------------------------------------------------------------------
  // Server-side source_ref stamp (handleReportArtifact) — Design Mode v0
  // -------------------------------------------------------------------------

  describe('report-artifact source_ref stamp', () => {
    async function reportIdeaSpec(runId: string): Promise<McpQueryResponse> {
      const { socket, writes } = makeSocketDouble();
      await handler.handleMessage(
        { type: 'mcp-report-artifact', requestId: 'r-1', runId, atype: 'idea-spec', label: 'spec' },
        socket,
      );
      return parseLastWrite(writes);
    }

    it('stamps source_ref = the design_idea_id AND session_id = the run session for a design session', async () => {
      seedDesignSession(db, { runId: 'run-src', sessionId: 'sess-src', ideaId: 'ide_src' });
      const res = await reportIdeaSpec('run-src');
      expect(res.ok).toBe(true);
      const { artifactId } = res.data as { artifactId: string };
      const row = artifactRow(db, artifactId)!;
      expect(row.source_ref).toBe('ide_src');
      // session_id is what the frontend DesignApproveControl render gate keys on
      // (live-smoke regression: sourceRef alone left the Approve control unreachable).
      expect(row.session_id).toBe('sess-src');
    });

    it('leaves source_ref AND session_id NULL for a non-design session (behavior unchanged)', async () => {
      seedSession(db, 'sess-plain2', 1, null);
      seedRun(db, 'run-plain2', 1, 'sess-plain2');
      const res = await reportIdeaSpec('run-plain2');
      expect(res.ok).toBe(true);
      const { artifactId } = res.data as { artifactId: string };
      const row = artifactRow(db, artifactId)!;
      expect(row.source_ref).toBeNull();
      expect(row.session_id).toBeNull();
    });

    it('leaves source_ref AND session_id NULL for a run with no session at all', async () => {
      seedRun(db, 'run-nosess2', 1, null);
      const res = await reportIdeaSpec('run-nosess2');
      expect(res.ok).toBe(true);
      const { artifactId } = res.data as { artifactId: string };
      const row = artifactRow(db, artifactId)!;
      expect(row.source_ref).toBeNull();
      expect(row.session_id).toBeNull();
    });

    it('re-report from a design session keeps source_ref + session_id pinned (enrich)', async () => {
      seedDesignSession(db, { runId: 'run-src2', sessionId: 'sess-src2', ideaId: 'ide_src2' });
      const first = await reportIdeaSpec('run-src2');
      const { artifactId } = first.data as { artifactId: string };
      // Re-report (enrich in place) — source_ref and session_id must stay pinned.
      await reportIdeaSpec('run-src2');
      const row = artifactRow(db, artifactId)!;
      expect(row.source_ref).toBe('ide_src2');
      expect(row.session_id).toBe('sess-src2');
    });
  });
});
