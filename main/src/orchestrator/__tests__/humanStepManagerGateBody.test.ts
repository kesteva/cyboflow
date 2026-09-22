/**
 * The BODY a human gate opens with — HumanStepManager.openHumanGate's
 * composeGateBody seam.
 *
 * Two behaviours, and the interaction between them:
 *   - EVERY gate now ends with "N finding(s) filed by this run still await
 *     triage" when the run has pending findings, so the human closing a run out
 *     is told what is waiting instead of discovering it in the queue afterwards.
 *   - the `approve-design` gate LEADS with the run's adversarial review: counts,
 *     blocking titles, the revisions taken so far, and what each button does.
 *
 * Driven through the real `openHumanGate` (not the composer directly) so the
 * fail-soft claim is tested where it matters: the composition runs INSIDE the
 * gate-open transaction, and a throw there would mean a run that cannot pause for
 * its human at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { HumanStepManager } from '../humanStepManager';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { buildReviewInboxDb, seedInboxRun } from '../__test_fixtures__/reviewInboxTestDb';

afterEach(() => {
  HumanStepManager._resetForTesting();
});

/**
 * The inbox fixture's migration subset predates `artifacts`, which is exactly the
 * "table absent" arm composeAdversarialReviewGateBody must survive. Tests that
 * want a critique add the table themselves, pared to the columns the read touches.
 */
function addArtifactsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      atype TEXT NOT NULL,
      payload_json TEXT,
      reported_at TEXT
    );
  `);
}

function seedReviewArtifact(
  db: Database.Database,
  runId: string,
  markdown: string,
  reportedAt: string | null = null,
): void {
  db.prepare(
    'INSERT INTO artifacts (id, run_id, atype, payload_json, reported_at) VALUES (?, ?, ?, ?, ?)',
  ).run(`art-${runId}`, runId, 'adversarial-review', JSON.stringify({ markdown }), reportedAt);
}

function gatePayload(db: Database.Database, reviewItemId: string): string | null {
  return (
    db.prepare('SELECT payload_json FROM review_items WHERE id = ?').get(reviewItemId) as {
      payload_json: string | null;
    }
  ).payload_json;
}

function seedPendingFinding(db: Database.Database, runId: string, id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, kind, status, blocking, audience, title, source, created_at, updated_at)
     VALUES (?, 1, ?, 'finding', 'pending', 0, 'human', ?, 'agent:code-review', ?, ?)`,
  ).run(id, runId, `finding ${id}`, now, now);
}

function gateBody(db: Database.Database, reviewItemId: string): string {
  return (db.prepare('SELECT body FROM review_items WHERE id = ?').get(reviewItemId) as { body: string })
    .body;
}

const REVIEW_DOC = `## Result

### Blocking

#### AR-1 — No error state anywhere in the spend flow
**Severity:** blocker   **Area:** prototype

### Findings

#### AR-2 — Copy drifts between two screens
**Severity:** advisory   **Area:** prototype
`;

describe('openHumanGate — pending-findings count', () => {
  it('appends the count for ANY gate when the run has pending findings', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-f', 'running');
    seedPendingFinding(db, 'run-f', 'rvw_f1');
    seedPendingFinding(db, 'run-f', 'rvw_f2');

    const id = await mgr.openHumanGate('run-f', 'human-review', 'Human review');
    expect(id).not.toBeNull();
    const body = gateBody(db, id!);
    expect(body).toContain('**Pending findings:** 2 findings filed by this run still await triage.');
    // The generic lead is still there — the count is a TAIL, not a replacement.
    expect(body).toContain("Workflow step 'human-review' requires a human decision");
  });

  it('uses the singular for one finding', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-f', 'running');
    seedPendingFinding(db, 'run-f', 'rvw_f1');

    const id = await mgr.openHumanGate('run-f', 'approve-plan', 'Plan review');
    expect(gateBody(db, id!)).toContain('**Pending findings:** 1 finding filed by this run');
  });

  it('omits the line entirely when the run has no pending findings', async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-f', 'running');

    const id = await mgr.openHumanGate('run-f', 'approve-plan', 'Plan review');
    expect(gateBody(db, id!)).not.toContain('Pending findings');
  });

  it("does not count ANOTHER run's findings", async () => {
    const db = buildReviewInboxDb();
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-a', 'running');
    seedInboxRun(db, 'run-b', 'running');
    seedPendingFinding(db, 'run-b', 'rvw_b1');

    const id = await mgr.openHumanGate('run-a', 'approve-plan', 'Plan review');
    expect(gateBody(db, id!)).not.toContain('Pending findings');
  });
});

describe('openHumanGate — approve-design body', () => {
  it('leads with the adversarial review and still carries the pending count', async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');
    seedReviewArtifact(db, 'run-d', REVIEW_DOC);
    seedPendingFinding(db, 'run-d', 'rvw_d1');

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design');
    const body = gateBody(db, id!);

    expect(body).toContain('1 blocking defect');
    expect(body).toContain('**AR-1** — No error state anywhere in the spend flow');
    expect(body).toContain('**Revise**');
    expect(body).toContain('**Approve**');
    expect(body).toContain('**Pending findings:** 1 finding filed by this run');
    // The generic fallback is REPLACED, not appended to.
    expect(body).not.toContain("requires a human decision before the run can advance");
  });

  it('falls back to the generic body when the run has no critique (the step self-skipped)', async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design');
    expect(gateBody(db, id!)).toContain("Workflow step 'approve-design' requires a human decision");
  });

  it('opens cleanly when the artifacts table does not exist at all (fail-soft)', async () => {
    const db = buildReviewInboxDb(); // no artifacts table
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design');
    expect(id).not.toBeNull();
    expect(gateBody(db, id!)).toContain("Workflow step 'approve-design' requires a human decision");
  });

  it('leaves a NON-design gate of the same run on the generic body', async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');
    seedReviewArtifact(db, 'run-d', REVIEW_DOC);

    const id = await mgr.openHumanGate('run-d', 'approve-plan', 'Plan review');
    const body = gateBody(db, id!);
    expect(body).toContain("Workflow step 'approve-plan' requires a human decision");
    expect(body).not.toContain('AR-1');
  });
});

/**
 * The walk's adversarial-review FRESHNESS bound, carried into openHumanGate.
 *
 * The critique artifact is ONE row per run, so a walk that never re-reviewed
 * (a crashed/self-skipped review step after a Revise, or a rewind landing past
 * it) still finds the PREVIOUS round's critique sitting there. The gate must not
 * present it as this round's, and it must persist the bound so the resolve-time
 * accepted-risk filing applies the identical constraint.
 */
describe('openHumanGate — approve-design freshness bound', () => {
  const STALE = '2026-09-20T10:00:00.000Z';
  const FRESH = '2026-09-20T12:00:00.000Z';
  const BOUND_ISO = '2026-09-20T11:00:00.000Z';
  const BOUND = Date.parse(BOUND_ISO);

  it('shows the "no review this round" notice for a PREVIOUS round\'s critique', async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');
    seedReviewArtifact(db, 'run-d', REVIEW_DOC, STALE);

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design', undefined, {
      reviewReportedSinceMs: BOUND,
    });
    const body = gateBody(db, id!);

    expect(body).toContain('**No adversarial review this round.**');
    expect(body).toContain('Approve files no accepted-risk findings from it.');
    expect(body).not.toContain('The adversarial reviewer raised');
    // (the Revise line's own prose mentions "a blocking defect", so the counts
    // are excluded by their exact shape, not by the bare phrase)
    expect(body).not.toContain('1 blocking defect');
    expect(body).not.toContain('**Blocking:**');
    expect(body).not.toContain('AR-1');
    // The choices survive — only the critique summary is withheld.
    expect(body).toContain('**Your two choices:**');
  });

  it("composes THIS round's counts when the artifact was reported after the bound", async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');
    seedReviewArtifact(db, 'run-d', REVIEW_DOC, FRESH);

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design', undefined, {
      reviewReportedSinceMs: BOUND,
    });
    const body = gateBody(db, id!);

    expect(body).toContain('1 blocking defect');
    expect(body).toContain('**AR-1** — No error state anywhere in the spend flow');
    expect(body).not.toContain('No adversarial review this round');
  });

  it('stamps the bound on the gate row as an ISO-8601 reviewReportedSince', async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');
    seedReviewArtifact(db, 'run-d', REVIEW_DOC, FRESH);

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design', undefined, {
      reviewReportedSinceMs: BOUND,
    });

    expect(JSON.parse(gatePayload(db, id!)!)).toEqual({
      kind: 'decision',
      gate: 'approve-design',
      reviewReportedSince: BOUND_ISO,
    });
  });

  it('leaves the approve-design payload NULL when no bound was given', async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');
    seedReviewArtifact(db, 'run-d', REVIEW_DOC, FRESH);

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design');
    expect(gatePayload(db, id!)).toBeNull();
  });

  it('does not stamp — or bound — a NON-design gate handed the same opts', async () => {
    const db = buildReviewInboxDb();
    addArtifactsTable(db);
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');
    seedReviewArtifact(db, 'run-d', REVIEW_DOC, STALE);

    const id = await mgr.openHumanGate('run-d', 'approve-plan', 'Plan review', undefined, {
      reviewReportedSinceMs: BOUND,
    });
    expect(gatePayload(db, id!)).toBeNull();
    expect(gateBody(db, id!)).toContain("Workflow step 'approve-plan' requires a human decision");
    expect(gateBody(db, id!)).not.toContain('No adversarial review this round');
  });

  it('treats a pre-143 artifacts table (no reported_at) as unknown age — no constraint', async () => {
    const db = buildReviewInboxDb();
    db.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        atype TEXT NOT NULL,
        payload_json TEXT
      );
    `);
    db.prepare('INSERT INTO artifacts (id, run_id, atype, payload_json) VALUES (?, ?, ?, ?)').run(
      'art-legacy',
      'run-d',
      'adversarial-review',
      JSON.stringify({ markdown: REVIEW_DOC }),
    );
    const mgr = HumanStepManager.initialize(dbAdapter(db));
    seedInboxRun(db, 'run-d', 'running');

    const id = await mgr.openHumanGate('run-d', 'approve-design', 'Approve design', undefined, {
      reviewReportedSinceMs: BOUND,
    });
    const body = gateBody(db, id!);

    expect(body).toContain('1 blocking defect');
    expect(body).not.toContain('No adversarial review this round');
  });
});
