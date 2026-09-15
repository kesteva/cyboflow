/**
 * Unit tests for flowDesignBinding — a FLOW run's prototype bound to its ideas as
 * a durable `approved_designs` row (migration 134, `source='flow'`).
 *
 * Driven against a REAL temp DB carrying the full migration chain via
 * DatabaseService.initialize(), so ideas/artifacts/approved_designs/idea_components
 * behave exactly as in production. Ideas are created through the TaskChangeRouter
 * chokepoint (real version + stage + created event).
 *
 * Coverage:
 *   (a) binds every named idea: a current flow row per idea, the snapshot file on
 *       disk, and the interactive prototype preferred over the static one.
 *   (b) idempotent re-entry: the same run at the same prototype revision skips
 *       ('already-bound') and writes nothing; a NEWER revision rebinds and
 *       supersedes.
 *   (c) Design Mode precedence: an idea whose CURRENT row is design-mode is
 *       SKIPPED, never superseded.
 *   (d) no prototype artifact on the run ⇒ every idea skipped, nothing written,
 *       and NO ledger stamp.
 *   (e) supersede chain: rebinding leaves exactly ONE current row and retains the
 *       prior as history.
 *   (f) the NARROW ledger stamp: only an idea whose own body carries a
 *       '## Design spec' section is stamped `prototype: complete`; a bound idea
 *       without one is left to derivation.
 *   (g) fail-soft: an unknown idea, a cross-project idea, and a throwing ledger
 *       router never abort the batch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../../database/database';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { TaskChangeRouter } from '../../taskChangeRouter';
import { ArtifactRouter } from '../../artifactRouter';
import { ReviewItemRouter } from '../../reviewItemRouter';
import { IdeaComponentRouter } from '../../ideaComponents/ideaComponentRouter';
import type { DatabaseLike } from '../../types';
import { bindApprovedDesignsForRun, type FlowDesignBindingDeps } from '../flowDesignBinding';
import { getCurrentApprovedDesign, listApprovedDesignHistory } from '../approvedDesigns';

const RUN = 'run-flow';
const OTHER_RUN = 'run-other';
const PROTO_HTML = '<!doctype html><html><body><h1>concept</h1></body></html>';
const CLOCK = '2026-09-15T12:00:00.000Z';

interface Harness {
  svc: DatabaseService;
  db: DatabaseLike;
  projectId: number;
  dir: string;
  snapDir: string;
}

let active: Harness | null = null;

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'cyboflow-flowbind-'));
  const snapDir = mkdtempSync(join(tmpdir(), 'cyboflow-flowbind-snap-'));
  const svc = new DatabaseService(join(dir, 'test.db'));
  svc.setMigrationsDirForTesting(join(__dirname, '..', '..', '..', 'database', 'migrations'));
  svc.initialize();
  const db = dbAdapter(svc.getDb());
  const project = svc.createProject('Flow Bind Test', join(dir, 'proj'));

  TaskChangeRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  IdeaComponentRouter._resetForTesting();
  TaskChangeRouter.initialize(db);

  db.prepare(
    "INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', ?, 'launch', '{}')",
  ).run(project.id);
  for (const runId of [RUN, OTHER_RUN]) {
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES (?, 'wf-1', ?, 'running', 'default')`,
    ).run(runId, project.id);
  }

  active = { svc, db, projectId: project.id, dir, snapDir };
  return active;
}

afterEach(() => {
  TaskChangeRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  IdeaComponentRouter._resetForTesting();
  if (active) {
    active.svc.close();
    rmSync(active.dir, { recursive: true, force: true });
    rmSync(active.snapDir, { recursive: true, force: true });
    active = null;
  }
});

async function makeIdea(h: Harness, title: string, body?: string): Promise<string> {
  const created = await TaskChangeRouter.getInstance().applyChange(h.projectId, {
    actor: 'user',
    entityType: 'idea',
    title,
  });
  if (body !== undefined) {
    h.db.prepare('UPDATE ideas SET body = ? WHERE id = ?').run(body, created.taskId);
  }
  return created.taskId;
}

function insertPrototype(
  h: Harness,
  opts: { id: string; runId?: string; atype?: string; revision?: number; payload?: boolean },
): void {
  h.db
    .prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, payload_json)
       VALUES (?, ?, ?, 'Prototype', 'canvas', ?, ?)`,
    )
    .run(
      opts.id,
      opts.runId ?? RUN,
      opts.atype ?? 'ui-prototype',
      opts.revision ?? 1,
      opts.payload === false ? null : JSON.stringify({ fileName: 'prototype/index.html' }),
    );
}

function insertDesignModeRow(h: Harness, ideaId: string): void {
  h.db
    .prepare(
      `INSERT INTO approved_designs
         (id, idea_id, project_id, handoff_id, session_id, draft_revision,
          prototype_artifact_id, prototype_revision, snapshot_path, approved_at, superseded_at)
       VALUES (?, ?, ?, 'hnd-1', 'sess-1', 1, 'art-dm', 1, '/snap/dm.html', ?, NULL)`,
    )
    .run(`apd_dm_${ideaId}`, ideaId, h.projectId, CLOCK);
}

function makeDeps(h: Harness, overrides: Partial<FlowDesignBindingDeps> = {}): FlowDesignBindingDeps {
  return {
    db: h.db,
    snapshotBaseDir: h.snapDir,
    loadPrototypeHtml: async () => PROTO_HTML,
    now: () => CLOCK,
    ...overrides,
  };
}

describe('bindApprovedDesignsForRun', () => {
  it('(a) binds every named idea, writes the snapshot, and prefers the interactive prototype', async () => {
    const h = await setup();
    const a = await makeIdea(h, 'Idea A');
    const b = await makeIdea(h, 'Idea B');
    insertPrototype(h, { id: 'art-static', atype: 'ui-prototype', revision: 2 });
    insertPrototype(h, { id: 'art-interactive', atype: 'interactive-prototype', revision: 1 });

    const res = await bindApprovedDesignsForRun(makeDeps(h), {
      runId: RUN,
      projectId: h.projectId,
      ideaIds: [a, b],
    });

    expect(res.bound.sort()).toEqual([a, b].sort());
    expect(res.skipped).toEqual([]);

    for (const ideaId of [a, b]) {
      const current = getCurrentApprovedDesign(h.db, ideaId);
      expect(current).not.toBeNull();
      expect(current?.source).toBe('flow');
      expect(current?.sourceRunId).toBe(RUN);
      expect(current?.handoffId).toBeNull();
      expect(current?.sessionId).toBeNull();
      // Interactive wins over static even at a LOWER revision (the tier rule).
      expect(current?.prototypeArtifactId).toBe('art-interactive');
      expect(current?.prototypeRevision).toBe(1);
      expect(current?.snapshotPath).toBe(join(h.snapDir, ideaId, `flow-${RUN}.html`));
      expect(existsSync(current!.snapshotPath)).toBe(true);
      expect(readFileSync(current!.snapshotPath, 'utf-8')).toBe(PROTO_HTML);
    }
  });

  it('(b) is idempotent on re-entry, and rebinds on a NEWER prototype revision', async () => {
    const h = await setup();
    const a = await makeIdea(h, 'Idea A');
    insertPrototype(h, { id: 'art-1', revision: 1 });

    const first = await bindApprovedDesignsForRun(makeDeps(h), {
      runId: RUN,
      projectId: h.projectId,
      ideaIds: [a],
    });
    expect(first.bound).toEqual([a]);
    const firstRowId = getCurrentApprovedDesign(h.db, a)?.id;

    // Same run, same revision → skipped, nothing written.
    const second = await bindApprovedDesignsForRun(makeDeps(h), {
      runId: RUN,
      projectId: h.projectId,
      ideaIds: [a],
    });
    expect(second.bound).toEqual([]);
    expect(second.skipped).toEqual([{ ideaId: a, reason: 'already-bound' }]);
    expect(getCurrentApprovedDesign(h.db, a)?.id).toBe(firstRowId);
    expect(listApprovedDesignHistory(h.db, a)).toHaveLength(1);

    // The prototype advances → a genuine re-approval of different bytes.
    h.db.prepare('UPDATE artifacts SET revision = 2 WHERE id = ?').run('art-1');
    const third = await bindApprovedDesignsForRun(makeDeps(h), {
      runId: RUN,
      projectId: h.projectId,
      ideaIds: [a],
    });
    expect(third.bound).toEqual([a]);
    expect(getCurrentApprovedDesign(h.db, a)?.prototypeRevision).toBe(2);
  });

  it('(c) skips an idea whose CURRENT approved design came from Design Mode', async () => {
    const h = await setup();
    const a = await makeIdea(h, 'Hand-designed idea');
    insertDesignModeRow(h, a);
    insertPrototype(h, { id: 'art-1' });

    const res = await bindApprovedDesignsForRun(makeDeps(h), {
      runId: RUN,
      projectId: h.projectId,
      ideaIds: [a],
    });

    expect(res.bound).toEqual([]);
    expect(res.skipped).toEqual([{ ideaId: a, reason: 'design-mode-current' }]);
    // Untouched: still the design-mode row, still the only one.
    const current = getCurrentApprovedDesign(h.db, a);
    expect(current?.source).toBe('design-mode');
    expect(current?.snapshotPath).toBe('/snap/dm.html');
    expect(listApprovedDesignHistory(h.db, a)).toHaveLength(1);
  });

  it('(d) with NO prototype artifact on the run: every idea skipped, nothing written, no ledger stamp', async () => {
    const h = await setup();
    const a = await makeIdea(h, 'Idea A', 'Body.\n\n## Design spec\n\nScreens.');
    // The prototype belongs to a DIFFERENT run.
    insertPrototype(h, { id: 'art-other', runId: OTHER_RUN });
    IdeaComponentRouter.initialize(h.db);
    const stamped: string[] = [];

    const res = await bindApprovedDesignsForRun(
      makeDeps(h, {
        ideaComponentRouter: {
          applyChange: async (...args) => {
            stamped.push(String(args[0]));
            throw new Error('should not be called');
          },
        },
      }),
      { runId: RUN, projectId: h.projectId, ideaIds: [a] },
    );

    expect(res.bound).toEqual([]);
    expect(res.skipped).toEqual([{ ideaId: a, reason: 'no-prototype-artifact' }]);
    expect(getCurrentApprovedDesign(h.db, a)).toBeNull();
    expect(stamped).toEqual([]);
  });

  it('(e) rebinding leaves exactly ONE current row and retains the prior as history', async () => {
    const h = await setup();
    const a = await makeIdea(h, 'Idea A');
    insertPrototype(h, { id: 'art-1', revision: 1 });
    await bindApprovedDesignsForRun(makeDeps(h), { runId: RUN, projectId: h.projectId, ideaIds: [a] });

    // A LATER run re-binds the same idea.
    insertPrototype(h, { id: 'art-2', runId: OTHER_RUN, revision: 1 });
    const res = await bindApprovedDesignsForRun(makeDeps(h), {
      runId: OTHER_RUN,
      projectId: h.projectId,
      ideaIds: [a],
    });
    expect(res.bound).toEqual([a]);

    const history = listApprovedDesignHistory(h.db, a);
    expect(history).toHaveLength(2);
    expect(history.filter((r) => r.supersededAt === null)).toHaveLength(1);
    expect(history[0].sourceRunId).toBe(OTHER_RUN);
    expect(history[1].supersededAt).not.toBeNull();
  });

  it("(f) stamps the prototype ledger component ONLY for an idea carrying its own '## Design spec'", async () => {
    const h = await setup();
    const designed = await makeIdea(h, 'Designed', 'Intro.\n\n## Design spec\n\n### Home\n\nThe list.');
    const undesigned = await makeIdea(h, 'Undesigned', 'Intro only.');
    insertPrototype(h, { id: 'art-1' });
    IdeaComponentRouter.initialize(h.db);

    const res = await bindApprovedDesignsForRun(
      makeDeps(h, { ideaComponentRouter: IdeaComponentRouter.getInstance() }),
      { runId: RUN, projectId: h.projectId, ideaIds: [designed, undesigned] },
    );
    expect(res.bound.sort()).toEqual([designed, undesigned].sort());

    const ledgerRows = h.db
      .prepare("SELECT idea_id AS ideaId, state FROM idea_components WHERE component = 'prototype'")
      .all() as Array<{ ideaId: string; state: string }>;
    expect(ledgerRows).toEqual([{ ideaId: designed, state: 'complete' }]);
  });

  it('(g) fail-soft: unknown / cross-project ideas and a throwing ledger router never abort the batch', async () => {
    const h = await setup();
    const ok = await makeIdea(h, 'Fine', 'Body.\n\n## Design spec\n\nScreens.');
    insertPrototype(h, { id: 'art-1' });
    // A second project whose idea must NOT be bound by this run.
    const other = h.svc.createProject('Other', join(h.dir, 'other'));
    const foreign = await TaskChangeRouter.getInstance().applyChange(other.id, {
      actor: 'user',
      entityType: 'idea',
      title: 'Foreign',
    });

    const res = await bindApprovedDesignsForRun(
      makeDeps(h, {
        ideaComponentRouter: {
          applyChange: () => Promise.reject(new Error('ledger down')),
        },
      }),
      { runId: RUN, projectId: h.projectId, ideaIds: [ok, 'ide_missing', foreign.taskId] },
    );

    expect(res.bound).toEqual([ok]);
    expect(res.skipped.map((s) => s.reason).sort()).toEqual(['unknown-idea', 'unknown-idea']);
    // The approval committed despite the ledger stamp throwing.
    expect(getCurrentApprovedDesign(h.db, ok)?.source).toBe('flow');
  });
});
