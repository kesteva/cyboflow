/**
 * VerifyRunbookStore — the §A5 "learn from success" store contract
 * (docs/proposals/runbook-optional-verification.md §A5), against the REAL
 * migration chain through 107 (`verify_runbook_local.origin` +
 * `verification_requests.bootstrap_proof`):
 *
 *   - `registerLearnedDraft`: one CAS'd UPSERT stamping origin `'learned'`,
 *     validated exactly as `registerDraft`, first writer wins;
 *   - `discardLearnedDraft`: a CAS DELETE, skipped while another non-terminal
 *     request pins the hash;
 *   - `registerDraft`'s conflict arm clears `origin`; `getByHash` carries it;
 *   - the learned-record drift rule in `statusDetail`.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VerifyRunbookStore, isLearnedPinRecord, type VerifyRunbookStoreDeps } from '../runbookStore';
import type { VerifyRunbookModalityEntry, VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');
const CHAIN = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
  '095_verify_failure_classes.sql',
  '096_verify_runbook_local.sql',
  '107_bootstrap_proof.sql',
];

const WORKTREE = '/tmp/wt-learned';

const WEB_ENTRY: VerifyRunbookModalityEntry = {
  build: ['pnpm run build'],
  serve: { cmd: 'pnpm run preview --port ${PORT}' },
  attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
};

const MOBILE_ENTRY: VerifyRunbookModalityEntry = {
  build: [
    'xcodebuild -project App.xcodeproj -scheme App -destination "id=$VERIFY_SIM_UDID" -derivedDataPath "$VERIFY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO build',
  ],
  app: { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'App' },
  attestation: { kind: 'bundle-identity', bundleId: 'com.example.app' },
};

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE)`);
  db.prepare("INSERT INTO projects (id, name, path) VALUES (1, 'P', '/tmp/p1')").run();
  for (const f of CHAIN) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  // The request rows below need no workflow/project graph behind them.
  db.pragma('foreign_keys = OFF');
  return db;
}

interface Harness {
  db: Database.Database;
  store: VerifyRunbookStore;
  files: Map<string, string>;
  state: { inputHash: string | null; fingerprint: string };
}

function harness(): Harness {
  const db = buildDb();
  const files = new Map<string, string>();
  const state = { inputHash: 'inputs-v1' as string | null, fingerprint: 'host-v1' };
  const deps: VerifyRunbookStoreDeps = {
    readPortableFile: async (dir) => files.get(dir) ?? null,
    computeInputHash: async () => state.inputHash,
    hostFingerprint: async () => state.fingerprint,
    hasPackageJson: async () => true,
  };
  return { db, store: new VerifyRunbookStore(db, deps), files, state };
}

function row(db: Database.Database, modality = 'web'): {
  status: string;
  version: number;
  origin: string | null;
  portable_json: string;
  input_hash: string | null;
  host_fingerprint_json: string | null;
} | undefined {
  return db
    .prepare(
      `SELECT status, version, origin, portable_json, input_hash, host_fingerprint_json
       FROM verify_runbook_local WHERE project_id = 1 AND modality = ?`,
    )
    .get(modality) as ReturnType<typeof row>;
}

function seedRequest(db: Database.Database, id: string, status: string, hash: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, 'wf', 1, 'running')
     ON CONFLICT(id) DO NOTHING`,
  ).run(`run-${id}`);
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, runbook_hash, runbook_local_version)
     VALUES (?, ?, 1, ?, 'interactive-web-behavior', '{}', ?, 1)`,
  ).run(id, `run-${id}`, status, hash);
}

describe('registerLearnedDraft', () => {
  it('writes a single-modality learned DRAFT at v1, stamped from the probe path', async () => {
    const h = harness();
    const out = await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, { portEnv: 'PORT' }, WORKTREE, null);
    if ('error' in out) throw new Error(out.error);
    expect(out.version).toBe(1);
    const r = row(h.db);
    expect(r).toMatchObject({ status: 'unproven-draft', version: 1, origin: 'learned', input_hash: 'inputs-v1', host_fingerprint_json: 'host-v1' });
    const stored = JSON.parse(r?.portable_json ?? '{}') as VerifyRunbookV1;
    expect(Object.keys(stored.modalities)).toEqual(['web']);
    expect(stored.levers).toEqual({ portEnv: 'PORT' });
    // No tree was written: the fake file map is still empty.
    expect(h.files.size).toBe(0);
    h.db.close();
  });

  it('validates exactly as registerDraft: a malformed entry and an unisolated mobile build are refused', async () => {
    const h = harness();
    const bad = await h.store.registerLearnedDraft(
      1,
      'web',
      { serve: { cmd: '' }, attestation: WEB_ENTRY.attestation } as VerifyRunbookModalityEntry,
      undefined,
      WORKTREE,
      null,
    );
    expect('error' in bad && bad.error).toMatch(/learned recipe is invalid/);
    const unisolated = await h.store.registerLearnedDraft(
      1,
      'mobile',
      { ...MOBILE_ENTRY, build: ['xcodebuild -scheme App -derivedDataPath /tmp/dd build'] },
      undefined,
      WORKTREE,
      null,
    );
    expect(unisolated).toMatchObject({ kind: 'unisolated-command' });
    expect(row(h.db)).toBeUndefined();
    expect(row(h.db, 'mobile')).toBeUndefined();
    h.db.close();
  });

  it('first writer wins: a caller that saw no record cannot overwrite an existing learned draft', async () => {
    const h = harness();
    const first = await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, null);
    if ('error' in first) throw new Error(first.error);
    const second = await h.store.registerLearnedDraft(
      1,
      'web',
      { ...WEB_ENTRY, build: ['pnpm run build:other'] },
      undefined,
      WORKTREE,
      null,
    );
    expect(second).toEqual({ error: 'cas-conflict' });
    expect(row(h.db)?.version).toBe(1);
    h.db.close();
  });

  it('updates a learned draft only at the expected version (CAS)', async () => {
    const h = harness();
    await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, null);
    const stale = await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, 7);
    expect(stale).toEqual({ error: 'cas-conflict' });
    const ok = await h.store.registerLearnedDraft(1, 'web', { ...WEB_ENTRY, build: [] }, undefined, WORKTREE, 1);
    expect('error' in ok).toBe(false);
    expect(row(h.db)).toMatchObject({ version: 2, origin: 'learned' });
    h.db.close();
  });

  it('never writes over a record that is not a learned draft (setup-flow draft, proven learned record)', async () => {
    const h = harness();
    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: WEB_ENTRY } }));
    const reg = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in reg) throw new Error(reg.error);
    h.store.setOrigin(1, 'web', 'setup-flow');
    expect(await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, reg.version)).toEqual({
      error: 'not-eligible',
    });
    expect(row(h.db)?.origin).toBe('setup-flow');

    const h2 = harness();
    const learned = await h2.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, null);
    if ('error' in learned) throw new Error(learned.error);
    expect(h2.store.markProven(1, 'web', learned.hash, learned.version, '{}')).toEqual({ ok: true });
    expect(await h2.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, learned.version)).toEqual({
      error: 'not-eligible',
    });
    h.db.close();
    h2.db.close();
  });
});

describe('discardLearnedDraft', () => {
  it('deletes the exact learned draft it was handed (CAS on hash + version)', async () => {
    const h = harness();
    const out = await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, null);
    if ('error' in out) throw new Error(out.error);
    expect(h.store.discardLearnedDraft(1, 'web', out.hash, out.version + 1)).toEqual({ ok: false, error: 'cas-conflict' });
    expect(h.store.discardLearnedDraft(1, 'web', out.hash, out.version)).toEqual({ ok: true });
    expect(row(h.db)).toBeUndefined();
    expect(h.store.discardLearnedDraft(1, 'web', out.hash, out.version)).toEqual({ ok: false, error: 'not-found' });
    h.db.close();
  });

  it('is skipped while ANOTHER non-terminal request pins the hash, but not for the discarding request itself', async () => {
    const h = harness();
    const out = await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, null);
    if ('error' in out) throw new Error(out.error);
    seedRequest(h.db, 'self', 'running', out.hash);
    seedRequest(h.db, 'done', 'failed', out.hash);
    // Only the discarding request (excepted) and a terminal one pin it.
    seedRequest(h.db, 'sibling', 'queued', out.hash);
    expect(h.store.discardLearnedDraft(1, 'web', out.hash, out.version, 'self')).toEqual({ ok: false, error: 'pinned' });
    expect(row(h.db)).toBeDefined();
    h.db.prepare("UPDATE verification_requests SET status = 'passed' WHERE id = 'sibling'").run();
    expect(h.store.discardLearnedDraft(1, 'web', out.hash, out.version, 'self')).toEqual({ ok: true });
    h.db.close();
  });

  it('never deletes a record that is not a learned draft', async () => {
    const h = harness();
    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: WEB_ENTRY } }));
    const reg = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in reg) throw new Error(reg.error);
    expect(h.store.discardLearnedDraft(1, 'web', reg.hash, reg.version)).toEqual({ ok: false, error: 'cas-conflict' });
    expect(row(h.db)).toBeDefined();
    h.db.close();
  });
});

describe('origin plumbing', () => {
  it("registerDraft's conflict arm clears origin (the caller's setOrigin re-stamps it)", async () => {
    const h = harness();
    await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, null);
    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: { ...WEB_ENTRY, build: ['pnpm run build:web'] } } }));
    const reg = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in reg).toBe(false);
    expect(row(h.db)?.origin).toBeNull();
    h.db.close();
  });

  it('getByHash / getCurrent carry origin, and isLearnedPinRecord keys on draft + learned', async () => {
    const h = harness();
    const out = await h.store.registerLearnedDraft(1, 'web', WEB_ENTRY, undefined, WORKTREE, null);
    if ('error' in out) throw new Error(out.error);
    const record = h.store.getByHash(1, 'web', out.hash);
    expect(record).toMatchObject({ status: 'unproven-draft', origin: 'learned', version: 1 });
    expect(h.store.getCurrent(1, 'web')?.origin).toBe('learned');
    expect(isLearnedPinRecord(record)).toBe(true);
    expect(isLearnedPinRecord(record && { ...record, status: 'proven' })).toBe(false);
    expect(isLearnedPinRecord(record && { ...record, origin: 'setup-flow' })).toBe(false);
    expect(isLearnedPinRecord(null)).toBe(false);
    h.db.close();
  });
});

describe('statusDetail — the learned-record drift rule', () => {
  async function provenLearnedMobile(h: Harness): Promise<void> {
    const out = await h.store.registerLearnedDraft(1, 'mobile', MOBILE_ENTRY, undefined, WORKTREE, null);
    if ('error' in out) throw new Error(out.error);
    expect(h.store.markProven(1, 'mobile', out.hash, out.version, '{}')).toEqual({ ok: true });
  }

  it("a committed file about OTHER modalities does not drift a learned record (the file conjunct is skipped)", async () => {
    const h = harness();
    await provenLearnedMobile(h);
    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: WEB_ENTRY } }));
    expect(await h.store.statusDetail(1, WORKTREE, 'mobile')).toEqual({ status: 'proven', reason: 'proven' });
    h.db.close();
  });

  it('a committed file that DECLARES the modality supersedes the learned record: content-drifted', async () => {
    const h = harness();
    await provenLearnedMobile(h);
    h.files.set(
      WORKTREE,
      JSON.stringify({ version: 1, modalities: { web: WEB_ENTRY, mobile: { ...MOBILE_ENTRY, notes: 'committed' } } }),
    );
    expect(await h.store.statusDetail(1, WORKTREE, 'mobile')).toEqual({ status: 'unproven-draft', reason: 'content-drifted' });
    h.db.close();
  });

  it('a NON-learned proven record keeps the old rule: any present, different file is content-drifted', async () => {
    const h = harness();
    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { mobile: MOBILE_ENTRY } }));
    const reg = await h.store.registerDraft(1, WORKTREE, 'mobile');
    if ('error' in reg) throw new Error(reg.error);
    expect(h.store.markProven(1, 'mobile', reg.hash, reg.version, '{}')).toEqual({ ok: true });
    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: WEB_ENTRY } }));
    expect(await h.store.statusDetail(1, WORKTREE, 'mobile')).toEqual({ status: 'unproven-draft', reason: 'content-drifted' });
    h.db.close();
  });
});
