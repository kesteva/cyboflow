/**
 * proposalExecutor — the ONLY code path that turns a user-confirmed global-agent
 * proposal into real side effects. The agent PROPOSES (records an
 * `agent_proposals` row); the user's Confirm click is what executes, server-side,
 * through the existing chokepoints, stamped `actor: 'user'` (a human confirming is
 * the human's decision — the same convention resolveReviewItemHandler.ts:45-46
 * documents).
 *
 * Execution is a CRASH-RECOVERABLE, IDEMPOTENT state machine (plan §2.5), not
 * execute-then-persist:
 *   1. CAS CLAIM — store.claimProposal stamps status 'proposed'->'executing' + the
 *      idempotency key. 0 rows updated ⇒ another caller won (double-click / retry) ⇒
 *      { ok:false, reason:'claimed' }. A missing row ⇒ { ok:false, reason:'not-found' }.
 *   2. PRECONDITION CHECK (edit-workflow only — spec-hash CAS): a mismatch supersedes
 *      the proposal with a refreshed-diff loopback turn, never a blind overwrite.
 *      (launch-run, create-backlog-items and triage-findings carry no precondition;
 *      reprioritize's per-task expectedVersions are consumed PER ITEM by the
 *      chokepoint, not as a whole-proposal gate; a triage item no longer pending at
 *      confirm time is skipped per item.)
 *   3. SIDE EFFECTS through the chokepoints, carrying the idempotency key / expected
 *      versions where the target supports them. launch-run runs a COMPENSATION SAGA:
 *      created resources are tracked and unwound in reverse on any post-session
 *      failure, with each compensation step's outcome persisted for reconciliation.
 *      create-workflow runs the same saga shape: agents first, then the flow, and
 *      every agent minted so far is deleted again when a later step fails.
 *      start-quick-session likewise: the session is minted first, then its brief is
 *      delivered as the first prompt, and a delivery failure dismisses the session.
 *   4. TERMINAL TRANSITION — store.finalizeProposal to 'executed' | 'failed' with a
 *      typed result_json (the card renders it: per-item ✓/✕, saga detail, etc.).
 *   5. BOOT RECONCILIATION — reconcileOrphanedExecutingProposals verifies OBSERVABLE
 *      side effects for every row stranded 'executing' by a crash and finalizes it to
 *      'executed' or 'failed':'crashed-mid-execution'. It NEVER re-runs side effects.
 *
 * open-session is NOT executable here: it is pure renderer navigation. The executor
 * rejects it ({ ok:false, reason:'not-executable' }); the client (S1.3) performs the
 * navigation and the tRPC router marks the proposal executed through a SEPARATE store
 * call. Do not implement that path here.
 *
 * Standalone-typecheck invariant (mirrors resolveReviewItemHandler.ts): NO imports
 * from 'electron', 'better-sqlite3', or main/src/services/*. Every collaborator is a
 * structural closure injected via {@link ProposalExecutorDeps}, so the pure module
 * runs against fakes in tests and the concrete singletons (RunLauncher /
 * createQuickSessionCore / TaskChangeRouter / WorkflowRegistry) wire at the boot
 * composition root (main/src/index.ts, next to setExperimentsDeps).
 */
import { computeSpecHash } from './specHash';
import { workflowDefinitionSchema } from '../workflowDefinitionSchema';
import { deriveAgentKey } from '../agents/agentValidation';
import type { LoggerLike } from '../types';
import type { PermissionMode, WorkflowDefinition, CyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { Priority } from '../../../../shared/types/tasks';
import type {
  AgentProposal,
  AgentProposalKind,
  AgentProposalStatus,
  CreateBacklogItem,
  CreateBacklogItemsProposalPayload,
  CreateWorkflowAgent,
  CreateWorkflowProposalPayload,
  EditWorkflowProposalPayload,
  LaunchRunProposalPayload,
  ReprioritizeBacklogProposalPayload,
  StartQuickSessionProposalPayload,
  TriageFindingItem,
  TriageFindingOp,
  TriageFindingsProposalPayload,
} from '../../../../shared/types/agentThread';

// ---------------------------------------------------------------------------
// Collaborator deps (injected — standalone-typecheck invariant)
// ---------------------------------------------------------------------------

/**
 * The narrow subset of AgentThreadDbStore the executor needs. Declared here (not
 * imported as the concrete class) so a fake with realistic CAS semantics drives the
 * tests. The real AgentThreadDbStore satisfies this structurally.
 */
export interface AgentProposalStoreLike {
  getProposal(id: string): AgentProposal | null;
  claimProposal(id: string, idempotencyKey: string): boolean;
  finalizeProposal(id: string, status: 'executed' | 'failed', resultJson: string | null): boolean;
  supersedeProposal(id: string, resultJson?: string | null): boolean;
  listProposalsByStatus(status: AgentProposalStatus): AgentProposal[];
}

/**
 * The launch-run side effect, high-level. The wiring closure
 * (proposalExecutorLaunchDeps.ts) resolves the workflow row — by `workflowId`
 * when the proposal carries one, else by `workflowName` — plus the project
 * path, and maps the seeds to RunLauncher.launch's positional params by the
 * flow's SHAPE (`seedKindForWorkflow`: taskIds→a task fan-out flow,
 * ideaIds→a plan-phase flow, findingIds→a compound-shaped flow), never by the
 * row's display name, so a custom sprint-shaped flow seeds like the built-in.
 * Seeds the resolved shape does not take are dropped and reported back as
 * `ignoredSeeds` so the result card can say so. The executor stays free of
 * workflow-resolution concerns and owns only the session→run sequencing +
 * compensation saga.
 */
export interface LaunchRunSideEffectArgs {
  projectId: number;
  /** Display name — a built-in name or a custom flow's; used for the session-name template. */
  workflowName: CyboflowWorkflowName | string;
  /** The resolved workflows.id, when the proposal was stamped with one (custom flows always are). */
  workflowId?: string;
  sessionId: string;
  substrate?: CliSubstrate;
  taskIds?: string[];
  ideaIds?: string[];
  findingIds?: string[];
}

/** What the executor asks the boot layer to mint for a start-quick-session confirm. */
export interface StartQuickSessionArgs {
  projectId: number;
  /** A branch-safe slug (normalized at propose time); absent → the boot layer mints one. */
  name?: string;
  /** Absent → the project's quick-session default (the wizard's PTY/SDK choice). */
  substrate?: CliSubstrate;
  inPlace: boolean;
}

/** The minted session — everything the brief delivery and the card need. */
export interface StartQuickSessionCreated {
  sessionId: string;
  /** The `__quick__` sentinel run (what open-session navigation carries as runId). */
  runId: string;
  worktreePath: string;
  /** The session's actual name (the slug, possibly `-<n>` suffixed on a collision). */
  name: string;
  /** The RESOLVED substrate the sentinel landed on — decides how the brief is delivered. */
  substrate: CliSubstrate;
}

/** One reprioritize applyChange, actor pinned 'user' by the executor. */
export interface ReprioritizeTaskChange {
  actor: 'user';
  taskId: string;
  expectedVersion?: number;
  fields?: { priority: Priority };
  stageId?: string;
}

/** Live task fields read during boot reconciliation of a reprioritize proposal. */
export interface TaskFieldsSnapshot {
  priority: Priority | null;
  stageId: string | null;
}

/**
 * One triage-findings write, actor pinned 'user' by the executor. Each shape
 * is a ReviewItemRouter.applyReviewItem op verbatim (the wiring closure
 * forwards it as-is), so the executor adds no write path of its own.
 */
export type TriageReviewItemChange =
  | { op: 'resolve' | 'dismiss'; actor: 'user'; reviewItemId: string; resolution?: string | null }
  | { op: 'approve'; actor: 'user'; reviewItemId: string }
  | { op: 'set-selected'; actor: 'user'; reviewItemIds: string[]; selected: boolean };

/** Live review-item state read before each triage write and during reconciliation. */
export interface ReviewItemStateSnapshot {
  status: 'pending' | 'resolved' | 'dismissed';
  stagedAt: string | null;
  selected: boolean;
}

export interface ProposalExecutorDeps {
  /** The agent_proposals CAS store (the single writer for the status machine). */
  store: AgentProposalStoreLike;
  /** Fresh idempotency key per confirm; stamped at CAS-claim time, carried into side effects. */
  newIdempotencyKey: () => string;

  // --- launch-run: create the host session, launch the run, compensate on failure ---
  /** Mint a fresh quick host session (createQuickSessionCore) — worktree + sentinel run. */
  createQuickSession: (opts: {
    projectId: number;
    nameHint: string;
  }) => Promise<{ sessionId: string; worktreePath: string }>;
  /**
   * Launch the seeded workflow run into the host session (RunLauncher.launch).
   * `ignoredSeeds` names the seed fields the flow's shape does not consume and
   * that were therefore dropped before the launch (never an error).
   */
  launchRun: (
    args: LaunchRunSideEffectArgs,
  ) => Promise<{ runId: string; worktreePath: string; branchName: string; ignoredSeeds?: LaunchSeedField[] }>;
  /** Compensation: cancel a run created before a later boundary failed (git-neutral). */
  cancelRun: (runId: string) => Promise<void>;
  /** Compensation: the FULL safe session-dismiss path (cancels hosted runs, then removes the worktree). */
  dismissSession: (sessionId: string) => Promise<void>;
  /** Reconciliation: does the run recorded in an orphan's result_json still exist? */
  runExists: (runId: string) => boolean;

  // --- start-quick-session: mint a USER quick session, then deliver its brief ---
  /**
   * Mint a quick session the way the launch wizard does (createQuickSessionCore
   * + the runtime-config stamps), on the requested or default substrate. Unlike
   * `createQuickSession` above this is a user session, never SDK-pinned.
   */
  startQuickSession: (args: StartQuickSessionArgs) => Promise<StartQuickSessionCreated>;
  /**
   * Deliver the brief as the session's FIRST prompt on its resolved substrate
   * (SDK: the chat panel's first turn; PTY: the REPL's spawn prompt). Resolves
   * to the chat panel it created; throws when the delivery could not start —
   * the executor then dismisses the session it just minted.
   */
  deliverQuickSessionBrief: (args: StartQuickSessionCreated & { brief: string }) => Promise<{ claudePanelId: string }>;

  // --- reprioritize-backlog: sequential per-item applyChange, partial-failure tolerant ---
  /** One TaskChangeRouter.applyChange (actor 'user'); throws (TaskChangeError) on rejection. */
  applyTaskChange: (projectId: number, change: ReprioritizeTaskChange) => Promise<void>;
  /** Reconciliation: the task's current priority/stage (null when the task is gone). */
  readTaskFields: (projectId: number, taskId: string) => TaskFieldsSnapshot | null;

  // --- create-backlog-items: sequential per-item create, partial-failure tolerant ---
  /**
   * One TaskChangeRouter.applyChange CREATE (actor 'user'); resolves to the new
   * entity's opaque id + display ref, and throws (TaskChangeError) on rejection —
   * `idea_needs_epic` / `invalid_parent` / `invalid_lineage` all surface here as a
   * per-item error rather than aborting the batch.
   */
  createBacklogItem: (
    projectId: number,
    item: CreateBacklogItem,
  ) => Promise<{ taskId: string; ref?: string }>;

  // --- edit-workflow: spec-hash CAS + safeParse + updateSpec, all inside one transaction ---
  /** better-sqlite3 transaction wrapper — the read-hash-compare-apply core runs atomically inside it. */
  runInTransaction: <T>(fn: () => T) => T;
  /** The workflow's CURRENT effective definition value to hash (null when the workflow is gone). */
  readEffectiveWorkflowSpec: (workflowId: string) => unknown | null;
  /** Persist the validated definition (WorkflowRegistry.updateSpec) — caller has already validated. */
  applyWorkflowSpec: (workflowId: string, definition: WorkflowDefinition) => void;

  // --- create-workflow: mint the agents, then the flow; unwind the agents on failure ---
  /**
   * One AgentOverrideRouter.applyChange createCustom for `projectId`; resolves to
   * the minted kebab key and throws (AgentOverrideError) on rejection.
   */
  createCustomAgent: (projectId: number, agent: CreateWorkflowAgent) => Promise<{ agentKey: string }>;
  /** Compensation: AgentOverrideRouter.applyChange deleteCustom for an agent this confirm minted. */
  deleteCustomAgent: (projectId: number, agentKey: string) => Promise<void>;
  /**
   * WorkflowRegistry.createCustom — `projectId` null mints a GLOBAL flow. Throws
   * on a name collision / reserved name (the registry's own guards).
   */
  createWorkflow: (args: {
    projectId: number | null;
    name: string;
    definition: WorkflowDefinition;
    permissionMode?: PermissionMode;
  }) => { workflowId: string };
  /** Reconciliation: the id of the workflow named `name` in that scope, or null. */
  findWorkflowIdByName: (projectId: number | null, name: string) => string | null;
  /** Reconciliation: does `projectId` carry a custom agent under `agentKey`? */
  customAgentExists: (projectId: number, agentKey: string) => boolean;

  // --- triage-findings: sequential per-item ReviewItemRouter writes, skip-tolerant ---
  /** One ReviewItemRouter.applyReviewItem (actor 'user'); throws (ReviewItemError) on rejection. */
  applyReviewItemChange: (projectId: number, change: TriageReviewItemChange) => Promise<void>;
  /** The item's current status / staged / selected state (null when it is gone or belongs elsewhere). */
  readReviewItemState: (projectId: number, reviewItemId: string) => ReviewItemStateSnapshot | null;

  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Typed result_json shapes (stored verbatim; the card + reconciliation read them)
// ---------------------------------------------------------------------------

interface CompensationStep {
  step: 'cancel-run' | 'dismiss-session';
  ok: boolean;
  error?: string;
}

/** The three launch seed fields a proposal may carry. */
export type LaunchSeedField = 'taskIds' | 'ideaIds' | 'findingIds';

export interface LaunchRunResultJson {
  kind: 'launch-run';
  status: 'executed' | 'failed';
  sessionId?: string;
  worktreePath?: string;
  runId?: string;
  branchName?: string;
  /** Seed fields the launched flow's shape does not take, dropped before launch. */
  ignoredSeeds?: LaunchSeedField[];
  error?: string;
  compensations?: CompensationStep[];
  /** Set by boot reconciliation (not the live confirm path). */
  reconciled?: boolean;
  verified?: string;
}

export interface ReprioritizeItemResultJson {
  taskId: string;
  ok: boolean;
  error?: string;
}

export interface ReprioritizeResultJson {
  kind: 'reprioritize-backlog';
  status: 'executed' | 'failed';
  items: ReprioritizeItemResultJson[];
  reconciled?: boolean;
}

export interface EditWorkflowResultJson {
  kind: 'edit-workflow';
  status: 'executed' | 'failed' | 'superseded';
  workflowId: string;
  appliedHash?: string;
  expectedHash?: string;
  actualHash?: string;
  reason?: 'spec-hash-mismatch' | 'validation-failed' | 'workflow-not-found' | 'missing-precondition' | 'crashed-mid-execution';
  issues?: string[];
  reconciled?: boolean;
}

export interface CreateBacklogItemResultJson {
  /** Position in the proposed batch — the only stable identity a not-yet-created entity has. */
  index: number;
  title: string;
  taskType: 'idea' | 'epic' | 'task';
  ok: boolean;
  /** Present on success: the minted entity's opaque id + display ref. */
  taskId?: string;
  ref?: string;
  error?: string;
}

export interface CreateBacklogResultJson {
  kind: 'create-backlog-items';
  status: 'executed' | 'failed';
  items: CreateBacklogItemResultJson[];
  reconciled?: boolean;
}

export interface CreateWorkflowAgentResultJson {
  /** Position in the proposed batch (the only stable identity before the key is minted). */
  index: number;
  name: string;
  ok: boolean;
  /** Present once the chokepoint minted it (or, on compensation, the key that was unwound). */
  agentKey?: string;
  error?: string;
}

export interface CreateWorkflowResultJson {
  kind: 'create-workflow';
  status: 'executed' | 'failed';
  name: string;
  /** Present on success: the registry-minted workflow id. */
  workflowId?: string;
  agents: CreateWorkflowAgentResultJson[];
  /** The step that failed, when one did. */
  error?: string;
  /** Agents unwound after a later failure, with each delete's outcome. */
  compensations?: Array<{ agentKey: string; ok: boolean; error?: string }>;
  /** Set by boot reconciliation (not the live confirm path). */
  reconciled?: boolean;
  verified?: string;
}

export interface TriageFindingItemResultJson {
  reviewItemId: string;
  op: TriageFindingOp;
  ok: boolean;
  /**
   * Present when the item was NOT written because someone else got there
   * first (it was no longer pending at confirm time, or no longer exists) —
   * reported, never a batch failure. `ok` is false on a skipped row.
   */
  skipped?: string;
  error?: string;
}

export interface TriageFindingsResultJson {
  kind: 'triage-findings';
  status: 'executed' | 'failed';
  items: TriageFindingItemResultJson[];
  /** Rows written through the chokepoint. */
  applied: number;
  /** Rows skipped as superseded (not counted as failures). */
  skipped: number;
  reconciled?: boolean;
}

export interface StartQuickSessionResultJson {
  kind: 'start-quick-session';
  status: 'executed' | 'failed';
  sessionId?: string;
  /** The `__quick__` sentinel run id — what the card's Open navigation carries. */
  runId?: string;
  worktreePath?: string;
  sessionName?: string;
  substrate?: CliSubstrate;
  claudePanelId?: string;
  error?: string;
  compensations?: CompensationStep[];
  /** Set by boot reconciliation (not the live confirm path). */
  reconciled?: boolean;
}

export type ProposalResultJson =
  | LaunchRunResultJson
  | ReprioritizeResultJson
  | EditWorkflowResultJson
  | CreateBacklogResultJson
  | CreateWorkflowResultJson
  | TriageFindingsResultJson
  | StartQuickSessionResultJson;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Discriminated result. `ok:false` is a REFUSAL the caller acts on: 'claimed' /
 * 'not-found' / 'not-executable' render a card state, 'superseded' / 'validation-failed'
 * additionally carry a `loopbackTurn` the router injects into the thread as the agent's
 * next turn (so a stale/invalid edit loops back for revision, not a dead end). `ok:true`
 * means the side effects RAN to a terminal state — `status` distinguishes 'executed' from
 * a fully-attempted 'failed' (partial reprioritize / compensated launch); either way the
 * card reads `result` (= the persisted result_json).
 */
export type ExecuteProposalResult =
  | { ok: true; proposalId: string; kind: AgentProposalKind; status: 'executed' | 'failed'; result: ProposalResultJson }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'claimed' }
  | { ok: false; reason: 'not-executable' }
  | { ok: false; reason: 'superseded'; loopbackTurn: string }
  | { ok: false; reason: 'validation-failed'; loopbackTurn: string };

// ---------------------------------------------------------------------------
// Late-bound deps holder (composition root wires it once at boot; the router +
// boot reconciliation read it — mirrors setStartRunDeps / setExperimentsDeps).
// ---------------------------------------------------------------------------

let wiredDeps: ProposalExecutorDeps | null = null;

/** Wire the real collaborators at boot (main/src/index.ts). */
export function setProposalExecutorDeps(deps: ProposalExecutorDeps): void {
  wiredDeps = deps;
}

/** The wired deps, or throw if the composition root has not run yet. */
export function getProposalExecutorDeps(): ProposalExecutorDeps {
  if (!wiredDeps) {
    throw new Error('proposal executor dependencies not wired yet. Call setProposalExecutorDeps() at boot.');
  }
  return wiredDeps;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A stable, human-readable worktree/session name for an agent-launched run. */
function launchNameHint(payload: LaunchRunProposalPayload, proposalId: string): string {
  return `agent-${payload.workflowName}-${proposalId.slice(0, 8)}`;
}

/** Format zod issues as one prose line each (`path: message`) for a loopback turn. */
function formatZodIssues(issues: readonly { path: readonly (string | number)[]; message: string }[]): string[] {
  return issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`);
}

/** Safely pull a string runId off an orphan proposal's parsed result_json. */
function resultRunId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const runId = (result as { runId?: unknown }).runId;
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}

// ---------------------------------------------------------------------------
// executeProposal — the Confirm entry point (§2.5 state machine)
// ---------------------------------------------------------------------------

export async function executeProposal(
  deps: ProposalExecutorDeps,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  const proposal = deps.store.getProposal(proposalId);
  if (!proposal) return { ok: false, reason: 'not-found' };

  // open-session is renderer navigation, never a server side effect. Reject BEFORE
  // claiming so its row is never transitioned to 'executing' — the router marks it
  // executed via a separate store call once the client has navigated (S1.3).
  if (proposal.kind === 'open-session') {
    return { ok: false, reason: 'not-executable' };
  }

  // 1. CAS CLAIM. 'proposed' -> 'executing' + idempotency key. A loser (already
  // executing/executed/dismissed/superseded, or a same-instant double-confirm) matches
  // zero rows and is rejected without touching the winner's key.
  const idempotencyKey = deps.newIdempotencyKey();
  if (!deps.store.claimProposal(proposalId, idempotencyKey)) {
    return { ok: false, reason: 'claimed' };
  }

  switch (proposal.kind) {
    case 'launch-run':
      return runLaunch(deps, proposal, proposal.payload as LaunchRunProposalPayload, proposalId);
    case 'reprioritize-backlog':
      return runReprioritize(deps, proposal, proposal.payload as ReprioritizeBacklogProposalPayload, proposalId);
    case 'edit-workflow':
      return runEditWorkflow(deps, proposal, proposal.payload as EditWorkflowProposalPayload, proposalId);
    case 'create-backlog-items':
      return runCreateBacklogItems(
        deps,
        proposal,
        proposal.payload as CreateBacklogItemsProposalPayload,
        proposalId,
      );
    case 'create-workflow':
      return runCreateWorkflow(deps, proposal, proposal.payload as CreateWorkflowProposalPayload, proposalId);
    case 'triage-findings':
      return runTriageFindings(deps, proposal, proposal.payload as TriageFindingsProposalPayload, proposalId);
    case 'start-quick-session':
      return runStartQuickSession(deps, proposal, proposal.payload as StartQuickSessionProposalPayload, proposalId);
    default:
      // Unreachable: open-session is handled above, and the union is closed. Finalize
      // failed defensively so a future kind never strands the claimed row.
      deps.store.finalizeProposal(proposalId, 'failed', JSON.stringify({ error: `unsupported proposal kind '${proposal.kind}'` }));
      return {
        ok: true,
        proposalId,
        kind: proposal.kind,
        status: 'failed',
        result: { kind: 'launch-run', status: 'failed', error: `unsupported proposal kind '${proposal.kind}'` },
      };
  }
}

// ---------------------------------------------------------------------------
// launch-run — createQuickSession -> launchRun, with the compensation saga
// ---------------------------------------------------------------------------

async function runLaunch(
  deps: ProposalExecutorDeps,
  proposal: AgentProposal,
  payload: LaunchRunProposalPayload,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  // Track created resources so a failure at any post-session boundary can unwind them
  // in reverse (the A/B experiments rollback ladder model).
  const created: { sessionId?: string; worktreePath?: string; runId?: string } = {};

  try {
    const session = await deps.createQuickSession({
      projectId: payload.projectId,
      nameHint: launchNameHint(payload, proposalId),
    });
    created.sessionId = session.sessionId;
    created.worktreePath = session.worktreePath;

    const run = await deps.launchRun({
      projectId: payload.projectId,
      workflowName: payload.workflowName,
      ...(payload.workflowId !== undefined ? { workflowId: payload.workflowId } : {}),
      sessionId: session.sessionId,
      substrate: payload.substrate,
      taskIds: payload.taskIds,
      ideaIds: payload.ideaIds,
      findingIds: payload.findingIds,
    });
    created.runId = run.runId;

    const result: LaunchRunResultJson = {
      kind: 'launch-run',
      status: 'executed',
      sessionId: session.sessionId,
      worktreePath: run.worktreePath,
      runId: run.runId,
      branchName: run.branchName,
      ...(run.ignoredSeeds !== undefined && run.ignoredSeeds.length > 0 ? { ignoredSeeds: run.ignoredSeeds } : {}),
    };
    deps.store.finalizeProposal(proposalId, 'executed', JSON.stringify(result));
    return { ok: true, proposalId, kind: proposal.kind, status: 'executed', result };
  } catch (err) {
    // Compensate in reverse. dismissSession internally cancels hosted runs + removes
    // the worktree, so it is the sufficient session unwind; cancelRun runs first only
    // when a runId was already minted (a post-launch boundary failed).
    const compensations = await compensateLaunch(deps, created);
    const result: LaunchRunResultJson = {
      kind: 'launch-run',
      status: 'failed',
      error: errMsg(err),
      ...(created.sessionId !== undefined ? { sessionId: created.sessionId } : {}),
      ...(created.worktreePath !== undefined ? { worktreePath: created.worktreePath } : {}),
      ...(created.runId !== undefined ? { runId: created.runId } : {}),
      ...(compensations.length > 0 ? { compensations } : {}),
    };
    deps.store.finalizeProposal(proposalId, 'failed', JSON.stringify(result));
    return { ok: true, proposalId, kind: proposal.kind, status: 'failed', result };
  }
}

/** Unwind created launch resources in reverse; a compensation failure is RECORDED, never thrown away. */
async function compensateLaunch(
  deps: ProposalExecutorDeps,
  created: { sessionId?: string; runId?: string },
): Promise<CompensationStep[]> {
  const steps: CompensationStep[] = [];
  if (created.runId !== undefined) {
    try {
      await deps.cancelRun(created.runId);
      steps.push({ step: 'cancel-run', ok: true });
    } catch (err) {
      steps.push({ step: 'cancel-run', ok: false, error: errMsg(err) });
    }
  }
  if (created.sessionId !== undefined) {
    try {
      await deps.dismissSession(created.sessionId);
      steps.push({ step: 'dismiss-session', ok: true });
    } catch (err) {
      steps.push({ step: 'dismiss-session', ok: false, error: errMsg(err) });
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// start-quick-session — startQuickSession -> deliverQuickSessionBrief, with the
// same two-boundary compensation shape as launch-run
// ---------------------------------------------------------------------------

async function runStartQuickSession(
  deps: ProposalExecutorDeps,
  proposal: AgentProposal,
  payload: StartQuickSessionProposalPayload,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  let created: StartQuickSessionCreated | undefined;
  try {
    created = await deps.startQuickSession({
      projectId: payload.projectId,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.substrate !== undefined ? { substrate: payload.substrate } : {}),
      inPlace: payload.inPlace === true,
    });
    const { claudePanelId } = await deps.deliverQuickSessionBrief({ ...created, brief: payload.brief });
    const result: StartQuickSessionResultJson = {
      kind: 'start-quick-session',
      status: 'executed',
      sessionId: created.sessionId,
      runId: created.runId,
      worktreePath: created.worktreePath,
      sessionName: created.name,
      substrate: created.substrate,
      claudePanelId,
    };
    deps.store.finalizeProposal(proposalId, 'executed', JSON.stringify(result));
    return { ok: true, proposalId, kind: proposal.kind, status: 'executed', result };
  } catch (err) {
    // A session minted before the brief could start is dismissed again (the
    // FULL dismiss: hosted sentinel cancelled, worktree removed) — never left
    // as an idle orphan the human has to find. No runId step: the sentinel is
    // the session's own and goes with it.
    const compensations = created !== undefined ? await compensateLaunch(deps, { sessionId: created.sessionId }) : [];
    const result: StartQuickSessionResultJson = {
      kind: 'start-quick-session',
      status: 'failed',
      error: errMsg(err),
      ...(created !== undefined
        ? { sessionId: created.sessionId, runId: created.runId, worktreePath: created.worktreePath, sessionName: created.name, substrate: created.substrate }
        : {}),
      ...(compensations.length > 0 ? { compensations } : {}),
    };
    deps.store.finalizeProposal(proposalId, 'failed', JSON.stringify(result));
    return { ok: true, proposalId, kind: proposal.kind, status: 'failed', result };
  }
}

// ---------------------------------------------------------------------------
// reprioritize-backlog — sequential per-item applyChange, partial-failure tolerant
// ---------------------------------------------------------------------------

async function runReprioritize(
  deps: ProposalExecutorDeps,
  proposal: AgentProposal,
  payload: ReprioritizeBacklogProposalPayload,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  const expectedVersions =
    proposal.preconditions?.kind === 'reprioritize-backlog' ? proposal.preconditions.expectedVersions : {};

  const items: ReprioritizeItemResultJson[] = [];
  let anyFailed = false;
  // NO atomic batch chokepoint exists (TaskChangeRouter.applyChange is one change per
  // call). Each item is its own call; a failure does NOT abort later items — the card
  // renders per-row ✓/✕ from the collected results.
  for (const item of payload.items) {
    const change: ReprioritizeTaskChange = { actor: 'user', taskId: item.taskId };
    if (item.priority !== undefined) change.fields = { priority: item.priority };
    if (item.stageId !== undefined) change.stageId = item.stageId;
    const expectedVersion = expectedVersions[item.taskId];
    if (expectedVersion !== undefined) change.expectedVersion = expectedVersion;

    try {
      await deps.applyTaskChange(payload.projectId, change);
      items.push({ taskId: item.taskId, ok: true });
    } catch (err) {
      anyFailed = true;
      items.push({ taskId: item.taskId, ok: false, error: errMsg(err) });
    }
  }

  const status: 'executed' | 'failed' = anyFailed ? 'failed' : 'executed';
  const result: ReprioritizeResultJson = { kind: 'reprioritize-backlog', status, items };
  deps.store.finalizeProposal(proposalId, status, JSON.stringify(result));
  return { ok: true, proposalId, kind: proposal.kind, status, result };
}

// ---------------------------------------------------------------------------
// create-backlog-items — sequential per-item create, partial-failure tolerant
// ---------------------------------------------------------------------------

async function runCreateBacklogItems(
  deps: ProposalExecutorDeps,
  proposal: AgentProposal,
  payload: CreateBacklogItemsProposalPayload,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  const items: CreateBacklogItemResultJson[] = [];
  let anyFailed = false;
  // Same posture as runReprioritize: TaskChangeRouter.applyChange is one entity per
  // call, so each item is its own call and a rejection (idea_needs_epic /
  // invalid_parent / a vanished parent) does NOT abort the rest — the card renders
  // per-row ✓/✕. Order is preserved so an epic listed before its children is created
  // first; that ordering is the assistant's to get right, not something enforced here.
  for (const [index, item] of payload.items.entries()) {
    try {
      const created = await deps.createBacklogItem(payload.projectId, item);
      items.push({
        index,
        title: item.title,
        taskType: item.taskType,
        ok: true,
        taskId: created.taskId,
        ...(created.ref !== undefined ? { ref: created.ref } : {}),
      });
    } catch (err) {
      anyFailed = true;
      items.push({ index, title: item.title, taskType: item.taskType, ok: false, error: errMsg(err) });
    }
  }

  const status: 'executed' | 'failed' = anyFailed ? 'failed' : 'executed';
  const result: CreateBacklogResultJson = { kind: 'create-backlog-items', status, items };
  deps.store.finalizeProposal(proposalId, status, JSON.stringify(result));
  return { ok: true, proposalId, kind: proposal.kind, status, result };
}

// ---------------------------------------------------------------------------
// create-workflow — agents first, then the flow, with an agent-unwind saga
// ---------------------------------------------------------------------------

async function runCreateWorkflow(
  deps: ProposalExecutorDeps,
  proposal: AgentProposal,
  payload: CreateWorkflowProposalPayload,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  const scopeProjectId = payload.scope === 'global' ? null : payload.projectId;
  const agents: CreateWorkflowAgentResultJson[] = [];
  const minted: string[] = [];

  // Unwind every agent minted so far, in reverse. Each delete's outcome is
  // recorded (never thrown away) so a half-unwound confirm is legible to the
  // human and to reconciliation — the same posture as launch-run's saga.
  const compensate = async (): Promise<CreateWorkflowResultJson['compensations']> => {
    const outcomes: NonNullable<CreateWorkflowResultJson['compensations']> = [];
    for (const agentKey of [...minted].reverse()) {
      try {
        await deps.deleteCustomAgent(payload.projectId, agentKey);
        outcomes.push({ agentKey, ok: true });
      } catch (err) {
        outcomes.push({ agentKey, ok: false, error: errMsg(err) });
      }
    }
    return outcomes;
  };

  const fail = async (error: string): Promise<ExecuteProposalResult> => {
    const compensations = await compensate();
    const result: CreateWorkflowResultJson = {
      kind: 'create-workflow',
      status: 'failed',
      name: payload.name,
      agents,
      error,
      ...(compensations && compensations.length > 0 ? { compensations } : {}),
    };
    deps.store.finalizeProposal(proposalId, 'failed', JSON.stringify(result));
    return { ok: true, proposalId, kind: proposal.kind, status: 'failed', result };
  };

  // 1. Agents, in order. The flow's steps bind these keys, so they must exist
  // BEFORE the flow does — a flow whose bindings dangle would spawn nothing on
  // its first run. Unlike create-backlog-items this is all-or-nothing: a flow
  // with half its agents is not a usable deliverable.
  for (const [index, agent] of (payload.agents ?? []).entries()) {
    try {
      const { agentKey } = await deps.createCustomAgent(payload.projectId, agent);
      minted.push(agentKey);
      agents.push({ index, name: agent.name, ok: true, agentKey });
    } catch (err) {
      agents.push({ index, name: agent.name, ok: false, error: errMsg(err) });
      return fail(`agent "${agent.name}" was not created: ${errMsg(err)}`);
    }
  }

  // 2. The flow. Re-parse what prepareProposal validated; a definition that no
  // longer parses here is a persisted-row corruption, not a user error.
  let definition: WorkflowDefinition;
  try {
    const parsed = workflowDefinitionSchema.safeParse(JSON.parse(payload.definitionJson));
    if (!parsed.success) return fail(`definition did not validate: ${formatZodIssues(parsed.error.issues).join('; ')}`);
    definition = parsed.data;
  } catch (err) {
    return fail(`definitionJson is not valid JSON: ${errMsg(err)}`);
  }
  let workflowId: string;
  try {
    ({ workflowId } = deps.createWorkflow({
      projectId: scopeProjectId,
      name: payload.name,
      definition,
      ...(payload.permissionMode !== undefined ? { permissionMode: payload.permissionMode } : {}),
    }));
  } catch (err) {
    return fail(`workflow "${payload.name}" was not created: ${errMsg(err)}`);
  }

  const result: CreateWorkflowResultJson = {
    kind: 'create-workflow',
    status: 'executed',
    name: payload.name,
    workflowId,
    agents,
  };
  deps.store.finalizeProposal(proposalId, 'executed', JSON.stringify(result));
  return { ok: true, proposalId, kind: proposal.kind, status: 'executed', result };
}

// ---------------------------------------------------------------------------
// triage-findings — sequential per-item chokepoint writes, superseded-tolerant
// ---------------------------------------------------------------------------

/** The chokepoint change(s) one triage item maps to, given the row's live state. */
function triageChanges(item: TriageFindingItem, live: ReviewItemStateSnapshot): TriageReviewItemChange[] {
  const id = item.reviewItemId;
  switch (item.op) {
    case 'dismiss':
    case 'resolve':
      return [{ op: item.op, actor: 'user', reviewItemId: id, resolution: item.resolution ?? null }];
    case 'approve':
      return [{ op: 'approve', actor: 'user', reviewItemId: id }];
    case 'set-selected': {
      const selected = item.selected === true;
      // Selecting an unstaged finding stages it first: the chokepoint only
      // toggles READY (staged) rows, and "stage for Compound" is one decision
      // from the human's side, not two clicks.
      const stage: TriageReviewItemChange[] = selected && live.stagedAt === null ? [{ op: 'approve', actor: 'user', reviewItemId: id }] : [];
      return [...stage, { op: 'set-selected', actor: 'user', reviewItemIds: [id], selected }];
    }
  }
}

async function runTriageFindings(
  deps: ProposalExecutorDeps,
  proposal: AgentProposal,
  payload: TriageFindingsProposalPayload,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  const items: TriageFindingItemResultJson[] = [];
  let applied = 0;
  let skipped = 0;
  let anyFailed = false;
  // Same posture as runReprioritize: ReviewItemRouter.applyReviewItem is one
  // item per call, so each item is its own call and a rejection does NOT abort
  // the rest. One extra arm: a row that stopped being pending between propose
  // and confirm (a human triaged it from the queue meanwhile) is SKIPPED and
  // reported — the assistant's intent for it is moot, not wrong — rather than
  // surfacing the chokepoint's invalid_status as a failure of the batch.
  for (const item of payload.items) {
    const live = deps.readReviewItemState(payload.projectId, item.reviewItemId);
    if (live === null) {
      skipped++;
      items.push({ reviewItemId: item.reviewItemId, op: item.op, ok: false, skipped: 'no longer exists' });
      continue;
    }
    if (live.status !== 'pending') {
      skipped++;
      items.push({ reviewItemId: item.reviewItemId, op: item.op, ok: false, skipped: `already ${live.status}` });
      continue;
    }
    try {
      for (const change of triageChanges(item, live)) {
        await deps.applyReviewItemChange(payload.projectId, change);
      }
      applied++;
      items.push({ reviewItemId: item.reviewItemId, op: item.op, ok: true });
    } catch (err) {
      anyFailed = true;
      items.push({ reviewItemId: item.reviewItemId, op: item.op, ok: false, error: errMsg(err) });
    }
  }

  const status: 'executed' | 'failed' = anyFailed ? 'failed' : 'executed';
  const result: TriageFindingsResultJson = { kind: 'triage-findings', status, items, applied, skipped };
  deps.store.finalizeProposal(proposalId, status, JSON.stringify(result));
  return { ok: true, proposalId, kind: proposal.kind, status, result };
}

/** Does the row's live state already reflect what `item` asked for? (Reconciliation read.) */
function triageItemApplied(item: TriageFindingItem, live: ReviewItemStateSnapshot | null): boolean {
  if (live === null) return false;
  switch (item.op) {
    case 'dismiss':
      return live.status === 'dismissed';
    case 'resolve':
      return live.status === 'resolved';
    case 'approve':
      return live.stagedAt !== null;
    case 'set-selected':
      return live.selected === (item.selected === true) && (item.selected !== true || live.stagedAt !== null);
  }
}

// ---------------------------------------------------------------------------
// edit-workflow — spec-hash CAS + safeParse + updateSpec inside one transaction
// ---------------------------------------------------------------------------

type EditWorkflowOutcome =
  | { kind: 'applied'; appliedHash: string }
  | { kind: 'superseded'; expectedHash: string; actualHash: string }
  | { kind: 'validation-failed'; issues: string[] }
  | { kind: 'error'; reason: 'workflow-not-found' | 'missing-precondition'; message: string };

async function runEditWorkflow(
  deps: ProposalExecutorDeps,
  proposal: AgentProposal,
  payload: EditWorkflowProposalPayload,
  proposalId: string,
): Promise<ExecuteProposalResult> {
  const expectedHash = proposal.preconditions?.kind === 'edit-workflow' ? proposal.preconditions.specHash : undefined;

  // The spec-hash CAS + apply must be atomic: WorkflowRegistry.updateSpec is an
  // UNCONDITIONAL UPDATE with no version column, so a concurrent writer between the
  // hash check and the apply would be silently overwritten. Read+hash+compare+parse+
  // apply therefore all run inside ONE transaction. The terminal proposal-row write
  // (finalize/supersede) is intentionally OUTSIDE it — a crash in that narrow window
  // leaves the row 'executing', and boot reconciliation re-derives the outcome from the
  // now-applied spec hash (never a re-apply).
  const outcome = deps.runInTransaction<EditWorkflowOutcome>(() => {
    const effective = deps.readEffectiveWorkflowSpec(payload.workflowId);
    if (effective === null) {
      return { kind: 'error', reason: 'workflow-not-found', message: `workflow ${payload.workflowId} not found` };
    }
    if (expectedHash === undefined) {
      return { kind: 'error', reason: 'missing-precondition', message: 'edit-workflow proposal carries no spec-hash precondition' };
    }
    const actualHash = computeSpecHash(effective);
    if (actualHash !== expectedHash) {
      return { kind: 'superseded', expectedHash, actualHash };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(payload.definitionJson);
    } catch {
      return { kind: 'validation-failed', issues: ['definitionJson is not valid JSON'] };
    }
    const parsed = workflowDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'validation-failed', issues: formatZodIssues(parsed.error.issues) };
    }
    deps.applyWorkflowSpec(payload.workflowId, parsed.data);
    return { kind: 'applied', appliedHash: actualHash };
  });

  switch (outcome.kind) {
    case 'superseded': {
      const result: EditWorkflowResultJson = {
        kind: 'edit-workflow',
        status: 'superseded',
        workflowId: payload.workflowId,
        reason: 'spec-hash-mismatch',
        expectedHash: outcome.expectedHash,
        actualHash: outcome.actualHash,
      };
      deps.store.supersedeProposal(proposalId, JSON.stringify(result));
      return {
        ok: false,
        reason: 'superseded',
        loopbackTurn:
          `The workflow "${payload.workflowId}" changed since you drafted this edit — its current definition no ` +
          `longer matches what you based the change on, so it was NOT applied. Re-read the current definition and ` +
          `propose the edit again against the fresh version.`,
      };
    }
    case 'validation-failed': {
      const result: EditWorkflowResultJson = {
        kind: 'edit-workflow',
        status: 'failed',
        workflowId: payload.workflowId,
        reason: 'validation-failed',
        issues: outcome.issues,
      };
      deps.store.finalizeProposal(proposalId, 'failed', JSON.stringify(result));
      return {
        ok: false,
        reason: 'validation-failed',
        loopbackTurn:
          `The workflow edit you proposed did not pass validation and was not applied:\n` +
          outcome.issues.map((i) => `- ${i}`).join('\n') +
          `\nRevise the definition to fix these and propose the edit again.`,
      };
    }
    case 'error': {
      const result: EditWorkflowResultJson = {
        kind: 'edit-workflow',
        status: 'failed',
        workflowId: payload.workflowId,
        reason: outcome.reason,
      };
      deps.store.finalizeProposal(proposalId, 'failed', JSON.stringify(result));
      return { ok: true, proposalId, kind: proposal.kind, status: 'failed', result };
    }
    case 'applied': {
      const result: EditWorkflowResultJson = {
        kind: 'edit-workflow',
        status: 'executed',
        workflowId: payload.workflowId,
        appliedHash: outcome.appliedHash,
      };
      deps.store.finalizeProposal(proposalId, 'executed', JSON.stringify(result));
      return { ok: true, proposalId, kind: proposal.kind, status: 'executed', result };
    }
  }
}

// ---------------------------------------------------------------------------
// Boot reconciliation — finalize rows stranded 'executing' by a crash
// ---------------------------------------------------------------------------

export interface ReconcileOutcome {
  proposalId: string;
  kind: AgentProposalKind;
  finalizedTo: 'executed' | 'failed';
  note: string;
}

export interface ReconcileSummary {
  total: number;
  outcomes: ReconcileOutcome[];
}

/**
 * At boot, verify OBSERVABLE side effects for every proposal stranded 'executing' by a
 * crash and finalize it. NEVER re-runs a side effect — it only reads current state and
 * transitions the row:
 *   - launch-run: the run recorded in result_json (if any) exists ⇒ executed; else
 *     'crashed-mid-execution' (a launch whose runId was never persisted cannot be
 *     verified, so it fails conservatively rather than risk a duplicate run).
 *   - reprioritize: every proposed item already carries its target priority/stage ⇒
 *     executed; otherwise 'crashed-mid-execution' with the per-item verified state.
 *   - edit-workflow: the workflow's current spec hash equals the proposed definition's
 *     hash ⇒ the edit landed ⇒ executed; otherwise 'crashed-mid-execution'.
 *   - create-backlog-items: NOT verifiable (a created entity carries no back-link to
 *     the proposal) ⇒ always 'crashed-mid-execution', never a re-run.
 *   - create-workflow: a flow under the proposed name exists in the proposed scope
 *     AND every proposed agent key exists ⇒ executed (the name was free at propose
 *     time, so its presence is the confirm's own trace); otherwise
 *     'crashed-mid-execution' — with whatever landed listed, since a half-minted
 *     agent set is exactly what the human has to clean up by hand.
 *   - triage-findings: every item's row already reflects its op (dismissed /
 *     resolved / staged / selected as asked) ⇒ executed; otherwise
 *     'crashed-mid-execution' with the per-item verified state. A row someone
 *     else triaged meanwhile reads as applied for dismiss/resolve only when the
 *     status matches — reconciliation never re-writes.
 *   - start-quick-session: NOT verifiable (a minted session carries no back-link to
 *     the proposal, and its name may have been generated) ⇒ always
 *     'crashed-mid-execution', never a re-run — like create-backlog-items.
 */
export async function reconcileOrphanedExecutingProposals(deps: ProposalExecutorDeps): Promise<ReconcileSummary> {
  const orphans = deps.store.listProposalsByStatus('executing');
  const outcomes: ReconcileOutcome[] = [];

  for (const proposal of orphans) {
    try {
      outcomes.push(await reconcileOne(deps, proposal));
    } catch (err) {
      // A verifier read threw — finalize failed defensively (never leave it stranded).
      const note = `reconcile verification threw: ${errMsg(err)}`;
      deps.store.finalizeProposal(proposal.id, 'failed', JSON.stringify({ reconciled: true, error: note }));
      outcomes.push({ proposalId: proposal.id, kind: proposal.kind, finalizedTo: 'failed', note });
    }
  }

  deps.logger?.info?.('[proposalExecutor] reconciled orphaned executing proposals', {
    total: orphans.length,
  });
  return { total: orphans.length, outcomes };
}

async function reconcileOne(deps: ProposalExecutorDeps, proposal: AgentProposal): Promise<ReconcileOutcome> {
  switch (proposal.kind) {
    case 'launch-run': {
      const runId = resultRunId(proposal.result);
      if (runId !== undefined && deps.runExists(runId)) {
        const result: LaunchRunResultJson = { kind: 'launch-run', status: 'executed', runId, reconciled: true, verified: `run ${runId} exists` };
        deps.store.finalizeProposal(proposal.id, 'executed', JSON.stringify(result));
        return { proposalId: proposal.id, kind: proposal.kind, finalizedTo: 'executed', note: `run ${runId} exists` };
      }
      const note = runId !== undefined ? `run ${runId} not found` : 'no run id recorded';
      const result: LaunchRunResultJson = {
        kind: 'launch-run',
        status: 'failed',
        ...(runId !== undefined ? { runId } : {}),
        reconciled: true,
        error: 'crashed-mid-execution',
        verified: note,
      };
      deps.store.finalizeProposal(proposal.id, 'failed', JSON.stringify(result));
      return { proposalId: proposal.id, kind: proposal.kind, finalizedTo: 'failed', note: `crashed-mid-execution: ${note}` };
    }

    case 'reprioritize-backlog': {
      const payload = proposal.payload as ReprioritizeBacklogProposalPayload;
      const items: ReprioritizeItemResultJson[] = [];
      let allApplied = true;
      for (const item of payload.items) {
        const live = deps.readTaskFields(payload.projectId, item.taskId);
        const applied =
          live !== null &&
          (item.priority === undefined || live.priority === item.priority) &&
          (item.stageId === undefined || live.stageId === item.stageId);
        if (!applied) allApplied = false;
        items.push({ taskId: item.taskId, ok: applied });
      }
      const status: 'executed' | 'failed' = allApplied ? 'executed' : 'failed';
      const result: ReprioritizeResultJson = { kind: 'reprioritize-backlog', status, items, reconciled: true };
      deps.store.finalizeProposal(proposal.id, status, JSON.stringify(result));
      return {
        proposalId: proposal.id,
        kind: proposal.kind,
        finalizedTo: status,
        note: allApplied ? 'all items already applied' : 'crashed-mid-execution: some items not applied',
      };
    }

    case 'edit-workflow': {
      const payload = proposal.payload as EditWorkflowProposalPayload;
      const effective = deps.readEffectiveWorkflowSpec(payload.workflowId);
      let proposedHash: string | null = null;
      try {
        proposedHash = computeSpecHash(JSON.parse(payload.definitionJson));
      } catch {
        proposedHash = null;
      }
      const currentHash = effective === null ? null : computeSpecHash(effective);
      const applied = proposedHash !== null && currentHash !== null && currentHash === proposedHash;
      const status: 'executed' | 'failed' = applied ? 'executed' : 'failed';
      const result: EditWorkflowResultJson = {
        kind: 'edit-workflow',
        status: applied ? 'executed' : 'failed',
        workflowId: payload.workflowId,
        reconciled: true,
        ...(applied ? { appliedHash: currentHash ?? undefined } : { reason: 'crashed-mid-execution' }),
      };
      deps.store.finalizeProposal(proposal.id, status, JSON.stringify(result));
      return {
        proposalId: proposal.id,
        kind: proposal.kind,
        finalizedTo: status,
        note: applied ? 'spec hash matches proposed edit' : 'crashed-mid-execution: spec hash does not match',
      };
    }

    case 'create-backlog-items': {
      // A create has NO verifiable natural key: the entities this proposal would have
      // minted carry no marker tying them back to the row, so an orphan cannot be told
      // apart from a batch that never ran. Fail conservatively — exactly the posture
      // launch-run takes for a run whose id was never persisted — and say so in the
      // note; re-running would risk duplicate entities, which is strictly worse than a
      // human re-proposing.
      const payload = proposal.payload as CreateBacklogItemsProposalPayload;
      const items: CreateBacklogItemResultJson[] = payload.items.map((item, index) => ({
        index,
        title: item.title,
        taskType: item.taskType,
        ok: false,
        error: 'crashed-mid-execution',
      }));
      const result: CreateBacklogResultJson = {
        kind: 'create-backlog-items',
        status: 'failed',
        items,
        reconciled: true,
      };
      deps.store.finalizeProposal(proposal.id, 'failed', JSON.stringify(result));
      return {
        proposalId: proposal.id,
        kind: proposal.kind,
        finalizedTo: 'failed',
        note: 'crashed-mid-execution: entity creation is not verifiable — check the board for partially created items',
      };
    }

    case 'create-workflow': {
      const payload = proposal.payload as CreateWorkflowProposalPayload;
      const scopeProjectId = payload.scope === 'global' ? null : payload.projectId;
      const workflowId = deps.findWorkflowIdByName(scopeProjectId, payload.name);
      const agents: CreateWorkflowAgentResultJson[] = (payload.agents ?? []).map((agent, index) => {
        // The confirm derives the key through the chokepoint; reconciliation has no
        // chokepoint call to make, so it re-derives it the same way the propose
        // path did (agentValidation.deriveAgentKey) via the existence probe.
        const agentKey = deriveAgentKey(agent.name);
        return { index, name: agent.name, agentKey, ok: deps.customAgentExists(payload.projectId, agentKey) };
      });
      const applied = workflowId !== null && agents.every((a) => a.ok);
      const status: 'executed' | 'failed' = applied ? 'executed' : 'failed';
      const verified = workflowId !== null ? `workflow ${workflowId} exists` : `no workflow named "${payload.name}"`;
      const result: CreateWorkflowResultJson = {
        kind: 'create-workflow',
        status,
        name: payload.name,
        ...(workflowId !== null ? { workflowId } : {}),
        agents,
        reconciled: true,
        verified,
        ...(applied ? {} : { error: 'crashed-mid-execution' }),
      };
      deps.store.finalizeProposal(proposal.id, status, JSON.stringify(result));
      return {
        proposalId: proposal.id,
        kind: proposal.kind,
        finalizedTo: status,
        note: applied ? verified : `crashed-mid-execution: ${verified}; check the Agents pane for partially created agents`,
      };
    }

    case 'triage-findings': {
      const payload = proposal.payload as TriageFindingsProposalPayload;
      const items: TriageFindingItemResultJson[] = [];
      let applied = 0;
      for (const item of payload.items) {
        const ok = triageItemApplied(item, deps.readReviewItemState(payload.projectId, item.reviewItemId));
        if (ok) applied++;
        items.push({ reviewItemId: item.reviewItemId, op: item.op, ok });
      }
      const allApplied = applied === payload.items.length;
      const status: 'executed' | 'failed' = allApplied ? 'executed' : 'failed';
      const result: TriageFindingsResultJson = { kind: 'triage-findings', status, items, applied, skipped: 0, reconciled: true };
      deps.store.finalizeProposal(proposal.id, status, JSON.stringify(result));
      return {
        proposalId: proposal.id,
        kind: proposal.kind,
        finalizedTo: status,
        note: allApplied ? 'all items already applied' : 'crashed-mid-execution: some items not applied',
      };
    }

    case 'start-quick-session': {
      const result: StartQuickSessionResultJson = {
        kind: 'start-quick-session',
        status: 'failed',
        reconciled: true,
        error: 'crashed-mid-execution',
      };
      deps.store.finalizeProposal(proposal.id, 'failed', JSON.stringify(result));
      return {
        proposalId: proposal.id,
        kind: proposal.kind,
        finalizedTo: 'failed',
        note: 'crashed-mid-execution: a started session is not verifiable from the proposal',
      };
    }

    default: {
      // open-session never reaches 'executing' (executeProposal rejects it before the
      // claim); finalize failed defensively if one somehow appears.
      deps.store.finalizeProposal(proposal.id, 'failed', JSON.stringify({ reconciled: true, error: 'crashed-mid-execution' }));
      return { proposalId: proposal.id, kind: proposal.kind, finalizedTo: 'failed', note: 'crashed-mid-execution: non-executable kind stranded' };
    }
  }
}
