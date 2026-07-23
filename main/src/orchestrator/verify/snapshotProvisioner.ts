/**
 * snapshotProvisioner — lane-consistent snapshot builds for visual verification
 * (design proposal §5.5, `docs/proposals/verification-agent-redesign.md`).
 *
 * Sprint lanes share ONE worktree. If the verification agent built/served the
 * deliverable straight out of that shared worktree, a neighboring lane's
 * mid-edit (uncommitted) state could break — or be wrongly blamed for
 * breaking — THIS lane's verification. The fix: verification always builds
 * against a temporary `git worktree` checked out at a `snapshotSha` recorded
 * at enqueue time (the shared branch HEAD). Committed neighbor work is
 * included by construction (it is deterministic and gate-vetted by those
 * lanes' own chains); uncommitted mess is excluded by construction.
 *
 * This module owns only the mechanics — resolve/validate the sha, create the
 * snapshot worktree, link in untracked dependency directories (a fresh
 * `git worktree` has no `node_modules`), and dispose of it unconditionally.
 * It knows nothing about the scheduler, leases, or the agent runner; those
 * compose this as a building block (§5.4/§5.6).
 *
 * Electron-free by design (plain Node `child_process`/`fs`/`os`/`path`) so it
 * can be unit-tested with no DB/Electron and reused from any process.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsPromises from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoggerLike } from '../types';

const execFileAsync = promisify(execFile);

/** Per-invocation git timeout. Snapshot operations are local (no network), so 30s is generous. */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/** How many directory levels below the run worktree root to scan for `node_modules`. */
const NODE_MODULES_SCAN_MAX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Injectable git seam
// ---------------------------------------------------------------------------

/**
 * Shell-free git invocation, injectable for tests. Args are passed
 * positionally to the `git` binary (never shell-interpolated). The default
 * implementation is a plain `execFile('git', args, { cwd })` call; the primary
 * test suite exercises this module against a real throwaway git repo fixture
 * rather than a faked git, but the seam exists so callers/tests that need to
 * simulate an operational git failure (timeout, spawn failure) can do so
 * without depending on OS-level git behavior.
 */
export type GitExec = (args: readonly string[], cwd: string) => Promise<string>;

const defaultGitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SnapshotProvisionErrorCode = 'bad_sha' | 'worktree_add_failed';

/**
 * Typed provisioning failure. Both codes are infra-bucket failures for the
 * caller (§3/§5.5 "fail-open infra bucket") — neither should consume a lane's
 * implement/verify retry budget.
 */
export class SnapshotProvisionError extends Error {
  readonly code: SnapshotProvisionErrorCode;

  constructor(message: string, code: SnapshotProvisionErrorCode, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SnapshotProvisionError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// captureSnapshotSha
// ---------------------------------------------------------------------------

/**
 * `git rev-parse HEAD` of the run worktree. Callers capture this AT ENQUEUE
 * TIME (the shared branch HEAD at the moment the visual-verify request is
 * fired) and pass it through as `snapshotSha` — this function does not decide
 * *when* to capture, only performs the capture. A recorded sha ALWAYS
 * snapshots (§5.5 amended): the runner's old whole-tree dirty check routed to
 * the live shared worktree whenever any sibling lane was mid-edit, so it was
 * removed; the live-worktree fallback now exists only for a failed capture.
 */
export async function captureSnapshotSha(runWorktreePath: string, gitExec: GitExec = defaultGitExec): Promise<string> {
  const out = await gitExec(['rev-parse', 'HEAD'], runWorktreePath);
  return out.trim();
}

// ---------------------------------------------------------------------------
// Dependency-dir linking
// ---------------------------------------------------------------------------

/**
 * Scans `root` for directories named `node_modules` (repo root + nested
 * workspace dirs), never recursing INTO a `node_modules` it finds, capped at
 * `maxDepth` levels below `root`. Exported for testing; callers normally go
 * through `provisionSnapshot`.
 */
export async function findDependencyDirs(root: string, maxDepth = NODE_MODULES_SCAN_MAX_DEPTH): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'node_modules') {
        found.push(full);
        continue; // never scan inside a node_modules dir
      }
      await walk(full, depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}

/**
 * Symlinks each dependency dir found in the run worktree into the same
 * relative path inside the snapshot worktree. Symlinks only (never copies —
 * §5.5 "symlink; hardlink-copy where a tool resolves symlinks poorly" is a
 * documented future refinement, not this slice). Best-effort per-dir: a
 * missing parent (the snapshot's checked-out tree doesn't have that nested
 * dir) or a symlink failure is logged and skipped, never thrown.
 */
async function linkDependencyDirs(
  runWorktreePath: string,
  snapshotWorktreePath: string,
  dependencyDirs: readonly string[],
  logger?: LoggerLike,
): Promise<void> {
  for (const srcDir of dependencyDirs) {
    const rel = path.relative(runWorktreePath, srcDir);
    const destPath = path.join(snapshotWorktreePath, rel);
    const destParent = path.dirname(destPath);

    try {
      await fsPromises.access(destParent);
    } catch {
      logger?.debug('snapshotProvisioner: skipping dependency-dir link, parent missing in snapshot', {
        srcDir,
        destPath,
      });
      continue;
    }

    try {
      await fsPromises.symlink(srcDir, destPath, 'dir');
    } catch (err) {
      logger?.warn('snapshotProvisioner: failed to symlink dependency dir', {
        srcDir,
        destPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// provisionSnapshot
// ---------------------------------------------------------------------------

export interface SnapshotProvision {
  /** Absolute path of the provisioned snapshot worktree the agent will run in. */
  worktreePath: string;
  /** The commit the snapshot was created at. */
  sha: string;
  /** Unconditional, idempotent teardown: git worktree remove --force + prune + rm of the temp dir. Never throws (log instead). */
  dispose(): Promise<void>;
}

export interface ProvisionSnapshotOptions {
  runWorktreePath: string;
  snapshotSha: string;
  logger?: LoggerLike;
  /** Injectable git seam (tests only); defaults to a real `execFile('git', ...)`. */
  gitExec?: GitExec;
}

/**
 * Creates a temporary, detached `git worktree` at `snapshotSha`, linked from
 * `runWorktreePath` (so it shares that repo's object store), then links in
 * dependency directories (§5.5) since a fresh worktree checkout has none.
 *
 * Throws `SnapshotProvisionError('bad_sha')` when `snapshotSha` does not
 * resolve to a commit reachable from the run worktree's repo, and
 * `SnapshotProvisionError('worktree_add_failed')` when `git worktree add`
 * itself fails (e.g. a stale worktree admin entry, disk pressure). Both are
 * infra-bucket failures for the caller to route to fail-open handling.
 */
export async function provisionSnapshot(opts: ProvisionSnapshotOptions): Promise<SnapshotProvision> {
  const { runWorktreePath, snapshotSha, logger } = opts;
  const gitExec = opts.gitExec ?? defaultGitExec;

  try {
    await gitExec(['cat-file', '-e', `${snapshotSha}^{commit}`], runWorktreePath);
  } catch (err) {
    throw new SnapshotProvisionError(
      `snapshot sha "${snapshotSha}" does not resolve to a commit in ${runWorktreePath}`,
      'bad_sha',
      { cause: err },
    );
  }

  // mkdtemp gives us a unique parent; the worktree itself checks out into a
  // not-yet-existing subdir of it (`git worktree add` requires the target
  // path to not already exist).
  const tmpParent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cyboflow-verify-'));
  const worktreePath = path.join(tmpParent, 'snapshot');

  try {
    await gitExec(['worktree', 'add', '--detach', worktreePath, snapshotSha], runWorktreePath);
  } catch (err) {
    await fsPromises.rm(tmpParent, { recursive: true, force: true }).catch(() => {});
    throw new SnapshotProvisionError(`git worktree add failed for sha "${snapshotSha}"`, 'worktree_add_failed', {
      cause: err,
    });
  }

  try {
    const dependencyDirs = await findDependencyDirs(runWorktreePath);
    await linkDependencyDirs(runWorktreePath, worktreePath, dependencyDirs, logger);
  } catch (err) {
    // Dependency-dir linking is a convenience for the agent's build step, not
    // a correctness requirement of the snapshot itself — never fail
    // provisioning over it. A missing dependency surfaces as a real build
    // error downstream, which is the documented risk (§5.5).
    logger?.warn('snapshotProvisioner: dependency-dir scan/link failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;

    try {
      await gitExec(['worktree', 'remove', '--force', worktreePath], runWorktreePath);
    } catch (err) {
      logger?.warn('snapshotProvisioner: git worktree remove failed', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await gitExec(['worktree', 'prune'], runWorktreePath);
    } catch (err) {
      logger?.warn('snapshotProvisioner: git worktree prune failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await fsPromises.rm(tmpParent, { recursive: true, force: true });
    } catch (err) {
      logger?.warn('snapshotProvisioner: failed to remove snapshot temp dir', {
        tmpParent,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { worktreePath, sha: snapshotSha, dispose };
}
