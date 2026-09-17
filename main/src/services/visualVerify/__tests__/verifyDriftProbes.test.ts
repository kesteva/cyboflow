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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeVerifyInputHash, computeVerifyHostFingerprint } from '../verifyDriftProbes';

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

  it('returns null — not a hash — when package.json is missing or unparseable', async () => {
    expect(await computeVerifyInputHash(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    expect(await computeVerifyInputHash(dir)).toBeNull();
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
