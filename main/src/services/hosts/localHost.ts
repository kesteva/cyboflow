/**
 * LocalHost — the ExecutionHost for This Mac.
 *
 * exec via runToolCapture (execFile, login-shell PATH, no shell), fs via node:fs/promises, git via runGitExit.
 * Every HostPath must carry hostId 'local'.
 *
 * Preflight reuses the existing local detection and stays cheap: claude binary + credentials
 * (detectClaudeBinary / detectClaudeCredentials), codex = resolveCodexExecutablePath ONLY (never spawns an
 * app-server) plus the auth file's presence, git = resolveGitCommand + `--version`. This Mac's tier is fixed
 * `full` and it is always `online`; only git, claude-auth and codex-auth are reported, the rest are `na`.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PREFLIGHT_CHECK_IDS,
  redactSecrets,
  type PreflightCheckId,
  type PreflightCheckResult,
  type PreflightResult,
} from '../../../../shared/types/hosts';
import type { ClaudeBinaryDetection, ClaudeCredentialDetection } from '../../../../shared/types/onboarding';
import type {
  ExecOptions,
  ExecResult,
  ExecutionHost,
  ExecutionHostInfo,
  GitExecutor,
  HostPath,
  MachineExec,
  MachineFs,
} from '../../orchestrator/trpc/contracts/executionHost';
import { LOCAL_HOST_ID } from '../../orchestrator/hosts/hostStore';
import type { LoggerLike } from '../../orchestrator/types';
import { detectClaudeBinary } from '../../utils/claudeBinaryDetection';
import { detectClaudeCredentials } from '../../utils/claudeCredentials';
import { resolveGitCommand } from '../../utils/gitExeFinder';
import { buildCommandEnv, runGitExit, runToolCapture } from '../../utils/runGit';
import { resolveCodexExecutablePath } from '../panels/codex/codexExecutablePath';
import { CHECK_LABELS, naCheck, type CheckOutcome } from './preflight/checks';
import type { CaptureErrorFn } from './preflight/preflightEngine';
import { HostPathMismatchError } from './sshHost';
import { spawnCapture, type ProcessRunner } from './sshTransport';

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const GIT_VERSION_TIMEOUT_MS = 15_000;
const DEFAULT_READ_MAX_BYTES = 1024 * 1024;

export interface LocalHostDeps {
  appVersion: string;
  label?: string;
  detectClaudeBinary?: () => Promise<ClaudeBinaryDetection>;
  detectClaudeCredentials?: () => Promise<ClaudeCredentialDetection>;
  /** Throws when the bundled Codex runtime is missing. Must not spawn anything. */
  resolveCodex?: () => { executablePath: string; version: string };
  /** Codex auth file present and non-empty. */
  codexAuthPresent?: () => Promise<boolean>;
  /** `git --version` output, or null when git cannot run. */
  gitVersion?: () => Promise<string | null>;
  /** Used for exec calls that pass stdin (runToolCapture has no stdin). */
  stdinRunner?: ProcessRunner;
  now?: () => Date;
  clock?: () => number;
  captureError?: CaptureErrorFn;
  logger?: LoggerLike;
}

/** Map a rejected execFile-style error into an ExecResult (non-zero exit, timeout, spawn failure). */
export function execErrorToResult(err: unknown): ExecResult {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown; message?: unknown;
  };
  const stdout = typeof e.stdout === 'string' ? e.stdout : '';
  const stderrRaw = typeof e.stderr === 'string' && e.stderr.length > 0
    ? e.stderr
    : typeof e.message === 'string' ? e.message : String(err);
  const timedOut = e.killed === true && e.signal === 'SIGTERM';
  return { code: typeof e.code === 'number' ? e.code : null, stdout, stderr: redactSecrets(stderrRaw), timedOut };
}

async function defaultCodexAuthPresent(): Promise<boolean> {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
  try {
    const st = await fsp.stat(path.join(home, 'auth.json'));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function defaultGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await runToolCapture(resolveGitCommand(), os.homedir(), ['--version'], {
      timeout: GIT_VERSION_TIMEOUT_MS,
    });
    const m = /git version\s+(\S+)/.exec(stdout);
    return m ? `git version ${m[1]}` : null;
  } catch {
    return null;
  }
}

function localArch(): string {
  try {
    return os.machine();
  } catch {
    return process.arch === 'x64' ? 'x86_64' : process.arch;
  }
}

function localOsVersion(): string {
  const getSystemVersion = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion;
  if (process.platform === 'darwin' && typeof getSystemVersion === 'function') {
    try {
      return `macOS ${getSystemVersion()}`;
    } catch {
      /* fall through */
    }
  }
  return `${os.type()} ${os.release()}`;
}

export class LocalHost implements ExecutionHost {
  readonly info: ExecutionHostInfo;
  readonly exec: MachineExec;
  readonly fs: MachineFs;
  readonly git: GitExecutor;

  constructor(private readonly deps: LocalHostDeps) {
    this.info = { id: LOCAL_HOST_ID, kind: 'local', label: deps.label ?? 'This Mac' };
    const stdinRunner = deps.stdinRunner ?? spawnCapture;

    const assertLocal = (p: HostPath): string => {
      if (p.hostId !== LOCAL_HOST_ID) throw new HostPathMismatchError();
      return p.path;
    };

    this.exec = {
      exec: async (argv: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
        if (argv.length === 0) throw new Error('argv is empty');
        const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
        if (opts.stdin !== undefined) {
          return stdinRunner(argv[0], argv.slice(1), { stdin: opts.stdin, timeoutMs, signal: opts.signal, env: buildCommandEnv() });
        }
        try {
          const { stdout, stderr } = await runToolCapture(argv[0], os.homedir(), argv.slice(1), {
            timeout: timeoutMs,
            signal: opts.signal,
          });
          return { code: 0, stdout, stderr, timedOut: false };
        } catch (err) {
          return execErrorToResult(err);
        }
      },
    };

    this.fs = {
      exists: async (p: HostPath): Promise<boolean> => {
        try {
          await fsp.access(assertLocal(p));
          return true;
        } catch (err) {
          if (err instanceof HostPathMismatchError) throw err;
          return false;
        }
      },
      readFile: async (p: HostPath, maxBytes = DEFAULT_READ_MAX_BYTES): Promise<string> => {
        const handle = await fsp.open(assertLocal(p), 'r');
        try {
          const buf = Buffer.alloc(maxBytes);
          const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
          return buf.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
      },
      writeFile: async (p: HostPath, data: string, mode: number): Promise<void> => {
        const file = assertLocal(p);
        await fsp.writeFile(file, data, { mode });
        await fsp.chmod(file, mode);
      },
      mkdirp: async (p: HostPath): Promise<void> => {
        await fsp.mkdir(assertLocal(p), { recursive: true });
      },
    };

    this.git = {
      run: async (cwd: HostPath, args: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
        const dir = assertLocal(cwd);
        try {
          const r = await runGitExit(dir, args, { timeout: opts.timeoutMs, signal: opts.signal });
          return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false };
        } catch (err) {
          return execErrorToResult(err);
        }
      },
    };
  }

  async preflight(
    mode: PreflightResult['mode'],
    onCheck?: (r: PreflightCheckResult) => void,
    signal?: AbortSignal,
  ): Promise<PreflightResult> {
    const d = this.deps;
    const now = d.now ?? (() => new Date());
    const clock = d.clock ?? (() => performance.now());
    const startedAt = now().toISOString();
    const decided = new Map<PreflightCheckId, PreflightCheckResult>();
    let claudeCli = false;
    let codexSdk = false;

    const emit = (o: CheckOutcome, startMs: number): void => {
      const r: PreflightCheckResult = { ...o, durationMs: Math.max(0, Math.round(clock() - startMs)) };
      decided.set(r.id, r);
      try {
        onCheck?.(r);
      } catch {
        /* a listener never breaks a preflight */
      }
    };
    const row = (id: PreflightCheckId, status: CheckOutcome['status'], detail: string, fix?: string): CheckOutcome => ({
      // This Mac's tier is fixed: no local row gates anything.
      id, label: CHECK_LABELS[id], status, detail, ...(fix !== undefined ? { fix } : {}), tierImpact: 'none',
    });
    const guarded = async (id: PreflightCheckId, fn: () => Promise<CheckOutcome>): Promise<void> => {
      if (signal?.aborted) {
        emit(row(id, 'skipped', 'Cancelled'), clock());
        return;
      }
      const s = clock();
      try {
        emit(await fn(), s);
      } catch (err) {
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        try {
          d.captureError?.('host-preflight', new Error(message), { hostKind: 'local' });
        } catch {
          /* telemetry never breaks a preflight */
        }
        emit(row(id, 'fail', `Unexpected error: ${message}`), s);
      }
    };

    await guarded('git', async () => {
      const v = await (d.gitVersion ?? defaultGitVersion)();
      return v !== null ? row('git', 'pass', v) : row('git', 'fail', 'git was not found', 'xcode-select --install');
    });
    await guarded('claude-auth', async () => {
      const [binary, creds] = await Promise.all([
        (d.detectClaudeBinary ?? (() => detectClaudeBinary()))(),
        (d.detectClaudeCredentials ?? detectClaudeCredentials)(),
      ]);
      claudeCli = binary.found;
      if (creds.found) return row('claude-auth', 'pass', `Signed in${creds.source ? ` (${creds.source})` : ''}`);
      return row('claude-auth', 'warn', binary.found ? 'Claude is not signed in' : 'Claude Code is not installed or not signed in', 'claude   # then type /login');
    });
    await guarded('codex-auth', async () => {
      try {
        (d.resolveCodex ?? (() => resolveCodexExecutablePath()))();
        codexSdk = true;
      } catch {
        return row('codex-auth', 'warn', 'The bundled Codex runtime was not found');
      }
      const signedIn = await (d.codexAuthPresent ?? defaultCodexAuthPresent)();
      return signedIn ? row('codex-auth', 'pass', 'Signed in') : row('codex-auth', 'warn', 'Codex is not signed in');
    });

    for (const id of PREFLIGHT_CHECK_IDS) {
      if (!decided.has(id)) emit(naCheck(id, 'Not checked for This Mac'), clock());
    }
    const results = PREFLIGHT_CHECK_IDS.flatMap((id) => decided.get(id) ?? []);

    return {
      hostId: LOCAL_HOST_ID,
      mode,
      startedAt,
      finishedAt: now().toISOString(),
      results,
      reachable: true,
      probeComplete: true,
      detectedTier: 'full',
      runtimes: { claudeSdk: true, codexSdk, claudeCli, codexCli: false },
      arch: localArch(),
      osVersion: localOsVersion(),
      toolchainHash: null,
      appVersion: d.appVersion,
    };
  }
}
