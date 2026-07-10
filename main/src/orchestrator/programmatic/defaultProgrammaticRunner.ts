/**
 * DefaultProgrammaticRunner — the production `ProgrammaticRunner` that RunExecutor
 * delegates a programmatic run to. It assembles the per-run engine: resolve the
 * run's DAG (the SAME `WorkflowDefinition` the orchestrated model uses), build a
 * SpawnStepRunner (scoped agent turns) + a ProgrammaticRunHost (timeline + human
 * gates + optional monitor triage), drive the WorkflowController, then map the
 * terminal outcome onto the spawn contract RunExecutor expects:
 *
 *   - 'completed' → resolve (the run rests in awaiting_review).
 *   - 'rejected'  → resolve (a human declined a gate — a terminal human decision,
 *                   NOT an execution failure; the run rests for the user).
 *   - 'failed'    → throw (RunExecutor marks the run failed, identical to a
 *                   thrown orchestrator turn).
 *
 * The monitor-unify refactor folds the old Stage 3 supervisor + supervisor-chat
 * planes into a single ON-DEMAND `MonitorSession`, ALWAYS ON for programmatic runs
 * since the supervisor-role redesign (2026-07-05). When a `monitorFactory` is
 * provided the runner builds the monitor for the run, registers it in
 * `MonitorRegistry` (so the tRPC layer / renderer can reach it for chat), and
 * passes both the monitor and the run context's `injectEvent` into the host so
 * triage rationale renders in the run's existing Chat pane. There is NO separate
 * transcript store and NO continuous feed.
 *
 * The stateless collaborators (spawner, reporter, gate) are injected once at the
 * composition root; per-run state is bound inside run().
 */
import { resolveWorkflowDefinition } from '../../../../shared/types/workflows';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { ClaudeSpawnerLike, ProgrammaticRunner, ProgrammaticRunContext } from '../runExecutor';
import type { LoggerLike } from '../types';
import type { FanOutDriver, StepReport, VisualVerifyGate } from './types';
import { WorkflowController } from './workflowController';
import { createRunDirectives } from './runDirectives';
import { SpawnStepRunner } from './spawnStepRunner';
import { ProgrammaticRunHost, type StepReporter } from './programmaticRunHost';
import type { HumanGateResolver } from './humanGate';
import type { BlockingItemsResolver } from './blockingItemsGate';
import type { SystemicPauseResolver } from './systemicPauseGate';
import { MonitorRegistry, type MonitorContext, type MonitorSession } from './monitor';

export interface DefaultProgrammaticRunnerDeps {
  spawner: ClaudeSpawnerLike;
  reporter: StepReporter;
  gate: HumanGateResolver;
  /**
   * Blocking-review-items checkpoint (Fix: blocking findings must block). Threaded
   * verbatim into every run's ProgrammaticRunHost so the controller parks the run
   * at each step boundary while a pending blocking review_item exists. Absent ⇒ no
   * parking for review items (byte-identical to today).
   */
  blockingGate?: BlockingItemsResolver;
  /**
   * Systemic-pause gate (the 2026-07-06 planner-incident fix). Threaded verbatim
   * into every run's ProgrammaticRunHost so a systemic step failure (usage/session/
   * rate limit, provider overload, auth) PARKS the run behind a blocking pause item
   * and re-runs the step once the condition clears (a human resolve or the
   * auto-resume timer) WITHOUT consuming the step's retry/skip/loopback/triage
   * budgets — instead of burning them and failing the whole run. Absent ⇒ systemic
   * failures follow the normal failure path (byte-identical to today).
   */
  systemicGate?: SystemicPauseResolver;
  /**
   * Per-run monitor factory (the monitor-unify refactor). Called once per run to
   * build the ON-DEMAND monitor brain (triage + chat answer). When present the
   * monitor is registered in `MonitorRegistry` and wired into the host so a required
   * step's exhausted failure is triaged WITH full history and its rationale renders
   * in the run's Chat pane. Absent — or returning undefined for this run — ⇒ no
   * monitor: exhausted required failures 'escalate' to the human review queue with a
   * plain chat note. In production the factory ALWAYS returns a session (the
   * supervisor-role redesign, 2026-07-05 — the old `programmaticSupervisor` config
   * opt-in is gone); the undefined arm exists for tests and defensive wiring.
   *
   * The run context's `injectEvent` (Slice B) is threaded as the SECOND arg so the
   * built session OWNS its chat-inject capability (its `converse` renders the human
   * turn + the monitor's reply into the run's Chat pane — the tRPC `monitor.send`
   * seam, Slice E). The registry still stores the bare `MonitorSession`, so the
   * router reaches both `answer` and `converse` through one entry.
   */
  monitorFactory?: (
    ctx: MonitorContext,
    injectEvent: (event: ClaudeStreamEvent) => void,
  ) => MonitorSession | undefined;
  /**
   * Per-step result sink (migration 033). When present, each settled step is
   * persisted (in production via StepResultStore.record) for queryable results +
   * crash-safe resume. Absent ⇒ results live only in the returned trace.
   */
  stepResultRecorder?: (runId: string, report: StepReport) => void;
  /**
   * Fan-out lane substrate (optional). Builds a per-run `FanOutDriver` bound to a
   * batch_id (sprint-lane backed in production). Invoked LAZILY — by the host's
   * `fanOut` provider, at the moment the controller first consults `host.fanOut`
   * with a non-empty batchId in hand — NOT once at run start (see
   * `readRunBatchId` below for why a one-shot call is unsafe for `ship`). Never
   * invoked at all when the run never resolves a batchId (byte-identical to
   * today for a plain orchestrated/non-sprint run). A factory that itself returns
   * undefined (e.g. no batch) likewise yields no host-driven fan-out.
   */
  fanOutDriverFactory?: (ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined;
  /**
   * LIVE `workflow_runs.batch_id` reader (generalize-parallel-fan-out follow-up —
   * fixes a confirmed silent no-op). `ctx.run.batch_id` is a SNAPSHOT taken once
   * when RunExecutor read the run row at the top of `execute()`. `ship`'s
   * materialize-batch step stamps `batch_id` MID-RUN (via the
   * `cyboflow_create_sprint_batch` MCP tool's `UPDATE workflow_runs SET batch_id=...
   * WHERE id=? AND batch_id IS NULL`, main/src/orchestrator/mcpServer/
   * mcpQueryHandler.ts), strictly AFTER this run() snapshots `ctx.run.batch_id` and
   * BEFORE the SAME walk reaches execute-tasks — so the snapshot never observes
   * the stamp and the fanOut step silently degrades to a single agent step. The
   * fan-out driver provider built below calls this fresh on every consult until a
   * driver is successfully resolved (then memoizes — batch_id only ever
   * transitions null → non-null, never un-stamped, so no more reads are needed).
   * Absent ⇒ the provider falls back to the one-shot `ctx.run.batch_id` snapshot
   * (today's behavior — byte-identical for `sprint`, which stamps batch_id at
   * LAUNCH before this run() is ever called, and for any test host that does not
   * care about a mid-run stamp).
   */
  readRunBatchId?: (runId: string) => string | null;
  /**
   * Visual merge-gate resolver (programmatic actuation). A single stateless
   * instance (it resolves run/lane state per call) threaded onto the host so the
   * controller can park + await the async visual verdict after a lane's
   * visual-verify step. Only consulted inside a sprint fan-out when verification is
   * active for the run; absent ⇒ the controller never parks (byte-identical to today).
   */
  visualGate?: VisualVerifyGate;
  /**
   * Sprint task-scope provider (grounding fix, 2026-06-22). Called once per
   * sprint-style run (a non-empty `batch_id`) to resolve the `# Sprint tasks`
   * block body — the SAME text the orchestrated `getPrompt` path prepends. The
   * runner threads the result into every step prompt via SpawnStepRunner so the
   * step agent always sees the real task set (programmatic step prompts otherwise
   * carry none, which made the analyze-dependencies agent conclude "No
   * dependencies" and the dependents fail). Absent / returns null ⇒ no task block.
   */
  seedTasksProvider?: (batchId: string) => string | null;
  logger?: LoggerLike;
}

export class DefaultProgrammaticRunner implements ProgrammaticRunner {
  constructor(private readonly deps: DefaultProgrammaticRunnerDeps) {}

  async run(ctx: ProgrammaticRunContext): Promise<void> {
    const def = resolveWorkflowDefinition(ctx.workflow.name, ctx.workflow.spec_json);
    if (!def) {
      throw new Error(
        `DefaultProgrammaticRunner: no resolvable workflow definition for run ${ctx.runId} (workflow '${ctx.workflow.name}')`,
      );
    }

    // A seeded sprint (non-empty batch_id) threads its `# Sprint tasks` block into
    // every step prompt so the step agent always sees the real task set. The block
    // is resolved PER STEP (a thunk, not a run-start snapshot) so a lane the monitor
    // adds mid-run — dispatched by the fan-out's wave-boundary re-resolution — is
    // grounded with its real title/body on first dispatch. buildSeedTasksBlock reads
    // the batch's lanes live, so re-invoking it picks up the added lane. Non-sprint
    // runs ⇒ no block.
    const batchId =
      typeof ctx.run.batch_id === 'string' && ctx.run.batch_id.length > 0 ? ctx.run.batch_id : null;
    const taskScope = batchId
      ? () => this.deps.seedTasksProvider?.(batchId) ?? undefined
      : undefined;

    // Live operator steering for this run (RunDirectives). RunExecutor owns the
    // per-run object and threads it in; absent (tests / no monitor wiring) ⇒ an
    // empty no-op set so the walk is byte-identical. Read by reference at the
    // controller loop head (skip) and by the SpawnStepRunner stepGuidance thunk
    // (steer) below — both re-read live, so a mutation lands on the next turn.
    const directives = ctx.directives ?? createRunDirectives();

    const runner = new SpawnStepRunner(
      this.deps.spawner,
      {
        panelId: ctx.panelId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        worktreePath: ctx.worktreePath,
        workflowName: ctx.workflow.name,
        // Per-step resolver (permission-mode redesign §3c#2): SpawnStepRunner
        // invokes this each step, reading the run's session-resolved mode off the
        // context rather than the demoted `permission_mode_snapshot` audit column.
        agentPermissionMode: () => ctx.agentPermissionMode,
        // Per-step operator-guidance resolver (RunDirectives live steering): read
        // this step's guidance off the SAME directives object each turn.
        stepGuidance: (stepId) => directives.stepGuidance.get(stepId),
        ...(taskScope ? { taskScope } : {}),
      },
      this.deps.logger,
    );

    // ON-DEMAND monitor (the monitor-unify refactor): when a factory is wired, build
    // the monitor for this run + register it so the tRPC/renderer can reach it for
    // chat. Absent ⇒ no monitor (the host escalates exhausted failures to the human
    // queue — the default review-queue behavior).
    const monitor = this.deps.monitorFactory?.(
      {
        runId: ctx.runId,
        projectId: ctx.run.project_id,
        workflowName: ctx.workflow.name,
        worktreePath: ctx.worktreePath,
      },
      ctx.injectEvent,
    );
    if (monitor) {
      MonitorRegistry.getInstance().register(ctx.runId, monitor);
    }

    // Host-driven fan-out (programmatic plane): resolve the per-run lane driver
    // LAZILY via a provider, not once here — see `readRunBatchId`'s docblock for
    // why a one-shot resolution silently drops `ship`'s mid-run batch_id stamp.
    // `resolvedFanOutDriver` memoizes the first successful build so a settled
    // driver is a cheap in-memory return on every later consult instead of a
    // repeat DB read + factory call.
    let resolvedFanOutDriver: FanOutDriver | undefined;
    const fanOutDriverProvider = (): FanOutDriver | undefined => {
      if (resolvedFanOutDriver) return resolvedFanOutDriver;
      const liveBatchId = this.deps.readRunBatchId ? this.deps.readRunBatchId(ctx.runId) : batchId;
      if (!liveBatchId) return undefined;
      resolvedFanOutDriver = this.deps.fanOutDriverFactory?.({ runId: ctx.runId, batchId: liveBatchId });
      return resolvedFanOutDriver;
    };

    const host = new ProgrammaticRunHost({
      runId: ctx.runId,
      projectId: ctx.run.project_id,
      reporter: this.deps.reporter,
      gate: this.deps.gate,
      ...(this.deps.blockingGate ? { blockingGate: this.deps.blockingGate } : {}),
      ...(this.deps.systemicGate ? { systemicGate: this.deps.systemicGate } : {}),
      ...(monitor ? { monitor } : {}),
      injectEvent: ctx.injectEvent,
      ...(this.deps.stepResultRecorder ? { recordStepResult: this.deps.stepResultRecorder } : {}),
      fanOutDriverProvider,
      // The visual merge-gate is inert until a fan-out step actually runs (which
      // itself requires the provider above to have resolved a driver), so it is
      // wired unconditionally rather than gated on a driver existing AT
      // CONSTRUCTION TIME — under lazy resolution that may not happen until well
      // into the walk (see ProgrammaticRunHostArgs.visualGate's docblock).
      ...(this.deps.visualGate ? { visualGate: this.deps.visualGate } : {}),
      logger: this.deps.logger,
    });

    // NOTE: the monitor is intentionally NOT unregistered when the walk ends. The
    // on-demand brain has no live session to tear down (each query is one-shot), and
    // it must stay reachable AFTER the walk so the user can chat with it about a run
    // resting in awaiting_review (or sitting failed / canceled-but-kept). It is
    // unregistered + its inject plumbing disposed at TERMINAL close-out (merge /
    // createPr / dismiss) by the composition-root close-out wiring
    // (RunExecutor.disposeMonitorResources + MonitorRegistry.unregister).
    const result = await new WorkflowController(runner, host).run(
      ctx.runId,
      def,
      ctx.signal,
      ctx.resumeFromStepId,
      ctx.completedStepIds,
      directives,
    );

    if (result.outcome === 'failed') {
      throw new Error(
        `DefaultProgrammaticRunner: run ${ctx.runId} failed at step '${result.failedStepId ?? '?'}'`,
      );
    }
    // 'canceled' resolves (NOT throws) — the cancel path owns the terminal DB
    // transition; RunExecutor.executeProgrammatic skips its 'drained' rest when
    // the signal aborted. 'completed' / 'rejected' also rest for the user.

    this.deps.logger?.info('[ProgrammaticRunner] programmatic run finished', {
      runId: ctx.runId,
      outcome: result.outcome,
      steps: result.steps.length,
    });
  }
}
