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
 * snapshot worktree, provision untracked dependency directories (a fresh
 * `git worktree` has no `node_modules`), and dispose of it unconditionally.
 * It knows nothing about the scheduler, leases, or the agent runner; those
 * compose this as a building block (§5.4/§5.6).
 *
 * Dependency provisioning is a CLONE into the snapshot, never a symlink out of
 * it (see {@link cloneDependencyDirs} for the full argument). When a prepared
 * dep set exists (`depPreparer`, verification-setup-flow §7.2) the clone source
 * is that per-key MIRROR — already rebuilt for the deliverable's Electron ABI
 * and warm across runs; absent one it is the live worktree dir. Either way the
 * snapshot ends up with its own disposable copy.
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
import { resolveGitCommand } from '../../utils/gitExeFinder';
import { VerifyDepPreparer, defaultDepExec, type DepExec } from './depPreparer';

const execFileAsync = promisify(execFile);

/** Per-invocation git timeout. Snapshot operations are local (no network), so 30s is generous. */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

/** How many directory levels below the run worktree root to scan for `node_modules`. */
const NODE_MODULES_SCAN_MAX_DEPTH = 3;

/**
 * Per-dependency-dir clone bound. APFS clonefile is near-instant even for a
 * multi-GB tree; the `-R` fallback is a real byte copy, hence minutes rather
 * than seconds. Same value as `depPreparer`'s, for the same reason.
 */
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Injectable git seam
// ---------------------------------------------------------------------------

/**
 * Shell-free git invocation, injectable for tests. Args are passed
 * positionally to the `git` binary (never shell-interpolated). The default
 * implementation is a plain `execFile(resolveGitCommand(), args, { cwd })`
 * call (gitExeFinder resolves the binary for GUI launches where PATH misses
 * git); the primary test suite exercises this module against a real throwaway
 * git repo fixture rather than a faked git, but the seam exists so
 * callers/tests that need to simulate an operational git failure (timeout,
 * spawn failure) can do so without depending on OS-level git behavior.
 */
export type GitExec = (args: readonly string[], cwd: string) => Promise<string>;

const defaultGitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync(resolveGitCommand(), args as string[], {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
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

/**
 * Does the run worktree have uncommitted changes (`git status --porcelain`
 * reports anything, including untracked files)?
 *
 * WHY THIS EXISTS. A recorded sha ALWAYS snapshots, and the snapshot is a
 * DETACHED checkout at that sha — so uncommitted work is invisible to the
 * verifier, and since the old whole-tree dirty check was removed (see
 * {@link captureSnapshotSha}) nothing else catches it. A sprint lane tolerates
 * this because it commits before verifying; a QUICK CHAT SESSION has no such
 * discipline, so a PASS there can certify the previous commit while the user is
 * looking at newer code. Callers surface this alongside the sha so a verdict can
 * be reported with the qualification it deserves.
 *
 * This is a WARNING SIGNAL, not a gate — verifying a dirty tree stays allowed,
 * because "check this before I commit" is a legitimate thing to ask of a chat
 * session. It is the caller's job to relay it.
 *
 * Fail-soft to `false` on ANY error (not a repo, no HEAD, git missing): an
 * unanswerable question must never block an enqueue, and the honest reading of
 * "could not check" is the same as today's behavior — no warning attached.
 */
export async function isWorktreeDirty(
  runWorktreePath: string,
  gitExec: GitExec = defaultGitExec,
): Promise<boolean> {
  try {
    const out = await gitExec(['status', '--porcelain'], runWorktreePath);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Is the portable runbook half VISIBLE AT `HEAD` of the run worktree — i.e.
 * would the detached snapshot the verifier builds from actually contain it?
 *
 * `git cat-file -e HEAD:<path>` asks exactly that question, and asks it of the
 * commit rather than the index or the working tree: a runbook that is written,
 * or even staged, but not committed is invisible to a snapshot at a sha.
 *
 * WHY THIS CHECK EXISTS. Plenty of repos ignore or locally-exclude `.cyboflow/`
 * — it is where cyboflow puts worktrees and local state — so a plain
 * `git add .cyboflow/verify-runbook.json` in the setup flow's prove step is a
 * SILENT no-op there (observed live 2026-07-31 on a project whose
 * `.git/info/exclude` carried `.cyboflow/`). The registration then succeeds
 * against the working-tree file, the proof runs against a snapshot with no
 * runbook in it, and the failure surfaces far away from its cause. Answering
 * "no" here turns that into one legible sentence at the moment the flow can
 * still fix it with `git add -f`.
 *
 * Fail-soft to `false` on ANY error (not a repo, no HEAD yet, git missing): the
 * caller uses this to attach a warning, never to fail a registration, and an
 * unanswerable question is reported as "could not confirm", which is what a
 * false says here.
 */
export async function isRunbookCommittedAtHead(
  runWorktreePath: string,
  relativePath: string,
  gitExec: GitExec = defaultGitExec,
): Promise<boolean> {
  try {
    await gitExec(['cat-file', '-e', `HEAD:${relativePath}`], runWorktreePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dependency-dir provisioning (clone-into-snapshot)
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
 * Provisions each dependency dir found in the run worktree at the same relative
 * path inside the snapshot worktree, by CLONING it in — never by symlinking out
 * of it, which is what this did until the §7.2 adversarial review (findings 5
 * and 6; see WHY A CLONE below). The clone SOURCE is the per-key MIRROR when a
 * prepared set exists (`mirrors`, from `depPreparer`) and the LIVE worktree dir
 * when it does not; the DESTINATION is the snapshot in both cases, which is the
 * part that carries every guarantee here. Per-dir lookup, not all-or-nothing: a
 * src with no mirror entry simply clones live.
 *
 * WHY A CLONE AND NOT A SYMLINK. Three consequences, each of which was a live
 * defect while this symlinked:
 *
 *  (a) WRITE-THROUGH IS DEAD IN BOTH PATHS. A symlink made the snapshot's
 *      `node_modules` an ALIAS, so anything the verification wrote into it
 *      landed in whatever the link pointed at: the shared sprint worktree every
 *      sibling lane is building against (root cause (c) — a host-Node
 *      better-sqlite3 under an Electron needing NMV 136 — and invisible to
 *      `checkSnapshotMutated` because `node_modules` is untracked), or the
 *      shared dep cache on the mirror path. A clone gives the snapshot its OWN
 *      copy, discarded with the snapshot, so no write inside a verification has
 *      a path back to anything a sibling lane or a later verification reads.
 *      That holds for writes this process never sees — a `node_modules` file
 *      edited directly, an install spelled through an env var or a script file —
 *      which is exactly what a command-pattern guard cannot promise.
 *  (b) WORKSPACE-RELATIVE SYMLINKS RESOLVE AGAINST THE SNAPSHOT. A pnpm
 *      workspace link like `frontend/node_modules/shared -> ../../shared` points
 *      at WORKSPACE SOURCE, not into the `.pnpm` store. Pointed at the mirror it
 *      resolved to `<mirror>/shared` — a path that does not exist, because the
 *      mirror holds dependencies and deliberately never the project's source. So
 *      every workspace-linked import broke inside verification while building
 *      fine in the developer's own tree: a build failure the deliverable did not
 *      cause, which the classifier can only read as a real one (a false blocking
 *      rewrite of working code). Cloned INTO the snapshot, the same relative
 *      link resolves to `<snapshot>/shared` — the checked-out source the
 *      verification is supposed to be building against in the first place.
 *  (c) THE §7.2 COMMAND REGEX BECOMES DIAGNOSTICS. `dependencyCommandGuard` is
 *      bypassable by construction (indirection through an env var, a script
 *      file, a direct write), so it was never a security control — it was
 *      merely the only one. The clone is the enforcement now; the regex keeps
 *      earning its place as the cheap, legible half that tells a composing agent
 *      WHY its `pnpm install` was refused, instead of leaving it to infer that
 *      from a confusing build.
 *
 * `checkSnapshotMutated` needs nothing from this change: it runs `git diff
 * --quiet HEAD`, which sees TRACKED files only, and a cloned `node_modules` is
 * untracked in the snapshot exactly as it was in the live tree.
 *
 * FAIL-SOFT, WITH THE POSTURE STATED. A missing parent (the snapshot's
 * checked-out tree has no such nested dir) or a failed clone is logged and the
 * dir is SKIPPED — never thrown, same as the symlink version. What changed is
 * what a skip costs: the snapshot then simply lacks that dependency dir and the
 * build fails loudly for want of it. That is the intended trade. The tempting
 * recovery — fall back to a symlink for the one dir whose clone failed — would
 * buy a working build by silently re-opening (a) for it, and an honest build
 * failure beats a silent cross-lane write every time.
 */
async function cloneDependencyDirs(
  runWorktreePath: string,
  snapshotWorktreePath: string,
  dependencyDirs: readonly string[],
  exec: DepExec,
  logger?: LoggerLike,
  mirrors?: ReadonlyMap<string, string> | null,
): Promise<void> {
  for (const srcDir of dependencyDirs) {
    const rel = path.relative(runWorktreePath, srcDir);
    const destPath = path.join(snapshotWorktreePath, rel);
    const destParent = path.dirname(destPath);
    const cloneSource = mirrors?.get(srcDir) ?? srcDir;

    try {
      await fsPromises.access(destParent);
    } catch {
      logger?.debug('snapshotProvisioner: skipping dependency-dir clone, parent missing in snapshot', {
        srcDir,
        destPath,
      });
      continue;
    }

    try {
      await cloneDependencyDir(cloneSource, destPath, snapshotWorktreePath, exec, logger);
    } catch (err) {
      logger?.warn('snapshotProvisioner: failed to clone dependency dir; the snapshot will not have it', {
        srcDir,
        cloneSource,
        destPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Clone one dependency dir into the snapshot. `cp -Rc` asks APFS for
 * clonefile(2) — copy-on-write, so even a multi-GB `node_modules` costs seconds
 * and near-zero disk until something writes into it. `-c` is macOS-only and
 * clonefile is refused ACROSS filesystems (the snapshot lives under
 * `os.tmpdir()`, which need not share a volume with the worktree or the dep
 * cache), so any failure retries as a plain recursive copy: slower, identical
 * result. A partial destination from the failed attempt is removed first so the
 * retry starts clean.
 *
 * Symlinks inside the tree are preserved AS SYMLINKS by both forms (BSD `cp -R`
 * implies `-P` for the traversal, and clonefile clones the link itself). That is
 * load-bearing twice over: it keeps a pnpm store's web of relative links intact,
 * and it is what makes consequence (b) above work at all — a `cp -L` here would
 * dereference `../../shared` against the SOURCE tree and copy the workspace's
 * source in, quietly re-pinning the snapshot to code it is not verifying.
 *
 * Deliberately the same ladder as `depPreparer.cloneDir` rather than a shared
 * helper: the two run against different roots with different delete guards
 * (cache vs snapshot), and the part that would actually be shared — the `cp`
 * argv — is three tokens.
 */
async function cloneDependencyDir(
  src: string,
  dest: string,
  snapshotWorktreePath: string,
  exec: DepExec,
  logger?: LoggerLike,
): Promise<void> {
  // Windows has no `cp` to shell out to; `defaultDepExec` translates these two
  // argv into an in-process junction-preserving copy there (depPreparer.ts).
  // Running the ladder THROUGH the injected seam keeps that seam the one
  // authoritative failure point on every platform.
  const cloned = await exec('cp', ['-Rc', src, dest], {
    cwd: snapshotWorktreePath,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (cloned.code === 0) return;

  logger?.debug('snapshotProvisioner: clonefile copy unavailable, falling back to a plain recursive copy', {
    src,
    dest,
    out: cloned.out,
  });
  await removeInsideSnapshot(snapshotWorktreePath, dest, logger);
  const copied = await exec('cp', ['-R', src, dest], {
    cwd: snapshotWorktreePath,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (copied.code !== 0) {
    throw new Error(`cp -R failed for ${src} (code ${copied.code}): ${copied.out}`);
  }
}

/**
 * The only recursive delete in this module, and it refuses anything that is not
 * strictly inside the snapshot worktree. Every path handed to it is composed
 * from that root plus a worktree-relative dependency path, so a violation means
 * a bug upstream — which is exactly when a guard on `rm -rf` earns its keep.
 * Same posture (and phrasing) as `depPreparer.removeInsideBaseDir`, whose root
 * is the dep cache instead: log and decline rather than throw, because a refused
 * delete leaves garbage in a temp dir we are about to remove wholesale, while an
 * unrefused one could delete a user's tree.
 */
async function removeInsideSnapshot(
  snapshotWorktreePath: string,
  target: string,
  logger?: LoggerLike,
): Promise<void> {
  const base = path.resolve(snapshotWorktreePath);
  const resolved = path.resolve(target);
  if (resolved === base || !resolved.startsWith(base + path.sep)) {
    logger?.error('snapshotProvisioner: refusing to remove a path outside the snapshot worktree', {
      snapshotWorktreePath: base,
      target: resolved,
    });
    return;
  }
  try {
    await fsPromises.rm(resolved, { recursive: true, force: true });
  } catch (err) {
    logger?.warn('snapshotProvisioner: failed to remove a partial dependency-dir clone', {
      target: resolved,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Default dependency preparer (lazy, kill-switchable)
// ---------------------------------------------------------------------------

/**
 * Memoized default preparers, keyed by resolved base dir. Lazy on purpose: this
 * module is imported on the app-boot graph, and a preparer constructed at import
 * time would resolve `CYBOFLOW_DIR` before `setCyboflowDirectory`/the env is
 * necessarily settled. Keying by base dir keeps a test that flips `CYBOFLOW_DIR`
 * from inheriting the previous run's instance.
 *
 * The FIRST caller's logger is retained for a given base dir. The app has one
 * logger, so this is a distinction without a difference in production; a test
 * that needs its own logging injects its own preparer via `opts.depPreparer`.
 */
const defaultDepPreparers = new Map<string, VerifyDepPreparer>();

/**
 * The prepared-set cache root: `<CYBOFLOW_DIR|~/.cyboflow>/verify-deps`.
 *
 * Deliberately NOT `utils/cyboflowDirectory.getCyboflowSubdirectory` — that
 * module imports `electron`, and this one is Electron-free by construction so it
 * stays unit-testable with no Electron/DB (see the module doc). The env var is
 * the same first-class override that resolver honors; the packaged per-variant
 * dirs it also handles only shift WHERE the cache lives, never whether it works.
 */
function resolveDefaultDepBaseDir(): string {
  return path.join(process.env.CYBOFLOW_DIR ?? path.join(os.homedir(), '.cyboflow'), 'verify-deps');
}

/**
 * The default preparer, or `null` when disabled.
 *
 * `CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER=1` is the rollback lever (mirroring
 * `CYBOFLOW_DISABLE_WARM_SDK=1` for warm SDK sessions): it drops the §7.2 mirror
 * entirely, so dependency dirs are cloned from the LIVE worktree — no per-key
 * cache, no in-mirror Electron-ABI rebuild, a cold clone every run. Note what it
 * does NOT revert: the snapshot still gets its OWN copy either way, so flipping
 * this cannot re-open the cross-lane write-through hazard, only the warmth and
 * ABI-correctness the mirror buys. Read on EVERY call rather than at module load
 * so flipping it takes effect on the next verification, and so a test can set it
 * per-case.
 *
 * Exported for tests only; production reaches it through `provisionSnapshot`.
 */
export function resolveDefaultDepPreparer(logger?: LoggerLike): VerifyDepPreparer | null {
  if (process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER === '1') return null;

  const baseDir = resolveDefaultDepBaseDir();
  const cached = defaultDepPreparers.get(baseDir);
  if (cached) return cached;

  const preparer = new VerifyDepPreparer({ baseDir, exec: defaultDepExec, ...(logger ? { logger } : {}) });
  defaultDepPreparers.set(baseDir, preparer);
  return preparer;
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
  /**
   * Injectable subprocess seam for the dependency `cp`, shaped exactly like
   * `depPreparer`'s (a non-zero exit is a VALUE, not a throw — the clonefile
   * fallback ladder depends on reading the code). Defaults to the same
   * production `execFile` runner that module uses. Tests inject it to simulate a
   * clone failure without needing a filesystem that refuses `cp`; the primary
   * suite otherwise runs the REAL `cp`, because "does the tree survive the copy
   * with its symlinks intact" is the claim under test.
   */
  exec?: DepExec;
  /**
   * Dependency preparer (§7.2). Omitted ⇒ the lazy default
   * ({@link resolveDefaultDepPreparer}, itself disabled by
   * `CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER=1`). `null` ⇒ explicitly disabled for
   * this call: dependency dirs are cloned straight from the live worktree, with
   * none of the mirror's warmth or ABI rebuild — but still INTO the snapshot,
   * which is where the isolation lives.
   */
  depPreparer?: VerifyDepPreparer | null;
}

/**
 * Creates a temporary, detached `git worktree` at `snapshotSha`, linked from
 * `runWorktreePath` (so it shares that repo's object store), then CLONES in
 * dependency directories (§5.5/§7.2) since a fresh worktree checkout has none.
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
  const exec = opts.exec ?? defaultDepExec;

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
    // §7.2: prepare BEFORE cloning, so the clone can read from the warm,
    // ABI-rebuilt mirror instead of the live tree. The preparer is fail-soft by
    // contract — a null map means "no prepared set", and the clone then simply
    // sources the live dirs. The DESTINATION is the snapshot either way, so the
    // isolation guarantee does not depend on the preparer succeeding.
    const preparer = opts.depPreparer === undefined ? resolveDefaultDepPreparer(logger) : opts.depPreparer;
    const mirrors = preparer ? await preparer.prepare(runWorktreePath, dependencyDirs) : null;
    await cloneDependencyDirs(runWorktreePath, worktreePath, dependencyDirs, exec, logger, mirrors);
  } catch (err) {
    // Dependency-dir provisioning is a convenience for the agent's build step,
    // not a correctness requirement of the snapshot itself — never fail
    // provisioning over it. A missing dependency surfaces as a real build
    // error downstream, which is the documented risk (§5.5).
    logger?.warn('snapshotProvisioner: dependency-dir scan/clone failed', {
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
