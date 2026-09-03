/**
 * Tests for ompGatePath — where the spawner finds the gating extension.
 *
 * Two behaviours are worth locking down, both of them measured against the real
 * `omp` binary rather than reasoned about (see ompGatePath.ts's header):
 *
 *  1. The asset is the TypeScript SOURCE. OMP rejected tsc's CommonJS output
 *     ("Extension does not export a valid factory function") and accepted the
 *     .ts file. A future "let's ship the compiled artifact like everything
 *     else" cleanup would break the gate silently, so the extension is asserted.
 *  2. A path that does not exist is REFUSED. OMP starts a session even when an
 *     extension fails to load (loader.ts:437-443), so returning an absent path
 *     would produce an UNGATED session instead of an error.
 *
 * The packaged arm additionally has two halves that must agree — this resolver
 * and the `build.extraResources` entry in the repo-root package.json — so the
 * last describe block reads the real package.json and asserts the pair.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  OMP_GATE_EXTENSION_FILENAME,
  PACKAGED_GATE_EXTENSION_REL,
  PACKAGED_GATE_EXTENSION_SOURCE,
  resolveOmpGateExtensionPath,
  toSourceDir,
} from '../ompGatePath';

describe('toSourceDir', () => {
  // Paths are assembled with path.join so the segment separators match the
  // platform the module under test computes its dist/src segments on.
  it('maps a compiled dev directory back to the source tree', () => {
    expect(
      toSourceDir(path.join('/repo', 'main', 'dist', 'main', 'src', 'services', 'panels', 'omp', 'gate')),
    ).toBe(path.join('/repo', 'main', 'src', 'services', 'panels', 'omp', 'gate'));
  });

  it('leaves a path that is already source alone (the vitest case)', () => {
    expect(toSourceDir(path.join('/repo', 'main', 'src', 'services', 'panels', 'omp', 'gate'))).toBe(
      path.join('/repo', 'main', 'src', 'services', 'panels', 'omp', 'gate'),
    );
  });

  it('rewrites the LAST occurrence, so a repo path containing main/dist is safe', () => {
    expect(
      toSourceDir(
        path.join(
          '/main/dist/main/src/x',
          'main', 'dist', 'main', 'src', 'services', 'panels', 'omp', 'gate',
        ),
      ),
    ).toBe(path.join('/main/dist/main/src/x', 'main', 'src', 'services', 'panels', 'omp', 'gate'));
  });
});

describe('resolveOmpGateExtensionPath', () => {
  it('resolves the source file from a compiled dev directory', () => {
    const resolved = resolveOmpGateExtensionPath({
      isPackaged: false,
      dirname: path.join('/repo', 'main', 'dist', 'main', 'src', 'services', 'panels', 'omp', 'gate'),
    });

    expect(resolved).toBe(
      path.join('/repo', 'main', 'src', 'services', 'panels', 'omp', 'gate', OMP_GATE_EXTENSION_FILENAME),
    );
  });

  it('resolves next to this module when it is already running from source', () => {
    const resolved = resolveOmpGateExtensionPath({
      isPackaged: false,
      dirname: path.join('/repo', 'main', 'src', 'services', 'panels', 'omp', 'gate'),
    });

    expect(resolved).toBe(
      path.join('/repo', 'main', 'src', 'services', 'panels', 'omp', 'gate', OMP_GATE_EXTENSION_FILENAME),
    );
  });

  it('defaults the directory to this module’s own location', () => {
    const resolved = resolveOmpGateExtensionPath({ isPackaged: false });

    expect(path.basename(resolved)).toBe(OMP_GATE_EXTENSION_FILENAME);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('ships the TypeScript source — the compiled .js is NOT loadable by OMP', () => {
    expect(OMP_GATE_EXTENSION_FILENAME).toBe('ompGateExtension.ts');
  });

  it('points at a file that actually exists in this checkout', async () => {
    // The dev path is the one `pnpm dev` uses; a rename that broke it would
    // otherwise only surface when someone started an OMP session.
    const fs = await import('node:fs');
    expect(fs.existsSync(resolveOmpGateExtensionPath({ isPackaged: false }))).toBe(true);
  });

  it('resolves the extraResources copy when packaged and the file shipped', () => {
    const resourcesPath = '/Applications/Cyboflow.app/Contents/Resources';
    const expected = path.join(resourcesPath, 'omp-gate', OMP_GATE_EXTENSION_FILENAME);

    const seen: string[] = [];
    const resolved = resolveOmpGateExtensionPath({
      isPackaged: true,
      resourcesPath,
      existsSync: (p) => {
        seen.push(p);
        return p === expected;
      },
    });

    expect(resolved).toBe(expected);
    // The dev branch's source-tree mapping must NOT be applied to a packaged
    // path — that is what would send `omp -e` at a main/src path off the bundle.
    expect(seen).toEqual([expected]);
  });

  it('throws when packaged and the file is ABSENT, naming the extraResources entry', () => {
    let thrown: unknown;
    try {
      resolveOmpGateExtensionPath({
        isPackaged: true,
        resourcesPath: '/Applications/Cyboflow.app/Contents/Resources',
        existsSync: () => false,
      });
    } catch (err) {
      thrown = err;
    }

    const message = (thrown as Error | undefined)?.message ?? '';
    expect(message).toMatch(/extraResources/);
    // Both halves of the contract are named, so the reader can fix it without
    // going looking for which config key is missing.
    expect(message).toContain(PACKAGED_GATE_EXTENSION_SOURCE);
    expect(message).toContain(PACKAGED_GATE_EXTENSION_REL);
    expect(message).toMatch(/does not exist/);
  });

  it('throws when packaged with no resourcesPath at all', () => {
    expect(() => resolveOmpGateExtensionPath({ isPackaged: true })).toThrow(
      /process\.resourcesPath is unavailable/,
    );
  });

  it('refuses to spawn rather than degrade when packaged', () => {
    expect(() => resolveOmpGateExtensionPath({ isPackaged: true })).toThrow(
      /Refusing to spawn OMP without/i,
    );
  });

  it('an existsSync that THROWS is treated as absent, never as present', () => {
    expect(() =>
      resolveOmpGateExtensionPath({
        isPackaged: true,
        resourcesPath: '/Applications/Cyboflow.app/Contents/Resources',
        existsSync: () => {
          throw new Error('EACCES');
        },
      }),
    ).toThrow(/Refusing to spawn OMP without/i);
  });
});

/**
 * The packaged arm is a two-sided contract: this resolver reads
 * `<resources>/omp-gate/ompGateExtension.ts`, and only the `build.extraResources`
 * entry in the repo-root package.json puts a file there. Either side moving
 * alone produces a packaged build that refuses to spawn OMP — a failure that
 * would otherwise surface only in a signed DMG, so assert the pair here.
 */
describe('build.extraResources ↔ resolver agreement', () => {
  interface ExtraResourceEntry {
    from?: string;
    to?: string;
  }
  interface RootPackageJson {
    build?: { extraResources?: ExtraResourceEntry[] };
  }

  function readRootPackageJson(): RootPackageJson {
    // __dirname is main/src/services/panels/omp/gate/__tests__ under vitest and
    // main/dist/... when compiled; walk up to the repo root by looking for the
    // package.json that carries the electron-builder config.
    let dir = __dirname;
    for (let hop = 0; hop < 12; hop += 1) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as RootPackageJson;
        if (parsed.build !== undefined) return parsed;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error('could not locate the repo-root package.json carrying the electron-builder build config');
  }

  it('ships the gate extension to exactly the path the resolver reads', () => {
    const entries = readRootPackageJson().build?.extraResources ?? [];
    const gateEntry = entries.find((e) => e.to === PACKAGED_GATE_EXTENSION_REL);

    expect(gateEntry, `no extraResources entry with to: "${PACKAGED_GATE_EXTENSION_REL}"`).toBeDefined();
    expect(gateEntry?.from).toBe(PACKAGED_GATE_EXTENSION_SOURCE);
  });

  it('copies a file that exists in this checkout', () => {
    const { from } = readRootPackageJson().build?.extraResources?.find(
      (e) => e.to === PACKAGED_GATE_EXTENSION_REL,
    ) ?? {};
    let repoRoot = __dirname;
    while (!fs.existsSync(path.join(repoRoot, 'pnpm-workspace.yaml')) && path.dirname(repoRoot) !== repoRoot) {
      repoRoot = path.dirname(repoRoot);
    }

    expect(from).toBeDefined();
    expect(fs.existsSync(path.join(repoRoot, from ?? ''))).toBe(true);
  });
});
