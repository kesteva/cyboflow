/**
 * Preflight checks — one PURE function per check id, from the parsed remote probe (plus context) to a
 * check outcome. The engine stamps `durationMs` and emits them; nothing here does I/O.
 *
 * Tier impact (spec table): ssh-reachable blocks-cli; arch, git, node22, sdk-binary-hash, mcp-roundtrip and
 * repo-root-tcc block full; the rest are informational, except a disk-free FAIL which blocks full.
 *
 * The three M2 checks that observe a remote round trip (mcp-roundtrip, the live claude-auth) are judged here from
 * the engine's observation (exit code, stdout) — the I/O itself lives in preflightEngine.ts.
 */
import {
  redactSecrets,
  type PreflightCheckId,
  type PreflightCheckResult,
  type TierImpact,
} from '../../../../../shared/types/hosts';
import type { ExecResult } from '../../../orchestrator/trpc/contracts/executionHost';
import type { ProbeRecord } from '../remoteProbe';
import type { SshFailure } from '../sshTransport';
import { TOOLCHAIN_CLAUDE_REL, TOOLCHAIN_MCP_REL } from '../toolchain/types';

export type CheckOutcome = Omit<PreflightCheckResult, 'durationMs'>;

export const CHECK_LABELS: Record<PreflightCheckId, string> = {
  'ssh-reachable': 'SSH reachable',
  arch: 'Architecture',
  'os-version': 'OS version',
  git: 'Git',
  node22: 'Node.js 22+',
  'sdk-binary-hash': 'Agent toolchain',
  'mcp-roundtrip': 'cyboflow tools link',
  'claude-auth': 'Claude sign-in',
  'codex-auth': 'Codex sign-in',
  'sleep-settings': 'Sleep',
  'repo-root-tcc': 'Workspace folder',
  'disk-free': 'Disk space',
};

export const CHECK_TIER_IMPACT: Record<PreflightCheckId, TierImpact> = {
  'ssh-reachable': 'blocks-cli',
  arch: 'blocks-full',
  'os-version': 'none',
  git: 'blocks-full',
  node22: 'blocks-full',
  'sdk-binary-hash': 'blocks-full',
  'mcp-roundtrip': 'blocks-full',
  'claude-auth': 'none',
  'codex-auth': 'none',
  'sleep-settings': 'none',
  'repo-root-tcc': 'blocks-full',
  'disk-free': 'none',
};

export const NOT_REACHABLE_DETAIL = 'Skipped: machine not reachable';
export const ARRIVES_LATER_DETAIL = 'Arrives with remote flows';

const KIB_PER_GIB = 1024 * 1024;
export const DISK_FAIL_BELOW_KB = 2 * KIB_PER_GIB;
export const DISK_WARN_BELOW_KB = 10 * KIB_PER_GIB;

function outcome(
  id: PreflightCheckId,
  status: CheckOutcome['status'],
  detail: string,
  fix?: string,
  tierImpact: TierImpact = CHECK_TIER_IMPACT[id],
): CheckOutcome {
  return { id, label: CHECK_LABELS[id], status, detail, ...(fix !== undefined ? { fix } : {}), tierImpact };
}

export function skippedCheck(id: PreflightCheckId, detail: string): CheckOutcome {
  return outcome(id, 'skipped', detail);
}

export function naCheck(id: PreflightCheckId, detail: string): CheckOutcome {
  // A not-applicable row never gates a tier.
  return outcome(id, 'na', detail, undefined, 'none');
}

const isDarwin = (p: ProbeRecord): boolean => p.unameS === 'Darwin';

/** `failure` null = `ssh … true` exited 0. */
export function checkSshReachable(failure: SshFailure | null): CheckOutcome {
  if (failure === null) return outcome('ssh-reachable', 'pass', 'Connected');
  return outcome('ssh-reachable', 'fail', failure.detail, failure.fix);
}

export function checkArch(p: ProbeRecord): CheckOutcome {
  const m = p.unameM;
  if (m === null) return outcome('arch', 'fail', 'Could not read the architecture');
  if (m === 'arm64' || m === 'aarch64' || m === 'x86_64') return outcome('arch', 'pass', m);
  return outcome('arch', 'fail', `${m} is not supported (arm64 or x86_64 only)`);
}

/** Leading integer of a dotted version ("15.1.1" -> 15, "v22.3.0" -> 22); null when unparseable. */
export function majorVersion(v: string | null): number | null {
  if (v === null) return null;
  const m = /^v?(\d+)/.exec(v.trim());
  return m ? Number.parseInt(m[1], 10) : null;
}

export function checkOsVersion(p: ProbeRecord): CheckOutcome {
  if (isDarwin(p)) {
    const major = majorVersion(p.osVersion);
    if (major === null) return outcome('os-version', 'warn', 'Could not read the macOS version');
    if (major >= 13) return outcome('os-version', 'pass', `macOS ${p.osVersion}`);
    return outcome('os-version', 'warn', `macOS ${p.osVersion} is older than macOS 13`, 'Update macOS to 13 or newer');
  }
  if (p.unameS === 'Linux') return outcome('os-version', 'pass', p.osVersion ?? 'Linux');
  return outcome('os-version', 'warn', p.unameS ? `Untested system: ${p.unameS}` : 'Could not read the operating system');
}

export function checkGit(p: ProbeRecord): CheckOutcome {
  if (p.gitVersion !== null) return outcome('git', 'pass', p.gitVersion);
  if (isDarwin(p) && p.xcodeClt === false) {
    return outcome('git', 'fail', 'Xcode Command Line Tools are not installed', 'xcode-select --install');
  }
  return outcome('git', 'fail', 'git was not found', isDarwin(p) ? 'xcode-select --install' : 'Install git with your package manager');
}

export function checkNode22(p: ProbeRecord): CheckOutcome {
  const fix = isDarwin(p) ? 'brew install node@22' : 'Install Node.js 22 or newer (https://nodejs.org)';
  if (p.nodeVersion === null) return outcome('node22', 'fail', 'Node.js was not found', fix);
  const major = majorVersion(p.nodeVersion);
  if (major !== null && major >= 22) return outcome('node22', 'pass', `${p.nodeVersion} (${p.nodePath ?? 'node'})`);
  return outcome('node22', 'fail', `${p.nodeVersion} is older than Node.js 22`, fix);
}

export const TOOLCHAIN_FIX = 'Install cyboflow tools';
export const TOOLCHAIN_NOT_INSTALLED_DETAIL = 'Not installed';
export const TOOLCHAIN_DAMAGED_DETAIL = 'Installed tools are damaged';
export const TOOLCHAIN_UNCHECKED_DETAIL = 'Could not check the installed tools';

/** One file of the expected toolchain whose installed size the probe reports. */
export interface ExpectedToolchainFile {
  rel: string;
  size: number;
}

/**
 * This Mac's toolchain for the machine's arch (spec A6): what an install of it must look like on the machine.
 * `expectedHash` is null exactly when this build cannot produce one (`unavailableReason` says why).
 */
export interface ExpectedToolchain {
  expectedHash: string | null;
  /** The claude binary, the MCP bundle and (when included) the codex entrypoint, with their sizes. */
  files: ExpectedToolchainFile[];
  codexIncluded: boolean;
  unavailableReason: string | null;
}

/** The codex entrypoint among the expected files (`codex/<target>/bin/codex`), or null. */
export function codexBinFile(expected: Pick<ExpectedToolchain, 'files'>): ExpectedToolchainFile | null {
  return expected.files.find((f) => /^codex\/[^/]+\/bin\/codex$/.test(f.rel)) ?? null;
}

const shortHash = (h: string): string => h.slice(0, 12);

/**
 * `expected` undefined = the toolchain is not wired (the M1 shape: skipped). Otherwise: unavailable for this
 * build → fail; no manifest → warn "Not installed"; a manifest without the hash or a size mismatch → fail
 * "damaged"; else pass. Every non-pass blocks full (CHECK_TIER_IMPACT), so the tier is full only on a pass.
 */
export function checkSdkBinaryHash(p: ProbeRecord, expected: ExpectedToolchain | null | undefined): CheckOutcome {
  if (expected === undefined) return skippedCheck('sdk-binary-hash', ARRIVES_LATER_DETAIL);
  if (expected === null) return skippedCheck('sdk-binary-hash', TOOLCHAIN_UNCHECKED_DETAIL);
  if (expected.expectedHash === null) {
    return outcome('sdk-binary-hash', 'fail', expected.unavailableReason ?? 'This build of cyboflow has no tools for this machine');
  }
  const hash = expected.expectedHash;
  if (p.tcHash !== hash || p.tcManifest === null) return skippedCheck('sdk-binary-hash', TOOLCHAIN_UNCHECKED_DETAIL);
  if (p.tcManifest === false) return outcome('sdk-binary-hash', 'warn', TOOLCHAIN_NOT_INSTALLED_DETAIL, TOOLCHAIN_FIX);
  const sizeOf = (rel: string): number | null => expected.files.find((f) => f.rel === rel)?.size ?? null;
  const codex = codexBinFile(expected);
  const matches =
    p.tcManifestHash === true &&
    p.tcClaudeSize !== null && p.tcClaudeSize === sizeOf(TOOLCHAIN_CLAUDE_REL) &&
    p.tcMcpSize !== null && p.tcMcpSize === sizeOf(TOOLCHAIN_MCP_REL) &&
    (!expected.codexIncluded || (codex !== null && p.tcCodexSize === codex.size));
  if (!matches) return outcome('sdk-binary-hash', 'fail', TOOLCHAIN_DAMAGED_DETAIL, TOOLCHAIN_FIX);
  return outcome('sdk-binary-hash', 'pass', `Installed (${shortHash(hash)})`);
}

export const NEEDS_NODE_DETAIL = 'Needs Node.js 22';
export const NO_ORCH_LINK_DETAIL = 'Orchestrator link not running';
export const MCP_ROUNDTRIP_PASS_DETAIL = 'cyboflow answered through the link';
export const LINK_UP_DETAIL = 'Link up';

/** What the engine saw when it pinged this Mac's orch socket through the machine's forward. */
export type McpRoundtripObservation =
  | { kind: 'no-node' }
  | { kind: 'no-orch-socket' }
  | { kind: 'link-failed'; message: string }
  /** prelaunch: the forward could be joined (no ping). */
  | { kind: 'link-up' }
  | { kind: 'reply'; requestId: string; result: ExecResult };

function lastLine(s: string): string {
  const lines = redactSecrets(s).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const line = lines[lines.length - 1] ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Pass iff the first stdout line is JSON with the same requestId and `ok: true`. */
export function checkMcpRoundtrip(obs: McpRoundtripObservation): CheckOutcome {
  switch (obs.kind) {
    case 'no-node':
      return skippedCheck('mcp-roundtrip', NEEDS_NODE_DETAIL);
    case 'no-orch-socket':
      return skippedCheck('mcp-roundtrip', NO_ORCH_LINK_DETAIL);
    case 'link-failed':
      return outcome('mcp-roundtrip', 'fail', `Could not open the link: ${redactSecrets(obs.message)}`, 'Run the check again');
    case 'link-up':
      return outcome('mcp-roundtrip', 'pass', LINK_UP_DETAIL);
    case 'reply': {
      const r = obs.result;
      if (r.timedOut) return outcome('mcp-roundtrip', 'fail', 'No answer through the link (timed out)', 'Run the check again');
      const first = r.stdout.split('\n')[0]?.trim() ?? '';
      let reply: unknown = null;
      try {
        reply = first ? JSON.parse(first) : null;
      } catch {
        reply = null;
      }
      if (
        reply !== null && typeof reply === 'object' &&
        (reply as { requestId?: unknown }).requestId === obs.requestId &&
        (reply as { ok?: unknown }).ok === true
      ) {
        return outcome('mcp-roundtrip', 'pass', MCP_ROUNDTRIP_PASS_DETAIL);
      }
      const why = r.code !== 0 ? lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code ?? 'unknown'}` : 'unexpected answer';
      return outcome('mcp-roundtrip', 'fail', `No answer through the link: ${why}`, 'Run the check again');
    }
  }
}

/** `remoteRoot` is shown as configured (e.g. `~/cf-remote/<id>`), so the fix is copyable on the machine. */
export function checkClaudeAuth(p: ProbeRecord, remoteRoot: string): CheckOutcome {
  const envPath = `${remoteRoot.replace(/\/+$/, '')}/env`;
  if (p.envExists !== true) {
    return outcome(
      'claude-auth', 'warn', 'No Claude token on this machine yet',
      `claude setup-token   # then write CLAUDE_CODE_OAUTH_TOKEN=<token> to ${envPath} and run: chmod 600 ${envPath}`,
    );
  }
  if (p.envMode !== '600') {
    return outcome('claude-auth', 'warn', `The token file is readable by others (mode ${p.envMode ?? 'unknown'})`, `chmod 600 ${envPath}`);
  }
  if (p.envLines !== 1 || p.envWellformed !== 1) {
    return outcome(
      'claude-auth', 'warn', 'expected exactly one CLAUDE_CODE_OAUTH_TOKEN=sk-ant-… line',
      `Edit ${envPath} so it holds exactly one CLAUDE_CODE_OAUTH_TOKEN=sk-ant-… line`,
    );
  }
  return outcome('claude-auth', 'pass', 'Token present');
}

export const CLAUDE_AUTH_LIVE_PASS_DETAIL = 'Signed in (checked with one request)';

/** 401 / revoked / expired / invalid key in the CLI's answer (stdout JSON or stderr). */
const AUTH_REJECTED_RE = /\b401\b|authentication_error|revoked|invalid (api key|bearer token|x-api-key)|oauth token (has )?expired|token (has )?expired|please run \/login/i;

/**
 * The live sign-in check (full mode, toolchain installed): `claude -p ok` run on the machine with the env-file
 * token. Exit 0 → pass; an auth rejection → fail with the re-issue fix; anything else → warn with the redacted
 * last line. Never echoes the token (redactSecrets on everything shown).
 */
export function checkClaudeAuthLive(r: ExecResult, remoteRoot: string): CheckOutcome {
  if (r.code === 0 && !r.timedOut) return outcome('claude-auth', 'pass', CLAUDE_AUTH_LIVE_PASS_DETAIL);
  const envPath = `${remoteRoot.replace(/\/+$/, '')}/env`;
  const text = `${r.stdout}\n${r.stderr}`;
  if (!r.timedOut && AUTH_REJECTED_RE.test(text)) {
    return outcome(
      'claude-auth', 'fail', 'The Claude token was rejected',
      `Create a new token with claude setup-token on that Mac and save it to ${envPath}`,
    );
  }
  const tail = r.timedOut ? 'timed out' : lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code ?? 'unknown'}`;
  return outcome('claude-auth', 'warn', `Could not confirm the Claude sign-in: ${tail}`);
}

export function checkCodexAuth(p: ProbeRecord): CheckOutcome {
  if (p.codexAuth === true) return outcome('codex-auth', 'pass', 'Signed in');
  return outcome('codex-auth', 'warn', 'Codex is not signed in on this machine', 'codex login');
}

export function checkSleepSettings(p: ProbeRecord): CheckOutcome {
  if (!isDarwin(p)) return naCheck('sleep-settings', 'Only checked on macOS');
  if (p.sleepPrevented === true) return outcome('sleep-settings', 'pass', 'Sleep is prevented');
  if (p.sleepValue === '0') return outcome('sleep-settings', 'pass', 'Sleep is off');
  const detail = p.sleepValue === null
    ? 'Could not read the sleep setting'
    : `The machine sleeps after ${p.sleepValue} min idle`;
  return outcome('sleep-settings', 'warn', detail, 'sudo pmset -a sleep 0');
}

const TCC_DIRS = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents'];

/** Path of `root` relative to the home dir, or null when it is not under home. */
function relativeToHome(root: string, home: string | null): string | null {
  if (root === '~') return '';
  if (root.startsWith('~/')) return root.slice(2);
  if (home === null) return null;
  const h = home.replace(/\/+$/, '');
  if (root === h) return '';
  return root.startsWith(`${h}/`) ? root.slice(h.length + 1) : null;
}

export function checkRepoRootTcc(remoteRoot: string, home: string | null): CheckOutcome {
  const rel = relativeToHome(remoteRoot, home);
  const hit = rel === null ? undefined : TCC_DIRS.find((d) => rel === d || rel.startsWith(`${d}/`));
  if (hit !== undefined) {
    return outcome(
      'repo-root-tcc', 'fail', `${remoteRoot} is inside ~/${hit}, which macOS privacy protection blocks for background work`,
      'Use a workspace folder outside Desktop, Documents, Downloads and iCloud Drive',
    );
  }
  return outcome('repo-root-tcc', 'pass', remoteRoot);
}

function gib(kb: number): string {
  return `${(kb / KIB_PER_GIB).toFixed(1)} GiB free`;
}

export function checkDiskFree(p: ProbeRecord): CheckOutcome {
  const kb = p.diskFreeKb;
  if (kb === null) return outcome('disk-free', 'warn', 'Could not read free disk space');
  if (kb < DISK_FAIL_BELOW_KB) return outcome('disk-free', 'fail', gib(kb), 'Free up disk space (at least 2 GiB)', 'blocks-full');
  if (kb < DISK_WARN_BELOW_KB) return outcome('disk-free', 'warn', gib(kb), 'Free up disk space (10 GiB or more recommended)');
  return outcome('disk-free', 'pass', gib(kb));
}
