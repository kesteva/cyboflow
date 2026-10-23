/**
 * SshHost — the ExecutionHost for a user-added SSH machine, over SshTransport.
 *
 * exec runs the argv remotely (quoted word by word by the transport). fs and git are tiny POSIX `sh -c`
 * programs whose PATH is a positional argument ($1), so a caller path is never spliced into shell text:
 *   exists -> `test -e`, readFile -> `head -c`, writeFile -> stdin into a 0600 temp file, chmod, rename,
 *   mkdirp -> `mkdir -p`, readdir -> a NUL-separated glob listing, unlink -> `rm -f` (directories refused),
 *   rmrf -> `rm -rf` behind the remote-root check, stat -> `stat -L` (BSD format, GNU fallback),
 *   git -> `git -C <path> …`.
 * A leading `~/` is expanded against the REMOTE $HOME inside the program.
 *
 * exec / git with `cwd` or `env` go through the remoteLaunch wrapper: the env travels as the stdin prelude
 * (before any caller stdin), never on argv. spawn() runs a long-lived process on a DEDICATED connection under
 * `env -i` + the wrapper (remoteLaunch.ts) and needs the probe facts (remote root, home), injected as a getter.
 *
 * Guards on every HostPath (spec "Remote-root guard"):
 *  - its hostId must be this host's id (HostPathMismatchError);
 *  - the path must be absolute or start with `~/`, and an absolute path that EXISTS on this Mac is refused
 *    (RemotePathIsLocalError): a local path must never be operated on remotely by mistake.
 */
import { existsSync } from 'node:fs';
import { redactSecrets, type PreflightCheckResult, type PreflightResult } from '../../../../shared/types/hosts';
import {
  HostGitCommandError,
  type ExecOptions,
  type ExecResult,
  type ExecutionHost,
  type ExecutionHostInfo,
  type GitCaptureOutput,
  type GitExecutor,
  type HostPath,
  type HostProcess,
  type HostSpawnSpec,
  type MachineExec,
  type MachineFs,
  type MachineStat,
} from '../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../orchestrator/types';
import { RemoteHostProcess, type HostProcessTimers } from './hostProcess';
import { runSshPreflight, type CaptureErrorFn, type SshPreflightExtras } from './preflight/preflightEngine';
import {
  buildRemoteSpawnCommand,
  encodeEnvPrelude,
  killArgv,
  remotePidFile,
  wrapperArgv,
  type RemoteHostFacts,
} from './remoteLaunch';
import type { SshTransportLike } from './sshTransport';

const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
const REMOTE_KILL_TIMEOUT_MS = 5_000;

export class HostPathMismatchError extends Error {
  constructor() {
    super('That path belongs to a different environment.');
    this.name = 'HostPathMismatchError';
  }
}

export class RemotePathIsLocalError extends Error {
  constructor() {
    super('Refusing a remote operation on a path that exists on this Mac.');
    this.name = 'RemotePathIsLocalError';
  }
}

export class InvalidRemotePathError extends Error {
  constructor() {
    super('A remote path must be absolute or start with ~/.');
    this.name = 'InvalidRemotePathError';
  }
}

/** A remote fs/git operation failed (ssh error or non-zero exit); the message carries redacted stderr. */
export class RemoteOperationError extends Error {
  readonly result: ExecResult;
  constructor(op: string, result: ExecResult) {
    const tail = redactSecrets(result.stderr).trim().split(/\r?\n/).pop() ?? '';
    super(`Remote ${op} failed${result.timedOut ? ' (timed out)' : ''}${tail ? `: ${tail.slice(0, 300)}` : ''}`);
    this.name = 'RemoteOperationError';
    this.result = result;
  }
}

/** rmrf / unlink refused a path (outside the remote root, `/`, the home dir, a directory for unlink). */
export class UnsafeRemoveError extends Error {
  constructor(message = 'Refusing to delete that path.') {
    super(message);
    this.name = 'UnsafeRemoveError';
  }
}

/** spawn() before a complete probe reported the remote root / home. */
export class RemoteHostNotReadyError extends Error {
  constructor() {
    super('This environment has not been checked yet. Run a check first.');
    this.name = 'RemoteHostNotReadyError';
  }
}

/** Shared prelude: `p` = $1 with a leading `~/` expanded against the remote $HOME. */
const PATH_PRELUDE = 'p=$1; case "$p" in "~/"*) p="$HOME/${p#??}" ;; esac; shift; ';

function remoteSh(program: string, path: string, ...rest: string[]): string[] {
  return ['/bin/sh', '-c', PATH_PRELUDE + program, 'sh', path, ...rest];
}

/** Entry names, NUL-terminated, dotfiles included (`.`/`..` never match these globs). */
const READDIR_PROGRAM =
  'cd -- "$p" || exit 2; for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done';

/** 0 removed / absent, 3 refused (a directory). */
const UNLINK_PROGRAM = 'if [ -d "$p" ] && [ ! -L "$p" ]; then exit 3; fi; exec rm -f -- "$p"';

/**
 * $1 = path, $2 = remote root (both `~/`-expanded). Exit 3 = refused: not strictly inside the root (textually,
 * then physically — a symlinked parent cannot point the delete outside), `/`, or $HOME. Absent = success.
 */
const RMRF_PROGRAM =
  'r=$1; case "$r" in "~/"*) r="$HOME/${r#??}" ;; esac; ' +
  'if [ "$p" = / ] || [ "$p" = "$HOME" ] || [ -z "$r" ] || [ "$r" = / ]; then exit 3; fi; ' +
  'case "$p" in "$r"/?*) ;; *) exit 3 ;; esac; ' +
  'if [ ! -e "$p" ] && [ ! -L "$p" ]; then exit 0; fi; ' +
  'd=$(cd -P -- "${p%/*}" && pwd -P) || exit 4; rr=$(cd -P -- "$r" && pwd -P) || exit 4; ' +
  'case "$d/" in "$rr"/*) ;; *) exit 3 ;; esac; ' +
  'exec rm -rf -- "$p"';

/** `<type>|<size>|<octal perms>`; exit 1 when nothing is there. BSD stat first, GNU stat as the fallback. */
const STAT_PROGRAM =
  'if [ ! -e "$p" ]; then exit 1; fi; ' +
  'stat -L -f "%HT|%z|%Mp%Lp" -- "$p" 2>/dev/null || exec stat -L -c "%F|%s|%a" -- "$p"';

/** Parse STAT_PROGRAM output. Throws on a shape it does not recognise. */
export function parseStatLine(line: string): MachineStat {
  const parts = line.trim().split('|');
  if (parts.length !== 3) throw new Error('unexpected stat output');
  const [kind, size, perms] = parts;
  const n = Number(size);
  const mode = parseInt(perms, 8);
  if (!Number.isFinite(n) || Number.isNaN(mode)) throw new Error('unexpected stat output');
  return { isFile: /^regular/i.test(kind), isDir: /^directory$/i.test(kind), size: n, mode: mode & 0o7777 };
}

/** Text form of a path with trailing slashes dropped (`/` stays `/`). */
function trimTrailingSlashes(p: string): string {
  const t = p.replace(/\/+$/, '');
  return t.length === 0 ? '/' : t;
}

export interface SshHostDeps {
  id: string;
  label: string;
  sshTarget: string;
  /** Configured root: absolute or `~/…` (default `~/cf-remote/<id>`). */
  remoteRoot: string;
  /**
   * Facts from the latest COMPLETE probe (expanded remote root, home, env base) — null until one has run.
   * Source of `info.remoteRoot` and required by spawn(). Wired by the hosts service (A4).
   */
  remoteFacts?: () => RemoteHostFacts | null;
  /** HostProcess kill timers (tests). */
  processTimers?: HostProcessTimers;
  /**
   * The full-tier inputs of a preflight (expected toolchain, orch link, prelaunch node path), resolved per run by
   * the hosts service. Absent (or rejecting) ⇒ the M1 checks: sdk-binary-hash / mcp-roundtrip skipped.
   */
  preflightExtras?: (mode: PreflightResult['mode']) => Promise<SshPreflightExtras>;
  appVersion: string;
  transport: SshTransportLike;
  /** Local existence probe for the remote-root guard. Default node:fs existsSync. */
  localExists?: (absolutePath: string) => boolean;
  now?: () => Date;
  clock?: () => number;
  captureError?: CaptureErrorFn;
  logger?: LoggerLike;
}

export class SshHost implements ExecutionHost {
  readonly info: ExecutionHostInfo;
  readonly exec: MachineExec;
  readonly fs: MachineFs;
  readonly git: GitExecutor;

  constructor(private readonly deps: SshHostDeps) {
    const facts = (): RemoteHostFacts | null => deps.remoteFacts?.() ?? null;
    this.info = {
      id: deps.id,
      kind: 'ssh',
      label: deps.label,
      get remoteRoot(): string | null {
        const known = facts()?.remoteRoot;
        if (known) return known;
        return deps.remoteRoot.startsWith('/') ? trimTrailingSlashes(deps.remoteRoot) : null;
      },
    };
    const localExists = deps.localExists ?? existsSync;
    const target = deps.sshTarget;
    const t = deps.transport;

    const checkPath = (path: string): string => {
      if (path.includes('\0') || !(path.startsWith('/') || path.startsWith('~/'))) throw new InvalidRemotePathError();
      if (path.startsWith('/') && localExists(path)) throw new RemotePathIsLocalError();
      return path;
    };
    const guard = (p: HostPath): string => {
      if (p.hostId !== deps.id) throw new HostPathMismatchError();
      return checkPath(p.path);
    };

    /** exec, through the wrapper when a cwd or env is asked for (env = stdin prelude, never argv). */
    const execOn = (argv: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
      if (opts.cwd === undefined && opts.env === undefined) return t.exec(target, argv, opts);
      const prelude = encodeEnvPrelude(opts.env ?? {});
      const cwd = opts.cwd === undefined ? '' : checkPath(opts.cwd);
      const wrapped = wrapperArgv({ cwd, envFile: '', pidFile: '', argv });
      return t.exec(target, wrapped, { timeoutMs: opts.timeoutMs, signal: opts.signal, stdin: prelude + (opts.stdin ?? '') });
    };

    this.exec = {
      exec: (argv: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
        if (argv.length === 0) return Promise.reject(new Error('argv is empty'));
        try {
          return execOn(argv, opts);
        } catch (e) {
          return Promise.reject(e);
        }
      },
    };

    /** Remote root forms accepted for the rmrf text check: the configured one and the probed absolute one. */
    const rootForms = (): string[] => {
      const forms = new Set<string>([trimTrailingSlashes(deps.remoteRoot)]);
      const known = facts()?.remoteRoot;
      if (known) forms.add(trimTrailingSlashes(known));
      return [...forms].filter((r) => r !== '/' && r !== '~' && r.length > 1);
    };

    this.fs = {
      exists: async (p: HostPath): Promise<boolean> => {
        const r = await t.exec(target, remoteSh('test -e "$p"', guard(p)));
        if (r.code === 0) return true;
        if (r.code === 1) return false;
        throw new RemoteOperationError('exists', r);
      },
      readFile: async (p: HostPath, maxBytes = DEFAULT_READ_MAX_BYTES): Promise<string> => {
        const n = Math.max(0, Math.floor(maxBytes));
        const r = await t.exec(target, remoteSh('exec head -c "$1" -- "$p"', guard(p), String(n)));
        if (r.code !== 0) throw new RemoteOperationError('read', r);
        return r.stdout;
      },
      writeFile: async (p: HostPath, data: string, mode: number): Promise<void> => {
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('invalid file mode');
        // Data arrives on stdin. BSD `install` rejects a pipe as /dev/stdin, so: a 0600 temp file next to the
        // target (umask 077 before any byte lands), the requested mode, then an atomic rename.
        const r = await t.exec(
          target,
          remoteSh(
            'umask 077; t="$p.cf-tmp.$$"; if cat > "$t" && chmod "$1" "$t" && mv -f "$t" "$p"; then exit 0; fi; rm -f "$t"; exit 1',
            guard(p),
            mode.toString(8),
          ),
          { stdin: data },
        );
        if (r.code !== 0) throw new RemoteOperationError('write', r);
      },
      mkdirp: async (p: HostPath): Promise<void> => {
        const r = await t.exec(target, remoteSh('exec mkdir -p -- "$p"', guard(p)));
        if (r.code !== 0) throw new RemoteOperationError('mkdir', r);
      },
      readdir: async (p: HostPath): Promise<string[]> => {
        const r = await t.exec(target, remoteSh(READDIR_PROGRAM, guard(p)));
        if (r.code !== 0) throw new RemoteOperationError('readdir', r);
        return r.stdout.split('\0').filter((n) => n.length > 0);
      },
      unlink: async (p: HostPath): Promise<void> => {
        const r = await t.exec(target, remoteSh(UNLINK_PROGRAM, guard(p)));
        if (r.code === 3) throw new UnsafeRemoveError('Refusing to unlink a directory.');
        if (r.code !== 0) throw new RemoteOperationError('unlink', r);
      },
      rmrf: async (p: HostPath): Promise<void> => {
        const path = trimTrailingSlashes(guard(p));
        if (path === '/' || path === '~' || path.split('/').some((seg) => seg === '..' || seg === '.')) {
          throw new UnsafeRemoveError();
        }
        const root = rootForms().find((r) => path.startsWith(`${r}/`));
        if (root === undefined) throw new UnsafeRemoveError("Refusing to delete outside this environment's folder.");
        const r = await t.exec(target, remoteSh(RMRF_PROGRAM, path, root));
        if (r.code === 3) throw new UnsafeRemoveError("Refusing to delete outside this environment's folder.");
        if (r.code !== 0) throw new RemoteOperationError('remove', r);
      },
      stat: async (p: HostPath): Promise<MachineStat | null> => {
        const r = await t.exec(target, remoteSh(STAT_PROGRAM, guard(p)));
        if (r.code === 1 && r.stdout.trim() === '') return null;
        if (r.code !== 0) throw new RemoteOperationError('stat', r);
        return parseStatLine(r.stdout);
      },
    };

    const gitRun = (cwd: HostPath, args: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
      const dir = guard(cwd);
      if (opts.env === undefined) {
        return t.exec(target, remoteSh('exec git -C "$p" "$@"', dir, ...args), {
          timeoutMs: opts.timeoutMs, signal: opts.signal, stdin: opts.stdin,
        });
      }
      // The repo dir doubles as the wrapper's cwd (it expands `~/` the same way).
      return execOn(['git', ...args], { ...opts, cwd: dir });
    };
    this.git = {
      run: async (cwd: HostPath, args: string[], opts: ExecOptions = {}): Promise<ExecResult> => gitRun(cwd, args, opts),
      capture: async (cwd: HostPath, args: string[], opts: ExecOptions = {}): Promise<GitCaptureOutput> => {
        const r = await gitRun(cwd, args, opts);
        if (r.code !== 0) throw new HostGitCommandError(args, r);
        return { stdout: r.stdout, stderr: r.stderr };
      },
    };
  }

  /**
   * Long-lived process on a DEDICATED connection (never the shared master: its idle exit and `closeMaster`
   * would kill a running agent). Throws RemoteHostNotReadyError before a complete probe.
   */
  spawn(spec: HostSpawnSpec): HostProcess {
    const facts = this.deps.remoteFacts?.() ?? null;
    if (!facts || !facts.remoteRoot.startsWith('/') || !facts.home) throw new RemoteHostNotReadyError();
    const pidFile = remotePidFile(facts.remoteRoot, spec.spawnKey);
    const prelude = encodeEnvPrelude(spec.env ?? {});
    if (spec.cwd !== undefined && (spec.cwd.includes('\0') || !(spec.cwd.startsWith('/') || spec.cwd.startsWith('~/')))) {
      throw new InvalidRemotePathError();
    }
    const command = buildRemoteSpawnCommand({
      facts,
      cwd: spec.cwd,
      withTokenEnvFile: spec.withTokenEnvFile,
      spawnKey: spec.spawnKey,
      argv: [spec.command, ...spec.args],
    });
    const t = this.deps.transport;
    const target = this.deps.sshTarget;
    const child = t.spawnStreaming(target, command, { stdin: 'pipe', dedicated: true });
    return new RemoteHostProcess({
      child,
      prelude,
      signal: spec.signal,
      timers: this.deps.processTimers,
      remoteKill: async (signal) => {
        try {
          await t.exec(target, killArgv(pidFile, signal), { timeoutMs: REMOTE_KILL_TIMEOUT_MS });
        } catch {
          /* best-effort: the local ssh child is signalled next */
        }
      },
    });
  }

  async preflight(
    mode: PreflightResult['mode'],
    onCheck?: (r: PreflightCheckResult) => void,
    signal?: AbortSignal,
  ): Promise<PreflightResult> {
    const d = this.deps;
    let extras: SshPreflightExtras = {};
    try {
      extras = (await d.preflightExtras?.(mode)) ?? {};
    } catch (err) {
      // The preflight never throws: without its extras it is the M1 check set.
      d.logger?.warn('[hosts] preflight inputs unavailable', { error: err instanceof Error ? err.name : 'unknown' });
    }
    return runSshPreflight(
      {
        ...extras,
        hostId: d.id,
        sshTarget: d.sshTarget,
        remoteRoot: d.remoteRoot,
        appVersion: d.appVersion,
        transport: d.transport,
        now: d.now,
        clock: d.clock,
        captureError: d.captureError,
        logger: d.logger,
      },
      mode,
      onCheck,
      signal,
    );
  }
}
