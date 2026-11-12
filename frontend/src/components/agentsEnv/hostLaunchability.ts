/**
 * hostLaunchability — can a session / workflow launch on this environment right now? Pure; the picker's
 * disabled-with-reason state and the launch surfaces' runtime coercion both read it. Advisory only: main
 * re-validates every launch and returns a readable refusal.
 */
import type { HostView, HostsFeatureStatus } from '../../../../shared/types/hosts';

export type HostLaunchKind = 'session' | 'workflow';
export type HostLaunchability = { ok: true } | { ok: false; reason: string };

/** The only runtimes a remote environment can host (SDK transports). */
export const REMOTE_LAUNCH_RUNTIMES = ['claude-sdk', 'codex-sdk'] as const;
export type RemoteLaunchRuntime = (typeof REMOTE_LAUNCH_RUNTIMES)[number];

export function isRemoteLaunchRuntime(runtime: string): runtime is RemoteLaunchRuntime {
  return (REMOTE_LAUNCH_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * The runtime a remote launch uses in place of one the environment cannot host: the SAME provider's SDK runtime
 * (Claude CLI → Claude SDK, Codex CLI → Codex SDK), or Claude's when that provider has none there (Pi, OMP).
 */
export function remoteLaunchRuntimeFor(runtime: string): RemoteLaunchRuntime {
  if (isRemoteLaunchRuntime(runtime)) return runtime;
  return runtime.startsWith('codex-') ? 'codex-sdk' : 'claude-sdk';
}

export function hostLaunchability(
  host: HostView,
  opts: { kind: HostLaunchKind; runtime?: string; featureStatus?: Pick<HostsFeatureStatus, 'killed'> | null },
): HostLaunchability {
  if (host.kind === 'local') return { ok: true };
  if (host.archivedAt !== null) return { ok: false, reason: 'Archived' };
  if (opts.featureStatus?.killed === true) return { ok: false, reason: 'Remote environments are turned off' };
  if (host.lifecycleState !== 'online') {
    return { ok: false, reason: host.lifecycleState === 'asleep' ? 'Asleep' : 'Unreachable' };
  }
  if (host.effectiveTier === null) return { ok: false, reason: 'Run a check first' };
  if (host.effectiveTier === 'cli') {
    return { ok: false, reason: host.userCapTier === 'cli' ? 'Terminal only (limited by you)' : 'Terminal only' };
  }
  if (!host.remoteReady) return { ok: false, reason: 'Install cyboflow tools first' };
  const runtime = opts.runtime;
  if (runtime !== undefined) {
    if (!isRemoteLaunchRuntime(runtime)) {
      return { ok: false, reason: 'Only Claude and Codex SDK sessions run on remote environments' };
    }
    const flags = host.preflight?.runtimes;
    if (runtime === 'claude-sdk' && flags?.claudeSdk === false) return { ok: false, reason: 'Claude is not signed in there' };
    if (runtime === 'codex-sdk' && flags?.codexSdk === false) return { ok: false, reason: 'Codex is not signed in there' };
  }
  return { ok: true };
}
