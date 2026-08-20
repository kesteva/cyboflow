/**
 * Versioned fleet-registry parser — the Cyboflow-side copy of the producer's
 * `parseRegistrySnapshot` (OMP-fleet-management `extensions/fleet/registry-contract.ts`).
 *
 * This module is PURE: it imports only types (erased at compile time) and
 * performs no I/O. It exists so Cyboflow validates the durable registry with
 * IDENTICAL semantics to the producer, rather than re-implementing a laxer
 * check that would silently accept a skewed file.
 *
 * The producer explicitly sanctions this copy: "a separate consumer repo can
 * `import type` the shapes — and copy or alias `parseRegistrySnapshot` verbatim."
 *
 * ## Version semantics
 *
 * - `SUPPORTED_REGISTRY_VERSION` pins the exact shape this module understands.
 * - A version bump is REQUIRED on any breaking change: field removal, a field
 *   type change, or a new required field.
 * - Additive OPTIONAL fields do NOT bump the version; unknown keys are accepted.
 * - On an unsupported version, a consumer MUST refuse the file — never
 *   best-effort a version-skewed registry.
 */

import type {
  RegistrySnapshot,
  WorkerEntry,
} from "../../../../shared/types/omp";

export const SUPPORTED_REGISTRY_VERSION = 1 as const;

export type RegistryParseResult =
  | { ok: true; snapshot: RegistrySnapshot }
  | { ok: false; reason: "unsupported-version"; version: number }
  | { ok: false; reason: "malformed"; errors: string[] };

// ─── Literal sets (single source for the validator) ────────────────────────

const WORKER_STATUSES: ReadonlySet<string> = new Set([
  "spawning", "working", "idle", "blocked", "dead", "evicted",
  "proposal_ready", "killing", "done", "failed",
]);

const BACKENDS: ReadonlySet<string> = new Set(["subprocess", "shepherd"]);

const INTENTS: ReadonlySet<string> = new Set([
  "read_only", "mutating", "high_stakes_mutating", "external_side_effect",
]);

const FAILURE_REPORT_STATES: ReadonlySet<string> = new Set([
  "pending", "claimed", "acknowledged",
]);

const FAILURE_TRANSITION_STATUSES: ReadonlySet<string> = new Set(["failed", "dead"]);

const REPO_ACCESS_LEVELS: ReadonlySet<string> = new Set([
  "none", "read", "overlay_write", "host_write",
]);

// ─── Validators ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(errors: string[], path: string, message: string): void {
  errors.push(`${path}: ${message}`);
}

function checkString(errors: string[], path: string, value: unknown): void {
  if (typeof value !== "string") fail(errors, path, "expected string");
}

function checkNullableString(errors: string[], path: string, value: unknown): void {
  if (value !== null && typeof value !== "string") fail(errors, path, "expected string or null");
}

function checkStringArray(errors: string[], path: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(errors, path, "expected string[]");
  }
}

function validateWorkerScope(errors: string[], path: string, value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    fail(errors, path, "expected object");
    return;
  }
  if (value.repo !== undefined) {
    if (!isRecord(value.repo)) {
      fail(errors, `${path}.repo`, "expected object");
    } else {
      checkString(errors, `${path}.repo.path`, value.repo.path);
      if (
        typeof value.repo.access !== "string" ||
        !REPO_ACCESS_LEVELS.has(value.repo.access)
      ) {
        fail(errors, `${path}.repo.access`, "expected a valid repo access level");
      }
      if (value.repo.include !== undefined) {
        checkStringArray(errors, `${path}.repo.include`, value.repo.include);
      }
      if (value.repo.exclude !== undefined) {
        checkStringArray(errors, `${path}.repo.exclude`, value.repo.exclude);
      }
    }
  }
  const sectionArrayFields = {
    shell: "commands",
    network: "domains",
    secrets: "names",
  } as const;
  for (const section of ["shell", "network", "secrets"] as const) {
    if (value[section] === undefined) continue;
    if (!isRecord(value[section])) {
      fail(errors, `${path}.${section}`, "expected object");
      continue;
    }
    if (typeof value[section].allowed !== "boolean") {
      fail(errors, `${path}.${section}.allowed`, "expected boolean");
    }
    const arrayField = sectionArrayFields[section];
    if (value[section][arrayField] !== undefined) {
      checkStringArray(errors, `${path}.${section}.${arrayField}`, value[section][arrayField]);
    }
  }
}

function validateFailureReport(errors: string[], path: string, value: unknown): void {
  if (!isRecord(value)) {
    fail(errors, path, "expected object");
    return;
  }
  if (
    typeof value.state !== "string" ||
    !FAILURE_REPORT_STATES.has(value.state)
  ) {
    fail(errors, `${path}.state`, "expected a valid failure report state");
  }
  checkString(errors, `${path}.idempotencyKey`, value.idempotencyKey);
  if (
    typeof value.transitionStatus !== "string" ||
    !FAILURE_TRANSITION_STATUSES.has(value.transitionStatus)
  ) {
    fail(errors, `${path}.transitionStatus`, 'expected "failed" | "dead"');
  }
  checkString(errors, `${path}.output`, value.output);
  if (value.traceId !== undefined) checkString(errors, `${path}.traceId`, value.traceId);
  if (value.claimedBy !== undefined) checkString(errors, `${path}.claimedBy`, value.claimedBy);
  if (value.claimExpiresAt !== undefined && typeof value.claimExpiresAt !== "number") {
    fail(errors, `${path}.claimExpiresAt`, "expected number");
  }
  if (value.acknowledgedAt !== undefined) {
    checkString(errors, `${path}.acknowledgedAt`, value.acknowledgedAt);
  }
}

function validateWorker(errors: string[], path: string, value: unknown): void {
  if (!isRecord(value)) {
    fail(errors, path, "expected object");
    return;
  }

  // Required fields.
  checkString(errors, `${path}.id`, value.id);
  checkNullableString(errors, `${path}.paneId`, value.paneId);
  checkNullableString(errors, `${path}.workspaceId`, value.workspaceId);
  if (typeof value.backend !== "string" || !BACKENDS.has(value.backend)) {
    fail(errors, `${path}.backend`, 'expected "subprocess" | "shepherd"');
  }
  checkString(errors, `${path}.model`, value.model);
  checkString(errors, `${path}.task`, value.task);
  checkNullableString(errors, `${path}.label`, value.label);
  if (typeof value.status !== "string" || !WORKER_STATUSES.has(value.status)) {
    fail(errors, `${path}.status`, "expected a valid worker status");
  }
  checkString(errors, `${path}.spawnedAt`, value.spawnedAt);
  checkString(errors, `${path}.lastSeenAt`, value.lastSeenAt);
  checkNullableString(errors, `${path}.leaseExpiresAt`, value.leaseExpiresAt);
  checkNullableString(errors, `${path}.lastOutput`, value.lastOutput);

  // Optional fields (checked only when present — absent is always valid).
  if (value.sandboxId !== undefined) checkString(errors, `${path}.sandboxId`, value.sandboxId);
  if (value.runId !== undefined) checkString(errors, `${path}.runId`, value.runId);
  if (value.traceId !== undefined) checkString(errors, `${path}.traceId`, value.traceId);
  if (value.proposalId !== undefined) checkString(errors, `${path}.proposalId`, value.proposalId);
  if (value.baseRevision !== undefined) checkString(errors, `${path}.baseRevision`, value.baseRevision);
  if (value.repoPath !== undefined) checkString(errors, `${path}.repoPath`, value.repoPath);
  if (value.allowedPaths !== undefined) checkStringArray(errors, `${path}.allowedPaths`, value.allowedPaths);
  if (value.proposalAuthorityFrozen !== undefined && typeof value.proposalAuthorityFrozen !== "boolean") {
    fail(errors, `${path}.proposalAuthorityFrozen`, "expected boolean");
  }
  if (value.intent !== undefined) {
    if (typeof value.intent !== "string" || !INTENTS.has(value.intent)) {
      fail(errors, `${path}.intent`, "expected a valid execution intent");
    }
  }
  if (value.scope !== undefined) validateWorkerScope(errors, `${path}.scope`, value.scope);
  if (value.cwd !== undefined) checkString(errors, `${path}.cwd`, value.cwd);
  if (value.ownerProcessId !== undefined) checkString(errors, `${path}.ownerProcessId`, value.ownerProcessId);
  if (value.ownerPid !== undefined && typeof value.ownerPid !== "number") {
    fail(errors, `${path}.ownerPid`, "expected number");
  }
  if (value.ownerHeartbeatAt !== undefined && typeof value.ownerHeartbeatAt !== "number") {
    fail(errors, `${path}.ownerHeartbeatAt`, "expected number");
  }
  if (value.timeout !== undefined && typeof value.timeout !== "number") {
    fail(errors, `${path}.timeout`, "expected number");
  }
  if (value.queued !== undefined && typeof value.queued !== "boolean") {
    fail(errors, `${path}.queued`, "expected boolean");
  }
  if (value.failureReportSequence !== undefined && typeof value.failureReportSequence !== "number") {
    fail(errors, `${path}.failureReportSequence`, "expected number");
  }
  if (value.failureReport !== undefined) {
    validateFailureReport(errors, `${path}.failureReport`, value.failureReport);
  }
  if (value.failureReports !== undefined) {
    if (!Array.isArray(value.failureReports)) {
      fail(errors, `${path}.failureReports`, "expected array");
    } else {
      value.failureReports.forEach((report, index) => {
        validateFailureReport(errors, `${path}.failureReports[${index}]`, report);
      });
    }
  }
}

/**
 * Parse and strictly validate an already-JSON-parsed registry payload.
 *
 * Pure: takes `unknown`, performs no I/O, and never throws.
 *
 * - `version !== SUPPORTED_REGISTRY_VERSION` → `unsupported-version` (checked
 *   before shape validation: a future version may legitimately not match the
 *   v1 shape).
 * - Any structural violation (top-level or per-worker) → `malformed`, with
 *   `path.field`-style error strings.
 * - Unknown keys are accepted (forward-compatible additive fields).
 */
export function parseRegistrySnapshot(data: unknown): RegistryParseResult {
  if (!isRecord(data)) {
    return { ok: false, reason: "malformed", errors: ["root: expected object"] };
  }

  if (typeof data.version !== "number") {
    return { ok: false, reason: "malformed", errors: ["version: expected number"] };
  }
  if (data.version !== SUPPORTED_REGISTRY_VERSION) {
    return { ok: false, reason: "unsupported-version", version: data.version };
  }
  if (typeof data.savedAt !== "string") {
    return { ok: false, reason: "malformed", errors: ["savedAt: expected string"] };
  }
  if (!Array.isArray(data.workers)) {
    return { ok: false, reason: "malformed", errors: ["workers: expected array"] };
  }

  const errors: string[] = [];
  data.workers.forEach((worker, index) => {
    validateWorker(errors, `workers[${index}]`, worker);
  });

  if (errors.length > 0) {
    return { ok: false, reason: "malformed", errors };
  }

  return {
    ok: true,
    snapshot: {
      workers: data.workers as WorkerEntry[],
      version: SUPPORTED_REGISTRY_VERSION,
      savedAt: data.savedAt,
    },
  };
}
