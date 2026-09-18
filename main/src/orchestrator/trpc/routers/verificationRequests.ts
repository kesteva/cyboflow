/**
 * cyboflow.verificationRequests sub-router (L6 / S7).
 *
 * Read-only typed tRPC contract backing the renderer's Verify-Queue panel — a
 * pure observability view over the `verification_requests` work queue (migration
 * 036 + `judge_calls_used` from 037). It MIRRORS the artifacts router's `list`
 * query exactly: a `protectedProcedure`, reaching the DB via `ctx.db`
 * (DatabaseLike), returning the shared `VerificationRequestRow[]` consumed on the
 * frontend by AppRouter inference ONLY (native tRPC serialization — NO IPCResponse
 * wrapper, no `{ success; data?; error? }` shape).
 *
 *   - list   : query -> VerificationRequestListRow[] (a project's verify requests,
 *              optionally narrowed by runId + status), newest-enqueued first, each
 *              enriched with its ORIGIN SESSION (run → session LEFT JOIN) for the
 *              panel's per-card session pill, and — additively, migration 095 —
 *              the classifier's `failureClass`/`modality`/`setupProof`/
 *              `failureEvidence` (docs/proposals/verification-setup-flow.md §3.1/
 *              §3.6). See {@link shapeRow}.
 *   - budget : query -> VerificationBudgetSummary (§3.6 "surface budget state in
 *              the Verify Queue") — a SIBLING query, not a field folded into
 *              `list`'s response, so `list` stays a flat array the renderer can
 *              index with `[number]` (`useVerificationRequests.ts`). Mirrors the
 *              exact `projects.visual_verify_budget_calls` /
 *              `SUM(judge_calls_used)` pair `VerificationScheduler
 *              .isProjectBudgetExhausted` already enforces at enqueue time
 *              (migration 056), so the number the panel shows can never
 *              silently diverge from the number the scheduler acts on.
 *
 *   - health : query -> VerificationHealthSummary (§6, the phase-3 health panel)
 *              — per-modality attempts / pass rate / failure-class histogram /
 *              median duration, the capability ledger (migration 095) with its
 *              re-probe TTLs resolved into a live `suppressionActive` bit, and
 *              setup-proof traffic counted APART from lane traffic (§8's
 *              "separate counter"). A third sibling query for the same reason
 *              `budget` is one: each has its own shape and its own refresh
 *              cadence in the panel.
 *
 *   - setupByProject : query -> VerifyProjectSetupRow[] (§6's project list) —
 *              whether EACH project has a proven runbook, in one pass over
 *              `verify_runbook_local`. Verification is configured per project,
 *              so a single global setup button can only ever speak for the
 *              selected one. `'proven'` is confirmed against the LIVE
 *              conjunction (`ctx.verifyRunbookStatus`), not the stored column —
 *              see {@link effectiveRunbookStatus}; the same applies to
 *              `health`'s per-modality `runbook.status`.
 *
 *   - hostProbes / provisionChromium : the §6 live host-capability probes and
 *              the chromium fix-it action. `provisionChromium` is the only
 *              mutation here and is NOT an entity write — it touches the host's
 *              browser cache, never the DB — so the read-only-over-the-schema
 *              property below is unaffected.
 *
 * The panel performs NO entity mutations (Accept-as-baseline lives on the
 * artifact verdict banner, S6) — this router stays read-only over the existing
 * schema, so there is no new migration and no chokepoint write path here.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import type { VerifyHostProbesLike, VerifyRunbookStatusLike } from '../context';
import type { VerifyRunbookStatus } from '../../verify/runbookStore';
import {
  REQUEST_STATUS,
  TERMINAL_REQUEST_STATUSES,
  VERIFICATION_FAILURE_CLASSES,
  VERIFICATION_MODALITIES,
  isVerificationFailureClass,
  isVerificationModality,
  type RequestStatus,
  type VerificationBudgetSummary,
  type VerificationCapabilityState,
  type VerificationFailureEvidence,
  type VerificationFailureHistogramKey,
  type VerificationHealthSummary,
  type VerificationModality,
  type VerificationModalityHealth,
  type VerificationOutcomeStats,
  type VerificationRunbookState,
  type VerificationRequestListRow,
  type VerificationType,
  type NativeGrantProbe,
  type VerifyHostProbeReport,
  type VerifyProbeFix,
  type VerifyProbeRow,
  type VerifyProjectSetupRow,
  type VisualBackendId,
} from '../../../../../shared/types/visualVerification';

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[verificationRequests.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/**
 * The raw `verification_requests` row as SQLite hands it back. snake_case mirrors
 * the columns; the nullable TEXT columns come back as `string | null`, numeric
 * columns as `number`. `chain_json` is nullable in the schema (NULL until the
 * scheduler resolves the live chain), but the panel-facing
 * {@link VerificationRequestRow} declares it non-null — {@link shapeRow}
 * normalizes NULL to an empty JSON array string so the renderer always parses a
 * valid `VisualBackendId[]`.
 */
interface VerificationRequestDbRow {
  id: string;
  run_id: string;
  project_id: number;
  status: string;
  verify_type: string;
  deliverable_json: string;
  chain_json: string | null;
  current_backend: string | null;
  attempt: number;
  verdict_json: string | null;
  error_message: string | null;
  enqueued_at: string;
  leased_at: string | null;
  ended_at: string | null;
  // Migration-078 columns (nullable on every pre-078 / legacy-engine row).
  task_json: string | null;
  report_json: string | null;
  delivery_state: string | null;
  snapshot_sha: string | null;
  enqueue_key: string | null;
  // Origin-session columns, LEFT-JOINed from workflow_runs → sessions (see the
  // list query). Both NULL when the run has no session row.
  session_id: string | null;
  session_name: string | null;
  // Migration-095 columns (verification-setup-flow.md §3.1/§3.6) — `undefined`
  // (not `null`) on a pre-095 DB, since `SELECT vr.*` simply omits a column
  // that does not exist yet; `null` on a post-095 row the classifier never
  // stamped (failure_class/modality/failure_evidence_json — all nullable TEXT,
  // no CHECK domain per the migration's own note) or a non-terminal/passed row.
  // `setup_proof` alone is `NOT NULL DEFAULT 0`, so it is a plain `number` on
  // every post-095 row and only `undefined` pre-095.
  failure_class: string | null | undefined;
  failure_evidence_json: string | null | undefined;
  modality: string | null | undefined;
  setup_proof: number | undefined;
}

/**
 * Parse `verification_requests.failure_evidence_json` into
 * {@link VerificationFailureEvidence}[] — FAIL-SOFT to `undefined` on
 * anything short of a well-shaped array (absent/NULL column, invalid JSON, a
 * non-array payload, or an array entry missing the `source`/`detail` strings
 * the type requires). Deliberately does not validate `source` against its
 * literal union — the health-panel audit trail (phase 3) is meant to survive
 * a future-added source value from a newer binary without this reader going
 * stale (mirrors the migration's own no-CHECK-domain posture on the column).
 */
function parseFailureEvidence(json: string | null | undefined): VerificationFailureEvidence[] | undefined {
  if (json === null || json === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const wellShaped = parsed.every(
      (entry): entry is VerificationFailureEvidence =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { source?: unknown }).source === 'string' &&
        typeof (entry as { detail?: unknown }).detail === 'string',
    );
    return wellShaped ? (parsed as VerificationFailureEvidence[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map one DB row to the shared {@link VerificationRequestRow}. The `status` /
 * `verify_type` / `current_backend` TEXT columns are constrained at write time
 * (the SQL CHECK domain + the resolver), so the read side asserts them onto their
 * union types rather than re-validating. `chain_json` NULL → '[]' (see the row
 * doc) keeps the renderer's `JSON.parse(chain_json)` safe.
 */
function shapeRow(r: VerificationRequestDbRow): VerificationRequestListRow {
  return {
    id: r.id,
    run_id: r.run_id,
    project_id: r.project_id,
    status: r.status as RequestStatus,
    verify_type: r.verify_type as VerificationType,
    deliverable_json: r.deliverable_json,
    chain_json: r.chain_json ?? '[]',
    current_backend: (r.current_backend as VisualBackendId | null) ?? null,
    attempt: r.attempt,
    verdict_json: r.verdict_json,
    error_message: r.error_message,
    enqueued_at: r.enqueued_at,
    leased_at: r.leased_at,
    ended_at: r.ended_at,
    // Migration-078 columns — `SELECT *` already fetches them; `?? null` keeps a
    // pre-078 test DB (column absent ⇒ undefined) shaping to the declared null.
    task_json: r.task_json ?? null,
    report_json: r.report_json ?? null,
    delivery_state: r.delivery_state ?? null,
    snapshot_sha: r.snapshot_sha ?? null,
    enqueue_key: r.enqueue_key ?? null,
    // LEFT-JOIN columns — `undefined` (no matching run/session row) shapes to the
    // declared null so the renderer's pill fallback has one shape to test.
    session_id: r.session_id ?? null,
    session_name: r.session_name ?? null,
    // Migration-095 derived fields (§3.1/§3.6) — see the VerificationRequestListRow
    // doc for why these are OPTIONAL/camelCase rather than the raw-passthrough
    // `| null` convention above: each one FAIL-SOFT's to `undefined`, never
    // passing an unvalidated raw value through.
    failureClass: isVerificationFailureClass(r.failure_class) ? r.failure_class : undefined,
    modality: isVerificationModality(r.modality) ? r.modality : undefined,
    // `=== 1` (not a bare truthiness check) — `undefined` (pre-095 column absent)
    // must resolve to `false` exactly like `0` does, never to `undefined` itself:
    // setupProof is a concrete boolean on every row the type declares it on.
    setupProof: r.setup_proof === 1,
    failureEvidence: parseFailureEvidence(r.failure_evidence_json),
  };
}

// ---------------------------------------------------------------------------
// health — the phase-3 panel's aggregation (§6)
// ---------------------------------------------------------------------------

const TERMINAL_SET: ReadonlySet<string> = new Set<string>(TERMINAL_REQUEST_STATUSES);

/** Mutable accumulator behind one {@link VerificationOutcomeStats} bucket. */
interface StatsAccumulator {
  attempts: number;
  inFlight: number;
  passed: number;
  outcomes: Record<RequestStatus, number>;
  failures: Record<VerificationFailureHistogramKey, number>;
  /** Every observed `leased_at → ended_at` span, unsorted; the median is taken at finalize. */
  durations: number[];
}

function newAccumulator(): StatsAccumulator {
  const outcomes = {} as Record<RequestStatus, number>;
  for (const s of REQUEST_STATUS) outcomes[s] = 0;
  const failures = {} as Record<VerificationFailureHistogramKey, number>;
  for (const c of VERIFICATION_FAILURE_CLASSES) failures[c] = 0;
  failures.unclassified = 0;
  return { attempts: 0, inFlight: 0, passed: 0, outcomes, failures, durations: [] };
}

/**
 * Fold one request row into a bucket.
 *
 * A row is an ATTEMPT only once terminal; the three in-flight states are
 * counted apart so a busy queue cannot depress the pass rate. `failure_class`
 * is tallied for every NON-PASSING terminal row — an unstamped one lands in
 * `unclassified` rather than vanishing, so the histogram always reconciles
 * against `attempts - passed`.
 *
 * A status outside `REQUEST_STATUS` therefore falls to `inFlight` — which is
 * unreachable today and deliberately left that way: migration 055 puts a CHECK
 * on the column whose domain is exactly `REQUEST_STATUS`. If a status is ever
 * added to the SQL CHECK without the TypeScript union (the drift 055's header
 * warns about), a visibly stuck "in flight" is the better failure than a
 * phantom terminal attempt silently depressing the pass rate.
 */
function accumulate(acc: StatsAccumulator, row: HealthDbRow): void {
  const status = row.status;
  if (!TERMINAL_SET.has(status)) {
    acc.inFlight += 1;
    return;
  }
  acc.attempts += 1;
  if (status in acc.outcomes) acc.outcomes[status as RequestStatus] += 1;

  if (status === 'passed') {
    acc.passed += 1;
  } else {
    const cls = isVerificationFailureClass(row.failure_class) ? row.failure_class : 'unclassified';
    acc.failures[cls] += 1;
  }

  // `duration_ms` is computed in SQL via julianday() rather than parsed here:
  // these columns hold BOTH SQLite's 'YYYY-MM-DD HH:MM:SS' default and ISO-8601
  // strings depending on the writer, and Date.parse reads the former as LOCAL
  // time and the latter as UTC — mixing them would silently skew every span by
  // the host's offset. julianday() treats both as UTC.
  if (typeof row.duration_ms === 'number' && Number.isFinite(row.duration_ms) && row.duration_ms >= 0) {
    acc.durations.push(row.duration_ms);
  }
}

/** Median of a non-empty numeric list (mean of the middle pair when even), rounded to an integer ms. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function finalize(acc: StatsAccumulator): VerificationOutcomeStats {
  return {
    attempts: acc.attempts,
    inFlight: acc.inFlight,
    passed: acc.passed,
    // null, never 0, when there is nothing to divide — "no data" and "never
    // passed" are different facts and the panel renders them differently.
    passRate: acc.attempts === 0 ? null : acc.passed / acc.attempts,
    outcomes: acc.outcomes,
    failures: acc.failures,
    medianDurationMs: median(acc.durations),
  };
}

/**
 * The columns `health` reads. Selected as `*` plus a computed span (see the
 * query) so a PRE-095 database — where `modality` / `failure_class` /
 * `setup_proof` do not exist yet — returns `undefined` for them rather than
 * throwing "no such column", exactly as the `list` query already relies on.
 */
interface HealthDbRow {
  status: string;
  ended_at: string | null;
  judge_calls_used: number | undefined;
  duration_ms: number | null;
  modality: string | null | undefined;
  failure_class: string | null | undefined;
  setup_proof: number | undefined;
}

/** Raw `verify_capability_state` row plus the current host generation for the derived `suppressionActive` bit. */
interface CapabilityDbRow {
  modality: string;
  runbook_hash: string;
  status: string;
  reason: string;
  consecutive_env_failures: number;
  host_generation: number;
  suppressed_until: string | null;
}

/**
 * The ledger key the ENGINE will use for a modality's next request.
 *
 * `verify_capability_state` is keyed `(project, modality, runbook_hash)`, and
 * the scheduler looks up exactly one of those triples: the request's PIN hash
 * (`capabilityRunbookKey` → `runbookPinForRow(...).hash ?? ''`). A pin only
 * ever resolves to a PROVEN revision, so an unproven-draft or absent runbook
 * means the engine reads the phase-0 `''` key — migration 095's column default.
 *
 * Selecting any other row (e.g. "the most recently updated one") reports a
 * suppression the engine will not honour, or hides one it will: a stale
 * revision's row can be written LAST when an old pinned request finishes after
 * a new runbook is registered.
 */
function capabilityLedgerKey(runbook: VerificationRunbookState | undefined): string {
  return runbook?.status === 'proven' ? runbook.portableHash : '';
}

/**
 * Read the capability ledger for a project, taking the row the engine reads.
 *
 * FAIL-SOFT to an empty map, mirroring `VerifyCapabilityStore`'s own posture:
 * on a pre-095 DB the tables do not exist, and a ledger hiccup must degrade the
 * panel to "nothing recorded" rather than fail the whole health query.
 *
 * A modality can hold several rows (one per `runbook_hash`) and only ONE of
 * them is live — see {@link capabilityLedgerKey}.
 */
function readCapabilities(
  db: DatabaseLike,
  projectId: number,
  runbooks: Map<VerificationModality, VerificationRunbookState>,
  hostGeneration: number,
  now: number,
): Map<VerificationModality, VerificationCapabilityState> {
  const out = new Map<VerificationModality, VerificationCapabilityState>();
  let rows: CapabilityDbRow[] = [];
  try {
    rows = db
      .prepare(
        `SELECT modality, runbook_hash, status, reason, consecutive_env_failures, host_generation, suppressed_until
           FROM verify_capability_state
          WHERE project_id = ?`,
      )
      .all(projectId) as CapabilityDbRow[];
  } catch {
    return out;
  }

  for (const row of rows) {
    if (!isVerificationModality(row.modality)) continue;
    // The PK is (project, modality, runbook_hash), so this admits at most one
    // row per modality — the same one `getActiveSuppression` will read.
    if (row.runbook_hash !== capabilityLedgerKey(runbooks.get(row.modality))) continue;
    const status =
      row.status === 'suppressed' || row.status === 'unsupported' || row.status === 'active'
        ? row.status
        : 'active';
    // Mirrors VerifyCapabilityStore.getActiveSuppression (§3.3): a tripped row
    // is only IN FORCE while its TTL is unexpired AND its stamped generation
    // still matches the host's. Either condition lapsing makes it inert, and
    // the next request re-attempts freely — showing raw `status` alone would
    // report a modality as blocked that the engine has already moved past.
    const untilMs = row.suppressed_until === null ? null : Date.parse(row.suppressed_until);
    const ttlLive = untilMs !== null && Number.isFinite(untilMs) && untilMs > now;
    const suppressionActive =
      status !== 'active' && ttlLive && row.host_generation === hostGeneration;

    out.set(row.modality, {
      status,
      reason: row.reason,
      consecutiveEnvFailures: row.consecutive_env_failures,
      suppressedUntil: row.suppressed_until,
      hostGeneration: row.host_generation,
      suppressionActive,
    });
  }
  return out;
}

/**
 * Read the project's runbook records (migration 096), keyed by modality.
 * Fail-soft to empty on a pre-096 DB, same posture as the capability ledger.
 */
async function readRunbooks(
  db: DatabaseLike,
  projectId: number,
  resolveStatus: VerifyRunbookStatusLike | undefined,
): Promise<Map<VerificationModality, VerificationRunbookState>> {
  const out = new Map<VerificationModality, VerificationRunbookState>();
  let rows: { modality: string; status: string; version: number; portable_hash: string; origin?: string | null }[] =
    [];
  try {
    // Migration 105's `origin` through the same widen-then-fall-back ladder the
    // rest of verify/ uses: a pre-105 DB throws on `prepare`, and losing the
    // whole runbook listing to that would blank the panel on a binary that has
    // records. The fallback drops only the provenance such a DB never had.
    try {
      rows = db
        .prepare(
          `SELECT modality, status, version, portable_hash, origin
             FROM verify_runbook_local
            WHERE project_id = ?`,
        )
        .all(projectId) as typeof rows;
    } catch {
      rows = db
        .prepare(
          `SELECT modality, status, version, portable_hash
             FROM verify_runbook_local
            WHERE project_id = ?`,
        )
        .all(projectId) as typeof rows;
    }
  } catch {
    return out;
  }
  for (const row of rows) {
    if (!isVerificationModality(row.modality)) continue;
    if (row.status !== 'proven' && row.status !== 'unproven-draft') continue;
    // `version` / `portableHash` come from the RECORD (they identify the
    // revision), but a PROVEN one has its status re-confirmed against the live
    // conjunction — see {@link effectiveRunbookStatus}. A record can name a
    // revision that no longer holds in this tree; that is worth showing,
    // mislabelled is not.
    //
    // A stored draft is NOT probed: the conjunction can only ever demote, so
    // re-checking one could not promote it and would only spend a file read.
    // (It also matters for correctness here — a resolver answering 'proven'
    // must never be able to launder a draft into a proof.)
    const status: VerifyRunbookStatus =
      row.status === 'proven'
        ? await effectiveRunbookStatus(resolveStatus, projectId, row.modality)
        : 'unproven-draft';
    if (status === 'absent') continue;
    out.set(row.modality, {
      status,
      version: row.version,
      portableHash: row.portable_hash,
      // An unrecognized value is reported as `null` — "unknown", not a guess.
      origin: row.origin === 'setup-flow' || row.origin === 'lane-bootstrap' ? row.origin : null,
    });
  }
  return out;
}

/**
 * The status the ENGINE would resolve for this (project, modality) — not the
 * `verify_runbook_local.status` column.
 *
 * The column is one conjunct. `VerifyRunbookStore.status()` re-checks the whole
 * conjunction on every read — a portable file present in the probed tree must
 * hash to the record, AND the project input-hash AND the host fingerprint must
 * match (a tree with no file skips only the first conjunct: the proof executes
 * the record's own copy, F10) — as a pure read that writes nothing back (F4),
 * and the degrade gate + the enqueue-time pin both go through it. A record
 * left reading `'proven'` after the lockfile moved on, or after the runbook
 * file was edited, is the exact case this indirection exists for: the gate
 * skips every request with "no proven verification runbook" while the panel
 * shows a green "Set up".
 *
 * Unwired resolver ⇒ `'unproven-draft'`, never `'proven'` (see
 * {@link ContextDeps.verifyRunbookStatus}), and a THROWING resolver degrades the
 * same way rather than failing the whole panel query: one modality whose probe
 * blew up must not blank out a project's health.
 */
async function effectiveRunbookStatus(
  resolveStatus: VerifyRunbookStatusLike | undefined,
  projectId: number,
  modality: VerificationModality,
): Promise<VerifyRunbookStatus> {
  if (resolveStatus === undefined) return 'unproven-draft';
  try {
    // The panel asks a PROJECT-level question, so no probe path is passed and
    // the resolver falls back to the project root. The reason discriminant the
    // resolver also carries is for a caller that WRITES (the runbook bootstrap);
    // the badge only needs the three-valued answer.
    return (await resolveStatus(projectId, modality)).status;
  } catch {
    return 'unproven-draft';
  }
}

/** The singleton host capability generation; 0 when the row/table is absent (fresh install — nothing is stale). */
function readHostGeneration(db: DatabaseLike): number {
  try {
    const row = db
      .prepare('SELECT capability_generation FROM verify_host_state WHERE id = 1')
      .get() as { capability_generation: number } | undefined;
    return row?.capability_generation ?? 0;
  } catch {
    return 0;
  }
}

/** Bound a probe's detail string so a pathological error message cannot bloat the response. */
function detail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}…` : flat;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One constituent of the rolled-up `browser-driving` row.
 *
 * Kept as an internal shape rather than a `VerifyProbeRow` because these are
 * NOT separately actionable: a user cannot do anything about node or the driver
 * CLI, and a host where any one of the three is absent drives no browser at
 * all. They collapse into one row whose detail names whichever parts fell over.
 */
interface DrivingPart {
  name: string;
  state: 'ok' | 'missing' | 'inconclusive';
  detail: string;
  fix: VerifyProbeFix;
}

/** node — the one probe whose rejection IS affirmative evidence (preflight's sole exception). */
async function probeNodePart(probes: VerifyHostProbesLike): Promise<DrivingPart> {
  try {
    return { name: 'node', state: 'ok', detail: await probes.resolveNode(), fix: null };
  } catch (err) {
    return { name: 'node', state: 'missing', detail: errorText(err), fix: null };
  }
}

/** chromium — provisioning, not consent: a miss is fixable in place (§6). */
async function probeChromiumPart(probes: VerifyHostProbesLike): Promise<DrivingPart> {
  try {
    const chromium = await probes.resolveChromium();
    return chromium === null
      ? { name: 'chromium', state: 'missing', detail: 'not installed', fix: 'provision-chromium' }
      : { name: 'chromium', state: 'ok', detail: chromium, fix: null };
  } catch (err) {
    return { name: 'chromium', state: 'inconclusive', detail: errorText(err), fix: null };
  }
}

async function probeDriverCliPart(probes: VerifyHostProbesLike): Promise<DrivingPart> {
  try {
    const cli = await probes.probeDriverCli();
    return {
      name: 'driver CLI',
      state: cli.exists ? 'ok' : 'missing',
      detail: cli.exists ? cli.path : `absent at ${cli.path}`,
      fix: null,
    };
  } catch (err) {
    return { name: 'driver CLI', state: 'inconclusive', detail: errorText(err), fix: null };
  }
}

/**
 * Collapse node + chromium + driver CLI into the single `browser-driving` row.
 *
 * Precedence is missing > inconclusive > ok, and the detail names EVERY failing
 * part rather than just the first — a host missing two of the three would
 * otherwise send the user round the loop twice. The offered fix is the first
 * failing part that has one (only chromium ever does).
 *
 * On success the detail is the chromium path: node and the driver CLI are ours
 * and always resolve to the same uninteresting places, while the browser is the
 * one that varies per host and is worth being able to read back.
 */
export function foldDrivingParts(parts: DrivingPart[]): VerifyProbeRow {
  const failed = parts.filter((p) => p.state !== 'ok');
  if (failed.length === 0) {
    const chromium = parts.find((p) => p.name === 'chromium');
    return {
      id: 'browser-driving',
      state: 'ok',
      detail: detail(chromium?.detail ?? 'ready'),
      fix: null,
    };
  }
  return {
    id: 'browser-driving',
    // A single unanswerable part poisons the row to 'inconclusive' only when
    // nothing else is affirmatively absent — a real absence is the stronger
    // fact and the one with an action attached.
    state: failed.some((p) => p.state === 'missing') ? 'missing' : 'inconclusive',
    detail: detail(failed.map((p) => `${p.name}: ${p.detail}`).join(' · ')),
    fix: failed.find((p) => p.fix !== null)?.fix ?? null,
  };
}

/**
 * The two macOS TCC grant rows, ALWAYS both present.
 *
 * A probe that could not answer yields `'inconclusive'` for both, never
 * `'missing'`: the fail-open rule from `preflight.ts`, and here it is the
 * difference between "grant this" and "we could not tell", which is the
 * difference between a useful instruction and a wild goose chase.
 */
async function grantRows(probes: VerifyHostProbesLike): Promise<VerifyProbeRow[]> {
  const probe = await readGrants(probes);
  if (probe.kind !== 'ok') {
    return [
      { id: 'screen-recording', state: 'inconclusive', detail: detail(probe.detail), fix: null },
      { id: 'accessibility', state: 'inconclusive', detail: detail(probe.detail), fix: null },
    ];
  }
  return [
    probe.screenRecording
      ? { id: 'screen-recording', state: 'ok', detail: 'granted', fix: null }
      : {
          id: 'screen-recording',
          state: 'missing',
          detail: 'not granted — screenshots of a running app return blank or fail',
          fix: 'open-screen-recording-settings',
        },
    probe.accessibility
      ? {
          id: 'accessibility',
          state: 'ok',
          // The §8 disclosure that used to be its own 'native-drive' row: the
          // grant is held, but nothing yet uses it to drive. Said here because
          // this is the grant driving would need — and because a bare "granted"
          // would imply a capability that does not exist.
          detail:
            'granted — brings a window forward before capture; no drive API yet, so capture is observe-only',
          fix: null,
        }
      : {
          id: 'accessibility',
          state: 'missing',
          // Deliberately NOT "capture cannot target a window": peekaboo names
          // this grant OPTIONAL and needs it for window FOCUS control, so a
          // backgrounded window still captures without it. Overstating the
          // consequence would send someone chasing a permission to fix
          // something that is not broken.
          detail: 'not granted — a background window cannot be raised before capture',
          fix: 'request-accessibility',
        },
  ];
}

/**
 * The `'mobile-simulator'` row — the iOS-Simulator toolchain, rolled up the way
 * `'browser-driving'` rolls up the browser one.
 *
 * `grantRows`' fail-open discipline, applied to a row that arrives pre-folded:
 * no composition wired, or a composition that threw, is `'inconclusive'` and
 * NEVER `'missing'`. The mapping from the three-way toolchain verdict to this
 * state lives in `mobileComposition.ts` (an Xcode-shaped type cannot cross into
 * this standalone-typechecked tree); the discipline over a probe that could not
 * answer at all lives here, next to the other rows that keep it.
 *
 * `fix` is forced to `null` in EVERY state, including one the composition
 * reported as `'missing'`. Neither Xcode nor Maestro is something this app can
 * install, so there is no state of this row with an action behind it, and
 * offering one would be a button that opens a download page and calls it a fix.
 */
async function mobileRow(probes: VerifyHostProbesLike): Promise<VerifyProbeRow> {
  if (probes.mobileSimulator === undefined) {
    return {
      id: 'mobile-simulator',
      state: 'inconclusive',
      detail: detail('no mobile toolchain probe wired on this host'),
      fix: null,
    };
  }
  try {
    const row = await probes.mobileSimulator();
    return { ...row, id: 'mobile-simulator', detail: detail(row.detail), fix: null };
  } catch (err) {
    // The composition's contract says it never throws; honour the fail-open
    // rule anyway rather than letting a contract violation read as a host that
    // affirmatively has no Xcode.
    return { id: 'mobile-simulator', state: 'inconclusive', detail: detail(errorText(err)), fix: null };
  }
}

/** Read the grants, mapping an unwired backend and a thrown probe alike to a reason string. */
async function readGrants(probes: VerifyHostProbesLike): Promise<NativeGrantProbe> {
  if (probes.nativeGrants === undefined) {
    return { kind: 'inconclusive', detail: 'no native capture backend wired on this host' };
  }
  try {
    return await probes.nativeGrants();
  } catch (err) {
    // The contract says it never throws; honour the fail-open rule anyway
    // rather than letting a contract violation read as a denied permission.
    return { kind: 'inconclusive', detail: errorText(err) };
  }
}

/**
 * Run the host probes and shape them into the four panel rows.
 *
 * The fail-open rule from `preflight.ts` is reproduced EXACTLY here: a probe
 * that rejects is `'inconclusive'`, never `'missing'`. The single exception is
 * `resolveNode` — "node is unresolvable" is itself the fact being checked, and
 * there is no state in which the harness could proceed without it.
 *
 * All four rows are UNCONDITIONAL, and none of them is softened by what the
 * project happens to need — the mobile row included: whether this host can
 * stand up an iOS Simulator is exactly the question asked while deciding
 * whether to declare the `mobile` modality at all. The grants used to appear only once some runbook
 * declared `native-screen`, which meant the one moment you needed to know
 * whether screen capture works here — while deciding whether to declare it —
 * was the one moment the panel would not say. Making the ANSWER conditional
 * instead of the row had the same defect in a quieter form: a capability
 * reported as "not needed" is a capability whose absence you find out about
 * when you first try to use it.
 */
async function runHostProbes(probes: VerifyHostProbesLike): Promise<VerifyProbeRow[]> {
  const [node, chromium, cli, grants, mobile] = await Promise.all([
    probeNodePart(probes),
    probeChromiumPart(probes),
    probeDriverCliPart(probes),
    grantRows(probes),
    mobileRow(probes),
  ]);
  return [foldDrivingParts([node, chromium, cli]), ...grants, mobile];
}

export const verificationRequestsRouter = router({
  /**
   * List a project's verification requests (newest enqueued first), optionally
   * narrowed to a single run and/or a single lifecycle status. Read-only over the
   * existing 036/037 schema — every column the {@link VerificationRequestRow}
   * shape declares is projected; columns it does not declare (`judge_calls_used`)
   * are ignored.
   */
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        runId: z.string().min(1).optional(),
        status: z.enum(REQUEST_STATUS as readonly [RequestStatus, ...RequestStatus[]]).optional(),
      }),
    )
    .query(async ({ input, ctx }): Promise<VerificationRequestListRow[]> => {
      const db = requireDb(ctx.db, 'list');
      // Every predicate is qualified with the `vr.` alias — workflow_runs carries
      // its OWN project_id / status columns, so an unqualified clause would be
      // ambiguous (or worse, silently filter on the RUN's status) once joined.
      const clauses = ['vr.project_id = ?'];
      const params: unknown[] = [input.projectId];
      if (input.runId !== undefined) {
        clauses.push('vr.run_id = ?');
        params.push(input.runId);
      }
      if (input.status !== undefined) {
        clauses.push('vr.status = ?');
        params.push(input.status);
      }
      // Two LEFT JOINs resolve the request's ORIGIN SESSION (run → session) for
      // the panel's session pill. LEFT (not INNER) so a request whose run or
      // session row is gone still lists — the pill degrades to the run id.
      const rows = db
        .prepare(
          `SELECT vr.*, wr.session_id AS session_id, s.name AS session_name
             FROM verification_requests vr
             LEFT JOIN workflow_runs wr ON wr.id = vr.run_id
             LEFT JOIN sessions s ON s.id = wr.session_id
            WHERE ${clauses.join(' AND ')}
            ORDER BY vr.enqueued_at DESC, vr.id DESC`,
        )
        .all(...params) as VerificationRequestDbRow[];
      return rows.map(shapeRow);
    }),

  /**
   * Per-project verify-budget summary (§3.6). A SIBLING query to `list` — see
   * the file header doc for why this is not a field folded into the list
   * response. Reads the EXACT SAME pair
   * `VerificationScheduler.isProjectBudgetExhausted` enforces at enqueue time
   * (`projects.visual_verify_budget_calls`, NULL = unlimited;
   * `SUM(verification_requests.judge_calls_used)` for the project's
   * lifetime, migration 056) so the panel's number can never silently
   * diverge from the number the scheduler actually acts on. `projectName`
   * is `undefined` only when the project row itself is gone (a router-
   * integrity edge case, not expected in practice — the caller always has a
   * live project selected).
   */
  budget: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ input, ctx }): Promise<VerificationBudgetSummary> => {
      const db = requireDb(ctx.db, 'budget');
      const proj = db
        .prepare('SELECT name, visual_verify_budget_calls AS budget FROM projects WHERE id = ?')
        .get(input.projectId) as { name: string; budget: number | null } | undefined;
      const usedRow = db
        .prepare(
          'SELECT COALESCE(SUM(judge_calls_used), 0) AS used FROM verification_requests WHERE project_id = ?',
        )
        .get(input.projectId) as { used: number } | undefined;
      return {
        projectId: input.projectId,
        projectName: proj?.name,
        budgetCalls: typeof proj?.budget === 'number' ? proj.budget : null,
        usedCalls: usedRow?.used ?? 0,
      };
    }),

  /**
   * Per-project verification health (§6) — the phase-3 panel's aggregation:
   * per-modality attempts / pass rate / failure-class histogram / median
   * duration, the capability ledger with its re-probe TTLs, and setup-proof
   * traffic counted apart from lane traffic.
   *
   * Read-only over the EXISTING schema (055 / 056 / 078 / 095) — no migration.
   * One pass over the project's requests, bucketed in TypeScript rather than by
   * several GROUP BY round-trips, because the same row must land in exactly one
   * of {modality, unattributed, setup-proof} and SQLite has no median anyway.
   *
   * Deliberately a SIBLING of `budget` rather than a superset: the panel shows
   * both, and folding them would duplicate the `SUM(judge_calls_used)` the
   * scheduler's exhaustion check reads — the one number that must not drift.
   */
  health: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ input, ctx }): Promise<VerificationHealthSummary> => {
      const db = requireDb(ctx.db, 'health');

      // `SELECT *` (not a named column list) so a pre-095 DB — no `modality` /
      // `failure_class` / `setup_proof` columns — yields `undefined` for them
      // instead of throwing, the same contract the `list` query depends on. The
      // computed span references only 055 columns, so it is always safe.
      const rows = db
        .prepare(
          // ROUND before CAST: julianday() returns a float, so the scaled
          // difference lands a hair under the true value (a 30s span computes
          // as 29999.999…) and CAST truncates toward zero — every duration
          // would read 1ms short without this.
          `SELECT *,
                  CAST(ROUND((julianday(ended_at) - julianday(leased_at)) * 86400000) AS INTEGER) AS duration_ms
             FROM verification_requests
            WHERE project_id = ?`,
        )
        .all(input.projectId) as HealthDbRow[];

      const byModality = new Map<VerificationModality, StatsAccumulator>();
      const unattributed = newAccumulator();
      const setupProof = newAccumulator();
      let setupProofCallsUsed = 0;

      for (const row of rows) {
        // Setup-proof rows are their own bucket and appear in NO other one
        // (§8's "separate counter"): a proof run is the flow that makes
        // verification work, so folding its attempts into the lane pass rate
        // would show a project as unhealthy exactly while it is being fixed.
        if (row.setup_proof === 1) {
          accumulate(setupProof, row);
          setupProofCallsUsed += typeof row.judge_calls_used === 'number' ? row.judge_calls_used : 0;
          continue;
        }
        if (isVerificationModality(row.modality)) {
          let acc = byModality.get(row.modality);
          if (!acc) {
            acc = newAccumulator();
            byModality.set(row.modality, acc);
          }
          accumulate(acc, row);
          continue;
        }
        accumulate(unattributed, row);
      }

      const hostGeneration = readHostGeneration(db);
      // Runbooks FIRST: they decide which capability row is the live one.
      const runbooks = await readRunbooks(db, input.projectId, ctx.verifyRunbookStatus);
      const capabilities = readCapabilities(db, input.projectId, runbooks, hostGeneration, Date.now());

      // A modality earns a row if it has traffic, a ledger entry, OR a runbook.
      // The latter two matter because a capability suppressed before its first
      // success — or a registered-but-unproven runbook — has no requests to
      // show yet, and those are exactly the states a user needs to see: until a
      // runbook is PROVEN the degrade gate skips every build/serve check for
      // that modality, so "no traffic" is the symptom, not the absence of a
      // problem.
      const modalities: VerificationModalityHealth[] = VERIFICATION_MODALITIES.filter(
        (m) => byModality.has(m) || capabilities.has(m) || runbooks.has(m),
      ).map((m) => ({
        modality: m,
        ...finalize(byModality.get(m) ?? newAccumulator()),
        capability: capabilities.get(m) ?? null,
        runbook: runbooks.get(m) ?? null,
      }));

      return {
        projectId: input.projectId,
        modalities,
        unattributed: finalize(unattributed),
        setupProof: finalize(setupProof),
        setupProofCallsUsed,
        hostGeneration,
      };
    }),

  /**
   * Setup state for EVERY project at once (§6's project list).
   *
   * Verification is configured per project — a runbook is registered against
   * one — so a single global "set up verification" button could only ever
   * speak for whichever project happened to be selected, while saying nothing
   * about the others. This is the query behind showing them all.
   *
   * One pass over `verify_runbook_local`, not one query per project: the table
   * is small, and N round-trips driven by the length of the user's project list
   * is the wrong shape for a panel that opens on every visit.
   *
   * A project with NO runbook row never appears in the result. The caller holds
   * the project list and treats an absent id as `none` — which is also what
   * makes a pre-096 DB (table absent) degrade correctly: every project reads
   * `none`, which is the truth on a host that has never run setup.
   */
  setupByProject: protectedProcedure.query(async ({ ctx }): Promise<VerifyProjectSetupRow[]> => {
    const db = requireDb(ctx.db, 'setupByProject');
    let rows: { project_id: number; modality: string; status: string; origin?: string | null }[] = [];
    try {
      // Migration-105 `origin`, through the widen-then-fall-back ladder: a
      // pre-105 DB throws on `prepare`, and losing the whole setup listing to
      // that would report every project as `not set up` on a binary where they
      // are configured.
      try {
        rows = db
          .prepare('SELECT project_id, modality, status, origin FROM verify_runbook_local')
          .all() as typeof rows;
      } catch {
        rows = db
          .prepare('SELECT project_id, modality, status FROM verify_runbook_local')
          .all() as typeof rows;
      }
    } catch {
      return [];
    }

    const proven = new Map<number, Set<VerificationModality>>();
    const laneDerived = new Set<number>();
    const seen = new Set<number>();
    for (const row of rows) {
      if (typeof row.project_id !== 'number') continue;
      seen.add(row.project_id);
      if (!isVerificationModality(row.modality)) continue;
      // NOT `row.status === 'proven'`. That column is one conjunct of the
      // answer; the badge must show what the GATE would answer, or it goes
      // green over exactly the failure it exists to warn about. See
      // {@link effectiveRunbookStatus}.
      //
      // The `row.status !== 'proven'` shortcut is deliberate and not merely an
      // optimization: the live conjunction can only ever DEMOTE a record, never
      // promote one, so a record that is not proven cannot become proven here —
      // and skipping those spares the probe (a file read + an input hash) for
      // every project that would fail it anyway.
      if (row.status !== 'proven') continue;
      const status = await effectiveRunbookStatus(ctx.verifyRunbookStatus, row.project_id, row.modality);
      if (status !== 'proven') continue;
      let set = proven.get(row.project_id);
      if (!set) {
        set = new Set<VerificationModality>();
        proven.set(row.project_id, set);
      }
      set.add(row.modality);
      // Recorded only for a record that actually resolved PROVEN: an unproven
      // lane-derived draft is not something a human has to weigh, and flagging
      // it would put a trust question in front of someone whose real state is
      // "verification is not running here at all".
      if (row.origin === 'lane-bootstrap') laneDerived.add(row.project_id);
    }

    return [...seen]
      .sort((a, b) => a - b)
      .map((projectId) => {
        const provenModalities = VERIFICATION_MODALITIES.filter(
          (m) => proven.get(projectId)?.has(m) === true,
        );
        return {
          projectId,
          status: provenModalities.length > 0 ? ('proven' as const) : ('unproven' as const),
          provenModalities,
          hasLaneDerivedRunbook: laneDerived.has(projectId),
        };
      });
  }),

  /**
   * Live host-capability probes for the health panel (§6 "probes, not
   * checkboxes"). Every row is probed AT CALL TIME — no remembered state, no
   * cache — because a TCC grant rots silently on any app-path or version
   * change while a wizard's checkmark keeps insisting it is configured.
   *
   * Runs the SAME implementations the verification preflight wires, so a panel
   * row and a preflight check can never disagree.
   *
   * PRECONDITION_FAILED (rather than an all-missing report) when the probes are
   * not wired: a host that was never asked is not a host with nothing
   * installed, and rendering the second would send users chasing binaries that
   * are already there.
   */
  hostProbes: protectedProcedure.query(async ({ ctx }): Promise<VerifyHostProbeReport> => {
    return await reportFor(requireProbes(ctx.verifyHostProbes, 'hostProbes'));
  }),

  /**
   * Provision chromium from the panel's fix-it row (§6 "chromium is
   * provisioning, not consent") and return the REPROBED rows.
   *
   * The one mutation on this router, and deliberately not an entity write: it
   * touches the host's browser cache, never the DB, so the no-direct-write /
   * chokepoint rules the file header describes are untouched.
   *
   * Soft-fail is preserved end to end — `ensureChromium` resolves `false`
   * rather than throwing when the download is unavailable, and the caller
   * learns that from the re-probed `chromium` row rather than from an
   * exception. Returning the fresh report (not just a boolean) means the panel
   * never renders a stale "missing" beside a success it just caused.
   *
   * A rejection is a CONTRACT VIOLATION rather than an outcome, and is still
   * swallowed: the re-probe below is the authority on whether chromium is now
   * present, and it answers that just as well after a throwing installer as
   * after a false-returning one. Failing the mutation instead would leave the
   * panel showing the pre-attempt rows.
   */
  provisionChromium: protectedProcedure.mutation(async ({ ctx }): Promise<VerifyHostProbeReport> => {
    const probes = requireProbes(ctx.verifyHostProbes, 'provisionChromium');
    try {
      await probes.ensureChromium();
    } catch {
      // Intentionally ignored — see the docblock; the re-probe reports reality.
    }
    return await reportFor(probes);
  }),

  /**
   * Prompt for the Accessibility grant, then return the REPROBED rows.
   *
   * Best-effort by construction: macOS shows the prompt once per binary and
   * silently no-ops forever after, so the wiring falls through to opening the
   * Settings pane. Either way the user still has to flip a switch, which is why
   * the re-probed row will usually still read `missing` on return — that is the
   * truth at that instant, not a failed mutation, and the next panel open picks
   * up the grant.
   */
  requestAccessibility: protectedProcedure.mutation(async ({ ctx }): Promise<VerifyHostProbeReport> => {
    const probes = requireProbes(ctx.verifyHostProbes, 'requestAccessibility');
    await runGrantAction(probes.requestAccessibility);
    return await reportFor(probes);
  }),

  /**
   * Open the Screen Recording pane of System Settings and return the REPROBED
   * rows. macOS exposes no request API for this grant, so this is the whole of
   * what the app can offer.
   */
  openScreenRecordingSettings: protectedProcedure.mutation(
    async ({ ctx }): Promise<VerifyHostProbeReport> => {
      const probes = requireProbes(ctx.verifyHostProbes, 'openScreenRecordingSettings');
      await runGrantAction(probes.openScreenRecordingSettings);
      return await reportFor(probes);
    },
  ),
});

/**
 * PRECONDITION_FAILED (rather than an all-missing report) when the probes are
 * not wired: a host that was never asked is not a host with nothing installed,
 * and rendering the second would send users chasing binaries already there.
 */
function requireProbes(
  probes: VerifyHostProbesLike | undefined,
  procedure: string,
): VerifyHostProbesLike {
  if (!probes) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[verificationRequests.${procedure}] host probes not wired into tRPC context`,
    });
  }
  return probes;
}

/**
 * Fire a grant action, swallowing both its absence (a platform with no such
 * grant) and any failure.
 *
 * Neither is worth failing the mutation over: the caller's real answer is the
 * re-probed report, and an action that could not run leaves the rows exactly as
 * they were — which is the honest outcome.
 */
async function runGrantAction(action: (() => Promise<void>) | undefined): Promise<void> {
  if (action === undefined) return;
  try {
    await action();
  } catch {
    // Intentionally ignored — see the docblock; the re-probe reports reality.
  }
}

/** The full probe report. */
async function reportFor(probes: VerifyHostProbesLike): Promise<VerifyHostProbeReport> {
  return { probes: await runHostProbes(probes) };
}
