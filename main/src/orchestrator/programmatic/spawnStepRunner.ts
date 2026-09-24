/**
 * SpawnStepRunner — the SDK-backed `StepRunner` (Stage 2). Runs one workflow
 * step as a scoped agent turn via the existing spawn surface
 * (`ClaudeSpawnerLike.spawnCliProcess`, in production the SubstrateDispatchFacade
 * → ClaudeCodeManager). `spawnCliProcess` resolves when the agent's turn drains
 * cleanly (⇒ step ok) and rejects when the turn errors (⇒ step failed), so the
 * run mapping is a thin try/catch. Reusing the existing spawn path means the
 * run's MCP servers, agent overlay, worktree, and permission mode are all set up
 * exactly as for an orchestrated turn — only the prompt is narrowed to one step
 * (see composeStepPrompt).
 *
 * CANCELLATION: the SDK substrate treats an aborted query() as a CLEAN exit, so a
 * canceled turn RESOLVES spawnCliProcess (it does NOT reject). Inferring success
 * purely from a resolved promise would therefore misread a cancel as 'ok' and let
 * the controller keep walking. So after the spawn settles we consult the injected
 * AbortSignal: if it fired, the result is 'aborted' (the controller ends the walk
 * with a 'canceled' outcome) — distinct from a genuine 'failed' turn that retries
 * / loops back. A signal already aborted BEFORE the spawn short-circuits to
 * 'aborted' without spawning. A genuine (non-canceled) failure is additionally
 * classified via isSystemicStepError: when the error text signals an
 * environment-level condition (usage/session/rate limit, provider overload,
 * auth) the result is stamped `systemic: true` so the controller parks-and-waits
 * on that condition instead of burning the step's retry/optional/loopback budget.
 *
 * Constructed per-run by DefaultProgrammaticRunner with the run's panel/session/
 * worktree bound, then invoked once per step by the WorkflowController.
 */
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { ClaudeSpawnerLike } from '../runExecutor';
import type { LoggerLike } from '../types';
import type { StepRunner, StepRunResult, ControllerStepContext } from './types';
import { composeStepPrompt } from './stepPrompt';
import type { SolutionThoroughness } from '../../../../shared/types/thoroughness';
import { isSystemicStepError } from './systemicError';
import type { WorkflowStep, WorkflowDefinition } from '../../../../shared/types/workflows';
import { definitionHasControllerVisualVerify } from '../laneChainResolution';
import { providerForRuntime, type WorkflowAgentRuntime } from '../../../../shared/types/agentRuntime';
import { normalizeEffortSelection, type ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
import { resolveStepSpawnTarget } from '../stepSpawnTarget';
import {
  renderWorkflowPromptForRuntime,
  type RoleBrief,
  type WorkflowPromptRenderContext,
} from '../workflowPromptRenderer';

/**
 * SDK tools denied on the step turns of a programmatic run whose controller owns
 * the visual-verification enqueue (the agentless visual-verify step in
 * workflowController.ts) — a step turn firing `cyboflow_request_verification`
 * itself creates an unkeyed request the controller never made and races the
 * merge-gate against the contract-retry loop (observed on the first live run,
 * 2026-07-22: the task-verify turn fired the request, self-parked the lane, and
 * the lane failed despite a delivered PASS). Constant across a run's turns so the
 * warm-session options fingerprint never recycles over it. Orchestrated runs
 * never pass through this runner, so the orchestrator's legitimate use of the
 * tool is unaffected.
 *
 * NOT applied to every programmatic run — see
 * {@link programmaticDisallowedTools}. "Programmatic" was a proxy for "the
 * controller enqueues"; `verify-setup` is programmatic with no controller-owned
 * enqueue at all, and blanket-denying the tool made the flow that bootstraps
 * verification unable to fire the one verification it exists to fire.
 */
export const PROGRAMMATIC_STEP_DISALLOWED_TOOLS: readonly string[] = [
  'mcp__cyboflow__cyboflow_request_verification',
];

/** Frozen empty deny list — a run with no controller-owned enqueue denies nothing. */
const NO_DISALLOWED_TOOLS: readonly string[] = [];

/**
 * The deny list for THIS run's step turns: {@link PROGRAMMATIC_STEP_DISALLOWED_TOOLS}
 * when the run's workflow has a controller-owned visual-verify step (sprint/ship
 * and any chain that kept one), otherwise nothing.
 *
 * The spawn seam drops an EMPTY `disallowedTools` entirely
 * (claudeCodeManager checks `.length > 0`), so a run with no controller-owned
 * enqueue spawns byte-identically to one from before this deny list existed.
 */
export function programmaticDisallowedTools(def: WorkflowDefinition): readonly string[] {
  return definitionHasControllerVisualVerify(def) ? PROGRAMMATIC_STEP_DISALLOWED_TOOLS : NO_DISALLOWED_TOOLS;
}

/** Per-run spawn parameters bound when the runner is constructed. */
export interface SpawnStepRunnerOptions {
  panelId: string;
  sessionId: string;
  runId: string;
  worktreePath: string;
  workflowName: string;
  /**
   * Per-spawn tool deny list for THIS run's step turns — normally
   * {@link programmaticDisallowedTools}(the run's resolved definition), which
   * denies `cyboflow_request_verification` only when the controller owns the
   * enqueue. Captured at construction (not per step): the run's definition is
   * frozen, and a value that varied per turn would recycle the warm-session
   * options fingerprint.
   *
   * OMITTED ⇒ {@link PROGRAMMATIC_STEP_DISALLOWED_TOOLS}, the pre-scoping
   * deny-everything posture. The unwired default is the CONSERVATIVE one so a
   * caller that never learned about this option cannot accidentally open the
   * merge-gate race; DefaultProgrammaticRunner always passes the scoped list.
   */
  disallowedTools?: readonly string[];
  /**
   * Per-step agent-permission-mode RESOLVER (permission-mode redesign §3c#2).
   * Invoked ONCE per `runStep` (NOT captured at construction) so each step turn
   * spawns under the mode resolved at step time rather than a value frozen when
   * the runner was built — the session is the live execution authority.
   * `undefined` (the thunk absent OR returning undefined) ⇒ no override threaded
   * to the spawn (byte-identical to the no-mode path).
   */
  agentPermissionMode?: () => PermissionMode | undefined;
  /**
   * Per-step operator-GUIDANCE resolver (RunDirectives live steering). Invoked
   * ONCE per `runStep` (NOT captured at construction), mirroring the
   * `agentPermissionMode` thunk pattern above, so guidance the operator adds
   * mid-run is honored on the step's NEXT spawn. Returns the guidance text for
   * this step id (appended to the composed prompt) or `undefined` (the thunk
   * absent OR returning undefined ⇒ no guidance section — byte-identical to the
   * no-guidance path). Wired by DefaultProgrammaticRunner to the run's
   * RunDirectives `stepGuidance` map.
   */
  stepGuidance?: (stepId: string) => string | undefined;
  /**
   * Per-step SUPERVISOR RETRY-guidance resolver. Same thunk shape as
   * `stepGuidance` above and invoked ONCE per `runStep`, but the thunk the runner
   * wires CONSUMES its entry (reads then deletes it from
   * `RunDirectives.retryGuidance`), so the guidance reaches exactly the ONE
   * attempt the supervisor's triage bought and no later spawn of the same step.
   * Rendered as its own section AFTER the operator's `stepGuidance`, which is
   * untouched and still sticky. Absent (or returning undefined) ⇒ no section —
   * byte-identical to the no-guidance path.
   */
  retryGuidance?: (stepId: string) => string | undefined;
  /**
   * Per-step sprint TASK-SCOPE resolver (the `# Sprint tasks` body). Invoked ONCE
   * per `runStep` (NOT captured at construction), mirroring the `agentPermissionMode`
   * / `stepGuidance` thunks above, so the block is RE-RENDERED from the run's live
   * batch each step. This is load-bearing for mid-run `add_task`: a lane added
   * after run start is dispatched by the fan-out's wave-boundary re-resolution, and
   * re-rendering here means its title/body appear in the scope block the step agent
   * sees (a run-start snapshot would list only the original tasks, leaving the added
   * lane grounded by opaque id alone). Absent for non-sprint runs, or returning
   * undefined ⇒ no task block (output unchanged).
   */
  taskScope?: () => string | undefined;
  /**
   * Per-step run-owned IDEA scope. Resolves the ids from the run's authoritative
   * ownership projection (seed idea plus ideas created during this run). It is a
   * thunk because Ship may create its idea during context, after this runner was
   * constructed but before its optional design steps run.
   */
  runOwnedIdeaIds?: () => readonly string[];
  /**
   * The run's resolved approve-ideas gate decisions, as pre-rendered verdict
   * lines (readApproveIdeasDecisionLines). A thunk re-read per step: it returns
   * undefined until the human resolves the batch gate, then every LATER step
   * turn carries the `# Approve-ideas decisions` block so post-gate steps know
   * which ideas were denied. Absent ⇒ no section (byte-identical prompts).
   */
  approveIdeasDecisions?: () => string | undefined;
  /**
   * The run's approved project-brief artifact markdown (launch flow). A thunk
   * re-read per step: undefined until the brief is reported (pre-brief steps
   * and non-launch flows), then every later step turn carries the
   * `# Project brief` grounding section — a programmatic step agent has no MCP
   * surface to read artifacts. Absent ⇒ no section (byte-identical prompts).
   */
  projectBrief?: () => string | undefined;
  /**
   * The `# Design surfaces` block for this sprint/ship run (composeDesignSurfaces).
   * A thunk re-read per step for the same reason taskScope is: a lane the monitor
   * adds mid-run brings its own originating idea, and a run-start snapshot would
   * omit that idea's design. Undefined on every run with no batch or no approved
   * design ⇒ no section (byte-identical prompts).
   */
  designSurfaces?: () => string | undefined;
  /**
   * The run's `adversarial-review` artifact markdown, read per step. Consumed
   * ONLY by the gate-revision section — a step re-driven by an approve-design
   * 'revise' has no memory of the critique it must address — so it is resolved
   * lazily there rather than rendered on every turn.
   *
   * `opts.reportedSinceMs` is the revision's snapshot of the walk's review
   * freshness bound: a critique last reported before it belongs to a PREVIOUS
   * round and reads as absent, so the quote never contradicts the gate body the
   * human actually answered. Omitted ⇒ unbounded, exactly as before.
   */
  adversarialReviewMarkdown?: (opts?: { reportedSinceMs?: number }) => string | undefined;
  /**
   * The project's declared solution thoroughness. A thunk re-read per step: on a
   * launch run the level comes off the brief, which only exists from the
   * project-brief step onward, so a construction-time snapshot would be undefined
   * for the whole run. Absent ⇒ no section (byte-identical prompts).
   */
  solutionThoroughness?: () => SolutionThoroughness | undefined;
  /**
   * The verify-setup run's approved runbook-proposal markdown, and the raw
   * `approve-runbook` gate resolution. Thunks re-read per step: both are
   * undefined on `inspect`/`derive` (which run before the artifact and the gate
   * exist) and on every other flow, so only `prove` carries them. Absent ⇒ no
   * section (byte-identical prompts).
   */
  runbookProposal?: () => string | undefined;
  approveRunbookResolution?: () => string | undefined;
  /**
   * The COMPOUND run's human-curated `# Selected findings` block body (migration
   * 034's `seed_finding_ids`, rendered). A thunk for consistency with every other
   * resolver here, though the seed itself is stamped at launch and never changes
   * mid-run. Undefined on an unseeded compound run and on every other flow ⇒ no
   * section and no seeded branch (byte-identical prompts).
   */
  selectedFindings?: () => string | undefined;
  /**
   * Provider/runtime prompt envelope for this run. Claude is identity; Codex gets
   * the compatibility adapter around each fresh per-step prompt.
   */
  promptRenderContext?: WorkflowPromptRenderContext;
  /** Provider-scoped model pinned on the owning workflow run. */
  model?: string;
  /**
   * Per-step agent RUNTIME resolver (Codex-per-step mixing). Invoked ONCE per
   * `runStep` (NOT captured at construction), mirroring the `agentPermissionMode`/
   * `stepGuidance` thunks above, so a workflow-scoped agent config edited mid-run
   * is honored on the step's next spawn. Returns the step's canonical agent key's
   * runtime/model/codexModel or `undefined` (the thunk absent, the step's `agent`
   * resolving to no canonical key — e.g. the `human` gate — or the resolved agent
   * carrying no override at all) ⇒ no per-spawn override, so the spawn falls back
   * to the run-level provider/runtime resolution (byte-identical to today).
   *
   * `model` is the resolved CONCRETE Claude model id (the caller resolves the
   * alias via modelContext.bareModelId), used for a Claude-runtime step. It is
   * the ONLY channel a per-agent Claude model pin has on this plane: a
   * programmatic step turn IS the agent (a top-level spawn), so the agent
   * overlay's `model:` frontmatter — which binds only when the CLI dispatches a
   * subagent — never applies here.
   *
   * `providerModel` is the model id for the step's resolved NON-CLAUDE provider
   * (already normalized `providerModel ?? codexModel` by the caller);
   * `codexModel` mirrors it for a not-yet-migrated reader.
   */
  /**
   * Repo paths this run's RUNBOOK BOOTSTRAP wrote
   * (docs/proposals/lane-runbook-bootstrap.md §11). Re-resolved PER STEP, like
   * every other thunk here, because the bootstrap fires mid-run — a value
   * captured at construction would be empty for the run that actually needs it.
   * Only the address-review step renders it.
   */
  bootstrapProtectedPaths?: () => readonly string[];
  resolveStepAgent?: (agentKey: string) =>
    | {
        runtime?: WorkflowAgentRuntime;
        model?: string;
        providerModel?: string;
        codexModel?: string;
        effort?: ReasoningEffort;
      }
    | undefined;
  /**
   * The run's resolved role prompts, inlined into a NON-Claude step's prompt
   * (Claude reads them from the installed `.claude/agents/` files instead).
   * Re-resolved per step like every thunk here; consulted only when the step
   * actually spawns off Claude, so a Claude step pays nothing.
   */
  resolveRoleBriefs?: () => readonly RoleBrief[];
}

/**
 * Dev lever: with `CYBOFLOW_FAKE_SYSTEMIC_STEP=<stepId>` set, returns the fake
 * error text a CLAUDE-provider spawn of that step should fail with
 * (`CYBOFLOW_FAKE_SYSTEMIC_ERROR` overrides the text; the default is the CLI's
 * epoch-suffixed subscription-limit shape, resetting two hours out so the
 * auto-resume timer is visibly armed). Null for every other step, for any
 * non-Claude provider, and whenever the lever is unset — the production path is
 * byte-identical.
 */
function fakeSystemicFailure(stepId: string, provider: string): string | null {
  const target = process.env.CYBOFLOW_FAKE_SYSTEMIC_STEP;
  if (!target || target !== stepId || provider !== 'claude') return null;
  const override = process.env.CYBOFLOW_FAKE_SYSTEMIC_ERROR;
  if (override) return override;
  const resetEpochSeconds = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  return `Claude AI usage limit reached|${resetEpochSeconds}`;
}

export class SpawnStepRunner implements StepRunner {
  constructor(
    private readonly spawner: ClaudeSpawnerLike,
    private readonly opts: SpawnStepRunnerOptions,
    private readonly logger?: LoggerLike,
  ) {}

  async runStep(step: WorkflowStep, ctx: ControllerStepContext): Promise<StepRunResult> {
    // Already canceled before we even spawn — short-circuit.
    if (ctx.signal?.aborted) return { status: 'aborted' };

    // Re-resolve any operator guidance for this step PER STEP (RunDirectives live
    // steering) — never captured at construction — so guidance added mid-run is
    // honored on this step's next spawn, exactly like agentPermissionMode below.
    const userGuidance = this.opts.stepGuidance?.(step.id);
    // Read the supervisor's one-shot retry guidance for this step. The wired
    // thunk CONSUMES the entry, so this is the only spawn that ever sees it —
    // read it right after `userGuidance` so both guidance channels resolve at the
    // same point in the step's life, even though only one of them is sticky.
    const retryGuidance = this.opts.retryGuidance?.(step.id);
    // Re-render the sprint task-scope block PER STEP (never captured at
    // construction) so a lane added mid-run is grounded with its real title/body
    // on its first dispatch, exactly like userGuidance/agentPermissionMode.
    const taskScope = this.opts.taskScope?.();
    // Re-resolve the run-owned idea ids per step. This prevents conditional Ship
    // steps from inspecting unrelated project ideas and picks up ideas context
    // creates mid-run.
    const runOwnedIdeaIds = this.opts.runOwnedIdeaIds?.();
    // Re-read the approve-ideas gate decisions per step — undefined until the
    // human resolves the batch gate, then every later step turn carries them.
    const approveIdeasDecisions = this.opts.approveIdeasDecisions?.();
    // Re-read the project brief per step — undefined until the brief artifact
    // is reported, then every later step turn carries the grounding section.
    const projectBrief = this.opts.projectBrief?.();
    // Re-read the run's approved design surfaces per step — a mid-run lane brings
    // its own idea, so a construction-time snapshot would miss that idea's design.
    const designSurfaces = this.opts.designSurfaces?.();
    // Re-read the project's thoroughness per step — on launch it is parsed from a
    // brief that does not exist until mid-run.
    const solutionThoroughness = this.opts.solutionThoroughness?.();
    // A gate 'revise' threads the human's note onto the ctx; pair it with the
    // review the gate was composed from, which the re-run agent cannot otherwise
    // see (fresh turn, no artifact-reading MCP tool). Resolved ONLY when a
    // revision is actually in flight, so no other turn pays for the read.
    const gateRevision = ctx.gateRevision
      ? (() => {
          // A revision that already carries `reviewMarkdown` WINS: the controller
          // sets it only when it judged the run's artifact to be a previous
          // round's, so re-reading the artifact here would hand the re-run the
          // very document the controller just rejected. Absent (every human-gate
          // revision, and every automatic lap whose artifact was current) ⇒ read
          // the artifact, under the revision's snapshot of the walk's review
          // FRESHNESS bound. That bound is what keeps this read honest on the
          // other channel: an approve-design gate whose body was the "No
          // adversarial review this round" notice withheld the critique from the
          // human, so quoting it here as the feedback to act on would contradict
          // the very gate that armed this revision. No bound ⇒ unbounded, so
          // every pre-existing path stays byte-identical.
          const { reviewMarkdown: carried, reviewReportedSinceMs: bound, ...rest } = ctx.gateRevision;
          const reviewMarkdown =
            carried !== undefined && carried.trim().length > 0
              ? carried
              : this.opts.adversarialReviewMarkdown?.(
                  bound !== undefined ? { reportedSinceMs: bound } : undefined,
                );
          return {
            ...rest,
            ...(reviewMarkdown !== undefined && reviewMarkdown.trim().length > 0
              ? { reviewMarkdown }
              : {}),
          };
        })()
      : undefined;
    // Re-read the verify-setup proposal + gate note per step — undefined until
    // `derive` publishes the artifact and the human resolves the gate, so in
    // practice only `prove` receives them.
    const runbookProposal = this.opts.runbookProposal?.();
    const approveRunbookResolution = this.opts.approveRunbookResolution?.();
    // Re-read the compound run's human-curated seed per step. Undefined on every
    // unseeded compound run and on every other flow ⇒ no section, no seeded branch.
    const selectedFindings = this.opts.selectedFindings?.();
    // Re-resolve the bootstrap's written paths per step: the bootstrap fires
    // mid-run at a lane's visual-verify, so a value read at construction would be
    // empty on exactly the run that needs the denylist.
    const bootstrapProtectedPaths = this.opts.bootstrapProtectedPaths?.();
    // Re-resolve this step's agent RUNTIME per step (Codex-per-step mixing) —
    // never captured at construction, mirroring the resolvers above — so a
    // workflow-scoped agent config edited mid-run is honored on this step's next
    // spawn. `resolveStepAgentKey` returns null for the `human` gate, which the
    // resolver is never consulted for.
    const agentKey = resolveStepAgentKey(step.id, step.agent);
    const stepAgent = agentKey ? this.opts.resolveStepAgent?.(agentKey) : undefined;
    // The provider + model this step ACTUALLY spawns on — the per-step runtime
    // override's provider when present, else the run-level provider, and a model
    // that BELONGS to that provider (the per-agent pin for the matching provider,
    // else the run model only when the step stays on the run's provider; a step
    // that FLIPS provider never inherits the other provider's concrete id). The
    // rule lives in stepSpawnTarget.ts so the per-step model rail
    // (runStepModels.ts) reports exactly what this seam spawns.
    const stepRuntime = stepAgent?.runtime;
    const stepProvider = stepRuntime ? providerForRuntime(stepRuntime) : undefined;
    const runProvider = this.opts.promptRenderContext?.provider ?? 'claude';
    const { provider: effectiveProvider, model: spawnModel } = resolveStepSpawnTarget(
      stepAgent,
      runProvider,
      this.opts.model,
    );
    // Normalize the per-agent effort against the provider this step actually spawns
    // under. A value outside that provider's scale is dropped here (see
    // normalizeEffortSelection), never forwarded to a spawn that rejects it.
    const effortProvider = effectiveProvider;
    const stepEffort = stepAgent?.effort
      ? normalizeEffortSelection(effortProvider, stepAgent.effort)
      : undefined;
    const basePrompt = composeStepPrompt({
      step,
      workflowName: this.opts.workflowName,
      attempt: ctx.attempt,
      ...(ctx.item ? { item: ctx.item } : {}),
      ...(taskScope ? { taskScope } : {}),
      ...(selectedFindings ? { selectedFindings } : {}),
      ...(runOwnedIdeaIds && runOwnedIdeaIds.length > 0 ? { runOwnedIdeaIds } : {}),
      ...(approveIdeasDecisions ? { approveIdeasDecisions } : {}),
      ...(projectBrief ? { projectBrief } : {}),
      ...(designSurfaces ? { designSurfaces } : {}),
      ...(solutionThoroughness ? { solutionThoroughness } : {}),
      ...(gateRevision ? { gateRevision } : {}),
      ...(runbookProposal ? { runbookProposal } : {}),
      ...(approveRunbookResolution ? { approveRunbookResolution } : {}),
      ...(userGuidance ? { userGuidance } : {}),
      ...(retryGuidance ? { retryGuidance } : {}),
      // Per-LANE rescue guidance (monitor lane triage). Threaded off the ctx, not
      // a thunk: it is per fan-out item, and the `stepGuidance` map the thunk
      // reads is keyed by bare step id and shared across lanes. Absent on every
      // non-rescued lane ⇒ byte-identical prompt.
      ...(ctx.laneGuidance ? { laneGuidance: ctx.laneGuidance } : {}),
      ...(bootstrapProtectedPaths && bootstrapProtectedPaths.length > 0
        ? { bootstrapProtectedPaths }
        : {}),
      // Per-attempt visual-verification threading (verification-agent redesign
      // §5.3): a task-verify contract re-run and a visual-FAIL implement
      // re-delegate carry their defect / report on the ctx; forward verbatim so
      // composeStepPrompt renders the corresponding section. Absent ⇒ byte-identical.
      ...(ctx.contractError ? { contractError: ctx.contractError } : {}),
      ...(ctx.loopbackFeedback ? { loopbackFeedback: ctx.loopbackFeedback } : {}),
      // Prior-step handoff: forwarded only for a step whose definition opts in
      // (`consumesPriorStepOutput`), which is what the controller gates on.
      // Absent ⇒ byte-identical prompt.
      ...(ctx.priorStepOutput ? { priorStepOutput: ctx.priorStepOutput } : {}),
    });
    // A step-level runtime override also overrides the render context's
    // provider/runtime so a Codex step gets the compatibility adapter even inside
    // an otherwise-Claude run's prompt envelope. No override ⇒ renderCtx is the
    // SAME object as today's base (byte-identical).
    const baseRenderCtx = this.opts.promptRenderContext ?? {
      provider: 'claude' as const,
      runtime: 'claude-sdk' as const,
      executionModel: 'programmatic' as const,
    };
    const renderCtx =
      stepRuntime && stepProvider ? { ...baseRenderCtx, provider: stepProvider, runtime: stepRuntime } : baseRenderCtx;
    const { prompt } = renderWorkflowPromptForRuntime(
      { prompt: basePrompt, systemPromptAppend: '' },
      {
        ...renderCtx,
        turnKind: 'programmatic-step',
        ...(effectiveProvider !== 'claude' && this.opts.resolveRoleBriefs
          ? { roleBriefs: this.opts.resolveRoleBriefs() }
          : {}),
      },
    );
    // Re-resolve the agent permission mode PER STEP (permission-mode redesign
    // §3c#2) — never captured at construction — so a mid-run mode change is
    // honored on the next step turn.
    const agentPermissionMode = this.opts.agentPermissionMode?.();
    // One line per PINNED spawn (any per-agent runtime/model/effort — including a
    // mid-run "Switch runtime & retry" override) so the log shows where each step
    // actually ran; an unpinned step spawns exactly as the run says and logs nothing.
    if (stepAgent && (stepAgent.runtime || stepAgent.model || stepAgent.providerModel || stepAgent.effort)) {
      this.logger?.info(
        `[SpawnStepRunner] step '${step.id}' spawning on ${effectiveProvider}/${renderCtx.runtime} model=${spawnModel ?? 'run default'} effort=${stepEffort ?? 'default'}`,
        { runId: this.opts.runId, stepId: step.id },
      );
    }
    // Dev lever (mirrors CYBOFLOW_FAKE_GIT_PREREQ): `CYBOFLOW_FAKE_SYSTEMIC_STEP=<stepId>`
    // fails that step's CLAUDE spawn with a fake usage-limit error instead of
    // spawning, so the systemic pause + "Switch runtime & retry" surface can be
    // exercised without burning a real limit. The text still goes through the real
    // classifier below; a step switched onto another provider spawns for real,
    // which is exactly what proves the switch took effect.
    const fakeError = fakeSystemicFailure(step.id, effectiveProvider);
    if (fakeError !== null) {
      this.logger?.warn(`[SpawnStepRunner] CYBOFLOW_FAKE_SYSTEMIC_STEP — step '${step.id}' failing WITHOUT spawning: ${fakeError}`, {
        runId: this.opts.runId,
        stepId: step.id,
      });
      return {
        status: 'failed',
        error: fakeError,
        ...(isSystemicStepError(fakeError) ? { systemic: true } : {}),
        provider: effectiveProvider,
        runtime: stepRuntime ?? baseRenderCtx.runtime,
      };
    }
    try {
      const outcome = await this.spawner.spawnCliProcess({
        panelId: this.opts.panelId,
        sessionId: this.opts.sessionId,
        runId: this.opts.runId,
        worktreePath: this.opts.worktreePath,
        prompt,
        hidePromptFromTranscript: true,
        agentInvocationStepId: step.id,
        // When the CONTROLLER owns the visual-verification enqueue (the agentless
        // visual-verify step), NO step turn may fire the request itself — the
        // first live run's task-verify turn did, hijacking the lane (2026-07-22).
        // Constant across the run, so warm lane sessions never recycle over the
        // fingerprint; EMPTY for a run with no such step (the spawn seam drops an
        // empty list), so verify-setup's `prove` step can fire its own proof.
        disallowedTools: [...(this.opts.disallowedTools ?? PROGRAMMATIC_STEP_DISALLOWED_TOOLS)],
        ...(spawnModel ? { model: spawnModel } : {}),
        ...(stepProvider ? { agentProvider: stepProvider } : {}),
        ...(stepRuntime ? { agentRuntime: stepRuntime } : {}),
        ...(stepEffort ? { reasoningEffort: stepEffort } : {}),
        ...(agentPermissionMode ? { agentPermissionMode } : {}),
        // Additive per-lane spawn identity — forwarded ONLY when present so the
        // non-fan-out (no-item) case stays byte-identical; the spawner defaults
        // spawnKey to panelId when absent.
        ...(ctx.spawnKey ? { spawnKey: ctx.spawnKey } : {}),
      });
      // The SDK treats an aborted turn as a clean drain, so a resolved spawn after
      // a cancel is NOT a real success — consult the signal to tell them apart.
      if (ctx.signal?.aborted) return { status: 'aborted' };
      // Typed step-output channel (§5.3): forward the step agent's final result
      // text captured at the spawn seam. `void` (a substrate that does not capture,
      // e.g. interactive) ⇒ null. The controller parses this on the `ok` path.
      return { status: 'ok', resultText: outcome?.resultText ?? null };
    } catch (err) {
      // A rejection during/after a cancel is the cancel, not a genuine failure.
      if (ctx.signal?.aborted) return { status: 'aborted' };
      const error = err instanceof Error ? err.message : String(err);
      this.logger?.warn(`[SpawnStepRunner] step '${step.id}' attempt ${ctx.attempt} failed`, {
        runId: this.opts.runId,
        stepId: step.id,
        error,
      });
      // Stamp systemic:true when the error text is an environment-level condition
      // (usage/rate limit, overload, auth) so the controller parks-and-retries
      // rather than consuming this step's retry/optional/loopback/triage budget.
      // provider/runtime: what this attempt ran on, so a systemic pause can name the
      // blocked provider (the operator's "Switch runtime & retry" scopes off it).
      return {
        status: 'failed',
        error,
        ...(isSystemicStepError(error) ? { systemic: true } : {}),
        provider: effectiveProvider,
        runtime: stepRuntime ?? baseRenderCtx.runtime,
      };
    }
  }
}
