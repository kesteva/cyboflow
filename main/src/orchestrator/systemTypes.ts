/**
 * Shared types for the `cyboflow.system` snapshot. The port/socket portion is
 * declared here exactly once — the system router and `index.ts` boot wiring
 * import it rather than redeclaring. Type-only: no runtime imports, so it stays
 * safe under the standalone-typecheck invariant.
 */
import type { PortProbeResult } from './portProbe';
import type {
  WorktreeMonitorDiskUsage,
  WorktreeMonitorRegistryEntry,
} from './trpc/routers/worktreeMonitor';

/** The fixed ports the System view probes. */
export const DEV_RENDERER_PROBE_PORT = 4521;
export const CDP_PROBE_PORT = 9223;

/** `orch.sock` occupancy, matching OrchSocketServer's public getters. */
export interface OrchSocketSnapshot {
  /** `OrchSocketServer.getConnectionCount()` — all open client connections. */
  connectionCount: number;
  /** `OrchSocketServer.getRunBindingCounts()` — live socket count per bound runId. */
  runBindings: Record<string, number>;
}

export interface PortsAndSocketsSnapshot {
  /** :4521 dev renderer. */
  devRenderer: PortProbeResult;
  /** :9223 CDP. */
  cdp: PortProbeResult;
  orchSocket: OrchSocketSnapshot;
}

/**
 * Structural mirror of services/processSnapshot/processTypes.ts `ProcessType`.
 * The concrete provider maps the service's value onto this, so a member added
 * there fails to compile until it is mirrored here.
 */
export type SystemProcessType =
  | 'claude-cli'
  | 'codex-cli'
  | 'pi-cli'
  | 'omp-cli'
  | 'shell-pty'
  | 'codex-broker'
  | 'unknown';

/** Structural mirror of processSnapshotService.ts `ProcessOwner`. */
export type SystemProcessOwner =
  | { kind: 'cli'; panelId: string; sessionId: string }
  | { kind: 'run-shell'; runId: string; terminalId: string };

interface SystemProcessCommon {
  processType: SystemProcessType;
  command: string;
  /** Owning worktree when known (manager handle, or a Codex broker's `--cwd`). */
  worktreePath: string | null;
}

interface SystemProcessMetrics {
  pid: number;
  ppid: number;
  pcpu: number | null;
  pmem: number | null;
  etimeSeconds: number | null;
  owner: SystemProcessOwner | null;
}

/** Belongs to this live instance (`owned`), or cyboflow-shaped without a marker (`suspected`). */
export interface SystemManagedProcess extends SystemProcessCommon, SystemProcessMetrics {
  bucket: 'owned' | 'suspected';
}

/** Cyboflow's own, spawned by an instance that is confirmed gone — the only sweep-eligible bucket. */
export interface SystemOrphanProcess extends SystemProcessCommon, SystemProcessMetrics {
  bucket: 'orphan';
  sweepEligible: true;
  /** The dead instance that spawned it. */
  instanceId: string;
}

/**
 * Someone else's. Deliberately carries NO number-typed field (no `pid`): the
 * classifier's read-only guarantee must survive the wire, so a client cannot
 * hand a foreign row's pid to a kill call.
 */
export interface SystemForeignProcess extends SystemProcessCommon {
  bucket: 'foreign';
  readOnly: true;
  pidLabel: string;
  display: { cpu: string | null; mem: string | null; elapsed: string | null };
  foreignInstanceId: string | null;
}

export type SystemProcessEntry = SystemManagedProcess | SystemOrphanProcess | SystemForeignProcess;

/**
 * A worktree's disk figure: the tri-state (`bytes` exists only when measured), or
 * `unsupported` where sizing cannot run (win32 — `du` is POSIX-only). Never a bare
 * number, so an unsized path can't render as "0 MB".
 */
export type SystemWorktreeUsage =
  | WorktreeMonitorDiskUsage
  | { status: 'unsupported'; reason: string };

/** A registry entry plus its disk usage. */
export type SystemWorktreeEntry = WorktreeMonitorRegistryEntry & { usage: SystemWorktreeUsage };

/**
 * Whether a POSIX-only capability is available on this platform. An explicit
 * `supported: false` — never an empty payload that would read as "nothing there".
 */
export type SystemCapability = { supported: true } | { supported: false; reason: string };

/** Why win32 has no disk sizing: `du` has no Windows equivalent wired in yet. */
export const DISK_SIZING_UNSUPPORTED_REASON =
  'Worktree disk sizing is not supported on Windows yet (it relies on `du`).';

/**
 * The aggregated `cyboflow.system.snapshot` payload. `status: 'starting'` is the
 * safe fallback served before the provider is wired (early boot).
 */
export interface SystemSnapshot {
  status: 'starting' | 'ready';
  /** Epoch ms the snapshot was assembled. */
  generatedAt: number;
  /** Platform capabilities: only genuinely POSIX-only parts are ever marked unsupported. */
  capabilities: { diskSizing: SystemCapability };
  processes: SystemProcessEntry[];
  worktrees: SystemWorktreeEntry[];
  ports: PortsAndSocketsSnapshot;
}
