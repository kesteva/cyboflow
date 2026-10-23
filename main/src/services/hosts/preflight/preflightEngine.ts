/**
 * SSH preflight engine: `ssh … true` (ssh-reachable), then ONE remote probe script, then the pure checks in
 * PREFLIGHT_CHECK_IDS order. Each check is emitted through `onCheck` the moment it is decided.
 *
 * Contract:
 *  - Never throws. An unexpected exception becomes a `fail` row for the check being decided (the rest are
 *    `skipped`) and is reported to captureError('host-preflight', …) with the low-cardinality `{hostKind}` tag
 *    only; its message is redacted first.
 *  - ssh-reachable failing skips every other check ("Skipped: machine not reachable"); the result is
 *    `reachable: false` with a null detected tier (unreachability is lifecycle, not capability).
 *  - An aborted signal stops at the next step boundary; undecided checks are `skipped` ("Cancelled").
 *  - A probe that never printed `probe_done` (connection dropped / timed out mid-probe) or threw: every
 *    post-reach check is `skipped` (PROBE_INCOMPLETE_DETAIL), `probeComplete: false`, and the tier / arch / OS
 *    are null — HostStore then keeps the last complete preflight and only marks the machine online.
 *  - In M1 the SDK runtimes are never present remotely (sdk-binary-hash / mcp-roundtrip are skipped), so a
 *    healthy machine detects as `cli`.
 *  - A complete probe that reported the remote home also records `remote` (PreflightRemoteFacts): the expanded
 *    remote root, the spawn env base and the tool paths a remote launch needs — read back from the persisted
 *    result, never parsed out of a check's detail.
 */
import {
  PREFLIGHT_CHECK_IDS,
  redactSecrets,
  type PreflightCheckId,
  type PreflightCheckResult,
  type PreflightRemoteFacts,
  type PreflightResult,
  type PreflightRuntimes,
} from '../../../../../shared/types/hosts';
import { computeDetectedTier } from '../../../orchestrator/hosts/tierRule';
import type { LoggerLike } from '../../../orchestrator/types';
import { REMOTE_SOCK_MAX_BYTES, remoteOrchSocketPath } from '../hostLink';
import { buildProbeScript, expandRemoteRoot, parseProbeOutput, type ProbeRecord } from '../remoteProbe';
import { classifySshFailure, type SshTransportLike } from '../sshTransport';
import {
  CHECK_LABELS,
  CHECK_TIER_IMPACT,
  NOT_REACHABLE_DETAIL,
  checkArch,
  checkClaudeAuth,
  checkCodexAuth,
  checkDiskFree,
  checkGit,
  checkMcpRoundtrip,
  checkNode22,
  checkOsVersion,
  checkRepoRootTcc,
  checkSdkBinaryHash,
  checkSleepSettings,
  checkSshReachable,
  skippedCheck,
  type CheckOutcome,
} from './checks';

export const CANCELLED_DETAIL = 'Cancelled';
export const PREFLIGHT_ERROR_DETAIL = 'Skipped: preflight error';
export const PROBE_INCOMPLETE_DETAIL = 'Check did not finish (connection dropped or timed out)';
export const REACH_TIMEOUT_MS = 20_000;
export const PROBE_TIMEOUT_MS = 60_000;

export type CaptureErrorFn = (seam: string, err: unknown, tags: Record<string, string>) => void;

export interface SshPreflightContext {
  hostId: string;
  sshTarget: string;
  /** As configured, e.g. `~/cf-remote/<id>`. */
  remoteRoot: string;
  appVersion: string;
  transport: Pick<SshTransportLike, 'exec' | 'runScript'>;
  now?: () => Date;
  /** Monotonic ms clock for durations. */
  clock?: () => number;
  captureError?: CaptureErrorFn;
  logger?: LoggerLike;
  reachTimeoutMs?: number;
  probeTimeoutMs?: number;
}

const NO_RUNTIMES: PreflightRuntimes = { claudeSdk: false, codexSdk: false, claudeCli: false, codexCli: false };

function runtimesFrom(probe: ProbeRecord | null): PreflightRuntimes {
  if (probe === null) return { ...NO_RUNTIMES };
  // The SDK runtimes need the cyboflow toolchain on the machine, which arrives with remote flows (M2).
  return { claudeSdk: false, codexSdk: false, claudeCli: probe.claudePath !== null, codexCli: probe.codexPath !== null };
}

function osVersionFrom(probe: ProbeRecord | null): string | null {
  if (probe === null || probe.osVersion === null) return null;
  return probe.unameS === 'Darwin' ? `macOS ${probe.osVersion}` : probe.osVersion;
}

/**
 * The persisted remote facts of a COMPLETE probe; undefined when the remote home (hence the absolute remote root)
 * is unknown. socketPathOk checks the path HostLink will actually forward to (`remoteOrchSocketPath`) and the
 * probe's own byte count of `<root>/s/o.sock` when it reported one.
 */
export function remoteFactsFrom(probe: ProbeRecord, configuredRoot: string): PreflightRemoteFacts | undefined {
  if (probe.home === null) return undefined;
  const expanded = expandRemoteRoot(configuredRoot, probe.home) ?? probe.remoteRoot;
  if (expanded === null || !expanded.startsWith('/')) return undefined;
  const remoteRoot = expanded.replace(/\/+$/, '') || '/';
  let socketPathOk = probe.sockPathBytes === null || probe.sockPathBytes < REMOTE_SOCK_MAX_BYTES;
  try {
    remoteOrchSocketPath(remoteRoot);
  } catch {
    socketPathOk = false;
  }
  return {
    home: probe.home,
    remoteRoot,
    user: probe.user,
    logname: probe.logname,
    shell: probe.shell,
    tmpdir: probe.tmpdir,
    lang: probe.lang,
    nodePath: probe.nodePath,
    gitPath: probe.gitPath,
    codexPath: probe.codexPath,
    arch: probe.unameM,
    socketPathOk,
  };
}

function errorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

export async function runSshPreflight(
  ctx: SshPreflightContext,
  mode: PreflightResult['mode'],
  onCheck?: (r: PreflightCheckResult) => void,
  signal?: AbortSignal,
): Promise<PreflightResult> {
  const now = ctx.now ?? (() => new Date());
  const clock = ctx.clock ?? (() => performance.now());
  const startedAt = now().toISOString();
  const results: PreflightCheckResult[] = [];
  let probe: ProbeRecord | null = null;
  let probeComplete = false;
  let current: PreflightCheckId = 'ssh-reachable';

  const emit = (o: CheckOutcome, startMs: number): void => {
    const r: PreflightCheckResult = { ...o, durationMs: Math.max(0, Math.round(clock() - startMs)) };
    results.push(r);
    try {
      onCheck?.(r);
    } catch (err) {
      ctx.logger?.warn('[hosts] preflight onCheck listener threw', { error: err instanceof Error ? err.name : 'unknown' });
    }
  };
  const decided = (id: PreflightCheckId): boolean => results.some((r) => r.id === id);
  const fillRemaining = (detail: string): void => {
    for (const id of PREFLIGHT_CHECK_IDS) if (!decided(id)) emit(skippedCheck(id, detail), clock());
  };

  try {
    if (signal?.aborted) {
      fillRemaining(CANCELLED_DETAIL);
    } else {
      const t0 = clock();
      const reach = await ctx.transport.exec(ctx.sshTarget, ['true'], {
        timeoutMs: ctx.reachTimeoutMs ?? REACH_TIMEOUT_MS,
        signal,
      });
      if (signal?.aborted) {
        fillRemaining(CANCELLED_DETAIL);
      } else if (reach.code !== 0) {
        emit(checkSshReachable(classifySshFailure(reach.stderr, reach.timedOut, ctx.sshTarget)), t0);
        fillRemaining(NOT_REACHABLE_DETAIL);
      } else {
        emit(checkSshReachable(null), t0);
        current = 'arch';
        const out = await ctx.transport.runScript(ctx.sshTarget, buildProbeScript(ctx.remoteRoot), {
          timeoutMs: ctx.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
          signal,
        });
        if (signal?.aborted) {
          fillRemaining(CANCELLED_DETAIL);
        } else {
          const p = parseProbeOutput(out.stdout);
          probe = p;
          if (!p.complete) {
            ctx.logger?.warn('[hosts] preflight probe output incomplete', {
              timedOut: out.timedOut,
              code: out.code,
              stderr: redactSecrets(out.stderr).slice(0, 300),
            });
            // No probe_done: the null fields mean "never reported", not "missing". Judging them would turn a
            // dropped connection into a column of fails, so every post-reach check is skipped instead.
            fillRemaining(PROBE_INCOMPLETE_DETAIL);
          } else {
            probeComplete = true;
            const expandedRoot = expandRemoteRoot(ctx.remoteRoot, p.home) ?? ctx.remoteRoot;
            const steps: ReadonlyArray<readonly [PreflightCheckId, () => CheckOutcome]> = [
              ['arch', () => checkArch(p)],
              ['os-version', () => checkOsVersion(p)],
              ['git', () => checkGit(p)],
              ['node22', () => checkNode22(p)],
              ['sdk-binary-hash', () => checkSdkBinaryHash()],
              ['mcp-roundtrip', () => checkMcpRoundtrip()],
              ['claude-auth', () => checkClaudeAuth(p, ctx.remoteRoot)],
              ['codex-auth', () => checkCodexAuth(p)],
              ['sleep-settings', () => checkSleepSettings(p)],
              ['repo-root-tcc', () => checkRepoRootTcc(expandedRoot, p.home)],
              ['disk-free', () => checkDiskFree(p)],
            ];
            for (const [id, fn] of steps) {
              if (signal?.aborted) break;
              current = id;
              const s = clock();
              emit(fn(), s);
            }
            if (signal?.aborted) fillRemaining(CANCELLED_DETAIL);
          }
        }
      }
    }
  } catch (err) {
    const message = errorMessage(err);
    ctx.logger?.error('[hosts] preflight failed unexpectedly', { error: message });
    try {
      const reported = new Error(message);
      reported.name = err instanceof Error ? err.name : 'Error';
      ctx.captureError?.('host-preflight', reported, { hostKind: 'ssh' });
    } catch {
      /* telemetry never breaks a preflight */
    }
    if (!decided(current)) {
      emit({
        id: current,
        label: CHECK_LABELS[current],
        status: 'fail',
        detail: `Unexpected error: ${message}`,
        tierImpact: CHECK_TIER_IMPACT[current],
      }, clock());
    }
    fillRemaining(PREFLIGHT_ERROR_DETAIL);
  }

  const order = (id: PreflightCheckId): number => PREFLIGHT_CHECK_IDS.indexOf(id);
  results.sort((a, b) => order(a.id) - order(b.id));
  const reachable = results.some((r) => r.id === 'ssh-reachable' && r.status === 'pass');
  // Only a finished probe (probe_done) whose checks all ran describes the machine; anything less is not recorded.
  const complete = reachable && probeComplete && !signal?.aborted;
  const runtimes = runtimesFrom(complete ? probe : null);
  const remote = complete && probe !== null ? remoteFactsFrom(probe, ctx.remoteRoot) : undefined;
  return {
    hostId: ctx.hostId,
    mode,
    startedAt,
    finishedAt: now().toISOString(),
    results,
    reachable,
    probeComplete: complete,
    detectedTier: complete ? computeDetectedTier(results, runtimes) : null,
    runtimes,
    arch: complete ? probe?.unameM ?? null : null,
    osVersion: complete ? osVersionFrom(probe) : null,
    toolchainHash: null,
    appVersion: ctx.appVersion,
    ...(remote !== undefined ? { remote } : {}),
  };
}
