/**
 * A0 end to end (docs/proposals/runbook-optional-verification.md §A0, T-F2):
 * the REAL drift probes (`computeVerifyInputHash`, `probeHasPackageJson`)
 * composed with the real `VerifyRunbookStore` and `BootstrapSuppressionStore`
 * over a real package.json-less tree — the Distractodo shape.
 *
 * `runbookStore.test.ts` fakes `computeInputHash` with a mutable string, which
 * is right for the store's own policy but cannot show the thing A0 exists for:
 * that a tree with NO `package.json` now produces a hash the store can prove
 * against and keep proven, and that a legacy record stored as NULL still reads
 * proven on that tree. The suppression store keys on the same probe, so its
 * behaviour on such a tree is pinned here too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VerifyRunbookStore, type VerifyRunbookStoreDeps } from '../runbookStore';
import { BootstrapSuppressionStore } from '../bootstrapSuppressionStore';
import type { DatabaseLike } from '../../types';
import { computeVerifyInputHash, probeHasPackageJson } from '../../../services/visualVerify/verifyDriftProbes';
import { VERIFY_RUNBOOK_RELATIVE_PATH, type VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

const MIG_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');

// Same chain runbookStore.test.ts stands 096 up on.
const THROUGH_096 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
  '095_verify_failure_classes.sql',
  '096_verify_runbook_local.sql',
];

function buildRunbookDb(): Database.Database {
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Distractodo', '/tmp/distractodo');
  for (const f of THROUGH_096) db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf-8'));
  return db;
}

function buildSuppressionDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(MIG_DIR, '108_runbook_bootstrap_stamp.sql'), 'utf-8'));
  db.exec(fs.readFileSync(path.join(MIG_DIR, '109_runbook_bootstrap_suppression.sql'), 'utf-8'));
  return db;
}

/** A well-formed, isolation-clean mobile runbook — what Verify Setup proves for an iOS app. */
function mobileRunbook(): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      mobile: {
        build: [
          'xcodebuild build -scheme Distractodo -destination "id=$VERIFY_SIM_UDID" ' +
            '-derivedDataPath "$VERIFY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO',
        ],
        app: { platform: 'ios-simulator', bundleId: 'com.example.distractodo', scheme: 'Distractodo' },
        attestation: { kind: 'bundle-identity', bundleId: 'com.example.distractodo' },
      },
    },
  };
}

/** The production reader's contract: `null` only for genuine absence. */
async function readPortableFile(dirPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(dirPath, VERIFY_RUNBOOK_RELATIVE_PATH), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

function makeStore(db: Database.Database, overrides: Partial<VerifyRunbookStoreDeps> = {}): VerifyRunbookStore {
  return new VerifyRunbookStore(db as unknown as DatabaseLike, {
    readPortableFile,
    computeInputHash: computeVerifyInputHash,
    hostFingerprint: async () => 'host-v1',
    hasPackageJson: probeHasPackageJson,
    ...overrides,
  });
}

function storedInputHash(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT input_hash FROM verify_runbook_local WHERE project_id = 1 AND modality = 'mobile'")
    .get() as { input_hash: string | null } | undefined;
  if (!row) throw new Error('no mobile record');
  return row.input_hash;
}

let tree: string;

beforeEach(() => {
  // A package.json-less iOS project: XcodeGen spec + the committed runbook.
  tree = fs.mkdtempSync(path.join(os.tmpdir(), 'runbook-a0-'));
  fs.writeFileSync(path.join(tree, 'project.yml'), 'name: Distractodo\n');
  fs.mkdirSync(path.join(tree, '.cyboflow'));
  fs.writeFileSync(path.join(tree, VERIFY_RUNBOOK_RELATIVE_PATH), JSON.stringify(mobileRunbook()));
});
afterEach(() => {
  fs.rmSync(tree, { recursive: true, force: true });
});

describe('A0 — a package.json-less project can be proven and stays proven', () => {
  it('register → markProven(fresh) → proven, with a non-null stored input hash', async () => {
    const db = buildRunbookDb();
    const store = makeStore(db);

    const registered = await store.registerDraft(1, tree, 'mobile');
    if ('error' in registered) throw new Error(registered.error);
    const fresh = await store.freshProvenance(tree);
    expect(fresh.inputHash).not.toBeNull();
    expect(store.markProven(1, 'mobile', registered.hash, registered.version, '{"sha":"cafe"}', fresh)).toEqual({
      ok: true,
    });

    expect(storedInputHash(db)).toBe(fresh.inputHash);
    expect(await store.statusDetail(1, tree, 'mobile')).toEqual({ status: 'proven', reason: 'proven' });
    db.close();
  });

  it('a project.yml change drifts the proof (the fallback manifest is actually observed)', async () => {
    const db = buildRunbookDb();
    const store = makeStore(db);
    const registered = await store.registerDraft(1, tree, 'mobile');
    if ('error' in registered) throw new Error(registered.error);
    store.markProven(1, 'mobile', registered.hash, registered.version, '{}', await store.freshProvenance(tree));

    fs.writeFileSync(path.join(tree, 'project.yml'), 'name: Distractodo\ntargets: {}\n');
    expect(await store.statusDetail(1, tree, 'mobile')).toEqual({ status: 'unproven-draft', reason: 'drifted' });
    db.close();
  });

  it('a cleaned-up probe path reads indeterminate — never a drift, never a stamped constant', async () => {
    const db = buildRunbookDb();
    const store = makeStore(db);
    const registered = await store.registerDraft(1, tree, 'mobile');
    if ('error' in registered) throw new Error(registered.error);
    store.markProven(1, 'mobile', registered.hash, registered.version, '{}', await store.freshProvenance(tree));
    const provenHash = storedInputHash(db);

    const gone = path.join(tree, 'disposed-worktree');
    expect(await store.statusDetail(1, gone, 'mobile')).toEqual({ status: 'absent', reason: 'indeterminate' });
    // A promotion probing that path must leave the stored baseline alone.
    const fresh = await store.freshProvenance(gone);
    expect(fresh.inputHash).toBeNull();
    expect(store.markProven(1, 'mobile', registered.hash, registered.version, '{}', fresh)).toEqual({ ok: true });
    expect(storedInputHash(db)).toBe(provenHash);
    db.close();
  });
});

describe('A0 legacy-NULL compat over a real tree', () => {
  /** A record proven the way a pre-A0 host stored it: input_hash NULL. */
  async function proveLegacy(db: Database.Database): Promise<void> {
    const legacy = makeStore(db, { computeInputHash: async () => null });
    const registered = await legacy.registerDraft(1, tree, 'mobile');
    if ('error' in registered) throw new Error(registered.error);
    expect(legacy.markProven(1, 'mobile', registered.hash, registered.version, '{"sha":"legacy"}')).toEqual({
      ok: true,
    });
    expect(storedInputHash(db)).toBeNull();
  }

  it('reads proven while the tree still has no package.json — no re-prove needed', async () => {
    const db = buildRunbookDb();
    await proveLegacy(db);

    expect(await makeStore(db).statusDetail(1, tree, 'mobile')).toEqual({ status: 'proven', reason: 'proven' });
    // Pure read: the NULL is not re-stamped.
    expect(storedInputHash(db)).toBeNull();
    db.close();
  });

  it('reads drifted once the tree has a package.json', async () => {
    const db = buildRunbookDb();
    await proveLegacy(db);

    fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    expect(await makeStore(db).statusDetail(1, tree, 'mobile')).toEqual({
      status: 'unproven-draft',
      reason: 'drifted',
    });
    db.close();
  });
});

describe('A0 — the bootstrap suppression keys on the same probe', () => {
  it('holds on an unchanged package.json-less tree (pre-A0 its null hash never matched) and reopens on a manifest change', async () => {
    const db = buildSuppressionDb();
    const suppression = new BootstrapSuppressionStore(db as unknown as DatabaseLike);
    const key = { projectId: 1, modality: 'mobile' as const, hostFingerprint: 'host-v1' };

    const inputHash = await computeVerifyInputHash(tree);
    expect(inputHash).not.toBeNull();
    expect(suppression.suppress({ ...key, inputHash, reason: 'NOT-POSSIBLE' })).toBe(true);

    expect(suppression.isSuppressed({ ...key, inputHash: await computeVerifyInputHash(tree) })).toBe(true);

    fs.writeFileSync(path.join(tree, 'project.yml'), 'name: Distractodo\ntargets: {}\n');
    expect(suppression.isSuppressed({ ...key, inputHash: await computeVerifyInputHash(tree) })).toBe(false);
    db.close();
  });
});
