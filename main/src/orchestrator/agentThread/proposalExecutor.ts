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
 *      (launch-run carries no precondition; reprioritize's per-task expectedVersions
 *      are consumed PER ITEM by the chokepoint, not as a whole-proposal gate.)
 *   3. SIDE EFFECTS through the chokepoints, carrying the idempotency key / expected
 *      versions where the target supports them. launch-run runs a COMPENSATION SAGA:
 *      created resources are tracked and unwound in reverse on any post-session
 *      failure, with each compensation step's outcome persisted for reconciliation.
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
import type { LoggerLike } from '../types';
import type { WorkflowDefinition, CyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { Priority } from '../../../../shared/types/tasks';
import type {
  AgentProposal,
  AgentProposalKind,
  AgentProposalStatus,
  EditWorkflowProposalPayload,
  LaunchRunProposalPayload,
  ReprioritizeBacklogProposalPayload,
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
 * The launch-run side effect, high-level. The wiring closure (index.ts) resolves the
 * workflow id + project path from (projectId, workflowName) and maps the seeds to
 * RunLauncher.launch's per-workflow positional params (taskIds→sprint,
 * ideaIds→planner/ship, findingIds→compound), respecting the launcher's own seed
 * guards. The executor stays free of workflow-resolution concerns and owns only the
 * session→run sequencing + compensation saga.
 */
export interface LaunchRunSideEffectArgs {
  projectId: number;
  workflowName: CyboflowWorkflowName;
  sessionId: string;
  substrate?: CliSubstrate;
  taskIds?: string[];
  ideaIds?: string[];
  findingIds?: string[];
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
  /** Launch the seeded workflow run into the host session (RunLauncher.launch). */
  launchRun: (
    args: LaunchRunSideEffectArgs,
  ) => Promise<{ runId: string; worktreePath: string; branchName: string }>;
  /** Compensation: cancel a run created before a later boundary failed (git-neutral). */
  cancelRun: (runId: string) => Promise<void>;
  /** Compensation: the FULL safe session-dismiss path (cancels hosted runs, then removes the worktree). */
  dismissSession: (sessionId: string) => Promise<void>;
  /** Reconciliation: does the run recorded in an orphan's result_json still exist? */
  runExists: (runId: string) => boolean;

  // --- reprioritize-backlog: sequential per-item applyChange, partial-failure tolerant ---
  /** One TaskChangeRouter.applyChange (actor 'user'); throws (TaskChangeError) on rejection. */
  applyTaskChange: (projectId: number, change: ReprioritizeTaskChange) => Promise<void>;
  /** Reconciliation: the task's current priority/stage (null when the task is gone). */
  readTaskFields: (projectId: number, taskId: string) => TaskFieldsSnapshot | null;

  // --- edit-workflow: spec-hash CAS + safeParse + updateSpec, all inside one transaction ---
  /** better-sqlite3 transaction wrapper — the read-hash-compare-apply core runs atomically inside it. */
  runInTransaction: <T>(fn: () => T) => T;
  /** The workflow's CURRENT effective definition value to hash (null when the workflow is gone). */
  readEffectiveWorkflowSpec: (workflowId: string) => unknown | null;
  /** Persist the validated definition (WorkflowRegistry.updateSpec) — caller has already validated. */
  applyWorkflowSpec: (workflowId: string, definition: WorkflowDefinition) => void;

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

export interface LaunchRunResultJson {
  kind: 'launch-run';
  status: 'executed' | 'failed';
  sessionId?: string;
  worktreePath?: string;
  runId?: string;
  branchName?: string;
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

export type ProposalResultJson = LaunchRunResultJson | ReprioritizeResultJson | EditWorkflowResultJson;

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

    default: {
      // open-session never reaches 'executing' (executeProposal rejects it before the
      // claim); finalize failed defensively if one somehow appears.
      deps.store.finalizeProposal(proposal.id, 'failed', JSON.stringify({ reconciled: true, error: 'crashed-mid-execution' }));
      return { proposalId: proposal.id, kind: proposal.kind, finalizedTo: 'failed', note: 'crashed-mid-execution: non-executable kind stranded' };
    }
  }
}
