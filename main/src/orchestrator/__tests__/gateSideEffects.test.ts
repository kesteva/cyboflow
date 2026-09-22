/**
 * GateSideEffects — what a human's "approve" at a design/brief gate actually
 * writes.
 *
 * Driven against a REAL temp DB carrying the full migration chain, with the real
 * TaskChangeRouter / ReviewItemRouter / IdeaComponentRouter chokepoints, because
 * every assertion here is about durable state landing through them.
 *
 * Coverage (one per dispatch arm, plus the properties the whole module rests on):
 *   (1) launch + approve-ideas + approve → binds ONLY the approved ideas.
 *   (2) planner + approve-design + approve → binds every RUN-OWNED idea, including
 *       a prompt-started run whose idea has no seed columns at all.
 *   (3) launch + approve-brief + approve → stamps the project's thoroughness.
 *   (4) approve-design + approve → files one accepted-risk finding per entry.
 *   (5) idempotent re-entry: applying twice binds once and files each entry once.
 *   (6) a non-approve verdict, a non-design flow, and an unknown gate all no-op.
 *   (7) fail-soft: a throwing collaborator never propagates.
 *   (8) reconcileAtSettle re-runs the durable writes and files NO findings.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../database/database';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { TaskChangeRouter } from '../taskChangeRouter';
import { ArtifactRouter } from '../artifactRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { IdeaComponentRouter } from '../ideaComponents/ideaComponentRouter';
import type { DatabaseLike, LoggerLike } from '../types';
import {
  GateSideEffects,
  gateDecisionFromResolution,
  ADVERSARIAL_FINDING_SOURCE,
  type GateSideEffectsDeps,
} from '../gateSideEffects';
import { getCurrentApprovedDesign } from '../design/approvedDesigns';
import { readSolutionThoroughness } from '../projectSettings';
import { serializeIdeaVerdictMap } from '../../../../shared/types/reviews';

const PROTO_HTML = '<!doctype html><html><body><h1>concept</h1></body></html>';

const REVIEW_DOC = `## Result

### Blocking

#### AR-1 — No error state in the spend flow
**Severity:** blocker   **Area:** prototype
**What:** Every screen assumes success.
**Why it matters:** The first failure is a dead end.
**Fix:** Add a failure screen.

### Findings

#### AR-2 — Copy drifts between screens
**Severity:** advisory   **Area:** prototype
`;

const BRIEF = ['# Project brief', '', 'THOROUGHNESS: production', 'UI_PROTOTYPE: yes'].join('\n');

interface Harness {
  svc: DatabaseService;
  db: DatabaseLike;
  projectId: number;
  dir: string;
  snapDir: string;
}

let active: Harness | null = null;

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cyboflow-gatefx-'));
  const snapDir = mkdtempSync(join(tmpdir(), 'cyboflow-gatefx-snap-'));
  const svc = new DatabaseService(join(dir, 'test.db'));
  svc.setMigrationsDirForTesting(join(__dirname, '..', '..', 'database', 'migrations'));
  svc.initialize();
  const db = dbAdapter(svc.getDb());
  const project = svc.createProject('Gate FX', join(dir, 'proj'));

  TaskChangeRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  IdeaComponentRouter._resetForTesting();
  GateSideEffects._resetForTesting();
  TaskChangeRouter.initialize(db);
  ReviewItemRouter.initialize(db);
  IdeaComponentRouter.initialize(db);

  active = { svc, db, projectId: project.id, dir, snapDir };
  return active;
}

afterEach(() => {
  TaskChangeRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  IdeaComponentRouter._resetForTesting();
  GateSideEffects._resetForTesting();
  if (active) {
    active.svc.close();
    rmSync(active.dir, { recursive: true, force: true });
    rmSync(active.snapDir, { recursive: true, force: true });
    active = null;
  }
});

function seedRun(h: Harness, runId: string, workflowName: string, seedIdeaId?: string): void {
  h.db
    .prepare("INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, ?, '{}')")
    .run(`wf-${workflowName}`, h.projectId, workflowName);
  h.db
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id)
       VALUES (?, ?, ?, 'running', 'default', ?)`,
    )
    .run(runId, `wf-${workflowName}`, h.projectId, seedIdeaId ?? null);
}

async function makeIdea(h: Harness, title: string): Promise<{ id: string; ref: string }> {
  const created = await TaskChangeRouter.getInstance().applyChange(h.projectId, {
    actor: 'user',
    entityType: 'idea',
    title,
  });
  const row = h.db.prepare('SELECT ref FROM ideas WHERE id = ?').get(created.taskId) as { ref: string };
  return { id: created.taskId, ref: row.ref };
}

/** Mark an idea as created BY the run, so listRunOwnedIdeaIds finds it with no seed columns. */
function attributeIdeaToRun(h: Harness, ideaId: string, runId: string): void {
  const seq = h.db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM entity_events WHERE entity_type = 'idea' AND entity_id = ?")
    .get(ideaId) as { next: number };
  h.db
    .prepare(
      `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
       VALUES ('idea', ?, ?, 'created', 'agent', ?)`,
    )
    .run(ideaId, seq.next, runId);
}

function seedArtifact(
  h: Harness,
  runId: string,
  atype: string,
  payload: unknown,
  reportedAt: string | null = null,
): void {
  h.db
    .prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, payload_json, reported_at)
       VALUES (?, ?, ?, ?, 'template', 1, ?, ?)`,
    )
    .run(`art-${runId}-${atype}`, runId, atype, atype, JSON.stringify(payload), reportedAt);
}

/**
 * A RESOLVED programmatic approve-design gate row, seeded directly — the shape
 * `HumanStepManager.openHumanGate` mints and `ReviewItemRouter.runTriage` then
 * merges its resolution meta into. `payload` is written verbatim so a test can
 * stage a row with, without, or with a malformed `reviewReportedSince`.
 */
function seedGateItem(h: Harness, id: string, runId: string, payload: unknown): void {
  const now = new Date().toISOString();
  h.db
    .prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, kind, status, blocking, audience, title, body, source, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, 'decision', 'resolved', 1, 'human', 'Human gate: Approve design', 'body',
               'gate:human-step:approve-design', ?, ?, ?)`,
    )
    .run(id, h.projectId, runId, payload === undefined ? null : JSON.stringify(payload), now, now);
}

function seedPrototype(h: Harness, runId: string): void {
  h.db
    .prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, revision, payload_json)
       VALUES (?, ?, 'ui-prototype', 'Prototype', 'canvas', 1, ?)`,
    )
    .run(`art-proto-${runId}`, runId, JSON.stringify({ fileName: 'prototype/index.html' }));
}

function makeDeps(h: Harness, overrides: Partial<GateSideEffectsDeps> = {}): GateSideEffectsDeps {
  return {
    db: h.db,
    snapshotBaseDir: h.snapDir,
    loadPrototypeHtml: async () => PROTO_HTML,
    ideaComponentRouter: IdeaComponentRouter.getInstance(),
    reviewItemRouter: ReviewItemRouter.getInstance(),
    ...overrides,
  };
}

function adversarialFindings(h: Harness, runId: string): Array<{ title: string; severity: string }> {
  return h.db
    .prepare('SELECT title, severity FROM review_items WHERE run_id = ? AND source = ? ORDER BY title')
    .all(runId, ADVERSARIAL_FINDING_SOURCE) as Array<{ title: string; severity: string }>;
}

describe('gateDecisionFromResolution', () => {
  it('mirrors parseGateVerdict, and a verdict map carrying denials still reads as approve', () => {
    expect(gateDecisionFromResolution('approved')).toBe('approve');
    expect(gateDecisionFromResolution(null)).toBe('approve');
    expect(gateDecisionFromResolution('please revise the spend flow')).toBe('revise');
    expect(gateDecisionFromResolution('retry')).toBe('revise');
    expect(gateDecisionFromResolution('reject')).toBe('reject');
    // The prefixes deliberately spell a declined entry 'deny', never 'reject'.
    expect(gateDecisionFromResolution(serializeIdeaVerdictMap({ 'IDEA-001': 'deny' }))).toBe('approve');
  });

  it('reads a NULL/empty note as approve — a dismissal is told apart by the opener flag, not the string', () => {
    // Load-bearing and easy to "harden" wrongly. ReviewQueueHumanGate settles a
    // DISMISSED gate with resolution null, and a note-less RESOLVE with null too;
    // only the opener's `dismissed` flag separates them (see the onGateResolved
    // wiring in main/src/index.ts). Reading null as a rejection here would stop
    // binding designs on the most common approve path — the queue card's Approve
    // button records no note at all.
    expect(gateDecisionFromResolution(null)).toBe('approve');
    expect(gateDecisionFromResolution('')).toBe('approve');
    expect(gateDecisionFromResolution('   ')).toBe('approve');
    expect(gateDecisionFromResolution(undefined)).toBe('approve');
  });

  it('reads the anchored verdict prefix without sniffing the note', () => {
    // Same contract (and same bug) as parseGateVerdict: the note after the colon
    // is the human's words, never a verdict source. 'rejects' in it must NOT end
    // the run.
    expect(gateDecisionFromResolution('revise: the architecture rejects empty input')).toBe('revise');
    expect(gateDecisionFromResolution('approve[no-findings]')).toBe('approve');
    expect(gateDecisionFromResolution('reject: retry later if you must')).toBe('reject');
    expect(gateDecisionFromResolution('REVISE')).toBe('revise');
    // Legacy rows keep the sniff.
    expect(gateDecisionFromResolution('please revise this')).toBe('revise');
  });
});

describe('GateSideEffects.apply — launch + approve-ideas', () => {
  it('(1) binds a design for the APPROVED ideas only', async () => {
    const h = setup();
    const approved = await makeIdea(h, 'Approved idea');
    const denied = await makeIdea(h, 'Denied idea');
    seedRun(h, 'run-l', 'launch');
    attributeIdeaToRun(h, approved.id, 'run-l');
    attributeIdeaToRun(h, denied.id, 'run-l');
    seedPrototype(h, 'run-l');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-l',
      stepId: 'approve-ideas',
      decision: 'approve',
      resolution: serializeIdeaVerdictMap({ [approved.ref]: 'approve', [denied.ref]: 'deny' }),
    });

    const bound = getCurrentApprovedDesign(h.db, approved.id);
    expect(bound?.source).toBe('flow');
    expect(bound?.sourceRunId).toBe('run-l');
    expect(existsSync(bound!.snapshotPath)).toBe(true);
    // The denied idea stays on the backlog untouched — binding it would assert a
    // decision the human declined to make.
    expect(getCurrentApprovedDesign(h.db, denied.id)).toBeNull();
  });

  it('a PLANNER run ignores approve-ideas (it is launch-only)', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-ideas',
      decision: 'approve',
      resolution: serializeIdeaVerdictMap({ [idea.ref]: 'approve' }),
    });
    expect(getCurrentApprovedDesign(h.db, idea.id)).toBeNull();
  });
});

describe('GateSideEffects.apply — planner/ship + approve-design', () => {
  it('(2) binds every RUN-OWNED idea, including a prompt-started run with no seed columns', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Run-created idea');
    // seed_idea_id IS NULL — the idea exists only because the run's context step
    // created it. Binding by seed columns would bind nothing here, silently.
    seedRun(h, 'run-p', 'planner');
    attributeIdeaToRun(h, idea.id, 'run-p');
    seedPrototype(h, 'run-p');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
      resolution: 'approved',
    });

    expect(getCurrentApprovedDesign(h.db, idea.id)?.sourceRunId).toBe('run-p');
  });

  it('a SHIP run binds the same way', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Ship idea');
    seedRun(h, 'run-s', 'ship', idea.id);
    seedPrototype(h, 'run-s');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-s',
      stepId: 'approve-designs',
      decision: 'approve',
    });
    expect(getCurrentApprovedDesign(h.db, idea.id)?.source).toBe('flow');
  });
});

describe('GateSideEffects.apply — launch + approve-brief', () => {
  it('(3) parses the brief flag and stamps the project', async () => {
    const h = setup();
    seedRun(h, 'run-l', 'launch');
    seedArtifact(h, 'run-l', 'project-brief', { markdown: BRIEF });
    const notified: number[] = [];
    GateSideEffects.initialize(makeDeps(h, { emitProjectUpdated: (id) => notified.push(id) }));

    await GateSideEffects.getInstance().apply({
      runId: 'run-l',
      stepId: 'approve-brief',
      decision: 'approve',
    });

    expect(readSolutionThoroughness(h.db, h.projectId)).toBe('production');
    expect(notified).toEqual([h.projectId]);
  });

  it('stamps nothing when the brief carries no THOROUGHNESS flag', async () => {
    const h = setup();
    seedRun(h, 'run-l', 'launch');
    seedArtifact(h, 'run-l', 'project-brief', { markdown: '# Project brief\n\nUI_PROTOTYPE: yes' });
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-l',
      stepId: 'approve-brief',
      decision: 'approve',
    });
    expect(readSolutionThoroughness(h.db, h.projectId)).toBeNull();
  });
});

describe('GateSideEffects.apply — accepted-risk findings', () => {
  it('(4) files one non-blocking finding per adversarial entry, severity-mapped', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    seedArtifact(h, 'run-p', 'adversarial-review', { markdown: REVIEW_DOC });
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
    });

    const filed = adversarialFindings(h, 'run-p');
    expect(filed).toEqual([
      { title: 'AR-1 — No error state in the spend flow', severity: 'error' },
      { title: 'AR-2 — Copy drifts between screens', severity: 'info' },
    ]);
    const row = h.db
      .prepare('SELECT blocking, kind, body, payload_json AS payloadJson FROM review_items WHERE title LIKE ?')
      .get('AR-1%') as { blocking: number; kind: string; body: string; payloadJson: string };
    expect(row.blocking).toBe(0);
    expect(row.kind).toBe('finding');
    expect(row.body).toContain('Accepted at the approve-design gate');
    expect(row.body).toContain('Add a failure screen');
    expect(JSON.parse(row.payloadJson)).toMatchObject({
      kind: 'finding',
      category: 'design-review',
      proposedTarget: 'backlog',
    });
  });

  it('a plain approve files the findings; approve[no-findings] binds but files none', async () => {
    // The approve-design gate's THIRD choice ("Continue without logging"). The
    // design is still approved — the bind must happen — but the human explicitly
    // said not to carry the surviving entries, so nothing is filed.
    const plain = setup();
    const plainIdea = await makeIdea(plain, 'Idea');
    seedRun(plain, 'run-a', 'planner', plainIdea.id);
    seedPrototype(plain, 'run-a');
    seedArtifact(plain, 'run-a', 'adversarial-review', { markdown: REVIEW_DOC });
    GateSideEffects.initialize(makeDeps(plain));
    await GateSideEffects.getInstance().apply({
      runId: 'run-a',
      stepId: 'approve-design',
      decision: 'approve',
      resolution: 'approve',
    });
    expect(adversarialFindings(plain, 'run-a')).toHaveLength(2);

    const quiet = setup();
    const quietIdea = await makeIdea(quiet, 'Idea');
    seedRun(quiet, 'run-b', 'planner', quietIdea.id);
    seedPrototype(quiet, 'run-b');
    seedArtifact(quiet, 'run-b', 'adversarial-review', { markdown: REVIEW_DOC });
    GateSideEffects.initialize(makeDeps(quiet));
    await GateSideEffects.getInstance().apply({
      runId: 'run-b',
      stepId: 'approve-design',
      decision: 'approve',
      resolution: 'approve[no-findings]: dropping the nits',
    });

    expect(adversarialFindings(quiet, 'run-b')).toEqual([]);
    // ...and the design IS bound — this is an approve, not a rejection.
    expect(
      (quiet.db.prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ?').get(quietIdea.id) as {
        n: number;
      }).n,
    ).toBe(1);
  });

  it('files nothing when the run has no adversarial-review artifact', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
    });
    expect(adversarialFindings(h, 'run-p')).toEqual([]);
  });
});

/**
 * The FRESHNESS bound the gate row was minted with, re-applied at resolve time.
 *
 * The adversarial-review artifact is ONE row per run and survives a rewind or a
 * Revise loopback. Approving a gate opened over a design that was never
 * re-reviewed used to file the PREVIOUS round's entries as risks the human
 * weighed — about a design revised precisely to address them.
 */
describe('GateSideEffects.apply — accepted-risk filing freshness bound', () => {
  const STALE = '2026-09-20T10:00:00.000Z';
  const FRESH = '2026-09-20T12:00:00.000Z';
  const BOUND_ISO = '2026-09-20T11:00:00.000Z';

  /** Run + idea + prototype + a critique artifact reported at `reportedAt`. */
  async function stage(
    h: Harness,
    runId: string,
    reportedAt: string | null,
  ): Promise<{ id: string; ref: string }> {
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, runId, 'planner', idea.id);
    seedPrototype(h, runId);
    seedArtifact(h, runId, 'adversarial-review', { markdown: REVIEW_DOC }, reportedAt);
    return idea;
  }

  function boundDesigns(h: Harness, ideaId: string): number {
    return (
      h.db.prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ?').get(ideaId) as {
        n: number;
      }
    ).n;
  }

  function makeLogger(): { logger: LoggerLike; info: Array<{ msg: string; ctx?: Record<string, unknown> }> } {
    const info: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    return {
      info,
      logger: {
        info: (msg, ctx) => {
          info.push({ msg, ...(ctx ? { ctx } : {}) });
        },
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    };
  }

  it('(a) files NOTHING and logs WHY when the artifact predates the gate row\'s bound — but still binds', async () => {
    const h = setup();
    const idea = await stage(h, 'run-p', STALE);
    seedGateItem(h, 'rvw_gate', 'run-p', {
      kind: 'decision',
      gate: 'approve-design',
      reviewReportedSince: BOUND_ISO,
    });
    const { logger, info } = makeLogger();
    GateSideEffects.initialize(makeDeps(h, { logger }));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
      reviewItemId: 'rvw_gate',
    });

    expect(adversarialFindings(h, 'run-p')).toEqual([]);
    // The approval itself still lands — only the previous round's entries are.
    expect(boundDesigns(h, idea.id)).toBe(1);
    const skip = info.find((l) => l.msg.includes('accepted-risk filing skipped'));
    expect(skip).toBeDefined();
    expect(skip?.ctx).toMatchObject({
      runId: 'run-p',
      reviewItemId: 'rvw_gate',
      reportedAt: STALE,
      bound: BOUND_ISO,
    });
  });

  it('(b) files as before when the artifact was reported AFTER the bound', async () => {
    const h = setup();
    await stage(h, 'run-p', FRESH);
    seedGateItem(h, 'rvw_gate', 'run-p', {
      kind: 'decision',
      gate: 'approve-design',
      reviewReportedSince: BOUND_ISO,
    });
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
      reviewItemId: 'rvw_gate',
    });

    expect(adversarialFindings(h, 'run-p')).toEqual([
      { title: 'AR-1 — No error state in the spend flow', severity: 'error' },
      { title: 'AR-2 — Copy drifts between screens', severity: 'info' },
    ]);
  });

  it('(c) files with NO reviewItemId at all — the orchestrated plane stays unbounded', async () => {
    const h = setup();
    await stage(h, 'run-p', STALE);
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
    });

    expect(adversarialFindings(h, 'run-p')).toHaveLength(2);
  });

  it('(d) files when the gate row carries no reviewReportedSince (a legacy / unbounded gate)', async () => {
    const h = setup();
    await stage(h, 'run-p', STALE);
    seedGateItem(h, 'rvw_plain', 'run-p', { kind: 'decision', gate: 'approve-design' });
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
      reviewItemId: 'rvw_plain',
    });

    expect(adversarialFindings(h, 'run-p')).toHaveLength(2);
  });

  it('(e) files when the artifact has a NULL reported_at — unknown age is no constraint', async () => {
    const h = setup();
    await stage(h, 'run-p', null);
    seedGateItem(h, 'rvw_gate', 'run-p', {
      kind: 'decision',
      gate: 'approve-design',
      reviewReportedSince: BOUND_ISO,
    });
    const { logger, info } = makeLogger();
    GateSideEffects.initialize(makeDeps(h, { logger }));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
      reviewItemId: 'rvw_gate',
    });

    expect(adversarialFindings(h, 'run-p')).toHaveLength(2);
    expect(info.some((l) => l.msg.includes('accepted-risk filing skipped'))).toBe(false);
  });

  it('a run with NO artifact under a bound stays the SILENT return it has always been', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    seedGateItem(h, 'rvw_gate', 'run-p', {
      kind: 'decision',
      gate: 'approve-design',
      reviewReportedSince: BOUND_ISO,
    });
    const { logger, info } = makeLogger();
    GateSideEffects.initialize(makeDeps(h, { logger }));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
      reviewItemId: 'rvw_gate',
    });

    expect(adversarialFindings(h, 'run-p')).toEqual([]);
    expect(info.some((l) => l.msg.includes('accepted-risk filing skipped'))).toBe(false);
  });

  it('an unparseable reviewReportedSince degrades to NO constraint', async () => {
    const h = setup();
    await stage(h, 'run-p', STALE);
    seedGateItem(h, 'rvw_bad', 'run-p', {
      kind: 'decision',
      gate: 'approve-design',
      reviewReportedSince: 'not-a-date',
    });
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'approve',
      reviewItemId: 'rvw_bad',
    });

    expect(adversarialFindings(h, 'run-p')).toHaveLength(2);
  });
});

describe('GateSideEffects.apply — idempotence and no-ops', () => {
  it('(5) applying TWICE binds once and files each entry once', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    seedArtifact(h, 'run-p', 'adversarial-review', { markdown: REVIEW_DOC });
    GateSideEffects.initialize(makeDeps(h));

    const args = { runId: 'run-p', stepId: 'approve-design', decision: 'approve' as const };
    await GateSideEffects.getInstance().apply(args);
    await GateSideEffects.getInstance().apply(args);

    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ?').get(idea.id) as {
        n: number;
      }).n,
    ).toBe(1);
    expect(adversarialFindings(h, 'run-p')).toHaveLength(2);
  });

  it('a DISMISSED gate binds nothing and files nothing (it arrives as decision reject)', async () => {
    // The wiring in index.ts maps the opener's `dismissed` flag to 'reject'
    // BEFORE calling apply, so from here a dismissal is simply a rejection. This
    // pins the consequence: no design bound, no accepted-risk findings filed for
    // a gate the human declined.
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    seedArtifact(h, 'run-p', 'adversarial-review', { markdown: REVIEW_DOC });
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: 'reject',
      resolution: null,
    });

    expect(getCurrentApprovedDesign(h.db, idea.id)).toBeNull();
    expect(adversarialFindings(h, 'run-p')).toEqual([]);
  });

  it('a note-less APPROVE still binds (the other side of the null-resolution coin)', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-p',
      stepId: 'approve-design',
      decision: gateDecisionFromResolution(null),
      resolution: null,
    });

    expect(getCurrentApprovedDesign(h.db, idea.id)?.sourceRunId).toBe('run-p');
  });

  it('(6) does nothing for a revise/reject verdict, a non-design flow, or an unknown gate', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedRun(h, 'run-sprint', 'sprint', idea.id);
    seedPrototype(h, 'run-p');
    seedPrototype(h, 'run-sprint');
    GateSideEffects.initialize(makeDeps(h));
    const fx = GateSideEffects.getInstance();

    await fx.apply({ runId: 'run-p', stepId: 'approve-design', decision: 'revise' });
    await fx.apply({ runId: 'run-p', stepId: 'approve-design', decision: 'reject' });
    await fx.apply({ runId: 'run-p', stepId: 'approve-design', decision: 'abort' });
    await fx.apply({ runId: 'run-p', stepId: 'approve-plan', decision: 'approve' });
    await fx.apply({ runId: 'run-sprint', stepId: 'approve-design', decision: 'approve' });
    await fx.apply({ runId: 'run-missing', stepId: 'approve-design', decision: 'approve' });

    expect(getCurrentApprovedDesign(h.db, idea.id)).toBeNull();
  });

  it('(7) is fail-soft: a throwing collaborator never propagates', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-p', 'planner', idea.id);
    seedPrototype(h, 'run-p');
    seedArtifact(h, 'run-p', 'adversarial-review', { markdown: REVIEW_DOC });
    GateSideEffects.initialize(
      makeDeps(h, {
        loadPrototypeHtml: () => Promise.reject(new Error('disk gone')),
        reviewItemRouter: { applyReviewItem: () => Promise.reject(new Error('router down')) },
      }),
    );

    await expect(
      GateSideEffects.getInstance().apply({
        runId: 'run-p',
        stepId: 'approve-design',
        decision: 'approve',
      }),
    ).resolves.toBeUndefined();
    expect(getCurrentApprovedDesign(h.db, idea.id)).toBeNull();
  });
});

describe('GateSideEffects.reconcileAtSettle', () => {
  it('(8) re-runs the durable writes and files NO findings', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-l', 'launch', idea.id);
    seedPrototype(h, 'run-l');
    seedArtifact(h, 'run-l', 'project-brief', { markdown: BRIEF });
    seedArtifact(h, 'run-l', 'adversarial-review', { markdown: REVIEW_DOC });
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().reconcileAtSettle('run-l');

    expect(getCurrentApprovedDesign(h.db, idea.id)?.sourceRunId).toBe('run-l');
    expect(readSolutionThoroughness(h.db, h.projectId)).toBe('production');
    // A settle is a machine noticing the run ended, not a human accepting a risk.
    expect(adversarialFindings(h, 'run-l')).toEqual([]);
  });

  it('converges with a gate that already fired — one bound row, one stamp', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-l', 'launch', idea.id);
    attributeIdeaToRun(h, idea.id, 'run-l');
    seedPrototype(h, 'run-l');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().apply({
      runId: 'run-l',
      stepId: 'approve-ideas',
      decision: 'approve',
      resolution: serializeIdeaVerdictMap({ [idea.ref]: 'approve' }),
    });
    await GateSideEffects.getInstance().reconcileAtSettle('run-l');

    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ?').get(idea.id) as {
        n: number;
      }).n,
    ).toBe(1);
  });

  it('never binds a design the human sent back — a resolved reject/revise gate is not converged on', async () => {
    for (const resolution of ['reject', 'revise']) {
      const h = setup();
      const idea = await makeIdea(h, 'Idea');
      const runId = `run-${resolution}`;
      seedRun(h, runId, 'launch', idea.id);
      seedPrototype(h, runId);
      seedArtifact(h, runId, 'project-brief', { markdown: BRIEF });
      h.db
        .prepare(
          `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title, source, resolution)
           VALUES (?, ?, ?, 'decision', 'resolved', 1, 'Human gate: Approve design', 'gate:human-step:approve-design', ?)`,
        )
        .run(`rvw-${resolution}`, h.projectId, runId, resolution);
      GateSideEffects.initialize(makeDeps(h));

      await GateSideEffects.getInstance().reconcileAtSettle(runId);

      expect(getCurrentApprovedDesign(h.db, idea.id)).toBeNull();
      // The brief gate was never minted here, so the stamp still converges.
      expect(readSolutionThoroughness(h.db, h.projectId)).toBe('production');
    }
  });

  it('still converges when the design gate resolved approve', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-ok', 'launch', idea.id);
    seedPrototype(h, 'run-ok');
    h.db
      .prepare(
        `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title, source, resolution)
         VALUES ('rvw-ok', ?, 'run-ok', 'decision', 'resolved', 1, 'Human gate: Approve design', 'gate:human-step:approve-design', 'approve')`,
      )
      .run(h.projectId);
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().reconcileAtSettle('run-ok');
    expect(getCurrentApprovedDesign(h.db, idea.id)?.sourceRunId).toBe('run-ok');
  });

  it('ignores a non-design flow', async () => {
    const h = setup();
    const idea = await makeIdea(h, 'Idea');
    seedRun(h, 'run-sprint', 'sprint', idea.id);
    seedPrototype(h, 'run-sprint');
    GateSideEffects.initialize(makeDeps(h));

    await GateSideEffects.getInstance().reconcileAtSettle('run-sprint');
    expect(getCurrentApprovedDesign(h.db, idea.id)).toBeNull();
  });
});

describe('GateSideEffects singleton accessors', () => {
  it('tryGetInstance is null before boot wires it; getInstance throws', () => {
    GateSideEffects._resetForTesting();
    expect(GateSideEffects.tryGetInstance()).toBeNull();
    expect(() => GateSideEffects.getInstance()).toThrow(/has not been initialized/i);
  });
});
