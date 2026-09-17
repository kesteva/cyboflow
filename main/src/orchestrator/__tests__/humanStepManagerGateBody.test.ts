/**
 * The BODY a human gate opens with — HumanStepManager.openHumanGate's
 * composeGateBody seam.
 *
 * Two behaviours, and the interaction between them:
 *   - EVERY gate now ends with "N finding(s) filed by this run still await
 *     triage" when the run has pending findings, so the human closing a run out
 *     is told what is waiting instead of discovering it in the queue afterwards.
 *   - the `approve-design` gate LEADS with the run's adversarial review: counts,
 *     blocking titles, the remaining revision budget, and what each button does.
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
      payload_json TEXT
    );
  `);
}

function seedReviewArtifact(db: Database.Database, runId: string, markdown: string): void {
  db.prepare('INSERT INTO artifacts (id, run_id, atype, payload_json) VALUES (?, ?, ?, ?)').run(
    `art-${runId}`,
    runId,
    'adversarial-review',
    JSON.stringify({ markdown }),
  );
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
