/**
 * Environments (hosts) wire types — shared by main (HostStore, preflight engine, tRPC router) and the
 * renderer. Code word = host; UI word = Environment. Pure: no imports.
 */

export const HOST_KINDS = ['local', 'ssh'] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export const CAPABILITY_TIERS = ['cli', 'full'] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export const LIFECYCLE_STATES = ['online', 'asleep', 'starting', 'stopped', 'unreachable'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const CHECK_STATUSES = ['pass', 'warn', 'fail', 'na', 'skipped'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const PREFLIGHT_CHECK_IDS = [
  'ssh-reachable', 'arch', 'os-version', 'git', 'node22', 'sdk-binary-hash', 'mcp-roundtrip',
  'claude-auth', 'codex-auth', 'sleep-settings', 'repo-root-tcc', 'disk-free',
] as const;
export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

export type TierImpact = 'none' | 'blocks-full' | 'blocks-cli';

export interface PreflightCheckResult {
  id: PreflightCheckId;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  tierImpact: TierImpact;
  durationMs: number;
}

export interface PreflightRuntimes {
  claudeSdk: boolean;
  codexSdk: boolean;
  claudeCli: boolean;
  codexCli: boolean;
}

/**
 * What a COMPLETE probe learned about an SSH machine that a remote launch needs (spawn env base, tool paths,
 * the orch forward's socket). Persisted inside the preflight JSON; never parsed back out of check `detail`s.
 */
export interface PreflightRemoteFacts {
  home: string;
  /** The configured remote root, expanded to an absolute path (`~/cf-remote/<id>` → `/Users/k/cf-remote/<id>`). */
  remoteRoot: string;
  user: string | null;
  logname: string | null;
  shell: string | null;
  tmpdir: string | null;
  lang: string | null;
  nodePath: string | null;
  gitPath: string | null;
  /** The user's own codex CLI (not the cyboflow toolchain's). */
  codexPath: string | null;
  arch: string | null;
  /** `<remoteRoot>/s/o.sock` fits a unix socket path (< 100 bytes). */
  socketPathOk: boolean;
}

export interface PreflightResult {
  hostId: string;
  mode: 'full' | 'prelaunch';
  startedAt: string;
  finishedAt: string;
  results: PreflightCheckResult[];
  reachable: boolean;
  /**
   * false when the machine answered but the remote probe did not finish (connection dropped / timed out): the
   * post-reach checks are `skipped`, and the last complete result stays the persisted one. Always true for This
   * Mac. A result persisted before this field existed reads as true.
   */
  probeComplete: boolean;
  /** null when unreachable or when the probe did not finish: lifecycle, not capability. */
  detectedTier: CapabilityTier | null;
  runtimes: PreflightRuntimes;
  arch: string | null;
  osVersion: string | null;
  toolchainHash: string | null;
  appVersion: string;
  /**
   * SSH only, and only for a complete probe that reported the remote home (probeComplete true). Absent for This
   * Mac, for an unreachable / incomplete run, and in results persisted before remote flows.
   */
  remote?: PreflightRemoteFacts;
}

export interface SshHostConfig {
  sshTarget: string;
  remoteRoot: string;
}

/** What the renderer sees — never secret_ciphertext. */
export interface HostView {
  id: string;
  label: string;
  kind: HostKind;
  sshTarget: string | null;
  remoteRoot: string | null;
  arch: string | null;
  osVersion: string | null;
  detectedTier: CapabilityTier | null;
  userCapTier: CapabilityTier | null;
  effectiveTier: CapabilityTier | null;
  tierSource: 'detected' | 'fixed';
  lifecycleState: LifecycleState | null;
  lastSeenAt: string | null;
  preflight: PreflightResult | null;
  preflightAt: string | null;
  /** In-memory, most recent run. */
  lastAttempt: { at: string; reachable: boolean; summary: string } | null;
  preflightRunning: boolean;
  /**
   * SSH only: the latest complete preflight passed `sdk-binary-hash` (cyboflow tools installed and matching) and
   * recorded the remote facts — the machine can host SDK sessions/flows. Always false for This Mac (it needs no
   * remote toolchain; pickers check `kind` first).
   */
  remoteReady: boolean;
  /**
   * The orchestrator link (ssh -R forward of the orch socket) for this machine: 'up' while forwarded, 'down' while
   * reconnecting after an unexpected drop, 'idle' otherwise (none needed yet / closed). Always 'idle' for This Mac.
   */
  linkState: HostLinkViewState;
  /** SSH only: an "Install cyboflow tools" push is running for this machine (in memory). */
  installRunning: boolean;
  runningSessions: number;
  runningRuns: number;
  archivedAt: string | null;
  createdAt: string;
}

export const HOST_LINK_VIEW_STATES = ['idle', 'up', 'down'] as const;
export type HostLinkViewState = (typeof HOST_LINK_VIEW_STATES)[number];

export interface HostsFeatureStatus {
  available: boolean;
  enabled: boolean;
  killed: boolean;
  scheduleKilled: boolean;
  /** available && enabled */
  running: boolean;
}

export const DISABLED_HOSTS_STATUS: HostsFeatureStatus = {
  available: false, enabled: false, killed: false, scheduleKilled: false, running: false,
};

export interface HostsConfig {
  enabled?: boolean;
}
export const HOSTS_CONFIG_KEYS = ['enabled'] as const satisfies readonly (keyof HostsConfig)[];

export const HOSTS_ERROR_NAMES = {
  notFound: 'HostNotFoundError',
  labelTaken: 'HostLabelTakenError',
  invalidTarget: 'InvalidSshTargetError',
  capAboveDetected: 'TierCapAboveDetectedError',
  localImmutable: 'LocalHostImmutableError',
  hasActiveWork: 'HostHasActiveWorkError',
  killed: 'RemoteHostsDisabledError',
  terminalUnavailable: 'HostTerminalUnavailableError',
  invalidLabel: 'InvalidHostLabelError',
  disabled: 'HostsDisabledError',
  /** This build of cyboflow has no tools for the machine's architecture (or its MCP bundle is not built). */
  toolchainUnavailable: 'ToolchainUnavailableError',
  /** Installing cyboflow tools on the machine failed (upload / verify / install). */
  toolchainPushFailed: 'ToolchainPushError',
  /** The action needs a complete check of the machine first (its remote folder and architecture). */
  needsPreflight: 'HostNeedsPreflightError',
} as const;

export type HostsFailureCode =
  | 'not_found' | 'label_taken' | 'invalid_target'
  | 'invalid_label' | 'cap_above_detected' | 'local_immutable'
  | 'has_active_work' | 'terminal_unavailable' | 'feature_disabled' | 'remote_hosts_disabled'
  | 'toolchain_unavailable' | 'toolchain_push_failed' | 'needs_preflight' | 'unknown';

export type HostsResult<T> = ({ ok: true } & T) | { ok: false; error: HostsFailureCode; message: string };

export interface HostsChangedEvent {
  kind: 'hosts' | 'status';
  hostId?: string;
}

export interface PreflightProgressEvent {
  hostId: string;
  check: PreflightCheckResult | null;
  done: boolean;
}

export const TOOLCHAIN_PROGRESS_PHASES = ['hashing', 'uploading', 'verifying', 'done', 'failed'] as const;
export type ToolchainProgressPhase = (typeof TOOLCHAIN_PROGRESS_PHASES)[number];

/**
 * "Install cyboflow tools" progress for one machine. Bytes are SOURCE bytes (hashing: bytes hashed; uploading /
 * verifying: uncompressed bytes sent), so `bytesTotal` is known up front (0 while hashing has not sized the
 * bundle yet). `done` / `failed` end an install; `message` is set (redacted, user-presentable) only on `failed`.
 */
export interface ToolchainProgressEvent {
  hostId: string;
  phase: ToolchainProgressPhase;
  bytesSent: number;
  bytesTotal: number;
  message: string | null;
}

/** A host terminal's ssh process exited (pushed so an open terminal view can show "Disconnected (exit N)"). */
export interface HostTerminalExitEvent {
  terminalId: string;
  exitCode: number | null;
}

/**
 * The ONE test for "this session/run lives on a remote environment". The canonical local value is NULL in
 * `sessions.host_id` / `workflow_runs.host_id`; the literal 'local' is tolerated on read but never stamped.
 */
export function isRemoteHostId(id: string | null | undefined): id is string {
  return id != null && id !== 'local';
}

/** ssh destination: no leading '-', a conservative charset, bounded length. */
export const SSH_TARGET_RE = /^(?!-)[A-Za-z0-9._%+@:\[\]-]{1,253}$/;
export const HOST_LABEL_MAX = 48;

/**
 * Scrub secrets from remote stdout/stderr before it reaches a log, an error message, telemetry or the UI.
 * Pure; used main- and renderer-side.
 */
export function redactSecrets(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]');
}
