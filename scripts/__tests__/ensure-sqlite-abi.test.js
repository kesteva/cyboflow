#!/usr/bin/env node
/**
 * Tests for scripts/ensure-sqlite-abi.mjs.
 *
 * Plain Node built-in test runner (node:test + node:assert) — no extra deps,
 * matching the other scripts/__tests__ suites. Runs in the `test:unit` chain.
 *
 * Run: node scripts/__tests__/ensure-sqlite-abi.test.js
 *
 * These run in SQLITE_ABI_FAKE=1 mode against a fixture package dir, so no
 * native module is compiled and no child runtime is spawned. What is faked is
 * only the native work: an artifact "loads" under <target> iff its bytes begin
 * with `abi:<target>`, and a "rebuild" writes that stamp. Every decision under
 * test — guard / bank-the-outgoing / restore / rebuild / discard-poisoned — is
 * the real code path.
 *
 * Why each matters:
 *   - The GUARD sits in front of `test:unit` and `pnpm dev`. If it stops being a
 *     no-op in steady state it taxes every single invocation, so the fast path
 *     is pinned explicitly (no rebuild, bytes untouched).
 *   - The CACHE is the whole point: a flip must be a copy, not a recompile. The
 *     round-trip test proves the second flip never reaches the rebuild path.
 *   - A cache key that fails to invalidate on a Node/Electron/better-sqlite3
 *     upgrade would restore an artifact that dlopen-fails — worse than no cache.
 *   - The missing-module message is the one a fresh git worktree hits first.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/ensure-sqlite-abi.mjs');

const ARTIFACT_REL = path.join('build', 'Release', 'better_sqlite3.node');

/**
 * Build a throwaway workspace: a fixture better-sqlite3 package dir (optionally
 * carrying a stamped artifact) plus an empty cache dir.
 */
function makeWorkspace({ stamp, prebuildStamp } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-abi-'));
  const moduleDir = path.join(root, 'better-sqlite3');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(path.join(moduleDir, 'build', 'Release'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(moduleDir, 'package.json'),
    JSON.stringify({ name: 'better-sqlite3', version: '11.10.0' })
  );
  if (stamp) fs.writeFileSync(path.join(moduleDir, ARTIFACT_REL), stamp);
  const prebuild = path.join(moduleDir, 'prebuilds', `${process.platform}-${process.arch}.node`);
  if (prebuildStamp) {
    fs.mkdirSync(path.dirname(prebuild), { recursive: true });
    fs.writeFileSync(prebuild, prebuildStamp);
  }

  return {
    root,
    moduleDir,
    cacheDir,
    prebuild,
    artifact: path.join(moduleDir, ARTIFACT_REL),
    readArtifact: () => fs.readFileSync(path.join(moduleDir, ARTIFACT_REL), 'utf8'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function run(args, workspace, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SQLITE_ABI_FAKE: '1',
      SQLITE_ABI_MODULE_DIR: workspace.moduleDir,
      SQLITE_ABI_CACHE_DIR: workspace.cacheDir,
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Every file banked in the cache, as `${key}` entries. */
function cacheKeys(workspace) {
  if (!fs.existsSync(workspace.cacheDir)) return [];
  return fs
    .readdirSync(workspace.cacheDir)
    .filter((entry) => fs.existsSync(path.join(workspace.cacheDir, entry, 'better_sqlite3.node')))
    .sort();
}

test('guard: already on the target ABI is a no-op that leaves the artifact untouched', () => {
  const ws = makeWorkspace({ stamp: 'abi:host\noriginal-bytes' });
  try {
    const result = run(['host'], ws);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already on the host ABI/);
    assert.doesNotMatch(result.stdout, /rebuilding/);
    assert.equal(ws.readArtifact(), 'abi:host\noriginal-bytes');
  } finally {
    ws.cleanup();
  }
});

test('guard: the no-op path still seeds the cache so the first flip is cheap', () => {
  const ws = makeWorkspace({ stamp: 'abi:host\noriginal-bytes' });
  try {
    run(['host'], ws);
    const keys = cacheKeys(ws);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^host-/);
  } finally {
    ws.cleanup();
  }
});

test('wrong ABI with an empty cache rebuilds, and banks the outgoing artifact first', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    const result = run(['host'], ws);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cache miss — rebuilding/);
    assert.match(ws.readArtifact(), /^abi:host/);

    // The electron artifact we displaced must be banked, or the trip back would
    // pay for another recompile — which is exactly what the cache exists to avoid.
    const keys = cacheKeys(ws);
    assert.equal(keys.length, 2);
    assert.ok(keys.some((k) => k.startsWith('electron-')), `no electron entry in ${keys}`);
    assert.ok(keys.some((k) => k.startsWith('host-')), `no host entry in ${keys}`);
    const bankedElectron = keys.find((k) => k.startsWith('electron-'));
    assert.equal(
      fs.readFileSync(path.join(ws.cacheDir, bankedElectron, 'better_sqlite3.node'), 'utf8'),
      'abi:electron\nelectron-bytes'
    );
  } finally {
    ws.cleanup();
  }
});

test('round trip: the second flip restores from cache instead of rebuilding', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    run(['host'], ws); // seeds both entries, rebuilds host
    const back = run(['electron'], ws);
    assert.equal(back.status, 0, back.stderr);
    assert.match(back.stdout, /restored the electron ABI from cache/);
    assert.doesNotMatch(back.stdout, /rebuilding/);
    // Byte-identical to what we banked — a copy, not a fresh compile.
    assert.equal(ws.readArtifact(), 'abi:electron\nelectron-bytes');

    const forward = run(['host'], ws);
    assert.match(forward.stdout, /restored the host ABI from cache/);
    assert.doesNotMatch(forward.stdout, /rebuilding/);
  } finally {
    ws.cleanup();
  }
});

test('a poisoned cache entry is discarded and rebuilt rather than trusted', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    // Bank a host entry whose contents do NOT satisfy the host ABI.
    const key = run(['--print-key', 'host'], ws).stdout.trim();
    fs.mkdirSync(path.join(ws.cacheDir, key), { recursive: true });
    fs.writeFileSync(path.join(ws.cacheDir, key, 'better_sqlite3.node'), 'abi:garbage\n');

    const result = run(['host'], ws);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /failed to load; discarding it/);
    assert.match(result.stdout, /cache miss — rebuilding/);
    assert.match(ws.readArtifact(), /^abi:host/);
  } finally {
    ws.cleanup();
  }
});

test('a missing artifact is rebuilt rather than treated as correct', () => {
  const ws = makeWorkspace(); // package dir exists, nothing compiled in it
  try {
    const result = run(['host'], ws);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cache miss — rebuilding/);
    assert.match(ws.readArtifact(), /^abi:host/);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// better-sqlite3 >= 13: an N-API prebuild that loads under BOTH hosts, and no
// compiled artifact at all. This is the steady state since the Electron 44
// upgrade, so the guard must be a no-op for either target and must not try to
// bank, restore or rebuild anything.
// ---------------------------------------------------------------------------

test('N-API prebuild, no compiled artifact: both targets pass as a no-op, nothing is banked', () => {
  const ws = makeWorkspace({ prebuildStamp: 'abi:any\nprebuild-bytes' });
  try {
    for (const target of ['host', 'electron']) {
      const result = run([target], ws);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`already on the ${target} ABI`));
      assert.doesNotMatch(result.stdout, /rebuilding|restored|banked/);
    }
    assert.equal(fs.existsSync(ws.artifact), false, 'no build/Release artifact may be conjured');
    assert.equal(fs.readFileSync(ws.prebuild, 'utf8'), 'abi:any\nprebuild-bytes');
    assert.deepEqual(cacheKeys(ws), [], 'there is no per-ABI artifact to bank');
  } finally {
    ws.cleanup();
  }
});

test('N-API prebuild shadows a stale compiled artifact, as the real loader does', () => {
  // A leftover build/Release from a pre-v13 install must not make the guard
  // believe the module is on the wrong ABI — the loader never opens it.
  const ws = makeWorkspace({ stamp: 'abi:electron\nstale-bytes', prebuildStamp: 'abi:any\n' });
  try {
    const result = run(['host'], ws);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already on the host ABI/);
    assert.doesNotMatch(result.stdout, /rebuilding|restored/);
    assert.equal(ws.readArtifact(), 'abi:electron\nstale-bytes', 'the stale artifact is left alone');
  } finally {
    ws.cleanup();
  }
});

test('an unresolvable better-sqlite3 fails loudly instead of silently passing', () => {
  const ws = makeWorkspace({ stamp: 'abi:host\n' });
  try {
    const result = run(['host'], ws, {
      SQLITE_ABI_MODULE_DIR: path.join(ws.root, 'does-not-exist'),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not be resolved from this checkout or any parent/);
  } finally {
    ws.cleanup();
  }
});

test('operating on a shared out-of-checkout copy is announced, not silent', () => {
  // Node resolution walks UP, so a worktree without its own node_modules hits the
  // parent checkout's single artifact — shared with its dev server and every
  // sibling worktree. A swap is a write; it must never happen invisibly.
  const ws = makeWorkspace({ stamp: 'abi:host\n' });
  try {
    const result = run(['--check', 'host'], ws);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /using better-sqlite3 from outside this checkout/);
    assert.match(result.stdout, /shared with the parent checkout and sibling worktrees/);
  } finally {
    ws.cleanup();
  }
});

test('an unknown target exits 2 with usage rather than touching anything', () => {
  const ws = makeWorkspace({ stamp: 'abi:host\noriginal-bytes' });
  try {
    for (const args of [[], ['nonsense']]) {
      const result = run(args, ws);
      assert.equal(result.status, 2, `expected usage exit for ${JSON.stringify(args)}`);
      assert.match(result.stderr, /usage: node scripts\/ensure-sqlite-abi\.mjs <host\|electron>/);
    }
    assert.equal(ws.readArtifact(), 'abi:host\noriginal-bytes');
    assert.deepEqual(cacheKeys(ws), []);
  } finally {
    ws.cleanup();
  }
});

test('--check reports the installed ABI without mutating anything', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    const miss = run(['--check', 'host'], ws);
    assert.equal(miss.status, 1);
    assert.match(miss.stdout, /does NOT load under the host ABI/);

    const hit = run(['--check', 'electron'], ws);
    assert.equal(hit.status, 0, hit.stderr);
    assert.match(hit.stdout, /LOADS under the electron ABI/);

    // The point of --check is that it is safe to run against a live checkout:
    // no swap, no rebuild, no cache write.
    assert.equal(ws.readArtifact(), 'abi:electron\nelectron-bytes');
    assert.deepEqual(cacheKeys(ws), []);
  } finally {
    ws.cleanup();
  }
});

test('cache keys pin every input that can invalidate a compiled artifact', () => {
  const ws = makeWorkspace({ stamp: 'abi:host\n' });
  try {
    const hostKey = run(['--print-key', 'host'], ws).stdout.trim();
    const electronKey = run(['--print-key', 'electron'], ws).stdout.trim();

    assert.notEqual(hostKey, electronKey);
    for (const key of [hostKey, electronKey]) {
      assert.ok(key.includes(process.platform), `${key} omits platform`);
      assert.ok(key.includes(process.arch), `${key} omits arch`);
      assert.ok(key.includes('bsq11.10.0'), `${key} omits the better-sqlite3 version`);
    }
    // The host key must move with NODE_MODULE_VERSION, or a Node upgrade would
    // silently restore an artifact built for the previous ABI.
    assert.ok(
      hostKey.endsWith(`nmv${process.versions.modules}`),
      `${hostKey} omits NODE_MODULE_VERSION`
    );
  } finally {
    ws.cleanup();
  }
});

test('a better-sqlite3 upgrade misses the cache rather than restoring a stale artifact', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    run(['host'], ws);
    const before = run(['--print-key', 'host'], ws).stdout.trim();

    fs.writeFileSync(
      path.join(ws.moduleDir, 'package.json'),
      JSON.stringify({ name: 'better-sqlite3', version: '12.0.0' })
    );
    const after = run(['--print-key', 'host'], ws).stdout.trim();
    assert.notEqual(before, after);

    // Flipping away and back on the new version must not reuse the old bytes.
    fs.writeFileSync(ws.artifact, 'abi:electron\nelectron-bytes');
    const result = run(['host'], ws);
    assert.match(result.stdout, /cache miss — rebuilding/);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Crash-class regression: never rewrite a mapped artifact's inode in place.
//
// fs.copyFileSync truncates and rewrites the destination, KEEPING its inode, so
// a process holding that .node mmap'd sees its bytes change underneath it. macOS
// validates code-signed pages lazily, on fault, so the next page fault against
// the mapping dies with EXC_BAD_ACCESS / KERN_CODESIGN_ERROR — Sentry
// CYBOFLOW-APP-6. Asserting on the INODE rather than on bytes is the point: the
// bytes were always correct, and a byte-only assertion passes on the buggy code.
// ---------------------------------------------------------------------------

const inodeOf = (file) => fs.statSync(file).ino;

test('a cache restore replaces the artifact inode instead of rewriting it in place', () => {
  const ws = makeWorkspace({ stamp: 'abi:host\nhost-bytes' });
  try {
    run(['host'], ws); // bank the host artifact
    fs.writeFileSync(ws.artifact, 'abi:electron\nelectron-bytes');
    const before = inodeOf(ws.artifact);

    const result = run(['host'], ws);
    assert.match(result.stdout, /restored the host ABI from cache/);
    assert.equal(ws.readArtifact(), 'abi:host\nhost-bytes');
    assert.notEqual(inodeOf(ws.artifact), before, 'restore must swap the inode, not rewrite in place');
  } finally {
    ws.cleanup();
  }
});

test('a rebuild replaces the artifact inode too (node-gyp writes it in place)', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    const before = inodeOf(ws.artifact);
    const result = run(['host'], ws);
    assert.match(result.stdout, /cache miss — rebuilding/);
    assert.notEqual(inodeOf(ws.artifact), before, 'rebuild must evict the old inode first');
  } finally {
    ws.cleanup();
  }
});

test('a swap leaves no staging or evicted files behind', () => {
  const ws = makeWorkspace({ stamp: 'abi:host\nhost-bytes' });
  try {
    run(['host'], ws);
    fs.writeFileSync(ws.artifact, 'abi:electron\nelectron-bytes');
    run(['host'], ws);

    const stray = fs
      .readdirSync(path.dirname(ws.artifact))
      .filter((e) => e.includes('.staging-') || e.includes('.evicted-'));
    assert.deepEqual(stray, []);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The swap lock. The rename above protects READERS; this protects two SWAPPERS
// from interleaving their bank/restore/rebuild steps.
// ---------------------------------------------------------------------------

const lockDirOf = (ws) => path.join(ws.moduleDir, 'build', 'Release', '.abi-swap.lock');

test('a lock held by a live process blocks a second swap rather than racing it', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    // process.pid is by definition alive, so this lock can never look stale.
    fs.mkdirSync(lockDirOf(ws), { recursive: true });
    fs.writeFileSync(path.join(lockDirOf(ws), 'owner'), `${process.pid}\n`);

    const result = run(['host'], ws, { SQLITE_ABI_LOCK_WAIT_MS: '600' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /waiting for another ABI swap/);
    // It gave up instead of proceeding: the artifact is untouched.
    assert.equal(ws.readArtifact(), 'abi:electron\nelectron-bytes');
  } finally {
    fs.rmSync(lockDirOf(ws), { recursive: true, force: true });
    ws.cleanup();
  }
});

test('a lock whose owner died is broken rather than waited out', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    // A pid that has certainly exited: spawn a child and let it finish.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    fs.mkdirSync(lockDirOf(ws), { recursive: true });
    fs.writeFileSync(path.join(lockDirOf(ws), 'owner'), `${dead.pid}\n`);

    const result = run(['host'], ws);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /breaking a stale ABI-swap lock/);
    assert.match(ws.readArtifact(), /^abi:host/);
  } finally {
    fs.rmSync(lockDirOf(ws), { recursive: true, force: true });
    ws.cleanup();
  }
});

test('the lock is released after a successful swap', () => {
  const ws = makeWorkspace({ stamp: 'abi:electron\nelectron-bytes' });
  try {
    run(['host'], ws);
    assert.equal(fs.existsSync(lockDirOf(ws)), false);
  } finally {
    ws.cleanup();
  }
});
