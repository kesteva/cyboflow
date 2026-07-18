/**
 * tRPC context for the cyboflow orchestrator.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 *
 * Auth-principal placeholder: in v1, every local desktop session runs as the
 * hard-coded userId `'local'`. The v2 team-tier swap replaces `'local'` with a
 * real principal derived from a session token — that requires only swapping out
 * this single file (or injecting a session resolver at server-init time).
 */
import type { DatabaseLike } from '../types';
import type { PermissionMode, WorkflowRow, WorkflowDefinition } from '../../../../shared/types/workflows';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { RunGitDiff } from '../../../../shared/types/runFiles';
import type { WorkflowDescriptor } from '../workflowRegistry';
import type { AgentOverrideRow } from '../../database/models';
import type { WorkflowVariantRow, WorkflowVariantStatus } from '../../../../shared/types/experiments';
import type { AgentThread, AgentProposal, AgentProposalStatus } from '../../../../shared/types/agentThread';
import type { ExecuteProposalResult } from '../agentThread/proposalExecutor';

/**
 * Narrow structural interface for AgentOverrideRouter used in tRPC context.
 *
 * Defined here (rather than importing the concrete AgentOverrideRouter class)
 * so the tRPC subtree never takes a hard dependency on the chokepoint's full
 * surface — preserves test substitutability and the standalone-typecheck
 * invariant (no 'better-sqlite3' or fs imports pulled transitively).
 *
 * `applyChange`'s change argument is typed `unknown` here (the `agents` router
 * builds its discriminated op objects literally and the concrete router accepts
 * the real `AgentOverrideChange` union) so this file does not import the concrete
 * union from the router module — the standalone-typecheck invariant holds.
 */
export interface AgentOverrideRouterLike {
  listByProject(projectId: number): AgentOverrideRow[];
  getByKey(projectId: number, agentKey: string): AgentOverrideRow | null;
  applyChange(projectId: number, change: unknown): Promise<{ agentKey: string }>;
}

/**
 * Narrow structural interface for WorkflowRegistry used in tRPC context.
 *
 * Defined here (rather than importing the concrete WorkflowRegistry class)
 * so the tRPC subtree never takes a hard dependency on the registry's full
 * surface — preserves test substitutability and the standalone-typecheck
 * invariant (no 'better-sqlite3' or fs imports pulled transitively).
 */
export interface WorkflowRegistryLike {
  listByProject(projectId: number): WorkflowRow[];
  getById(workflowId: string): WorkflowRow | null;
  seed(projectId: number, descriptors: WorkflowDescriptor[]): void;
  /**
   * Upsert the in-repo built-ins as ONE GLOBAL set (migration 030): a single
   * `wf-global-<name>` row per built-in (`project_id NULL`), shared across every
   * project. Re-points pre-refactor rows at the in-repo prompts; no projectId.
   */
  ensureGlobalBuiltIns(descriptors: WorkflowDescriptor[]): void;
  /** Persist an edited definition onto a workflow's `spec_json` (editor Save). */
  updateSpec(workflowId: string, definition: WorkflowDefinition): void;
  /** Reset a built-in workflow's spec back to its static default. */
  resetSpec(workflowId: string): void;
  /**
   * Create a brand-new custom workflow row (migration 030). `projectId === null`
   * mints a GLOBAL custom flow; a number mints a project-scoped copy. `specJson`
   * defaults to the empty spec and `permissionMode` to `'default'` when omitted.
   */
  createCustom(params: {
    projectId: number | null;
    name: string;
    specJson?: string;
    permissionMode?: PermissionMode;
  }): WorkflowRow;
  /**
   * Delete a workflow row (gallery "Delete"). Throws a distinguishable Error for
   * a missing row ('not found'), a reserved global built-in / __quick__ sentinel
   * ('reserved'), or a flow with run history ('run history').
   */
  deleteWorkflow(workflowId: string): void;
  // --- Workflow variants (A/B testing, migration 048) ---
  /** List a workflow's variants (newest-first). */
  listVariants(workflowId: string): WorkflowVariantRow[];
  /**
   * Create a variant snapshotting the workflow's current resolved definition
   * (seeds status='draft'). Throws distinguishable Errors: 'not found' / reserved
   * sentinel / unresolvable definition / label 'already exists'.
   */
  createVariantFromCurrent(workflowId: string, label: string): WorkflowVariantRow;
  /** Patch a variant in place (re-snapshot). Throws 'not found' when missing. */
  updateVariant(
    variantId: string,
    patch: {
      specJson?: string;
      agentOverridesJson?: string | null;
      model?: string | null;
      executionModel?: 'orchestrated' | 'programmatic' | null;
      weight?: number;
      label?: string;
    },
  ): void;
  /** Transition a variant's rotation status. Throws 'not found' when missing. */
  setVariantStatus(variantId: string, status: WorkflowVariantStatus): void;
  /** Delete a variant. Throws 'run history' when runs reference it; 'not found' when missing. */
  deleteVariant(variantId: string): void;
  /** Read a workflow's baseline rotation participation (migration 054). Null when missing. */
  getBaselineRotation(workflowId: string): { inRotation: boolean; weight: number } | null;
  /** Patch a workflow's baseline rotation participation (migration 054). Throws 'not found' when missing. */
  setBaselineRotation(workflowId: string, patch: { inRotation?: boolean; weight?: number }): void;
}

/**
 * Narrow structural slice of AgentThreadService the agentThread router needs
 * (global-agent chat thread, migration 071). Declared here — not imported as the
 * concrete class — so the tRPC subtree never pulls in the service's node:fs /
 * claudeCodeManager-type dependencies, preserving the standalone-typecheck
 * invariant and test substitutability. The real AgentThreadService satisfies it
 * structurally.
 */
export interface AgentThreadServiceLike {
  /** Load-or-create the single 'global' thread + ensure its neutral home dir. */
  ensureGlobalThread(): AgentThread;
  /** Send one turn (spawn/warm-continue). Also used to inject executor loopback turns. */
  sendMessage(threadId: string, text: string): Promise<void>;
  /** Trigger a synthetic digest turn, server-throttled (throttled ⇒ triggered:false). */
  triggerDigest(threadId: string): Promise<{ triggered: true } | { triggered: false; reason: 'throttled' }>;
}

/**
 * Narrow structural slice of AgentThreadDbStore the agentThread router needs for
 * the proposal card lifecycle it owns directly: listing a thread's proposals, and
 * the open-session Confirm path (CAS-claim → finalize 'executed', since the
 * executor rejects open-session by design — plan §2.5). Declared here (not the
 * concrete store) for the same standalone-typecheck reason as above.
 */
export interface AgentThreadStoreLike {
  listProposals(threadId: string, opts?: { statuses?: AgentProposalStatus[] }): AgentProposal[];
  getProposal(id: string): AgentProposal | null;
  claimProposal(id: string, idempotencyKey: string): boolean;
  finalizeProposal(id: string, status: 'executed' | 'failed', resultJson: string | null): boolean;
  dismissProposal(id: string): boolean;
}

/**
 * Narrow structural slice for invoking the boot-wired proposal executor from the
 * router. The concrete closure (index.ts) reads the late-bound
 * setProposalExecutorDeps holder — keeping the FULL ProposalExecutorDeps surface
 * (createQuickSession / launchRun / TaskChangeRouter / …) out of the tRPC subtree,
 * so the router stays standalone-typecheck-clean and unit-testable with a fake.
 */
export interface AgentProposalExecutorLike {
  execute(proposalId: string): Promise<ExecuteProposalResult>;
}

/**
 * Injectable dependencies for the tRPC context.
 *
 * All fields are optional so callers (and unit tests) that do not need a
 * particular capability can omit it — the factory supplies safe no-ops.
 */
export interface ContextDeps {
  /**
   * Callback that sets the macOS dock badge count.
   *
   * Injected from `main/src/index.ts` by passing a closure over
   * `dockBadgeService.setBadgeCount`. Keeping this as a plain callback (rather
   * than importing the service directly) preserves the standalone-typecheck
   * invariant: no 'electron' or 'main/src/services/*' import is needed here.
   */
  setDockBadge?: (count: number) => void;

  /**
   * Live database handle for the orchestrator's SQLite DB.
   *
   * Injected from `main/src/index.ts` via `makeDatabaseLike(databaseService)`.
   * Keeping this as the narrow `DatabaseLike` interface (rather than importing
   * the concrete DatabaseService) preserves the standalone-typecheck invariant:
   * no 'better-sqlite3' or 'main/src/services/*' import is needed here.
   *
   * Handlers must explicitly check `ctx.db` before use — `undefined` is the
   * intentional default so unit tests that do not need DB access can omit it.
   */
  db?: DatabaseLike;

  /**
   * Live WorkflowRegistry instance.
   *
   * Injected from `main/src/index.ts` via the `workflowRegistry` singleton
   * constructed at app start. Using the narrow `WorkflowRegistryLike` interface
   * (rather than importing the concrete WorkflowRegistry class) preserves the
   * standalone-typecheck invariant and test substitutability.
   *
   * Handlers must explicitly check `ctx.workflowRegistry` before use —
   * `undefined` is the intentional default so unit tests that do not need the
   * registry can omit it.
   */
  workflowRegistry?: WorkflowRegistryLike;

  /**
   * Live AgentOverrideRouter instance — the single write chokepoint for
   * `agent_overrides` (migration 029).
   *
   * Injected from `main/src/index.ts` via `AgentOverrideRouter.getInstance()`.
   * Using the narrow `AgentOverrideRouterLike` interface (rather than importing
   * the concrete class) preserves the standalone-typecheck invariant and test
   * substitutability.
   *
   * Handlers must explicitly check `ctx.agentOverrideRouter` before use —
   * `undefined` is the intentional default so unit tests that do not need agent
   * overrides can omit it.
   */
  agentOverrideRouter?: AgentOverrideRouterLike;

  /**
   * Reads the global forced-substrate pin (ConfigManager.getForcedSubstrate).
   *
   * Injected from `main/src/index.ts` as a closure over the ConfigManager
   * singleton — kept as a plain callback (like `setDockBadge`) so the
   * standalone-typecheck invariant holds (no 'main/src/services/*' import here).
   * `substrates.resolveEffective` consults it so the batch-cap preview matches
   * what WorkflowRegistry.createRun would actually stamp under a demo-mode or
   * interactive-PTY-only pin. Defaults to `() => null` (no pin).
   */
  getForcedSubstrate?: () => CliSubstrate | null;

  /**
   * Captures the diff of an absolute worktree path. With `baseRef` (the run's
   * base_sha) it diffs the working tree against that ref — surfacing committed,
   * uncommitted, and untracked changes since launch — which is what a flow that
   * COMMITS its work (sprint/ship merging task lanes) needs; without it, it falls
   * back to the working-directory diff (vs HEAD, uncommitted only).
   *
   * Backs cyboflow.runs.gitDiff (the run-scoped Diff tab). Injected from
   * `main/src/index.ts` as a closure over GitDiffManager — kept as a plain
   * function (like `setDockBadge`) so the standalone-typecheck invariant holds
   * (the router never imports 'main/src/services/gitDiffManager'). Returns the raw
   * unified diff + aggregate stats. When omitted (unit tests that don't need it),
   * the gitDiff procedure throws PRECONDITION_FAILED.
   */
  gitDiff?: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff>;

  /**
   * Live AgentThreadService (global-agent chat thread, migration 071).
   *
   * Injected from `main/src/index.ts` via the singleton constructed in
   * initializeServices. Using the narrow {@link AgentThreadServiceLike} interface
   * (not the concrete class) preserves the standalone-typecheck invariant. The
   * agentThread router guards on it — `undefined` is the intentional default so
   * tests that do not exercise the agent thread can omit it.
   */
  agentThreadService?: AgentThreadServiceLike;

  /**
   * Live AgentThreadDbStore (proposals + thread rows, migration 071). The SAME
   * instance the MCP propose_action handler + proposal executor share. Narrowed to
   * {@link AgentThreadStoreLike} for the standalone-typecheck invariant.
   */
  agentThreadStore?: AgentThreadStoreLike;

  /**
   * Boot-wired proposal-executor invoker (reads setProposalExecutorDeps). Narrowed
   * to {@link AgentProposalExecutorLike} so the router never imports the full
   * executor-deps surface. `undefined` ⇒ confirmProposal for executable kinds
   * throws PRECONDITION_FAILED.
   */
  agentProposalExecutor?: AgentProposalExecutorLike;
}

/**
 * Creates the tRPC request context.
 *
 * @param deps - Optional injectable callbacks. Omitting a field uses a safe
 *   no-op so tests and future standalone-Node scenarios work without wiring
 *   the full Electron service graph.
 * @returns A context object carrying the auth principal and injected callbacks.
 *
 * @remarks v2 team-tier: replace `'local'` with a real session-token lookup.
 * The shape of this return value is what `protectedProcedure` asserts on — keep
 * `userId` as the canonical field name regardless of how it is populated.
 */
export function createContext(deps: ContextDeps = {}): {
  userId: 'local';
  setDockBadge: (count: number) => void;
  db?: DatabaseLike;
  workflowRegistry?: WorkflowRegistryLike;
  agentOverrideRouter?: AgentOverrideRouterLike;
  getForcedSubstrate: () => CliSubstrate | null;
  gitDiff?: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff>;
  agentThreadService?: AgentThreadServiceLike;
  agentThreadStore?: AgentThreadStoreLike;
  agentProposalExecutor?: AgentProposalExecutorLike;
} {
  const {
    setDockBadge = (_count: number) => undefined,
    db,
    workflowRegistry,
    agentOverrideRouter,
    getForcedSubstrate = () => null,
    gitDiff,
    agentThreadService,
    agentThreadStore,
    agentProposalExecutor,
  } = deps;
  return {
    userId: 'local' as const,
    setDockBadge,
    db,
    workflowRegistry,
    agentOverrideRouter,
    getForcedSubstrate,
    gitDiff,
    agentThreadService,
    agentThreadStore,
    agentProposalExecutor,
  };
}

/** Shape of the tRPC context, inferred from `createContext`. */
export type Context = ReturnType<typeof createContext>;
