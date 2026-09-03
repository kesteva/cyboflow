/**
 * depPreparer — the second half of the §7.2 "snapshot dep isolation" fix
 * (docs/proposals/verification-setup-flow.md). Its sibling,
 * `dependencyCommandGuard.ts`, says what a verification may not RUN; this module
 * removes the reason it wanted to run it at all.
 *
 * WHAT IT IS FOR, NOW THAT IT IS NOT THE ISOLATION. This module was introduced
 * to redirect the snapshot's `node_modules` SYMLINK away from the live sprint
 * worktree (where a verification's writes flipped native-module ABIs under every
 * sibling lane) and into a disposable mirror. `snapshotProvisioner` no longer
 * symlinks at all — it CLONES the dep dirs INTO the snapshot, which closes the
 * write-through hazard outright and independently of anything here (see that
 * module's `cloneDependencyDirs` for the full argument). This module's mirror is
 * therefore a clone SOURCE, never a symlink target: nothing outside the cache
 * ever holds a reference into it, and a snapshot's writes land in the snapshot's
 * own copy.
 *
 * That leaves it two jobs, both of which are the reason to keep it:
 *  - THE ELECTRON-ABI REBUILD, once, outside every snapshot, where §7.2 says it
 *    belongs ("the electron-ABI rebuild lives here, never in runbook commands").
 *    Cloning the live tree straight into a snapshot would carry the developer's
 *    host-Node better-sqlite3 (NMV 127) under an Electron that needs NMV 136 —
 *    §1 root cause (c), unfixed. The mirror is where that gets corrected, once
 *    per key rather than once per verification.
 *  - WARMTH. A published set is reused across runs and branches, so the
 *    per-verification cost is one copy-on-write clone of an already-correct
 *    tree rather than a rebuild.
 *
 * CLONE, NOT "FRESH INSTALL" — a deliberate, documented deviation from §7.2's
 * wording, with the same guarantees. The proposal describes building a prepared
 * dep set by installing from the lockfile. Doing that correctly for an ARBITRARY
 * project layout means re-deriving that project's package manager, workspace
 * protocol, store location, patch set, postinstall scripts, and private-registry
 * auth — i.e. re-implementing `pnpm install` well enough that a divergence from
 * the developer's own tree is not itself a new class of false failure. An
 * APFS-level CLONE of the dirs that already exist reaches the same end state
 * (an isolated, per-key, disposable dep tree whose ABI we control) for a
 * fraction of the machinery and none of the guessing: clonefile is
 * copy-on-write, so the mirror costs ~nothing to make and diverges only where it
 * is written. What it does NOT do is repair a broken/absent live install — that
 * remains the developer's tree to fix, and this module falls back cleanly
 * (see FAIL-SOFT) rather than pretending otherwise.
 *
 * KEYING IS THE WHOLE CORRECTNESS ARGUMENT. A mirror is reused only while every
 * input that could make it wrong is unchanged: the lockfile BYTES (the
 * dependency graph itself), `platform` + `arch` (native binaries are not
 * portable across either — the recurring "x64 better-sqlite3 in an arm64
 * worktree" landmine), the NODE MAJOR (the module ABI the host-Node build
 * targets), and the project's declared ELECTRON VERSION (the ABI
 * `electron-builder install-app-deps` rebuilds native modules against). Any of
 * them drifting mints a different key, i.e. a different directory — there is no
 * in-place invalidation to get wrong, and a stale set simply ages out via LRU.
 *
 * RELATIVE LAYOUT IS PRESERVED, ON PURPOSE. Each dependency dir is cloned to the
 * SAME path relative to the worktree root inside the mirror (`sub/node_modules`
 * stays `sub/node_modules`). pnpm's trees are a web of RELATIVE symlinks from a
 * package dir into the root `.pnpm` store; flattening the layout would break
 * every one of them, while preserving it keeps them resolving entirely inside
 * the mirror. Preserving it is also what lets the snapshot clone a mirror dir
 * back to its own matching relative path, which is how a workspace link
 * (`frontend/node_modules/shared -> ../../shared`, pointing at SOURCE rather
 * than into the store) ends up resolving against the snapshot's checked-out
 * tree — a link the mirror alone can never satisfy, because a mirror holds
 * dependencies and deliberately never the project's source. The adjacent
 * manifests (`package.json` next to each cloned dir, `pnpm-workspace.yaml`, the
 * lockfile) are copied to their same relative spots for a third reason:
 * `electron-builder install-app-deps` reads them.
 *
 * FAIL-SOFT, ALWAYS. Every failure path — no lockfile, a failed clone, a failed
 * rebuild, a half-published set, an unexpected throw — warns and returns
 * `null`, which the caller reads as "clone the live worktree dirs instead". A
 * dep-cache problem must never fail a verification, and it cannot make one
 * UNSAFE either: the snapshot gets its own copy on both paths, so all a null
 * costs is the warmth and the ABI rebuild above. What is lost is real (a
 * verification of an Electron app may hit root cause (c) again) but it is a
 * loud, honest build failure, not a silent cross-lane write.
 *
 * Electron-free by construction (mirrors snapshotProvisioner.ts): plain node
 * `fs/promises`/`path`/`crypto` plus an INJECTED exec seam, so the whole module
 * is unit-testable with a fake exec and a temp base dir — no `pnpm install`, no
 * Electron, no DB.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { LoggerLike } from '../types';
import { cmdCommandLine, cmdExeInvocation } from '../../utils/win32CmdLine';

const execFileAsync = promisify(execFile);

/**
 * Lockfile candidates, probed at the worktree root IN THIS ORDER. The first hit
 * is the key's content input. No lockfile at all ⇒ there is no stable identity
 * to key a cache on, so `prepare` declines (returns null) rather than minting a
 * key that would either collide across genuinely different dep trees or re-key
 * on every run.
 */
const LOCKFILE_CANDIDATES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] as const;

/**
 * Root manifests copied into the mirror alongside the lockfile. Only files
 * `electron-builder install-app-deps` (and pnpm, when it resolves a workspace)
 * actually read — this is not a general repo copy, and deliberately so: the
 * mirror holds DEPENDENCIES, never the deliverable's source (the snapshot
 * worktree is the deliverable).
 */
const ROOT_MANIFESTS = ['pnpm-workspace.yaml'] as const;

/** Per-clone bound. APFS clonefile is near-instant; the `-R` fallback is a real copy, hence minutes not seconds. */
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

/** Bound on the in-mirror Electron ABI rebuild — the one dependency mutation §7.2 sanctions, and only here. */
const REBUILD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How many published prepared sets survive a GC pass. Two, not one: a machine
 * that alternates between two active branches (a sprint branch and main) would
 * otherwise thrash, rebuilding on every alternation. Two, not more: each set is
 * a clone of a full `node_modules` tree, and while clonefile makes them cheap on
 * disk they are not free once written into.
 */
const KEEP_PREPARED_SETS = 2;

/** Recency stamp inside each published set; also the LRU sort key. */
const LAST_USED_STAMP = '.last-used';

/**
 * Grace window that protects a published mirror from GC even when the
 * keep-N rule (see {@link KEEP_PREPARED_SETS}) would otherwise reclaim it.
 *
 * WHY THIS IS NEEDED. `prepare()` hands its caller bare mirror DIRECTORY
 * PATHS, not a lease or a handle — the caller (`snapshotProvisioner`) then
 * clones FROM those paths at its own pace, entirely outside this module's
 * view. A GC pass runs synchronously after every publish (see `build`), so
 * with 3+ distinct keys active at once — e.g. two live sprint branches plus a
 * third mid-transition — the keep-2 rule alone can delete an older mirror a
 * moment before, or DURING, a clone that is still reading from it. That clone
 * fails soft at the `cp` layer (see FAIL-SOFT), but the caller has already
 * committed to the prepared path by then, so the outcome is a blocking build
 * failure on an otherwise-healthy deliverable, not a quiet fallback.
 *
 * A GRACE WINDOW is the cheapest mechanism that closes this, not a lease or a
 * lockfile. An in-process refcount would need `prepare`/`release` pairing
 * across every caller — an API change this module's callers do not have; a
 * cross-process lease needs a lockfile protocol this module has no other use
 * for. Time is already the LRU currency here (`.last-used`), so reusing it as
 * a hold is zero new machinery: `touch()` already runs on both the REUSE path
 * and the fresh BUILD-then-publish path, so any mirror this module has ever
 * handed to a caller is unreclaimable for this long afterward — and an APFS
 * clonefile copy (seconds) can never outlast it.
 *
 * RESIDUAL: a clone that somehow takes longer than the grace window was
 * already dead on arrival at whatever caller-side deadline started it, long
 * before 15 minutes could elapse — not a gap this module needs to close.
 *
 * {@link KEEP_PREPARED_SETS} is unchanged by this: grace only ADDS
 * protection on top of the keep-2-newest rule, it never widens what GC is
 * willing to delete once a set ages out of the window.
 */
const DEP_MIRROR_GC_GRACE_MS = 15 * 60 * 1000;

/**
 * Marker in an UNPUBLISHED build directory's name. GC skips anything containing
 * it (another process may be mid-build) and the publish step renames it away, so
 * a directory without the marker is by definition complete.
 */
const TMP_MARKER = '.tmp-';

/**
 * Key length in hex chars (128 bits). Full sha256 would be 64 chars of pure
 * overhead on every path inside an already-deep `node_modules` tree, and 128
 * bits is far past collision-relevance for a machine-local cache.
 */
const KEY_HEX_CHARS = 32;

// ---------------------------------------------------------------------------
// Injectable exec seam
// ---------------------------------------------------------------------------

/**
 * Shell-free command invocation, injectable for tests. Args are passed
 * positionally (never shell-interpolated), and a NON-ZERO EXIT IS A VALUE, not a
 * throw: the clone path deliberately treats `cp -Rc` failing as an ordinary
 * "this filesystem cannot clone" signal it retries as a plain copy, and code
 * that reads exit codes out of a caught error object gets that wrong sooner or
 * later.
 */
export type DepExec = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; out: string }>;

/**
 * Windows stand-in for the POSIX `cp -R`/`cp -Rc` clone rungs: there is no `cp`
 * binary on Windows, so without this every dependency clone ENOENT'd and the
 * snapshot provisioned WITHOUT the dir — fail-soft, but a guaranteed downstream
 * build failure on every Windows verification. A recursive copy that preserves
 * links VERBATIM, matching the BSD `cp -R` semantics documented on the POSIX
 * rungs: directory links are re-created as JUNCTIONS (no privilege needed —
 * pnpm's Windows workspace shape), file links need symlink privilege and fail
 * the copy like any other unclonable filesystem. A copied junction keeps its
 * ABSOLUTE target, exactly like an absolute symlink does under `cp -R` on
 * POSIX.
 */
async function copyDirVerbatimWin32(src: string, dest: string): Promise<void> {
  await fsPromises.mkdir(dest, { recursive: true });
  for (const entry of await fsPromises.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await fsPromises.readlink(from);
      const targetsDirectory = await fsPromises
        .stat(from)
        .then((s) => s.isDirectory())
        .catch(() => false);
      await fsPromises.symlink(target, to, targetsDirectory ? 'junction' : 'file');
    } else if (entry.isDirectory()) {
      await copyDirVerbatimWin32(from, to);
    } else {
      await fsPromises.copyFile(from, to);
    }
  }
}

/** The production exec: `execFile` with stdout+stderr merged into `out` and every failure mapped to a code. */
export const defaultDepExec: DepExec = async (cmd, args, opts) => {
  // `cp` does not exist on Windows: translate the exact argv the two clone
  // rungs pass (`['-Rc'|'-R', src, dest]`) to an in-process verbatim copy.
  // Anything else (notably the electron-builder rebuild) still goes to execFile.
  // `npx` on Windows is `npx.cmd`, which Node refuses to spawn shell-less
  // (EINVAL hardening). cmd.exe resolves the shim and `windowsHide` (set on
  // every exec below) keeps it invisible.
  if (process.platform === 'win32' && cmd === 'npx') {
    const cmd = cmdExeInvocation(cmdCommandLine(['npx', ...args]));
    const result = await execFileAsync(cmd.command, cmd.args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: cmd.windowsVerbatimArguments,
    });
    return { code: 0, out: `${result.stdout}${result.stderr}` };
  }
  if (
    process.platform === 'win32' &&
    cmd === 'cp' &&
    args.length === 3 &&
    (args[0] === '-R' || args[0] === '-Rc')
  ) {
    try {
      await copyDirVerbatimWin32(args[1], args[2]);
      return { code: 0, out: '' };
    } catch (err) {
      return { code: 1, out: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const code = typeof e.code === 'number' ? e.code : 1;
    const out = `${typeof e.stdout === 'string' ? e.stdout : ''}${typeof e.stderr === 'string' ? e.stderr : ''}`;
    return { code, out: out.length > 0 ? out : String(e.message ?? 'exec failed') };
  }
};

// ---------------------------------------------------------------------------
// Single-flight registry (module-level, shared by every instance)
// ---------------------------------------------------------------------------

/**
 * In-process build mutex, keyed by `<resolved baseDir>::<key>`. Sprint lanes fan
 * out: several verification requests can provision snapshots for the same
 * lockfile within milliseconds of each other, and without this every one of them
 * would clone a full dependency tree and race to publish the same directory.
 * The registry collapses them onto ONE build whose result they all await.
 *
 * It resolves to the MIRROR ROOT (a string), never to a caller's src→mirror map:
 * two different worktrees can legitimately share a key (same lockfile, same
 * host), and handing the second caller the first caller's source paths would be
 * a silent mis-mapping. Each caller derives its own map from its own dirs.
 *
 * Module-level rather than per-instance because the thing being serialized is a
 * DIRECTORY on disk, which does not care how many `VerifyDepPreparer` objects
 * exist. Cross-PROCESS races are handled at the publish step instead (rename
 * loses gracefully to a peer that got there first).
 */
const inFlightBuilds = new Map<string, Promise<string | null>>();

/** Injected collaborators. `baseDir` is resolved by the caller (see snapshotProvisioner's lazy default). */
export interface DepPreparerDeps {
  /** Root of the prepared-set cache — `<CYBOFLOW_DIR|~/.cyboflow>/verify-deps`. Nothing outside it is ever deleted. */
  baseDir: string;
  /** Command runner (clone + rebuild). Faked in tests. */
  exec: DepExec;
  /**
   * Which platform's clone command to issue. Defaults to the host; injected so
   * the robocopy arm is exercised from any host, since a macOS run would
   * otherwise never reach it.
   */
  platform?: NodeJS.Platform;
  logger?: LoggerLike;
}

/** A discovered lockfile: its bare filename at the worktree root, plus the absolute path. */
interface DiscoveredLockfile {
  name: string;
  absPath: string;
}

/**
 * Builds and reuses per-key mirrors of a worktree's dependency directories.
 *
 * The only entry point is {@link VerifyDepPreparer.prepare}; everything else is
 * mechanics. It never throws at its caller — see FAIL-SOFT in the module doc.
 */
export class VerifyDepPreparer {
  private readonly deps: DepPreparerDeps;

  constructor(deps: DepPreparerDeps) {
    this.deps = deps;
  }

  /**
   * Returns a `src dir → mirror dir` map the caller CLONES FROM, or `null`
   * meaning "no prepared set; clone the live worktree dirs instead" — which is
   * slower and ABI-cold, never less isolated (the caller's destination is the
   * snapshot on both paths).
   *
   * Null — never a throw — is returned for: no dependency dirs, no lockfile at
   * the worktree root, a dependency dir outside the worktree, a failed
   * clone/rebuild/publish, a published set missing one of the requested dirs
   * (a set built from a DIFFERENT dir layout under the same key: honest miss,
   * not a partial mapping), or any unexpected error.
   */
  async prepare(runWorktreePath: string, dependencyDirs: readonly string[]): Promise<Map<string, string> | null> {
    try {
      if (dependencyDirs.length === 0) return null;

      const lockfile = await this.discoverLockfile(runWorktreePath);
      if (!lockfile) {
        this.deps.logger?.debug('depPreparer: no lockfile at the worktree root; using live dependency dirs', {
          runWorktreePath,
        });
        return null;
      }

      // Relative layout is load-bearing (see the module doc), so a dependency
      // dir that does not live under the worktree cannot be mirrored coherently.
      const relatives = new Map<string, string>();
      for (const src of dependencyDirs) {
        const rel = path.relative(runWorktreePath, src);
        if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
          this.deps.logger?.warn('depPreparer: dependency dir is outside the run worktree; using live dirs', {
            runWorktreePath,
            src,
          });
          return null;
        }
        relatives.set(src, rel);
      }

      const key = await this.computeKey(runWorktreePath, lockfile);
      const mirrorRoot = await this.ensureMirror(key, runWorktreePath, dependencyDirs, lockfile);
      if (!mirrorRoot) return null;

      const map = new Map<string, string>();
      for (const [src, rel] of relatives) {
        const mirrorDir = path.join(mirrorRoot, rel);
        if (!(await this.isDirectory(mirrorDir))) {
          this.deps.logger?.warn('depPreparer: prepared set is missing a requested dependency dir; using live dirs', {
            key,
            mirrorDir,
          });
          return null;
        }
        map.set(src, mirrorDir);
      }

      await this.touch(mirrorRoot);
      return map;
    } catch (err) {
      this.deps.logger?.warn('depPreparer: prepare failed; using live dependency dirs', {
        runWorktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Key derivation
  // -------------------------------------------------------------------------

  /** First existing {@link LOCKFILE_CANDIDATES} entry at the worktree root, or null. */
  private async discoverLockfile(runWorktreePath: string): Promise<DiscoveredLockfile | null> {
    for (const name of LOCKFILE_CANDIDATES) {
      const absPath = path.join(runWorktreePath, name);
      try {
        const stat = await fsPromises.stat(absPath);
        if (stat.isFile()) return { name, absPath };
      } catch {
        // Not this one — try the next candidate.
      }
    }
    return null;
  }

  /**
   * sha256 over (lockfile bytes, platform, arch, node major, declared electron
   * version), truncated to {@link KEY_HEX_CHARS}. Components are NUL-separated
   * so no concatenation of two different component sets can produce the same
   * pre-image (`arch="x"`+`node="64"` vs `arch="x64"`+`node=""`).
   */
  private async computeKey(runWorktreePath: string, lockfile: DiscoveredLockfile): Promise<string> {
    const lockBytes = await fsPromises.readFile(lockfile.absPath);
    const nodeMajor = process.versions.node.split('.')[0] ?? '';
    const electronVersion = (await this.readElectronVersion(runWorktreePath)) ?? '';

    const hash = createHash('sha256');
    hash.update(lockBytes);
    for (const component of [lockfile.name, process.platform, process.arch, nodeMajor, electronVersion]) {
      hash.update('\0');
      hash.update(component);
    }
    return hash.digest('hex').slice(0, KEY_HEX_CHARS);
  }

  /** The project's declared `electron` version from the root package.json (any dep section), or null. */
  private async readElectronVersion(runWorktreePath: string): Promise<string | null> {
    const pkg = await this.readRootPackageJson(runWorktreePath);
    if (!pkg) return null;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const deps = pkg[section];
      if (deps && typeof deps === 'object') {
        const value = (deps as Record<string, unknown>).electron;
        if (typeof value === 'string') return value;
      }
    }
    return null;
  }

  /** Root package.json, parsed defensively — an absent/corrupt manifest is simply "no info". */
  private async readRootPackageJson(runWorktreePath: string): Promise<Record<string, unknown> | null> {
    try {
      const text = await fsPromises.readFile(path.join(runWorktreePath, 'package.json'), 'utf8');
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Mirror lifecycle: reuse → build → publish → GC
  // -------------------------------------------------------------------------

  /** Single-flighted reuse-or-build. See {@link inFlightBuilds} for why the resolved value is the mirror ROOT. */
  private async ensureMirror(
    key: string,
    runWorktreePath: string,
    dependencyDirs: readonly string[],
    lockfile: DiscoveredLockfile,
  ): Promise<string | null> {
    const flightKey = `${path.resolve(this.deps.baseDir)}::${key}`;
    const existing = inFlightBuilds.get(flightKey);
    if (existing) return existing;

    const flight = this.reuseOrBuild(key, runWorktreePath, dependencyDirs, lockfile).catch((err: unknown) => {
      this.deps.logger?.warn('depPreparer: prepared-set build failed; using live dependency dirs', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    inFlightBuilds.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (inFlightBuilds.get(flightKey) === flight) inFlightBuilds.delete(flightKey);
    }
  }

  private async reuseOrBuild(
    key: string,
    runWorktreePath: string,
    dependencyDirs: readonly string[],
    lockfile: DiscoveredLockfile,
  ): Promise<string | null> {
    const finalDir = path.join(this.deps.baseDir, key);
    if (await this.isDirectory(finalDir)) {
      // REUSE. A published directory is complete by construction (it only ever
      // exists as the result of an atomic rename), so there is nothing to
      // validate here beyond its existence; the caller's per-dir check catches
      // a set that was built from a different dir layout.
      await this.touch(finalDir);
      return finalDir;
    }
    return this.build(key, runWorktreePath, dependencyDirs, lockfile);
  }

  /**
   * Build into `<baseDir>/<key>.tmp-<pid>`, then PUBLISH by renaming onto
   * `<baseDir>/<key>`. Build-then-rename is what makes a published set safe to
   * reuse without a lock: a reader either sees the final name (complete) or does
   * not see it (absent) — never a half-cloned tree, because a rename within one
   * filesystem is atomic.
   */
  private async build(
    key: string,
    runWorktreePath: string,
    dependencyDirs: readonly string[],
    lockfile: DiscoveredLockfile,
  ): Promise<string | null> {
    const finalDir = path.join(this.deps.baseDir, key);
    const tmpDir = path.join(this.deps.baseDir, `${key}${TMP_MARKER}${process.pid}`);

    await fsPromises.mkdir(this.deps.baseDir, { recursive: true });
    // A leftover from a crashed earlier build of THIS pid+key would otherwise
    // make `cp` refuse (dest exists) or poison the set with stale content.
    await this.removeInsideBaseDir(tmpDir);
    await fsPromises.mkdir(tmpDir, { recursive: true });

    try {
      for (const src of dependencyDirs) {
        const rel = path.relative(runWorktreePath, src);
        const dest = path.join(tmpDir, rel);
        await fsPromises.mkdir(path.dirname(dest), { recursive: true });
        await this.cloneDir(src, dest, tmpDir);
      }

      await this.copyManifests(runWorktreePath, tmpDir, dependencyDirs, lockfile);

      if (await this.dependsOnElectron(runWorktreePath)) {
        // §7.2: the Electron ABI rebuild belongs HERE — once, outside every
        // snapshot, against the mirror we are about to publish — and nowhere
        // else. Running it in the mirror root is what makes the prepared set's
        // native modules already correct for `electron .`, which is root cause
        // (c) removed rather than worked around.
        const result = await this.deps.exec('npx', ['electron-builder', 'install-app-deps'], {
          cwd: tmpDir,
          timeoutMs: REBUILD_TIMEOUT_MS,
        });
        if (result.code !== 0) {
          throw new Error(`electron-builder install-app-deps failed (code ${result.code}): ${result.out}`);
        }
      }

      const published = await this.publish(tmpDir, finalDir);
      if (!published) return null;

      await this.touch(finalDir);
      await this.gc();
      return finalDir;
    } catch (err) {
      this.deps.logger?.warn('depPreparer: prepared-set build failed; using live dependency dirs', {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.removeInsideBaseDir(tmpDir);
      return null;
    }
  }

  /**
   * Clone one dependency dir. On POSIX, `cp -Rc` asks APFS for clonefile
   * (copy-on-write: near-zero time and disk until something writes). `-c` is
   * macOS-only and clonefile is refused across filesystems, so ANY failure
   * retries as a plain recursive copy — slower, identical result. A partial
   * destination from the failed attempt is removed first so the retry starts
   * clean.
   *
   * Windows has no `cp` (and the packaged app cannot assume a Git-for-Windows
   * `cp.exe` on PATH), so it clones with robocopy — shipped with the OS — whose
   * exit codes are a BITMASK: anything below 8 is a success flavor
   * (1=files copied, 2=extra dest files, 4=mismatched attributes); 8+ are
   * real failures.
   */
  private async cloneDir(src: string, dest: string, cwd: string): Promise<void> {
    if ((this.deps.platform ?? process.platform) === 'win32') {
      const copied = await this.deps.exec(
        'robocopy',
        [src, dest, '/E', '/NFL', '/NDL', '/NJH', '/NP', '/NS', '/NC'],
        { cwd, timeoutMs: CLONE_TIMEOUT_MS },
      );
      if (copied.code < 8) return;
      throw new Error(`robocopy failed for ${src} (code ${copied.code}): ${copied.out}`);
    }

    const cloned = await this.deps.exec('cp', ['-Rc', src, dest], { cwd, timeoutMs: CLONE_TIMEOUT_MS });
    if (cloned.code === 0) return;

    this.deps.logger?.debug('depPreparer: clonefile copy unavailable, falling back to a plain recursive copy', {
      src,
      dest,
      out: cloned.out,
    });
    await this.removeInsideBaseDir(dest);
    const copied = await this.deps.exec('cp', ['-R', src, dest], { cwd, timeoutMs: CLONE_TIMEOUT_MS });
    if (copied.code !== 0) {
      throw new Error(`cp -R failed for ${src} (code ${copied.code}): ${copied.out}`);
    }
  }

  /**
   * Copy the manifests the mirror needs to be self-describing: the lockfile and
   * {@link ROOT_MANIFESTS} at the root, plus the `package.json` ADJACENT to each
   * cloned dependency dir (root and each nested workspace), each to its same
   * relative spot. Best-effort per file — a project without a
   * `pnpm-workspace.yaml`, or a nested `node_modules` with no sibling manifest,
   * is normal, not an error.
   */
  private async copyManifests(
    runWorktreePath: string,
    tmpDir: string,
    dependencyDirs: readonly string[],
    lockfile: DiscoveredLockfile,
  ): Promise<void> {
    const relFiles = new Set<string>([lockfile.name, ...ROOT_MANIFESTS]);
    for (const src of dependencyDirs) {
      const manifest = path.join(path.dirname(src), 'package.json');
      relFiles.add(path.relative(runWorktreePath, manifest));
    }

    for (const rel of relFiles) {
      if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const from = path.join(runWorktreePath, rel);
      const to = path.join(tmpDir, rel);
      try {
        await fsPromises.mkdir(path.dirname(to), { recursive: true });
        await fsPromises.copyFile(from, to);
      } catch {
        // Absent/unreadable manifest — the mirror is still usable without it.
      }
    }
  }

  /** Whether the project declares `electron` in any dependency section (drives the in-mirror ABI rebuild). */
  private async dependsOnElectron(runWorktreePath: string): Promise<boolean> {
    return (await this.readElectronVersion(runWorktreePath)) !== null;
  }

  /**
   * Atomic publish. A rename onto an EXISTING final name means a peer process
   * built the same key first — a race we win by losing: drop our tmp build and
   * adopt theirs (identical by construction; that is what the key asserts).
   * Any other rename failure is a real error and returns null (fail-soft).
   */
  private async publish(tmpDir: string, finalDir: string): Promise<boolean> {
    try {
      await fsPromises.rename(tmpDir, finalDir);
      return true;
    } catch (err) {
      if (await this.isDirectory(finalDir)) {
        this.deps.logger?.debug('depPreparer: a peer published this prepared set first; adopting it', { finalDir });
        await this.removeInsideBaseDir(tmpDir);
        return true;
      }
      this.deps.logger?.warn('depPreparer: publish rename failed; using live dependency dirs', {
        tmpDir,
        finalDir,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.removeInsideBaseDir(tmpDir);
      return false;
    }
  }

  /**
   * LRU trim to {@link KEEP_PREPARED_SETS}, newest-first by `.last-used`, MINUS
   * anything still inside {@link DEP_MIRROR_GC_GRACE_MS} — see that constant
   * for why a recently-handed-out mirror must survive even when the keep-2
   * rank alone would evict it (a caller may still be cloning from it). Runs
   * only after a successful publish — GC is maintenance, never a precondition
   * for serving a request. Unpublished ({@link TMP_MARKER}) directories are
   * skipped: another process may be mid-build inside one, and every failure path
   * removes its own.
   */
  private async gc(): Promise<void> {
    try {
      const entries = await fsPromises.readdir(this.deps.baseDir, { withFileTypes: true });
      const published = entries.filter((e) => e.isDirectory() && !e.name.includes(TMP_MARKER));
      const stamped = await Promise.all(
        published.map(async (e) => ({
          name: e.name,
          lastUsed: await this.readStamp(path.join(this.deps.baseDir, e.name)),
        })),
      );
      stamped.sort((a, b) => b.lastUsed - a.lastUsed);
      const now = Date.now();
      for (const victim of stamped.slice(KEEP_PREPARED_SETS)) {
        if (now - victim.lastUsed < DEP_MIRROR_GC_GRACE_MS) {
          // Grace window: this set was published or reused recently enough
          // that a caller may still be mid-clone from it — see
          // DEP_MIRROR_GC_GRACE_MS. Leave it; a later GC pass (after another
          // publish) re-evaluates it once the window has passed.
          continue;
        }
        await this.removeInsideBaseDir(path.join(this.deps.baseDir, victim.name));
      }
    } catch (err) {
      this.deps.logger?.warn('depPreparer: prepared-set GC failed', {
        baseDir: this.deps.baseDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Small fs helpers
  // -------------------------------------------------------------------------

  private async isDirectory(target: string): Promise<boolean> {
    try {
      return (await fsPromises.stat(target)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Write the recency stamp; best-effort (a set with no stamp simply sorts oldest in GC). */
  private async touch(dir: string): Promise<void> {
    try {
      await fsPromises.writeFile(path.join(dir, LAST_USED_STAMP), `${Date.now()}`, 'utf8');
    } catch {
      // Non-fatal: the set is usable, it just loses LRU precedence.
    }
  }

  /** Stamp value, falling back to mtime, then to 0 (= evict first). */
  private async readStamp(dir: string): Promise<number> {
    try {
      const text = await fsPromises.readFile(path.join(dir, LAST_USED_STAMP), 'utf8');
      const value = Number(text.trim());
      if (Number.isFinite(value)) return value;
    } catch {
      // Fall through to mtime.
    }
    try {
      return (await fsPromises.stat(dir)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * The ONLY recursive delete in this module, and it refuses anything that is
   * not strictly inside `baseDir`. Every path handed to it is composed from
   * `baseDir` + a key, so a violation means a bug upstream — which is exactly
   * when a guard on `rm -rf` earns its keep. It logs and declines rather than
   * throwing: a refused delete leaves garbage, an unrefused one could delete a
   * user's tree.
   */
  private async removeInsideBaseDir(target: string): Promise<void> {
    const base = path.resolve(this.deps.baseDir);
    const resolved = path.resolve(target);
    if (resolved === base || !resolved.startsWith(base + path.sep)) {
      this.deps.logger?.error('depPreparer: refusing to remove a path outside the prepared-set cache', {
        baseDir: base,
        target: resolved,
      });
      return;
    }
    try {
      await fsPromises.rm(resolved, { recursive: true, force: true });
    } catch (err) {
      this.deps.logger?.warn('depPreparer: failed to remove a prepared-set directory', {
        target: resolved,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
