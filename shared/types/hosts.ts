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

export interface PreflightResult {
  hostId: string;
  mode: 'full' | 'prelaunch';
  startedAt: string;
  finishedAt: string;
  results: PreflightCheckResult[];
  reachable: boolean;
  /** null when unreachable: lifecycle, not capability. */
  detectedTier: CapabilityTier | null;
  runtimes: PreflightRuntimes;
  arch: string | null;
  osVersion: string | null;
  toolchainHash: string | null;
  appVersion: string;
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
  runningSessions: number;
  runningRuns: number;
  archivedAt: string | null;
  createdAt: string;
}

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
} as const;

export type HostsFailureCode =
  | 'not_found' | 'label_taken' | 'invalid_target'
  | 'invalid_label' | 'cap_above_detected' | 'local_immutable'
  | 'has_active_work' | 'feature_disabled' | 'remote_hosts_disabled' | 'unknown';

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
