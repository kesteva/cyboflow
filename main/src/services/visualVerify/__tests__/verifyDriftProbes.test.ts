/**
 * verifyDriftProbes — the §5.3 drift probes' two load-bearing rules, which were
 * untestable while they lived inside `index.ts`'s Electron boot:
 *
 *   1. STABILITY. Both are compared for EQUALITY across calls, so an unchanged
 *      host must produce byte-identical output; a changed package script or
 *      lockfile must not.
 *   2. FAIL SOFT, NOT FAIL CHANGED. An unobservable input hash is `null`
 *      ("cannot tell"), never a fresh hash — a fresh one would demote a proof
 *      on every unreadable directory. A chromium probe that throws degrades to
 *      `chromium: null` rather than propagating.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeVerifyInputHash, computeVerifyHostFingerprint, probeHasPackageJson } from '../verifyDriftProbes';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-drift-probes-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writePkg = (scripts: Record<string, string>): void => {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts, packageManager: 'pnpm@10.11.1' }));
};

describe('computeVerifyInputHash', () => {
  it('is stable across calls on an unchanged directory', async () => {
    writePkg({ dev: 'vite' });
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    expect(await computeVerifyInputHash(dir)).toBe(await computeVerifyInputHash(dir));
  });

  it('changes when a package script changes', async () => {
    writePkg({ dev: 'vite' });
    const before = await computeVerifyInputHash(dir);
    writePkg({ dev: 'vite --port 4521' });

    expect(await computeVerifyInputHash(dir)).not.toBe(before);
  });

  it('changes when the lockfile changes', async () => {
    writePkg({ dev: 'vite' });
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const before = await computeVerifyInputHash(dir);
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# bumped\n');

    expect(await computeVerifyInputHash(dir)).not.toBe(before);
  });

  it('ignores files that are neither package.json nor a lockfile', async () => {
    writePkg({ dev: 'vite' });
    const before = await computeVerifyInputHash(dir);
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const x = 1;\n');

    expect(await computeVerifyInputHash(dir)).toBe(before);
  });

  it('npm path output is byte-identical to the pre-A0 algorithm (existing proofs must not drift)', async () => {
    // The pre-A0 digest, recomputed independently: scripts JSON, packageManager,
    // every present lockfile in LOCKFILES order, node major, modules ABI. A0
    // must not have moved a single byte of this for a tree WITH package.json.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, packageManager: 'pnpm@10.11.1' }),
    );
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    fs.writeFileSync(path.join(dir, 'yarn.lock'), '# yarn\n');
    // Fallback manifests alongside a package.json are NOT part of the npm path.
    fs.writeFileSync(path.join(dir, 'project.yml'), 'name: App\n');

    const expected = createHash('sha256');
    expected.update(JSON.stringify({ dev: 'vite' }));
    expected.update('pnpm@10.11.1');
    expected.update(fs.readFileSync(path.join(dir, 'pnpm-lock.yaml')));
    expected.update(fs.readFileSync(path.join(dir, 'yarn.lock')));
    expected.update(process.versions.node.split('.')[0]);
    expected.update(process.versions.modules);

    expect(await computeVerifyInputHash(dir)).toBe(expected.digest('hex'));
  });

  it('with a package.json present, a fallback manifest change does NOT move the hash', async () => {
    writePkg({ dev: 'vite' });
    fs.writeFileSync(path.join(dir, 'project.yml'), 'name: App\n');
    const before = await computeVerifyInputHash(dir);
    fs.writeFileSync(path.join(dir, 'project.yml'), 'name: App\ntargets: {}\n');

    expect(await computeVerifyInputHash(dir)).toBe(before);
  });

  it('returns null — not a hash — when package.json is unparseable', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    expect(await computeVerifyInputHash(dir)).toBeNull();
  });

  it('returns null on a non-ENOENT/ENOTDIR fs fault reading package.json (EACCES)', async () => {
    writePkg({ dev: 'vite' });
    const pkgPath = path.join(dir, 'package.json');
    fs.chmodSync(pkgPath, 0o000);
    try {
      // Root can still read a 0-perm file, so this assertion only holds
      // non-root — matches every other EACCES-shaped test in this repo.
      if (process.getuid && process.getuid() === 0) return;
      expect(await computeVerifyInputHash(dir)).toBeNull();
    } finally {
      fs.chmodSync(pkgPath, 0o644);
    }
  });
});

/**
 * A0 (docs/proposals/runbook-optional-verification.md §A0) — a missing
 * `package.json` is no longer "cannot observe". ENOENT/ENOTDIR on it folds in
 * the fixed-order fallback manifests instead (or a constant tag when none
 * exist), so a project with no npm manifest at all — an XcodeGen/Xcode-only
 * mobile repo, say — can still be proven and stay proven.
 */
describe('computeVerifyInputHash — A0 fallback manifests (no package.json)', () => {
  it('is non-null and stable when no package.json and no fallback manifest exists', async () => {
    const a = await computeVerifyInputHash(dir);
    const b = await computeVerifyInputHash(dir);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('changes when project.yml content changes', async () => {
    fs.writeFileSync(path.join(dir, 'project.yml'), 'name: App\n');
    const before = await computeVerifyInputHash(dir);
    fs.writeFileSync(path.join(dir, 'project.yml'), 'name: App\ntargets: {}\n');
    const after = await computeVerifyInputHash(dir);
    expect(after).not.toBe(before);
  });

  it('changing from no fallback manifest to one present also changes the hash', async () => {
    const before = await computeVerifyInputHash(dir);
    fs.writeFileSync(path.join(dir, 'Cargo.lock'), 'version = 3\n');
    const after = await computeVerifyInputHash(dir);
    expect(after).not.toBe(before);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
  });

  it('folds every fallback manifest kind, each changing the hash independently', async () => {
    const seen = new Set<string | null>();
    seen.add(await computeVerifyInputHash(dir));

    fs.writeFileSync(path.join(dir, 'Package.resolved'), '{"pins":[]}');
    seen.add(await computeVerifyInputHash(dir));

    fs.writeFileSync(path.join(dir, 'Podfile.lock'), 'PODS: []\n');
    seen.add(await computeVerifyInputHash(dir));

    fs.writeFileSync(path.join(dir, 'Cargo.lock'), 'version = 3\n');
    seen.add(await computeVerifyInputHash(dir));

    fs.writeFileSync(path.join(dir, 'go.sum'), 'module v0.0.0\n');
    seen.add(await computeVerifyInputHash(dir));

    // Every incremental addition produced a distinct hash.
    expect(seen.size).toBe(5);
  });

  it('folds the Xcode project\'s own Package.resolved, found by globbing *.xcodeproj at the root', async () => {
    const before = await computeVerifyInputHash(dir);

    const resolvedDir = path.join(dir, 'App.xcodeproj', 'project.xcworkspace', 'xcshareddata', 'swiftpm');
    fs.mkdirSync(resolvedDir, { recursive: true });
    fs.writeFileSync(path.join(resolvedDir, 'Package.resolved'), '{"pins":["a"]}');
    const withResolved = await computeVerifyInputHash(dir);
    expect(withResolved).not.toBe(before);

    fs.writeFileSync(path.join(resolvedDir, 'Package.resolved'), '{"pins":["a","b"]}');
    const changed = await computeVerifyInputHash(dir);
    expect(changed).not.toBe(withResolved);
  });

  it('globs xcodeproj dirs in sorted order — result is stable regardless of readdir order', async () => {
    for (const name of ['Widget.xcodeproj', 'App.xcodeproj']) {
      const resolvedDir = path.join(dir, name, 'project.xcworkspace', 'xcshareddata', 'swiftpm');
      fs.mkdirSync(resolvedDir, { recursive: true });
      fs.writeFileSync(path.join(resolvedDir, 'Package.resolved'), `{"pins":["${name}"]}`);
    }
    const a = await computeVerifyInputHash(dir);
    const b = await computeVerifyInputHash(dir);
    expect(a).toBe(b);
  });

  it('never folds project.pbxproj — it is not one of the fallback manifests', async () => {
    const before = await computeVerifyInputHash(dir);
    const projDir = path.join(dir, 'App.xcodeproj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'project.pbxproj'), '// pbxproj v1\n');
    const after = await computeVerifyInputHash(dir);
    expect(after).toBe(before);
  });

  it('keeps a probe path that is not an existing directory unobservable (null), not "no manifest"', async () => {
    // A cleaned-up run worktree: ENOENT on package.json, but there is no tree
    // to lack one. A 'no-manifest' hash here would let a promotion stamp a
    // constant over a real stored input hash (markProven's `fresh`).
    expect(await computeVerifyInputHash(path.join(dir, 'gone'))).toBeNull();

    // ENOTDIR: the probe path runs through a regular file.
    const filePath = path.join(dir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    expect(await computeVerifyInputHash(path.join(filePath, 'nested'))).toBeNull();
    // …and the probe path IS a regular file.
    expect(await computeVerifyInputHash(filePath)).toBeNull();
  });

  it('frames each manifest by name — the same bytes under a different manifest hash differently', async () => {
    fs.writeFileSync(path.join(dir, 'Podfile.lock'), 'same\n');
    const asPodfile = await computeVerifyInputHash(dir);
    fs.rmSync(path.join(dir, 'Podfile.lock'));
    fs.writeFileSync(path.join(dir, 'Cargo.lock'), 'same\n');
    const asCargo = await computeVerifyInputHash(dir);

    expect(asPodfile).not.toBeNull();
    expect(asCargo).not.toBeNull();
    expect(asCargo).not.toBe(asPodfile);
  });

  it('an empty fallback manifest is distinct from none at all', async () => {
    const none = await computeVerifyInputHash(dir);
    fs.writeFileSync(path.join(dir, 'go.sum'), '');
    expect(await computeVerifyInputHash(dir)).not.toBe(none);
  });

  it('returns null when a fallback manifest EXISTS but cannot be read (EACCES) — never a skipped fold', async () => {
    if (process.getuid && process.getuid() === 0) return; // root reads 0-perm files
    const manifest = path.join(dir, 'project.yml');
    fs.writeFileSync(manifest, 'name: App\n');
    fs.chmodSync(manifest, 0o000);
    try {
      expect(await computeVerifyInputHash(dir)).toBeNull();
    } finally {
      fs.chmodSync(manifest, 0o644);
    }
  });
});

describe('probeHasPackageJson', () => {
  it('is true when package.json exists and false when it does not', async () => {
    expect(await probeHasPackageJson(dir)).toBe(false);
    writePkg({ dev: 'vite' });
    expect(await probeHasPackageJson(dir)).toBe(true);
  });

  it('answers false (never throws) for a path that does not exist', async () => {
    await expect(probeHasPackageJson(path.join(dir, 'does', 'not', 'exist'))).resolves.toBe(false);
  });

  it('answers TRUE (the conservative direction) when it cannot look — EACCES on the directory', async () => {
    if (process.getuid && process.getuid() === 0) return; // root traverses 0-perm dirs
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      await expect(probeHasPackageJson(locked)).resolves.toBe(true);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe('computeVerifyHostFingerprint', () => {
  it('carries the probed chromium path and the app exe path', async () => {
    const fp = JSON.parse(
      await computeVerifyHostFingerprint({
        probeChromium: async () => '/opt/chromium',
        appExePath: '/Applications/Cyboflow.app/Contents/MacOS/Cyboflow',
      }),
    ) as Record<string, unknown>;

    expect(fp.chromium).toBe('/opt/chromium');
    expect(fp.appPath).toBe('/Applications/Cyboflow.app/Contents/MacOS/Cyboflow');
    expect(fp.electronAbi).toBe(process.versions.modules);
    expect(fp.arch).toBe(process.arch);
  });

  it('degrades a throwing chromium probe to null instead of propagating', async () => {
    const fp = JSON.parse(
      await computeVerifyHostFingerprint({
        probeChromium: async () => {
          throw new Error('driver core exploded');
        },
        appExePath: '/exe',
      }),
    ) as Record<string, unknown>;

    expect(fp.chromium).toBeNull();
  });

  it('demotes when chromium moves, and is stable when it does not', async () => {
    const at = (p: string | null) => computeVerifyHostFingerprint({ probeChromium: async () => p, appExePath: '/exe' });

    expect(await at('/opt/chromium')).toBe(await at('/opt/chromium'));
    expect(await at('/opt/chromium')).not.toBe(await at(null));
  });
});
