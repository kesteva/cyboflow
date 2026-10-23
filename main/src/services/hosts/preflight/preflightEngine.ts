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
 *  - The full tier (spec A6): `sdk-binary-hash` compares the installed toolchain (manifest + sizes, reported by the
 *    probe for the EXPECTED hash the caller's `toolchain` source computes for the machine's arch) with this Mac's;
 *    `mcp-roundtrip` pings this Mac's orch socket through the machine's forward (`orchLink`) with a fixed `node -e`
 *    program; `claude-auth` additionally runs the installed claude once (`-p ok`, one model request) with the
 *    env-file token when the toolchain passed. Without a `toolchain` source the M1 shape remains: both blocks-full
 *    checks are skipped and a healthy machine detects as `cli`.
 *  - mode 'prelaunch' (a launch-time liveness check, never persisted by the caller): a 2 s budget (combined with
 *    the caller's signal) over ssh-reachable, a TRIMMED probe (toolchain manifest for the expected hash, env file
 *    shape, node) and "link acquirable"; every other check is `skipped`; the detected tier is always null.
 *  - A complete probe that reported the remote home also records `remote` (PreflightRemoteFacts): the expanded
 *    remote root, the spawn env base and the tool paths a remote launch needs — read back from the persisted
 *    result, never parsed out of a check's detail.
 */
import { randomBytes } from 'node:crypto';
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
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../orchestrator/types';
import { REMOTE_SOCK_MAX_BYTES, remoteOrchSocketPath } from '../hostLink';
import {
  DEFAULT_REMOTE_BASE_PATH,
  composeRemotePath,
  encodeEnvPrelude,
  envIBase,
  remoteTokenEnvFile,
  wrapperArgv,
  type RemoteHostFacts,
} from '../remoteLaunch';
import {
  buildPrelaunchProbeScript,
  buildProbeScript,
  buildToolchainProbeScript,
  expandRemoteRoot,
  parseProbeOutput,
  type ProbeRecord,
  type ToolchainProbeSpec,
} from '../remoteProbe';
import { classifySshFailure, type SshTransportLike } from '../sshTransport';
import { remoteToolchainPaths } from '../toolchain/toolchainPusher';
import { toolchainArchFromUname } from '../toolchain/types';
import {
  CHECK_LABELS,
  CHECK_TIER_IMPACT,
  NOT_REACHABLE_DETAIL,
  checkArch,
  checkClaudeAuth,
  checkClaudeAuthLive,
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
  codexBinFile,
  skippedCheck,
  type CheckOutcome,
  type ExpectedToolchain,
} from './checks';

export const CANCELLED_DETAIL = 'Cancelled';
export const PREFLIGHT_ERROR_DETAIL = 'Skipped: preflight error';
export const PROBE_INCOMPLETE_DETAIL = 'Check did not finish (connection dropped or timed out)';
export const REACH_TIMEOUT_MS = 20_000;
export const PROBE_TIMEOUT_MS = 60_000;
/** The toolchain-only probe (first check of a machine / changed arch). */
export const TOOLCHAIN_PROBE_TIMEOUT_MS = 15_000;
/** The ping program's own bound; the exec adds ssh slack on top. */
export const MCP_ROUNDTRIP_PROGRAM_MS = 3_000;
export const MCP_ROUNDTRIP_TIMEOUT_MS = MCP_ROUNDTRIP_PROGRAM_MS + 5_000;
export const CLAUDE_AUTH_TIMEOUT_MS = 60_000;
/** Total budget of a prelaunch preflight (its remote round trips; the expected toolchain is resolved first). */
export const PRELAUNCH_BUDGET_MS = 2_000;
export const PRELAUNCH_TIMEOUT_DETAIL = 'Did not answer in time';
export const NOT_CHECKED_BEFORE_LAUNCH_DETAIL = 'Not checked before a launch';

/**
 * Mirrors PREFLIGHT_PING_MESSAGE_TYPE (orchestrator/mcpServer/mcpQueryHandler.ts) — duplicated as a literal so the
 * preflight does not pull the whole MCP query handler graph in for one string; a test pins the two together.
 */
export const PREFLIGHT_PING_TYPE = 'preflight-ping';

/**
 * The fixed `node -e` program of mcp-roundtrip: argv[1] = remote socket, argv[2] = request id (both data, never
 * program text). Connects, writes one `preflight-ping` line, prints the first line it reads back, exits; exit 3
 * on its own timeout, 2 on a connect error, 4 when the socket closes without a line.
 */
export const MCP_PING_PROGRAM =
  "const net=require('net');const sock=process.argv[1],id=process.argv[2];let buf='',done=false;" +
  // Exit only after the line is flushed: stdout to an ssh channel is an async pipe on macOS.
  'const fin=(code,out)=>{if(done)return;done=true;process.stdout.write(out+"\\n",()=>process.exit(code));};' +
  `setTimeout(()=>fin(3,'timeout'),${MCP_ROUNDTRIP_PROGRAM_MS});` +
  `const c=net.createConnection(sock,()=>c.write(JSON.stringify({type:'${PREFLIGHT_PING_TYPE}',requestId:id})+"\\n"));` +
  "c.setEncoding('utf8');" +
  "c.on('data',(d)=>{buf+=d;const i=buf.indexOf('\\n');if(i>=0){c.destroy();fin(0,buf.slice(0,i));}});" +
  "c.on('error',(e)=>fin(2,'error '+(e&&e.code?e.code:'unknown')));" +
  "c.on('close',()=>fin(4,'closed'));";

export type CaptureErrorFn = (seam: string, err: unknown, tags: Record<string, string>) => void;

/** The expected toolchain for the machine (spec A6). */
export interface PreflightToolchainSource {
  /** `uname -m` from the last complete check; null on a first check (the probe then reports it). */
  archHint: string | null;
  /** This Mac's toolchain for that `uname -m`. Must not reject (an unusable build → `unavailableReason`). */
  expectedFor(unameM: string): Promise<ExpectedToolchain>;
}

/** The machine's orch forward, for mcp-roundtrip and the prelaunch "link acquirable" row. */
export interface PreflightOrchLink {
  /** false = this Mac has no orch socket to forward (skips mcp-roundtrip). */
  available(): boolean;
  /** Join (open) the forward. `remoteRoot` is the probed absolute root. One release() per successful acquire. */
  acquire(remoteRoot: string): Promise<{ remoteSock: string }>;
  release(): void;
}

/** What the hosts service injects into an SshHost's preflights (absent pieces keep the M1 behaviour). */
export interface SshPreflightExtras {
  toolchain?: PreflightToolchainSource;
  orchLink?: PreflightOrchLink;
  /** prelaunch: the node path of the last complete check, tried first. */
  prelaunchNodePath?: string | null;
}

export interface SshPreflightContext extends SshPreflightExtras {
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
  prelaunchBudgetMs?: number;
  /** mcp-roundtrip nonce (tests). */
  newRequestId?: () => string;
}

const NO_RUNTIMES: PreflightRuntimes = { claudeSdk: false, codexSdk: false, claudeCli: false, codexCli: false };

/** The SDK runtimes need the cyboflow toolchain installed and matching (sdk-binary-hash pass). */
function runtimesFrom(probe: ProbeRecord | null, toolchainOk: boolean, codexIncluded: boolean): PreflightRuntimes {
  if (probe === null) return { ...NO_RUNTIMES };
  return {
    claudeSdk: toolchainOk,
    codexSdk: toolchainOk && codexIncluded && probe.codexAuth === true,
    claudeCli: probe.claudePath !== null,
    codexCli: probe.codexPath !== null,
  };
}

function toolchainSpec(expected: ExpectedToolchain | null): ToolchainProbeSpec | null {
  if (expected === null || expected.expectedHash === null) return null;
  return { hash: expected.expectedHash, codexBinRel: expected.codexIncluded ? codexBinFile(expected)?.rel ?? null : null };
}

const BASE_PATH_DIRS: ReadonlySet<string> = new Set(DEFAULT_REMOTE_BASE_PATH.split(':'));

/** Directory of an absolute remote path; null otherwise and for a directory the base PATH already names. */
function remoteDirOf(p: string | null): string | null {
  if (p === null || !p.startsWith('/')) return null;
  const i = p.lastIndexOf('/');
  const dir = i <= 0 ? '/' : p.slice(0, i);
  return BASE_PATH_DIRS.has(dir) ? null : dir;
}

/** The `env -i` base of a remote exec, from a complete probe's facts. */
function hostFactsFrom(facts: PreflightRemoteFacts): RemoteHostFacts {
  const nodeDir = remoteDirOf(facts.nodePath);
  const gitDir = remoteDirOf(facts.gitPath);
  return {
    remoteRoot: facts.remoteRoot,
    home: facts.home,
    path: composeRemotePath({ nodeDir, gitDir: gitDir === nodeDir ? null : gitDir }),
    user: facts.user,
    logname: facts.logname,
    shell: facts.shell,
    tmpdir: facts.tmpdir,
    lang: facts.lang,
  };
}

/** The argv of the live sign-in check: the installed claude under `env -i` + the wrapper, token from the env file. */
export function claudeAuthArgv(facts: RemoteHostFacts, claudePath: string): string[] {
  return [
    ...envIBase(facts),
    ...wrapperArgv({
      cwd: facts.remoteRoot,
      envFile: remoteTokenEnvFile(facts.remoteRoot),
      pidFile: '',
      argv: [claudePath, '-p', 'ok', '--max-turns', '1', '--output-format', 'json'],
    }),
  ];
}

/** The live sign-in check's prelude (the wrapper reads it from stdin; the token never travels in it). */
export const CLAUDE_AUTH_PRELUDE = encodeEnvPrelude({ TERM: 'dumb', DISABLE_AUTOUPDATER: '1' });

/** Expected toolchain from a source that must not reject — but a defect there must not break the preflight. */
async function resolveExpected(
  source: PreflightToolchainSource,
  unameM: string,
  logger: LoggerLike | undefined,
): Promise<ExpectedToolchain> {
  try {
    return await source.expectedFor(unameM);
  } catch (err) {
    logger?.warn('[hosts] expected toolchain lookup failed', { error: err instanceof Error ? err.name : 'unknown' });
    return { expectedHash: null, files: [], codexIncluded: false, unavailableReason: 'Could not prepare the cyboflow tools' };
  }
}

/** The caller's signal combined with a budget timer (setTimeout, so fake timers drive it in tests). */
function budgetSignal(ms: number, signal: AbortSignal | undefined): { signal: AbortSignal; expired: () => boolean; dispose: () => void } {
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), ms);
  const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  return {
    signal: combined,
    expired: () => budget.signal.aborted && !(signal?.aborted ?? false),
    dispose: () => clearTimeout(timer),
  };
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

/** acquire(), abandoned (and the late lease released) when `signal` aborts first. */
function acquireWithin(link: PreflightOrchLink, remoteRoot: string, signal: AbortSignal | undefined): Promise<{ remoteSock: string }> {
  const pending = link.acquire(remoteRoot);
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      pending.then(() => link.release(), () => undefined);
      reject(new Error('cancelled'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (lease) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(lease);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

const defaultRequestId = (): string => randomBytes(12).toString('hex');

/** Same arch for the toolchain (`arm64`/`aarch64` are one), so an expected hash computed for the hint still applies. */
function sameToolchainArch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const x = toolchainArchFromUname(a);
  return x !== null && x === toolchainArchFromUname(b);
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
  const prelaunch = mode === 'prelaunch';
  const results: PreflightCheckResult[] = [];
  let probe: ProbeRecord | null = null;
  let probeComplete = false;
  let current: PreflightCheckId = 'ssh-reachable';
  let expected: ExpectedToolchain | null = null;

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
  const statusOf = (id: PreflightCheckId): string | undefined => results.find((r) => r.id === id)?.status;
  const fillRemaining = (detail: string): void => {
    for (const id of PREFLIGHT_CHECK_IDS) if (!decided(id)) emit(skippedCheck(id, detail), clock());
  };

  // The expected toolchain for the last known arch is resolved BEFORE any remote work (and before a prelaunch
  // budget starts): hashing this Mac's bundle is local and, on a cold cache, slower than the whole budget.
  const hint = ctx.toolchain?.archHint ?? null;
  const preExpected = ctx.toolchain && hint !== null && !signal?.aborted
    ? await resolveExpected(ctx.toolchain, hint, ctx.logger)
    : null;
  const budgetMs = ctx.prelaunchBudgetMs ?? PRELAUNCH_BUDGET_MS;
  const budget = prelaunch ? budgetSignal(budgetMs, signal) : null;
  const sig = budget?.signal ?? signal;
  const cancelDetail = (): string => (budget?.expired() ? PRELAUNCH_TIMEOUT_DETAIL : CANCELLED_DETAIL);

  try {
    if (sig?.aborted) {
      fillRemaining(cancelDetail());
    } else {
      const t0 = clock();
      const reach = await ctx.transport.exec(ctx.sshTarget, ['true'], {
        timeoutMs: prelaunch ? budgetMs : ctx.reachTimeoutMs ?? REACH_TIMEOUT_MS,
        signal: sig,
      });
      if (sig?.aborted) {
        fillRemaining(cancelDetail());
      } else if (reach.code !== 0) {
        emit(checkSshReachable(classifySshFailure(reach.stderr, reach.timedOut, ctx.sshTarget)), t0);
        fillRemaining(NOT_REACHABLE_DETAIL);
      } else {
        emit(checkSshReachable(null), t0);
        current = prelaunch ? 'node22' : 'arch';
        const spec = toolchainSpec(preExpected);
        const script = prelaunch
          ? buildPrelaunchProbeScript(ctx.remoteRoot, { toolchain: spec, nodePath: ctx.prelaunchNodePath ?? null })
          : buildProbeScript(ctx.remoteRoot, { toolchain: spec });
        const out = await ctx.transport.runScript(ctx.sshTarget, script, {
          timeoutMs: prelaunch ? budgetMs : ctx.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
          signal: sig,
        });
        if (sig?.aborted) {
          fillRemaining(cancelDetail());
        } else {
          let p = parseProbeOutput(out.stdout);
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
            expected = preExpected;
            if (ctx.toolchain && !prelaunch && p.unameM !== null && !(preExpected !== null && sameToolchainArch(hint, p.unameM))) {
              // First check of this machine (or its arch changed): the probe could not look for the right hash.
              expected = await resolveExpected(ctx.toolchain, p.unameM, ctx.logger);
              const spec2 = toolchainSpec(expected);
              if (spec2 !== null && !sig?.aborted) {
                const tc = await ctx.transport.runScript(ctx.sshTarget, buildToolchainProbeScript(ctx.remoteRoot, spec2), {
                  timeoutMs: TOOLCHAIN_PROBE_TIMEOUT_MS,
                  signal: sig,
                });
                const tp = parseProbeOutput(tc.stdout);
                if (tp.complete) {
                  p = {
                    ...p,
                    tcHash: tp.tcHash, tcManifest: tp.tcManifest, tcManifestHash: tp.tcManifestHash,
                    tcClaudeSize: tp.tcClaudeSize, tcMcpSize: tp.tcMcpSize, tcCodexSize: tp.tcCodexSize,
                  };
                  probe = p;
                }
              }
            }
            const probed = p;
            const expandedRoot = expandRemoteRoot(ctx.remoteRoot, probed.home) ?? ctx.remoteRoot;
            const facts = remoteFactsFrom(probed, ctx.remoteRoot);
            const sdk = (): CheckOutcome => checkSdkBinaryHash(probed, ctx.toolchain ? expected : undefined);

            /** Join the forward (bounded by the signal), run `use`, always release. */
            const withLink = async (
              remoteRoot: string | null,
              use: (remoteSock: string) => Promise<CheckOutcome>,
            ): Promise<CheckOutcome> => {
              const link = ctx.orchLink;
              if (!link || !link.available()) return checkMcpRoundtrip({ kind: 'no-orch-socket' });
              if (remoteRoot === null) return checkMcpRoundtrip({ kind: 'link-failed', message: 'the remote folder is not known yet' });
              let lease: { remoteSock: string };
              try {
                lease = await acquireWithin(link, remoteRoot, sig);
              } catch (err) {
                return checkMcpRoundtrip({ kind: 'link-failed', message: errorMessage(err) });
              }
              try {
                return await use(lease.remoteSock);
              } finally {
                try {
                  link.release();
                } catch {
                  /* a release never breaks a preflight */
                }
              }
            };

            const mcpRoundtrip = async (): Promise<CheckOutcome> => {
              const nodePath = probed.nodePath;
              if (statusOf('node22') !== 'pass' || nodePath === null || !nodePath.startsWith('/')) {
                return checkMcpRoundtrip({ kind: 'no-node' });
              }
              return withLink(facts?.remoteRoot ?? null, async (remoteSock) => {
                const requestId = (ctx.newRequestId ?? defaultRequestId)();
                const result = await ctx.transport.exec(ctx.sshTarget, [nodePath, '-e', MCP_PING_PROGRAM, remoteSock, requestId], {
                  timeoutMs: MCP_ROUNDTRIP_TIMEOUT_MS,
                  signal: sig,
                });
                return checkMcpRoundtrip({ kind: 'reply', requestId, result });
              });
            };

            const linkAcquirable = (): Promise<CheckOutcome> => {
              const root = expandRemoteRoot(ctx.remoteRoot, probed.home) ?? probed.remoteRoot;
              const abs = root !== null && root.startsWith('/') ? root.replace(/\/+$/, '') || '/' : null;
              return withLink(abs, async () => checkMcpRoundtrip({ kind: 'link-up' }));
            };

            const claudeAuth = async (): Promise<CheckOutcome> => {
              const shape = checkClaudeAuth(probed, ctx.remoteRoot);
              const hash = expected?.expectedHash ?? null;
              if (shape.status !== 'pass' || statusOf('sdk-binary-hash') !== 'pass' || facts === undefined || hash === null) {
                return shape;
              }
              const claudePath = remoteToolchainPaths(facts.remoteRoot, { hash, codexTarget: null }).claude;
              const result: ExecResult = await ctx.transport.exec(ctx.sshTarget, claudeAuthArgv(hostFactsFrom(facts), claudePath), {
                stdin: CLAUDE_AUTH_PRELUDE,
                timeoutMs: CLAUDE_AUTH_TIMEOUT_MS,
                signal: sig,
              });
              return checkClaudeAuthLive(result, ctx.remoteRoot);
            };

            const steps: ReadonlyArray<readonly [PreflightCheckId, () => CheckOutcome | Promise<CheckOutcome>]> = prelaunch
              ? [
                ['node22', () => checkNode22(probed)],
                ['sdk-binary-hash', sdk],
                ['mcp-roundtrip', linkAcquirable],
                ['claude-auth', () => checkClaudeAuth(probed, ctx.remoteRoot)],
              ]
              : [
                ['arch', () => checkArch(probed)],
                ['os-version', () => checkOsVersion(probed)],
                ['git', () => checkGit(probed)],
                ['node22', () => checkNode22(probed)],
                ['sdk-binary-hash', sdk],
                ['mcp-roundtrip', mcpRoundtrip],
                ['claude-auth', claudeAuth],
                ['codex-auth', () => checkCodexAuth(probed)],
                ['sleep-settings', () => checkSleepSettings(probed)],
                ['repo-root-tcc', () => checkRepoRootTcc(expandedRoot, probed.home)],
                ['disk-free', () => checkDiskFree(probed)],
              ];
            for (const [id, fn] of steps) {
              if (sig?.aborted) break;
              current = id;
              const s = clock();
              const o = await fn();
              if (sig?.aborted) break; // an aborted round trip's answer describes the abort, not the machine
              emit(o, s);
            }
            if (sig?.aborted) fillRemaining(cancelDetail());
            else if (prelaunch) fillRemaining(NOT_CHECKED_BEFORE_LAUNCH_DETAIL);
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
  } finally {
    budget?.dispose();
  }

  const order = (id: PreflightCheckId): number => PREFLIGHT_CHECK_IDS.indexOf(id);
  results.sort((a, b) => order(a.id) - order(b.id));
  const reachable = results.some((r) => r.id === 'ssh-reachable' && r.status === 'pass');
  // Only a finished probe (probe_done) whose checks all ran describes the machine; anything less is not recorded.
  const complete = reachable && probeComplete && !sig?.aborted;
  const toolchainHash = complete && statusOf('sdk-binary-hash') === 'pass' ? expected?.expectedHash ?? null : null;
  const runtimes = runtimesFrom(complete ? probe : null, toolchainHash !== null, expected?.codexIncluded ?? false);
  const remote = complete && !prelaunch && probe !== null ? remoteFactsFrom(probe, ctx.remoteRoot) : undefined;
  return {
    hostId: ctx.hostId,
    mode,
    startedAt,
    finishedAt: now().toISOString(),
    results,
    reachable,
    probeComplete: complete,
    // A prelaunch run checks a subset: it is a liveness answer, never a capability statement.
    detectedTier: complete && !prelaunch ? computeDetectedTier(results, runtimes) : null,
    runtimes,
    arch: complete ? probe?.unameM ?? null : null,
    osVersion: complete ? osVersionFrom(probe) : null,
    toolchainHash,
    appVersion: ctx.appVersion,
    ...(remote !== undefined ? { remote } : {}),
  };
}
