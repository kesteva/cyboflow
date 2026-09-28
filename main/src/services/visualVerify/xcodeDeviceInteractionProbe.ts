/**
 * XcodeDeviceInteractionProbe — can this host run the Xcode 27 DeviceInteraction
 * drive/observe rung, and is cyboflow approved to? (docs/proposals/
 * runbook-optional-verification.md §B2; health/preflight id `xcode-mcp`).
 *
 * SPAWN-FREE BY CONTRACT (review finding B-3). This probe NEVER spawns
 * `mcpbridge` and never calls `XcodeListWorkspaces`: a bridge spawn inferably
 * starts headless Xcode, and running one on the health panel or gate hot path
 * would be a side effect of LOOKING. Everything here comes from four read-only
 * commands:
 *  1. `xcrun --find mcpbridge`            — the bridge exists (Xcode 27+);
 *  2. `xcodebuild -version`               — Xcode major ≥ 27;
 *  3. `xcrun simctl list runtimes -j`     — an AVAILABLE iOS ≥ 27 runtime
 *                                            (DeviceInteraction refuses older ones);
 *  4. `xcrun mcp-server status --format json`, parsed ONCE, for both headless
 *     mode (`permission.enabled`) and the approval grant.
 * Only the runner, inside a request, spawns the bridge — and its
 * `DeviceInteractionStartSession` is the AUTHORITATIVE approval check. This
 * probe is the cheap early read that decides the engine and fills the health
 * row; it can be wrong in the unrecognised-trust case, which is why that case
 * is `inconclusive` (the runner still attempts xcode under `auto`), never a
 * confident "not approved".
 *
 * APPROVAL (B0, B-1). Xcode keys a grant on the binary that spawns the bridge —
 * the main process's `process.execPath`, injected as {@link
 * XcodeDeviceInteractionProbeDeps.execPath}. Approved means:
 *  - `permission.unsafeAlwaysAllowAllAgents` (never set BY cyboflow, but it
 *    counts when a user did), or
 *  - a `permittedAgents[]` entry whose `trust.unsigned` names that path AND
 *    that file's current sha256 (a dev Electron is ad-hoc signed ⇒ unsigned; an
 *    Electron bump changes the hash and silently voids the grant), with no
 *    `expiration` or one later than now + the 20-minute request ceiling + a
 *    margin. `expiration` is CFAbsoluteTime: + 978307200 gives unix seconds.
 * A signed client's trust shape is UNMEASURED (a packaged Developer-ID build may
 * get durable trust). An entry whose trust carries any key but `unsigned`
 * counts as ours when it names our path. Otherwise, a path that is not ours
 * or no path at all, it is NOT a confident "not ours": a signed grant may key
 * on the code signature and record the bundle path or a stale install path, so
 * it makes the answer `inconclusive`. Treating it as "not ours" would degrade
 * a packaged build holding durable trust on every request, and B-3 forbids
 * that. The one exception is an `unsigned` entry that names our path, which
 * proves Xcode classes this binary as unsigned. Then no signed-shape entry can
 * be ours, and the unsigned grant's own verdict (expired, binary changed)
 * stands.
 *
 * THE THREE-WAY RULE of {@link XcodeToolchainBackend} holds per check: a command
 * that could not run, or answered in a shape not recognised, is
 * `inconclusive`; only an affirmative answer is `failed`. Reporting "install
 * Xcode 27" because `simctl` timed out is the bug that split exists to prevent.
 *
 * Shaped after XcodeToolchainBackend: an injected exec seam, a 60 s memo shared
 * by concurrent callers, and a probe that NEVER throws.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import type { LoggerLike } from '../../orchestrator/types';
import {
  compareSimVersions,
  type AppleCliExec,
  type AppleCliExecResult,
} from '../../orchestrator/verify/mobileSimulatorSession';
import { parseXcodeVersion, SIMCTL_FIRST_LAUNCH_HINT } from './xcodeToolchainBackend';

/** The preflight / health-panel row id (§B2). */
export const XCODE_MCP_PROBE_ID = 'xcode-mcp';

/** DeviceInteraction needs Xcode 27 and an iOS 27.0+ simulator runtime (B0). */
export const MIN_DEVICE_INTERACTION_MAJOR = 27;

/** Seconds between the unix epoch and the CFAbsoluteTime epoch (2001-01-01T00:00:00Z). */
export const CF_ABSOLUTE_TIME_EPOCH_OFFSET_S = 978_307_200;

/** The B8 action a user takes to (re-)grant access; the health row renders it as a button. */
export const APPROVE_XCODE_ACCESS_REMEDY = 'Approve Xcode access';

const PROBE_TTL_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/** The longest a verification request may run (§B2: "now + 20 min + margin"). */
const DEFAULT_REQUEST_CEILING_MS = 20 * 60_000;
const DEFAULT_EXPIRY_MARGIN_MS = 5 * 60_000;

export type XcodeDeviceInteractionOutcome =
  | 'available'
  | 'approval-required'
  | 'expiring'
  | 'inconclusive'
  | 'unavailable';

export type XcodeMcpCheckId = 'mcpbridge' | 'xcode-version' | 'ios-runtime' | 'headless-enabled' | 'approval';

/** One line of the health row / preflight evidence. `ok` is `status === 'ok'`. */
export interface XcodeMcpCheck {
  id: XcodeMcpCheckId;
  ok: boolean;
  /** `failed` only on an affirmative no; `inconclusive` when the host could not be asked. */
  status: 'ok' | 'failed' | 'inconclusive';
  detail: string;
  /** What the user can do, or `null` when nothing (or nothing needed). Shown, never run. */
  remedy: string | null;
}

/** The approval answer behind the `approval` check. */
export type XcodeApprovalState =
  | 'approved'
  /** Approved now, but the grant ends before a request could finish. */
  | 'expiring'
  | 'expired'
  /** A grant names our path but a different sha256 — the binary changed since approval. */
  | 'binary-changed'
  | 'missing'
  /** Could not tell: an unrecognised trust shape, an unreadable binary, or no status at all. */
  | 'unknown';

/** The grant that decided an approved/expiring/expired answer. */
export interface XcodeMcpGrant {
  source: 'always-allow-all-agents' | 'unsigned' | 'unrecognised-trust';
  /** The `permittedAgents[].id`, e.g. for `xcrun mcp-server deny <id>`; `null` for always-allow. */
  agentId: string | null;
  /** Unix ms; `null` = no expiration (durable). */
  expiresAt: number | null;
}

export interface XcodeDeviceInteractionProbeResult {
  outcome: XcodeDeviceInteractionOutcome;
  /** One human sentence: what decided the outcome. */
  detail: string;
  checks: XcodeMcpCheck[];
  approval: XcodeApprovalState;
  grant: XcodeMcpGrant | null;
  /**
   * Ids under any `permission.pending*` array, when such a key exists. Its
   * name is UNMEASURED (B-3), so this is empty unless the status JSON actually
   * carries one — never guessed.
   */
  pendingRequestIds: string[];
  xcodeVersion: string | null;
  mcpbridgePath: string | null;
  /** e.g. `iOS 27.0` — the newest available runtime at or above the minimum. */
  iosRuntime: string | null;
  /** Unix ms the probe completed. */
  checkedAt: number;
}

export interface XcodeDeviceInteractionProbeDeps {
  exec: AppleCliExec;
  /** The binary that will spawn the bridge: the MAIN process's `process.execPath`. */
  execPath: string;
  /** sha256 (hex) of a file. Defaults to a streaming read. */
  hashFile?: (absPath: string) => Promise<string>;
  /** Defaults to `fs.promises.realpath`. */
  realpath?: (target: string) => Promise<string>;
  platform?: NodeJS.Platform;
  now?: () => number;
  logger?: LoggerLike;
  commandTimeoutMs?: number;
  requestCeilingMs?: number;
  expiryMarginMs?: number;
}

/** CFAbsoluteTime seconds → unix milliseconds. */
export function cfAbsoluteTimeToUnixMs(seconds: number): number {
  return Math.round((seconds + CF_ABSOLUTE_TIME_EPOCH_OFFSET_S) * 1000);
}

/** The major version out of `xcodebuild -version` (`Xcode 27.0` → 27), or `null`. */
export function parseXcodeMajor(stdout: string): number | null {
  const version = parseXcodeVersion(stdout);
  if (version === null) return null;
  const major = Number.parseInt(version.split('.')[0] as string, 10);
  return Number.isInteger(major) ? major : null;
}

/**
 * The degrade reason the runner records (§B3) when this probe steers it off
 * xcode, or `null` when the probe does not (available / inconclusive: under
 * `auto` both still attempt xcode, and StartSession decides).
 */
export function degradeReasonForProbe(
  result: Pick<XcodeDeviceInteractionProbeResult, 'outcome' | 'approval'>,
): 'xcode-approval-missing' | 'xcode-approval-expired' | 'xcode-unavailable' | null {
  switch (result.outcome) {
    case 'unavailable':
      return 'xcode-unavailable';
    case 'expiring':
      return 'xcode-approval-expired';
    case 'approval-required':
      return result.approval === 'expired' ? 'xcode-approval-expired' : 'xcode-approval-missing';
    case 'available':
    case 'inconclusive':
      return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Fold a command's stderr into one bounded clause, or nothing when it said nothing. */
function trimForDetail(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? '' : `: ${trimmed.slice(0, 200)}`;
}

async function defaultHashFile(absPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

type Settled = { ran: true; result: AppleCliExecResult } | { ran: false; error: string };

type ExpirationRead = { kind: 'none' } | { kind: 'at'; ms: number } | { kind: 'unreadable' };

function readExpiration(value: unknown): ExpirationRead {
  if (value === undefined || value === null) return { kind: 'none' };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'at', ms: cfAbsoluteTimeToUnixMs(value) };
  return { kind: 'unreadable' };
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

const MCPBRIDGE_REMEDY =
  'Install Xcode 27 or later and make it the active developer directory (`sudo xcode-select -s /Applications/Xcode.app`)';
const XCODE_VERSION_REMEDY = 'Install Xcode 27 or later';
const IOS_RUNTIME_REMEDY = '`xcodebuild -downloadPlatform iOS`';
const HEADLESS_REMEDY = '`sudo xcrun mcp-server enable`';

interface ApprovalAssessment {
  state: XcodeApprovalState;
  grant: XcodeMcpGrant | null;
  check: XcodeMcpCheck;
}

export class XcodeDeviceInteractionProbe {
  private readonly exec: AppleCliExec;
  private readonly execPath: string;
  private readonly hashFile: (absPath: string) => Promise<string>;
  private readonly realpath: (target: string) => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly logger?: LoggerLike;
  private readonly timeoutMs: number;
  private readonly requestCeilingMs: number;
  private readonly expiryMarginMs: number;

  private cached: { at: number; result: XcodeDeviceInteractionProbeResult } | null = null;
  private inFlight: Promise<XcodeDeviceInteractionProbeResult> | null = null;

  constructor(deps: XcodeDeviceInteractionProbeDeps) {
    this.exec = deps.exec;
    this.execPath = deps.execPath;
    this.hashFile = deps.hashFile ?? defaultHashFile;
    this.realpath = deps.realpath ?? fsRealpath;
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
    this.timeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.requestCeilingMs = deps.requestCeilingMs ?? DEFAULT_REQUEST_CEILING_MS;
    this.expiryMarginMs = deps.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS;
  }

  /** The probe, memoized for 60 s against the injected clock and shared by concurrent callers. NEVER throws. */
  async probe(): Promise<XcodeDeviceInteractionProbeResult> {
    const cached = this.cached;
    if (cached !== null && this.now() - cached.at < PROBE_TTL_MS) return cached.result;
    if (this.inFlight !== null) return this.inFlight;
    const attempt = this.compute()
      .catch((err: unknown): XcodeDeviceInteractionProbeResult => {
        // compute() handles every expected failure itself; this is the backstop
        // that keeps "never throws" true for the unexpected one.
        this.logger?.warn('[XcodeDeviceInteractionProbe] probe threw', { error: errorText(err) });
        return this.result('inconclusive', `the Xcode MCP probe failed unexpectedly: ${errorText(err)}`, [], {
          approval: 'unknown',
        });
      })
      .then((result) => {
        this.cached = { at: this.now(), result };
        return result;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = attempt;
    return attempt;
  }

  /** Drop the memo — e.g. right after the B8 "Approve Xcode access" action. */
  invalidate(): void {
    this.cached = null;
  }

  private async run(command: string, args: readonly string[]): Promise<Settled> {
    try {
      return { ran: true, result: await this.exec(command, args, { timeoutMs: this.timeoutMs }) };
    } catch (err) {
      return { ran: false, error: errorText(err) };
    }
  }

  private result(
    outcome: XcodeDeviceInteractionOutcome,
    detail: string,
    checks: XcodeMcpCheck[],
    extra: Partial<Omit<XcodeDeviceInteractionProbeResult, 'outcome' | 'detail' | 'checks' | 'checkedAt'>>,
  ): XcodeDeviceInteractionProbeResult {
    return {
      outcome,
      detail,
      checks,
      approval: extra.approval ?? 'unknown',
      grant: extra.grant ?? null,
      pendingRequestIds: extra.pendingRequestIds ?? [],
      xcodeVersion: extra.xcodeVersion ?? null,
      mcpbridgePath: extra.mcpbridgePath ?? null,
      iosRuntime: extra.iosRuntime ?? null,
      checkedAt: this.now(),
    };
  }

  private async compute(): Promise<XcodeDeviceInteractionProbeResult> {
    if (this.platform !== 'darwin') {
      // No Xcode off darwin, and nothing to ask: spawn NOTHING.
      return this.result(
        'unavailable',
        `Xcode DeviceInteraction requires macOS; this host reports platform "${this.platform}"`,
        [
          {
            id: 'mcpbridge',
            ok: false,
            status: 'failed',
            detail: `requires macOS (platform "${this.platform}")`,
            remedy: null,
          },
        ],
        {},
      );
    }

    const [find, xcodebuild, runtimes, status] = await Promise.all([
      this.run('xcrun', ['--find', 'mcpbridge']),
      this.run('xcodebuild', ['-version']),
      this.run('xcrun', ['simctl', 'list', 'runtimes', '-j']),
      this.run('xcrun', ['mcp-server', 'status', '--format', 'json']),
    ]);

    const bridge = this.assessBridge(find);
    const version = this.assessXcodeVersion(xcodebuild);
    const runtime = this.assessRuntime(runtimes);
    const server = await this.assessStatus(status);

    const checks = [bridge.check, version.check, runtime.check, server.headless, server.approval.check];
    const extra = {
      approval: server.approval.state,
      grant: server.approval.grant,
      pendingRequestIds: server.pendingRequestIds,
      xcodeVersion: version.version,
      mcpbridgePath: bridge.path,
      iosRuntime: runtime.name,
    };

    // Precedence: an AFFIRMATIVE answer always outranks an unknown one. A
    // missing prerequisite ⇒ unavailable; a known-bad grant ⇒ approval-required
    // or expiring even if some other check could not be asked; only then does an
    // unknown make the whole answer inconclusive.
    const prerequisites = [bridge.check, version.check, runtime.check, server.headless];
    const failed = prerequisites.find((check) => check.status === 'failed');
    if (failed !== undefined) return this.result('unavailable', failed.detail, checks, extra);
    const approvalState = server.approval.state;
    if (approvalState === 'missing' || approvalState === 'expired' || approvalState === 'binary-changed') {
      return this.result('approval-required', server.approval.check.detail, checks, extra);
    }
    if (approvalState === 'expiring') return this.result('expiring', server.approval.check.detail, checks, extra);
    const unknown = prerequisites.find((check) => check.status === 'inconclusive');
    if (unknown !== undefined) return this.result('inconclusive', unknown.detail, checks, extra);
    if (approvalState === 'unknown') return this.result('inconclusive', server.approval.check.detail, checks, extra);
    return this.result(
      'available',
      `Xcode ${version.version ?? '27+'} with ${runtime.name ?? 'an iOS 27+ runtime'}, headless mode on; ${server.approval.check.detail}`,
      checks,
      extra,
    );
  }

  private assessBridge(settled: Settled): { check: XcodeMcpCheck; path: string | null } {
    if (!settled.ran) {
      return {
        path: null,
        check: {
          id: 'mcpbridge',
          ok: false,
          status: 'inconclusive',
          detail: `\`xcrun --find mcpbridge\` could not run: ${settled.error}`,
          remedy: null,
        },
      };
    }
    const { result } = settled;
    const found = result.stdout.trim().split('\n')[0]?.trim() ?? '';
    if (result.code !== 0) {
      return {
        path: null,
        check: {
          id: 'mcpbridge',
          ok: false,
          status: 'failed',
          detail: `\`xcrun\` cannot find mcpbridge — the active Xcode predates 27${trimForDetail(result.stderr)}`,
          remedy: MCPBRIDGE_REMEDY,
        },
      };
    }
    if (!found.startsWith('/')) {
      return {
        path: null,
        check: {
          id: 'mcpbridge',
          ok: false,
          status: 'inconclusive',
          detail: '`xcrun --find mcpbridge` succeeded but printed no path',
          remedy: null,
        },
      };
    }
    return { path: found, check: { id: 'mcpbridge', ok: true, status: 'ok', detail: found, remedy: null } };
  }

  private assessXcodeVersion(settled: Settled): { check: XcodeMcpCheck; version: string | null } {
    const check = (status: XcodeMcpCheck['status'], detail: string, remedy: string | null): XcodeMcpCheck => ({
      id: 'xcode-version',
      ok: status === 'ok',
      status,
      detail,
      remedy,
    });
    if (!settled.ran) {
      return { version: null, check: check('inconclusive', `\`xcodebuild -version\` could not run: ${settled.error}`, null) };
    }
    const { result } = settled;
    if (result.code !== 0) {
      return {
        version: null,
        check: check(
          'failed',
          `Xcode command-line tools unavailable: \`xcodebuild -version\` exited ${result.code ?? 'null'}${trimForDetail(result.stderr)}`,
          XCODE_VERSION_REMEDY,
        ),
      };
    }
    const version = parseXcodeVersion(result.stdout);
    const major = parseXcodeMajor(result.stdout);
    if (version === null || major === null) {
      return { version: null, check: check('inconclusive', '`xcodebuild -version` printed no readable version', null) };
    }
    if (major < MIN_DEVICE_INTERACTION_MAJOR) {
      return {
        version,
        check: check(
          'failed',
          `Xcode ${version} is older than ${MIN_DEVICE_INTERACTION_MAJOR}, which DeviceInteraction requires`,
          XCODE_VERSION_REMEDY,
        ),
      };
    }
    return { version, check: check('ok', `Xcode ${version}`, null) };
  }

  private assessRuntime(settled: Settled): { check: XcodeMcpCheck; name: string | null } {
    const check = (status: XcodeMcpCheck['status'], detail: string, remedy: string | null): XcodeMcpCheck => ({
      id: 'ios-runtime',
      ok: status === 'ok',
      status,
      detail,
      remedy,
    });
    if (!settled.ran) {
      return {
        name: null,
        check: check(
          'inconclusive',
          `\`xcrun simctl list runtimes -j\` could not run: ${settled.error}${SIMCTL_FIRST_LAUNCH_HINT}`,
          null,
        ),
      };
    }
    const { result } = settled;
    if (result.code !== 0) {
      // The tool ran but refused: says nothing about which runtimes exist.
      return {
        name: null,
        check: check(
          'inconclusive',
          `\`xcrun simctl list runtimes -j\` exited ${result.code ?? 'null'}${trimForDetail(result.stderr)}`,
          null,
        ),
      };
    }
    let root: Record<string, unknown> | null;
    try {
      root = asRecord(JSON.parse(result.stdout));
    } catch (err) {
      return {
        name: null,
        check: check('inconclusive', `\`xcrun simctl list runtimes -j\` produced unreadable JSON: ${errorText(err)}`, null),
      };
    }
    if (root === null || !Array.isArray(root.runtimes)) {
      return { name: null, check: check('inconclusive', '`xcrun simctl list runtimes -j` has no runtimes list', null) };
    }
    const ios = root.runtimes
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => {
        if (entry === null) return false;
        const platform = asNonEmptyString(entry.platform);
        const identifier = asNonEmptyString(entry.identifier) ?? '';
        return platform !== null ? platform === 'iOS' : /SimRuntime\.iOS-/i.test(identifier);
      })
      .map((entry) => {
        const version = asNonEmptyString(entry.version) ?? '';
        const major = Number.parseInt(version.split('.')[0] as string, 10);
        return {
          available: entry.isAvailable === true,
          version,
          major: Number.isInteger(major) ? major : -1,
          name: asNonEmptyString(entry.name) ?? `iOS ${version}`,
          build: asNonEmptyString(entry.buildversion),
        };
      });
    const eligible = ios
      .filter((entry) => entry.available && entry.major >= MIN_DEVICE_INTERACTION_MAJOR)
      .sort((a, b) => compareSimVersions(b.version, a.version));
    const best = eligible[0];
    if (best === undefined) {
      const installed = ios.filter((entry) => entry.available).map((entry) => entry.name);
      return {
        name: null,
        check: check(
          'failed',
          `no available iOS ${MIN_DEVICE_INTERACTION_MAJOR}.0+ simulator runtime (installed: ${
            installed.length > 0 ? installed.join(', ') : 'none'
          })`,
          IOS_RUNTIME_REMEDY,
        ),
      };
    }
    return {
      name: best.name,
      check: check('ok', `${best.name}${best.build !== null ? ` (${best.build})` : ''}`, null),
    };
  }

  private async assessStatus(settled: Settled): Promise<{
    headless: XcodeMcpCheck;
    approval: ApprovalAssessment;
    pendingRequestIds: string[];
  }> {
    const headless = (status: XcodeMcpCheck['status'], detail: string, remedy: string | null): XcodeMcpCheck => ({
      id: 'headless-enabled',
      ok: status === 'ok',
      status,
      detail,
      remedy,
    });
    const unknownApproval = (detail: string): ApprovalAssessment => ({
      state: 'unknown',
      grant: null,
      check: { id: 'approval', ok: false, status: 'inconclusive', detail, remedy: null },
    });

    if (!settled.ran) {
      const detail = `\`xcrun mcp-server status\` could not run: ${settled.error}`;
      return { headless: headless('inconclusive', detail, null), approval: unknownApproval(detail), pendingRequestIds: [] };
    }
    const { result } = settled;
    if (result.code !== 0) {
      const said = `${result.stderr}\n${result.stdout}`;
      if (/unable to find utility/i.test(said)) {
        const detail = `this Xcode has no \`mcp-server\` tool${trimForDetail(result.stderr)}`;
        return {
          headless: headless('failed', detail, MCPBRIDGE_REMEDY),
          approval: unknownApproval('not checked: Xcode has no MCP server'),
          pendingRequestIds: [],
        };
      }
      const detail = `\`xcrun mcp-server status\` exited ${result.code ?? 'null'}${trimForDetail(result.stderr)}`;
      return { headless: headless('inconclusive', detail, null), approval: unknownApproval(detail), pendingRequestIds: [] };
    }
    let root: Record<string, unknown> | null;
    try {
      root = asRecord(JSON.parse(result.stdout));
    } catch (err) {
      const detail = `\`xcrun mcp-server status\` produced unreadable JSON: ${errorText(err)}`;
      return { headless: headless('inconclusive', detail, null), approval: unknownApproval(detail), pendingRequestIds: [] };
    }
    const permission = asRecord(root?.permission);
    if (permission === null || typeof permission.enabled !== 'boolean') {
      const detail = '`xcrun mcp-server status` JSON has no recognisable permission.enabled';
      return { headless: headless('inconclusive', detail, null), approval: unknownApproval(detail), pendingRequestIds: [] };
    }

    const headlessCheck = permission.enabled
      ? headless('ok', 'headless mode is enabled', null)
      : headless('failed', 'Xcode headless MCP mode is disabled', HEADLESS_REMEDY);
    return {
      headless: headlessCheck,
      approval: await this.assessApproval(permission),
      pendingRequestIds: pendingIds(permission),
    };
  }

  private async assessApproval(permission: Record<string, unknown>): Promise<ApprovalAssessment> {
    const approvalCheck = (
      status: XcodeMcpCheck['status'],
      detail: string,
      remedy: string | null,
    ): XcodeMcpCheck => ({ id: 'approval', ok: status === 'ok', status, detail, remedy });

    if (permission.unsafeAlwaysAllowAllAgents === true) {
      return {
        state: 'approved',
        grant: { source: 'always-allow-all-agents', agentId: null, expiresAt: null },
        check: approvalCheck('ok', 'every agent is allowed (unsafeAlwaysAllowAllAgents)', null),
      };
    }
    const agents = permission.permittedAgents;
    if (agents !== undefined && !Array.isArray(agents)) {
      return {
        state: 'unknown',
        grant: null,
        check: approvalCheck('inconclusive', 'permission.permittedAgents is not a list', null),
      };
    }

    const identities = new Set<string>([this.execPath]);
    try {
      identities.add(await this.realpath(this.execPath));
    } catch {
      // An unresolvable path still matches verbatim.
    }
    let ownHash: Promise<string | null> | null = null;
    const hashOnce = (): Promise<string | null> => {
      if (ownHash === null) {
        ownHash = this.hashFile(this.execPath).then(
          (hex) => hex.toLowerCase(),
          (err: unknown) => {
            this.logger?.info('[XcodeDeviceInteractionProbe] could not hash the bridge-spawning binary', {
              error: errorText(err),
            });
            return null;
          },
        );
      }
      return ownHash;
    };

    const matches: XcodeMcpGrant[] = [];
    let unrecognised = 0;
    /** Unmeasured-shape entries that do not name our path: possibly ours, unless we are known unsigned. */
    let unmatchedUnknownShape = 0;
    /** An `unsigned` entry names our path: Xcode keys THIS binary as unsigned. */
    let ownUnsignedEntry = false;
    let binaryChanged = false;
    let unhashable = false;
    for (const raw of agents ?? []) {
      const entry = asRecord(raw);
      const trust = asRecord(entry?.trust);
      if (entry === null || trust === null) {
        unrecognised += 1;
        continue;
      }
      const agentId = asNonEmptyString(entry.id);
      for (const [shape, body] of Object.entries(trust)) {
        const record = asRecord(body);
        const grantPath = asNonEmptyString(record?.path);
        if (shape === 'unsigned') {
          const sha = asNonEmptyString(record?.sha256);
          if (grantPath === null || sha === null) {
            unrecognised += 1;
            continue;
          }
          if (!identities.has(grantPath)) continue; // another client's grant
          ownUnsignedEntry = true;
          const own = await hashOnce();
          if (own === null) {
            unhashable = true;
            continue;
          }
          if (own !== sha.toLowerCase()) {
            binaryChanged = true;
            continue;
          }
          const expiration = readExpiration(record?.expiration);
          if (expiration.kind === 'unreadable') {
            unrecognised += 1;
            continue;
          }
          matches.push({ source: 'unsigned', agentId, expiresAt: expiration.kind === 'at' ? expiration.ms : null });
          continue;
        }
        // An unmeasured trust shape (e.g. a signed client's). One that names
        // our path counts. Any other, whether it names a foreign path or no
        // path, leaves the answer open, because a signature-keyed grant need
        // not record our executable's path (see the header).
        if (grantPath === null || !identities.has(grantPath)) {
          unmatchedUnknownShape += 1;
          continue;
        }
        const expiration = readExpiration(record?.expiration);
        if (expiration.kind === 'unreadable') {
          unrecognised += 1;
          continue;
        }
        matches.push({
          source: 'unrecognised-trust',
          agentId,
          expiresAt: expiration.kind === 'at' ? expiration.ms : null,
        });
      }
    }

    const now = this.now();
    const validUntil = now + this.requestCeilingMs + this.expiryMarginMs;
    const durable = matches.find((grant) => grant.expiresAt === null);
    const latest = [...matches].sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
    const best = durable ?? latest;
    if (best !== undefined && (best.expiresAt === null || best.expiresAt > validUntil)) {
      return {
        state: 'approved',
        grant: best,
        check: approvalCheck(
          'ok',
          best.expiresAt === null
            ? `approved for ${this.execPath} (no expiry)`
            : `approved for ${this.execPath} until ${isoOf(best.expiresAt)}`,
          null,
        ),
      };
    }
    if (unrecognised > 0 || unhashable || (unmatchedUnknownShape > 0 && !ownUnsignedEntry)) {
      return {
        state: 'unknown',
        grant: null,
        check: approvalCheck(
          'inconclusive',
          unhashable
            ? `could not hash ${this.execPath} to match Xcode's grant; the session start will decide`
            : "Xcode lists a trust entry in a shape cyboflow does not recognise; the session start will decide",
          null,
        ),
      };
    }
    if (best !== undefined && best.expiresAt !== null && best.expiresAt > now) {
      return {
        state: 'expiring',
        grant: best,
        check: approvalCheck(
          'failed',
          `the Xcode grant for ${this.execPath} expires at ${isoOf(best.expiresAt)}, before a verification could finish`,
          `${APPROVE_XCODE_ACCESS_REMEDY} (the current grant expires at ${isoOf(best.expiresAt)})`,
        ),
      };
    }
    if (best !== undefined && best.expiresAt !== null) {
      return {
        state: 'expired',
        grant: best,
        check: approvalCheck(
          'failed',
          `the Xcode grant for ${this.execPath} expired at ${isoOf(best.expiresAt)}`,
          APPROVE_XCODE_ACCESS_REMEDY,
        ),
      };
    }
    if (binaryChanged) {
      return {
        state: 'binary-changed',
        grant: null,
        check: approvalCheck(
          'failed',
          `Xcode's grant for ${this.execPath} was made for a different build of it (sha256 mismatch, e.g. after an app or Electron update)`,
          APPROVE_XCODE_ACCESS_REMEDY,
        ),
      };
    }
    return {
      state: 'missing',
      grant: null,
      check: approvalCheck('failed', `Xcode has no MCP grant for ${this.execPath}`, APPROVE_XCODE_ACCESS_REMEDY),
    };
  }
}

/** Ids under any `permission.pending*` array — only when the (unmeasured) key actually exists. */
function pendingIds(permission: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const [key, value] of Object.entries(permission)) {
    if (!/^pending/i.test(key) || !Array.isArray(value)) continue;
    for (const item of value) {
      const id = asNonEmptyString(asRecord(item)?.id);
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
