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
import {
  resolveWorkflowDefinition,
  VERIFY_SETUP_WORKFLOW_NAME,
  type WorkflowStep,
} from '../../../../shared/types/workflows';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { WorkflowAgentRuntime } from '../../../../shared/types/agentRuntime';
import type { ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import {
  isVerificationType,
  type VerificationTaskV1,
} from '../../../../shared/types/visualVerification';
import type { ClaudeSpawnerLike, ProgrammaticRunner, ProgrammaticRunContext } from '../runExecutor';
import type { DatabaseLike, LoggerLike } from '../types';
import { enqueueTaskVerification } from '../verify/enqueueFromTask';
import {
  resolveVerificationPosture,
  type VerificationRunStamp,
  type VerificationPostureDeps,
} from '../verify/verificationPosture';
import { sweepBuildBreaks } from './buildBreakDetector';
import type {
  EscalationReviewItemSummary,
  FanOutDriver,
  SetAsideFindingInput,
  StepReport,
  VisualVerifyGate,
} from './types';
import { WorkflowController } from './workflowController';
import { createRunDirectives } from './runDirectives';
import { SpawnStepRunner, programmaticDisallowedTools } from './spawnStepRunner';
import { composeDesignSurfaces } from './designSurfaces';
import {
  isSolutionThoroughness,
  parseThoroughnessFlag,
  type SolutionThoroughness,
} from '../../../../shared/types/thoroughness';
import {
  ProgrammaticRunHost,
  type LaneTriageAdjustResult,
  type LaneTriageTaskFacts,
  type StepReporter,
} from './programmaticRunHost';
import type { HumanGateResolver } from './humanGate';
import type { BlockingItemsResolver } from './blockingItemsGate';
import type { SystemicPauseResolver } from './systemicPauseGate';
import { MonitorRegistry, type MonitorContext, type MonitorSession } from './monitor';
import { readApproveIdeasDecisionLines } from '../resolveReviewItemHandler';
import { selectFindingForSeed } from '../reviewItemListing';
import {
  findingBucket,
  parseGateResolution,
  type FindingTagBucket,
} from '../../../../shared/types/reviews';
import { ReviewItemRouter } from '../reviewItemRouter';
import { hasReviewableDesignSurface } from '../runEntityOwnership';
// ONE reader for the run's design critique — the gate body, the gate-revision
// quote and the controller's verdict fallback must never disagree about what the
// artifact says, and only the gate-body copy knows the `reported_at` freshness
// rule (migration 143). This module used to keep a byte-identical private copy.
import { readAdversarialReviewMarkdown } from '../adversarialReviewGateBody';

/**
 * The ESCALATION-REVIEW collaborator bag, declared STRUCTURALLY here rather than
 * imported from `orchestrator/monitorActionSinks` (which builds it): that module
 * reaches into task listing and gate side-effects, and `programmatic/` must stay
 * standalone-typecheckable. The production bag satisfies this shape by
 * construction; a test can satisfy it with five `vi.fn()`s.
 */
export interface EscalationSinks {
  /** This run's review-queue rows for the gate consult (bounded, newest first). */
  listRunReviewItems(runId: string): Promise<EscalationReviewItemSummary[]>;
  /** Upsert the supervisor's recommendation section into a PENDING item's body. */
  annotate(runId: string, input: { reviewItemId: string; markdown: string }): Promise<void>;
  /** Close one blocking FINDING as the supervisor (item 9). */
  resolveAsMonitor(runId: string, input: { reviewItemId: string; resolution: string }): Promise<void>;
  /** Autonomous resolves this run has already spent (the durable cap's counter). */
  countMonitorResolves(runId: string): Promise<number>;
  /** Review-write barrier awaited before every step-boundary queue read (CR-3). */
  awaitWritesSettled(projectId: number): Promise<void>;
}

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
   * Read-only DB handle for the agentless visual-verify enqueue seam
   * (verification-agent redesign §5.3/§5.4). When present (production wires
   * `cyboflowDb`), the runner builds the host's `enqueueVisualVerification`
   * capability — the controller's agentless visual-verify step calls it to enqueue
   * the composed task on the singleton VerificationScheduler (reads the run's verify
   * stamps + project id, captures the snapshot sha, dual-writes). Absent (tests /
   * a host built without a DB) ⇒ the capability is not wired, so the controller's
   * visual-verify step cleanly SKIPS (fail-open — no request, no park). The
   * scheduler being a singleton is why no scheduler instance is threaded here.
   */
  db?: DatabaseLike;
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
  /**
   * LIVE run-owned idea scope. Resolves the authoritative union of the run's
   * `workflow_runs.seed_idea_id` and ideas it created in entity_events. Invoked
   * per step instead of snapshotting at run start: a raw-prompt Ship run has no
   * seed, but its context step creates an idea before the later optional design
   * steps need to evaluate that idea's flags.
   */
  runOwnedIdeaIdsProvider?: (runId: string) => readonly string[];
  /**
   * Repo paths a run's RUNBOOK BOOTSTRAP wrote
   * (docs/proposals/lane-runbook-bootstrap.md §11), rendered as a do-not-touch
   * list on address-review. Absent ⇒ no section, which is every run that did not
   * bootstrap.
   */
  bootstrapProtectedPathsProvider?: (runId: string) => readonly string[];
  /**
   * Per-step agent RUNTIME resolver (Codex-per-step mixing). Threaded to the
   * run's SpawnStepRunner as a run-bound thunk (`(agentKey) =>
   * resolveStepAgent(runId, agentKey)`) so a workflow-scoped agent config that
   * pins a step's canonical agent key to `runtime: 'codex-sdk'` routes that
   * step's spawn to Codex without touching the run-level `workflow_runs`
   * provider/runtime stamp. Absent ⇒ no resolver threaded, so every step spawns
   * under the run-level resolution (byte-identical to today).
   */
  resolveStepAgent?: (
    runId: string,
    agentKey: string,
  ) =>
    | {
        runtime?: WorkflowAgentRuntime;
        providerModel?: string;
        codexModel?: string;
        effort?: ReasoningEffort;
      }
    | undefined;
  /**
   * LANE-TRIAGE task reader (autonomous lane rescue). Resolves a fan-out item's
   * ref / title / CURRENT body so the host can enrich the controller's bare
   * lane-failure facts before consulting the monitor — the brain judges whether
   * the task's acceptance criteria conflict with repo reality, which it cannot do
   * without seeing them. MUST be fail-soft. Absent ⇒ the consult still happens,
   * but with an empty title/body (so `adjust_and_retry` is out of reach).
   */
  laneTriageTaskReader?: (runId: string, itemId: string) => LaneTriageTaskFacts | undefined;
  /**
   * LANE-TRIAGE task-body writer (autonomous lane rescue). Bound in production to
   * `adjustRunTaskForLaneTriage` over the SAME `TaskMutationDeps` the monitor's
   * chat `edit_task` action uses, so every backlog write still lands on the
   * TaskChangeRouter chokepoint. Absent ⇒ an `adjust_and_retry` verdict is
   * downgraded to a plain rescue (guidance only).
   */
  laneTriageAdjustTask?: (
    runId: string,
    input: { taskRef: string; body: string },
  ) => Promise<LaneTriageAdjustResult>;
  /**
   * LANE-TRIAGE audit sink (autonomous lane rescue). Bound in production to the
   * SAME ReviewItemRouter seam the monitor's `fileNote` action uses, so an
   * autonomous rescue — and above all an autonomous requirements adjustment —
   * always reaches the human's review queue. Absent ⇒ rescues are logged only.
   */
  laneTriageFindingSink?: (runId: string, input: { title: string; body: string }) => Promise<void>;
  /**
   * SUPERVISOR-AUDIT sink (the review loop). Bound in production to the SAME
   * ReviewItemRouter seam `laneTriageFindingSink` uses, with actor `monitor`, so
   * an autonomous decision about whether to spend another design lap always
   * reaches the human's review queue. Absent ⇒ the decision is logged only.
   */
  monitorFindingSink?: (
    runId: string,
    input: { title: string; body: string; category?: string },
  ) => Promise<void>;
  /**
   * SET-ASIDE sink (the review loop). Files one non-blocking finding per
   * adversarial-review entry the supervisor excluded from a lap — the thing that
   * makes a set-aside safe. Bound in production to the same chokepoint, composed
   * to match the approve-design gate's accepted-risk findings so the gate dedupes
   * rather than double-files. Absent ⇒ set-aside entries are logged only.
   */
  setAsideFindingSink?: (runId: string, input: SetAsideFindingInput) => Promise<void>;
  /**
   * LATE-BOUND accessor for the ESCALATION-REVIEW collaborator bag
   * (`monitorActionSinks.buildGateEscalationSinks`). A getter, not the bag
   * itself: this runner is constructed EARLY in `initializeServices` while the
   * bag is built in a later nested block, so the only thing available at
   * construction time is a way to look it up per run.
   *
   * Absent or returning null ⇒ every escalation seam degrades to its pre-seam
   * posture: an empty queue list, a logged-only recommendation, no autonomous
   * resolve, and an unbarriered boundary read.
   */
  escalationSinks?: () => EscalationSinks | null | undefined;
  /**
   * The project's runbook-status resolver — the SAME closure the scheduler's
   * `runbookStatus` dependency and the verify health panel share (index.ts builds
   * one and hands it to all three). Feeds the RUN-LEVEL verification posture
   * (CD1); absent ⇒ the posture never reads a runbook, so a `native-desktop` run
   * resolves 'available' and behaves exactly as it did before the seam.
   */
  verifyRunbookStatus?: VerificationPostureDeps['runbookStatus'];
  /**
   * The LIVE visual-verify config (`configManager.getVisualVerifyConfig`) — the
   * same read the agent engine's gate 3 makes for the runbook-optional kill
   * switch, so the RUN-LEVEL posture and the per-request execution mode agree
   * (runbook-optional-verification.md §A6). Absent ⇒ the posture consults only
   * the env override, whose default is explore-on — the engine's own default.
   */
  verifyLiveConfig?: VerificationPostureDeps['liveConfig'];
  logger?: LoggerLike;
}

/**
 * Read the run's IMMUTABLE verification stamp (migration 055) plus the worktree
 * the runbook probe should look at — the input half of the run-level posture.
 *
 * Fail-soft to `null`, which the posture resolver reads as 'available': an
 * unreadable stamp is not evidence that a project cannot be verified.
 */
export function readVerificationRunStamp(db: DatabaseLike, runId: string): VerificationRunStamp | null {
  try {
    const row = db
      .prepare(
        `SELECT project_id AS projectId, verify_enabled AS verifyEnabled,
                verify_type AS verifyType, worktree_path AS worktreePath
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          projectId?: number | null;
          verifyEnabled?: number | boolean | null;
          verifyType?: string | null;
          worktreePath?: string | null;
        }
      | undefined;
    if (!row || typeof row.projectId !== 'number') return null;
    const worktreePath =
      typeof row.worktreePath === 'string' && row.worktreePath.trim().length > 0 ? row.worktreePath : null;
    const rawType: unknown = row.verifyType;
    return {
      projectId: row.projectId,
      verifyEnabled: row.verifyEnabled === 1 || row.verifyEnabled === true,
      verifyType: isVerificationType(rawType) ? rawType : null,
      worktreePath,
    };
  } catch {
    return null;
  }
}

/**
 * File one RUN-SCOPED declaration through `ReviewItemRouter.createIfNoPending`,
 * whose check-and-create runs as ONE task on the per-project queue.
 *
 * `source` IS the dedupe key (there is no unique index behind it), which is why
 * it is a parameter: the two callers — the "no verifiable modality" declaration
 * and a shared-build-break group — need the same once-only guarantee under
 * different keys. NON-BLOCKING and severity 'warning' for the same reason the
 * F8 skip finding is: these describe something a human should SEE, never
 * something the run should stop for.
 */
async function fileRunScopedFinding(
  projectId: number,
  runId: string,
  input: { source: string; title: string; body: string },
): Promise<void> {
  await ReviewItemRouter.getInstance().createIfNoPending(projectId, {
    op: 'create',
    actor: 'orchestrator',
    kind: 'finding',
    title: input.title,
    body: input.body,
    blocking: false,
    severity: 'warning',
    source: input.source,
    runId,
  });
}

/**
 * File the F8 "visual verification never reached the queue" finding through the
 * ReviewItemRouter chokepoint (docs/proposals/visual-verification-brittleness-
 * fixes.md §F8). NON-BLOCKING and severity 'warning': the lane already advanced
 * fail-open, so parking the run here would punish a lane for a harness gap; the
 * point is that a human SEES that no visual check ran.
 *
 * `source: 'visual-verify'` matches verdictDelivery's gate-side skip findings on
 * purpose — pre-row drops and post-row skips are the same class of event to the
 * reader, and grouping them means the review queue answers "did verification
 * actually run on this sprint?" in one place.
 *
 * Fail-soft: an uninitialized router or a rejected write is logged by the caller
 * (ProgrammaticRunHost) and never reaches the walk.
 */
async function fileVerificationSkipFinding(
  projectId: number,
  runId: string,
  input: { title: string; body: string },
): Promise<void> {
  await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
    op: 'create',
    actor: 'orchestrator',
    kind: 'finding',
    title: input.title,
    body: input.body,
    blocking: false,
    severity: 'warning',
    source: 'visual-verify',
    runId,
  });
}

/**
 * Read the run's `project-brief` artifact markdown (the launch flow's approved
 * brief), or undefined when the brief has not been reported yet. Fail-soft: a
 * missing artifacts table or unparseable payload yields undefined — the step
 * prompt simply omits its `# Project brief` section.
 */
export function readProjectBriefMarkdown(db: DatabaseLike, runId: string): string | undefined {
  try {
    const row = db
      .prepare(
        "SELECT payload_json AS payloadJson FROM artifacts WHERE run_id = ? AND atype = 'project-brief' LIMIT 1",
      )
      .get(runId) as { payloadJson?: string | null } | undefined;
    if (typeof row?.payloadJson !== 'string' || row.payloadJson.length === 0) return undefined;
    const parsed: unknown = JSON.parse(row.payloadJson);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const markdown = (parsed as { markdown?: unknown }).markdown;
    return typeof markdown === 'string' && markdown.trim().length > 0 ? markdown : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the run's runbook PROPOSAL markdown — the payload of the `verify-runbook`
 * artifact the verify-setup flow's `derive` step published, which the
 * `approve-runbook` gate then approved. The programmatic `prove` step has no MCP
 * tool that READS an artifact, so without this it cannot recover what it is
 * supposed to write and asks the human to paste the proposal back (observed live
 * 2026-08-27).
 *
 * LEGACY FALLBACK. `derive` declared `outputArtifact.atype:
 * 'compound-recommendations'` until this fix — the atype `verify-runbook` was
 * minted (migration 097) to replace exactly that mislabel and the flow definition
 * was never switched over. Runs that are IN FLIGHT across the fix, or that get
 * rewound, still carry their proposal under the old atype, so fall back to it
 * rather than stranding them. Scoped to the verify-setup flow by the caller, so a
 * real Compound run's recommendations can never be read as a runbook.
 *
 * KNOWN LIMITATION (deliberate, not an oversight): this reads the run's CURRENT
 * proposal, not a revision pinned at the moment the gate approved it. The
 * artifact is one-per-run and `prove` is told to re-report it enriched with the
 * proof outcomes, so a REWOUND run that re-enters `prove` reads back a document
 * carrying its own previous attempt's outcomes rather than the pristine approved
 * one. Pinning it properly means an approved-revision reference in the gate
 * payload, which today has a typed shape only for launch's approve-ideas — a
 * bigger change than this fix. The enriched doc still contains the same approved
 * runbook, so the failure mode is noise in the prompt, not a different runbook.
 *
 * Fail-soft like readProjectBriefMarkdown: a missing table or unparseable payload
 * yields undefined and the step prompt simply omits the section.
 */
export function readRunbookProposalMarkdown(db: DatabaseLike, runId: string): string | undefined {
  const read = (atype: string): string | undefined => {
    try {
      const row = db
        .prepare('SELECT payload_json AS payloadJson FROM artifacts WHERE run_id = ? AND atype = ? LIMIT 1')
        .get(runId, atype) as { payloadJson?: string | null } | undefined;
      if (typeof row?.payloadJson !== 'string' || row.payloadJson.length === 0) return undefined;
      const parsed: unknown = JSON.parse(row.payloadJson);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const markdown = (parsed as { markdown?: unknown }).markdown;
      return typeof markdown === 'string' && markdown.trim().length > 0 ? markdown : undefined;
    } catch {
      return undefined;
    }
  };
  return read('verify-runbook') ?? read('compound-recommendations');
}

/**
 * Render the COMPOUND run's `# Selected findings` block body from its
 * `seed_finding_ids` (migration 034) — the human's explicit selection from the
 * review-queue triage tray.
 *
 * REPLICATES `RunExecutor.buildSelectedFindingsBlock`, deliberately rather than
 * sharing it: that method is private to an executor the programmatic plane does
 * not hold, it resolves findings through an injected `FindingReaderLike` wired
 * only for the orchestrated prompt path, and widening either to reach here would
 * put an orchestrated-prompt collaborator on the controller's critical path. Both
 * render from the SAME two sources — the run's `seed_finding_ids` and
 * `selectFindingForSeed` — and both emit the same heading, ordering, and
 * per-finding shape, which is what `compound.md` keys its seeded branch on.
 *
 * Ordering matches the orchestrated block: priority (P0 < P1 < P2, null LAST)
 * then bucket (quick < doc < task), with the seeded order as the stable tiebreak.
 *
 * Fail-soft at every step like its siblings above: no ids, unparseable JSON, or
 * a finding that no longer resolves ⇒ that finding is skipped, and an empty
 * result yields undefined so the step prompt simply omits the section.
 */
export function readSelectedFindingsBlock(
  db: DatabaseLike,
  rawSeedFindingIds: string | null | undefined,
): string | undefined {
  if (!rawSeedFindingIds) return undefined;
  let ids: string[];
  try {
    const parsed: unknown = JSON.parse(rawSeedFindingIds);
    if (!Array.isArray(parsed)) return undefined;
    ids = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return undefined;
  }
  if (ids.length === 0) return undefined;

  type ResolvedFinding = NonNullable<ReturnType<typeof selectFindingForSeed>>;
  const resolved: ResolvedFinding[] = [];
  for (const id of ids) {
    try {
      const finding = selectFindingForSeed(db, id);
      if (finding) resolved.push(finding);
    } catch {
      // Fail-soft per id — one unresolvable finding never sinks the prompt.
    }
  }
  if (resolved.length === 0) return undefined;

  const priorityRank = (p: 'P0' | 'P1' | 'P2' | null): number =>
    p === 'P0' ? 0 : p === 'P1' ? 1 : p === 'P2' ? 2 : 3;
  const bucketRank: Record<FindingTagBucket, number> = { quick: 0, doc: 1, task: 2 };
  resolved.sort((a, b) => {
    const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
    if (byPriority !== 0) return byPriority;
    return bucketRank[findingBucket(a.proposedTarget)] - bucketRank[findingBucket(b.proposedTarget)];
  });

  const sections = resolved.map((f) => {
    const badge = f.priority ?? '—';
    const title = f.title?.trim() || '(untitled finding)';
    const bucket = findingBucket(f.proposedTarget);
    const sourceTail = f.source?.trim() || 'unknown';
    const parts: string[] = [
      `## ${badge} ${title}`,
      `Target: ${bucket} · Source: ${sourceTail} · id: \`${f.id}\``,
    ];
    const body = f.body?.trim();
    if (body) parts.push(body);
    const suggestedFix = f.suggestedFix?.trim();
    if (suggestedFix) parts.push(`### Suggested fix\n${suggestedFix}`);
    const locations = (f.locations ?? []).filter((l) => l.path?.trim());
    if (locations.length > 0) {
      const lines = locations.map(
        (l) => `- ${l.path.trim()}${typeof l.line === 'number' ? `:${l.line}` : ''}`,
      );
      parts.push(['### Locations', ...lines].join('\n'));
    }
    return parts.join('\n\n');
  });

  const directive =
    'Act ONLY on these findings, in the order listed. For each, apply the action for its target bucket, then IMMEDIATELY call `cyboflow_resolve_finding` with its id and the matching resolution kind — do not batch resolves to the end.';
  return [directive, ...sections].join('\n\n');
}

/**
 * Read the raw resolution string of this run's RESOLVED `approve-runbook` gate.
 *
 * Unlike launch's approve-ideas fold there is nothing structured to parse: the
 * programmatic plane opens `approve-runbook` as a generic blocking decision item
 * (HumanStepManager supplies a typed payload only for approve-ideas) and the UI
 * offers only Approve / Reject, so `humanGate.parseGateVerdict` string-sniffs the
 * resolution down to approve/reject/revise. The flow's "Pick subset" option is
 * therefore ORCHESTRATED-ONLY. The one trimming signal that survives to `prove`
 * is a qualification a human typed into the note, so the note is what we hand
 * over.
 *
 * PREFIX FIRST: a row written by `composeGateResolution` ('approve: only web')
 * yields just the NOTE — undefined for a bare verdict, so composeStepPrompt has
 * nothing to drop. A legacy row (parse returns null) still hands over the raw
 * string exactly as before, and composeStepPrompt keeps dropping a bare verdict
 * word there.
 *
 * Fail-soft: a missing review_items table or any thrown query yields undefined.
 */
export function readApproveRunbookResolution(db: DatabaseLike, runId: string): string | undefined {
  try {
    const row = db
      .prepare(
        `SELECT resolution FROM review_items
          WHERE run_id = ? AND kind = 'decision' AND status = 'resolved'
            AND source = 'gate:human-step:approve-runbook'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runId) as { resolution?: string | null } | undefined;
    const resolution = row?.resolution;
    if (typeof resolution !== 'string' || resolution.trim().length === 0) return undefined;
    const parsed = parseGateResolution(resolution);
    return parsed !== null ? parsed.note : resolution;
  } catch {
    return undefined;
  }
}

/**
 * The raw resolution text of this run's most recent RESOLVED gate for `stepId`.
 *
 * The gate resolver reduces a resolution to approve/reject/revise/abort and drops
 * the text; on a 'revise' that text is the only thing distinguishing "do it again"
 * from "the spend screen has no way back to Home". Generalizes
 * readApproveRunbookResolution's query to any gate step id.
 *
 * Returns undefined for a bare verdict word — rendering "> Revise" as the human's
 * guidance is noise that reads like an instruction when there is none — and for
 * any thrown query.
 *
 * PREFIX FIRST: a row written by `composeGateResolution` ('revise: only AR-2
 * matters') yields just the NOTE, so the human's words survive verbatim even
 * when they contain a verdict word. Legacy rows keep today's behaviour: a bare
 * verdict word is dropped by the regex below, any other free text passes through.
 */
export function readGateResolutionNote(
  db: DatabaseLike,
  runId: string,
  stepId: string,
): string | undefined {
  try {
    const row = db
      .prepare(
        `SELECT resolution FROM review_items
          WHERE run_id = ? AND kind = 'decision' AND status = 'resolved'
            AND source = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(runId, `gate:human-step:${stepId}`) as { resolution?: string | null } | undefined;
    const resolution = (row?.resolution ?? '').trim();
    if (resolution.length === 0) return undefined;
    const parsed = parseGateResolution(resolution);
    if (parsed !== null) return parsed.note;
    return /^(approve|approved|reject|rejected|revise|retry)$/i.test(resolution) ? undefined : resolution;
  } catch {
    return undefined;
  }
}

/**
 * Read the project's stamped SOLUTION THOROUGHNESS (migration 135), for a run
 * whose project already carries one.
 *
 * Raw SQL rather than the project read model for the same reason
 * readProjectBriefMarkdown is: this runner holds a narrow DatabaseLike, not the
 * Database service, and a per-step read has to stay cheap and dependency-free.
 *
 * Fail-soft: a pre-135 DB (no column), a missing row, or an unexpected value all
 * yield undefined, and the step prompt simply omits its thoroughness section.
 */
export function readProjectThoroughness(
  db: DatabaseLike,
  runId: string,
): SolutionThoroughness | undefined {
  try {
    const row = db
      .prepare(
        `SELECT p.solution_thoroughness AS level
           FROM workflow_runs r JOIN projects p ON p.id = r.project_id
          WHERE r.id = ? LIMIT 1`,
      )
      .get(runId) as { level?: unknown } | undefined;
    return isSolutionThoroughness(row?.level) ? row.level : undefined;
  } catch {
    return undefined;
  }
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

    // LIVE batch-id resolution, shared by the task-scope thunk below and the
    // fan-out driver provider further down. `ctx.run.batch_id` is a run-start
    // SNAPSHOT; `ship` stamps batch_id MID-RUN (see readRunBatchId's docblock),
    // so BOTH consumers must keep re-reading until the stamp lands — a
    // snapshot-gated taskScope left ship's per-task step prompts without the
    // `# Sprint tasks` grounding block even after the driver resolved. Memoized
    // on first success: batch_id only ever transitions null → non-null. Absent
    // readRunBatchId ⇒ the snapshot is all there is (sprint stamps at launch,
    // so this is byte-identical for it).
    let resolvedBatchId: string | null =
      typeof ctx.run.batch_id === 'string' && ctx.run.batch_id.length > 0 ? ctx.run.batch_id : null;
    const liveBatchId = (): string | null => {
      if (resolvedBatchId) return resolvedBatchId;
      resolvedBatchId = this.deps.readRunBatchId ? this.deps.readRunBatchId(ctx.runId) : null;
      return resolvedBatchId;
    };

    // A seeded sprint (non-empty batch_id) threads its `# Sprint tasks` block into
    // every step prompt so the step agent always sees the real task set. The block
    // is resolved PER STEP (a thunk, not a run-start snapshot) so a lane the monitor
    // adds mid-run — dispatched by the fan-out's wave-boundary re-resolution — is
    // grounded with its real title/body on first dispatch. buildSeedTasksBlock reads
    // the batch's lanes live, so re-invoking it picks up the added lane. Non-sprint
    // runs ⇒ no block.
    const taskScope = (): string | undefined => {
      const batchId = liveBatchId();
      return batchId ? (this.deps.seedTasksProvider?.(batchId) ?? undefined) : undefined;
    };

    // Resolve the idea scope per step, never from an in-memory "active idea"
    // guess. A raw-prompt Ship run starts with no seed_idea_id; its context turn
    // can create the idea whose flags later control ui-prototype / architecture.
    const runOwnedIdeaIds = (): readonly string[] => this.deps.runOwnedIdeaIdsProvider?.(ctx.runId) ?? [];
    const bootstrapProtectedPaths = (): readonly string[] =>
      this.deps.bootstrapProtectedPathsProvider?.(ctx.runId) ?? [];

    // Re-read the run's resolved approve-ideas gate verdicts per step (launch's
    // batch gate). Undefined until the human resolves the gate — pre-gate steps
    // get byte-identical prompts; post-gate steps carry the decisions block so
    // they can honor DENIED refs (no delivery turn exists on this plane).
    const approveIdeasDecisions = (): string | undefined =>
      this.deps.db ? readApproveIdeasDecisionLines(this.deps.db, ctx.runId) : undefined;

    // Re-read the run's project-brief artifact per step (launch flow). A
    // programmatic step agent cannot read artifacts via MCP, so every
    // post-brief step turn carries the brief as its grounding section.
    // Undefined pre-brief and on every non-launch flow ⇒ no section.
    const projectBrief = (): string | undefined => {
      if (ctx.workflow.name !== 'launch' || !this.deps.db) return undefined;
      return readProjectBriefMarkdown(this.deps.db, ctx.runId);
    };

    // Re-read this run's APPROVED DESIGN SURFACES per step (sprint / ship). The
    // design was approved in a DIFFERENT run whose prototype artifact this run
    // cannot read and which is cascade-deleted with it; what survives is the
    // approved_designs snapshot path plus each idea's `## Design spec` section,
    // and composeDesignSurfaces reads both off the batch's tasks. A thunk, not a
    // snapshot, for the same reason taskScope is one: a lane added mid-run brings
    // its own originating idea. Flow-gated by name — planner/launch have no batch,
    // so the read would be a guaranteed miss, and every other flow's prompt stays
    // byte-identical.
    const designSurfaces = (): string | undefined => {
      if ((ctx.workflow.name !== 'sprint' && ctx.workflow.name !== 'ship') || !this.deps.db) {
        return undefined;
      }
      return composeDesignSurfaces(this.deps.db, ctx.runId);
    };

    // Re-read the verify-setup run's approved runbook proposal + its gate note per
    // step. Naturally undefined on `inspect`/`derive` (they run BEFORE the artifact
    // exists) and on every other flow ⇒ no section, so all other prompts stay
    // byte-identical. Flow-gated by name for the same reason projectBrief is: the
    // reader falls back to the legacy `compound-recommendations` atype, which
    // outside this flow is a real Compound deliverable.
    const runbookProposal = (): string | undefined => {
      if (ctx.workflow.name !== VERIFY_SETUP_WORKFLOW_NAME || !this.deps.db) return undefined;
      return readRunbookProposalMarkdown(this.deps.db, ctx.runId);
    };
    const approveRunbookResolution = (): string | undefined => {
      if (ctx.workflow.name !== VERIFY_SETUP_WORKFLOW_NAME || !this.deps.db) return undefined;
      return readApproveRunbookResolution(this.deps.db, ctx.runId);
    };

    // Re-render the COMPOUND run's human-curated seed per step. Flow-gated by
    // name for the same reason designSurfaces is: only compound is ever launched
    // with `seed_finding_ids`, and gating keeps every other flow's prompt
    // byte-identical without paying for a guaranteed-miss read. The ids come off
    // the run row snapshot because the launcher stamps them once at launch and
    // nothing ever rewrites them mid-run.
    const selectedFindings = (): string | undefined => {
      if (ctx.workflow.name !== 'compound' || !this.deps.db) return undefined;
      return readSelectedFindingsBlock(this.deps.db, ctx.run.seed_finding_ids);
    };

    // The project's SOLUTION THOROUGHNESS, re-read per step. Two sources, because
    // the level is stamped on the project only when Launch's approve-brief gate
    // resolves: DURING a launch run the brief's own `THOROUGHNESS:` flag is the
    // live answer (and is what the post-brief steps must obey), while every later
    // sprint/ship run reads the stamped column. Reading the flag first on launch
    // also makes the level available to the design steps that run before the
    // stamp's gate side-effect has necessarily landed. Absent ⇒ no section, so
    // every project predating the stamp keeps today's prompts byte-for-byte.
    const solutionThoroughness = (): SolutionThoroughness | undefined => {
      if (!this.deps.db) return undefined;
      if (ctx.workflow.name === 'launch') {
        const brief = readProjectBriefMarkdown(this.deps.db, ctx.runId);
        return parseThoroughnessFlag(brief) ?? undefined;
      }
      if (ctx.workflow.name !== 'sprint' && ctx.workflow.name !== 'ship') return undefined;
      return readProjectThoroughness(this.deps.db, ctx.runId);
    };

    // The design critique the approve-design gate reviewed, re-read per step. Only
    // the gate-revision section renders it, and only on a run that reported the
    // artifact — every other prompt is byte-identical.
    //
    // The CALLER supplies the bound. `SpawnStepRunner` passes the revision's
    // snapshot of the walk's review-freshness instant, so the quote is the same
    // critique the gate body was composed from: a gate that rendered the "No
    // adversarial review this round" notice withheld the previous round's
    // critique from the human, and must not have it threaded back as the
    // feedback the re-run is told to act on. A revision armed on a walk with no
    // bound (a resume past the review step) passes none ⇒ unbounded, exactly as
    // before.
    const adversarialReviewMarkdown = (opts?: { reportedSinceMs?: number }): string | undefined =>
      this.deps.db ? readAdversarialReviewMarkdown(this.deps.db, ctx.runId, opts) : undefined;

    // The human's free-text note on a resolved gate, run-bound for the host. The
    // controller asks for it when a gate 'revise' arms a loopback; the verdict
    // channel itself carries only the four-way decision.
    const gateResolutionNote = this.deps.db
      ? (stepId: string): string | undefined =>
          readGateResolutionNote(this.deps.db!, ctx.runId, stepId)
      : undefined;

    // Live operator steering for this run (RunDirectives). RunExecutor owns the
    // per-run object and threads it in; absent (tests / no monitor wiring) ⇒ an
    // empty no-op set so the walk is byte-identical. Read by reference at the
    // controller loop head (skip) and by the SpawnStepRunner stepGuidance thunk
    // (steer) below — both re-read live, so a mutation lands on the next turn.
    const directives = ctx.directives ?? createRunDirectives();

    // Run-bound per-step agent-runtime resolver (Codex-per-step mixing): binds
    // this run's id so SpawnStepRunner only has to pass the agentKey each step.
    // The non-null assertion is guarded by the outer ternary — deps.resolveStepAgent
    // is checked truthy before the thunk that closes over it is ever built or called.
    const resolveStepAgent = this.deps.resolveStepAgent
      ? (agentKey: string) => this.deps.resolveStepAgent!(ctx.runId, agentKey)
      : undefined;

    const runner = new SpawnStepRunner(
      this.deps.spawner,
      {
        panelId: ctx.panelId,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        worktreePath: ctx.worktreePath,
        workflowName: ctx.workflow.name,
        // Deny `cyboflow_request_verification` on this run's step turns ONLY when
        // the controller owns the enqueue (a fan-out chain carrying the agentless
        // visual-verify step). A programmatic run without one — `verify-setup`,
        // whose `prove` step fires the setup proof itself — denies nothing.
        disallowedTools: programmaticDisallowedTools(def),
        ...(ctx.run.model ? { model: ctx.run.model } : {}),
        promptRenderContext: {
          provider: ctx.run.agent_provider ?? 'claude',
          runtime: ctx.run.agent_runtime ?? 'claude-sdk',
          executionModel: ctx.run.execution_model ?? 'programmatic',
        },
        // Per-step resolver (permission-mode redesign §3c#2): SpawnStepRunner
        // invokes this each step, reading the run's session-resolved mode off the
        // context rather than the demoted `permission_mode_snapshot` audit column.
        agentPermissionMode: () => ctx.agentPermissionMode,
        // Per-step operator-guidance resolver (RunDirectives live steering): read
        // this step's guidance off the SAME directives object each turn.
        stepGuidance: (stepId) => directives.stepGuidance.get(stepId),
        // Per-step SUPERVISOR retry guidance, CONSUMED on read: the entry the
        // host staged when triage returned 'retry' reaches exactly the one
        // attempt it was bought for, and a later spawn of the same step (a
        // loopback, a gate revise, a second triage) starts clean. Deleting here
        // rather than at the write site is what makes that true regardless of
        // WHY the step spawns again.
        retryGuidance: (stepId) => {
          const g = directives.retryGuidance.get(stepId);
          if (g !== undefined) directives.retryGuidance.delete(stepId);
          return g;
        },
        taskScope,
        runOwnedIdeaIds,
        approveIdeasDecisions,
        projectBrief,
        designSurfaces,
        solutionThoroughness,
        adversarialReviewMarkdown,
        runbookProposal,
        approveRunbookResolution,
        selectedFindings,
        bootstrapProtectedPaths,
        ...(resolveStepAgent ? { resolveStepAgent } : {}),
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
      const batchId = liveBatchId();
      if (!batchId) return undefined;
      resolvedFanOutDriver = this.deps.fanOutDriverFactory?.({ runId: ctx.runId, batchId });
      return resolvedFanOutDriver;
    };

    // Agentless visual-verify enqueue capability (verification-agent redesign
    // §5.3/§5.4): built ONLY when a DB is wired. The controller calls it from the
    // (agentless) visual-verify inner step with the task task-verify composed +
    // the lane's authoritative ref/attempt; enqueueTaskVerification reads the run's
    // verify stamps, captures the snapshot sha off ctx.worktreePath, dual-writes,
    // and enqueues on the singleton scheduler. Absent DB ⇒ undefined ⇒ the
    // controller's visual-verify step cleanly skips (fail-open).
    const db = this.deps.db;
    const enqueueVisualVerification = db
      ? (args: { runId: string; task: VerificationTaskV1; laneTaskRef: string; attempt: number }) =>
          enqueueTaskVerification({
            db,
            runId: args.runId,
            task: args.task,
            laneTaskRef: args.laneTaskRef,
            attempt: args.attempt,
            worktreePath: ctx.worktreePath,
            ...(this.deps.logger ? { logger: this.deps.logger } : {}),
          })
      : undefined;

    // Optional-human-gate precondition (approve-design): when BOTH design steps
    // self-skipped (no idea carried the UI_PROTOTYPE/ARCH_DESIGN flags), the run
    // has no prototype artifact and no architecture section — the gate would
    // park the run over an empty review surface. A POPULATED adversarial-review
    // artifact counts as a surface too, so a critique with entries always opens
    // the gate. hasReviewableDesignSurface is fail-open (any read error opens it).
    //
    // `ctx.reviewReportedSinceMs` is the controller's "this round started at"
    // instant: a critique last reported before it is a PREVIOUS walk's leftover
    // (the artifact row survives a rewind / Revise) and must not by itself open
    // the gate over a surface that no longer exists. Absent ctx ⇒ no bound.
    const humanGateSkip = (step: WorkflowStep, gateCtx?: { reviewReportedSinceMs?: number }): string | null => {
      if (step.id !== 'approve-design' || !this.deps.db) return null;
      return hasReviewableDesignSurface(
        this.deps.db,
        ctx.runId,
        gateCtx?.reviewReportedSinceMs !== undefined ? { reviewReportedSinceMs: gateCtx.reviewReportedSinceMs } : undefined,
      )
        ? null
        : 'no design surface to review — no prototype artifact, no architecture design section, and no adversarial-review entries';
    };

    // Autonomous LANE-RESCUE collaborators, run-bound here so the host only ever
    // passes the item / edit / note. Each is threaded ONLY when wired: an absent
    // dep is exactly the "no lane triage" posture (the host gives up, the lane
    // settles failed as it always did).
    const laneTriageTaskReader = this.deps.laneTriageTaskReader;
    const laneTriageAdjustTask = this.deps.laneTriageAdjustTask;
    const laneTriageFindingSink = this.deps.laneTriageFindingSink;
    const monitorFindingSink = this.deps.monitorFindingSink;
    const setAsideFindingSink = this.deps.setAsideFindingSink;
    const escalationSinks = this.deps.escalationSinks?.() ?? null;
    // Narrowed once here so the two conditional spreads below close over a
    // definitely-defined handle rather than re-narrowing `this.deps` inside a
    // callback (where TS cannot keep the narrowing).
    const postureDb = this.deps.db;
    const verifyRunbookStatus = this.deps.verifyRunbookStatus;
    const verifyLiveConfig = this.deps.verifyLiveConfig;

    const host = new ProgrammaticRunHost({
      runId: ctx.runId,
      projectId: ctx.run.project_id,
      reporter: this.deps.reporter,
      gate: this.deps.gate,
      humanGateSkip,
      ...(gateResolutionNote ? { readGateResolutionNote: gateResolutionNote } : {}),
      // Same reader the revision prompt uses, handed to the controller so a
      // review whose final text never arrived still loops on its artifact —
      // but BOUND here: the controller passes the round's "reported since"
      // instant so a previous walk's surviving critique reads as absent
      // instead of arming a phantom loopback.
      ...(this.deps.db
        ? {
            readAdversarialReview: (opts?: { reportedSinceMs?: number }): string | undefined =>
              readAdversarialReviewMarkdown(this.deps.db!, ctx.runId, opts),
          }
        : {}),
      ...(this.deps.blockingGate ? { blockingGate: this.deps.blockingGate } : {}),
      ...(this.deps.systemicGate ? { systemicGate: this.deps.systemicGate } : {}),
      ...(monitor ? { monitor } : {}),
      // The WRITE half of the one-shot retry-guidance channel. The runner owns
      // `directives`, so it is the only place that can hand the host a setter;
      // the host stages the supervisor's guidance here and SpawnStepRunner's
      // consuming thunk above picks it up on the step's next spawn.
      setRetryGuidance: (stepId: string, text: string) => {
        directives.retryGuidance.set(stepId, text);
      },
      injectEvent: ctx.injectEvent,
      ...(this.deps.stepResultRecorder ? { recordStepResult: this.deps.stepResultRecorder } : {}),
      fanOutDriverProvider,
      // The visual merge-gate is inert until a fan-out step actually runs (which
      // itself requires the provider above to have resolved a driver), so it is
      // wired unconditionally rather than gated on a driver existing AT
      // CONSTRUCTION TIME — under lazy resolution that may not happen until well
      // into the walk (see ProgrammaticRunHostArgs.visualGate's docblock).
      ...(this.deps.visualGate ? { visualGate: this.deps.visualGate } : {}),
      ...(enqueueVisualVerification ? { enqueueVisualVerification } : {}),
      ...(laneTriageTaskReader ? { readLaneTask: (itemId: string) => laneTriageTaskReader(ctx.runId, itemId) } : {}),
      ...(laneTriageAdjustTask
        ? { adjustRunTask: (input: { taskRef: string; body: string }) => laneTriageAdjustTask(ctx.runId, input) }
        : {}),
      ...(laneTriageFindingSink
        ? {
            fileLaneTriageFinding: (input: { title: string; body: string }) =>
              laneTriageFindingSink(ctx.runId, input),
          }
        : {}),
      ...(monitorFindingSink
        ? {
            fileMonitorFinding: (input: { title: string; body: string; category?: string }) =>
              monitorFindingSink(ctx.runId, input),
          }
        : {}),
      ...(setAsideFindingSink
        ? { fileSetAsideFinding: (input: SetAsideFindingInput) => setAsideFindingSink(ctx.runId, input) }
        : {}),
      // ESCALATION REVIEW. No `onGateOpened` is passed: the host builds its own
      // gate-open hook from `reviewGateEscalation` whenever a capable monitor is
      // wired, and `args.onGateOpened` stays a test-only override. These five are
      // the readers/writers that hook — and item 9's step-boundary sibling —
      // need: the queue list, the annotate, the autonomous resolve, its durable
      // budget, and the write barrier the boundary reads behind.
      ...(escalationSinks
        ? {
            listRunReviewItems: (runId: string) => escalationSinks.listRunReviewItems(runId),
            annotateReviewItem: (input: { reviewItemId: string; markdown: string }) =>
              escalationSinks.annotate(ctx.runId, input),
            resolveReviewItemAsMonitor: (input: { reviewItemId: string; resolution: string }) =>
              escalationSinks.resolveAsMonitor(ctx.runId, input),
            countMonitorResolves: (runId: string) => escalationSinks.countMonitorResolves(runId),
            awaitReviewWritesSettled: (projectId: number) => escalationSinks.awaitWritesSettled(projectId),
          }
        : {}),
      // F8 "never skip silently" (docs/proposals/visual-verification-brittleness-
      // fixes.md): a visual verification dropped BEFORE a request row exists
      // reaches the human through the SAME ReviewItemRouter chokepoint + the same
      // 'visual-verify' source tag verdictDelivery uses for the gate-side skips,
      // so both kinds of "it did not run" land in one place in the review queue.
      fileVerificationSkipFinding: (input: { title: string; body: string }) =>
        fileVerificationSkipFinding(ctx.run.project_id, ctx.runId, input),
      // CD1/CD3 — the two RUN-SCOPED declarations, both deduped on `source`
      // through createIfNoPending. Wired unconditionally (the sink itself is
      // cheap and idempotent); the POSTURE resolver and the BUILD-BREAK sweep are
      // each gated on the dep they actually need, so a runner built without a DB
      // (or without the shared runbook-status closure) keeps its pre-seam
      // behaviour rather than resolving a posture from nothing.
      fileRunScopedFinding: (input: { source: string; title: string; body: string }) =>
        fileRunScopedFinding(ctx.run.project_id, ctx.runId, input),
      ...(postureDb !== undefined && verifyRunbookStatus !== undefined
        ? {
            resolveVerificationPosture: () =>
              resolveVerificationPosture(
                {
                  readRunStamp: (runId: string) => readVerificationRunStamp(postureDb, runId),
                  runbookStatus: verifyRunbookStatus,
                  ...(verifyLiveConfig !== undefined ? { liveConfig: verifyLiveConfig } : {}),
                },
                ctx.runId,
              ),
          }
        : {}),
      ...(postureDb !== undefined
        ? {
            sweepBuildBreaks: () =>
              sweepBuildBreaks(postureDb, { runId: ctx.runId, projectId: ctx.run.project_id }),
          }
        : {}),
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
