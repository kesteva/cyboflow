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
import { resolveGitCommand } from '../../../utils/gitExeFinder';
import { resolveWorkflowBundle } from '../../../orchestrator/workflows/workflowBundle';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';
import {
  DEFAULT_FAN_OUT_DISPATCH,
  type FanOutDispatch,
} from '../../../../../shared/types/fanOutDispatch';
import { renderFanOutBatchScripts } from '../../../orchestrator/prompts/fanOutStageScript';
import { resolveRunFrozenSpec } from '../../../orchestrator/runFrozenSpec';
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
 * Exclude pattern for RENDERED dynamic-workflow stage scripts. Kept OUT of the
 * always-applied list above and appended only when scripts are actually being
 * installed: `ensureBundleExcluded` runs on every spawn, so folding this in
 * unconditionally would mutate `.git/info/exclude` in every worktree even for
 * runs that never render a script — breaking the "dispatch off ⇒ nothing on
 * disk changes" floor.
 */
const CYBOFLOW_SCRIPT_EXCLUDE_PATTERN = '.claude/workflows/cyboflow-*.js';

/**
 * True when a failed `git` invocation failed *because the cwd is not a git
 * repository* — the expected, uninteresting case (see ensureBundleExcluded).
 * Node puts the child's stderr on `err.stderr` when it is piped, and also folds
 * it into `err.message` ("Command failed: <cmd>\n<stderr>"); both are checked so
 * this holds regardless of how the spawn's stdio is configured. `LC_ALL=C` at
 * the call site pins git's wording to English so this match is locale-stable.
 */
function isNotAGitRepositoryError(err: unknown): boolean {
  const candidate = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof candidate?.stderr === 'string' ? candidate.stderr : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  return /not a git repository/i.test(stderr) || /not a git repository/i.test(message);
}

/**
 * Add the cyboflow bundle globs to the worktree's LOCAL git exclude
 * (`$GIT_DIR/info/exclude`, NOT the tracked `.gitignore`) so the generated
 * `cyboflow-*.md` files never surface in the run diff (`git ls-files --others
 * --exclude-standard` / `git status` both honor it) or get accidentally
 * committed. Idempotent (skips patterns already present) and fail-soft — a git
 * or fs error here must not break a spawn.
 *
 * A NON-REPO target is expected, not a fault: the global-agent chat thread's
 * home (`<dataDir>/agent-home/<threadId>`, AgentThreadService's `homeDirBase`)
 * goes through this same install seam and is deliberately a neutral directory
 * with no repo. It has no run diff to keep the bundle out of, so there is
 * nothing to exclude. That case is logged at debug and returns; every OTHER git
 * or fs failure still warns, because those are real and worth seeing.
 */
function ensureBundleExcluded(worktreePath: string, extraPatterns: string[], logger?: LoggerLike): void {
  const patterns = [...CYBOFLOW_EXCLUDE_PATTERNS, ...extraPatterns];
  try {
    const raw = execFileSync(resolveGitCommand(), ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktreePath,
      encoding: 'utf8',
      windowsHide: true,
      // Pin git's message language for isNotAGitRepositoryError, and capture
      // stderr rather than letting the child's `fatal:` line leak to the app's
      // own stderr on the (expected) non-repo path.
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
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
    const missing = patterns.filter((p) => !lines.includes(p));
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
    if (isNotAGitRepositoryError(err)) {
      logger?.debug('[WorkflowBundleInstall] skipped git exclude — not a git repository', {
        worktreePath,
      });
      return;
    }
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
 * Render the run's fan-out STAGE scripts from its EFFECTIVE workflow definition.
 *
 * Resolves through `resolveRunFrozenSpec` — the run's frozen A/B variant graph,
 * falling back to the live spec — deliberately NOT the live `workflows.spec_json`
 * join used for `workflow_path`. The prompt side resolves the frozen spec too
 * (interactiveClaudeManager.resolveRunEffectiveDefinition); reading the live row
 * here would let a variant run install scripts for a DIFFERENT inner chain than
 * the one its prompt walks, and the mismatch would surface only as the agent
 * naming a workflow that does not exist.
 *
 * Fail-soft to `[]` on any DB/resolve error — a missing script degrades to the
 * prose path, which is the correct floor.
 */
function resolveStageScripts(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): Array<{ name: string; content: string }> {
  try {
    const row = db
      .prepare(
        `SELECT w.name AS name, w.spec_json AS specJson
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(runId) as { name?: unknown; specJson?: unknown } | undefined;
    if (typeof row?.name !== 'string') return [];

    const frozen = resolveRunFrozenSpec(db, runId)?.specJson;
    const specJson = typeof frozen === 'string'
      ? frozen
      : (typeof row.specJson === 'string' ? row.specJson : '{}');

    const def = resolveWorkflowDefinition(row.name, specJson);
    if (def === null) return [];

    const steps = def.phases.flatMap((phase) => phase.steps);
    return renderFanOutBatchScripts(row.name, steps);
  } catch (err) {
    logger?.warn(
      `[WorkflowBundleInstall] stage-script render failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
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
  dispatch: FanOutDispatch = DEFAULT_FAN_OUT_DISPATCH,
): void {
  try {
    // Stage scripts for the fan-out steps — ONLY in 'workflow' dispatch. The
    // mode is a threaded ARGUMENT, not a global config read: this seam is
    // substrate-shared (the SDK manager calls it too) and the SDK consumes no
    // scripts, so reading a global here would litter SDK worktrees.
    const scripts = dispatch === 'workflow' ? resolveStageScripts(db, runId, logger) : [];

    // Keep the generated cyboflow files out of git (run diff + commits) BEFORE
    // writing them, so they never flicker into a diff poll. The scripts glob is
    // added only when scripts are actually being installed.
    ensureBundleExcluded(
      worktreePath,
      scripts.length > 0 ? [CYBOFLOW_SCRIPT_EXCLUDE_PATTERN] : [],
      logger,
    );

    const workflowPath = getRunWorkflowPath(db, runId, logger);
    const bundle = { ...resolveWorkflowBundle(workflowPath), scripts };
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
