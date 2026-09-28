/**
 * Unit tests for VerifyRunbookStore — the machine-local half of the runbook
 * contract (docs/proposals/verification-setup-flow.md §5.2 seam 1 + §5.3),
 * against a migration-backed in-memory DB (006 → 011 → 014 → 015 → 016 → 055 →
 * 056 → 095 → 096, extending capabilityStore.test.ts's chain through the new
 * file) so `verify_runbook_local` and the two `verification_requests` pin
 * columns come from the REAL migration 096, not a hand-rolled schema.
 *
 * The suite is organized around the store's ONE non-obvious invariant:
 * `'proven'` is a conjunction re-checked on every read, and the ways it can
 * stop holding do NOT all mean the same thing.
 *   - portable hash / project input-hash / host fingerprint drift  → the READ
 *     answers `'unproven-draft'`/`'drifted'`. Something the proof depended on
 *     changed; the green badge would be a lie.
 *   - the portable FILE is simply missing from the probed tree      → the
 *     portable-hash conjunct is SKIPPED and the other two decide (F10: the
 *     record's `portable_json`, not the file, is what a proof executes). That
 *     is the ordinary pre-merge state on every branch that has not landed the
 *     runbook yet, and it can still read `'proven'`.
 *   - the portable file is UNREADABLE (the injected dep rejects)     → fail-soft
 *     `'absent'`/`'indeterminate'`. Never the record-authoritative path.
 *
 * AND NONE OF THEM WRITE (F4 —
 * docs/proposals/visual-verification-brittleness-fixes.md). Drift used to be a
 * write-through demotion, which meant a lockfile bump or an app release
 * destroyed a proof and merely opening the Project Overview could trigger it.
 * The persisted `status` column now moves under `registerDraft`/`markProven`
 * only — so most assertions here pair the ANSWER with `persistedStatus()`,
 * which is the thing that must not have changed.
 *
 * IO is injected (a fake portable-file map + mutable input-hash/fingerprint
 * values), so these exercise the DB state machine without a filesystem.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  VerifyRunbookStore,
  type VerifyRunbookStoreDeps,
} from '../runbookStore';
import { runbookPortableHash } from '../runbookHash';
import {
  parseVerifyRunbookV1,
  type VerifyRunbookV1,
} from '../../../../../shared/types/verifyRunbook';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

// Mirrors capabilityStore.test.ts's chain — the minimal set that stands up
// workflow_runs + verification_requests (which 096 ALTERs).
const THROUGH_095 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
  '095_verify_failure_classes.sql',
];

function apply(db: Database.Database, files: string[]): void {
  for (const f of files) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
}

function seedProject(db: Database.Database): void {
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
}

/** Full chain through 096 — the "you get it for free from real migrations" DB. */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_095, '096_verify_runbook_local.sql']);
  return db;
}

/** Same chain WITHOUT 096 — proves fail-soft behavior on a pre-096 DB. */
function buildPre096Db(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, THROUGH_095);
  return db;
}

const WORKTREE = '/tmp/wt-a';

/** The runbook the fake worktree "contains" unless a test rewrites it. */
function baseRunbook(): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      web: {
        build: ['pnpm build:renderer'],
        serve: { cmd: 'pnpm dev --port ${PORT}', readyWhen: { urlPath: '/' } },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      },
      'cdp-app': {
        serve: { cmd: 'electron . --remote-debugging-port=${PORT}', attach: 'cdp' },
        attestation: { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1' },
      },
    },
  };
}

/** Mutable fake IO — every knob a drift test needs to turn. */
interface Harness {
  store: VerifyRunbookStore;
  db: Database.Database;
  /** dirPath → portable file text (absent key ⇒ readPortableFile resolves null = GENUINELY ABSENT). */
  files: Map<string, string>;
  /**
   * dirPaths whose read REJECTS — the production reader's post-F10 contract
   * (index.ts: `null` only for ENOENT/ENOTDIR, throw otherwise), so the store's
   * "unreadable is not absent" behavior is exercised the way it really happens.
   */
  unreadable: Set<string>;
  state: { inputHash: string | null; fingerprint: string };
  /**
   * A0 legacy-NULL compat's `hasPackageJson` dep — the set of probe paths this
   * fake tree currently "has a package.json" under. Not in `files`/`unreadable`
   * because it models a wholly separate file (`package.json`, not the
   * `.cyboflow/verify-runbook.json` those track).
   */
  packageJsonExists: Set<string>;
  warnings: string[];
}

function makeHarness(db: Database.Database = buildDb()): Harness {
  const files = new Map<string, string>([[WORKTREE, JSON.stringify(baseRunbook())]]);
  const unreadable = new Set<string>();
  const state = { inputHash: 'inputs-v1' as string | null, fingerprint: 'host-v1' };
  const packageJsonExists = new Set<string>();
  const warnings: string[] = [];
  const deps: VerifyRunbookStoreDeps = {
    readPortableFile: async (dirPath) => {
      if (unreadable.has(dirPath)) throw new Error('EACCES: permission denied');
      return files.get(dirPath) ?? null;
    },
    computeInputHash: async () => state.inputHash,
    hostFingerprint: async () => state.fingerprint,
    hasPackageJson: async (dirPath) => packageJsonExists.has(dirPath),
    logger: {
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: () => {},
      debug: () => {},
    },
  };
  return { store: new VerifyRunbookStore(db, deps), db, files, unreadable, state, packageJsonExists, warnings };
}

/** The whole persisted record — what a non-writing read must leave untouched. */
function persistedRow(
  db: Database.Database,
  modality = 'web',
): {
  status: string;
  version: number;
  proof_json: string | null;
  portable_hash: string;
  input_hash: string | null;
  host_fingerprint_json: string | null;
  bindings_json: string | null;
} {
  return db
    .prepare(
      `SELECT status, version, proof_json, portable_hash, input_hash, host_fingerprint_json, bindings_json
       FROM verify_runbook_local WHERE project_id = 1 AND modality = ?`,
    )
    .get(modality) as {
    status: string;
    version: number;
    proof_json: string | null;
    portable_hash: string;
    input_hash: string | null;
    host_fingerprint_json: string | null;
    bindings_json: string | null;
  };
}

/** Read the persisted status directly — the assertion that separates "answered" from "wrote". */
function persistedStatus(db: Database.Database, modality = 'web'): string | undefined {
  const row = db
    .prepare('SELECT status FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
    .get(modality) as { status: string } | undefined;
  return row?.status;
}

/** Drive the happy path to a proven record and return its pin (hash + version). */
async function proveWeb(h: Harness): Promise<{ hash: string; version: number }> {
  const registered = await h.store.registerDraft(1, WORKTREE, 'web');
  if ('error' in registered) throw new Error(`registerDraft failed: ${registered.error}`);
  const proven = h.store.markProven(1, 'web', registered.hash, registered.version, '{"sha":"deadbeef"}');
  expect(proven).toEqual({ ok: true });
  return registered;
}

describe('migration 096', () => {
  it('creates verify_runbook_local and adds the two verification_requests pin columns', () => {
    const db = buildDb();
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'verify_runbook_local'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('verify_runbook_local');

    const cols = (db.prepare('PRAGMA table_info(verification_requests)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('runbook_hash');
    expect(cols).toContain('runbook_local_version');
    db.close();
  });

  it('constrains status to the two persisted states (an absent row IS the absent state)', () => {
    const db = buildDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO verify_runbook_local (project_id, modality, portable_hash, portable_json, version, status)
           VALUES (1, 'web', 'h', '{}', 1, 'absent')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe('VerifyRunbookStore lifecycle', () => {
  it('registerDraft persists an unproven draft at version 1 with the portable hash', async () => {
    const h = makeHarness();
    const result = await h.store.registerDraft(1, WORKTREE, 'web', '{"chromium":"/usr/bin/chromium"}');
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.version).toBe(1);
    expect(result.hash).toBe(runbookPortableHash(baseRunbook()));

    const row = h.db
      .prepare('SELECT * FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
      .get('web') as {
      status: string;
      portable_hash: string;
      portable_json: string;
      bindings_json: string | null;
      input_hash: string | null;
      host_fingerprint_json: string | null;
      proof_json: string | null;
    };
    expect(row.status).toBe('unproven-draft');
    expect(row.portable_hash).toBe(result.hash);
    expect(row.bindings_json).toBe('{"chromium":"/usr/bin/chromium"}');
    expect(row.input_hash).toBe('inputs-v1');
    expect(row.host_fingerprint_json).toBe('host-v1');
    expect(row.proof_json).toBeNull();
    // The stored JSON is the VALIDATED rebuild, not the raw file text.
    expect(parseVerifyRunbookV1(JSON.parse(row.portable_json)).ok).toBe(true);
    h.db.close();
  });

  it('status reports unproven-draft after registerDraft and proven after markProven', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');

    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{"sha":"deadbeef"}')).toEqual({ ok: true });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');

    const proof = h.db
      .prepare('SELECT proof_json FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
      .get('web') as { proof_json: string };
    expect(proof.proof_json).toBe('{"sha":"deadbeef"}');
    h.db.close();
  });

  it('tracks modalities independently — proving web says nothing about cdp-app', async () => {
    const h = makeHarness();
    await proveWeb(h);
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    // Declared in the file but never registered ⇒ derived, not proven.
    expect(await h.store.status(1, WORKTREE, 'cdp-app')).toBe('unproven-draft');
    // Not declared at all ⇒ absent.
    expect(await h.store.status(1, WORKTREE, 'native-screen')).toBe('absent');
    h.db.close();
  });

  it('re-registering a new revision bumps the version and drops back to unproven-draft', async () => {
    const h = makeHarness();
    const first = await proveWeb(h);
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');

    const edited = baseRunbook();
    edited.modalities.web = {
      build: ['pnpm build:renderer'],
      serve: { cmd: 'pnpm dev --port ${PORT} --host' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    h.files.set(WORKTREE, JSON.stringify(edited));

    const second = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in second) throw new Error(second.error);
    expect(second.version).toBe(first.version + 1);
    expect(second.hash).not.toBe(first.hash);
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    h.db.close();
  });
});

/**
 * F4 — drift is COMPUTED AND RETURNED, never written.
 *
 * Each case asserts the same two things: the READ is honest
 * (`'unproven-draft'`, so the gate and the badge still refuse), and the RECORD
 * is untouched (still `'proven'`, proof intact). The second half is the whole
 * change: the write-through demotion this suite used to assert made an ordinary
 * dependency bump or app release destroy a proof outright, recoverable only by
 * re-deriving a human-authored runbook — and merely opening the Project
 * Overview was enough to trigger it.
 */
describe('VerifyRunbookStore drift → computed, non-writing', () => {
  it('reads unproven when the portable file hashes to something else, WITHOUT writing', async () => {
    const h = makeHarness();
    await proveWeb(h);

    const edited = baseRunbook();
    edited.modalities.web = {
      serve: { cmd: 'pnpm preview --port ${PORT}' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    h.files.set(WORKTREE, JSON.stringify(edited));

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('reads unproven when the portable file no longer parses, WITHOUT writing', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.files.set(WORKTREE, '{ not json');

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('reads unproven on project input-hash drift (an edited dev script), WITHOUT writing', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.inputHash = 'inputs-v2';

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('reads unproven on host-fingerprint drift (chromium moved, an Electron ABI bump), WITHOUT writing', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.fingerprint = 'host-v2';

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('a drifting read leaves the ENTIRE record intact — proof, version, and provenance', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);
    const before = persistedRow(h.db);
    h.state.fingerprint = 'host-v2';
    await h.store.status(1, WORKTREE, 'web');

    // Byte-for-byte the same record: the read is a read.
    expect(persistedRow(h.db)).toEqual(before);
    expect(persistedRow(h.db).version).toBe(pin.version);
    expect(persistedRow(h.db).proof_json).toBe('{"sha":"deadbeef"}');
    // The provenance of what the proof WAS taken against is what makes the
    // drift diagnosable — and what a re-prove re-stamps.
    expect(persistedRow(h.db).input_hash).toBe('inputs-v1');

    // The runner still resolves the pin, and (F4/Codex #2, accepted) it now sees
    // 'proven' — drift is caught at the ENQUEUE gate, not at execution time.
    expect(h.store.getByHash(1, 'web', pin.hash)?.status).toBe('proven');
    h.db.close();
  });

  it('the drift warn still fires, so a vanishing proof is still greppable', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.inputHash = 'inputs-v2';
    await h.store.status(1, WORKTREE, 'web');
    expect(h.warnings.some((w) => w.includes('drifted'))).toBe(true);
    h.db.close();
  });

  it('the inputs coming back restores proven with no re-registration at all', async () => {
    // The other half of "non-destructive": a proof that reads drifted because
    // the developer switched to the dev build is proven again the moment they
    // switch back. Under write-through demotion this needed a full re-derive.
    const h = makeHarness();
    await proveWeb(h);
    h.state.fingerprint = 'host-v2';
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');

    h.state.fingerprint = 'host-v1';
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });

  it('a re-proof after drift recovers proven', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);
    h.state.fingerprint = 'host-v2';
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');

    // A8 (RS-12): content and bindings are UNCHANGED, so re-registering is
    // correctly a NO-OP here — it does not touch input_hash/host_fingerprint,
    // and does NOT bump the version. Recovery from a HOST-only drift therefore
    // goes through markProven's own `fresh` re-stamp (see the
    // "fresh provenance re-stamp" describe block), against the SAME pinned
    // hash + version, not through a pointless re-register of identical content.
    const noop = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in noop) throw new Error(noop.error);
    expect(noop).toEqual(pin);

    const fresh = await h.store.freshProvenance(WORKTREE);
    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{"sha":"cafe"}', fresh)).toEqual({ ok: true });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });
});

/**
 * F10 — the file is an EXPORT; the record is what executes.
 *
 * Nothing reads `.cyboflow/verify-runbook.json` inside the detached snapshot:
 * the runner fetches `portable_json` by content hash. So a probe path that
 * genuinely lacks the file cannot change WHAT would run, and the portable-hash
 * conjunct is skipped rather than the whole read being refused. The input hash
 * is what still guards a branch — it is the one that folds in package scripts
 * and the lockfile.
 *
 * The narrowness of "absent" is the safety property: an UNREADABLE file must
 * never take this path, which is why the production reader rejects on anything
 * but ENOENT/ENOTDIR (index.ts, Codex #8) and the harness models that.
 */
describe('VerifyRunbookStore — an absent file is record-authoritative (F10)', () => {
  it('a proven record reads PROVEN from a tree that lacks the file, when the other conjuncts hold', async () => {
    const h = makeHarness();
    await proveWeb(h);

    // A sibling lane's worktree legitimately lacks the not-yet-merged runbook —
    // and, being a checkout of the same project, hashes the same inputs.
    expect(await h.store.statusDetail(1, '/tmp/wt-b', 'web')).toEqual({
      status: 'proven',
      reason: 'proven',
    });
    expect(persistedStatus(h.db)).toBe('proven');

    // The tree that DOES carry it is still proven, by the full conjunction.
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });

  it('an absent file does NOT excuse input drift — the branch still refuses, and still without writing', async () => {
    const h = makeHarness();
    await proveWeb(h);
    // The tree lacks the runbook AND its scripts/lockfile moved: exactly the
    // case the skipped conjunct must not launder.
    h.state.inputHash = 'inputs-v2';

    expect(await h.store.statusDetail(1, '/tmp/wt-b', 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'drifted',
    });
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('an absent file does NOT excuse host drift either', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.fingerprint = 'host-v2';

    expect(await h.store.statusDetail(1, '/tmp/wt-b', 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'drifted',
    });
    h.db.close();
  });

  it('an UNREADABLE file is not an absent one: fail-soft indeterminate, never proven, never written', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.unreadable.add(WORKTREE);

    // The reader rejected (a permissions/IO fault), so the store cannot observe
    // the tree at all — and an inability to look is never evidence of a proof.
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'absent',
      reason: 'indeterminate',
    });
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('a PRESENT but unparseable file keeps its rejection (content drift, not absence)', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.files.set(WORKTREE, '{ not json');

    // 'content-drifted', not 'drifted': the remedy is to re-register this
    // tree's revision, and no proof can substitute for that (F4 fix round).
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'content-drifted',
    });
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });
});

describe('VerifyRunbookStore non-demoting states', () => {
  it('an uncomputable input hash fails soft to absent WITHOUT demoting', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.inputHash = null;

    expect(await h.store.status(1, WORKTREE, 'web')).toBe('absent');
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('no record + no file is absent; no record + a declaring file is unproven-draft', async () => {
    const h = makeHarness();
    expect(await h.store.status(1, '/tmp/empty', 'web')).toBe('absent');
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    // Nothing was written by either read.
    expect(persistedStatus(h.db)).toBeUndefined();
    h.db.close();
  });

  it('an already-unproven record answers unproven-draft without consulting drift', async () => {
    const h = makeHarness();
    await h.store.registerDraft(1, WORKTREE, 'web');
    h.state.inputHash = null; // would fail-soft to 'absent' on a PROVEN record
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    h.db.close();
  });
});

describe('VerifyRunbookStore.markProven CAS', () => {
  it('rejects a stale version as cas-conflict without flipping the record', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    expect(h.store.markProven(1, 'web', pin.hash, pin.version + 1, '{}')).toEqual({
      ok: false,
      error: 'cas-conflict',
    });
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('rejects a proof against a different portable hash as hash-mismatch', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    expect(h.store.markProven(1, 'web', 'not-the-hash', pin.version, '{}')).toEqual({
      ok: false,
      error: 'hash-mismatch',
    });
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('a registerDraft racing between the proof run and the flip invalidates the proof', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    // The human edits + re-registers while the proof run is in flight.
    const edited = baseRunbook();
    edited.modalities.web = {
      serve: { cmd: 'pnpm dev --port ${PORT} --strictPort false' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    h.files.set(WORKTREE, JSON.stringify(edited));
    await h.store.registerDraft(1, WORKTREE, 'web');

    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{}')).toEqual({
      ok: false,
      error: 'hash-mismatch',
    });
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('reports not-found when no record exists for the (project, modality)', () => {
    const h = makeHarness();
    expect(h.store.markProven(1, 'web', 'h', 1, '{}')).toEqual({ ok: false, error: 'not-found' });
    h.db.close();
  });
});

/**
 * F4 / Codex #1 — promotion RE-STAMPS the provenance the drift check compares
 * against, and only that.
 *
 * `registerDraft` stamps `input_hash`/`host_fingerprint_json` from whatever tree
 * and host were current when the DRAFT was written — a flow worktree, or a host
 * that has since taken an Electron bump. A proof obtained afterwards was
 * therefore born already drifted. The engine now hands `markProven` what it
 * observed at promotion time.
 *
 * `portable_hash` is deliberately NOT re-stampable: it is the content address of
 * `portable_json` and the target of every pin.
 */
describe('VerifyRunbookStore.markProven — fresh provenance re-stamp', () => {
  it('re-stamps input_hash + host_fingerprint_json, and never portable_hash', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);
    expect(persistedRow(h.db).input_hash).toBe('inputs-v1');

    // The host moved between the draft and the proof (an app release, a
    // playwright bump) — the proof describes the NEW one.
    expect(
      h.store.markProven(1, 'web', pin.hash, pin.version, '{"sha":"beef"}', {
        inputHash: 'inputs-v2',
        hostFingerprint: 'host-v2',
      }),
    ).toEqual({ ok: true });

    const row = persistedRow(h.db);
    expect(row.status).toBe('proven');
    expect(row.input_hash).toBe('inputs-v2');
    expect(row.host_fingerprint_json).toBe('host-v2');
    // The content address is untouched, so the pin still resolves.
    expect(row.portable_hash).toBe(pin.hash);
    expect(row.version).toBe(pin.version);
    expect(h.store.getByHash(1, 'web', pin.hash)?.status).toBe('proven');
    h.db.close();
  });

  it('the re-stamp is what makes the very next read proven instead of drifted', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);
    // The draft was registered on host-v1; the proof ran on host-v2.
    h.state.fingerprint = 'host-v2';

    // Without the re-stamp the proof is born drifted…
    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{}')).toEqual({ ok: true });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');

    // …with it, the record describes the host that actually proved it.
    const fresh = await h.store.freshProvenance(WORKTREE);
    expect(fresh).toEqual({ inputHash: 'inputs-v1', hostFingerprint: 'host-v2' });
    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{}', fresh)).toEqual({ ok: true });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });

  /**
   * An UNOBSERVABLE input hash must not be WRITTEN (F4 fix round).
   *
   * `null` from `computeInputHash` means "could not look at this tree" — a
   * worktree already cleaned up when the terminal settled, a manifest
   * momentarily unreadable — not "the inputs are empty". Stamping it would be
   * self-destroying: `statusDetail` counts a stored NULL against any freshly
   * computed value as a difference, so the promotion would read as drifted on
   * its very next check, and the record would need a whole re-prove to recover
   * from having just been proven. The stored baseline is kept instead, which is
   * exactly what the caller's fallback does when the probe THROWS.
   */
  it('a null input hash is NOT written over the stored one; the fingerprint still is', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);
    expect(persistedRow(h.db).input_hash).toBe('inputs-v1');

    h.state.inputHash = null;
    h.state.fingerprint = 'host-v2';
    const fresh = await h.store.freshProvenance(WORKTREE);
    expect(fresh.inputHash).toBeNull();
    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{}', fresh)).toEqual({ ok: true });

    const row = persistedRow(h.db);
    expect(row.status).toBe('proven');
    expect(row.input_hash).toBe('inputs-v1');
    // The half that WAS observed is still re-stamped — a probe that could not
    // read the tree says nothing about the host.
    expect(row.host_fingerprint_json).toBe('host-v2');
    h.db.close();
  });

  it('the promotion survives its own next read when the inputs were unobservable', async () => {
    // The concrete regression: with a NULL written, this read answered
    // 'unproven-draft'/'drifted' one line after a successful proof.
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);

    h.state.inputHash = null;
    const fresh = await h.store.freshProvenance(WORKTREE);
    expect(h.store.markProven(1, 'web', pin.hash, pin.version, '{}', fresh)).toEqual({ ok: true });

    // The tree becomes readable again and its inputs are unchanged.
    h.state.inputHash = 'inputs-v1';
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'proven',
      reason: 'proven',
    });
    h.db.close();
  });

  it('BOTH CAS predicates still gate the re-stamping flip', async () => {
    const h = makeHarness();
    const pin = await h.store.registerDraft(1, WORKTREE, 'web');
    if ('error' in pin) throw new Error(pin.error);
    const fresh = { inputHash: 'inputs-v2', hostFingerprint: 'host-v2' };

    expect(h.store.markProven(1, 'web', pin.hash, pin.version + 1, '{}', fresh)).toEqual({
      ok: false,
      error: 'cas-conflict',
    });
    expect(h.store.markProven(1, 'web', 'not-the-hash', pin.version, '{}', fresh)).toEqual({
      ok: false,
      error: 'hash-mismatch',
    });

    // A refused flip re-stamps NOTHING — the provenance is part of the same
    // guarded UPDATE, not a second write.
    const row = persistedRow(h.db);
    expect(row.status).toBe('unproven-draft');
    expect(row.input_hash).toBe('inputs-v1');
    expect(row.host_fingerprint_json).toBe('host-v1');
    h.db.close();
  });

  it('freshProvenance propagates a rejecting host probe (the caller decides, not the store)', async () => {
    const h = makeHarness();
    await h.store.registerDraft(1, WORKTREE, 'web');
    // A fingerprint that cannot be computed has no safe stand-in: swallowing it
    // would stamp a value that never matches. The scheduler catches this and
    // falls back to a status-only flip rather than losing the proof.
    const broken = new VerifyRunbookStore(h.db, {
      readPortableFile: async () => null,
      computeInputHash: async () => 'inputs-v1',
      hostFingerprint: async () => {
        throw new Error('probe exploded');
      },
    });
    await expect(broken.freshProvenance(WORKTREE)).rejects.toThrow('probe exploded');
    h.db.close();
  });
});

describe('VerifyRunbookStore.getByHash', () => {
  it('returns the pinned revision, its version, and its status on a hit', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);

    const found = h.store.getByHash(1, 'web', pin.hash);
    expect(found).not.toBeNull();
    expect(found?.version).toBe(pin.version);
    expect(found?.status).toBe('proven');
    expect(found?.runbook.modalities.web?.serve?.cmd).toBe('pnpm dev --port ${PORT}');
    h.db.close();
  });

  it('misses on an unknown hash, a different modality, and a different project', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);

    expect(h.store.getByHash(1, 'web', 'nope')).toBeNull();
    expect(h.store.getByHash(1, 'cdp-app', pin.hash)).toBeNull();
    expect(h.store.getByHash(2, 'web', pin.hash)).toBeNull();
    h.db.close();
  });

  it('misses (rather than throwing) when the stored portable JSON is corrupt', async () => {
    const h = makeHarness();
    const pin = await proveWeb(h);
    h.db
      .prepare('UPDATE verify_runbook_local SET portable_json = ? WHERE project_id = 1 AND modality = ?')
      .run('{ not json', 'web');

    expect(h.store.getByHash(1, 'web', pin.hash)).toBeNull();
    expect(h.warnings.some((w) => w.includes('not valid JSON'))).toBe(true);
    h.db.close();
  });
});

describe('VerifyRunbookStore.registerDraft rejections', () => {
  it('reports an absent portable file rather than persisting an empty record', async () => {
    const h = makeHarness();
    const result = await h.store.registerDraft(1, '/tmp/empty', 'web');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('no portable runbook found');
    expect(persistedStatus(h.db)).toBeUndefined();
    h.db.close();
  });

  it('reports malformed JSON and a failed contract validation with the offending path', async () => {
    const h = makeHarness();
    h.files.set(WORKTREE, '{ not json');
    const bad = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in bad && bad.error).toContain('not valid JSON');

    h.files.set(WORKTREE, JSON.stringify({ version: 1, modalities: { web: { serve: { cmd: 'x' } } } }));
    const invalid = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in invalid && invalid.error).toContain('modalities["web"].attestation: required');
    h.db.close();
  });

  it('refuses a modality the runbook never declared — including mobile, when this fixture declares no mobile entry', async () => {
    const h = makeHarness();
    const notDeclared = await h.store.registerDraft(1, WORKTREE, 'native-screen');
    expect('error' in notDeclared && notDeclared.error).toContain('declares no "native-screen" modality');

    const mobile = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in mobile && mobile.error).toContain('declares no "mobile" modality');
    h.db.close();
  });
});

/**
 * §7.2 mobile isolation, enforced at THIS chokepoint (`registerDraft`) rather
 * than in `runbookDraftValidation.ts` — see the guard's own header. The shared
 * parser (shared/types/verifyRunbook.ts) enforces SHAPE and cross-field
 * invariants only (app required, serve forbidden, attestation.bundleId
 * matches); it never inspects a `build[]` command's CONTENT, which is what
 * this suite exercises.
 */
describe('VerifyRunbookStore.registerDraft — §7.2 mobile command isolation', () => {
  /** A well-formed mobile entry's build[], parameterized so each test can break exactly one rule. */
  function mobileRunbook(build: string[]): VerifyRunbookV1 {
    return {
      version: 1,
      modalities: {
        mobile: {
          build,
          app: { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'MyApp' },
          attestation: { kind: 'bundle-identity', bundleId: 'com.example.app' },
        },
      },
    };
  }

  const CLEAN_STEP =
    'xcodebuild build -scheme MyApp -destination "id=$VERIFY_SIM_UDID" ' +
    '-derivedDataPath "$VERIFY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO';

  it('registers a well-formed mobile entry successfully', async () => {
    const h = makeHarness();
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([CLEAN_STEP])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(await h.store.status(1, WORKTREE, 'mobile')).toBe('unproven-draft');
    h.db.close();
  });

  it.each([
    ['bare $VAR', '-derivedDataPath $VERIFY_DERIVED_DATA -destination "id=$VERIFY_SIM_UDID"'],
    ['braced ${VAR}', '-derivedDataPath ${VERIFY_DERIVED_DATA} -destination "id=${VERIFY_SIM_UDID}"'],
    ['quoted "$VAR"', '-derivedDataPath "$VERIFY_DERIVED_DATA" -destination "id=$VERIFY_SIM_UDID"'],
  ])('accepts the %s lever spelling', async (_label, flags) => {
    const h = makeHarness();
    const step = `xcodebuild build -scheme MyApp ${flags} CODE_SIGNING_ALLOWED=NO`;
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(false);
    h.db.close();
  });

  it('rejects a build step missing -derivedDataPath entirely', async () => {
    const h = makeHarness();
    const step = 'xcodebuild build -scheme MyApp -destination "id=$VERIFY_SIM_UDID" CODE_SIGNING_ALLOWED=NO';
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.kind).toBe('unisolated-command');
    expect(result.error).toContain(
      'modalities["mobile"].build[0]: missing "-derivedDataPath" referencing the DerivedData lever ($VERIFY_DERIVED_DATA or the runbook\'s levers.derivedDataEnv)',
    );
    expect(persistedStatus(h.db, 'mobile')).toBeUndefined();
    h.db.close();
  });

  it('rejects an ABSOLUTE -derivedDataPath', async () => {
    const h = makeHarness();
    const step = 'xcodebuild build -scheme MyApp -destination "id=$VERIFY_SIM_UDID" -derivedDataPath /tmp/dd CODE_SIGNING_ALLOWED=NO';
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.kind).toBe('unisolated-command');
    expect(result.error).toContain(
      'modalities["mobile"].build[0]: -derivedDataPath is an absolute path ("/tmp/dd") — it must reference the request-scoped DerivedData lever, not a fixed location',
    );
    h.db.close();
  });

  it('rejects a home-relative (~) -derivedDataPath the same way', async () => {
    const h = makeHarness();
    const step = 'xcodebuild build -scheme MyApp -destination "id=$VERIFY_SIM_UDID" -derivedDataPath ~/dd CODE_SIGNING_ALLOWED=NO';
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('-derivedDataPath is an absolute path ("~/dd")');
    h.db.close();
  });

  it('rejects a build step missing -destination with the sim-UDID lever', async () => {
    const h = makeHarness();
    const step = 'xcodebuild build -scheme MyApp -derivedDataPath "$VERIFY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO';
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.kind).toBe('unisolated-command');
    expect(result.error).toContain(
      'modalities["mobile"].build[0]: missing "-destination" with "id=$VERIFY_SIM_UDID" (or the runbook\'s levers.simUdidEnv) — the simulator target must be the request-scoped lever, never a fixed device',
    );
    h.db.close();
  });

  it('rejects a build step missing CODE_SIGNING_ALLOWED=NO', async () => {
    const h = makeHarness();
    const step = 'xcodebuild build -scheme MyApp -destination "id=$VERIFY_SIM_UDID" -derivedDataPath "$VERIFY_DERIVED_DATA"';
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.kind).toBe('unisolated-command');
    expect(result.error).toContain(
      'modalities["mobile"].build[0]: missing "CODE_SIGNING_ALLOWED=NO" — an xcodebuild build step must disable code signing',
    );
    h.db.close();
  });

  it('rejects a literal simulator/device UDID anywhere in a build step', async () => {
    const h = makeHarness();
    const step =
      'xcodebuild build -scheme MyApp -destination "id=1F2E3D4C-5B6A-4321-9876-ABCDEF012345" ' +
      '-derivedDataPath "$VERIFY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO';
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.kind).toBe('unisolated-command');
    expect(result.error).toContain(
      'modalities["mobile"].build[0]: contains a literal simulator/device UDID ("1F2E3D4C-5B6A-4321-9876-ABCDEF012345") — the UDID must come from the request-scoped simUdidEnv lever, never be hardcoded',
    );
    h.db.close();
  });

  it.each(['install', 'launch', 'boot', 'create', 'delete', 'shutdown'])(
    'rejects "xcrun simctl %s" as a build step — device lifecycle is harness-owned',
    async (verb) => {
      const h = makeHarness();
      const step = `xcrun simctl ${verb} $VERIFY_SIM_UDID com.example.app`;
      h.files.set(WORKTREE, JSON.stringify(mobileRunbook([step])));

      const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.kind).toBe('unisolated-command');
      expect(result.error).toContain(
        `modalities["mobile"].build[0]: runs "xcrun simctl ${verb}" — simulator install/launch (the harness's own mobile-install/mobile-launch) and device lifecycle are harness-owned, not a build step's job`,
      );
      h.db.close();
    },
  );

  it('a non-xcodebuild pre-step is NOT held to the derivedDataPath/destination/signing rules', async () => {
    const h = makeHarness();
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook(['swift build', CLEAN_STEP])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(false);
    h.db.close();
  });

  it('a non-xcodebuild pre-step is STILL held to the literal-UDID rule', async () => {
    const h = makeHarness();
    const badPreStep = 'swift build --triple 1F2E3D4C-5B6A-4321-9876-ABCDEF012345';
    h.files.set(WORKTREE, JSON.stringify(mobileRunbook([badPreStep, CLEAN_STEP])));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('modalities["mobile"].build[0]: contains a literal simulator/device UDID');
    h.db.close();
  });

  it('checks a riding-along mobile entry even when registering a DIFFERENT modality', async () => {
    const h = makeHarness();
    const combined: VerifyRunbookV1 = {
      version: 1,
      modalities: {
        ...baseRunbook().modalities,
        mobile: {
          build: ['xcodebuild build -scheme MyApp -derivedDataPath /tmp/dd'],
          app: { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'MyApp' },
          attestation: { kind: 'bundle-identity', bundleId: 'com.example.app' },
        },
      },
    };
    h.files.set(WORKTREE, JSON.stringify(combined));

    // Registering 'web' would otherwise persist the WHOLE portable_json —
    // mobile entry included — unvetted.
    const result = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.kind).toBe('unisolated-command');
    expect(result.error).toContain('-derivedDataPath is an absolute path ("/tmp/dd")');
    expect(persistedStatus(h.db, 'web')).toBeUndefined();
    h.db.close();
  });

  it('honors a runbook-declared derivedDataEnv/simUdidEnv lever name instead of the defaults', async () => {
    const h = makeHarness();
    const custom: VerifyRunbookV1 = {
      version: 1,
      modalities: {
        mobile: {
          build: [
            'xcodebuild build -scheme MyApp -destination "id=$MY_SIM_UDID" ' +
              '-derivedDataPath "$MY_DERIVED_DATA" CODE_SIGNING_ALLOWED=NO',
          ],
          app: { platform: 'ios-simulator', bundleId: 'com.example.app', scheme: 'MyApp' },
          attestation: { kind: 'bundle-identity', bundleId: 'com.example.app' },
        },
      },
      levers: { derivedDataEnv: 'MY_DERIVED_DATA', simUdidEnv: 'MY_SIM_UDID' },
    };
    h.files.set(WORKTREE, JSON.stringify(custom));

    const result = await h.store.registerDraft(1, WORKTREE, 'mobile');
    expect('error' in result).toBe(false);
    h.db.close();
  });
});

describe('VerifyRunbookStore fail-soft on a pre-096 DB', () => {
  it('degrades to absent / errors / null without throwing when the table is missing', async () => {
    const h = makeHarness(buildPre096Db());

    await expect(h.store.status(1, WORKTREE, 'web')).resolves.toBe('absent');

    const registered = await h.store.registerDraft(1, WORKTREE, 'web');
    expect('error' in registered).toBe(true);

    const proven = h.store.markProven(1, 'web', 'h', 1, '{}');
    expect(proven.ok).toBe(false);

    expect(h.store.getByHash(1, 'web', 'h')).toBeNull();
    h.db.close();
  });
});

/**
 * `statusDetail()` — the situation behind the three-valued answer
 * (lane-runbook-bootstrap.md §4).
 *
 * The suite above proves the ANSWERS are right. This one exists because several
 * distinct situations answer `'unproven-draft'` and two answer `'absent'`, and
 * a caller that intends to WRITE — a bootstrap that would `registerDraft` over
 * the singleton (project, modality) row — has to tell them apart. The load
 * bearing case is now `'drifted'`: the record is live and someone's proof is
 * merely out of date with its inputs, so the response is to RE-PROVE it, not to
 * re-derive over it. (`'proven-file-absent-here'` stays in the union for the
 * modules that map it, but F10 means `statusDetail` no longer produces it — an
 * absent file just skips the portable-hash conjunct.)
 *
 * Every case also asserts that `status()` projects to the same answer, so the
 * gate's view and a writer's view cannot drift apart.
 */
describe('VerifyRunbookStore.statusDetail', () => {
  it('no record and no file is no-record', async () => {
    const h = makeHarness();
    expect(await h.store.statusDetail(1, '/tmp/empty', 'web')).toEqual({
      status: 'absent',
      reason: 'no-record',
    });
    expect(await h.store.status(1, '/tmp/empty', 'web')).toBe('absent');
    h.db.close();
  });

  it('no record but a declaring file in THIS tree is file-only, not no-record', async () => {
    const h = makeHarness();
    // A teammate's committed runbook, freshly cloned: adopt-and-prove, not
    // author-a-competing-one. Same 'unproven-draft' answer as a draft record.
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'file-only',
    });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('unproven-draft');
    expect(persistedStatus(h.db)).toBeUndefined();
    h.db.close();
  });

  it('an unproven record is draft, and says whether this tree carries the file beside it', async () => {
    const h = makeHarness();
    await h.store.registerDraft(1, WORKTREE, 'web');
    // Registered FROM this tree's file, so the file is here and declares 'web':
    // the bootstrap adopts it rather than deriving a rival (the same §4 case as
    // 'file-only', with the record merely registered first).
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'draft',
      fileDeclaresModality: true,
    });
    // A tree WITHOUT the file (another branch, pre-merge) answers the same
    // reason with nothing to adopt.
    expect(await h.store.statusDetail(1, '/no-file-here', 'web')).toEqual({
      status: 'unproven-draft',
      reason: 'draft',
      fileDeclaresModality: false,
    });
    h.db.close();
  });

  it('NEVER answers proven-file-absent-here any more — an absent file is judged on the other conjuncts (F10)', async () => {
    const h = makeHarness();
    await proveWeb(h);

    // The pre-merge state used to be its own refusal. It is now simply the
    // record's answer, because the record is what the runner executes.
    expect(await h.store.statusDetail(1, '/tmp/wt-b', 'web')).toEqual({
      status: 'proven',
      reason: 'proven',
    });
    expect(persistedStatus(h.db)).toBe('proven');

    // And the tree that carries it still reads proven, for both views.
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'proven',
      reason: 'proven',
    });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    h.db.close();
  });

  /**
   * WHICH drift, not just THAT it drifted (F4 fix round).
   *
   * The two file-shaped rows answer `'content-drifted'` and the two
   * provenance-shaped rows answer `'drifted'`, and the split is load bearing
   * rather than descriptive: `decideRunbookBootstrap` re-proves the second pair
   * and DECLINES the first, because promotion never re-stamps `portable_hash`
   * (Codex #1) and so no proof can ever clear a content mismatch. Collapsing
   * them again would re-create a passing proof that fails its own confirmation,
   * once per run, forever. Both still gate identically — same status, same
   * intact record.
   */
  it.each([
    ['portable hash drift', 'content-drifted', (h: Harness) => h.files.set(WORKTREE, JSON.stringify({
      ...baseRunbook(),
      modalities: { ...baseRunbook().modalities, web: { ...baseRunbook().modalities.web!, build: ['pnpm build:other'] } },
    }))],
    ['project input drift', 'drifted', (h: Harness) => { h.state.inputHash = 'inputs-v2'; }],
    ['host fingerprint drift', 'drifted', (h: Harness) => { h.state.fingerprint = 'host-v2'; }],
    ['an unparseable portable file', 'content-drifted', (h: Harness) => h.files.set(WORKTREE, '{ not json')],
  ])('%s reports %s and leaves the record alone (F4)', async (_label, reason, mutate) => {
    const h = makeHarness();
    await proveWeb(h);
    mutate(h);

    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'unproven-draft',
      reason,
    });
    // 'drifted' is a COMPUTED answer, not a spent proof: the record is still
    // proven, and it is the enqueue gate — which recomputes this on every read —
    // that keeps the badge and the lane honest.
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('an unobservable input hash is indeterminate, NOT no-record', async () => {
    const h = makeHarness();
    await proveWeb(h);
    h.state.inputHash = null;

    // Both collapse to 'absent', but "I could not look" is not "nothing is
    // there" — and the record is still proven underneath.
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'absent',
      reason: 'indeterminate',
    });
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('a pre-096 DB is indeterminate, NOT no-record', async () => {
    const h = makeHarness(buildPre096Db());
    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({
      status: 'absent',
      reason: 'indeterminate',
    });
    h.db.close();
  });
});

/**
 * A0 legacy-NULL compat (docs/proposals/runbook-optional-verification.md §A0).
 *
 * Before A0, `computeInputHash` returned `null` for a package.json-less tree,
 * and `registerDraft`/`markProven` stamped that `null` straight into
 * `input_hash`. A0's `computeVerifyInputHash` no longer returns null there — it
 * folds in fallback manifests instead — so a bare `freshInputHash !==
 * row.input_hash` comparison would now read EVERY such legacy record as
 * drifted, forever, the instant this fix ships (the Distractodo case the
 * design's evidence section documents). `statusDetail` special-cases a stored
 * NULL: it counts as matching only when the probe tree STILL has no
 * `package.json`, via the optional injected `hasPackageJson` dep.
 */
describe('VerifyRunbookStore — A0 legacy-NULL input-hash compat', () => {
  /** Registers + proves 'web' the way a pre-A0 host would have: a null input hash. */
  async function proveWebWithLegacyNullInputHash(h: Harness): Promise<{ hash: string; version: number }> {
    const savedInputHash = h.state.inputHash;
    h.state.inputHash = null;
    try {
      const registered = await h.store.registerDraft(1, WORKTREE, 'web');
      if ('error' in registered) throw new Error(`registerDraft failed: ${registered.error}`);
      expect(h.store.markProven(1, 'web', registered.hash, registered.version, '{"sha":"legacy"}')).toEqual({
        ok: true,
      });
      return registered;
    } finally {
      h.state.inputHash = savedInputHash;
    }
  }

  it('persists input_hash = NULL, the pre-A0 shape', async () => {
    const h = makeHarness();
    await proveWebWithLegacyNullInputHash(h);
    expect(persistedRow(h.db).input_hash).toBeNull();
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('reads proven when the probe tree STILL has no package.json (the condition that produced the NULL)', async () => {
    const h = makeHarness();
    await proveWebWithLegacyNullInputHash(h);

    // A0 ships: the SAME package.json-less tree now computes a non-null
    // fallback hash instead of null.
    h.state.inputHash = 'fallback-hash-v1';
    h.packageJsonExists.delete(WORKTREE);

    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({ status: 'proven', reason: 'proven' });
    expect(await h.store.status(1, WORKTREE, 'web')).toBe('proven');
    // Still a pure read — nothing was re-stamped.
    expect(persistedRow(h.db).input_hash).toBeNull();
    h.db.close();
  });

  it('reads drifted once the tree grows a package.json — real drift, not the legacy case', async () => {
    const h = makeHarness();
    await proveWebWithLegacyNullInputHash(h);

    h.state.inputHash = 'npm-hash-v1';
    h.packageJsonExists.add(WORKTREE);

    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({ status: 'unproven-draft', reason: 'drifted' });
    // Non-writing, same as every other drift answer.
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('a NON-legacy record (a real stored hash) still refuses on any hash difference regardless of package.json', async () => {
    const h = makeHarness();
    await proveWeb(h); // ordinary proof — input_hash = 'inputs-v1', not NULL.
    h.state.inputHash = 'inputs-v2';
    h.packageJsonExists.delete(WORKTREE); // package.json absence is irrelevant here — the stored hash isn't NULL.

    expect(await h.store.statusDetail(1, WORKTREE, 'web')).toEqual({ status: 'unproven-draft', reason: 'drifted' });
    h.db.close();
  });

  it('without an injected hasPackageJson dep, a legacy NULL record conservatively reads drifted — never a spurious proven', async () => {
    const db = buildDb();
    const files = new Map<string, string>([[WORKTREE, JSON.stringify(baseRunbook())]]);
    const state = { inputHash: null as string | null, fingerprint: 'host-v1' };
    const store = new VerifyRunbookStore(db, {
      readPortableFile: async (dirPath) => files.get(dirPath) ?? null,
      computeInputHash: async () => state.inputHash,
      hostFingerprint: async () => state.fingerprint,
      // hasPackageJson intentionally omitted — models a wiring that has not
      // added the A0 dep yet.
    });

    const registered = await store.registerDraft(1, WORKTREE, 'web');
    if ('error' in registered) throw new Error(registered.error);
    expect(store.markProven(1, 'web', registered.hash, registered.version, '{}')).toEqual({ ok: true });

    state.inputHash = 'fallback-hash-v1';
    expect(await store.statusDetail(1, WORKTREE, 'web')).toEqual({ status: 'unproven-draft', reason: 'drifted' });
    db.close();
  });
});

/**
 * A8 (RS-12): `registerDraft` is a no-op when the computed portable hash AND
 * `bindingsJson` both equal those of an EXISTING PROVEN record — see the
 * method's own doc for why an idempotent re-register must not silently demote
 * a proof that changed nothing.
 */
describe('VerifyRunbookStore.registerDraft — A8 no-op over an unchanged proven record', () => {
  it('is a no-op — same hash and same bindings over a proven record write NOTHING and return it unchanged', async () => {
    const h = makeHarness();
    const registered = await h.store.registerDraft(1, WORKTREE, 'web', '{"chromium":"/usr/bin/chromium"}');
    if ('error' in registered) throw new Error(registered.error);
    expect(h.store.markProven(1, 'web', registered.hash, registered.version, '{"sha":"deadbeef"}')).toEqual({
      ok: true,
    });
    const before = persistedRow(h.db);

    const again = await h.store.registerDraft(1, WORKTREE, 'web', '{"chromium":"/usr/bin/chromium"}');
    expect('error' in again).toBe(false);
    if ('error' in again) return;
    expect(again).toEqual({ hash: registered.hash, version: registered.version });

    // Byte-for-byte the same record: nothing was written.
    expect(persistedRow(h.db)).toEqual(before);
    expect(persistedStatus(h.db)).toBe('proven');
    h.db.close();
  });

  it('treats an omitted bindingsJson as matching a previously-omitted one (both normalize to NULL)', async () => {
    const h = makeHarness();
    const registered = await h.store.registerDraft(1, WORKTREE, 'web'); // no bindingsJson
    if ('error' in registered) throw new Error(registered.error);
    expect(h.store.markProven(1, 'web', registered.hash, registered.version, '{}')).toEqual({ ok: true });
    const before = persistedRow(h.db);

    const again = await h.store.registerDraft(1, WORKTREE, 'web'); // still no bindingsJson
    expect(again).toEqual({ hash: registered.hash, version: registered.version });
    expect(persistedRow(h.db)).toEqual(before);
    h.db.close();
  });

  it('demotes to unproven-draft, bumping the version and clearing the proof, when only bindings differ', async () => {
    const h = makeHarness();
    const registered = await h.store.registerDraft(1, WORKTREE, 'web', '{"chromium":"/usr/bin/chromium"}');
    if ('error' in registered) throw new Error(registered.error);
    expect(h.store.markProven(1, 'web', registered.hash, registered.version, '{"sha":"deadbeef"}')).toEqual({
      ok: true,
    });

    const changed = await h.store.registerDraft(1, WORKTREE, 'web', '{"chromium":"/opt/homebrew/bin/chromium"}');
    expect('error' in changed).toBe(false);
    if ('error' in changed) return;
    expect(changed.hash).toBe(registered.hash); // content itself is unchanged
    expect(changed.version).toBe(registered.version + 1); // still bumped — A8 does not apply

    const row = persistedRow(h.db);
    expect(row.status).toBe('unproven-draft');
    expect(row.proof_json).toBeNull();
    expect(row.bindings_json).toBe('{"chromium":"/opt/homebrew/bin/chromium"}');
    h.db.close();
  });

  it('still demotes on any content difference, exactly as before A8, even with identical bindings', async () => {
    const h = makeHarness();
    const registered = await h.store.registerDraft(1, WORKTREE, 'web', '{"x":"y"}');
    if ('error' in registered) throw new Error(registered.error);
    expect(h.store.markProven(1, 'web', registered.hash, registered.version, '{}')).toEqual({ ok: true });

    const edited = baseRunbook();
    edited.modalities.web = {
      serve: { cmd: 'pnpm preview --port ${PORT}' },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    };
    h.files.set(WORKTREE, JSON.stringify(edited));

    const changed = await h.store.registerDraft(1, WORKTREE, 'web', '{"x":"y"}');
    expect('error' in changed).toBe(false);
    if ('error' in changed) return;
    expect(changed.hash).not.toBe(registered.hash);
    expect(changed.version).toBe(registered.version + 1);
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('does NOT no-op when the existing record is a draft, never proven — a draft always bumps on re-register', async () => {
    const h = makeHarness();
    const first = await h.store.registerDraft(1, WORKTREE, 'web', '{"x":"y"}');
    if ('error' in first) throw new Error(first.error);
    // Never proven.

    const second = await h.store.registerDraft(1, WORKTREE, 'web', '{"x":"y"}');
    if ('error' in second) throw new Error(second.error);
    expect(second.hash).toBe(first.hash);
    expect(second.version).toBe(first.version + 1); // bumped — no proven record to protect
    expect(persistedStatus(h.db)).toBe('unproven-draft');
    h.db.close();
  });

  it('registering a brand-new (project, modality) with no existing record at all is unaffected by A8', async () => {
    const h = makeHarness();
    const result = await h.store.registerDraft(1, WORKTREE, 'cdp-app');
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.version).toBe(1);
    h.db.close();
  });
});
