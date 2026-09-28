/**
 * LaneBuildSlots — per-concurrency-slot build directories for programmatic
 * fan-out lanes. The unit block drives fake deps; the real-git blocks prove the
 * production exclude writer covers a slot dir inside a LINKED worktree (sprint
 * worktrees are `git worktree add` worktrees, whose `info/exclude` resolves
 * through the common dir) so the commit-integrity probe never sees it as dirt,
 * and that the production git verification catches what the exclude cannot
 * (a `.gitignore` negation, files already tracked under the root).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
import { ensureGitExcludeEntries } from '../../../utils/gitExcludeWriter';
import { runGitExit } from '../../../utils/runGit';
import {
  LANE_BUILD_SLOTS_DIR,
  LANE_BUILD_SLOTS_EXCLUDE_ENTRY,
  LANE_BUILD_SLOTS_KILL_SWITCH_ENV,
  LANE_SCRATCH_DIR_ENV,
  LaneBuildSlots,
  laneBuildSlotsDisabled,
  stripInheritedLaneEnv,
  verifyLaneBuildSlotsIgnored,
  type GitExit,
  type LaneBuildSlotsDeps,
  type VerifyIgnoredResult,
} from '../laneBuildSlots';

const WORKTREE = path.resolve('/tmp/lane-slots-wt');

function fakeDeps(over: Partial<LaneBuildSlotsDeps> = {}) {
  const order: string[] = [];
  const ensureExcluded = vi.fn((worktreePath: string, entries: readonly string[]) => {
    order.push(`exclude:${worktreePath}:${entries.join(',')}`);
    return over.ensureExcluded ? over.ensureExcluded(worktreePath, entries) : true;
  });
  const verifyIgnored = vi.fn(async (worktreePath: string, root: string): Promise<VerifyIgnoredResult> => {
    order.push(`verify:${worktreePath}:${root}`);
    return over.verifyIgnored ? over.verifyIgnored(worktreePath, root) : { ok: true };
  });
  const mkdirp = vi.fn(async (dirPath: string) => {
    order.push(`mkdir:${dirPath}`);
    if (over.mkdirp) await over.mkdirp(dirPath);
  });
  return { order, ensureExcluded, verifyIgnored, mkdirp };
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

  it('writes the git exclude, then has git verify it, BEFORE creating any directory', async () => {
    const deps = fakeDeps();
    await new LaneBuildSlots(WORKTREE, deps).resolve(0);

    expect(deps.order).toEqual([
      `exclude:${WORKTREE}:${LANE_BUILD_SLOTS_EXCLUDE_ENTRY}`,
      `verify:${WORKTREE}:${LANE_BUILD_SLOTS_DIR}`,
      `mkdir:${path.join(WORKTREE, '.cyboflow', 'build-slots', 'slot-0')}`,
    ]);
    // Narrow on purpose: projects commit other .cyboflow/ files.
    expect(LANE_BUILD_SLOTS_EXCLUDE_ENTRY).toBe('/.cyboflow/build-slots/');
  });

  it('excludes and verifies once across many resolves and creates each slot dir once', async () => {
    const deps = fakeDeps();
    const slots = new LaneBuildSlots(WORKTREE, deps);

    await slots.resolve(0);
    await slots.resolve(1);
    await slots.resolve(0);
    await slots.resolve(1);
    await slots.resolve(2);

    expect(deps.ensureExcluded).toHaveBeenCalledTimes(1);
    expect(deps.verifyIgnored).toHaveBeenCalledTimes(1);
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
    expect(deps.verifyIgnored).not.toHaveBeenCalled();
    expect(deps.mkdirp).not.toHaveBeenCalled();
  });

  // ── git verification (the exclude is written, but does git honor it?) ──
  it('creates NO directory when git says the root is not ignored, for the rest of the run', async () => {
    const logger = makeSpyLogger();
    const deps = fakeDeps({ verifyIgnored: async () => ({ ok: false, reason: 'a .gitignore rule re-includes it' }) });
    const slots = new LaneBuildSlots(WORKTREE, deps, logger);

    expect(await slots.resolve(0)).toBeUndefined();
    expect(await slots.resolve(1)).toBeUndefined();
    expect(await slots.prepare()).toBe(false);

    expect(deps.mkdirp).not.toHaveBeenCalled();
    // Sticky: a negation / tracked file is a fact about the repo, not re-asked per lane step.
    expect(deps.verifyIgnored).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('treats a REJECTING verification (git could not run) as a failure', async () => {
    const deps = fakeDeps({
      verifyIgnored: async () => {
        throw new Error('spawn git ENOENT');
      },
    });
    const reasons: string[] = [];
    const slots = new LaneBuildSlots(WORKTREE, deps);
    slots.setUnavailableListener((reason) => reasons.push(reason));

    expect(await slots.resolve(0)).toBeUndefined();
    expect(deps.mkdirp).not.toHaveBeenCalled();
    expect(reasons).toEqual([`git could not confirm that ${LANE_BUILD_SLOTS_DIR}/ is ignored (spawn git ENOENT)`]);
  });

  it('shares one in-flight preparation between concurrent resolves (verification runs once, before any mkdir)', async () => {
    let release: (result: VerifyIgnoredResult) => void = () => undefined;
    const gate = new Promise<VerifyIgnoredResult>((resolve) => {
      release = resolve;
    });
    const deps = fakeDeps({ verifyIgnored: () => gate });
    const slots = new LaneBuildSlots(WORKTREE, deps);

    const pending = [slots.prepare(), slots.resolve(0), slots.resolve(1)];
    await Promise.resolve();
    expect(deps.mkdirp).not.toHaveBeenCalled();
    release({ ok: true });
    const [prepared, first, second] = await Promise.all(pending);

    expect(prepared).toBe(true);
    expect(first).toMatchObject({ slot: 0 });
    expect(second).toMatchObject({ slot: 1 });
    expect(deps.verifyIgnored).toHaveBeenCalledTimes(1);
  });

  // ── the once-per-run "unavailable" notice ──
  it('tells the listener about the FIRST failure only, whatever kind the later ones are', async () => {
    let excludeOk = false;
    const deps = fakeDeps({
      ensureExcluded: () => excludeOk,
      mkdirp: () => {
        throw new Error('EACCES');
      },
    });
    const reasons: string[] = [];
    const slots = new LaneBuildSlots(WORKTREE, deps);
    slots.setUnavailableListener((reason) => reasons.push(reason));

    expect(await slots.prepare()).toBe(false); // exclude write fails
    expect(await slots.resolve(0)).toBeUndefined(); // …and again
    excludeOk = true;
    expect(await slots.resolve(0)).toBeUndefined(); // exclude recovers, mkdir fails
    expect(await slots.resolve(1)).toBeUndefined(); // another mkdir failure

    expect(reasons).toEqual([
      `could not write the git exclude entry \`${LANE_BUILD_SLOTS_EXCLUDE_ENTRY}\` for this worktree`,
    ]);
  });

  it('reports a mkdir failure when it is the first failure', async () => {
    const deps = fakeDeps({
      mkdirp: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    const reasons: string[] = [];
    const slots = new LaneBuildSlots(WORKTREE, deps);
    slots.setUnavailableListener((reason) => reasons.push(reason));

    expect(await slots.prepare()).toBe(true); // the root is fine…
    expect(await slots.resolve(2)).toBeUndefined(); // …the slot dir is not

    expect(reasons).toEqual([
      `could not create ${path.join(WORKTREE, '.cyboflow', 'build-slots', 'slot-2')} (EACCES: permission denied)`,
    ]);
  });

  it('delivers a failure that happened before a listener subscribed, exactly once', async () => {
    const deps = fakeDeps({ verifyIgnored: async () => ({ ok: false, reason: 'tracked files' }) });
    const slots = new LaneBuildSlots(WORKTREE, deps);
    expect(await slots.prepare()).toBe(false);

    const listener = vi.fn();
    slots.setUnavailableListener(listener);
    await slots.resolve(0);
    slots.setUnavailableListener(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('tracked files');
  });

  it('never notifies when everything succeeds, and survives a throwing listener', async () => {
    const quiet = vi.fn();
    const ok = new LaneBuildSlots(WORKTREE, fakeDeps());
    ok.setUnavailableListener(quiet);
    await ok.prepare();
    await ok.resolve(0);
    expect(quiet).not.toHaveBeenCalled();

    const logger = makeSpyLogger();
    const failing = new LaneBuildSlots(WORKTREE, fakeDeps({ ensureExcluded: () => false }), logger);
    failing.setUnavailableListener(() => {
      throw new Error('listener exploded');
    });
    expect(await failing.resolve(0)).toBeUndefined();
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

/**
 * A temp repo with one commit plus a LINKED worktree of it (how sprint
 * worktrees are made), `prepareMain` running in the main checkout before the
 * commit so it can seed a .gitignore or a tracked file.
 */
async function withLinkedWorktree(
  prefix: string,
  fn: (worktreePath: string) => Promise<void>,
  prepareMain?: (mainRepo: string) => void,
): Promise<void> {
  await withTempDir(prefix, async (root) => {
    const mainRepo = path.join(root, 'repo');
    fs.mkdirSync(mainRepo);
    git(['init', '-q'], mainRepo);
    fs.writeFileSync(path.join(mainRepo, 'README.md'), 'hello\n', 'utf8');
    git(['add', 'README.md'], mainRepo);
    prepareMain?.(mainRepo);
    git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], mainRepo);

    // A space in the path, as real project paths often have.
    const worktreePath = path.join(root, 'sprint wt');
    git(['worktree', 'add', '-q', '-b', 'sprint-branch', worktreePath], mainRepo);
    await fn(worktreePath);
  });
}

/** The PRODUCTION git runner for the verification, as DefaultProgrammaticRunner wires it. */
const productionGit = (cwd: string, args: string[]): Promise<GitExit> => runGitExit(cwd, args);

/** PRODUCTION deps, exactly as DefaultProgrammaticRunner wires them. */
function productionDeps(): LaneBuildSlotsDeps {
  return {
    ensureExcluded: (wt, entries) => ensureGitExcludeEntries(wt, entries) !== null,
    verifyIgnored: (wt, root) => verifyLaneBuildSlotsIgnored(wt, root, productionGit),
    mkdirp: async (dirPath) => {
      await fs.promises.mkdir(dirPath, { recursive: true });
    },
  };
}

describe('LaneBuildSlots — real git, linked worktree', () => {
  it(
    'git-excludes the slot dir in a linked worktree so git status never lists its contents',
    async () => {
      await withLinkedWorktree('lane-build-slots-', async (worktreePath) => {
        const slots = new LaneBuildSlots(worktreePath, productionDeps());
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

  it(
    'verification passes once the exclude is written — and the probe path is NOT vacuous',
    async () => {
      await withLinkedWorktree('lane-build-slots-verify-', async (worktreePath) => {
        // Before the exclude exists git does NOT ignore the probe path, so a
        // pass below is the exclude's doing, not a check that always says yes.
        expect(await verifyLaneBuildSlotsIgnored(worktreePath, LANE_BUILD_SLOTS_DIR, productionGit)).toEqual({
          ok: false,
          reason: expect.stringContaining('git does not ignore .cyboflow/build-slots/'),
        });

        expect(ensureGitExcludeEntries(worktreePath, [LANE_BUILD_SLOTS_EXCLUDE_ENTRY])).not.toBeNull();
        // The root directory does not exist yet: the probe form must still match.
        expect(fs.existsSync(path.join(worktreePath, '.cyboflow'))).toBe(false);
        expect(await verifyLaneBuildSlotsIgnored(worktreePath, LANE_BUILD_SLOTS_DIR, productionGit)).toEqual({
          ok: true,
        });
        // Why the probe is the root WITH a trailing slash: the directory-only
        // rule does not match the bare root while it does not exist (exit 1),
        // but does match it asked as a directory (exit 0).
        const bareRoot = await runGitExit(worktreePath, ['check-ignore', '-q', '--', LANE_BUILD_SLOTS_DIR]);
        expect(bareRoot.exitCode).toBe(1);
        const probe = await runGitExit(worktreePath, ['check-ignore', '-q', '--', `${LANE_BUILD_SLOTS_DIR}/`]);
        expect(probe.exitCode).toBe(0);
      });
    },
    60_000,
  );

  it(
    'creates NO slot dir when the root is re-included even though a rule ignores dotfiles inside it',
    async () => {
      await withLinkedWorktree(
        'lane-build-slots-dotmask-',
        async (worktreePath) => {
          const slots = new LaneBuildSlots(worktreePath, productionDeps());
          expect(await slots.prepare()).toBe(false);
          expect(fs.existsSync(path.join(worktreePath, '.cyboflow', 'build-slots'))).toBe(false);

          // The trap a LEAF probe falls into: `.*` ignores a dotfile leaf, so it
          // reads as ignored — while the root itself is re-included and git
          // status would list every slot file.
          const leaf = await runGitExit(worktreePath, [
            'check-ignore',
            '-q',
            '--',
            `${LANE_BUILD_SLOTS_DIR}/slot-0/.probe`,
          ]);
          expect(leaf.exitCode).toBe(0);
          fs.mkdirSync(path.join(worktreePath, LANE_BUILD_SLOTS_DIR, 'slot-0'), { recursive: true });
          fs.writeFileSync(path.join(worktreePath, LANE_BUILD_SLOTS_DIR, 'slot-0', 'a.o'), 'x', 'utf8');
          expect(porcelain(worktreePath)).toContain('?? .cyboflow/build-slots/slot-0/a.o');
        },
        (mainRepo) => {
          fs.writeFileSync(
            path.join(mainRepo, '.gitignore'),
            '!/.cyboflow/build-slots/\n.*\n!/.cyboflow/\n!.gitignore\n',
            'utf8',
          );
          git(['add', '.gitignore'], mainRepo);
        },
      );
    },
    60_000,
  );

  for (const negation of ['!/.cyboflow/build-slots/', '!.cyboflow/build-slots/']) {
    it(
      `creates NO slot dir when a .gitignore negation (${negation}) re-includes the root`,
      async () => {
        await withLinkedWorktree(
          'lane-build-slots-negation-',
          async (worktreePath) => {
            const reasons: string[] = [];
            const slots = new LaneBuildSlots(worktreePath, productionDeps());
            slots.setUnavailableListener((reason) => reasons.push(reason));

            expect(await slots.prepare()).toBe(false);
            expect(await slots.resolve(0)).toBeUndefined();

            expect(fs.existsSync(path.join(worktreePath, '.cyboflow', 'build-slots'))).toBe(false);
            expect(reasons).toHaveLength(1);
            expect(reasons[0]).toContain('a .gitignore rule re-includes it');
          },
          (mainRepo) => {
            fs.writeFileSync(path.join(mainRepo, '.gitignore'), `${negation}\n`, 'utf8');
            git(['add', '.gitignore'], mainRepo);
          },
        );
      },
      60_000,
    );
  }

  it(
    'creates NO slot dir when files under the root are already tracked',
    async () => {
      await withLinkedWorktree(
        'lane-build-slots-tracked-',
        async (worktreePath) => {
          const reasons: string[] = [];
          const slots = new LaneBuildSlots(worktreePath, productionDeps());
          slots.setUnavailableListener((reason) => reasons.push(reason));

          expect(await slots.resolve(0)).toBeUndefined();

          expect(fs.existsSync(path.join(worktreePath, '.cyboflow', 'build-slots', 'slot-0'))).toBe(false);
          expect(reasons).toEqual([
            'files under .cyboflow/build-slots/ are already tracked by git (.cyboflow/build-slots/old/output.o), so git will not ignore them',
          ]);
        },
        (mainRepo) => {
          const dir = path.join(mainRepo, '.cyboflow', 'build-slots', 'old');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'output.o'), 'x', 'utf8');
          git(['add', '-f', '.cyboflow/build-slots/old/output.o'], mainRepo);
        },
      );
    },
    60_000,
  );

  it('reports a git that fails outright (not a repository) as a failure, not a pass', async () => {
    await withTempDir('lane-build-slots-norepo-', async (dir) => {
      const result = await verifyLaneBuildSlotsIgnored(dir, LANE_BUILD_SLOTS_DIR, (cwd, args) =>
        runGitExit(cwd, args, { env: { GIT_CEILING_DIRECTORIES: path.dirname(dir) } }),
      );
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('`git ls-files` failed (exit 128)') });
    });
  });
});
