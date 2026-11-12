/**
 * RunHostAccess — how orchestrator code reaches the worktree of a run whose `workflow_runs.host_id` names a REMOTE
 * environment (spec M2 §5 Phase D item 3): the programmatic runner's lane build slots and environment actions, and
 * the commit-integrity probe. Paths are absolute paths ON that machine (a remote session's worktree_path is the
 * remote path); never a local path.
 *
 * Implemented in services/hosts/runHostAccess.ts over the ExecutionHost of the run's host and injected at the
 * composition root (programmaticRunnerComposition.ts), so orchestrator/** keeps importing no services/* (the
 * standalone invariant).
 *
 * Contract: nothing here ever falls back to This Mac. When Environments are off or the host is gone, every method
 * REJECTS with a readable error; callers treat that as their existing fail-soft "unavailable" path.
 *
 * Standalone: imports only types from executionHost.ts.
 */
import type { MachineStat } from './executionHost';

/** A git command on the run's machine that ran to completion (runGitExit parity: ANY exit code resolves). */
export interface RunHostGitExit {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A command on the run's machine that exited 0. */
export interface RunHostCommandOutput {
  stdout: string;
  stderr: string;
}

/**
 * What a non-zero {@link RunWorktreeHost.execIn} rejects with — the execFile error shape (`code`, `stdout`,
 * `stderr`, a `Command failed: …` message) that callers written against runToolCapture already read. Output is
 * redacted.
 */
export interface RunHostCommandError extends Error {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunWorktreeHost {
  /** The remote host id (never 'local'). */
  readonly hostId: string;
  exists(path: string): Promise<boolean>;
  /** null when nothing exists at the path. */
  stat(path: string): Promise<MachineStat | null>;
  /** Entry names of a directory (dotfiles included). Rejects when not a directory. */
  readdir(path: string): Promise<string[]>;
  readFile(path: string, maxBytes?: number): Promise<string>;
  mkdirp(path: string): Promise<void>;
  /**
   * `git <args>` in `cwd`; resolves for ANY exit code. Rejects only when git did not run to completion (timeout,
   * transport failure, Environments unavailable) — there is no exit code to report then.
   */
  gitExit(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<RunHostGitExit>;
  /** `git <args>` in `cwd`; resolves stdout on exit 0, rejects on anything else (runGitAsync parity). */
  gitCapture(cwd: string, args: string[], opts?: { timeoutMs?: number }): Promise<string>;
  /**
   * Run `bin args` in `cwd` on the machine, with the environment's tool PATH (its probed node / git dirs plus the
   * system dirs). Resolves on exit 0; rejects with a {@link RunHostCommandError} otherwise (runToolCapture parity).
   */
  execIn(cwd: string, bin: string, args: string[], opts: { timeoutMs: number }): Promise<RunHostCommandOutput>;
}

export interface RunHostAccess {
  /**
   * The run machine for a REMOTE host id. Never throws for availability (the methods reject instead); throws only
   * for a local / empty id, which is a caller bug: local runs keep their existing local code path.
   */
  forHost(hostId: string): RunWorktreeHost;
}
