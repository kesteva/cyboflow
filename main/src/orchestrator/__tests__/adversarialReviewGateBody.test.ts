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
  readAdversarialReviewReportedAtMs,
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
      payload_json TEXT,
      reported_at TEXT
    );
    CREATE TABLE review_items (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      blocking INTEGER NOT NULL DEFAULT 0,
      audience TEXT DEFAULT 'human',
      source TEXT,
      resolution TEXT,
      created_at TEXT DEFAULT '2026-09-15T00:00:00.000Z'
    );
  `);
  return db;
}

function seedReview(
  db: Database.Database,
  runId: string,
  markdown: string | null,
  reportedAt: string | null = null,
): void {
  db.prepare(
    'INSERT INTO artifacts (id, run_id, atype, payload_json, reported_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    `art-${runId}`,
    runId,
    'adversarial-review',
    markdown === null ? null : JSON.stringify({ markdown }),
    reportedAt,
  );
}

/**
 * A PRE-143 fixture: an `artifacts` table with no `reported_at` column at all.
 * Both readers must fail-soft to "age unknown" there — the freshness bound can
 * only ever make an artifact read as absent, so a DB that has not been migrated
 * must keep today's behaviour instead of losing its critique.
 */
function buildLegacyDb(): Database.Database {
  const db = new Database(':memory:');
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
    'run-1',
    'adversarial-review',
    JSON.stringify({ markdown: REVIEW_DOC }),
  );
  return db;
}

/**
 * One resolved `approve-design` gate row per entry of `resolutions` — the strings
 * are what the human's answer actually stored, which is the thing the count reads.
 */
function seedGateResolution(
  db: Database.Database,
  runId: string,
  resolutions: readonly (string | null)[],
): void {
  resolutions.forEach((resolution, i) => {
    db.prepare(
      `INSERT INTO review_items (id, run_id, kind, status, blocking, source, resolution)
       VALUES (?, ?, 'decision', 'resolved', 1, 'gate:human-step:approve-design', ?)`,
    ).run(`gate-${runId}-${i}`, runId, resolution);
  });
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

describe('readAdversarialReviewReportedAtMs', () => {
  it('parses a zoned ISO value to its epoch ms', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC, '2026-09-21T10:00:00.000Z');
    expect(readAdversarialReviewReportedAtMs(dbAdapter(db), 'run-1')).toBe(
      Date.parse('2026-09-21T10:00:00.000Z'),
    );
  });

  it('parses the UNZONED SQLite shape as UTC, not local', () => {
    // The repo's recurring timestamp trap: `new Date('2026-09-21 10:00:00')`
    // reads LOCAL, which on a UTC-7 host puts the row 7 hours in the future and
    // would make a fresh critique read as stale (or vice versa).
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC, '2026-09-21 10:00:00');
    expect(readAdversarialReviewReportedAtMs(dbAdapter(db), 'run-1')).toBe(
      Date.parse('2026-09-21T10:00:00.000Z'),
    );
  });

  it('is null for a NULL column value, no row, and a table without the column', () => {
    const db = buildDb();
    seedReview(db, 'run-null', REVIEW_DOC, null);
    const adapter = dbAdapter(db);
    expect(readAdversarialReviewReportedAtMs(adapter, 'run-null')).toBeNull();
    expect(readAdversarialReviewReportedAtMs(adapter, 'run-missing')).toBeNull();
    // pre-143 DB: the SELECT itself throws, and that must read as "unknown".
    expect(readAdversarialReviewReportedAtMs(dbAdapter(buildLegacyDb()), 'run-1')).toBeNull();
  });

  it('is null for an unparseable value', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC, 'not a timestamp');
    expect(readAdversarialReviewReportedAtMs(dbAdapter(db), 'run-1')).toBeNull();
  });
});

describe('readAdversarialReviewMarkdown freshness bound', () => {
  const BOUND = Date.parse('2026-09-21T10:00:00.000Z');

  it('reads as ABSENT when the artifact was reported BEFORE the bound', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC, '2026-09-21T09:59:59.999Z');
    expect(readAdversarialReviewMarkdown(dbAdapter(db), 'run-1', { reportedSinceMs: BOUND })).toBeUndefined();
  });

  it('reads the markdown when reported AT the bound, and when reported after it', () => {
    const at = buildDb();
    seedReview(at, 'run-1', REVIEW_DOC, '2026-09-21T10:00:00.000Z');
    expect(readAdversarialReviewMarkdown(dbAdapter(at), 'run-1', { reportedSinceMs: BOUND })).toBe(REVIEW_DOC);

    const after = buildDb();
    seedReview(after, 'run-1', REVIEW_DOC, '2026-09-21T10:00:00.001Z');
    expect(readAdversarialReviewMarkdown(dbAdapter(after), 'run-1', { reportedSinceMs: BOUND })).toBe(REVIEW_DOC);
  });

  it('applies NO constraint when the age is unknown (NULL column, or no column at all)', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC, null);
    expect(readAdversarialReviewMarkdown(dbAdapter(db), 'run-1', { reportedSinceMs: BOUND })).toBe(REVIEW_DOC);
    expect(
      readAdversarialReviewMarkdown(dbAdapter(buildLegacyDb()), 'run-1', { reportedSinceMs: BOUND }),
    ).toBe(REVIEW_DOC);
  });

  it('applies NO constraint with no opts — the unbounded read is unchanged', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC, '2000-01-01T00:00:00.000Z');
    expect(readAdversarialReviewMarkdown(dbAdapter(db), 'run-1')).toBe(REVIEW_DOC);
    expect(readAdversarialReviewMarkdown(dbAdapter(db), 'run-1', {})).toBe(REVIEW_DOC);
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

  it('omits the revision count on a first visit, then counts up', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC);
    expect(composeAdversarialReviewGateBody(dbAdapter(db), 'run-1')).not.toContain(
      'Revisions so far',
    );

    seedGateResolution(db, 'run-1', ['revise', 'revise: drop AR-11']);
    expect(composeAdversarialReviewGateBody(dbAdapter(db), 'run-1')).toContain(
      '**Revisions so far this run: 2.**',
    );
  });

  it('never claims a deadline — the enforced bound is the controller\'s, not this count', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC);
    seedGateResolution(db, 'run-1', ['revise', 'revise', 'revise', 'revise', 'revise']);

    const body = composeAdversarialReviewGateBody(dbAdapter(db), 'run-1');
    expect(body).toContain('**Revisions so far this run: 5.**');
    expect(body).not.toContain('this is the last one');
    expect(body).not.toContain('One revision remains');
    expect(body).not.toContain('of 5 used');
    expect(body).not.toContain('swept when the session is archived');
  });

  it('says nothing about convergence on a FIRST review (there is no ledger to read)', () => {
    const db = buildDb();
    seedReview(db, 'run-1', REVIEW_DOC);
    expect(composeAdversarialReviewGateBody(dbAdapter(db), 'run-1')).not.toContain('Convergence');
  });

  it('reports convergence from the ledger: prior blockers resolved, regressions, NEW blockers, set aside', () => {
    const db = buildDb();
    // Prior round: AR-1 + AR-2 blocking, AR-3 minor, AR-4 advisory.
    // This round: AR-2 still blocking (carried forward), AR-9 is brand new.
    seedReview(
      db,
      'run-1',
      [
        '## Blocking',
        '',
        '#### AR-2 — Criteria never mention reachability',
        '**Severity:** major',
        '',
        '#### AR-9 — The new failure screen has no retry',
        '**Severity:** blocker',
        '',
        '## Findings',
        '',
        'None.',
        '',
        '## Prior entries',
        '',
        '- AR-1 (blocker) — resolved — the failure screen is in the prototype now',
        '- AR-2 (major) — unresolved — the criterion is unchanged',
        '- AR-3 (minor) — resolved-with-regression (see AR-9) — the retry went missing with the queue',
        '- AR-4 (advisory) — set-aside — steering excluded it',
      ].join('\n'),
    );

    const body = composeAdversarialReviewGateBody(dbAdapter(db), 'run-1');
    // b counts prior blocker|major only (2), a the resolved ones among them (1);
    // AR-9 is the only current blocker absent from the ledger.
    expect(body).toContain('**Convergence:** 1 of 2 prior blockers resolved, 1 regression, 1 new blocker, 1 set aside.');
    // The still-open entries are listed, not dropped. Plain text only: this body is
    // rendered as a React text child, so raw HTML would reach the human as tags.
    expect(body).toContain('**Unresolved or regressed:**');
    expect(body).not.toContain('<details>');
    expect(body).not.toContain('<summary>');
    expect(body).toContain('- AR-2 — unresolved — the criterion is unchanged');
    expect(body).toContain('- AR-3 — resolved-with-regression — the retry went missing with the queue');
    expect(body).not.toContain('- AR-1 — resolved');
  });

  it('reports a fully converged round with no open-entry list', () => {
    const db = buildDb();
    seedReview(
      db,
      'run-1',
      [
        '## Blocking',
        '',
        'None.',
        '',
        '## Findings',
        '',
        'None.',
        '',
        '## Prior entries',
        '',
        '- AR-1 (blocker) — resolved — fixed',
        '- AR-2 (advisory) — withdrawn — no longer stand behind it',
      ].join('\n'),
    );

    const body = composeAdversarialReviewGateBody(dbAdapter(db), 'run-1');
    expect(body).toContain('**Convergence:** 1 of 1 prior blocker resolved, 0 regressions, 0 new blockers, 0 set aside.');
    expect(body).not.toContain('**Unresolved or regressed:**');
  });
});

describe('countApproveDesignRevisionsUsed', () => {
  it('counts only RESOLVED approve-design gates of THIS run', () => {
    const db = buildDb();
    seedGateResolution(db, 'run-1', ['revise', 'revise', 'revise']);
    seedGateResolution(db, 'run-2', ['revise']);
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

  it('does NOT count a reject — the run ended rejected and was rewound, not revised', () => {
    const db = buildDb();
    seedGateResolution(db, 'run-1', ['reject', 'reject: the architecture is wrong', 'revise']);
    expect(countApproveDesignRevisionsUsed(dbAdapter(db), 'run-1')).toBe(1);
  });

  it('does NOT count an approve, including a null/empty resolution', () => {
    const db = buildDb();
    seedGateResolution(db, 'run-1', ['approve', 'approve[no-findings]', null, '']);
    expect(countApproveDesignRevisionsUsed(dbAdapter(db), 'run-1')).toBe(0);
  });

  it('counts a prefixed revise WITH a note, and reads the prefix rather than sniffing the note', () => {
    const db = buildDb();
    // The note contains 'reject'; the anchored prefix is what decides.
    seedGateResolution(db, 'run-1', ['revise: the architecture rejects empty input']);
    expect(countApproveDesignRevisionsUsed(dbAdapter(db), 'run-1')).toBe(1);
  });

  it('counts a LEGACY free-text revise the grammar does not recognize', () => {
    const db = buildDb();
    seedGateResolution(db, 'run-1', ['please revise this', 'approved', 'retry the design']);
    expect(countApproveDesignRevisionsUsed(dbAdapter(db), 'run-1')).toBe(2);
  });

  it('returns 0 rather than throwing when there is no review_items table', () => {
    const bare = new Database(':memory:');
    expect(countApproveDesignRevisionsUsed(dbAdapter(bare), 'run-1')).toBe(0);
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
