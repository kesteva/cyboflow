/**
 * baselineStore tests — the fs home for git-tracked golden baselines.
 *
 * Exercised against a real os.tmpdir() project root (no Electron). Cases (per the
 * S5 testPlan):
 *   - write -> read -> list a baseline PNG by key+viewport
 *   - missing baseline -> read returns null (intent-only judging path)
 *   - key/viewport sanitization: a traversal-y key/viewport can NOT escape the
 *     baselines dir (the bytes land under .cyboflow/artifacts/baselines).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { FsBaselineStore, BASELINES_SUBDIR, safeStem } from '../baselineStore';

let projectRoot: string;
let store: FsBaselineStore;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'cvv-baseline-'));
  store = new FsBaselineStore();
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/** Write a tiny placeholder PNG-ish file at `p` (the store moves bytes, not images). */
async function seedFile(p: string, content = 'PNGBYTES'): Promise<void> {
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content, 'utf-8');
}

describe('FsBaselineStore', () => {
  it('writes, reads, and lists a baseline PNG by key + viewport', async () => {
    const src = join(projectRoot, 'run-artifacts', 'desktop.png');
    await seedFile(src);

    const dest = await store.write(projectRoot, 'home', 'desktop', src);
    // Landed under .cyboflow/artifacts/baselines/home/desktop.png.
    expect(dest).toBe(join(projectRoot, BASELINES_SUBDIR, 'home', 'desktop.png'));
    await expect(access(dest)).resolves.toBeUndefined();

    // read resolves the same absolute path when it exists.
    expect(await store.read(projectRoot, 'home', 'desktop')).toBe(dest);

    // list returns the accepted viewport stems for the key.
    await store.write(projectRoot, 'home', 'mobile', src);
    expect(await store.list(projectRoot, 'home')).toEqual(['desktop', 'mobile']);
  });

  it('returns null for a missing baseline (intent-only judging path)', async () => {
    expect(await store.read(projectRoot, 'never-accepted', 'desktop')).toBeNull();
    // list of a key with no baselines is empty, not a throw.
    expect(await store.list(projectRoot, 'never-accepted')).toEqual([]);
  });

  it('baselinePath is deterministic and under the baselines subtree', () => {
    const p = store.baselinePath(projectRoot, 'home', 'desktop');
    expect(p).toBe(join(projectRoot, BASELINES_SUBDIR, 'home', 'desktop.png'));
    const rel = relative(join(projectRoot, BASELINES_SUBDIR), p);
    expect(rel.startsWith('..')).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
  });

  it('SANITIZES a traversal-y key/viewport so it cannot escape the baselines dir', async () => {
    const src = join(projectRoot, 'art', 'shot.png');
    await seedFile(src);

    const dest = await store.write(projectRoot, '../../etc', '../../../secret', src);
    const baselinesRoot = join(projectRoot, BASELINES_SUBDIR);
    const rel = relative(baselinesRoot, dest);
    // The destination stays strictly INSIDE the baselines dir (no '..' segment).
    expect(rel.startsWith('..')).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(dest.startsWith(baselinesRoot)).toBe(true);
    // The separators were stripped (mirrors viewportFileStem), not interpreted.
    expect(dest).not.toContain('..');
  });

  it('safeStem strips separators + odd chars and falls back when empty', () => {
    expect(safeStem('home page!', 'fb')).toBe('home-page');
    expect(safeStem('../../etc', 'fb')).toBe('etc');
    expect(safeStem('', 'fb')).toBe('fb');
    expect(safeStem('///', 'fb')).toBe('fb');
    expect(safeStem('TASK_001-mobile', 'fb')).toBe('TASK_001-mobile');
  });

  it('metadata mirrors the BaselineMetadata shape (key + viewports + acceptedAt)', () => {
    const meta = store.metadata('home', [{ width: 1280, height: 800, label: 'desktop' }], 'looks good');
    expect(meta.key).toBe('home');
    expect(meta.viewports).toEqual([{ width: 1280, height: 800, label: 'desktop' }]);
    expect(meta.notes).toBe('looks good');
    expect(typeof meta.acceptedAt).toBe('string');
    expect(Number.isNaN(Date.parse(meta.acceptedAt))).toBe(false);
  });
});
