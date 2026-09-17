/**
 * evalComposition — the code-review-eval composition root, extracted from
 * index.ts's initializeServices() (GitHub issue #19, the god-file split, step
 * 4). It initializes the EvalWorker (rubric jury) and the PairwiseJudgeWorker
 * (A/B panel), resumes whatever an app quit interrupted, and subscribes the two
 * triggers: the human-review step transition and the terminal run status. The
 * body is index.ts's verbatim, apart from `app.getVersion()` → the injected
 * `appVersion` and index.ts's module-level `EMPTY_WORKTREE_STATUS` /
 * `resolveGitRefToSha` arriving as deps (index.ts's tRPC gitDiff context
 * closure still uses both, so they stay there).
 *
 * A SIBLING of index.ts on purpose — composition-root code that imports
 * concrete services, so it must stay OUT of main/src/orchestrator/**. No unit
 * test, as there was none over initializeServices(); the workers' own suites
 * cover the injected seams.
 *
 * ORDER IS LOAD-BEARING at the call site: both workers write net-new findings
 * through ReviewItemRouter, so this runs after the routers, and the bootstrap
 * stamp store it reads comes out of composeVerification().
 */

import { ReviewItemRouter } from './orchestrator/reviewItemRouter';
import { ArtifactRouter } from './orchestrator/artifactRouter';
import { resolveWorkflowDefinition } from '../../shared/types/workflows';
import { experimentEvents, runStatusEvents, stepTransitionEvents } from './orchestrator/trpc/routers/events';
import { EvalWorker } from './orchestrator/eval/evalWorker';
import { ClaudeJudge } from './orchestrator/eval/evalJury';
import { CodexJudge } from './orchestrator/eval/codexJudge';
import { makeEvalJudgeQuery } from './orchestrator/eval/evalJudgeQuery';
import { makeCodexEvalJudgeQuery } from './services/panels/codex/codexEvalJudgeQuery';
import { PairwiseJudgeWorker } from './orchestrator/eval/pairwiseJudgeWorker';
import { ClaudePairwiseJudge } from './orchestrator/eval/pairwiseJudge';
import { CodexPairwiseJudge } from './orchestrator/eval/codexPairwiseJudge';
import { makePairwiseJudgeQuery } from './orchestrator/eval/pairwiseJudgeQuery';
import { handleTerminalStatusEvent } from './orchestrator/terminalEvalSubscriber';
import { resolveRunFrozenSpec } from './orchestrator/runFrozenSpec';
import type { WorkflowStepTransitionEvent } from '../../shared/types/workflows';
import type { RunGitDiff, WorktreeStatusPayload } from '../../shared/types/runFiles';
import type { RunStatusChangedEvent } from '../../shared/types/cyboflow';
import { reconcileExperimentStatus } from './orchestrator/experimentStore';
import type { ConfigManager } from './services/configManager';
import type { GitDiffManager } from './services/gitDiffManager';
import type { RunbookBootstrapStampStore } from './orchestrator/verify/bootstrapStampStore';
import type { LoggerLike, DatabaseLike } from './orchestrator/types';

export interface EvalCompositionDeps {
  cyboflowDb: DatabaseLike;
  cyboflowLogger: LoggerLike;
  configManager: ConfigManager;
  claudeExecutablePath: string | undefined;
  gitDiffManager: GitDiffManager;
  /** index.ts's ref → sha resolver, shared with the tRPC gitDiff context closure. */
  resolveGitRefToSha: (worktreePath: string, ref: string | undefined) => Promise<string | null>;
  /** index.ts's EMPTY_WORKTREE_STATUS stub — the eval diff has no worktree-status view to report. */
  emptyWorktreeStatus: WorktreeStatusPayload;
  /** app.getVersion(), stamped on every eval row. */
  appVersion: string;
  /** From composeVerification(): the bootstrap's written paths are dropped from the graded diff (§11). */
  runbookBootstrapStamps: RunbookBootstrapStampStore;
}

export function composeEvalWorkers(deps: EvalCompositionDeps): void {
  const {
    cyboflowDb,
    cyboflowLogger,
    configManager,
    claudeExecutablePath,
    gitDiffManager,
    resolveGitRefToSha,
    emptyWorktreeStatus,
    appVersion,
    runbookBootstrapStamps,
  } = deps;

  // Code-review eval worker (migration 043). Grades a built-in run's frozen
  // pre-human diff against the 7-dimension rubric with a 2×Claude + 1×Codex jury and
  // writes net-new findings through ReviewItemRouter — so it MUST initialize after
  // the router (mirrors DynamicWorkflowTracker above). Electron-touching deps are
  // injected as closures (GitDiffManager, the SDK judge-query, the findings
  // chokepoint) so the worker itself imports no concrete service.
  //
  // gitDiff closure narrows GitDiffResult to the RunGitDiff wire shape and swallows
  // capture errors to null (the snapshot fails-soft on a null diff) — same closure
  // shape as the runs-router tRPC context (index.ts createContext), kept separate so
  // it can fail-soft rather than throw.
  const evalGitDiff = async (
    worktreePath: string,
    baseRef?: string,
  ): Promise<RunGitDiff | null> => {
    try {
      // Resolve to a sha for `resolvedBase` (TASK-211) even though this closure
      // has no meaningful worktree-status view to report — see
      // EMPTY_WORKTREE_STATUS in index.ts (injected as `emptyWorktreeStatus`).
      const resolvedBase = await resolveGitRefToSha(worktreePath, baseRef);
      const result = resolvedBase
        ? await gitDiffManager.captureDiffAgainstRef(worktreePath, resolvedBase)
        : await gitDiffManager.captureWorkingDirectoryDiff(worktreePath);
      return {
        diff: result.diff,
        stats: result.stats,
        changedFiles: result.changedFiles,
        resolvedBase,
        worktree: emptyWorktreeStatus,
      };
    } catch (err) {
      cyboflowLogger?.warn?.(
        `[eval] gitDiff closure failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
  const claudeJudge = new ClaudeJudge({
    structuredQuery: makeEvalJudgeQuery(claudeExecutablePath, cyboflowLogger),
    logger: cyboflowLogger,
  });
  const codexJudge = new CodexJudge({
    structuredQuery: makeCodexEvalJudgeQuery(cyboflowLogger),
    logger: cyboflowLogger,
  });
  EvalWorker.initialize(cyboflowDb, cyboflowLogger, {
    gitDiff: evalGitDiff,
    jury: [
      {
        slot: 'claude-1',
        provider: 'claude',
        model: claudeJudge.resolvedModel ?? null,
        judge: claudeJudge,
      },
      {
        slot: 'claude-2',
        provider: 'claude',
        model: claudeJudge.resolvedModel ?? null,
        judge: claudeJudge,
      },
      {
        slot: 'codex-1',
        provider: 'codex',
        model: codexJudge.resolvedModel ?? null,
        judge: codexJudge,
      },
    ],
    reviewItemWriter: (projectId, change) =>
      ReviewItemRouter.getInstance().applyReviewItem(projectId, change),
    // Artifact chokepoint — the ONE production wiring for the ad-hoc verdict's
    // 'eval-report' tab (never a raw INSERT into artifacts). Same closure shape as
    // reviewItemWriter so the eval module imports no concrete router.
    artifactWriter: (projectId, change) => ArtifactRouter.getInstance().apply(projectId, change),
    appVersion,
    // GLOBAL code-review-eval toggle (default ON) — read fresh per trigger so a
    // Settings change takes effect without relaunch. A per-run override
    // (workflow_runs.eval_enabled) outranks this; the snapshot consults it only
    // when the per-run value is NULL. Closure keeps the eval module free of any
    // concrete-service import (standalone-typecheck invariant).
    isEvalEnabled: () => configManager.getCodeReviewEvalEnabled(),
    // A/B testing slice C: the "Auto-grade variant & experiment runs" sub-toggle
    // (default ON). Consulted by the snapshot ONLY for variant/experiment-tagged
    // runs (untagged built-in runs ignore it), on TOP of the global toggle above.
    isVariantAutoGradeEnabled: () => configManager.getAutoGradeVariantRuns(),
    // §11 (lane-runbook-bootstrap): drop the runbook bootstrap's own files from
    // the graded diff. verify-setup is exempt from auto-eval for exactly this
    // reason — a runbook's acceptance test is its own proof run, not a rubric —
    // and the bootstrap moves that diff class into sprint/ship runs, which ARE
    // graded and A/B-compared.
    bootstrapWrittenPaths: (runId) => runbookBootstrapStamps.writtenPathsForRun(runId),
  });
  // Crash-safe resume: re-enqueue any eval an app quit left 'pending'/'running'
  // (the frozen diff lives in the row, so a re-grade is self-contained) — otherwise
  // the summary panel polls a perpetual 'running'.
  EvalWorker.getInstance().recoverInterrupted();

  // A/B testing slice C — the pairwise A/B judge worker. A SEPARATE singleton with
  // its OWN concurrency-1 queue (so pairwise judging runs CONCURRENTLY with per-arm
  // rubric evals, not behind them). Same closure-injected impurity shape as
  // EvalWorker: the diff-capture, the SDK pairwise judge, and the review-item
  // chokepoint are all closures so the worker imports no concrete service. Its
  // isEvalEnabled is COMPOSED — global code-review eval AND the auto-grade
  // sub-toggle — so turning either off captures the diffs but skips the judge.
  //
  // The panel mirrors EvalWorker's rubric jury: 2×Claude + 1×Codex, its LENGTH
  // driving K. Both Claude slots share ONE ClaudePairwiseJudge instance (identical
  // to claudeJudge above). The Codex slot gets a FRESH makeCodexEvalJudgeQuery — the
  // factory's resolvedModel is per-closure state, so reusing the rubric juror's
  // query fn would cross-contaminate the two panels' model provenance. No timeoutMs:
  // the factory already defaults to CODEX_EVAL_JUDGE_TIMEOUT_MS.
  const claudePairwiseJudge = new ClaudePairwiseJudge({
    structuredQuery: makePairwiseJudgeQuery(claudeExecutablePath, cyboflowLogger),
    logger: cyboflowLogger,
  });
  const codexPairwiseJudge = new CodexPairwiseJudge({
    structuredQuery: makeCodexEvalJudgeQuery(cyboflowLogger),
    logger: cyboflowLogger,
  });
  PairwiseJudgeWorker.initialize(cyboflowDb, cyboflowLogger, {
    gitDiff: evalGitDiff,
    panel: [
      {
        slot: 'claude-1',
        provider: 'claude',
        model: claudePairwiseJudge.resolvedModel ?? null,
        judge: claudePairwiseJudge,
      },
      {
        slot: 'claude-2',
        provider: 'claude',
        model: claudePairwiseJudge.resolvedModel ?? null,
        judge: claudePairwiseJudge,
      },
      {
        slot: 'codex-1',
        provider: 'codex',
        model: codexPairwiseJudge.resolvedModel ?? null,
        judge: codexPairwiseJudge,
      },
    ],
    reviewItemWriter: (projectId, change) =>
      ReviewItemRouter.getInstance().applyReviewItem(projectId, change),
    emitComparisonReady: (event) => experimentEvents.emit('comparisonReady', event),
    appVersion,
    isEvalEnabled: () =>
      configManager.getCodeReviewEvalEnabled() && configManager.getAutoGradeVariantRuns(),
  });
  // Crash-safe resume: re-enqueue any comparison an app quit left 'pending'/'running'
  // (both frozen diffs live on the row, so a re-grade is self-contained).
  PairwiseJudgeWorker.getInstance().recoverInterrupted();

  // Trigger seam (zero-touch): subscribe to the SHARED step-transition emitter and
  // snapshot on the sprint-review => human-review boundary. The flow prompts report
  // each step as it BEGINS (status='running'), so "human-review begins" is
  // observable EXACTLY ONCE as stepId==='human-review' && status==='running'.
  // Sprint + ship carry that step; compound also carries a terminal 'human-review'
  // step but snapshotRunForEval EXEMPTS 'compound' by name (its merge-gate diff is
  // not rubric material), so it self-excludes downstream. The snapshot re-checks
  // isCyboflowWorkflowName so custom flows with a same-named step default OFF.
  // Fire-and-forget + error-swallowed inside snapshot() — this can never affect the run.
  stepTransitionEvents.on('transition', (event: WorkflowStepTransitionEvent) => {
    if (event.stepId === 'human-review' && event.status === 'running') {
      void EvalWorker.getInstance().snapshot(event.runId);
    }
  });

  // A/B testing slice C — the workflow-agnostic terminal-status trigger. Fires on
  // ALL FOUR settled statuses so a failed/canceled second arm still completes the
  // experiment. A cheap tag SELECT gates EVERYTHING: an untagged run is a total
  // no-op (normal sprint/ship/planner/compound/quick runs are unaffected). Only
  // variant/experiment-tagged runs reach the auto-eval (healthy statuses + no
  // existing run_evals row, so the refire path is never hit), and experiment-tagged
  // runs additionally reconcile the experiment status + attempt the pairwise
  // comparison. The subscriber body lives in the deps-injected
  // handleTerminalStatusEvent helper (unit-testable); everything here is
  // fire-and-forget so a trigger failure can never affect a run.
  runStatusEvents.on('changed', (event: RunStatusChangedEvent) => {
    handleTerminalStatusEvent(event, {
      db: cyboflowDb,
      hasRunEvalRow: (runId) => {
        const row = cyboflowDb
          .prepare('SELECT 1 AS one FROM run_evals WHERE run_id = ? LIMIT 1')
          .get(runId) as { one?: number } | undefined;
        return row !== undefined;
      },
      // Path A (the human-review step-transition subscriber above) owns the rubric
      // snapshot for any run whose resolved definition carries a 'human-review'
      // step (built-in sprint/ship, and now compound). Deferring to it here avoids
      // the two non-serialized snapshot() calls racing snapshotRunForEval's INSERT
      // OR IGNORE (which would flip human_influenced=1 on the loser). Compound
      // resolves to a human-review step too, so it defers here — harmless because
      // snapshotRunForEval exempts 'compound' by name, so neither path ever grades
      // it. Planner/custom runs with no such step return false and still terminal-
      // eval. Fail-soft: any resolution error is treated as "not owned" (eval may fire).
      stepTransitionOwnsEval: (runId) => {
        try {
          const frozen = resolveRunFrozenSpec(cyboflowDb, runId);
          if (!frozen) return false;
          const def = resolveWorkflowDefinition(frozen.workflowName, frozen.specJson);
          if (!def) return false;
          return def.phases.some((phase) => phase.steps.some((step) => step.id === 'human-review'));
        } catch {
          return false;
        }
      },
      evalSnapshot: (runId) => void EvalWorker.getInstance().snapshot(runId),
      reconcile: (experimentId) => {
        reconcileExperimentStatus(cyboflowDb, experimentId);
      },
      pairwiseMaybe: (experimentId) => {
        void PairwiseJudgeWorker.getInstance().maybeSnapshotAndEnqueue(experimentId);
      },
      logger: cyboflowLogger,
    });
  });
}
