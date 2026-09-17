/**
 * The `approve-design` gate body composed from a run's adversarial-review
 * artifact, plus `countRunPendingFindings` — the count every human gate now ends
 * with.
 *
 * Hand-rolled minimal tables (the composePartialSprintGateBody convention): these
 * are pure reads over `artifacts` and `review_items`, pared to the columns the
 * functions actually touch.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  composeAdversarialReviewGateBody,
  countApproveDesignRevisionsUsed,
  readAdversarialReviewMarkdown,
} from '../adversarialReviewGateBody';
import { countRunPendingFindings } from '../reviewItemListing';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      atype TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE TABLE review_items (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      blocking INTEGER NOT NULL DEFAULT 0,
      audience TEXT DEFAULT 'human',
      source TEXT,
      created_at TEXT DEFAULT '2026-09-15T00:00:00.000Z'
    );
  `);
  return db;
}

function seedReview(db: Database.Database, runId: string, markdown: string | null): void {
  db.prepare('INSERT INTO artifacts (id, run_id, atype, payload_json) VALUES (?, ?, ?, ?)').run(
    `art-${runId}`,
    runId,
    'adversarial-review',
    markdown === null ? null : JSON.stringify({ markdown }),
  );
}

function seedGateResolution(db: Database.Database, runId: string, n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      `INSERT INTO review_items (id, run_id, kind, status, blocking, source)
       VALUES (?, ?, 'decision', 'resolved', 1, 'gate:human-step:approve-design')`,
    ).run(`gate-${runId}-${i}`, runId);
  }
}

function seedFinding(
  db: Database.Database,
  runId: string,
  opts: { id: string; status?: string; source?: string | null; audience?: string | null; kind?: string } = {
    id: 'f',
  },
): void {
  db.prepare(
    `INSERT INTO review_items (id, run_id, kind, status, blocking, audience, source)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    opts.id,
    runId,
    opts.kind ?? 'finding',
    opts.status ?? 'pending',
    opts.audience === undefined ? 'human' : opts.audience,
    opts.source === undefined ? 'agent:code-review' : opts.source,
  );
}

const REVIEW_DOC = `## Result

### Blocking

#### AR-1 — The spend flow has no error state
**Severity:** blocker   **Area:** prototype
**What:** Every screen assumes the payment succeeds.

#### AR-2 — Criteria never mention reachability
**Severity:** major   **Area:** criteria

### Findings

#### AR-3 — An unused queue in the architecture
**Severity:** minor   **Area:** architecture
`;

describe('readAdversarialReviewMarkdown', () => {
  it('reads the artifact payload markdown', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC);
    expect(readAdversarialReviewMarkdown(dbAdapter(db), 'run-1')).toBe(REVIEW_DOC);
  });

  it('is undefined for a run with no artifact, a null payload, or a payload with no markdown', () => {
    const db = buildDb();
    seedReview(db, 'run-null', null);
    db.prepare('INSERT INTO artifacts (id, run_id, atype, payload_json) VALUES (?, ?, ?, ?)').run(
      'art-empty',
      'run-empty',
      'adversarial-review',
      JSON.stringify({ markdown: '   ' }),
    );
    const adapter = dbAdapter(db);
    expect(readAdversarialReviewMarkdown(adapter, 'run-missing')).toBeUndefined();
    expect(readAdversarialReviewMarkdown(adapter, 'run-null')).toBeUndefined();
    expect(readAdversarialReviewMarkdown(adapter, 'run-empty')).toBeUndefined();
  });

  it('does not read some OTHER atype of the same run', () => {
    const db = buildDb();
    db.prepare('INSERT INTO artifacts (id, run_id, atype, payload_json) VALUES (?, ?, ?, ?)').run(
      'art-brief',
      'run-1',
      'project-brief',
      JSON.stringify({ markdown: '# Brief' }),
    );
    expect(readAdversarialReviewMarkdown(dbAdapter(db), 'run-1')).toBeUndefined();
  });
});

describe('composeAdversarialReviewGateBody', () => {
  it('returns null when the run has no adversarial-review artifact (the step self-skipped)', () => {
    const db = buildDb();
    expect(composeAdversarialReviewGateBody(dbAdapter(db), 'run-1')).toBeNull();
  });

  it('states the counts, lists every blocking entry, and explains BOTH choices', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC);

    const body = composeAdversarialReviewGateBody(dbAdapter(db), 'run-1');
    expect(body).not.toBeNull();
    expect(body).toContain('2 blocking defects');
    expect(body).toContain('1 advisory finding');
    expect(body).toContain('**AR-1** — The spend flow has no error state');
    expect(body).toContain('**AR-2** — Criteria never mention reachability');
    // The advisory entry is COUNTED but not listed — the blocking ones are the
    // decision, the rest are in the tab.
    expect(body).not.toContain('AR-3');
    expect(body).toContain('**Revise**');
    expect(body).toContain('**Approve**');
    expect(body).toContain('accepted-risk finding');
  });

  it('still composes a body — and says so — when the reviewer raised nothing', () => {
    const db = buildDb();
    seedReview(db, 'run-1', '## Result\n\n### Blocking\n\nNone.\n\n### Findings\n\nNone.\n');

    const body = composeAdversarialReviewGateBody(dbAdapter(db), 'run-1');
    expect(body).toContain('raised nothing');
    expect(body).toContain('**Approve**');
  });

  it('omits the revision budget on a first visit, then counts up', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC);
    expect(composeAdversarialReviewGateBody(dbAdapter(db), 'run-1')).not.toContain('Revision budget');

    seedGateResolution(db, 'run-1', 2);
    expect(composeAdversarialReviewGateBody(dbAdapter(db), 'run-1')).toContain(
      '**Revision budget: 2 of 5 used.**',
    );
  });

  it('warns at the LAST revision that a further Revise ends the run as rejected', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC);
    seedGateResolution(db, 'run-1', 4);
    const penultimate = composeAdversarialReviewGateBody(dbAdapter(db), 'run-1');
    expect(penultimate).toContain('One revision remains');

    db.prepare(
      `INSERT INTO review_items (id, run_id, kind, status, blocking, source)
       VALUES ('gate-run-1-extra', 'run-1', 'decision', 'resolved', 1, 'gate:human-step:approve-design')`,
    ).run(); // now 5 of 5
    const last = composeAdversarialReviewGateBody(dbAdapter(db), 'run-1');
    expect(last).toContain('this is the last one');
    expect(last).toContain('`rejected`');
    expect(last).toContain('swept when the session is archived');
  });
});

describe('countApproveDesignRevisionsUsed', () => {
  it('counts only RESOLVED approve-design gates of THIS run', () => {
    const db = buildDb();
    seedGateResolution(db, 'run-1', 3);
    seedGateResolution(db, 'run-2', 1);
    // A still-pending gate of the same run does not count (it is the one being opened).
    db.prepare(
      `INSERT INTO review_items (id, run_id, kind, status, blocking, source)
       VALUES ('pending-1', 'run-1', 'decision', 'pending', 1, 'gate:human-step:approve-design')`,
    ).run();
    // A DIFFERENT gate of the same run does not count.
    db.prepare(
      `INSERT INTO review_items (id, run_id, kind, status, blocking, source)
       VALUES ('other-1', 'run-1', 'decision', 'resolved', 1, 'gate:human-step:approve-plan')`,
    ).run();

    expect(countApproveDesignRevisionsUsed(dbAdapter(db), 'run-1')).toBe(3);
    expect(countApproveDesignRevisionsUsed(dbAdapter(db), 'run-2')).toBe(1);
    expect(countApproveDesignRevisionsUsed(dbAdapter(db), 'run-none')).toBe(0);
  });
});

describe('countRunPendingFindings', () => {
  it('counts pending, human-audience, agent-sourced findings of THIS run', () => {
    const db = buildDb();
    seedFinding(db, 'run-1', { id: 'f1' });
    seedFinding(db, 'run-1', { id: 'f2', source: 'agent:adversarial-review' });
    seedFinding(db, 'run-2', { id: 'f3' });
    expect(countRunPendingFindings(dbAdapter(db), 'run-1')).toBe(2);
    expect(countRunPendingFindings(dbAdapter(db), 'run-2')).toBe(1);
    expect(countRunPendingFindings(dbAdapter(db), 'run-none')).toBe(0);
  });

  it('excludes resolved, machine-audience, non-agent-sourced, and non-finding rows', () => {
    const db = buildDb();
    seedFinding(db, 'run-1', { id: 'keep' });
    seedFinding(db, 'run-1', { id: 'resolved', status: 'resolved' });
    seedFinding(db, 'run-1', { id: 'machine', audience: 'machine' });
    seedFinding(db, 'run-1', { id: 'systemic', source: 'gate:systemic-pause' });
    seedFinding(db, 'run-1', { id: 'nosource', source: null });
    seedFinding(db, 'run-1', { id: 'decision', kind: 'decision' });
    expect(countRunPendingFindings(dbAdapter(db), 'run-1')).toBe(1);
  });

  it('returns 0 rather than throwing when there is no review_items table', () => {
    const bare = new Database(':memory:');
    expect(countRunPendingFindings(dbAdapter(bare), 'run-1')).toBe(0);
  });
});
