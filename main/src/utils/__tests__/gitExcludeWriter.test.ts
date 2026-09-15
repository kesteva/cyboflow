/**
 * Unit tests for gitExcludeWriter — the shared "idempotently append lines to
 * a repo/worktree's LOCAL git exclude" writer that replaces three
 * near-duplicate copies (workflowBundleInstall, interactiveClaudeManager,
 * ompMcpConfigWriter) and the two .gitignore writers (ipc/project.ts,
 * RunLauncher). Real `git init`/`git worktree add` temp repos — 60s per test,
 * since real git subprocess spawns can be slow under load
 * (feedback_worktree_test_runner_landmines).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { makeSpyLogger } from '../../orchestrator/__test_fixtures__/loggerLikeSpy';
import { ensureGitExcludeEntries, isNotAGitRepositoryError } from '../gitExcludeWriter';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** Resolve the SAME path the writer itself resolves, so tests never hardcode
 *  git's internal layout (plain repo vs. linked worktree differ). */
function resolveExcludePath(repoPath: string): string {
  const raw = git(['rev-parse', '--git-path', 'info/exclude'], repoPath);
  return path.isAbsolute(raw) ? raw : path.join(repoPath, raw);
}

describe('ensureGitExcludeEntries', () => {
  it(
    'creates info/exclude in a fresh repo and reports the added entry',
    async () => {
      await withTempDir('git-exclude-fresh-', async (repo) => {
        git(['init', '-q'], repo);

        const result = ensureGitExcludeEntries(repo, ['.cyboflow/']);

        expect(result).toEqual({ added: ['.cyboflow/'] });
        const contents = fs.readFileSync(resolveExcludePath(repo), 'utf8');
        expect(contents.split('\n').map((l) => l.trim())).toContain('.cyboflow/');
      });
    },
    60_000,
  );

  it(
    'is idempotent across leading/trailing-slash forms — /x/, x/ and x all match',
    async () => {
      await withTempDir('git-exclude-idempotent-', async (repo) => {
        git(['init', '-q'], repo);

        const first = ensureGitExcludeEntries(repo, ['x/']);
        expect(first).toEqual({ added: ['x/'] });

        // Re-adding the SAME logical entry in different slash forms is a no-op.
        for (const form of ['x', '/x/', '/x']) {
          const result = ensureGitExcludeEntries(repo, [form]);
          expect(result).toEqual({ added: [] });
        }

        const contents = fs.readFileSync(resolveExcludePath(repo), 'utf8');
        expect(contents.split('\n').filter((l) => l.trim() === 'x/')).toHaveLength(1);
      });
    },
    60_000,
  );

  it(
    'writes the marker once, even across multiple calls that each add something new',
    async () => {
      await withTempDir('git-exclude-marker-', async (repo) => {
        git(['init', '-q'], repo);
        const marker = '# cyboflow: generated';

        ensureGitExcludeEntries(repo, ['a/'], { marker });
        ensureGitExcludeEntries(repo, ['b/'], { marker });

        const contents = fs.readFileSync(resolveExcludePath(repo), 'utf8');
        const count = (needle: string) => contents.split(needle).length - 1;
        expect(count(marker)).toBe(1);
        expect(contents).toContain('a/');
        expect(contents).toContain('b/');
      });
    },
    60_000,
  );

  it(
    'a linked worktree writes to whatever path git itself reports for --git-path info/exclude',
    async () => {
      await withTempDir('git-exclude-worktree-', async (mainRepo) => {
        git(['init', '-q'], mainRepo);
        fs.writeFileSync(path.join(mainRepo, 'README.md'), 'hello\n', 'utf8');
        git(['add', 'README.md'], mainRepo);
        git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], mainRepo);

        const worktreePath = path.join(path.dirname(mainRepo), `${path.basename(mainRepo)}-wt`);
        git(['worktree', 'add', '-q', '-b', 'wt-branch', worktreePath], mainRepo);
        try {
          const result = ensureGitExcludeEntries(worktreePath, ['.cyboflow/']);
          expect(result).toEqual({ added: ['.cyboflow/'] });

          // Whatever file `git rev-parse --git-path info/exclude` names FROM
          // the worktree is the one that must carry the entry — no assumption
          // about common-dir vs. per-worktree layout.
          const contents = fs.readFileSync(resolveExcludePath(worktreePath), 'utf8');
          expect(contents.split('\n').map((l) => l.trim())).toContain('.cyboflow/');
        } finally {
          git(['worktree', 'remove', '--force', worktreePath], mainRepo);
        }
      });
    },
    60_000,
  );

  it(
    'a non-repo directory returns null and writes no .gitignore anywhere',
    async () => {
      await withTempDir('git-exclude-nonrepo-', async (dir) => {
        const logger = makeSpyLogger();

        const result = ensureGitExcludeEntries(dir, ['.cyboflow/'], { logger, label: 'Test' });

        expect(result).toBeNull();
        expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
        expect(logger.warn).not.toHaveBeenCalled();
        const skipped = logger.calls.some(
          (c) => c.level === 'debug' && c.message.includes('skipped git exclude'),
        );
        expect(skipped).toBe(true);
      });
    },
    60_000,
  );

  it('returns { added: [] } and touches nothing for an empty entries list', async () => {
    await withTempDir('git-exclude-empty-', async (repo) => {
      git(['init', '-q'], repo);
      // `git init` itself seeds info/exclude with its own placeholder comment —
      // capture that baseline so the assertion is "unchanged", not "absent".
      const excludePath = resolveExcludePath(repo);
      const before = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : null;

      const result = ensureGitExcludeEntries(repo, []);

      expect(result).toEqual({ added: [] });
      const after = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : null;
      expect(after).toBe(before);
    });
  });
});

describe('isNotAGitRepositoryError', () => {
  it('matches on stderr', () => {
    expect(isNotAGitRepositoryError({ stderr: 'fatal: not a git repository (or any of the parent directories)' })).toBe(true);
  });

  it('matches on message when stderr is absent', () => {
    expect(isNotAGitRepositoryError(new Error('Command failed: git rev-parse\nfatal: Not a git repository'))).toBe(true);
  });

  it('is false for an unrelated failure', () => {
    expect(isNotAGitRepositoryError(new Error('fatal: detected dubious ownership in repository'))).toBe(false);
  });
});
