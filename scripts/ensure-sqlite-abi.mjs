#!/usr/bin/env node
/**
 * ensure-sqlite-abi — make the installed better-sqlite3 native addon match the
 * ABI of the runtime that is about to load it, as cheaply as possible.
 *
 * WHY THIS EXISTS
 * ---------------
 * NODE_MODULE_VERSION is a property of the HOST BINARY, not the module. There
 * is exactly one compiled artifact —
 *   node_modules/.../better-sqlite3/build/Release/better_sqlite3.node
 * — and two hosts that dlopen it: Electron (`pnpm dev`, e2e, packaging) and
 * host Node (vitest). Whichever rebuilt last wins, so the two ABIs ping-pong
 * and the loser dies with a NODE_MODULE_VERSION mismatch far from its cause.
 *
 * CI already flips deterministically (see .github/workflows/quality.yml, which
 * runs scripts/rebuild-better-sqlite3-host.mjs before every DB-touching job).
 * The pain is LOCAL: run the unit suite, then `pnpm dev`, and the app crashes.
 *
 * This script closes that gap two ways:
 *   1. GUARD — probe first. If the installed artifact already loads under the
 *      target runtime, exit 0 immediately. Steady state is a ~50ms no-op, so
 *      it can sit in front of every entry point without anyone noticing.
 *   2. CACHE — the artifact is a SINGLE FILE. Keep one copy per ABI under
 *      .abi-cache/ and swap by copy (~50ms) instead of recompiling (minutes).
 *      The cache is populated for free: whenever we are about to overwrite a
 *      working artifact, we bank it under the ABI it actually satisfies first.
 * Only on a genuine cache miss do we pay for a real rebuild.
 *
 * The probe is a real `new Database(':memory:')` in a FRESH child process, not
 * a marker file or a hash guess — it is ground truth about whether the thing
 * loads, which is the only question that matters. Reading it costs one process
 * spawn; a wrong answer costs a confusing test failure, so we buy the truth.
 *
 * USAGE
 *   node scripts/ensure-sqlite-abi.mjs host       # before vitest
 *   node scripts/ensure-sqlite-abi.mjs electron   # before `pnpm dev`
 *   node scripts/ensure-sqlite-abi.mjs --check host       # read-only: which ABI is installed?
 *   node scripts/ensure-sqlite-abi.mjs --print-key host   # diagnostics
 *
 * Swaps are ATOMIC and MUTUALLY EXCLUSIVE. The artifact is never rewritten in
 * place — it is staged beside itself and renamed over, so a process that already
 * has it mmap'd keeps the old inode and never sees bytes change under it (see
 * installArtifact for the crash this prevents). Concurrent swappers serialize on
 * a lock next to the artifact, since a worktree without its own node_modules
 * shares the parent checkout's copy.
 *
 * ENV
 *   SQLITE_ABI_CACHE_DIR     override the cache location (default <repo>/.abi-cache)
 *   SQLITE_ABI_MODULE_DIR    test seam — point at a fixture better-sqlite3 dir
 *   SQLITE_ABI_FAKE          test seam — see "FAKE MODE" below
 *   SQLITE_ABI_LOCK_WAIT_MS  test seam — shorten the swap-lock wait
 *
 * FAKE MODE (tests only)
 *   With SQLITE_ABI_FAKE=1 no child process is spawned and nothing is compiled.
 *   An artifact is treated as loadable under <target> iff its bytes begin with
 *   `abi:<target>`, and a "rebuild" just writes that stamp. That one rule makes
 *   probe, cache save/restore and rebuild all consistent with each other, so the
 *   decision logic under test is the real one — only the native work is faked.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const TARGETS = ['host', 'electron'];
const FAKE = process.env.SQLITE_ABI_FAKE === '1';

function log(message) {
  console.log(`[ensure-sqlite-abi] ${message}`);
}

function fail(message) {
  console.error(`[ensure-sqlite-abi] ${message}`);
}

/** The other ABI — the one we may be about to overwrite and should bank first. */
function otherTarget(target) {
  return target === 'host' ? 'electron' : 'host';
}

/**
 * Locate the installed better-sqlite3 package directory.
 *
 * Resolves the package.json first, falling back to walking up from the main
 * entry: under pnpm the real package lives in a .pnpm content-addressed store
 * and `node_modules/better-sqlite3` is only a symlink into it, so the path
 * cannot be hardcoded. `require.resolve` does not execute the module, so this
 * is safe to call even when the addon is on the wrong ABI.
 */
function resolveModuleDir() {
  const override = process.env.SQLITE_ABI_MODULE_DIR;
  if (override) return fs.existsSync(override) ? override : null;

  try {
    return path.dirname(require.resolve('better-sqlite3/package.json', { paths: [repoRoot] }));
  } catch {
    // Older/`exports`-restricted layouts may refuse the package.json subpath.
  }

  try {
    let dir = path.dirname(require.resolve('better-sqlite3', { paths: [repoRoot] }));
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      dir = path.dirname(dir);
    }
  } catch {
    // Not installed at all.
  }
  return null;
}

function artifactPath(moduleDir) {
  return path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
}

/**
 * Put `bytes at sourcePath` in place at `destination` WITHOUT ever rewriting the
 * destination's existing inode.
 *
 * This is not a style preference — it is the fix for a real crash class.
 * `fs.copyFileSync` truncates and rewrites the destination IN PLACE, keeping the
 * same inode (measured; not folklore). Any process that already has that .node
 * mmap'd therefore sees its bytes change underneath it, and because macOS
 * validates code-signed pages LAZILY — on fault, not at load — the next page
 * fault against the mapping fails validation and the process dies with
 * `EXC_BAD_ACCESS / KERN_CODESIGN_ERROR`, dyld's Mach-O header parse
 * (`mach_o::Universal::isUniversal` / `compatibleSlice`) sitting on the stack.
 * That is Sentry CYBOFLOW-APP-6: 53 events spread evenly across 12 releases,
 * i.e. long-standing tooling rather than any one build.
 *
 * Staging into the SAME directory and renaming fixes it: rename(2) is atomic and
 * swaps the inode, so a live mapping keeps pointing at the old one and never
 * observes a byte change. Same directory matters — a cross-filesystem rename
 * would fall back to a copy and reintroduce the tear.
 */
function installArtifact(sourcePath, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = `${destination}.staging-${process.pid}`;
  try {
    fs.copyFileSync(sourcePath, staging);
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

/** As installArtifact, for content we generate rather than copy (FAKE mode). */
function writeArtifact(destination, contents) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = `${destination}.staging-${process.pid}`;
  try {
    fs.writeFileSync(staging, contents);
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

/**
 * Warn when the artifact we are about to touch lives OUTSIDE this checkout.
 *
 * Node resolution walks up the directory tree, so a git worktree with no
 * node_modules of its own silently resolves the parent checkout's copy — and
 * there is only one compiled artifact there, shared with the parent's dev server
 * and every sibling worktree. Whatever we do here is felt by all of them. That
 * is pre-existing (vitest in such a worktree already loads the parent's addon),
 * but a swap is a WRITE, so it must not happen invisibly.
 */
function noteModuleLocation(moduleDir) {
  const relative = path.relative(repoRoot, moduleDir);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return;
  log(`note: using better-sqlite3 from outside this checkout — ${moduleDir}`);
  log('      that copy is shared with the parent checkout and sibling worktrees.');
  log('      Run `pnpm install` here to give this worktree its own.');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Path to the Electron binary, or null when Electron is not installed. */
function resolveElectronBinary() {
  try {
    const entry = require(require.resolve('electron', { paths: [repoRoot] }));
    return typeof entry === 'string' && fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function resolveElectronVersion() {
  // In fake mode the cache key must not depend on whether Electron is actually
  // installed — tests exercise the electron branch on checkouts that have no
  // node_modules at all (a fresh git worktree).
  if (FAKE) return 'fake';
  try {
    const pkg = readJson(require.resolve('electron/package.json', { paths: [repoRoot] }));
    return pkg?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Cache key for a target. Every input that can invalidate a compiled artifact
 * is baked in — platform, arch, the better-sqlite3 version, and the ABI-defining
 * version of the host (Node's NODE_MODULE_VERSION, or Electron's release). A
 * Node or Electron upgrade therefore MISSES rather than restoring a stale
 * artifact that would dlopen-fail, which is the whole point of keying it.
 *
 * Returns null when the target's ABI cannot be identified (e.g. Electron is not
 * installed) — callers then skip the cache entirely rather than guess.
 */
function cacheKey(target, moduleVersion) {
  const base = `${process.platform}-${process.arch}-bsq${moduleVersion}`;
  if (target === 'host') return `host-${base}-nmv${process.versions.modules}`;
  const electronVersion = resolveElectronVersion();
  if (!electronVersion) return null;
  return `electron-${base}-el${electronVersion}`;
}

function cacheDir() {
  return process.env.SQLITE_ABI_CACHE_DIR || path.join(repoRoot, '.abi-cache');
}

function cachePath(key) {
  return path.join(cacheDir(), key, 'better_sqlite3.node');
}

/**
 * Does the artifact currently on disk load under `target`?
 *
 * Spawns a FRESH child process rather than requiring in-process: Node caches a
 * native addon by resolved path once loaded, so an in-process check would keep
 * reporting the pre-swap binary and mask the exact staleness we are testing for
 * (same reasoning as scripts/rebuild-better-sqlite3-host.mjs).
 */
function probe(target, moduleDir) {
  const artifact = artifactPath(moduleDir);
  if (!fs.existsSync(artifact)) return { ok: false, detail: `no artifact at ${artifact}` };

  if (FAKE) {
    const stamp = fs.readFileSync(artifact, 'utf8');
    return stamp.startsWith(`abi:${target}`)
      ? { ok: true, info: { nodeModuleVersion: `fake-${target}`, arch: process.arch } }
      : { ok: false, detail: `fake artifact is not stamped abi:${target}` };
  }

  const source = `
    const Database = require(${JSON.stringify(moduleDir)});
    const db = new Database(':memory:');
    db.exec('CREATE TABLE probe (id INTEGER)');
    db.exec('DROP TABLE probe');
    db.close();
    process.stdout.write(JSON.stringify({
      nodeModuleVersion: process.versions.modules,
      arch: process.arch,
    }));
  `;

  let exec = process.execPath;
  let env = process.env;
  if (target === 'electron') {
    const binary = resolveElectronBinary();
    if (!binary) return { ok: false, detail: 'electron is not installed; run pnpm install' };
    exec = binary;
    // Electron-as-Node: same binary, same ABI, no window — so the probe measures
    // the ABI the real app will load with, without opening a UI.
    env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    // The Electron binary rejects --openssl-legacy-provider in NODE_OPTIONS
    // (even with ELECTRON_RUN_AS_NODE=1), so a host that exports it would make
    // the probe fail spuriously and force the slow rebuild path on every launch.
    // The probe only needs a bare ABI check — drop NODE_OPTIONS for this child.
    delete env.NODE_OPTIONS;
  }

  const result = spawnSync(exec, ['-e', source], { cwd: repoRoot, encoding: 'utf8', env });
  if (result.status !== 0) {
    return { ok: false, detail: (result.stderr || result.error?.message || 'unknown failure').trim() };
  }
  try {
    return { ok: true, info: JSON.parse(result.stdout.trim()) };
  } catch {
    return { ok: false, detail: `could not parse probe output: ${result.stdout}` };
  }
}

/** Copy the current artifact into the cache under `key`, if not already banked. */
function saveToCache(key, moduleDir) {
  if (!key) return false;
  const destination = cachePath(key);
  if (fs.existsSync(destination)) return false;
  installArtifact(artifactPath(moduleDir), destination);
  log(`banked current artifact in cache as ${key}`);
  return true;
}

/** Copy a cached artifact into place. Returns false on a cache miss. */
function restoreFromCache(key, moduleDir) {
  if (!key) return false;
  const source = cachePath(key);
  if (!fs.existsSync(source)) return false;
  installArtifact(source, artifactPath(moduleDir));
  return true;
}

/**
 * Pay full price: recompile the addon for `target`.
 *
 * The host path delegates to scripts/rebuild-better-sqlite3-host.mjs, which
 * already retries once with a forced source build — a bare `pnpm rebuild` can
 * silently leave a stale wrong-arch prebuild behind. Reuse it rather than
 * duplicating that hard-won retry.
 */
function rebuild(target, moduleDir) {
  log(`cache miss — rebuilding better-sqlite3 for the ${target} ABI (this is the slow path)`);

  if (FAKE) {
    writeArtifact(artifactPath(moduleDir), `abi:${target}\n`);
    return true;
  }

  const [command, args] =
    target === 'host'
      ? [process.execPath, [path.join(repoRoot, 'scripts', 'rebuild-better-sqlite3-host.mjs')]]
      : ['pnpm', ['run', 'electron:rebuild']];

  // node-gyp writes build/Release/better_sqlite3.node itself, so installArtifact
  // cannot stage this one — the rewrite happens inside the child. Evict the old
  // artifact by RENAMING it aside first: the compiler then creates a fresh inode,
  // and any process still holding the old one keeps a stable mapping (rename does
  // not disturb mappings, and neither does the unlink below — the inode outlives
  // its last link while mapped). Without this, a cache-miss rebuild tears live
  // readers exactly the way the in-place copy used to.
  const artifact = artifactPath(moduleDir);
  const evicted = `${artifact}.evicted-${process.pid}`;
  let didEvict = false;
  try {
    fs.renameSync(artifact, evicted);
    didEvict = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // nothing installed yet — nothing to evict
  }

  const ok = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' }).status === 0;

  if (didEvict) {
    // On failure put it back: a failed rebuild must not leave the tree emptier
    // than it found it, or the next run has no artifact to bank or fall back to.
    if (!ok && !fs.existsSync(artifact)) fs.renameSync(evicted, artifact);
    else fs.rmSync(evicted, { force: true });
  }
  return ok;
}

/**
 * Serialize ABI swaps across processes.
 *
 * The rename in installArtifact protects READERS (a live mmap never sees bytes
 * change). This lock protects the SWAP ITSELF from another swapper: without it,
 * two flips to different targets can interleave their bank/restore/rebuild steps
 * and leave the cache holding an artifact filed under the wrong ABI.
 *
 * The lock lives beside the ARTIFACT, not in the repo-local cache dir, because
 * the artifact is the contended resource — a git worktree with no node_modules
 * of its own resolves the PARENT checkout's copy (see noteModuleLocation), so
 * siblings must contend on the same lock rather than one per worktree.
 *
 * mkdir is the primitive: it is atomic and fails EEXIST when already held.
 */
const LOCK_POLL_MS = 100;
// A genuine cache-miss rebuild takes minutes, so the wait has to outlast one.
// SQLITE_ABI_LOCK_WAIT_MS is a test seam — the contention tests would otherwise
// have to sit through the real ten minutes to observe a give-up.
const LOCK_WAIT_MS = Number.parseInt(process.env.SQLITE_ABI_LOCK_WAIT_MS ?? '', 10) || 10 * 60_000;
const LOCK_STALE_MS = 20 * 60_000;

function lockPath(moduleDir) {
  return path.join(moduleDir, 'build', 'Release', '.abi-swap.lock');
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock is stale if its owner died, or it has simply sat there far too long. */
function lockIsStale(dir) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return false; // vanished — not stale, just gone
  }
  if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;
  const pid = Number.parseInt(fs.readFileSync(path.join(dir, 'owner'), 'utf8').trim(), 10);
  if (!Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0); // signal 0 tests liveness without delivering anything
    return false;
  } catch {
    return true; // owner is gone; it died holding the lock
  }
}

function withSwapLock(moduleDir, fn) {
  const dir = lockPath(moduleDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  let announced = false;

  while (!held) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'owner'), `${process.pid}\n`);
      held = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (lockIsStale(dir)) {
        log('breaking a stale ABI-swap lock (owner is gone)');
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        // Never proceed unserialized: that is the corruption this prevents.
        fail(`another ABI swap has held ${dir} for over ${LOCK_WAIT_MS / 60_000} minutes.`);
        fail('If nothing is really running, remove that directory and retry.');
        return 1;
      }
      if (!announced) {
        log('waiting for another ABI swap to finish…');
        announced = true;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }

  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ensure(target) {
  const moduleDir = resolveModuleDir();
  if (!moduleDir) {
    fail('better-sqlite3 could not be resolved from this checkout or any parent.');
    fail('Run `pnpm install` first.');
    return 1;
  }
  noteModuleLocation(moduleDir);
  return withSwapLock(moduleDir, () => ensureLocked(target, moduleDir));
}

function ensureLocked(target, moduleDir) {
  const moduleVersion = readJson(path.join(moduleDir, 'package.json'))?.version ?? 'unknown';
  const key = cacheKey(target, moduleVersion);

  // 1. Guard: already correct? This is the steady state and must stay cheap.
  const initial = probe(target, moduleDir);
  if (initial.ok) {
    saveToCache(key, moduleDir);
    log(`already on the ${target} ABI (NODE_MODULE_VERSION=${initial.info.nodeModuleVersion}) — nothing to do`);
    return 0;
  }

  // 2. Wrong ABI. Bank the artifact we are about to overwrite, so the trip back
  //    is a copy rather than another recompile.
  const outgoing = probe(otherTarget(target), moduleDir);
  if (outgoing.ok) saveToCache(cacheKey(otherTarget(target), moduleVersion), moduleDir);

  // 3. Try the cheap swap.
  if (restoreFromCache(key, moduleDir)) {
    const restored = probe(target, moduleDir);
    if (restored.ok) {
      log(`restored the ${target} ABI from cache (NODE_MODULE_VERSION=${restored.info.nodeModuleVersion})`);
      return 0;
    }
    fail(`cached ${target} artifact failed to load; discarding it and rebuilding.`);
    fs.rmSync(cachePath(key), { force: true });
  }

  // 4. Cache miss (or a poisoned entry) — recompile.
  if (!rebuild(target, moduleDir)) {
    fail(`rebuild for the ${target} ABI failed.`);
    return 1;
  }

  const rebuilt = probe(target, moduleDir);
  if (!rebuilt.ok) {
    fail(`better-sqlite3 still does not load under the ${target} ABI after a rebuild:`);
    fail(rebuilt.detail);
    return 1;
  }

  saveToCache(key, moduleDir);
  log(`rebuilt for the ${target} ABI (NODE_MODULE_VERSION=${rebuilt.info.nodeModuleVersion})`);
  return 0;
}

function main(argv) {
  const printKeyIndex = argv.indexOf('--print-key');
  if (printKeyIndex !== -1) {
    const target = argv[printKeyIndex + 1];
    if (!TARGETS.includes(target)) {
      fail(`--print-key needs a target: ${TARGETS.join(' | ')}`);
      return 2;
    }
    const moduleDir = resolveModuleDir();
    const moduleVersion = moduleDir
      ? (readJson(path.join(moduleDir, 'package.json'))?.version ?? 'unknown')
      : 'unknown';
    console.log(cacheKey(target, moduleVersion) ?? '');
    return 0;
  }

  // Read-only: report whether the installed artifact loads under <target>
  // without swapping, rebuilding or touching the cache. Safe to run against a
  // checkout whose app is live — diagnosing must never mutate what it measures.
  const checkIndex = argv.indexOf('--check');
  if (checkIndex !== -1) {
    const target = argv[checkIndex + 1];
    if (!TARGETS.includes(target)) {
      fail(`--check needs a target: ${TARGETS.join(' | ')}`);
      return 2;
    }
    const moduleDir = resolveModuleDir();
    if (!moduleDir) {
      fail('better-sqlite3 could not be resolved from this checkout or any parent.');
      return 1;
    }
    noteModuleLocation(moduleDir);
    const result = probe(target, moduleDir);
    if (result.ok) {
      log(`installed artifact LOADS under the ${target} ABI (NODE_MODULE_VERSION=${result.info.nodeModuleVersion})`);
      return 0;
    }
    log(`installed artifact does NOT load under the ${target} ABI`);
    log(result.detail);
    return 1;
  }

  const target = argv[0];
  if (!TARGETS.includes(target)) {
    fail(`usage: node scripts/ensure-sqlite-abi.mjs <${TARGETS.join('|')}>`);
    return 2;
  }
  return ensure(target);
}

process.exit(main(process.argv.slice(2)));
