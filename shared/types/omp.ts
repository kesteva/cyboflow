/**
 * OMP fleet-registry domain types — the Cyboflow-side mirror of the
 * authoritative producer contract in `OMP-fleet-management`
 * (`extensions/fleet/registry-contract.ts`).
 *
 * The producer module is PURE and explicitly sanctions consumer copies: "a
 * separate consumer repo can `import type` the shapes — and copy or alias
 * `parseRegistrySnapshot` verbatim." Cyboflow is not a dependency consumer, so
 * these shapes are re-declared here and pinned to `SUPPORTED_REGISTRY_VERSION`
 * (see `main/src/orchestrator/omp/registryContract.ts`).
 *
 * ## Drift discipline
 *
 * The parser refuses any registry whose `version !== SUPPORTED_REGISTRY_VERSION`.
 * If the producer bumps the version or changes a field shape, this file and
 * `registryContract.ts` must be updated TOGETHER, or the reader fails closed
 * (it reports `unsupported-version` / `malformed`, never mis-renders).
 *
 * `ExecutionIntent` and `WorkerScope` are stubbed here because the producer
 * imports them from its own `./backend`; Cyboflow has no such module. They
 * mirror the producer's `extensions/fleet/backend.ts` exactly.
 */

/** Producer-side default fleet model (OMP-fleet-management docs, default worker). */
export const DEFAULT_OMP_MODEL = "zai/glm-5.2:high";

export type OmpBackend = "subprocess" | "shepherd";

export type WorkerStatus =
  | "spawning"
  | "working"
  | "idle"
  | "blocked"
  | "dead"
  | "evicted"
  | "proposal_ready"
  | "killing"
  | "done"
  | "failed";

export type FailureReportState = "pending" | "claimed" | "acknowledged";

export type ExecutionIntent =
  | "read_only"
  | "mutating"
  | "high_stakes_mutating"
  | "external_side_effect";

export interface WorkerScope {
  repo?: {
    path: string;
    access: "none" | "read" | "overlay_write" | "host_write";
    include?: string[];
    exclude?: string[];
  };
  shell?: { allowed: boolean; commands?: string[] };
  network?: { allowed: boolean; domains?: string[] };
  secrets?: { allowed: boolean; names?: string[] };
}

export interface FailureReportRecord {
  state: FailureReportState;
  idempotencyKey: string;
  transitionStatus: "failed" | "dead";
  traceId?: string;
  output: string;
  claimedBy?: string;
  claimExpiresAt?: number;
  acknowledgedAt?: string;
}

export interface WorkerEntry {
  id: string;
  paneId: string | null;
  workspaceId: string | null;
  backend: OmpBackend;
  model: string;
  task: string;
  label: string | null;
  status: WorkerStatus;
  spawnedAt: string;
  lastSeenAt: string;
  leaseExpiresAt: string | null;
  lastOutput: string | null;
  sandboxId?: string;
  runId?: string;
  traceId?: string;
  proposalId?: string;
  baseRevision?: string;
  repoPath?: string;
  allowedPaths?: string[];
  proposalAuthorityFrozen?: boolean;
  intent?: ExecutionIntent;
  scope?: WorkerScope;
  cwd?: string;
  /** Process instance that owns lifecycle observation for this worker. */
  ownerProcessId?: string;
  ownerPid?: number;
  ownerHeartbeatAt?: number;
  timeout?: number;
  queued?: boolean;
  failureReportSequence?: number;
  failureReport?: FailureReportRecord;
  /** Canonical oldest-first queue; failureReport mirrors its current head. */
  failureReports?: FailureReportRecord[];
}

export interface RegistrySnapshot {
  workers: WorkerEntry[];
  version: 1;
  savedAt: string;
}

/**
 * Result of a fleet snapshot read at the adapter boundary. Distinct from the
 * parser-level result (`registryContract.ts`): this adds `unavailable` for a
 * missing/unreadable registry and flattens validation detail into a string so
 * the renderer never depends on parser internals.
 */
export type OmpSnapshotResult =
  | { ok: true; snapshot: RegistrySnapshot }
  | {
      ok: false;
      error: "unavailable" | "missing" | "unsupported-version" | "malformed";
      detail: string;
    };

/**
 * Renderer-safe worker projection. The full WorkerEntry carries task text,
 * lastOutput, repoPath, allowedPaths, and failure-report output — none of which
 * may cross the IPC boundary. This DTO is produced in MAIN before the tRPC
 * reply; the renderer only ever sees these summary fields.
 */
export interface OmpFleetWorkerView {
  id: string;
  label: string | null;
  model: string;
  status: WorkerStatus;
  backend: OmpBackend;
  spawnedAt: string;
  lastSeenAt: string;
}

export interface OmpFleetViewSnapshot {
  version: number;
  savedAt: string;
  totalWorkers: number;
  workers: OmpFleetWorkerView[];
}

/** Renderer-facing result: a redacted summary, never the raw registry. */
export type OmpFleetViewResult =
  | { ok: true; snapshot: OmpFleetViewSnapshot }
  | {
      ok: false;
      error: "unavailable" | "missing" | "unsupported-version" | "malformed";
      detail: string;
    };

/**
 * Read-only control-plane adapter. This is the ONLY surface the renderer/other
 * code consumes. It deliberately exposes no mutators: proposal/proof read and
 * command (spawn/kill/verify/apply) surfaces are separate, privileged
 * increments that arrive later. The `authority` literal is a type-level
 * guarantee, not a comment.
 */
export interface OmpControlPlaneAdapter {
  readonly version: 1;
  readonly authority: "read";
  getFleetSnapshot(): Promise<OmpSnapshotResult>;
}
