/**
 * LaneBuildSlots — per-concurrency-slot build directories for programmatic
 * fan-out lanes. The unit block drives fake deps; the real-git block proves the
 * production exclude writer covers a slot dir inside a LINKED worktree (sprint
 * worktrees are `git worktree add` worktrees, whose `info/exclude` resolves
 * through the common dir) so the commit-integrity probe never sees it as dirt.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
import { ensureGitExcludeEntries } from '../../../utils/gitExcludeWriter';
import {
  LANE_BUILD_SLOTS_EXCLUDE_ENTRY,
  LANE_BUILD_SLOTS_KILL_SWITCH_ENV,
  LANE_SCRATCH_DIR_ENV,
  LaneBuildSlots,
  laneBuildSlotsDisabled,
  stripInheritedLaneEnv,
  type LaneBuildSlotsDeps,
} from '../laneBuildSlots';

const WORKTREE = path.resolve('/tmp/lane-slots-wt');

function fakeDeps(over: Partial<LaneBuildSlotsDeps> = {}) {
  const order: string[] = [];
  const ensureExcluded = vi.fn((worktreePath: string, entries: readonly string[]) => {
    order.push(`exclude:${worktreePath}:${entries.join(',')}`);
    return over.ensureExcluded ? over.ensureExcluded(worktreePath, entries) : true;
  });
  const mkdirp = vi.fn(async (dirPath: string) => {
    order.push(`mkdir:${dirPath}`);
    if (over.mkdirp) await over.mkdirp(dirPath);
  });
  return { order, ensureExcluded, mkdirp };
}

describe('LaneBuildSlots', () => {
  const savedKillSwitch = process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV];
  afterEach(() => {
    if (savedKillSwitch === undefined) delete process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV];
    else process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV] = savedKillSwitch;
  });

  it('resolves an absolute slot dir under .cyboflow/build-slots with the scratch + module-cache env', async () => {
    const deps = fakeDeps();
    const scratch = await new LaneBuildSlots(WORKTREE, deps).resolve(2);

    const dir = path.join(WORKTREE, '.cyboflow', 'build-slots', 'slot-2');
    expect(scratch).toEqual({
      slot: 2,
      dir,
      env: {
        [LANE_SCRATCH_DIR_ENV]: dir,
        CLANG_MODULE_CACHE_PATH: path.join(dir, 'clang-module-cache'),
        SWIFTPM_MODULECACHE_OVERRIDE: path.join(dir, 'clang-module-cache'),
      },
    });
    expect(path.isAbsolute(scratch!.dir)).toBe(true);
    expect(LANE_SCRATCH_DIR_ENV).toBe('CYBOFLOW_LANE_SCRATCH_DIR');
    // Codex's shell env policy drops names containing these words.
    expect(LANE_SCRATCH_DIR_ENV).not.toMatch(/KEY|SECRET|TOKEN/);
  });

  it('makes a relative worktree path absolute', async () => {
    const scratch = await new LaneBuildSlots('relative/wt', fakeDeps()).resolve(0);
    expect(path.isAbsolute(scratch!.dir)).toBe(true);
    expect(scratch!.dir).toBe(path.resolve('relative/wt', '.cyboflow', 'build-slots', 'slot-0'));
  });

  it('writes the git exclude BEFORE creating any directory, with the anchored build-slots entry', async () => {
    const deps = fakeDeps();
    await new LaneBuildSlots(WORKTREE, deps).resolve(0);

    expect(deps.order).toEqual([
      `exclude:${WORKTREE}:${LANE_BUILD_SLOTS_EXCLUDE_ENTRY}`,
      `mkdir:${path.join(WORKTREE, '.cyboflow', 'build-slots', 'slot-0')}`,
    ]);
    // Narrow on purpose: projects commit other .cyboflow/ files.
    expect(LANE_BUILD_SLOTS_EXCLUDE_ENTRY).toBe('/.cyboflow/build-slots/');
  });

  it('excludes once across many resolves and creates each slot dir once', async () => {
    const deps = fakeDeps();
    const slots = new LaneBuildSlots(WORKTREE, deps);

    await slots.resolve(0);
    await slots.resolve(1);
    await slots.resolve(0);
    await slots.resolve(1);
    await slots.resolve(2);

    expect(deps.ensureExcluded).toHaveBeenCalledTimes(1);
    expect(deps.mkdirp).toHaveBeenCalledTimes(3);
    expect(deps.mkdirp.mock.calls.map((c) => path.basename(String(c[0])))).toEqual(['slot-0', 'slot-1', 'slot-2']);
  });

  it('returns undefined and creates NO directory when the exclude cannot be written; logs the failure once', async () => {
    const logger = makeSpyLogger();
    const deps = fakeDeps({ ensureExcluded: () => false });
    const slots = new LaneBuildSlots(WORKTREE, deps, logger);

    expect(await slots.resolve(0)).toBeUndefined();
    expect(await slots.resolve(1)).toBeUndefined();

    expect(deps.mkdirp).not.toHaveBeenCalled();
    expect(deps.ensureExcluded).toHaveBeenCalledTimes(2); // a failure is retried, a success is not
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('treats a THROWING exclude writer as a failure (undefined, no directory)', async () => {
    const deps = fakeDeps({
      ensureExcluded: () => {
        throw new Error('git exploded');
      },
    });
    expect(await new LaneBuildSlots(WORKTREE, deps).resolve(0)).toBeUndefined();
    expect(deps.mkdirp).not.toHaveBeenCalled();
  });

  it('recovers on a later resolve once the exclude succeeds', async () => {
    let ok = false;
    const deps = fakeDeps({ ensureExcluded: () => ok });
    const slots = new LaneBuildSlots(WORKTREE, deps);

    expect(await slots.resolve(0)).toBeUndefined();
    ok = true;
    expect(await slots.resolve(0)).toMatchObject({ slot: 0 });
    expect(deps.mkdirp).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when mkdir fails, and retries the mkdir on the next resolve', async () => {
    const logger = makeSpyLogger();
    let fail = true;
    const deps = fakeDeps({
      mkdirp: () => {
        if (fail) throw new Error('EACCES');
      },
    });
    const slots = new LaneBuildSlots(WORKTREE, deps, logger);

    expect(await slots.resolve(0)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    fail = false;
    expect(await slots.resolve(0)).toMatchObject({ slot: 0 });
    expect(deps.mkdirp).toHaveBeenCalledTimes(2);
  });

  it('rejects a slot that is not a non-negative integer without touching git or disk', async () => {
    const deps = fakeDeps();
    const slots = new LaneBuildSlots(WORKTREE, deps);
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(await slots.resolve(bad)).toBeUndefined();
    }
    expect(deps.ensureExcluded).not.toHaveBeenCalled();
    expect(deps.mkdirp).not.toHaveBeenCalled();
  });

  it('laneBuildSlotsDisabled is true only for the exact value "1"', () => {
    delete process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV];
    expect(laneBuildSlotsDisabled()).toBe(false);
    process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV] = 'true';
    expect(laneBuildSlotsDisabled()).toBe(false);
    process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV] = '1';
    expect(laneBuildSlotsDisabled()).toBe(true);
    expect(LANE_BUILD_SLOTS_KILL_SWITCH_ENV).toBe('CYBOFLOW_DISABLE_LANE_BUILD_SLOTS');
  });
});

// ── boot-time strip of a slot env INHERITED from a hosting lane (index.ts) ──
describe('stripInheritedLaneEnv', () => {
  it("removes an inherited slot's scratch var and the module-cache overrides that point into it", async () => {
    // The exact env a lane agent's shell carries — so the strip stays in step
    // with what resolve() sets.
    const scratch = await new LaneBuildSlots(WORKTREE, fakeDeps()).resolve(3);
    const env: NodeJS.ProcessEnv = { ...scratch!.env, PATH: '/usr/bin', OTHER: 'kept' };

    stripInheritedLaneEnv(env);

    expect(env).toEqual({ PATH: '/usr/bin', OTHER: 'kept' });
  });

  it("keeps a user's own module-cache setting that does not point into the inherited slot", () => {
    const dir = path.join(WORKTREE, '.cyboflow', 'build-slots', 'slot-0');
    const env: NodeJS.ProcessEnv = {
      [LANE_SCRATCH_DIR_ENV]: dir,
      CLANG_MODULE_CACHE_PATH: '/Users/me/.clang-cache',
      // A sibling path that merely shares the prefix string is not inside the slot.
      SWIFTPM_MODULECACHE_OVERRIDE: `${dir}-other/cache`,
    };

    stripInheritedLaneEnv(env);

    expect(env).toEqual({
      CLANG_MODULE_CACHE_PATH: '/Users/me/.clang-cache',
      SWIFTPM_MODULECACHE_OVERRIDE: `${dir}-other/cache`,
    });
  });

  it('leaves the env untouched when no slot was inherited', () => {
    const env: NodeJS.ProcessEnv = { CLANG_MODULE_CACHE_PATH: '/Users/me/.clang-cache', PATH: '/usr/bin' };
    stripInheritedLaneEnv(env);
    expect(env).toEqual({ CLANG_MODULE_CACHE_PATH: '/Users/me/.clang-cache', PATH: '/usr/bin' });
  });

  it('drops an empty inherited scratch var without touching anything else', () => {
    const env: NodeJS.ProcessEnv = { [LANE_SCRATCH_DIR_ENV]: '', CLANG_MODULE_CACHE_PATH: '/c' };
    stripInheritedLaneEnv(env);
    expect(env).toEqual({ CLANG_MODULE_CACHE_PATH: '/c' });
  });
});

// ── real git: a slot dir inside a LINKED worktree is invisible to git status ──
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** The commit-integrity probe's own read (index.ts beginCommitProbe). */
function porcelain(cwd: string): string[] {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  })
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('LaneBuildSlots — real git, linked worktree', () => {
  it(
    'git-excludes the slot dir in a linked worktree so git status never lists its contents',
    async () => {
      await withTempDir('lane-build-slots-', async (root) => {
        const mainRepo = path.join(root, 'repo');
        fs.mkdirSync(mainRepo);
        git(['init', '-q'], mainRepo);
        fs.writeFileSync(path.join(mainRepo, 'README.md'), 'hello\n', 'utf8');
        git(['add', 'README.md'], mainRepo);
        git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], mainRepo);

        const worktreePath = path.join(root, 'wt');
        git(['worktree', 'add', '-q', '-b', 'sprint-branch', worktreePath], mainRepo);

        // PRODUCTION deps, exactly as DefaultProgrammaticRunner wires them.
        const slots = new LaneBuildSlots(worktreePath, {
          ensureExcluded: (wt, entries) => ensureGitExcludeEntries(wt, entries) !== null,
          mkdirp: async (dirPath) => {
            await fs.promises.mkdir(dirPath, { recursive: true });
          },
        });
        const scratch = await slots.resolve(0);
        expect(scratch).toBeDefined();
        expect(fs.statSync(scratch!.dir).isDirectory()).toBe(true);

        // A build writes deep into the slot…
        const derived = path.join(scratch!.dir, 'DerivedData', 'Build', 'Intermediates.noindex', 'XCBuildData');
        fs.mkdirSync(derived, { recursive: true });
        fs.writeFileSync(path.join(derived, 'build.db'), 'x', 'utf8');
        // …next to an ordinary untracked file and another .cyboflow/ file a
        // project may legitimately commit (the exclude must stay narrow).
        fs.writeFileSync(path.join(worktreePath, 'new-file.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(worktreePath, '.cyboflow', 'verify-runbook.json'), '{}\n', 'utf8');

        const dirty = porcelain(worktreePath);
        expect(dirty).toContain('?? new-file.ts');
        expect(dirty).toContain('?? .cyboflow/verify-runbook.json');
        expect(dirty.some((line) => line.includes('build-slots'))).toBe(false);

        // Idempotent: a second instance (a later walk) adds nothing new.
        expect(ensureGitExcludeEntries(worktreePath, [LANE_BUILD_SLOTS_EXCLUDE_ENTRY])).toEqual({ added: [] });
      });
    },
    60_000,
  );
});
