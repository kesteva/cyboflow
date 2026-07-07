/**
 * RunLauncher — orchestrates the launch sequence for a single workflow run.
 *
 * Responsibilities:
 *   1. Ensure `.cyboflow/worktrees/` is in the project's `.gitignore`
 *   2. Create a new `workflow_runs` row via WorkflowRegistry.createRun
 *   3. Create a deterministic worktree via WorktreeManager.createDeterministicWorktree
 *   4. UPDATE the `workflow_runs` row with worktree_path, branch_name, status='starting'
 *   5. (Optional) Enqueue RunExecutor.execute(runId) via RunQueueRegistry after publish
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron'
 * or any concrete service in main/src/services/*.  All collaborators are
 * injected via the constructor. The new optional 10th (runExecutor) and 11th
 * (runQueueRegistry) constructor parameters preserve backward compatibility
 * with all existing call sites that omit them.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { WorkflowRegistry } from './workflowRegistry';
import { QUICK_WORKFLOW_NAME } from './workflowRegistry';
import type { WorktreeManager } from '../services/worktreeManager';
import type { DatabaseLike, LoggerLike } from './types';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import type { StreamEnvelope } from '../../../shared/types/claudeStream';
import type { McpConfigWriter } from './mcpConfigWriter';
import type { RunExecutor } from './runExecutor';
import type { RunQueueRegistry } from './RunQueueRegistry';
import type { TaskChange } from './taskChangeRouter';
import type { VariantResolver } from './variantResolver';
import type { ExperimentArm } from '../../../shared/types/experiments';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import {
  updateSessionAgentPermissionMode,
  type SessionAgentPermissionModeDeps,
} from './sessionPermissionMode';

/**
 * Provides the Unix socket path that the orchestrator IPC server listens on.
 * In production, this is the real `permissionIpcServer.getSocketPath()`.
 * In tests, a stub returns a canned string.
 */
export interface OrchSocketProvider {
  getSocketPath(): string;
}

/**
 * Resolves the absolute path to the bundled cyboflowPermissionBridge.js.
 * In production, this handles ASAR extraction and dev vs packaged build differences.
 * In tests, a stub returns a canned path.
 */
export interface BridgeScriptResolver {
  getScriptPath(): string;
}

/**
 * Resolves the path to the node executable.
 * In production, delegates to findExecutableInPath('node') with a fallback ladder.
 * In tests, a stub returns a canned path.
 */
export interface NodeResolver {
  getNodePath(): Promise<string>;
}

/**
 * Decouples RunLauncher from the Electron layer by accepting a plain publisher
 * interface instead of importing BrowserWindow directly.
 *
 * The concrete implementation lives in main/src/index.ts (initializeServices),
 * which is the only place that calls win.webContents.send for cyboflow stream
 * events.
 * Keeping this interface here preserves the standalone-typecheck invariant:
 * no electron imports inside main/src/orchestrator/.
 */
export interface StreamEventPublisher {
  publish(runId: string, event: StreamEnvelope): void;
}

/**
 * Narrow slice of TaskChangeRouter needed to wire in-process stage derivation
 * at launch. Keeping it as an injected interface (rather than reaching for
 * `TaskChangeRouter.getInstance()` directly) preserves the standalone-typecheck
 * invariant and the constructor-injection test ergonomics used everywhere else
 * in this module. The concrete TaskChangeRouter singleton satisfies this shape
 * structurally; the boot wiring in main/src/index.ts passes it in.
 *
 * Both task writes (entry-stage capture via applyChange, derived execution
 * stage via recomputeTaskExecutionStage) route through the chokepoint — this
 * file never UPDATEs the `tasks` table directly. Writes to `workflow_runs`
 * (task_id + triage columns) are NOT task-state writes and are done inline.
 */
export interface TaskStageDeriverLike {
  applyChange(
    projectId: number,
    change: TaskChange,
  ): Promise<{ taskId: string; event: { id: number; seq: number } }>;
  recomputeTaskExecutionStage(taskId: string): Promise<void>;
}

/**
 * Narrow slice of SprintLaneStore needed to seed the per-task lanes of a
 * session-hosted `sprint` run at launch (feat/parallel-sprint, single-run lane
 * model). Injected as an interface (not `SprintLaneStore.getInstance()`) to
 * preserve the standalone-typecheck invariant and constructor-injection test
 * ergonomics; the boot wiring in main/src/index.ts passes the singleton in.
 */
export interface SprintLanesLike {
  createForRun(
    projectId: number,
    substrate: CliSubstrate,
    taskIds: string[],
  ): { batchId: string };
}

export class RunLauncher {
  constructor(
    private readonly db: DatabaseLike,
    private readonly workflowRegistry: WorkflowRegistry,
    private readonly worktreeManager: WorktreeManager,
    private readonly logger: LoggerLike,
    private readonly mcpConfigWriter: McpConfigWriter,
    private readonly orchSocketProvider: OrchSocketProvider,
    private readonly bridgeScriptResolver: BridgeScriptResolver,
    private readonly nodeResolver: NodeResolver,
    private readonly publisher?: StreamEventPublisher,
    private readonly runExecutor?: RunExecutor,
    private readonly runQueueRegistry?: RunQueueRegistry,
    /**
     * Optional native-task stage deriver (migration 014). When injected AND a
     * launch is given a `taskId`, the launcher records the run->task link,
     * captures the task's planning entry stage on first execution, and recomputes
     * the task's derived execution stage (-> In development). When absent (legacy
     * call sites, tests that predate native tasks, or a run launched with no task),
     * task derivation is silently skipped — backward-compatible.
     */
    private readonly taskStageDeriver?: TaskStageDeriverLike,
    /**
     * Optional sprint-lane store (feat/parallel-sprint, migration 022). When
     * injected AND a launch is given `seedTaskIds`, the launcher creates the
     * batch + per-task lane rows via the SprintLaneStore chokepoint and stamps
     * `workflow_runs.batch_id`. When absent, launching with seedTaskIds throws —
     * the lanes are load-bearing for the sprint orchestrator agent.
     */
    private readonly sprintLanes?: SprintLanesLike,
    /**
     * Optional session-mode write chokepoint deps (permission-mode redesign §3e /
     * Slice 5). When injected AND a launch supplies an explicit
     * `requestedPermissionMode`, the launcher writes that mode to the HOST session
     * via updateSessionAgentPermissionMode (the SAME chokepoint the composer pill +
     * runs.setPermissionMode use) — persist + 'session-updated' emit + runtime
     * mutate. When omitted (legacy
     * call sites / tests that predate the chokepoint), the session-mode write is
     * silently skipped — backward-compatible. The launch picker permanently sets
     * the host session's mode; when no explicit mode is supplied the session's mode
     * is LEFT UNTOUCHED (the createRun ladder still stamps permission_mode_snapshot
     * as an audit-only value that may diverge).
     */
    private readonly sessionPermissionModeDeps?: SessionAgentPermissionModeDeps,
    /**
     * Optional rotation resolver (A/B testing, migration 048). When injected,
     * launch() resolves the variant for every launch (explicit pin or weighted
     * random over active variants) BEFORE createRun and threads the variant fields
     * into the createRun opts bag. When absent (legacy call sites / tests that
     * predate the feature), no variant is ever resolved — every launch is a
     * baseline live-spec run, byte-identical to before.
     */
    private readonly variantResolver?: VariantResolver,
  ) {
    // Legacy-bridge collaborators are required only when no runExecutor is
    // supplied.  Under the SDK substrate, the PreToolUse hook gates permissions
    // in-process; the MCP permission-bridge file (writeForRun) is skipped.
    if (!runExecutor) {
      if (!mcpConfigWriter) throw new Error('RunLauncher: missing required collaborator mcpConfigWriter');
      if (!orchSocketProvider) throw new Error('RunLauncher: missing required collaborator orchSocketProvider');
      if (!bridgeScriptResolver) throw new Error('RunLauncher: missing required collaborator bridgeScriptResolver');
      if (!nodeResolver) throw new Error('RunLauncher: missing required collaborator nodeResolver');
    }
  }

  /**
   * Launch a workflow run:
   *   1. ensureGitignoreEntry — idempotent; adds `.cyboflow/worktrees/` if absent
   *   2. createRun — inserts workflow_runs row (status='queued')
   *   3. Worktree resolution (SESSION-HOSTED only, slice 1b): reuse the EXISTING
   *      session's worktree. No new worktree/branch is created; base_sha is
   *      snapshotted from the session worktree's HEAD and the session's run_id
   *      back-link is dual-written for legacy readers (session<->run restructure,
   *      Phase 1). The legacy session-less createDeterministicWorktree branch was
   *      removed when the never-session-less invariant was hard-enforced.
   *   4. UPDATE workflow_runs — sets worktree_path, branch_name, status='starting'
   *   5. (When a `taskId` is supplied AND a taskStageDeriver is injected)
   *      link the run to the task, capture base_branch/base_sha/steps_snapshot_json,
   *      capture the task's planning entry stage if not yet recorded, then recompute
   *      the task's derived execution stage (-> In development).
   *
   * `taskId` (migration 014) is OPTIONAL: runs may be launched with no task
   * (ad-hoc workflow runs predate native tasks). The task-derivation block is a
   * complete no-op when `taskId` is omitted or no deriver is wired.
   *
   * `sessionId` (session<->run restructure, Phase 1 / migration 019) is REQUIRED
   * (permission-mode redesign slice 1b): the run executes inside that session's
   * worktree, and a one-running-at-a-time guard rejects a second concurrent run for
   * the same session. launch throws when it is missing; there is no session-less
   * path anymore.
   *
   * Returns the runId, worktreePath, branchName, and snapshotted permissionMode.
   */
  async launch(
    workflowId: string,
    projectPath: string,
    // The user's explicit per-run CLI substrate choice (IDEA-013 / TASK-812),
    // threaded down to the S1 resolver/stamp in WorkflowRegistry.createRun as the
    // highest-precedence override. OPTIONAL — when omitted the resolver ladder
    // falls through to env + the 'sdk' floor.
    substrate?: CliSubstrate,
    taskId?: string,
    // Planner pre-launch seed idea (migration 017). Written DIRECTLY to
    // workflow_runs.seed_idea_id — NOT routed through linkRunToTaskAndDerive
    // (no entry-stage capture, no recomputeTaskExecutionStage, so no not_found
    // throw for an id absent from the tasks table). task_id stays task-only.
    ideaId?: string,
    // Session<->run restructure, Phase 1 (migration 019). The run is hosted inside
    // this session's existing worktree, and is threaded into
    // WorkflowRegistry.createRun (below) to stamp workflow_runs.session_id. REQUIRED
    // as of the permission-mode redesign slice 1b: launch throws when it is missing
    // and the legacy session-less worktree branch was removed. The declared type
    // stays `?: string` only because TS1016 forbids a required parameter after the
    // preceding optional params; the runtime guard is the enforcement.
    sessionId?: string,
    // The user's explicit per-run agent-permission choice (WorkflowPicker),
    // threaded to the highest-precedence `requestedMode` rung of the permission
    // ladder in WorkflowRegistry.createRun. OPTIONAL — when omitted the ladder
    // falls through to frontmatter → global default → 'default'.
    requestedPermissionMode?: PermissionMode,
    // Parallel-sprint (feat/parallel-sprint, P4). Historically forwarded into
    // createDeterministicWorktree to cut a dependent task's worktree branch off the
    // CURRENT integration tip. DORMANT since slice 1b removed the session-less
    // worktree path: every run reuses the session worktree, so this is ignored. The
    // param is retained for positional-call-site ABI stability; a later slice will
    // re-home base-branch selection onto the session worktree if needed.
    baseBranch?: string,
    // Parallel-sprint (feat/parallel-sprint, single-run lane model). When
    // supplied, the run is a session-hosted `sprint` run seeded with these task
    // ids: the launcher creates the batch + per-task lane rows via
    // SprintLaneStore.createForRun and stamps `workflow_runs.batch_id`. ONLY
    // valid when the workflow's name === 'sprint' — any other workflow throws.
    seedTaskIds?: string[],
    // The EXPLICIT launch project (migration 030 — global workflows). For a
    // GLOBAL workflow (a built-in or global custom flow, `workflow.project_id
    // IS NULL`) this is the ONLY source of the run's project: it is threaded into
    // WorkflowRegistry.createRun (stamped onto the NOT-NULL workflow_runs.project_id)
    // AND into SprintLaneStore.createForRun. OPTIONAL for backward-compat: when
    // omitted (legacy call sites / a per-project sentinel or edited built-in row)
    // createRun falls back to workflow.project_id. A global workflow launched
    // WITHOUT this throws in createRun ("an explicit projectId is required").
    projectId?: number,
    // The user's explicit per-run EXECUTION MODEL choice (orchestrated vs
    // programmatic), threaded to the highest-precedence `requestedExecutionModel`
    // rung of the execution-model resolver in WorkflowRegistry.createRun. OPTIONAL
    // — when omitted the resolver falls through to global default → env → the
    // 'orchestrated' floor (and the interactive substrate hard-pins 'orchestrated'
    // regardless). DORMANT until a picker surfaces it.
    requestedExecutionModel?: ExecutionModel,
    // The selected compound findings (findings-triage redesign / migration 034).
    // When supplied, the run is a `compound` run seeded with these review_items.id
    // values: the launcher writes them (JSON-encoded) DIRECTLY to
    // workflow_runs.seed_finding_ids — NOT routed through any task/lane chokepoint
    // (mirrors seed_idea_id / batch_id). ONLY valid when the workflow's name ===
    // 'compound' — any other workflow throws. NO selection cap (OD-7).
    // RunExecutor.getPrompt reads this column to inject the `## Selected findings`
    // block. OPTIONAL — when omitted the run is not finding-seeded.
    findingIds?: string[],
    // The user's explicit per-run MODEL choice (Configure surface →
    // runs.start → here), a user-facing alias ('opus' | 'opus-250k' | 'sonnet' |
    // 'haiku' | 'auto') threaded into WorkflowRegistry.createRun, which stamps it
    // onto workflow_runs.model (migration 037). OPTIONAL — when omitted the run
    // pins no model and RunExecutor falls through to the SDK default. There is no
    // resolver ladder; the value is resolved to a concrete snapshot at the spawn
    // seam (modelContext.resolveModelAlias).
    requestedModel?: string,
    // The user's explicit per-run CODE-REVIEW-EVAL choice (Configure surface →
    // runs.start → here). true = force the eval ON for this run, false = force it
    // OFF, undefined = no per-run pin → inherit the global codeReviewEvalEnabled
    // toggle at the trigger seam. Threaded into WorkflowRegistry.createRun, which
    // stamps it onto workflow_runs.eval_enabled (0/1/NULL, migration 044). Like
    // requestedModel there is no resolver ladder; the value is read at the trigger
    // (snapshotRunForEval). OPTIONAL — omitted for every legacy/one-click call site.
    requestedEvalEnabled?: boolean,
    // A/B testing (migration 048). ONE trailing options object (resolves the
    // variant-pin + experiment-stamp surface without adding two positionals):
    //   - requestedVariantId — an EXPLICIT variant pin (UI selection / restart
    //     inherit / experiment arm). When omitted the VariantResolver applies
    //     weighted rotation over active variants (or resolves null → baseline).
    //   - experiment — slice B stamps the run's experiment_id + arm so the arm's
    //     entity writes are sandboxed. The 048 columns exist for this; slice B
    //     supplies the values, and createRun stamps them immutably now.
    launchOptions?: {
      requestedVariantId?: string;
      experiment?: { experimentId: string; arm: ExperimentArm };
      // Restart of a baseline (variant_id NULL) run: PIN the baseline so the
      // resolver returns null WITHOUT rotating, reproducing the retried run's
      // baseline config even after the workflow gained active variants ("restart
      // inherits, no re-roll"). Ignored when requestedVariantId is set.
      baseline?: boolean;
    },
  ): Promise<{ runId: string; worktreePath: string; branchName: string; permissionMode: PermissionMode }> {
    await this.ensureGitignoreEntry(projectPath);

    const workflow = this.workflowRegistry.getById(workflowId);
    if (!workflow) throw new Error(`RunLauncher.launch: workflow ${workflowId} not found`);

    // Sprint seed-task validation — BEFORE createRun so an invalid request never
    // leaves a half-created run row behind.
    if (seedTaskIds !== undefined) {
      if (workflow.name !== 'sprint') {
        throw new Error(
          `RunLauncher.launch: seedTaskIds is only valid for the 'sprint' workflow (got '${workflow.name}')`,
        );
      }
      if (seedTaskIds.length < 1) {
        throw new Error('RunLauncher.launch: seedTaskIds must contain at least one task id');
      }
      if (!this.sprintLanes) {
        throw new Error('RunLauncher.launch: seedTaskIds supplied but no sprintLanes store is wired');
      }
    }

    // Compound seed-finding validation (findings-triage redesign / migration 034)
    // — BEFORE createRun so an invalid request never leaves a half-created run row
    // behind. Mirrors the seedTaskIds guard; no store dependency (the seed is a
    // direct workflow_runs write).
    if (findingIds !== undefined) {
      if (workflow.name !== 'compound') {
        throw new Error("findingIds is only valid for the 'compound' workflow");
      }
      if (findingIds.length < 1) {
        throw new Error('findingIds must contain at least one finding id');
      }
    }

    // Session invariant (permission-mode redesign slice 1b): every run is hosted by
    // a session — there is no session-less launch path anymore. Enforced here AFTER
    // the sprint/finding request validation (so an invalid request still surfaces
    // its own specific error first) and BEFORE the one-running guard binds sessionId
    // into SQL. createRun re-asserts this as the hard chokepoint; this guard gives a
    // clean message and narrows sessionId to a non-empty string for the body below.
    // (The signature stays `sessionId?: string` only because TS1016 forbids a
    // required parameter after the preceding optional params.)
    if (!sessionId) {
      throw new Error('RunLauncher.launch: sessionId is required (run cannot be session-less)');
    }

    // One-running-at-a-time guard: a session may own many runs over its lifetime
    // but only ONE may be in flight at a time. Checked BEFORE createRun so we never
    // leave a half-created run behind on rejection.
    //
    // The __quick__ SENTINEL run (created by sessions:create-quick to back a quick
    // session in the workflow_runs pipeline) is permanently 'running' and must NOT
    // count toward this limit — otherwise launching the FIRST real workflow into a
    // quick session would always be wrongly blocked by its own sentinel. Exclude
    // any run whose workflow is the sentinel.
    const activeRow = this.db
      .prepare(
        // 'paused' (Phase 4b) is non-terminal — a paused run still occupies the
        // session and must block launching a second run into it.
        `SELECT COUNT(*) AS n FROM workflow_runs
          WHERE session_id = ?
            AND status IN ('queued','starting','running','awaiting_review','stuck','awaiting_input','paused')
            AND workflow_id NOT IN (SELECT id FROM workflows WHERE name = ?)`,
      )
      .get(sessionId, QUICK_WORKFLOW_NAME) as { n: number };
    if (activeRow.n > 0) {
      throw new Error(
        `RunLauncher.launch: session ${sessionId} already has a running workflow`,
      );
    }

    // Launch-picker → host-session mode (permission-mode redesign §3e / Slice 5).
    // When an EXPLICIT mode is supplied, write it to the host session via the SAME
    // chokepoint the composer pill + runs.setPermissionMode use (persist +
    // 'session-updated' emit + runtime mutate + interactive re-prime) BEFORE
    // createRun — so launching a flow with an explicit mode permanently sets the
    // session's mode (affecting later chat + later flows). When OMITTED the
    // session's mode is LEFT UNTOUCHED (never clobbered with the createRun ladder).
    // The chokepoint deps are optional for legacy/test call sites that omit them.
    if (requestedPermissionMode !== undefined && this.sessionPermissionModeDeps) {
      updateSessionAgentPermissionMode(this.sessionPermissionModeDeps, sessionId, requestedPermissionMode);
    }

    // Thread the EXPLICIT launch project (migration 030) so createRun stamps it
    // onto workflow_runs.project_id. For a GLOBAL workflow (project_id NULL) this
    // is required; for a per-project row (quick sentinel / edited built-in) it is
    // omitted and createRun falls back to workflow.project_id. The `opts` object
    // is only passed when projectId is defined so the legacy fallback path stays
    // byte-identical for callers that never thread a project.
    // A/B testing (migration 048): resolve the variant for this launch ONCE, here,
    // pre-createRun — so EVERY launch surface (picker, one-click, backlog, restart,
    // experiment arm) inherits rotation from a single place and createRun stays a
    // pure stamper. An explicit pin (requestedVariantId) loads regardless of status;
    // otherwise the resolver does weighted random over active variants (or null →
    // baseline live-spec run). A foreign-workflow pin throws inside the resolver.
    const rv =
      this.variantResolver?.resolveForLaunch(workflowId, launchOptions?.requestedVariantId, {
        baseline: launchOptions?.baseline,
      }) ?? null;
    const experiment = launchOptions?.experiment;

    // Pass the opts bag when an explicit project, execution model, model, per-run
    // eval override, a resolved variant, OR an experiment stamp is threaded; omit it
    // entirely otherwise so the legacy fallback path (workflow.project_id + resolver
    // floor, no model/eval/variant pin) stays byte-identical.
    const createOpts =
      projectId !== undefined ||
      requestedExecutionModel !== undefined ||
      requestedModel !== undefined ||
      requestedEvalEnabled !== undefined ||
      rv !== null ||
      experiment !== undefined
        ? {
            ...(projectId !== undefined ? { projectId } : {}),
            ...(requestedExecutionModel !== undefined ? { requestedExecutionModel } : {}),
            ...(requestedModel !== undefined ? { requestedModel } : {}),
            ...(requestedEvalEnabled !== undefined ? { requestedEvalEnabled } : {}),
            ...(rv !== null
              ? {
                  variantId: rv.variantId,
                  variantLabel: rv.variantLabel,
                  variantSpecJson: rv.specJson,
                  ...(rv.model !== null ? { variantModel: rv.model } : {}),
                  ...(rv.executionModel !== null ? { variantExecutionModel: rv.executionModel } : {}),
                }
              : {}),
            ...(experiment !== undefined
              ? { experimentId: experiment.experimentId, experimentArm: experiment.arm }
              : {}),
          }
        : undefined;
    const { runId, permissionMode, substrate: resolvedSubstrate } = this.workflowRegistry.createRun(
      workflowId,
      substrate,
      sessionId,
      requestedPermissionMode,
      createOpts,
    );

    try {
      // Every run is session-hosted (slice 1b): the run executes inside the owning
      // session's EXISTING worktree. The legacy session-less createDeterministicWorktree
      // branch (and the `baseBranch` it consumed) was removed with the invariant.
      const { worktreePath, branchName } = await this.resolveSessionHostedWorktree(runId, sessionId);

      // Write the per-run .mcp.json into the worktree so Claude can discover
      // the cyboflow-permissions bridge.
      // Skipped when runExecutor is wired: the SDK substrate gates permissions
      // via PreToolUse in-process; the legacy Unix-socket bridge file is dead
      // code on every SDK-driven launch.
      if (!this.runExecutor) {
        const nodeExecutablePath = await this.nodeResolver.getNodePath();
        await this.mcpConfigWriter.writeForRun({
          runId,
          worktreePath,
          orchSocketPath: this.orchSocketProvider.getSocketPath(),
          bridgeScriptPath: this.bridgeScriptResolver.getScriptPath(),
          nodeExecutablePath,
        });
      }

      this.db
        .prepare(
          'UPDATE workflow_runs SET worktree_path = ?, branch_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        )
        .run(worktreePath, branchName, 'starting', runId);

      // Session-hosted finalization (session<->run restructure, Phase 1).
      // Snapshot the session worktree's HEAD as base_sha and dual-write the
      // legacy sessions.run_id back-link so readers that still consult
      // sessions.run_id (e.g. useLifecycleSession.ts until Phase 3) keep working.
      // The forward link (workflow_runs.session_id) was stamped at createRun.
      // Always runs now — the session-less launch path was removed in slice 1b.
      const baseSha = await this.worktreeManager.getHeadCommit(worktreePath);
      this.db
        .prepare('UPDATE workflow_runs SET base_sha = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(baseSha, runId);
      // Dual-write the legacy back-link AND keep the session's substrate in
      // lockstep with the run it hosts. Without the substrate stamp a session
      // created on the SDK default (ensureSessionForLaunch) that hosts an
      // INTERACTIVE run would, on cancel/end, return to its resting view as
      // SDK — the session never reflected the PTY substrate the run actually
      // used. The frontend resting view (ClaudePanel) reads sessions.substrate,
      // and the live REPL re-spawn (sessions:input) re-registers the PTY channel
      // under sessions.run_id, so this keeps the resting view a PTY surface.
      this.db
        .prepare('UPDATE sessions SET run_id = ?, substrate = ? WHERE id = ?')
        .run(runId, resolvedSubstrate, sessionId);

      // Planner pre-launch seed idea (migration 017). A direct workflow_runs
      // write — NOT a tasks write, and NOT routed through the stage deriver
      // (the seed idea participates in no stage derivation). RunExecutor.getPrompt
      // reads this column to inject the `# Selected idea` block. Idempotent and
      // independent of any taskId link below.
      if (ideaId) {
        this.db
          .prepare('UPDATE workflow_runs SET seed_idea_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(ideaId, runId);
      }

      // Parallel-sprint lane seeding (feat/parallel-sprint, migration 022).
      // Create the batch + per-task lane rows via the SprintLaneStore chokepoint
      // (using the run's RESOLVED substrate from createRun, never the raw
      // request), then stamp `workflow_runs.batch_id` — a direct workflow_runs
      // write, NOT routed through the task chokepoint. Stamped at launch so the
      // link exists before the first cyboflow_update_sprint_task report.
      if (seedTaskIds && seedTaskIds.length > 0 && this.sprintLanes) {
        // Seed the lanes with the run's project (migration 030). Prefer the
        // EXPLICITLY-threaded launch `projectId` — the canonical source now that
        // workflow.project_id is NULLABLE (NULL for the global built-ins). When a
        // caller did not thread it, fall back to the RUN's stamped project
        // (workflow_runs.project_id, a real NOT-NULL value createRun just wrote)
        // rather than workflow.project_id, which may be NULL.
        let laneProjectId: number;
        if (projectId !== undefined) {
          laneProjectId = projectId;
        } else {
          const runRow = this.db
            .prepare('SELECT project_id FROM workflow_runs WHERE id = ?')
            .get(runId) as { project_id: number } | undefined;
          if (!runRow) {
            throw new Error(`RunLauncher.launch: run ${runId} not found immediately after createRun`);
          }
          laneProjectId = runRow.project_id;
        }
        const { batchId } = this.sprintLanes.createForRun(
          laneProjectId,
          resolvedSubstrate,
          seedTaskIds,
        );
        this.db
          .prepare('UPDATE workflow_runs SET batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(batchId, runId);
      }

      // Compound seed findings (findings-triage redesign / migration 034). A direct
      // workflow_runs write — NOT routed through any chokepoint (workflow_runs has
      // none), exactly like seed_idea_id / batch_id above. JSON-encoded so the
      // single TEXT column holds the selected review_items.id array;
      // RunExecutor.getPrompt parses it to inject the `## Selected findings` block.
      if (findingIds && findingIds.length > 0) {
        this.db
          .prepare('UPDATE workflow_runs SET seed_finding_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(JSON.stringify(findingIds), runId);
      }

      // Native-task linkage + in-process stage derivation (migration 014).
      // No-op when no taskId was supplied or no deriver is wired. Wrapped in its
      // own try/catch so a task-side failure never aborts the run launch: the run
      // is already created + worktree built; the task overlay is best-effort.
      if (taskId && this.taskStageDeriver) {
        try {
          await this.linkRunToTaskAndDerive(runId, taskId, workflow, projectPath, branchName);
        } catch (taskErr) {
          this.logger.warn('RunLauncher: task stage derivation failed (run launch unaffected)', {
            runId,
            taskId,
            error: taskErr instanceof Error ? taskErr.message : String(taskErr),
          });
        }
      }

      // KEEP: synthetic run_started emission; closes a 50-500ms 'Waiting for events...'
      // gap before the first real SDK event arrives. RunExecutor is now wired (see
      // main/src/index.ts:580-589); real SDK events follow. Retained as UI-bootstrap aid.
      this.publisher?.publish(runId, {
        type: 'run_started',
        payload: {
          type: 'run_started',
          runId,
          worktreePath,
          branchName,
          // A/B testing (migration 048): surface the variant assignment immediately
          // so the UI can badge the run without an extra query. Omitted for a
          // baseline run.
          ...(rv !== null ? { variantLabel: rv.variantLabel } : {}),
        },
        timestamp: new Date().toISOString(),
      });

      // Enqueue the RunExecutor onto the per-run PQueue (fire-and-forget).
      // The void prefix and inner try/catch are load-bearing: launch() must
      // not block on the SDK run, and errors must not propagate to the caller.
      if (this.runExecutor && this.runQueueRegistry) {
        const executor = this.runExecutor;
        const queue = this.runQueueRegistry.getOrCreate(runId);
        void queue.add(async () => {
          try {
            await executor.execute(runId);
          } catch (err) {
            this.logger.error('[RunLauncher] RunExecutor.execute failed', {
              runId,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            });
          }
        });
      }

      this.logger.info('RunLauncher: run started', {
        runId,
        workflowId,
        worktreePath,
        branchName,
      });

      return { runId, worktreePath, branchName, permissionMode };
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      try {
        this.db
          .prepare(
            "UPDATE workflow_runs SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
          .run(errMsg, runId);
      } catch (dbErr) {
        this.logger.error('RunLauncher: failed to mark run as failed after launch error', {
          runId,
          originalError: errMsg,
          dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
      this.logger.error('RunLauncher: launch failed', { runId, workflowId, error: errMsg });
      throw err;
    }
  }

  /**
   * Resolve the worktree a SESSION-HOSTED run executes inside (session<->run
   * restructure, Phase 1). Instead of creating a dedicated worktree the run
   * reuses the owning session's existing tree, read from the `sessions` row.
   *
   * The run's branch_name is resolved from the session worktree's CURRENT branch
   * (the live HEAD ref the session is checked out on); if that cannot be read it
   * falls back to the session's recorded base_branch. (The `sessions` table has
   * no branch_name column — see migration history — so we derive it here.)
   *
   * Throws a clear Error when the session row or its worktree_path is missing so
   * the launch fails loudly rather than silently creating a stray worktree.
   */
  private async resolveSessionHostedWorktree(
    runId: string,
    sessionId: string,
  ): Promise<{ worktreePath: string; branchName: string }> {
    const sessionRow = this.db
      .prepare('SELECT worktree_path, base_branch, in_place, is_main_repo FROM sessions WHERE id = ?')
      .get(sessionId) as
      | {
          worktree_path: string | null;
          base_branch: string | null;
          in_place: number | null;
          is_main_repo: number | null;
        }
      | undefined;

    if (!sessionRow) {
      throw new Error(`RunLauncher.launch: session ${sessionId} not found (cannot host run ${runId})`);
    }
    // Workflow runs ALWAYS execute in an isolated worktree session. An in-place
    // session (migration 047) shares the user's real checkout, and the singleton
    // is_main_repo dashboard session has no dedicated worktree either — neither can
    // host a run without mutating unrelated tracked files. This single seam covers
    // runs.start / runs.restart / programmatic callers; the __quick__ sentinel never
    // traverses launch, so quick sessions (in-place or not) are unaffected.
    if (sessionRow.in_place || sessionRow.is_main_repo) {
      throw new Error(
        `RunLauncher.launch: session ${sessionId} works directly in the project checkout (in-place) — workflow runs require an isolated worktree session`,
      );
    }
    if (!sessionRow.worktree_path) {
      throw new Error(
        `RunLauncher.launch: session ${sessionId} has no worktree_path (cannot host run ${runId})`,
      );
    }
    const worktreePath = sessionRow.worktree_path;

    // Resolve the run's branch from the session worktree's current branch; fall
    // back to the session's recorded base_branch when the live ref is unreadable.
    let branchName: string | null = sessionRow.base_branch ?? null;
    try {
      branchName = await this.worktreeManager.getProjectMainBranch(worktreePath);
    } catch (err) {
      this.logger.warn('RunLauncher: could not read session worktree branch; falling back to base_branch', {
        runId,
        sessionId,
        worktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!branchName) {
      throw new Error(
        `RunLauncher.launch: could not resolve a branch for session ${sessionId} worktree ${worktreePath}`,
      );
    }

    return { worktreePath, branchName };
  }

  /**
   * Link a freshly-launched run to its native task, capture the run's launch
   * snapshot (base_branch / base_sha / steps_snapshot_json), capture the task's
   * planning entry stage the FIRST time it enters execution, then recompute the
   * task's derived execution stage.
   *
   * Ordering rationale:
   *   1. Resolve base_branch + the step->agent snapshot (best-effort; failures
   *      degrade to null, never abort the launch).
   *   2. UPDATE workflow_runs with task_id + the triage columns. This is a
   *      `workflow_runs` write (NOT a `tasks` write) so it is done inline — the
   *      no-direct-`tasks`-write invariant only governs the `tasks` table.
   *   3. If the task currently sits in an ASSERTED, non-terminal planning stage
   *      and has no entry_stage_id yet, capture it via applyChange (chokepoint),
   *      so a later revert (dismiss / all-runs-terminal) restores it.
   *   4. recomputeTaskExecutionStage — the derived-stage write, also via the
   *      chokepoint. At launch the run is `starting`; the executor's pre_spawn
   *      transition advances it to `running`, at which point the executor calls
   *      recompute again to land the task on `In development`.
   */
  private async linkRunToTaskAndDerive(
    runId: string,
    taskId: string,
    workflow: { name: string; spec_json?: string | null },
    projectPath: string,
    branchName: string,
  ): Promise<void> {
    const deriver = this.taskStageDeriver;
    if (!deriver) return;

    // (1) Best-effort launch snapshot. base_sha is a future-only triage field and
    // has no public WorktreeManager accessor exposed here, so it stays null for now.
    let baseBranch: string | null = null;
    try {
      baseBranch = await this.worktreeManager.getProjectMainBranch(projectPath);
    } catch (err) {
      this.logger.warn('RunLauncher: could not resolve base branch for task triage snapshot', {
        runId,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const stepsSnapshotJson = this.buildStepsSnapshotJson(runId, workflow);

    // (2) workflow_runs linkage + triage columns (NOT a `tasks` write).
    this.db
      .prepare(
        `UPDATE workflow_runs
            SET task_id = ?, base_branch = ?, base_sha = ?, steps_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(taskId, baseBranch, null, stepsSnapshotJson, runId);

    // (3) Entry-stage capture: only when the task is in an asserted, non-terminal
    // planning stage and entry_stage_id is still null. Routed through the chokepoint.
    const stageInfo = this.db
      .prepare(
        `SELECT t.project_id AS project_id, t.stage_id AS stage_id, t.entry_stage_id AS entry_stage_id,
                s.write_policy AS write_policy, s.is_terminal AS is_terminal
           FROM tasks t
           JOIN board_stages s ON s.id = t.stage_id
          WHERE t.id = ?`,
      )
      .get(taskId) as
      | {
          project_id: number;
          stage_id: string;
          entry_stage_id: string | null;
          write_policy: 'asserted' | 'derived';
          is_terminal: number;
        }
      | undefined;

    if (
      stageInfo &&
      stageInfo.entry_stage_id === null &&
      stageInfo.write_policy === 'asserted' &&
      stageInfo.is_terminal !== 1
    ) {
      await deriver.applyChange(stageInfo.project_id, {
        actor: 'orchestrator',
        taskId,
        runId,
        kind: 'entry-stage-capture',
        fields: { entryStageId: stageInfo.stage_id },
      });
    }

    // (4) Derived execution-stage recompute (chokepoint, actor='orchestrator').
    await deriver.recomputeTaskExecutionStage(taskId);

    this.logger.info('RunLauncher: linked run to task + derived execution stage', {
      runId,
      taskId,
      baseBranch,
      branchName,
    });
  }

  /**
   * Build the frozen step->agent map persisted in workflow_runs.steps_snapshot_json.
   *
   * A/B testing (migration 048): resolves the run's FROZEN effective definition via
   * resolveRunFrozenSpec — a VARIANT run's snapshot must describe ITS graph, not the
   * live workflow spec_json (the snapshot's consumers are load-bearing: runIsPlanGated
   * → pending/hidden + reveal + delete-gate, board current-agent display). Falls back
   * to the passed-in workflow's live spec (then null) so a legacy / no-hash run is
   * byte-identical to before. Returns null when no definition resolves — the overlay
   * reader falls back to current_step_id then 'agent'.
   */
  private buildStepsSnapshotJson(
    runId: string,
    workflow: { name: string; spec_json?: string | null },
  ): string | null {
    const frozen = resolveRunFrozenSpec(this.db, runId);
    const name = frozen?.workflowName ?? workflow.name;
    const specJson = frozen?.specJson ?? workflow.spec_json ?? null;
    const definition = resolveWorkflowDefinition(name, specJson);
    if (!definition) return null;
    const map: Record<string, string> = {};
    for (const phase of definition.phases) {
      for (const step of phase.steps) {
        map[step.id] = step.agent;
      }
    }
    return JSON.stringify(map);
  }

  /**
   * Idempotently ensure `.cyboflow/worktrees/` is present in the project's
   * `.gitignore`.  Three cases:
   *   - File missing   → create it with the single entry
   *   - Entry absent   → append the entry (preserving existing content)
   *   - Entry present  → no-op
   */
  async ensureGitignoreEntry(projectPath: string): Promise<void> {
    const gitignorePath = path.join(projectPath, '.gitignore');
    const targetLine = '.cyboflow/worktrees/';

    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw e;
      // .gitignore does not exist — create it with just the target line
      await fs.writeFile(gitignorePath, targetLine + '\n', 'utf-8');
      this.logger.info(`RunLauncher: created ${gitignorePath} with .cyboflow/worktrees/ entry`);
      return;
    }

    // Match the line exactly (with or without trailing slash)
    const lines = content.split(/\r?\n/);
    const present = lines.some(
      (l) => l.trim() === '.cyboflow/worktrees/' || l.trim() === '.cyboflow/worktrees',
    );
    if (present) return;

    // Append — ensure there's a newline separator before the new line
    const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
    await fs.writeFile(gitignorePath, content + suffix + targetLine + '\n', 'utf-8');
    this.logger.info(`RunLauncher: appended .cyboflow/worktrees/ to ${gitignorePath}`);
  }
}
