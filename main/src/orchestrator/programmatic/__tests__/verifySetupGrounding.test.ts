/**
 * The verify-setup flow's programmatic grounding readers.
 *
 * Both exist because of one live defect (2026-08-27): a verify-setup run on the
 * programmatic plane reached `prove` — the step that must WRITE the runbook the
 * human approved — with no way to see the proposal, because each programmatic
 * step is a fresh agent turn and no MCP tool reads an artifact. The prove agent
 * filed three gate questions asking a human to paste the proposal back.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  readRunbookProposalMarkdown,
  readApproveRunbookResolution,
} from '../defaultProgrammaticRunner';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function artifactsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT, atype TEXT, label TEXT, payload_json TEXT)`,
  );
  return db;
}

function reviewDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    `CREATE TABLE review_items (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, source TEXT, status TEXT, resolution TEXT)`,
  );
  return db;
}

describe('readRunbookProposalMarkdown', () => {
  const insert = (db: Database.Database, id: string, runId: string, atype: string, md: string | null) =>
    db
      .prepare('INSERT INTO artifacts (id, run_id, atype, label, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(id, runId, atype, 'Runbook proposal', md === null ? null : JSON.stringify({ markdown: md }));

  it('reads the verify-runbook artifact markdown', () => {
    const db = artifactsDb();
    insert(db, 'a1', 'run-1', 'verify-runbook', '## Runbook\n\ncdp-app: ...');
    expect(readRunbookProposalMarkdown(dbAdapter(db), 'run-1')).toBe('## Runbook\n\ncdp-app: ...');
  });

  it('falls back to the legacy compound-recommendations atype', () => {
    // `derive` declared the wrong atype until this fix, so a run already in
    // flight (or one that gets rewound) carries its proposal under the old type.
    // Stranding those would leave exactly the runs that hit the bug unable to
    // recover from it.
    const db = artifactsDb();
    insert(db, 'a1', 'run-legacy', 'compound-recommendations', '## Act on\n\nlegacy shape');
    expect(readRunbookProposalMarkdown(dbAdapter(db), 'run-legacy')).toBe('## Act on\n\nlegacy shape');
  });

  it('prefers the correct atype when a run somehow carries both', () => {
    const db = artifactsDb();
    insert(db, 'a1', 'run-both', 'compound-recommendations', 'legacy');
    insert(db, 'a2', 'run-both', 'verify-runbook', 'current');
    expect(readRunbookProposalMarkdown(dbAdapter(db), 'run-both')).toBe('current');
  });

  it('is fail-soft on every degenerate shape', () => {
    const db = artifactsDb();
    insert(db, 'a1', 'run-null', 'verify-runbook', null);
    db.prepare('INSERT INTO artifacts (id, run_id, atype, label, payload_json) VALUES (?,?,?,?,?)').run(
      'a2',
      'run-bad',
      'verify-runbook',
      'x',
      'not json',
    );
    db.prepare('INSERT INTO artifacts (id, run_id, atype, label, payload_json) VALUES (?,?,?,?,?)').run(
      'a3',
      'run-blank',
      'verify-runbook',
      'x',
      JSON.stringify({ markdown: '   ' }),
    );
    expect(readRunbookProposalMarkdown(dbAdapter(db), 'run-null')).toBeUndefined();
    expect(readRunbookProposalMarkdown(dbAdapter(db), 'run-bad')).toBeUndefined();
    expect(readRunbookProposalMarkdown(dbAdapter(db), 'run-blank')).toBeUndefined();
    expect(readRunbookProposalMarkdown(dbAdapter(db), 'run-absent')).toBeUndefined();
    // No artifacts table at all (a pre-migration DB) degrades to undefined.
    expect(readRunbookProposalMarkdown(dbAdapter(new Database(':memory:')), 'run-1')).toBeUndefined();
  });
});

describe('readApproveRunbookResolution', () => {
  const insert = (db: Database.Database, id: string, runId: string, status: string, res: string | null) =>
    db
      .prepare(
        `INSERT INTO review_items (id, run_id, kind, source, status, resolution)
         VALUES (?, ?, 'decision', 'gate:human-step:approve-runbook', ?, ?)`,
      )
      .run(id, runId, status, res);

  it('returns the raw resolution of the resolved gate', () => {
    const db = reviewDb();
    insert(db, 'r1', 'run-1', 'resolved', 'approve, but skip native-screen');
    expect(readApproveRunbookResolution(dbAdapter(db), 'run-1')).toBe('approve, but skip native-screen');
  });

  it('ignores a pending gate, a foreign gate, and a blank resolution', () => {
    const db = reviewDb();
    insert(db, 'r1', 'run-pending', 'pending', null);
    insert(db, 'r2', 'run-blank', 'resolved', '  ');
    db.prepare(
      `INSERT INTO review_items (id, run_id, kind, source, status, resolution)
       VALUES ('r3', 'run-other', 'decision', 'gate:human-step:approve-ideas', 'resolved', 'approve')`,
    ).run();
    expect(readApproveRunbookResolution(dbAdapter(db), 'run-pending')).toBeUndefined();
    expect(readApproveRunbookResolution(dbAdapter(db), 'run-blank')).toBeUndefined();
    expect(readApproveRunbookResolution(dbAdapter(db), 'run-other')).toBeUndefined();
    expect(readApproveRunbookResolution(dbAdapter(new Database(':memory:')), 'run-1')).toBeUndefined();
  });

  it('returns only the NOTE when the row carries the verdict prefix', () => {
    // A row written by composeGateResolution: the verdict is structural and
    // carries no trimming signal, so only the qualification is handed to `prove`.
    // A bare verdict therefore has nothing to hand over at all.
    const db = reviewDb();
    insert(db, 'r1', 'run-note', 'resolved', 'approve: only web');
    insert(db, 'r2', 'run-bare', 'resolved', 'approve');
    insert(db, 'r3', 'run-mod', 'resolved', 'approve[no-findings]');
    expect(readApproveRunbookResolution(dbAdapter(db), 'run-note')).toBe('only web');
    expect(readApproveRunbookResolution(dbAdapter(db), 'run-bare')).toBeUndefined();
    expect(readApproveRunbookResolution(dbAdapter(db), 'run-mod')).toBeUndefined();
  });
});
