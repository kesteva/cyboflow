/**
 * ExecutionHost — the structural contract every machine (This Mac, an SSH host) satisfies.
 *
 * Standalone: no imports besides shared types and Node stream/event TYPES. M1 shipped the machine surface
 * (exec / fs / git / preflight); M2 adds working-directory + env on exec, the destructive fs verbs, a
 * throw-on-nonzero git capture and a streaming `spawn` for long-lived agent processes.
 *
 * Every method on an SshHost asserts the HostPath's hostId matches the host and (fs / git) that the path
 * is not an existing LOCAL path (remote-root guard), so a local path can never be operated on remotely.
 */
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { redactSecrets, type HostKind, type PreflightCheckResult, type PreflightResult } from '../../../../../shared/types/hosts';

export interface HostPath {
  hostId: string;
  path: string;
}

export function localHostPath(path: string): HostPath {
  return { hostId: 'local', path };
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  stdin?: string;
  /** Working directory on the machine. Local default: the home dir. ssh: absolute or `~/` (else the login dir). */
  cwd?: string;
  /**
   * Extra environment, merged OVER the machine's command env. ssh: delivered through the remote wrapper's
   * stdin env prelude (services/hosts/remoteLaunch.ts), never on any argv; keys must be shell identifiers and
   * values must not contain a newline or NUL (rejected locally before anything is sent).
   */
  env?: Record<string, string>;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** argv run on the machine; for ssh the argv is shell-quoted remotely by the transport. */
export interface MachineExec {
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
}

export interface MachineStat {
  isFile: boolean;
  isDir: boolean;
  size: number;
  /** Permission bits (`mode & 0o7777`). Symlinks are followed. */
  mode: number;
}

export interface MachineFs {
  exists(p: HostPath): Promise<boolean>;
  readFile(p: HostPath, maxBytes?: number): Promise<string>;
  writeFile(p: HostPath, data: string, mode: number): Promise<void>;
  mkdirp(p: HostPath): Promise<void>;
  /** Entry names (not paths) of a directory, dotfiles included, `.`/`..` excluded. Throws when not a directory. */
  readdir(p: HostPath): Promise<string[]>;
  /** Remove a file or symlink. A missing path is not an error; a directory is refused. */
  unlink(p: HostPath): Promise<void>;
  /**
   * `rm -rf`. Refuses `/` and the home directory on every machine; on an ssh host ALSO refuses anything that is
   * not strictly inside the host's remote root (checked locally on the text and again remotely on the physical
   * path), throwing UnsafeRemoveError. A missing path is not an error.
   */
  rmrf(p: HostPath): Promise<void>;
  /** null when nothing exists at the path. */
  stat(p: HostPath): Promise<MachineStat | null>;
}

/** Both streams of a git command that exited 0. */
export interface GitCaptureOutput {
  stdout: string;
  stderr: string;
}

/**
 * A git command run through {@link GitExecutor.capture} did not exit 0. Mirrors the execFile error that
 * utils/runGit.ts `runGitCapture` rejects with (`code` = exit code, `stdout`, `stderr`, a
 * `Command failed: git …` message) so callers written against runGitCapture keep working; stderr is redacted
 * and the message carries only its tail.
 */
export class HostGitCommandError extends Error {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly args: readonly string[];

  constructor(args: readonly string[], result: ExecResult) {
    const stderr = redactSecrets(result.stderr);
    const tail = stderr.trimEnd().split(/\r?\n/).slice(-20).join('\n');
    const bounded = tail.length > 2000 ? tail.slice(-2000) : tail;
    super(`Command failed: git ${args.join(' ')}${result.timedOut ? ' (timed out)' : ''}${bounded ? `\n${bounded}` : ''}`);
    this.name = 'HostGitCommandError';
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = stderr;
    this.timedOut = result.timedOut;
    this.args = [...args];
  }
}

export interface GitExecutor {
  /** Resolves for ANY exit code (the code is the answer). */
  run(cwd: HostPath, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Throw-on-nonzero twin (runGitCapture parity): rejects with HostGitCommandError. */
  capture(cwd: HostPath, args: string[], opts?: ExecOptions): Promise<GitCaptureOutput>;
}

export interface ExecutionHostInfo {
  id: string;
  kind: HostKind;
  label: string;
  /**
   * The host's working root, absolute and `~`-expanded; null for This Mac. For an ssh host it comes from an
   * injected probe-facts getter and is null until a complete probe has run (a configured root that is already
   * absolute is reported as-is). Read it on use — it can change after a preflight.
   */
  readonly remoteRoot: string | null;
}

/** A long-lived process on the machine (an agent CLI, a Codex app-server). */
export interface HostSpawnSpec {
  command: string;
  args: readonly string[];
  /** Working directory on the machine. */
  cwd?: string;
  /**
   * The COMPLETE child environment for an ssh host (it starts from `env -i` plus the probe's base:
   * HOME/PATH/USER/LOGNAME/SHELL/TMPDIR/LANG); merged over the command env for This Mac. `undefined` values
   * are dropped. ssh: sent on stdin through the wrapper's prelude, never on argv.
   */
  env?: Record<string, string | undefined>;
  /** Aborting kills the process (same sequence as HostProcess.kill). */
  signal?: AbortSignal;
  /**
   * Stable, filename-safe key (`[A-Za-z0-9._-]`, ≤ 128) naming the remote pidfile `<remoteRoot>/run/<key>.pid`
   * that kill() and a later re-dispatch fence use. Ignored by This Mac.
   */
  spawnKey: string;
  /**
   * ssh only: export CLAUDE_CODE_OAUTH_TOKEN from `<remoteRoot>/env` (strict single-line match, read ON the
   * remote, never sourced; the token never transits this Mac).
   */
  withTokenEnvFile?: boolean;
}

/**
 * What ExecutionHost.spawn returns. Structurally satisfies the Claude Agent SDK `SpawnedProcess` and the Codex
 * `AppServerProcess` (both asserted by type tests). `pid` is ALWAYS undefined for an ssh host: the only local
 * pid is the ssh client's, and a caller that signals a pid's process group (the Codex client's teardown) must
 * never reach a local group by mistake — it falls back to kill(), which runs the remote kill sequence.
 * Events: 'exit' (code, signal) once, 'error' (Error), 'close' after stdio closed.
 */
export interface HostProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface ExecutionHost {
  info: ExecutionHostInfo;
  exec: MachineExec;
  fs: MachineFs;
  git: GitExecutor;
  /**
   * Start a long-lived process with piped stdio. Throws synchronously for a precondition (an ssh host whose
   * probe facts are not known yet, an invalid spawnKey, an env the prelude cannot carry); runtime failures
   * arrive as the process's 'error' / 'exit'.
   */
  spawn(spec: HostSpawnSpec): HostProcess;
  preflight(
    mode: PreflightResult['mode'],
    onCheck?: (r: PreflightCheckResult) => void,
    signal?: AbortSignal,
  ): Promise<PreflightResult>;
}
