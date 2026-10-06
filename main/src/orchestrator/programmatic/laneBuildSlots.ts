/**
 * LANE BUILD SLOTS — a private build directory for each CONCURRENCY SLOT of a
 * programmatic sprint/ship fan-out. Up to `effectiveMaxConcurrency` lanes run at
 * once in ONE shared worktree, so their agents' builds share every cache a
 * toolchain keeps by default. Observed 2026-09-28:
 *   - concurrent `xcodebuild` into one DerivedData died on
 *     `XCBuildData/build.db: database is locked` (three projects);
 *   - Codex lanes run in a `workspace-write` sandbox that can write only inside
 *     the workspace (and tmp), so Swift's default clang module cache
 *     (`~/.cache/clang/ModuleCache`) failed with `Operation not permitted` —
 *     1,313 hits in one run, every lane fighting over the same file.
 *
 * THE FIX: slot `n` gets `<worktree>/.cyboflow/build-slots/slot-<n>/`.
 *   - INSIDE the worktree, so the Codex sandbox can write it, two runs can never
 *     share it (each run owns its worktree), and it is deleted with the worktree
 *     at merge / dismiss — no sweep, marker or owner check needed.
 *   - Per SLOT, not per lane: the controller hands a freed slot to the next lane
 *     it dispatches, so a later lane inherits a warm cache instead of a cold one.
 *   - GIT-EXCLUDED before it is ever created, through the worktree's local
 *     exclude (never `.gitignore`). An un-excluded build tree would read as dirt
 *     to the lane commit-integrity probe and could be swept into a commit, so an
 *     exclude that cannot be written means no slot dir at all. The entry is
 *     anchored and narrow: projects commit other `.cyboflow/` files
 *     (`verify-runbook.json`).
 *   - VERIFIED with real git before the first slot is created: a `.gitignore`
 *     negation outranks the local exclude, and files already tracked under the
 *     root are never ignored ({@link verifyLaneBuildSlotsIgnored}). Either one
 *     means no slot dirs for the run.
 *
 * The lane agent gets the dir as {@link LANE_SCRATCH_DIR_ENV} plus the two
 * module-cache overrides — pure caches, so redirecting them is safe for every
 * project. Nothing that changes behavior (TMPDIR, HOME, CARGO_TARGET_DIR, …) is
 * redirected; DerivedData and SwiftPM's scratch path are flags, which the lane
 * step prompt asks the agent to pass.
 *
 * Fail-soft end to end: any failure resolves `undefined` and the lane spawns
 * exactly as it did before this module existed. Never SILENT: the first failure
 * of any kind reaches the one listener ({@link LaneBuildSlots.setUnavailableListener}),
 * which the run host turns into a monitor chat line and a non-blocking finding.
 *
 * Electron-free and dependency-injected so it is unit-testable with fakes.
 */

import * as path from 'path';
import type { LoggerLike } from '../types';

/**
 * The env var naming the slot's directory. Deliberately free of KEY/SECRET/TOKEN:
 * Codex's default shell environment policy drops variables whose names contain
 * those words.
 */
export const LANE_SCRATCH_DIR_ENV = 'CYBOFLOW_LANE_SCRATCH_DIR';

/** The slots root, relative to the worktree. */
export const LANE_BUILD_SLOTS_DIR = '.cyboflow/build-slots';

/** The worktree-local git exclude line covering {@link LANE_BUILD_SLOTS_DIR} (anchored). */
export const LANE_BUILD_SLOTS_EXCLUDE_ENTRY = '/.cyboflow/build-slots/';

/** Kill switch: set to '1' to spawn lanes with no build slot (byte-identical to before). */
export const LANE_BUILD_SLOTS_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_LANE_BUILD_SLOTS';

/** Subdirectory of a slot that the clang/Swift module cache is pointed at. */
const MODULE_CACHE_SUBDIR = 'clang-module-cache';

export interface LaneScratch {
  /** The concurrency slot this directory belongs to (0-based). */
  slot: number;
  /** Absolute path of the slot's directory. */
  dir: string;
  /** Env merged last into the lane agent's spawn env. */
  env: Record<string, string>;
}

/** The outcome of checking that git really ignores the slots root. */
export type VerifyIgnoredResult = { ok: true } | { ok: false; reason: string };

export interface LaneBuildSlotsDeps {
  /**
   * Ensure `entries` are in the worktree's local git exclude. True when they are
   * present (already, or just added); false when the exclude could not be written.
   */
  ensureExcluded(worktreePath: string, entries: readonly string[]): boolean;
  /**
   * Confirm with real git that `root` (relative to the worktree) is ignored and
   * holds nothing tracked — production: {@link verifyLaneBuildSlotsIgnored}.
   * Called after the exclude is written and before any slot directory exists.
   * A rejection counts as `{ ok: false }`.
   */
  verifyIgnored(worktreePath: string, root: string): Promise<VerifyIgnoredResult>;
  /** `mkdir -p`. May throw / reject. */
  mkdirp(dirPath: string): void | Promise<void>;
}

export class LaneBuildSlots {
  /**
   * Set once the exclude is in place AND git confirmed it; memoized for the
   * instance. An exclude that could not be WRITTEN is retried on the next resolve.
   */
  private ready = false;
  private excludeFailureLogged = false;
  /**
   * Why git's verification failed. STICKY: a `.gitignore` negation or a tracked
   * file is a fact about the repo, not a transient error, so the run gets no slot
   * dirs at all rather than a re-check on every lane step.
   */
  private verifyFailure: string | undefined;
  /** The in-flight root preparation, shared by concurrent resolves. */
  private preparing: Promise<boolean> | undefined;
  /** Slots whose directory already exists (created by this instance). */
  private readonly created = new Set<number>();
  /** The first failure's reason, kept until a listener has been told (once). */
  private unavailable: { reason: string; delivered: boolean } | undefined;
  private unavailableListener: ((reason: string) => void) | undefined;

  constructor(
    private readonly worktreePath: string,
    private readonly deps: LaneBuildSlotsDeps,
    private readonly logger?: LoggerLike,
  ) {}

  /**
   * Subscribe to the FIRST failure of any kind (exclude write, git verification,
   * a slot's mkdir), delivered at most once per instance — i.e. once per run. A
   * failure that happened before subscription is delivered on subscription.
   */
  setUnavailableListener(listener: (reason: string) => void): void {
    this.unavailableListener = listener;
    this.deliverUnavailable();
  }

  /**
   * Root-level preparation: write the exclude, then have git confirm it — once,
   * before any slot directory exists. True when slots can be created. Called
   * eagerly by the fan-out preflight so a failure surfaces before any lane
   * dispatches, and again (memoized) by every {@link resolve}.
   */
  async prepare(): Promise<boolean> {
    if (this.ready) return true;
    if (this.verifyFailure !== undefined) return false;
    this.preparing ??= this.prepareRoot().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  /** The build directory for `slot`, created and git-excluded; undefined on any failure. */
  async resolve(slot: number): Promise<LaneScratch | undefined> {
    if (!Number.isInteger(slot) || slot < 0) return undefined;
    // Exclude + verify BEFORE the directory exists: never leave an un-ignored
    // build tree in the worktree, even for a moment.
    if (!(await this.prepare())) return undefined;
    const dir = path.resolve(this.worktreePath, LANE_BUILD_SLOTS_DIR, `slot-${slot}`);
    if (!this.created.has(slot)) {
      try {
        await this.deps.mkdirp(dir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`[LaneBuildSlots] could not create ${dir}; lane spawns without a build slot`, {
          error: message,
        });
        this.reportUnavailable(`could not create ${dir} (${message})`);
        return undefined;
      }
      this.created.add(slot);
    }
    const moduleCache = path.join(dir, MODULE_CACHE_SUBDIR);
    // Keys stay in step with MODULE_CACHE_ENV_KEYS (stripInheritedLaneEnv).
    return {
      slot,
      dir,
      env: {
        [LANE_SCRATCH_DIR_ENV]: dir,
        // Honored by clang and the Swift driver (explicit module builds included).
        CLANG_MODULE_CACHE_PATH: moduleCache,
        // SwiftPM's manifest compile keeps its own module cache; point it at the same place.
        SWIFTPM_MODULECACHE_OVERRIDE: moduleCache,
      },
    };
  }

  private async prepareRoot(): Promise<boolean> {
    if (!this.ensureExcluded()) return false;
    let result: VerifyIgnoredResult;
    try {
      result = await this.deps.verifyIgnored(this.worktreePath, LANE_BUILD_SLOTS_DIR);
    } catch (err) {
      result = {
        ok: false,
        reason: `git could not confirm that ${LANE_BUILD_SLOTS_DIR}/ is ignored (${err instanceof Error ? err.message : String(err)})`,
      };
    }
    if (!result.ok) {
      this.verifyFailure = result.reason;
      this.logger?.warn(
        `[LaneBuildSlots] ${LANE_BUILD_SLOTS_DIR}/ is not safely ignored in ${this.worktreePath}; lanes spawn without build slots`,
        { reason: result.reason },
      );
      this.reportUnavailable(result.reason);
      return false;
    }
    this.ready = true;
    return true;
  }

  private ensureExcluded(): boolean {
    let ok = false;
    try {
      ok = this.deps.ensureExcluded(this.worktreePath, [LANE_BUILD_SLOTS_EXCLUDE_ENTRY]);
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (!this.excludeFailureLogged) {
      this.excludeFailureLogged = true;
      this.logger?.warn(
        `[LaneBuildSlots] could not git-exclude ${LANE_BUILD_SLOTS_EXCLUDE_ENTRY} in ${this.worktreePath}; lanes spawn without build slots`,
      );
    }
    this.reportUnavailable(`could not write the git exclude entry \`${LANE_BUILD_SLOTS_EXCLUDE_ENTRY}\` for this worktree`);
    return false;
  }

  /** Record the FIRST failure only; later ones are already covered by its notice. */
  private reportUnavailable(reason: string): void {
    if (this.unavailable !== undefined) return;
    this.unavailable = { reason, delivered: false };
    this.deliverUnavailable();
  }

  private deliverUnavailable(): void {
    const pending = this.unavailable;
    const listener = this.unavailableListener;
    if (pending === undefined || pending.delivered || listener === undefined) return;
    pending.delivered = true;
    try {
      listener(pending.reason);
    } catch (err) {
      this.logger?.warn('[LaneBuildSlots] unavailable listener threw (fail-soft)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** A finished git child (see `runGitExit` in utils/runGit.ts). */
export interface GitExit {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run git in `cwd`, resolving for ANY exit code; rejects only when git could not run. */
export type GitExitRunner = (cwd: string, args: string[]) => Promise<GitExit>;

/** How many tracked paths a verification failure names before summarizing. */
const MAX_NAMED_TRACKED_PATHS = 3;

/**
 * Ask REAL git whether it ignores `root` in `worktreePath` — the production
 * `LaneBuildSlotsDeps.verifyIgnored`. Writing the exclude is not proof: a
 * `.gitignore` negation (`!/.cyboflow/build-slots/`) outranks `info/exclude`,
 * and a file already TRACKED under the root is never ignored. So, before any
 * slot directory exists:
 *   1. `git ls-files -- <root>` must list nothing;
 *   2. `git check-ignore -q -- <root>/` must exit 0 (1 = not ignored; anything
 *      else = git failed). The probe is the ROOT ITSELF, as a directory: git
 *      never re-includes anything under an excluded directory, so "the root is
 *      excluded" is exactly "everything under it is ignored". The trailing slash
 *      is load-bearing — the directory-only exclude rule cannot match the bare
 *      root while that directory does not exist yet (git 2.54 answers 1 for
 *      `.cyboflow/build-slots`, 0 for `.cyboflow/build-slots/`). A probe LEAF
 *      inside a slot would be vacuous in the other direction: a `.gitignore`
 *      that re-includes the root but also ignores the leaf's own name (a `.*`
 *      rule for a `.probe` file) reads as ignored while `git status` lists
 *      every slot file. No `--no-index`, so an already-tracked path would read
 *      as NOT ignored.
 * A git that cannot run at all rejects; the caller counts that as a failure.
 */
export async function verifyLaneBuildSlotsIgnored(
  worktreePath: string,
  root: string,
  git: GitExitRunner,
): Promise<VerifyIgnoredResult> {
  const tracked = await git(worktreePath, ['ls-files', '--', root]);
  if (tracked.exitCode !== 0) {
    return { ok: false, reason: `\`git ls-files\` failed (exit ${tracked.exitCode})${stderrSuffix(tracked.stderr)}` };
  }
  const trackedPaths = tracked.stdout.split('\n').filter((line) => line.length > 0);
  if (trackedPaths.length > 0) {
    const named = trackedPaths.slice(0, MAX_NAMED_TRACKED_PATHS).join(', ');
    const more = trackedPaths.length > MAX_NAMED_TRACKED_PATHS ? `, and ${trackedPaths.length - MAX_NAMED_TRACKED_PATHS} more` : '';
    return {
      ok: false,
      reason: `files under ${root}/ are already tracked by git (${named}${more}), so git will not ignore them`,
    };
  }
  const ignored = await git(worktreePath, ['check-ignore', '-q', '--', `${root}/`]);
  if (ignored.exitCode === 0) return { ok: true };
  if (ignored.exitCode === 1) {
    return {
      ok: false,
      reason: `git does not ignore ${root}/ in this worktree although it is in the local exclude — a .gitignore rule re-includes it (e.g. \`!/${root}/\`)`,
    };
  }
  return { ok: false, reason: `\`git check-ignore\` failed (exit ${ignored.exitCode})${stderrSuffix(ignored.stderr)}` };
}

function stderrSuffix(stderr: string): string {
  const text = stderr.trim();
  return text.length > 0 ? `: ${text}` : '';
}

export function laneBuildSlotsDisabled(): boolean {
  return process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV] === '1';
}

/** The module-cache overrides a slot's env sets alongside {@link LANE_SCRATCH_DIR_ENV}. */
const MODULE_CACHE_ENV_KEYS = ['CLANG_MODULE_CACHE_PATH', 'SWIFTPM_MODULECACHE_OVERRIDE'] as const;

/**
 * Delete the slot env a cyboflow process INHERITED from a hosting lane agent
 * (dogfooding: `pnpm dev` launched from a lane's shell). Every manager spreads
 * `process.env` first, so an inherited slot would point this instance's
 * non-lane spawns — chat sessions, non-fan-out steps, a lane whose own slot
 * could not be prepared — at the OUTER run's build directory. Keyed on
 * {@link LANE_SCRATCH_DIR_ENV}: the module-cache overrides are removed only
 * when they point inside that directory, so a user's own setting survives.
 * Called once at main-process boot, beside the other per-run env strip.
 */
export function stripInheritedLaneEnv(env: NodeJS.ProcessEnv): void {
  const dir = env[LANE_SCRATCH_DIR_ENV];
  if (dir === undefined) return;
  delete env[LANE_SCRATCH_DIR_ENV];
  if (dir.length === 0) return;
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const key of MODULE_CACHE_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && (value === dir || value.startsWith(prefix))) delete env[key];
  }
}
