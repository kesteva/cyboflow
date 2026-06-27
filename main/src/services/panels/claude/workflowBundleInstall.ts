/**
 * workflowBundleInstall — the substrate-shared seam that resolves a run's
 * co-located command/agent bundle and installs it into the run's worktree
 * (IDEA-013 rung-(ii)). Called from BOTH managers' spawn paths
 * (interactiveClaudeManager.spawnCliProcess and claudeCodeManager.spawnCliProcess)
 * so the `/cyboflow-<phase>` invokable units land for either substrate; removal is
 * each manager's own teardown (interactive: teardownRun; SDK: cleanupCliResources)
 * via `WorkflowBundleWriter.remove`.
 *
 * The bundle is keyed off the run's `workflows.workflow_path` — the SAME `.md`
 * the prompt body is read from — so any flow using a built-in's prose gets that
 * built-in's sibling bundle, and a quick session / custom flow with no sibling
 * bundle dir resolves to an empty bundle and writes nothing (fail-soft).
 *
 * Unlike the dumb `WorkflowBundleWriter` (fs-only, standalone-typecheck-safe),
 * this helper bridges DB + resolver + writer, so it MAY import better-sqlite3 and
 * the orchestrator resolver (same latitude as the managers that call it).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { LoggerLike } from '../../../orchestrator/types';
import { resolveWorkflowBundle } from '../../../orchestrator/workflows/workflowBundle';
import type { WorkflowBundleWriter } from './workflowBundleWriter';
import { installAgentOverlay } from './agentOverlayWriter';

/** Marker line preceding the cyboflow patterns in a worktree's git exclude. */
const CYBOFLOW_EXCLUDE_MARKER = '# cyboflow: generated agent/command bundle (not user code)';

/**
 * Glob patterns for the files BOTH writers above emit. Every cyboflow-generated
 * agent/command is `cyboflow-<key>.md` (WorkflowBundleWriter + agentOverlayWriter
 * both force that prefix), so these two lines cover the whole generated set and
 * never match a user's own `.claude/agents` file.
 */
const CYBOFLOW_EXCLUDE_PATTERNS = [
  '.claude/agents/cyboflow-*.md',
  '.claude/commands/cyboflow-*.md',
];

/**
 * Add the cyboflow bundle globs to the worktree's LOCAL git exclude
 * (`$GIT_DIR/info/exclude`, NOT the tracked `.gitignore`) so the generated
 * `cyboflow-*.md` files never surface in the run diff (`git ls-files --others
 * --exclude-standard` / `git status` both honor it) or get accidentally
 * committed. Idempotent (skips patterns already present) and fail-soft — a git
 * or fs error here must not break a spawn.
 */
function ensureBundleExcluded(worktreePath: string, logger?: LoggerLike): void {
  try {
    const raw = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();
    if (raw.length === 0) return;
    const excludePath = path.isAbsolute(raw) ? raw : path.join(worktreePath, raw);

    let existing = '';
    try {
      existing = fs.readFileSync(excludePath, 'utf8');
    } catch {
      /* file absent — created below */
    }
    const lines = existing.split(/\r?\n/);
    const missing = CYBOFLOW_EXCLUDE_PATTERNS.filter((p) => !lines.includes(p));
    if (missing.length === 0) return;

    const parts: string[] = [];
    if (existing.length > 0 && !existing.endsWith('\n')) parts.push(''); // close a dangling line
    if (!lines.includes(CYBOFLOW_EXCLUDE_MARKER)) parts.push(CYBOFLOW_EXCLUDE_MARKER);
    parts.push(...missing, '');

    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    fs.appendFileSync(excludePath, parts.join('\n'), 'utf8');
    logger?.debug('[WorkflowBundleInstall] excluded cyboflow bundle from git', {
      worktreePath,
      added: missing,
    });
  } catch (err) {
    logger?.warn(
      `[WorkflowBundleInstall] could not update git exclude for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the run's `workflow_path` (the prose `.md`) from `workflow_runs JOIN
 * workflows`. Fail-soft to `null` on a missing run row, an unresolvable join, or a
 * DB error — mirrors `interactiveClaudeManager.buildStepReportingAppendForRun`.
 */
function getRunWorkflowPath(db: Database.Database, runId: string, logger?: LoggerLike): string | null {
  try {
    const row = db
      .prepare(
        `SELECT w.workflow_path AS workflowPath
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(runId) as { workflowPath?: unknown } | undefined;
    return typeof row?.workflowPath === 'string' ? row.workflowPath : null;
  } catch (err) {
    logger?.warn(
      `[WorkflowBundleInstall] workflow_path lookup failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Resolve + install the run's co-located command/agent bundle into `worktreePath`.
 * No-op (writes nothing) when the run has no resolvable `workflow_path` or no
 * sibling bundle dir. Never throws — a bundle failure must not break a spawn.
 */
export function installWorkflowBundle(
  db: Database.Database,
  writer: WorkflowBundleWriter,
  runId: string,
  worktreePath: string,
  logger?: LoggerLike,
): void {
  try {
    // Keep the generated cyboflow-*.md files out of git (run diff + commits)
    // BEFORE writing them, so they never flicker into a diff poll.
    ensureBundleExcluded(worktreePath, logger);

    const workflowPath = getRunWorkflowPath(db, runId, logger);
    const bundle = resolveWorkflowBundle(workflowPath);
    writer.write(worktreePath, bundle);
    // Overlay the project's FULL effective agent set (built-ins + agent_overrides)
    // on top of the flow bundle, so a custom/quick flow still gets the project's
    // agents and an overridden builtin gets its override body. Synchronous +
    // fail-soft (see agentOverlayWriter doc-comment for the plan deviation).
    installAgentOverlay(db, runId, worktreePath, logger);
  } catch (err) {
    logger?.warn(
      `[WorkflowBundleInstall] install failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
