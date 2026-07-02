/**
 * Unit tests for workflowBundleInstall (IDEA-013 rung-(ii), B6).
 *
 * Covers the substrate-shared install seam's two fail-soft responsibilities:
 *   (1) ensureBundleExcluded — appends the cyboflow bundle globs + marker to the
 *       worktree's LOCAL git exclude (`$GIT_DIR/info/exclude`) so generated
 *       cyboflow-*.md files never leak into the run diff or a commit. Idempotent,
 *       trailing-newline-safe, and fail-soft on a non-git path.
 *   (2) installWorkflowBundle — never throws into a spawn: a DB-miss resolves to
 *       an empty bundle (no write) and a throwing writer is caught + logged.
 *
 * agentOverlayWriter is mocked out — it bridges the full built-in agent catalogue
 * and is exercised by its own suite; here we isolate the install/exclude seam.
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree (git-inited where the
 * exclude path is needed) and a hand-rolled better-sqlite3 stub, so no schema or
 * agent-catalogue coupling leaks in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type Database from 'better-sqlite3';

// agentOverlayWriter pulls in the whole built-in agent catalogue — stub it so
// these tests isolate the exclude + fail-soft seam.
vi.mock('../agentOverlayWriter', () => ({ installAgentOverlay: vi.fn() }));

import { installWorkflowBundle } from '../workflowBundleInstall';
import { installAgentOverlay } from '../agentOverlayWriter';
import { WorkflowBundleWriter } from '../workflowBundleWriter';
import type { WorkflowBundle } from '../../../../orchestrator/workflows/workflowBundle';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

const MARKER = '# cyboflow: generated agent/command bundle (not user code)';
const GLOBS = ['.claude/agents/cyboflow-*.md', '.claude/commands/cyboflow-*.md'];

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
}

function excludePath(worktree: string): string {
  return path.join(worktree, '.git', 'info', 'exclude');
}

/**
 * A better-sqlite3 stub whose single prepared statement's .get() returns `row`.
 * getRunWorkflowPath is the only consumer of `db` (installAgentOverlay is mocked).
 * When `throwOnPrepare` is set, prepare throws to exercise the DB-error branch.
 */
function makeDbStub(
  row: { workflowPath?: unknown } | undefined,
  throwOnPrepare = false,
): Database.Database {
  return {
    prepare: () => {
      if (throwOnPrepare) throw new Error('db exploded');
      return { get: () => row };
    },
  } as unknown as Database.Database;
}

/** A writer whose write() throws, to prove installWorkflowBundle never propagates it. */
function makeThrowingWriter(): WorkflowBundleWriter {
  return {
    write: () => {
      throw new Error('writer boom');
    },
    remove: () => {},
  } as unknown as WorkflowBundleWriter;
}

describe('workflowBundleInstall — ensureBundleExcluded', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = tmpDir('cyboflow-bundle-install-');
    initGitRepo(worktree);
    vi.clearAllMocks();
  });

  it('appends the marker + both globs to a fresh git exclude', () => {
    // Empty bundle (row undefined) so writer.write is a no-op; only the exclude side matters.
    installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'run-1', worktree);

    const contents = fs.readFileSync(excludePath(worktree), 'utf8');
    expect(contents).toContain(MARKER);
    for (const glob of GLOBS) expect(contents).toContain(glob);
  });

  it('is idempotent — a second install adds no duplicate marker or globs', () => {
    const writer = new WorkflowBundleWriter();
    installWorkflowBundle(makeDbStub(undefined), writer, 'run-1', worktree);
    installWorkflowBundle(makeDbStub(undefined), writer, 'run-1', worktree);

    const contents = fs.readFileSync(excludePath(worktree), 'utf8');
    const count = (needle: string): number => contents.split(needle).length - 1;
    expect(count(MARKER)).toBe(1);
    for (const glob of GLOBS) expect(count(glob)).toBe(1);
  });

  it('closes a pre-existing file with no trailing newline before appending (no line-mashing)', () => {
    // Pre-seed the exclude with a user pattern and NO trailing newline.
    fs.mkdirSync(path.dirname(excludePath(worktree)), { recursive: true });
    fs.writeFileSync(excludePath(worktree), '*.log', 'utf8');

    installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'run-1', worktree);

    const contents = fs.readFileSync(excludePath(worktree), 'utf8');
    // The user pattern survives on its own line; the marker is NOT mashed onto it.
    expect(contents).toContain('*.log\n');
    expect(contents).not.toContain('*.log#');
    expect(contents).not.toContain(`*.log${MARKER}`);
    expect(contents).toContain(MARKER);
    for (const glob of GLOBS) expect(contents).toContain(glob);
  });

  it('fails soft (logs, does not throw) when the worktree is not a git repo', () => {
    const nonGit = tmpDir('cyboflow-bundle-nongit-');
    const logger = makeSpyLogger();

    expect(() =>
      installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'run-1', nonGit, logger),
    ).not.toThrow();

    // The exclude-update failure is warned, not thrown.
    expect(logger.warn).toHaveBeenCalled();
    const warned = logger.calls.some(
      (c) => c.level === 'warn' && c.message.includes('could not update git exclude'),
    );
    expect(warned).toBe(true);
    fs.rmSync(nonGit, { recursive: true, force: true });
  });
});

describe('workflowBundleInstall — installWorkflowBundle fail-soft', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = tmpDir('cyboflow-bundle-install-fs-');
    initGitRepo(worktree);
    vi.clearAllMocks();
  });

  it('DB-miss resolves to an empty bundle and writes no .claude tree', () => {
    // row undefined → workflowPath null → resolveWorkflowBundle(null) is empty →
    // real writer writes nothing.
    installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'missing-run', worktree);

    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
    // The overlay is still invoked (post-write) — install proceeds fail-soft.
    expect(installAgentOverlay).toHaveBeenCalledOnce();
  });

  it('catches + logs a throwing writer.write() and never propagates it to the spawn', () => {
    const logger = makeSpyLogger();
    // A resolvable (but bundle-less) path so resolveWorkflowBundle returns empty
    // and the writer is the thing that throws.
    const db = makeDbStub({ workflowPath: '/nonexistent/planner.md' });

    expect(() =>
      installWorkflowBundle(db, makeThrowingWriter(), 'run-x', worktree, logger),
    ).not.toThrow();

    const warned = logger.calls.some(
      (c) => c.level === 'warn' && c.message.includes('install failed for runId=run-x'),
    );
    expect(warned).toBe(true);
    // The writer threw, so the overlay is never reached.
    expect(installAgentOverlay).not.toHaveBeenCalled();
  });

  it('catches a DB-error during workflow_path lookup without throwing', () => {
    const logger = makeSpyLogger();
    // prepare() throws → getRunWorkflowPath warns + returns null → empty bundle.
    installWorkflowBundle(
      makeDbStub(undefined, /* throwOnPrepare */ true),
      new WorkflowBundleWriter(),
      'run-db-err',
      worktree,
      logger,
    );

    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
    const warned = logger.calls.some(
      (c) => c.level === 'warn' && c.message.includes('workflow_path lookup failed'),
    );
    expect(warned).toBe(true);
  });
});
