/**
 * McpQueryHandler — orchestrator-side handler for MCP query messages arriving
 * over the Cyboflow Unix IPC socket.
 *
 * Handles these message types dispatched by the cyboflowMcpServer subprocess:
 *   - mcp-list-pending-approvals  (SELECT from approvals)
 *   - mcp-get-run                 (SELECT from workflow_runs)
 *   - mcp-submit-checkpoint       (INSERT into raw_events with event_type='cyboflow_checkpoint')
 *   - mcp-report-step             (observational workflow-step transition)
 *   - mcp-create-task / -update-task / -set-task-stage (entity-aware task writes
 *                                  via the TaskChangeRouter chokepoint)
 *   - mcp-report-finding          (NON-BLOCKING review-item create via the
 *                                  ReviewItemRouter chokepoint; replies ok:true
 *                                  immediately and never pauses the run)
 *   - mcp-get-task                (READ-ONLY; an idea's `attachments` — migration
 *                                  028 image metadata — is threaded onto the
 *                                  response, RESOLVED to an absolute on-disk path
 *                                  via the same containment guard as
 *                                  ideas:load-attachments, IDEA-006. Epics/tasks
 *                                  get no `attachments` key at all. An idea with
 *                                  a current approved_designs row (Design Mode
 *                                  v0, migration 085) also gets an
 *                                  `approved_design` block with a RESOLVED
 *                                  absolute path to the approved prototype
 *                                  snapshot — the zero-export handoff read path.
 *                                  An idea also gets `components` — the idea
 *                                  component ledger's full hybrid read model
 *                                  (migration 101, resolveIdeaComponents),
 *                                  always all five, carrying `staleAt` so
 *                                  "needs review" (prior work, re-verify) is
 *                                  never collapsed into "not started".)
 *   - mcp-set-idea-component      (WRITE via IdeaComponentRouter's chokepoint;
 *                                  source:'flow', sourceRunId + the idea's
 *                                  current version stamped by this handler,
 *                                  never by the calling agent.)
 *
 * Plus the INTERACTIVE-substrate PreToolUse gate (IDEA-013 S5 / TASK-810):
 *   - shell-approval-request      (ASYNC-DEFERRED — the first handler that does
 *                                  NOT respond synchronously; it holds the socket
 *                                  open across the human-decision window and
 *                                  writes the verdict via ApprovalRouter's
 *                                  socketReply closure, possibly minutes later).
 *
 * Plus the INTERACTIVE-substrate Stop turn-end signal (IDEA-030):
 *   - interactive-turn-end        (fire-and-ack — replies synchronously and
 *                                  invokes the injected `onInteractiveTurnEnd`
 *                                  dep, which routes to
 *                                  InteractiveClaudeManager.notifyTurnEnd via
 *                                  main/src/index.ts wiring; this file may NOT
 *                                  import main/src/services directly).
 *
 * Unknown message types produce a structured error response — they never throw,
 * so a malformed subprocess message cannot crash the orchestrator socket.
 *
 * IMPORTANT: This handler is purely additive. The existing permission-request /
 * permission-response flow (owned by ApprovalRouter) is untouched. Checkpoint
 * writes do NOT transition workflow_runs.status; they are observational markers
 * only.
 *
 * Column names are verified against migration 006_cyboflow_schema.sql:
 *   approvals  — id, run_id, tool_name, tool_input_json, tool_use_id,
 *                status, created_at
 *   workflow_runs — all columns selected via *
 *   raw_events — id (AUTOINCREMENT), run_id, event_type, payload_json, created_at
 *
 * Quick-session invariant (IDEA-024 / TASK-743):
 *   This handler reads from `approvals` and `workflow_runs` only — it does NOT
 *   JOIN or SELECT from `sessions`.  Therefore it is already NULL-tolerant with
 *   respect to the TASK-743 nullable sessions.run_id column: quick sessions
 *   (sessions with run_id IS NULL) have no corresponding workflow_runs row, so
 *   any mcp-get-run request for a quick-session id will take the existing
 *   'not_found' branch and return ok:false — the intended behaviour.  No logic
 *   changes are required here for quick-session support.
 */
import * as net from 'net';
import * as path from 'path';
import type { McpQueryMessage, McpQueryResponse, McpQueryHandlerDeps, WorkflowConfigLike } from './mcpQueryMessages';
export type { McpQueryMessage, McpQueryResponse, McpQueryHandlerDeps, WorkflowConfigLike } from './mcpQueryMessages';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, lstatSync, openSync, readSync, closeSync } from 'fs';
import type { Dirent, Stats } from 'fs';
import {
  isPathWithinRoots,
  isSecretPath,
  bufferLooksBinary,
  compileBasenameGlob,
  matchesBasenameGlob,
  FS_READ_MAX_BYTES,
  FS_LIST_MAX_ENTRIES,
  FS_GREP_MAX_RESULTS,
  FS_GREP_MAX_FILES,
  FS_GREP_MAX_LINE_LEN,
  FS_GREP_MAX_FILE_BYTES,
  BINARY_SNIFF_BYTES,
  GREP_SKIP_DIRS,
} from './fsAccessGuard';
// Only cyboflow_db_query's readonly sibling connection needs a real
// better-sqlite3 handle — every other query in this file goes through the
// injected DatabaseLike `this.db`. This file carries no standalone-typecheck
// invariant (unlike orchSocketServer.ts, which must stay import-clean of
// 'better-sqlite3'/'electron' so runLauncher.ts's structural boundary holds).
import BetterSqlite3Database from 'better-sqlite3';
import type { DatabaseLike, LoggerLike } from '../types';
import { getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';
import {
  hasCustomSpecSlot,
  resolveWorkflowDefinition,
  isPermissionMode,
  isCyboflowWorkflowName,
  VERIFY_SETUP_WORKFLOW_NAME,
} from '../../../../shared/types/workflows';
import { resolveEffectiveDefinition } from '../../../../shared/tuning/workflowTuning';
import { resolveRunFrozenSpec } from '../runFrozenSpec';
import type { PermissionMode, WorkflowDefinition, WorkflowRow } from '../../../../shared/types/workflows';
import { workflowDefinitionSchema } from '../workflowDefinitionSchema';
import { buildStepTransitionEvent } from '../stepTransitionBridge';
import { handleEntityWrite } from '../autoMintArtifacts';
import { listRunDecomposedIdeaIds, listRunCreatedTaskIds } from '../runEntityOwnership';
import { ApprovalRouter, RunNotRunningError } from '../approvalRouter';
import type { ApprovalDecision } from '../../../../shared/types/approval';
import { isToolAllowed, loadMergedPermissionRules } from '../permissionRules';
import { isAcceptEditsAutoApprovable } from '../permissionModeMapper';
import { TaskChangeRouter, TaskChangeError } from '../taskChangeRouter';
import type { TaskChange, TaskActor } from '../taskChangeRouter';
import { ReviewItemRouter, ReviewItemError } from '../reviewItemRouter';
import type { ReviewItemCreate, ReviewItemTriage, ReviewItemDbRow } from '../reviewItemRouter';
import { selectFindingForSeed, selectRunFindingsForRuns } from '../reviewItemListing';
import { selectSessionRunScope } from '../sessionRunScope';
import { selectEvalReadout } from '../evalReadout';
import { selectProjectBacklog, selectTaskById, resolveBacklogRef, selectIdeaAttachments } from '../taskListing';
import { getCurrentApprovedDesign } from '../design/approvedDesigns';
import { resolveIdeaComponents } from '../ideaComponents/resolveIdeaComponents';
import { IdeaComponentRouter, IdeaComponentError } from '../ideaComponents/ideaComponentRouter';
import { ArtifactRouter, ArtifactError } from '../artifactRouter';
import { FeedbackRouter, FeedbackError } from '../feedbackRouter';
import type { ArtifactActor } from '../artifactRouter';
import type { ArtifactType } from '../../../../shared/types/artifacts';
import { PROTOTYPE_HTML_RELPATH, MAX_PROTOTYPE_HTML_BYTES, ARTIFACT_POLICIES } from '../../../../shared/types/artifacts';
import { QUICK_WORKFLOW_NAME, LEGACY_DROPPED_WORKFLOW_NAMES } from '../workflowRegistry';
import { computeSpecHash } from '../agentThread/specHash';
import {
  extractTurnText,
  excerptAround,
  truncateHead,
  TURN_TEXT_MAX_CHARS,
} from '../agentThread/transcriptSearch';
import {
  AGENT_PROPOSAL_KINDS,
  AGENT_THREAD_SPAWN_PREFIX,
  isAgentThreadSpawnId,
  type AgentNavigationTarget,
  type AgentProposalKind,
  type AgentProposalPayload,
  type AgentProposalPreconditions,
  type CreateBacklogItem,
  type CreateBacklogItemsProposalPayload,
  type EditWorkflowProposalPayload,
  type LaunchRunProposalPayload,
  type OpenSessionProposalPayload,
  type ReprioritizeBacklogItem,
  type ReprioritizeBacklogProposalPayload,
} from '../../../../shared/types/agentThread';
import {
  AGENT_REQUEST_TIMEOUT_CEILING_MS,
  VerificationScheduler,
} from '../verify/verificationScheduler';
import { resolveVisualVerification, SHIPPED_VERIFY_BACKENDS } from '../visualVerificationResolver';
import { loadVerifyConfig } from '../verifyConfigLoader';
import { laneEnqueueKeyFor, prepareVerificationEnqueue } from '../verify/enqueueFromTask';
import { captureSnapshotSha, isRunbookCommittedAtHead, isWorktreeDirty } from '../verify/snapshotProvisioner';
import { isVerifyRunbookModality, VERIFY_RUNBOOK_RELATIVE_PATH } from '../../../../shared/types/verifyRunbook';
import {
  FALLBACK_CHAINS,
  isVerificationType,
  parseVerificationTaskV1,
  deriveLegacyInputFromTask,
  resolveTaskModality,
} from '../../../../shared/types/visualVerification';
import type {
  VerificationType,
  VerificationRequestInput,
  VerificationTaskV1,
  VisualBackendId,
  VerifyChainEntry,
} from '../../../../shared/types/visualVerification';
import type { AdHocSnapshotResult } from '../eval/snapshotRunForEval';
import { SprintLaneStore, SprintLaneError } from '../sprintLaneStore';
import type { SprintLaneRow } from '../../../../shared/types/sprintBatch';
import {
  resolveSprintMaxTasks,
  AWAITING_VERIFY_STEP,
} from '../../../../shared/types/sprintBatch';
import { resolveRunFanOutInner, runHasControllerVisualVerify } from '../laneChainResolution';
import { isCliSubstrate, type CliSubstrate } from '../../../../shared/types/substrate';
import { runStatusEvents } from '../trpc/routers/events';
import type { RunStatusChangedEvent } from '../../../../shared/types/cyboflow';
import type { BacklogTaskItem, EntityCategory, IdeaAttachment, IdeaScope, Priority, TaskType } from '../../../../shared/types/tasks';
import type { ExperimentArm, WorkflowVariantRow } from '../../../../shared/types/experiments';
import { resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
import { QuestionRouter } from '../questionRouter';
import type {
  FindingPayload,
  FindingProposedTarget,
  ReviewItemKind,
  ReviewItemPayload,
} from '../../../../shared/types/reviews';
import {
  RESOLUTION_PREFIX_FIXED,
  RESOLUTION_PREFIX_TRIAGED,
  RESOLUTION_PREFIX_PROMOTED,
} from '../../../../shared/types/reviews';

/**
 * The workflow step id whose Approve answer flips a plan-gated run's drafted
 * epics/tasks visible + sprint-eligible (stamping plan_approved_at). Mirrors the
 * same-named constant in questionRouter.ts — duplicated as a bare literal to keep
 * this module free of a questionRouter import for one string. Used by the
 * approve-plan silent-pass guard in handleReportStep.
 */
const APPROVE_PLAN_STEP_ID = 'approve-plan';

/**
 * Provenance stamped on the folded permission review_item, per transport.
 *
 * Both the interactive Claude shell hook and the OMP gate extension reach
 * `handleShellApprovalRequest` over the same socket, so the source is the only
 * thing in the row that records which substrate is actually blocked.
 * (Codex has its own, `CODEX_APP_SERVER_APPROVAL_SOURCE`.)
 */
const APPROVAL_SOURCE_INTERACTIVE = 'approval:interactive';
const APPROVAL_SOURCE_OMP = 'approval:omp';

/**
 * Wire error per ad-hoc-eval rejection reason (`cyboflow_run_eval`). Keyed by the
 * AdHocSnapshotResult reason union, so a new reason fails the build here instead
 * of silently degrading to an undefined error string. Each value is
 * `<code>: <human-readable explanation>` — the calling agent gets a machine token
 * to branch on AND enough prose to decide whether to stop asking.
 */
const AD_HOC_EVAL_REJECTION_ERRORS: Record<
  Extract<AdHocSnapshotResult, { outcome: 'rejected' }>['reason'],
  string
> = {
  run_not_found: 'run_not_found: this session has no workflow_runs row to grade.',
  tagged_run:
    'adhoc_eval_tagged_run_rejected: this run is part of an A/B experiment or variant rotation. ' +
    'Tagged runs auto-grade at settle so both arms are scored under identical conditions; an ' +
    'ad-hoc eval would replace that canonical score and distort the comparison.',
  exists_auto:
    'adhoc_eval_exists_auto: this run already has its canonical automatic eval, which is never ' +
    "overwritten. See the run's quality panel (or retry it there) instead.",
  no_diff:
    'adhoc_eval_no_diff: no diff was captured for this run (no worktree, or nothing changed since ' +
    'its base), so there is nothing to grade.',
};

/**
 * Default wait budget for `cyboflow_await_verification` when the caller names
 * none (docs/proposals/verification-setup-flow.md §5.2 seam 2). Fifteen minutes
 * sits deliberately between the agent engine's 10-minute default deadline and its
 * 20-minute ceiling ({@link AGENT_REQUEST_TIMEOUT_CEILING_MS}, which is also this
 * tool's clamp): long enough that an ordinary proof run — cold build, boot,
 * drive, judge — is awaited to completion rather than abandoned one minute short,
 * and short enough that a wedged request cannot hold a flow's turn hostage for
 * longer than the request could legally live.
 */
const AWAIT_VERIFICATION_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Parse the global-agent sentinel form 'agent:<threadId>' out of a
 * CYBOFLOW_RUN_ID. Accepts ONLY this exact shape — a bare workflow_runs id (or
 * the 'orchestrator' health-check sentinel) is rejected. The reverse also
 * holds with NO code change required on the run-scoped side:
 * resolveTaskRunContext / resolveReviewItemRunContext do a strict
 * `SELECT ... FROM workflow_runs WHERE id = ?` lookup, and an
 * 'agent:<threadId>' string never matches a real run row, so those resolvers
 * fall through to their existing 'run_not_found' branch — see
 * mcpQueryHandler.test.ts for the two-way coverage.
 *
 * A free function (not a class method): it touches no DB/state, so every
 * global-agent handler below calls it directly and every unit test can call
 * it directly too.
 */
export function resolveGlobalAgentContext(
  runId: string,
): { ok: true; threadId: string } | { ok: false; error: string } {
  if (!isAgentThreadSpawnId(runId)) {
    return { ok: false, error: 'not_a_global_agent_run' };
  }
  return { ok: true, threadId: runId.slice(AGENT_THREAD_SPAWN_PREFIX.length) };
}

// ---------------------------------------------------------------------------
// cyboflow_history caps (mcp-history). The transcript table grows without
// bound — it is the assistant's permanent memory — so every read of it is
// bounded on FOUR independent axes: how many turns come back (limit), how many
// rows may be examined to find them (scan cap), how many rows are pulled per
// round-trip (batch), and how large the serialized reply may get (payload
// ceiling). Whichever binds first stops the walk and sets `truncated`, with
// `nextBeforeId` telling the caller exactly where to resume.
// ---------------------------------------------------------------------------

/** Default number of turns returned when the caller passes no `limit`. */
const HISTORY_DEFAULT_LIMIT = 20;
/** Hard ceiling on `limit` — a memory search is a lookup, not a bulk export. */
const HISTORY_MAX_LIMIT = 50;
/** Rows fetched per SQL round-trip while paging id-descending. */
const HISTORY_BATCH_ROWS = 500;
/** Rows examined before the walk gives up (mostly-plumbing threads page fast). */
const HISTORY_MAX_SCAN_ROWS = 10_000;
/** Serialized-turn budget for one reply, mirroring cyboflow_db_query's ceiling. */
const HISTORY_MAX_PAYLOAD_BYTES = 100_000;
/**
 * Ceiling on `daysBack` (~100 years). Not a usability limit — a guard against
 * SQLite's datetime() overflow: datetime('now', '-N days') silently returns
 * NULL once N leaves the julian-day range (measured: N=3,650,000 → NULL), and
 * `created_at >= NULL` filters out EVERY row, so an assistant reaching for a
 * huge number to mean "search everything" would get a confident false
 * "no memory of it". Clamped, the widest window just includes the whole table.
 */
const HISTORY_MAX_DAYS_BACK = 36_500;

/** One row of the transcript scan (the four columns mcp-history selects). */
interface AgentThreadEventScanRow {
  id: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

/** One turn as returned to the assistant by cyboflow_history. */
interface HistoryTurn {
  eventId: number;
  at: string;
  role: 'user' | 'assistant';
  text: string;
  /** Present (true) only in search mode, where `text` is a match excerpt. */
  matched?: boolean;
}

// ---------------------------------------------------------------------------
// cyboflow_db_query statement-shape validation (S0.4 global-agent) — pure,
// throws nothing. This is DEFENSE-IN-DEPTH: the primary read-only guarantee
// comes from executing on a dedicated `{ readonly: true }` better-sqlite3
// connection (see getGlobalAgentReadonlyDb below), which SQLite itself
// refuses to write through regardless of what slips past this validator.
// ---------------------------------------------------------------------------

const DB_QUERY_MAX_ROWS = 200;
const DB_QUERY_MAX_PAYLOAD_BYTES = 100_000;
const DB_QUERY_MAX_STRING_LEN = 2000;

const READER_KEYWORD_RE = /^(SELECT|WITH|EXPLAIN)\b/i;
const FORBIDDEN_KEYWORD_RE = /\b(ATTACH|PRAGMA)\b/i;

/** Strips leading whitespace and leading `--`/`/* *\/` comments (repeatedly,
 * since a query may open with several comment lines before the keyword). */
function stripLeadingSqlComments(sql: string): string {
  let s = sql;
  for (;;) {
    const trimmed = s.replace(/^\s+/, '');
    if (trimmed.startsWith('--')) {
      const nl = trimmed.indexOf('\n');
      s = nl === -1 ? '' : trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      s = end === -1 ? '' : trimmed.slice(end + 2);
      continue;
    }
    return trimmed;
  }
}

/**
 * True when non-whitespace, non-comment SQL content follows the first
 * top-level `;` — i.e. more than one statement was submitted. Skips over
 * single-quoted string literals (SQL's `''` escape) and comments while
 * scanning so a `;` inside a string literal doesn't false-positive.
 */
function hasTrailingStatement(sql: string): boolean {
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { i += 2; continue; }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") { inString = true; i += 1; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ';') {
      return stripLeadingSqlComments(sql.slice(i + 1)).length > 0;
    }
    i += 1;
  }
  return false;
}

type DbQueryValidation =
  | { ok: true; sql: string }
  | { ok: false; reason: 'empty_sql' | 'not_a_select' | 'multiple_statements' | 'forbidden_keyword' };

function validateReadonlySql(rawSql: unknown): DbQueryValidation {
  if (typeof rawSql !== 'string' || rawSql.trim().length === 0) {
    return { ok: false, reason: 'empty_sql' };
  }
  const stripped = stripLeadingSqlComments(rawSql);
  if (stripped.length === 0) {
    return { ok: false, reason: 'empty_sql' };
  }
  if (!READER_KEYWORD_RE.test(stripped)) {
    return { ok: false, reason: 'not_a_select' };
  }
  // Scanned over the WHOLE raw string (not just the stripped head) — ATTACH /
  // PRAGMA are rejected wherever they appear, including mid-statement.
  if (FORBIDDEN_KEYWORD_RE.test(rawSql)) {
    return { ok: false, reason: 'forbidden_keyword' };
  }
  if (hasTrailingStatement(rawSql)) {
    return { ok: false, reason: 'multiple_statements' };
  }
  return { ok: true, sql: rawSql };
}

/** Row-value sanitization shared by the cyboflow_db_query result path. */
function sanitizeDbQueryValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > DB_QUERY_MAX_STRING_LEN
      ? `${value.slice(0, DB_QUERY_MAX_STRING_LEN)}…[truncated]`
      : value;
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `<blob ${value.length} bytes>`;
  }
  return value;
}

function sanitizeDbQueryRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = sanitizeDbQueryValue(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// cyboflow_propose_action payload validation (S0.4) — narrows an unknown JSON
// value into an AgentProposalPayload, dispatching on `kind`. Every branch
// extracts each field to a local const BEFORE narrowing it so TypeScript's
// control-flow analysis reliably narrows a `Record<string, unknown>` property
// access (narrowing a bare `raw.foo` expression across a guard is fragile;
// binding it to a local first is not). Returns null (never throws) on any
// malformed shape or unrecognized kind — the caller responds ok:false
// 'invalid_payload' rather than propagate a parse exception.
// ---------------------------------------------------------------------------

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isAgentPriority(v: unknown): v is Priority {
  return v === 'P0' || v === 'P1' || v === 'P2' || v === 'P3' || v === 'P4' || v === 'P5' || v === 'P6';
}

function isAgentTaskType(v: unknown): v is TaskType {
  return v === 'idea' || v === 'epic' || v === 'task';
}

function isAgentCategory(v: unknown): v is EntityCategory {
  return v === 'feature' || v === 'bug' || v === 'chore';
}

function isAgentIdeaScope(v: unknown): v is IdeaScope {
  return v === 'small' || v === 'large';
}

/**
 * Ceiling on one create-backlog-items proposal. A proposal card is a single
 * human decision — a 50-entity dump is not reviewable, and the executor writes
 * them one chokepoint call at a time on the confirm path.
 */
const CREATE_BACKLOG_MAX_ITEMS = 20;

/**
 * Narrow one create-backlog-items entry. Every optional field is validated
 * strictly (a malformed member REJECTS the whole payload rather than being
 * dropped) — unlike the finding-extras parsers below, a create is a durable
 * entity write the human is being asked to approve, so a silently dropped
 * body/priority would have the card describe something other than what
 * Confirm would produce.
 */
function parseCreateBacklogItem(raw: unknown): CreateBacklogItem | null {
  if (!isRecord(raw)) return null;
  const taskType = raw.taskType;
  const title = raw.title;
  if (!isAgentTaskType(taskType)) return null;
  if (typeof title !== 'string' || title.trim().length === 0) return null;
  const item: CreateBacklogItem = { taskType, title };

  const summary = raw.summary;
  if (summary !== undefined) {
    if (typeof summary !== 'string') return null;
    item.summary = summary;
  }
  const body = raw.body;
  if (body !== undefined) {
    if (typeof body !== 'string') return null;
    item.body = body;
  }
  const priority = raw.priority;
  if (priority !== undefined) {
    if (!isAgentPriority(priority)) return null;
    item.priority = priority;
  }
  const category = raw.category;
  if (category !== undefined) {
    if (!isAgentCategory(category)) return null;
    item.category = category;
  }
  const scope = raw.scope;
  if (scope !== undefined) {
    if (!isAgentIdeaScope(scope)) return null;
    item.scope = scope;
  }
  const parentEpicId = raw.parentEpicId;
  if (parentEpicId !== undefined) {
    if (typeof parentEpicId !== 'string' || parentEpicId.length === 0) return null;
    item.parentEpicId = parentEpicId;
  }
  const originatingIdeaId = raw.originatingIdeaId;
  if (originatingIdeaId !== undefined) {
    if (typeof originatingIdeaId !== 'string' || originatingIdeaId.length === 0) return null;
    item.originatingIdeaId = originatingIdeaId;
  }
  return item;
}

function parseAgentNavigationTarget(raw: unknown): AgentNavigationTarget | null {
  if (!isRecord(raw)) return null;
  const target = raw.target;
  if (target === 'run') {
    const runId = raw.runId;
    if (typeof runId !== 'string' || runId.length === 0) return null;
    return { target: 'run', runId };
  }
  if (target === 'quick-session') {
    const sessionId = raw.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const navRunId = raw.runId;
    if (navRunId !== undefined && (typeof navRunId !== 'string' || navRunId.length === 0)) return null;
    return navRunId !== undefined
      ? { target: 'quick-session', sessionId, runId: navRunId }
      : { target: 'quick-session', sessionId };
  }
  return null;
}

function parseAgentProposalPayload(raw: unknown): AgentProposalPayload | null {
  if (!isRecord(raw)) return null;
  const kindRaw = raw.kind;
  if (typeof kindRaw !== 'string' || !(AGENT_PROPOSAL_KINDS as readonly string[]).includes(kindRaw)) {
    return null;
  }
  const kind = kindRaw as AgentProposalKind;

  switch (kind) {
    case 'launch-run': {
      const projectId = raw.projectId;
      const workflowName = raw.workflowName;
      if (typeof projectId !== 'number') return null;
      if (typeof workflowName !== 'string' || !isCyboflowWorkflowName(workflowName)) return null;
      const payload: LaunchRunProposalPayload = { kind: 'launch-run', projectId, workflowName };

      const substrate = raw.substrate;
      if (substrate !== undefined) {
        if (!isCliSubstrate(substrate)) return null;
        payload.substrate = substrate;
      }
      const taskIds = raw.taskIds;
      if (taskIds !== undefined) {
        if (!isStringArray(taskIds)) return null;
        payload.taskIds = taskIds;
      }
      const ideaIds = raw.ideaIds;
      if (ideaIds !== undefined) {
        if (!isStringArray(ideaIds)) return null;
        payload.ideaIds = ideaIds;
      }
      const findingIds = raw.findingIds;
      if (findingIds !== undefined) {
        if (!isStringArray(findingIds)) return null;
        payload.findingIds = findingIds;
      }
      const note = raw.note;
      if (note !== undefined) {
        if (typeof note !== 'string') return null;
        payload.note = note;
      }
      return payload;
    }
    case 'reprioritize-backlog': {
      const projectId = raw.projectId;
      const itemsRaw = raw.items;
      if (typeof projectId !== 'number') return null;
      if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) return null;
      const items: ReprioritizeBacklogItem[] = [];
      for (const entryRaw of itemsRaw) {
        if (!isRecord(entryRaw)) return null;
        const taskId = entryRaw.taskId;
        if (typeof taskId !== 'string' || taskId.length === 0) return null;
        const item: ReprioritizeBacklogItem = { taskId };
        const priority = entryRaw.priority;
        if (priority !== undefined) {
          if (!isAgentPriority(priority)) return null;
          item.priority = priority;
        }
        const stageId = entryRaw.stageId;
        if (stageId !== undefined) {
          if (typeof stageId !== 'string' || stageId.length === 0) return null;
          item.stageId = stageId;
        }
        if (item.priority === undefined && item.stageId === undefined) return null; // no-op row
        items.push(item);
      }
      const payload: ReprioritizeBacklogProposalPayload = { kind: 'reprioritize-backlog', projectId, items };
      return payload;
    }
    case 'edit-workflow': {
      const workflowId = raw.workflowId;
      const definitionJson = raw.definitionJson;
      if (typeof workflowId !== 'string' || workflowId.length === 0) return null;
      if (typeof definitionJson !== 'string' || definitionJson.length === 0) return null;
      const payload: EditWorkflowProposalPayload = { kind: 'edit-workflow', workflowId, definitionJson };
      const summary = raw.summary;
      if (summary !== undefined) {
        if (typeof summary !== 'string') return null;
        payload.summary = summary;
      }
      return payload;
    }
    case 'open-session': {
      const navigation = parseAgentNavigationTarget(raw.navigation);
      if (!navigation) return null;
      const payload: OpenSessionProposalPayload = { kind: 'open-session', navigation };
      return payload;
    }
    case 'create-backlog-items': {
      const projectId = raw.projectId;
      const itemsRaw = raw.items;
      if (typeof projectId !== 'number') return null;
      if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) return null;
      if (itemsRaw.length > CREATE_BACKLOG_MAX_ITEMS) return null;
      const items: CreateBacklogItem[] = [];
      for (const entryRaw of itemsRaw) {
        const item = parseCreateBacklogItem(entryRaw);
        if (!item) return null;
        items.push(item);
      }
      const payload: CreateBacklogItemsProposalPayload = { kind: 'create-backlog-items', projectId, items };
      return payload;
    }
  }
}


// ---------------------------------------------------------------------------
// Structured finding-extras mapping (snake_case wire -> camelCase payload).
//
// The cyboflow_report_finding tool accepts optional category / locations /
// suggested_fix / impact alongside the legacy payload_json. They arrive on the
// query message UNVALIDATED (typed `unknown`); the guards below narrow each shape
// and the builder DROPS any malformed member rather than erroring — an agent typo
// must never fail a non-blocking finding write (the whole point of the inbox).
// ---------------------------------------------------------------------------

/** A non-null object whose own keys can be safely indexed. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrow `unknown` to FindingPayload['locations'], keeping only well-formed
 * entries ({ path: string, line?: number }) and dropping malformed ones. Returns
 * undefined when the input is not an array OR no entry survives.
 */
function parseFindingLocations(v: unknown): FindingPayload['locations'] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NonNullable<FindingPayload['locations']> = [];
  for (const entry of v) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue; // drop malformed
    out.push(typeof entry.line === 'number' ? { path: entry.path, line: entry.line } : { path: entry.path });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Narrow `unknown` to FindingPayload['impact'], keeping only the numeric/string
 * members that are present and well-typed. Returns undefined when the input is
 * not an object OR no member survives.
 */
function parseFindingImpact(v: unknown): FindingPayload['impact'] | undefined {
  if (!isRecord(v)) return undefined;
  const impact: NonNullable<FindingPayload['impact']> = {};
  if (typeof v['ran_count'] === 'number') impact.ranCount = v['ran_count'];
  if (typeof v['caught_regressions'] === 'number') impact.caughtRegressions = v['caught_regressions'];
  if (typeof v['token_delta'] === 'number') impact.tokenDelta = v['token_delta'];
  if (typeof v['note'] === 'string') impact.note = v['note'];
  return Object.keys(impact).length > 0 ? impact : undefined;
}

/**
 * Build the FindingPayload extras from a report-finding message, dropping any
 * malformed member. Returns only the keys that survived narrowing (so the caller
 * can spread them over a base payload without clobbering with undefined).
 */
function buildFindingExtras(
  msg: Extract<McpQueryMessage, { type: 'mcp-report-finding' }>,
): Partial<Omit<FindingPayload, 'kind'>> {
  const extras: Partial<Omit<FindingPayload, 'kind'>> = {};
  if (typeof msg.category === 'string') extras.category = msg.category;
  if (typeof msg.suggestedFix === 'string') extras.suggestedFix = msg.suggestedFix;
  // proposedTarget must be one of the four routing literals ('fix' = a quick
  // in-place fix, added with the findings-triage redesign); anything else is
  // DROPPED (same agent-typo-can-never-fail-a-write discipline as the rest).
  if (['backlog', 'docs', 'prompt', 'fix'].includes(msg.proposedTarget as string)) {
    extras.proposedTarget = msg.proposedTarget as FindingProposedTarget;
  }
  const locations = parseFindingLocations(msg.locations);
  if (locations !== undefined) extras.locations = locations;
  const impact = parseFindingImpact(msg.impact);
  if (impact !== undefined) extras.impact = impact;
  return extras;
}

// ---------------------------------------------------------------------------
// Internal row shapes (enough for safe narrowing — not a full ORM mapping)
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  run_id: string;
  tool_name: string;
  tool_input_json: string;
  created_at: string;
}

/**
 * One held-open shell-approval socket awaiting a human verdict.
 *
 * The async-deferred `shell-approval-request` branch retains the client socket
 * (no synchronous response) and registers an in-flight entry here so two
 * cleanup paths can find it later:
 *  - the socket's own 'close'/'error' (orchestrator-down / hook subprocess
 *    died) clears the pending approval so the run does not leak in
 *    awaiting_review; and
 *  - the per-run cancel affordance (denyInFlightShellApprovals) writes a deny
 *    verdict and closes every socket for the run so a torn-down PTY unblocks.
 */
interface InFlightShellApproval {
  client: net.Socket;
  requestId: string;
  /** Set once requestApproval's transaction commits — used by cancel cleanup. */
  approvalId?: string;
  /** Detaches the per-socket 'close'/'error' disconnect listeners. */
  detachListeners: () => void;
}

/**
 * One OMP tool call whose approval outlived its requester.
 *
 * The omp-sdk gate can only block for ~25s (OMP kills extension handlers at
 * 30s), so its socket routinely goes away while the question is still worth
 * asking. The approval stays pending — {@link ApprovalRouter.orphanPendingForRun}
 * — and this entry is how the two halves find each other again:
 *
 *   - `client === null` while nobody is waiting; the verdict, when it lands, is
 *     parked in `decision` instead of being written to a dead socket.
 *   - the model's RETRY of the identical call re-attaches its fresh socket here
 *     rather than opening a second approval, so one human answer maps to one
 *     execution and the queue does not fill with duplicates of the same ask.
 *
 * `parked` is SINGLE-USE: consumed by the first matching retry and deleted.
 * A human's "yes" authorizes the call they were shown, not every future call
 * that happens to serialize identically. It also EXPIRES — see
 * {@link OMP_PARKED_DECISION_MAX_AGE_MS}.
 */
/**
 * How long a verdict that arrived with no requester keeps authorizing a retry.
 *
 * The ENTRY itself is deliberately not reaped — it must survive across turns so
 * a retry re-attaches to its own card instead of opening a duplicate, and a TTL
 * on it destroys exactly that. A parked DECISION is a different object: it is a
 * consumable authorization, and the window it stays valid in used to be bounded
 * only by the gate's ~25s budget. Raising that budget to 30 minutes
 * (`OMP_RAISED_DECISION_BUDGET_MS`) turned an incidental bound into a real one:
 * without this, a "yes" the human gave could sit in memory for the rest of the
 * run and authorize a call the model issues much later, in a context the human
 * never saw.
 *
 * Expiry is not silent — the retry falls through to a FRESH approval, so the
 * human is asked again rather than the call being denied out from under them.
 * Two minutes is generous for the mechanism this serves: OMP retries an
 * identical call within the same turn, seconds after the handler returns.
 */
const OMP_PARKED_DECISION_MAX_AGE_MS = 120_000;

interface DeferredOmpApproval {
  /** Live requester, or null while the approval is orphaned. */
  client: net.Socket | null;
  /** requestId of the CURRENT requester — a retry replaces it. */
  requestId: string;
  /**
   * Verdict that arrived with no requester attached. Single-use, and stamped so
   * it can also expire: see {@link OMP_PARKED_DECISION_MAX_AGE_MS}. One object
   * rather than two optional fields, so "decided" and "when" cannot drift.
   */
  parked?: { decision: ApprovalDecision; at: number };
  /**
   * The approvals row this entry owns, once ApprovalRouter has minted it.
   *
   * Undefined only in the window between putDeferredOmpApproval and the
   * onCreated callback — a window a socket death can land in, which is why the
   * detach path re-checks rather than assuming it is set. Needed to mark the ask
   * un-awaited when the gate stops waiting, and awaited again when a retry
   * re-attaches.
   */
  approvalId?: string;
}

/**
 * Identity of a tool call for retry matching: name + a key-ordered serialization
 * of its arguments.
 *
 * Key-ORDERED rather than raw `JSON.stringify` because the retry is a fresh
 * serialization from the model, and object key order is not guaranteed stable
 * across turns; without the sort an identical call could miss its own orphaned
 * approval and open a duplicate card. Recursive so nested argument objects sort
 * too. Non-plain values fall back to their JSON form.
 */
function ompCallKey(toolName: string, toolInput: Record<string, unknown>): string {
  return `${toolName}\u0000${stableJson(toolInput)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ---------------------------------------------------------------------------
// McpQueryHandler
// ---------------------------------------------------------------------------

export class McpQueryHandler {
  /**
   * In-flight shell-approval sockets, keyed by runId. The shell transport holds
   * the connection open across the multi-minute human-decision window, so the
   * socket must be reachable by both the disconnect-cleanup path and the cancel
   * affordance the interactive manager calls before killing the PTY.
   */
  private readonly inFlightShellApprovals = new Map<string, Set<InFlightShellApproval>>();

  /**
   * Orphaned OMP approvals, keyed runId → {@link ompCallKey} → entry. Populated
   * only on the omp-sdk lane; cleared with the run's in-flight sockets.
   */
  private readonly ompDeferredApprovals = new Map<string, Map<string, DeferredOmpApproval>>();

  /**
   * Lazily-opened, cached readonly sibling connection backing
   * cyboflow_db_query (mcp-db-query). Opened once on first use against
   * `this.db.name` (the on-disk file path the injected DatabaseLike wraps)
   * and reused for the process lifetime — mirrors the main db connection's
   * own lifetime, so no explicit dispose path is needed here (this class has
   * no existing close()/dispose() to hook into).
   */
  private globalAgentReadonlyDb: BetterSqlite3Database.Database | null = null;

  /**
   * @param db     Orchestrator DB surface.
   * @param logger Optional structured logger. Passed through for connect /
   *               disconnect / precondition diagnostics on the shell-approval
   *               path (CODE-PATTERNS.md optional-logger rule: pass it, don't omit it).
   * @param deps   Optional callback deps otherwise unreachable from this layer
   *               (see McpQueryHandlerDeps). Defaults to `{}` — every member is
   *               individually optional, so omitting this arg entirely (as every
   *               existing test call site does) is equivalent to passing `{}`.
   */
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
    private readonly deps: McpQueryHandlerDeps = {},
  ) {}

  // --------------------------------------------------------------------------
  // Public entry point
  // --------------------------------------------------------------------------

  /**
   * Route a parsed McpQueryMessage to the correct handler and write a
   * JSON response back on `client`.
   *
   * Never throws — all exceptions are caught and surfaced as ok:false responses.
   */
  async handleMessage(msg: McpQueryMessage, client: net.Socket): Promise<void> {
    try {
      switch (msg.type) {
        case 'mcp-list-pending-approvals':
          this.handleListPendingApprovals(msg, client);
          break;
        case 'mcp-get-run':
          this.handleGetRun(msg, client);
          break;
        case 'mcp-submit-checkpoint':
          this.handleSubmitCheckpoint(msg, client);
          break;
        case 'mcp-report-step':
          await this.handleReportStep(msg, client);
          break;
        case 'mcp-request-user-input':
          await this.handleRequestUserInput(msg, client);
          break;
        case 'mcp-create-task':
          await this.handleCreateTask(msg, client);
          break;
        case 'mcp-update-task':
          await this.handleUpdateTask(msg, client);
          break;
        case 'mcp-set-task-stage':
          await this.handleSetTaskStage(msg, client);
          break;
        case 'mcp-add-task-dependency':
          await this.handleAddTaskDependency(msg, client);
          break;
        case 'mcp-set-idea-component':
          await this.handleSetIdeaComponent(msg, client);
          break;
        case 'mcp-list-tasks':
          // Read-only: projects + flattens selectProjectBacklog's tree. Never writes.
          this.handleListTasks(msg, client);
          break;
        case 'mcp-get-task':
          // Read-only: id-then-ref resolution + cross-project guard. Never writes.
          this.handleGetTask(msg, client);
          break;
        case 'mcp-update-sprint-task':
          this.handleUpdateSprintTask(msg, client);
          break;
        case 'mcp-create-sprint-batch':
          this.handleCreateSprintBatch(msg, client);
          break;
        case 'mcp-report-finding':
          // NON-BLOCKING: writes its response synchronously after enqueuing the
          // review-item create — the run is NEVER paused waiting on the inbox.
          this.handleReportFinding(msg, client);
          break;
        case 'mcp-get-selected-findings':
          // Read-only: returns the findings the human seeded into THIS compound
          // run (workflow_runs.seed_finding_ids). Never writes.
          this.handleGetSelectedFindings(msg, client);
          break;
        case 'mcp-get-eval':
          // Read-only: run_evals + the review_items cross-link. Never writes,
          // and deliberately not gated on a live run — the eval grades AT settle.
          this.handleGetEval(msg, client);
          break;
        case 'mcp-list-run-findings':
          // Read-only, but AWAITED: it drains the project's review-item queue
          // first so the run observes its own just-reported findings (the
          // fire-and-forget report path replies before its write commits).
          await this.handleListRunFindings(msg, client);
          break;
        case 'mcp-resolve-finding':
          // AWAITED (unlike fire-and-forget report-finding) so a failed resolve
          // surfaces to the agent rather than silently leaving the finding pending.
          await this.handleResolveFinding(msg, client);
          break;
        case 'mcp-report-artifact':
          await this.handleReportArtifact(msg, client);
          break;
        case 'mcp-commit-artifact':
          await this.handleCommitArtifact(msg, client);
          break;
        case 'mcp-design-get-idea':
          // Design Mode v0: read-only; re-validates the session's idea link.
          this.handleDesignGetIdea(msg, client);
          break;
        case 'mcp-design-update-draft':
          // Design Mode v0: persists a monotonic design-spec draft bound to the
          // current ui-prototype revision (the CAS material Approve consumes).
          this.handleDesignUpdateDraft(msg, client);
          break;
        case 'mcp-design-ack-feedback':
          // Design Mode v1: AWAITED — the one-result CAS runs through the
          // FeedbackRouter queue, and the agent needs the applied/discarded
          // outcome back before it moves on.
          await this.handleDesignAckFeedback(msg, client);
          break;
        case 'mcp-request-verification':
          // FIRE-AND-CONTINUE on the VERDICT (the lane never blocks on it), but
          // AWAITED here: the enqueue-time runbook resolution (§5.2 seam 3) does
          // filesystem work, and the reply must not be written until the row —
          // pin included — exists.
          await this.handleRequestVerification(msg, client);
          break;
        case 'mcp-await-verification':
          // BLOCKING (§5.2 seam 2) — holds the socket open until the request
          // settles or the caller's bounded deadline expires, exactly like the
          // question gate above. The setup flow's prove→diagnose→re-prove loop
          // needs the verdict IN ITS OWN TURN; fire-and-continue delivery has no
          // channel back to a live turn.
          await this.handleAwaitVerification(msg, client);
          break;
        case 'mcp-get-verifications':
          // NON-BLOCKING cold read — a plain run-scoped SELECT, no waiting.
          this.handleGetVerifications(msg, client);
          break;
        case 'mcp-register-verify-runbook':
          // AWAITED: the store reads + validates the portable runbook file and
          // fingerprints the host, so the reply cannot be written until the
          // record (and its hash + CAS version) actually exists.
          await this.handleRegisterVerifyRunbook(msg, client);
          break;
        case 'mcp-run-eval':
          // FIRE-AND-CONTINUE: awaits only the snapshot + enqueue (never the jury),
          // then replies with the queued/requeued/in_flight status or a reason code.
          await this.handleRunEval(msg, client);
          break;
        case 'mcp-list-workflows':
          this.handleListWorkflows(msg, client);
          break;
        case 'mcp-get-workflow':
          this.handleGetWorkflow(msg, client);
          break;
        case 'mcp-update-workflow':
          this.handleUpdateWorkflow(msg, client);
          break;
        case 'mcp-reset-workflow':
          this.handleResetWorkflow(msg, client);
          break;
        case 'mcp-create-workflow':
          this.handleCreateWorkflow(msg, client);
          break;
        case 'mcp-delete-workflow':
          this.handleDeleteWorkflow(msg, client);
          break;
        case 'mcp-list-variants':
          this.handleListVariants(msg, client);
          break;
        case 'mcp-create-variant':
          this.handleCreateVariant(msg, client);
          break;
        case 'mcp-update-variant':
          this.handleUpdateVariant(msg, client);
          break;
        case 'mcp-set-variant-status':
          this.handleSetVariantStatus(msg, client);
          break;
        case 'mcp-delete-variant':
          this.handleDeleteVariant(msg, client);
          break;
        case 'mcp-set-baseline-rotation':
          this.handleSetBaselineRotation(msg, client);
          break;
        case 'mcp-overview':
          this.handleAgentOverview(msg, client);
          break;
        case 'mcp-backlog':
          this.handleAgentBacklog(msg, client);
          break;
        case 'mcp-entity':
          this.handleAgentEntity(msg, client);
          break;
        case 'mcp-queue':
          this.handleAgentQueue(msg, client);
          break;
        case 'mcp-workflows':
          this.handleAgentWorkflows(msg, client);
          break;
        case 'mcp-workflow':
          this.handleAgentWorkflow(msg, client);
          break;
        case 'mcp-propose-action':
          this.handleProposeAction(msg, client);
          break;
        case 'mcp-db-query':
          this.handleAgentDbQuery(msg, client);
          break;
        case 'mcp-fs-read':
          this.handleFsRead(msg, client);
          break;
        case 'mcp-fs-list':
          this.handleFsList(msg, client);
          break;
        case 'mcp-fs-grep':
          this.handleFsGrep(msg, client);
          break;
        case 'mcp-history':
          this.handleAgentHistory(msg, client);
          break;
        case 'shell-approval-request':
          // Async-deferred — the FIRST handler that does NOT writeResponse
          // synchronously. It returns after kicking off requestApproval; only
          // the socketReply closure writes the verdict, possibly minutes later.
          this.handleShellApprovalRequest(msg, client);
          break;
        case 'interactive-turn-end':
          // Fire-and-ack: unlike shell-approval-request, there is no verdict to
          // defer — writeResponse happens synchronously either way.
          this.handleInteractiveTurnEnd(msg, client);
          break;
        case 'interactive-question-open':
          // Fire-and-ack: flip the run's board state to `blocked`; no verdict.
          this.handleInteractiveQuestionOpen(msg, client);
          break;
        default: {
          // TypeScript exhaustiveness helper — cast so the switch compiles even
          // if future union members are added without updating this switch.
          const exhaustive = msg as { type: string; requestId: string };
          console.error(
            `[Cyboflow MCP Query] Unknown message type: ${exhaustive.type}`,
          );
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: exhaustive.requestId,
            ok: false,
            error: 'unknown_message_type',
          });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // NOT "unhandled" — every throw reaching here is converted into the
      // structured ok:false response written immediately below, and several
      // handlers rely on that conversion for EXPECTED input errors. The clearest
      // case is handleAgentDbQuery, whose SQL is AGENT-authored: a bad column
      // name in an ad-hoc cyboflow_db_query is a query error the caller is told
      // about, not an app fault. Reporting those as "Unhandled error" labelled a
      // designed path as a crash — it cost a 2026-08-01 smoke run a false
      // medium-severity app finding before the handler's own source comment
      // reclassified it. This message states what is true of BOTH classes (the
      // handler threw; the client got ok:false) and names the message type so
      // triage knows which handler without decoding the stack.
      //
      // mcp-db-query goes to WARN rather than ERROR: wording alone did not stop
      // the recurrence (the 2026-08-06 smoke re-filed the same false finding off
      // a line that already said "returned to client as ok:false", because log
      // triage keys off the LEVEL, not the prose). Its SQL is agent-authored, so
      // a throw here is by construction a caller error and does not belong on
      // the channel reserved for app faults. Every other message type builds its
      // own SQL and keeps ERROR, where a throw IS ours.
      const logAtWarn = msg.type === 'mcp-db-query';
      const summary = `[Cyboflow MCP Query] ${msg.type} threw; returned to client as ok:false:`;
      if (logAtWarn) {
        console.warn(`${summary} ${error} (agent-authored SQL — caller error, not an app fault)`);
      } else {
        console.error(summary, err);
      }
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Message handlers
  // --------------------------------------------------------------------------

  private handleListPendingApprovals(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-pending-approvals' }>,
    client: net.Socket,
  ): void {
    const stmt = this.db.prepare(
      `SELECT id, run_id, tool_name, tool_input_json, created_at
         FROM approvals
        WHERE status = 'pending'
        ORDER BY created_at ASC`,
    );
    const rows = stmt.all() as ApprovalRow[];

    const approvals = rows.map((row) => ({
      approval_id: row.id,
      run_id: row.run_id,
      tool_name: row.tool_name,
      input: (() => {
        try {
          return JSON.parse(row.tool_input_json) as unknown;
        } catch {
          console.warn(
            `[Cyboflow MCP Query] tool_input_json parse failed for approval ${row.id} — returning raw string`,
          );
          return row.tool_input_json;
        }
      })(),
      created_at: row.created_at,
    }));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { approvals },
    });
  }

  private async handleRequestUserInput(
    msg: Extract<McpQueryMessage, { type: 'mcp-request-user-input' }>,
    client: net.Socket,
  ): Promise<void> {
    const answer = await QuestionRouter.getInstance().requestQuestion(
      msg.runId,
      msg.requestId,
      msg.questions,
      () => undefined,
    );
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: answer,
    });
  }

  private handleGetRun(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-run' }>,
    client: net.Socket,
  ): void {
    const stmt = this.db.prepare(
      `SELECT * FROM workflow_runs WHERE id = ?`,
    );
    const row = stmt.get(msg.targetRunId) as Record<string, unknown> | undefined;

    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { run: row },
    });
  }

  private handleSubmitCheckpoint(
    msg: Extract<McpQueryMessage, { type: 'mcp-submit-checkpoint' }>,
    client: net.Socket,
  ): void {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'checkpoint_requires_real_run',
      });
      return;
    }

    const now = new Date().toISOString();
    const payload = JSON.stringify({
      label: msg.label,
      note: msg.note ?? null,
      submitted_via: 'mcp',
    });

    const stmt = this.db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, created_at)
       VALUES (?, 'cyboflow_checkpoint', ?, ?)`,
    );
    const result = stmt.run(msg.runId, payload, now);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { checkpoint_id: result.lastInsertRowid },
    });
  }

  /**
   * Record the run's current workflow step (OBSERVATIONAL — drives the Workflow
   * Progress panel; never changes workflow_runs.status).
   *
   * Validation flow (dynamic step-id model, post user-editable-workflows merge):
   *   - orchestrator-sentinel guard mirrors handleSubmitCheckpoint: the
   *     singleton MCP server runs with CYBOFLOW_RUN_ID='orchestrator', which has
   *     no workflow_runs row → reject before any DB touch.
   *   - JOIN workflows for the run's name AND spec_json, then resolve the
   *     EFFECTIVE definition via resolveWorkflowDefinition(name, specJson). This
   *     is the runtime source of truth that fully overrides the static
   *     WORKFLOW_DEFINITIONS seed — an edited/custom step id present only in
   *     spec_json is accepted, a step id absent from (or removed by an edit of)
   *     the resolved def is rejected with 'unknown_step_id' (no write).
   *   - We validate stepId here (returning structured 'unknown_step_id') rather
   *     than relying on buildStepTransitionEvent's null return, which collapses
   *     "bad step" and "row vanished" into a single null and cannot distinguish
   *     them for the response. The bridge call is reached only for already-
   *     validated steps; its `null` there means the row vanished mid-flight.
   *
   * Pass `undefined` for the bridge logger arg — this class holds no LoggerLike
   * and must not fabricate one (CODE-PATTERNS.md silent-no-op rule applies only to
   * loggers actually in scope; the bridge falls back to console.warn).
   */
  private async handleReportStep(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-step' }>,
    client: net.Socket,
  ): Promise<void> {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'report_step_requires_real_run',
      });
      return;
    }

    // A/B testing (migration 055): resolve the run's FROZEN effective spec (its
    // variant graph, else the live spec) via resolveRunFrozenSpec (already keyed by
    // runId) instead of a live JOIN read.
    const row = resolveRunFrozenSpec(this.db, msg.runId);

    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_not_found',
      });
      return;
    }

    const name = row.workflowName;
    const specJson = row.specJson;

    // Validate stepId against the run's RESOLVED definition — NOT the static
    // WORKFLOW_DEFINITIONS constant (which is now only the seed/fallback).
    const def = resolveWorkflowDefinition(name, specJson);
    const allSteps = def === null ? [] : def.phases.flatMap((p) => p.steps);
    const step = allSteps.find((s) => s.id === msg.stepId);

    if (!step) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'unknown_step_id',
      });
      return;
    }

    const status = msg.status ?? 'running';

    // GATE GUARD (silent-pass safety net) — ORCHESTRATED runs only. An
    // orchestrated agent — especially a Codex handover agent that lacks Claude's
    // AskUserQuestion tool — can report a HUMAN gate step 'done' WITHOUT ever
    // surfacing a real gate, asking in plain chat instead. That silent pass
    // skips the human decision entirely; for approve-plan it also skips the
    // reveal (promoteTasksOnPlanApproval), leaving plan_approved_at NULL, the
    // run's drafted tasks unpromoted, and materialize-batch dying with
    // `ship_no_tasks_to_materialize`. Refuse to COMPLETE any human gate that
    // shows no backend trace of having been surfaced-and-answered, forcing the
    // agent to open the gate via `cyboflow_request_user_input` (Codex/MCP) or
    // AskUserQuestion (Claude).
    //
    // Scoped to orchestrated runs: the programmatic plane drives human steps via
    // the deterministic HumanStepManager/openHumanGate, which writes a decision
    // review_item (NOT a `questions` row) and stamps plan_approved_at before its
    // step worker reports done — so the questions-based check below would
    // false-positive there. Two signals, strongest-first:
    //   • approve-plan → plan_approved_at. Bulletproof: the reveal stamps it
    //     SYNCHRONOUSLY (before the agent resumes) iff a gate resolved through
    //     QuestionRouter with an Approve answer.
    //   • every other human gate → a `questions` row created at/after the step's
    //     most-recent 'running' onset (humanGateWasSurfaced). Fail-OPEN whenever
    //     the window can't be bounded, so a legitimately-surfaced gate is never
    //     false-rejected. Both branches fail open on a missing run / pre-schema
    //     DB (never block).
    if (step.human === true && status === 'done') {
      const executionModel = this.readExecutionModel(msg.runId);
      if (executionModel === 'orchestrated') {
        if (msg.stepId === APPROVE_PLAN_STEP_ID) {
          if (!this.isPlanApproved(msg.runId)) {
            this.writeResponse(client, {
              type: 'mcp-query-response',
              requestId: msg.requestId,
              ok: false,
              error:
                'approve_plan_gate_not_resolved: no plan approval was recorded for this run. ' +
                'Surface the approve-plan gate with cyboflow_request_user_input (or AskUserQuestion) ' +
                'and wait for the human to answer "Approve" — do NOT ask in a plain chat message — ' +
                'before reporting approve-plan done.',
            });
            return;
          }
        } else if (!this.humanGateWasSurfaced(msg.runId, msg.stepId)) {
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: msg.requestId,
            ok: false,
            error:
              `human_gate_not_surfaced: no human gate was surfaced for the '${msg.stepId}' step. ` +
              'Open the gate with cyboflow_request_user_input (or AskUserQuestion) and wait for the ' +
              `human to answer — do NOT ask in a plain chat message — before reporting '${msg.stepId}' done.`,
          });
          return;
        }
      }
    }

    const event = buildStepTransitionEvent(msg.runId, msg.stepId, status, this.db, undefined);

    if (event === null) {
      // Row vanished between the JOIN above and the bridge UPDATE — the stepId
      // was already validated, so a null here is a missing-run race, not a typo.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_not_found',
      });
      return;
    }

    // Report-step is OBSERVATIONAL: it records the run's current step for the
    // progress rail and never changes the run's lifecycle state. Human steps
    // (approve-idea / approve-plan / human-review) are AGENT-driven — the agent
    // pauses and asks via AskUserQuestion, which QuestionRouter surfaces as a
    // blocking `decision` review_item. The orchestrator must NOT pause the run on
    // a human-step report: doing so blocks the very agent that needs to ask (its
    // own tool calls then fail the status='running' guard → deadlock).
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        step_id: msg.stepId,
        status,
      },
    });
  }

  /**
   * Fail-soft read of a run's execution_model ('orchestrated' | 'programmatic').
   * Returns null on a missing run / vanished row (never throws) — callers treat
   * a non-'orchestrated' result as "no gate guard".
   */
  private readExecutionModel(runId: string): string | null {
    try {
      const row = this.db
        .prepare('SELECT execution_model AS m FROM workflow_runs WHERE id = ?')
        .get(runId) as { m?: unknown } | undefined;
      return typeof row?.m === 'string' ? row.m : null;
    } catch {
      return null;
    }
  }

  /**
   * True iff the run's approve-plan reveal stamped plan_approved_at (a real gate
   * resolved through QuestionRouter with Approve). Fail-OPEN (returns true) on a
   * pre-042 DB lacking the column or a vanished run, so the guard never blocks
   * when it cannot judge.
   */
  private isPlanApproved(runId: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT plan_approved_at AS p FROM workflow_runs WHERE id = ?')
        .get(runId) as { p?: unknown } | undefined;
      return typeof row?.p === 'string' && row.p.length > 0;
    } catch {
      // Pre-042 DB (no plan_approved_at column) — cannot judge, so do not block.
      return true;
    }
  }

  /**
   * True iff a gate question was surfaced for `stepId` on this run — i.e. a
   * `questions` row exists created at/after the step's most-recent 'running'
   * onset (from the step_transition raw_events log). This is the generic
   * silent-pass signal for human gates OTHER than approve-plan (which has the
   * stronger plan_approved_at check). It catches only the clear failure mode:
   * an orchestrated agent that reported the step running→done without ever
   * opening a gate. Fail-OPEN (returns true) whenever the window can't be
   * bounded — no 'running' onset recorded, or the questions/raw_events tables
   * (or JSON1) are unavailable — so a legitimately-surfaced gate, or a
   * clarifying question the human engaged with, is never false-rejected.
   */
  private humanGateWasSurfaced(runId: string, stepId: string): boolean {
    try {
      const onsetRow = this.db
        .prepare(
          `SELECT created_at AS onset FROM raw_events
             WHERE run_id = ? AND event_type = 'step_transition'
               AND json_extract(payload_json, '$.step_id') = ?
               AND json_extract(payload_json, '$.status') = 'running'
             ORDER BY id DESC LIMIT 1`,
        )
        .get(runId, stepId) as { onset?: unknown } | undefined;
      const onset = typeof onsetRow?.onset === 'string' ? onsetRow.onset : null;
      if (onset === null) {
        // No 'running' onset recorded for this step — the window is unbounded, so
        // do not block (an agent that never reported running is out of scope).
        return true;
      }
      const surfaced = this.db
        .prepare(
          `SELECT 1 FROM questions
             WHERE run_id = ? AND datetime(created_at) >= datetime(?)
             LIMIT 1`,
        )
        .get(runId, onset) as unknown;
      return surfaced !== undefined;
    } catch {
      // questions / raw_events / JSON1 unavailable — fail open.
      return true;
    }
  }

  // --------------------------------------------------------------------------
  // Native task writes (cyboflow_create_task / _update_task / _set_task_stage)
  //
  // All three route through the SINGLE write chokepoint
  // TaskChangeRouter.getInstance().applyChange — they NEVER UPDATE `tasks`
  // directly. The actor is derived from the calling run's current step
  // (agent:LABEL), mirroring TaskChangeRouter.resolveAgentLabel. The
  // orchestrator-derived stage authority, active-run guard, parent validation,
  // and optimistic concurrency are all enforced INSIDE applyChange and surface
  // here as TaskChangeError.code (forbidden_stage | active_runs | invalid_parent
  // | not_found | concurrency) — they are DESIGNED rejections, not bugs.
  // --------------------------------------------------------------------------

  /**
   * Resolve the calling run into the project scope + agent actor needed to apply
   * a task change. Returns a discriminated result so callers branch without any.
   *
   * Guards (parity with handleSubmitCheckpoint / handleReportStep):
   *   - the 'orchestrator' sentinel runId has no workflow_runs row → reject
   *     before any DB touch (task_write_requires_real_run);
   *   - a missing run row → run_not_found;
   *   - a terminal run (completed | failed | canceled) must not mutate tasks →
   *     run_not_active.
   *
   * Actor derivation mirrors TaskChangeRouter.resolveAgentLabel:
   *   label = snapshot[current_step_id] (non-empty string) ?? current_step_id ??
   *           'unknown'; actor = `agent:${label}`.
   */
  private resolveTaskRunContext(
    runId: string,
  ): { ok: true; projectId: number; actor: TaskActor } | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'task_write_requires_real_run' };
    }

    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, status, current_step_id AS currentStepId,
                steps_snapshot_json AS stepsSnapshotJson
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          projectId?: unknown;
          status?: unknown;
          currentStepId?: unknown;
          stepsSnapshotJson?: unknown;
        }
      | undefined;

    if (!row) {
      return { ok: false, error: 'run_not_found' };
    }

    const status = typeof row.status === 'string' ? row.status : '';
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      return { ok: false, error: 'run_not_active' };
    }

    const projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
    const currentStepId = typeof row.currentStepId === 'string' ? row.currentStepId : null;
    const stepsSnapshotJson = typeof row.stepsSnapshotJson === 'string' ? row.stepsSnapshotJson : null;

    let label = 'unknown';
    if (currentStepId && stepsSnapshotJson) {
      try {
        const snapshot = JSON.parse(stepsSnapshotJson) as Record<string, unknown>;
        const agent = snapshot[currentStepId];
        if (typeof agent === 'string' && agent.length > 0) {
          label = resolveStepAgentKey(currentStepId, agent) ?? agent;
        } else {
          label = currentStepId;
        }
      } catch {
        // malformed snapshot — fall back to the step id when present.
        label = currentStepId;
      }
    } else if (currentStepId) {
      label = currentStepId;
    }

    const actor: TaskActor = `agent:${label}`;
    return { ok: true, projectId, actor };
  }

  /**
   * Re-read an entity's identity columns after a chokepoint write so the
   * response carries the canonical ref / stage / version / type. Table identity
   * is the discriminator (migration 015), so we try ideas -> epics -> tasks in
   * turn and return the type of the matching table. Returns undefined only if
   * the row vanished between commit and read (caller surfaces not_found).
   */
  private readTaskIdentity(
    taskId: string,
  ): { ref: string; stage_id: string; version: number; type: TaskType } | undefined {
    const tables: Array<{ table: string; type: TaskType }> = [
      { table: 'ideas', type: 'idea' },
      { table: 'epics', type: 'epic' },
      { table: 'tasks', type: 'task' },
    ];
    for (const { table, type } of tables) {
      const row = this.db
        .prepare(`SELECT ref, stage_id, version FROM ${table} WHERE id = ?`)
        .get(taskId) as { ref?: unknown; stage_id?: unknown; version?: unknown } | undefined;
      if (!row) continue;
      return {
        ref: typeof row.ref === 'string' ? row.ref : '',
        stage_id: typeof row.stage_id === 'string' ? row.stage_id : '',
        version: typeof row.version === 'number' ? row.version : Number(row.version),
        type,
      };
    }
    return undefined;
  }

  /**
   * Resolve a ref-or-id into the OPAQUE id of an existing entity of `type`
   * within `projectId`, or null when it does not exist / is the wrong type /
   * belongs to another project. Used by the global agent's
   * create-backlog-items propose path to validate + normalize the
   * parentEpicId / originatingIdeaId links a proposed batch points at
   * (resolveBacklogRef round-trips an opaque id unchanged, so one call covers
   * both input forms).
   */
  private resolveExistingEntity(projectId: number, refOrId: string, type: TaskType): string | null {
    const id = resolveBacklogRef(this.db, projectId, refOrId) ?? refOrId;
    const table = type === 'idea' ? 'ideas' : type === 'epic' ? 'epics' : 'tasks';
    const row = this.db
      .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`)
      .get(id, projectId);
    return row !== undefined ? id : null;
  }

  private async handleCreateTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-task' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // originating_idea_id is only meaningful for epic/task creates (ideas carry
    // no lineage — describe('idea').hasOriginatingIdea is false); an idea
    // create silently drops a supplied value here rather than letting the
    // chokepoint reject it with invalid_lineage, mirroring how scope is
    // dropped on epic/task creates (desc.hasScope gating in TaskChangeRouter)
    // instead of throwing. When applicable, resolve ref-or-id via the same
    // resolveBacklogRef helper used elsewhere in this file (get_task,
    // create_sprint_batch) — an opaque id has no matching `ref` row so it
    // round-trips unchanged.
    const originatingIdeaId: string | null =
      msg.originatingIdeaId !== undefined && msg.taskType !== undefined && msg.taskType !== 'idea'
        ? (resolveBacklogRef(this.db, ctx.projectId, msg.originatingIdeaId) ?? msg.originatingIdeaId)
        : null;

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      entityType: msg.taskType,
      title: msg.title,
      summary: msg.summary,
      body: msg.body,
      priority: msg.priority,
      category: msg.category,
      repo: msg.repo,
      parentEpicId: msg.parentEpicId ?? null,
      boardId: msg.boardId,
      initialStageId: msg.initialStageId,
      scope: msg.scope,
      originatingIdeaId,
    };

    try {
      const { taskId } = await TaskChangeRouter.getInstance().applyChange(ctx.projectId, change);
      const identity = this.readTaskIdentity(taskId);

      // Content-driven artifact mint: a successful entity create may have just made
      // a templated deliverable non-empty (idea -> idea-spec; epic/task ->
      // decomposed-stories). Fire-and-forget + fail-soft (handleEntityWrite never
      // throws, but a defensive .catch guards a surprise rejection from becoming an
      // unhandled rejection — mirrors the buildStepTransitionEvent .catch posture).
      // The entity type comes from the re-read identity, falling back to the
      // requested taskType (default 'idea' at the chokepoint).
      const createdType: 'idea' | 'epic' | 'task' = identity?.type ?? msg.taskType ?? 'idea';
      void handleEntityWrite(this.db, msg.runId, createdType, this.logger).catch((err) => {
        this.logger?.warn('[Cyboflow MCP Query] entity-write mint rejected (ignored)', {
          runId: msg.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          task_id: taskId,
          ref: identity?.ref,
          stage_id: identity?.stage_id,
          type: identity?.type,
          version: identity?.version,
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  private async handleUpdateTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-task' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      taskId: msg.taskId,
      ...(msg.entityType !== undefined ? { entityType: msg.entityType } : {}),
      fields: {
        title: msg.title,
        summary: msg.summary,
        body: msg.body,
        priority: msg.priority,
        category: msg.category,
        repo: msg.repo,
        scope: msg.scope,
      },
      ...(msg.parentEpicId !== undefined ? { parentEpicId: msg.parentEpicId } : {}),
      expectedVersion: msg.expectedVersion,
    };

    try {
      const { taskId } = await TaskChangeRouter.getInstance().applyChange(ctx.projectId, change);
      const identity = this.readTaskIdentity(taskId);

      // Content-driven artifact mint: an update that filled in the idea body /
      // summary (idea -> idea-spec) or an entity's content (epic/task ->
      // decomposed-stories) may have just made a templated deliverable non-empty.
      // Fire-and-forget + fail-soft (mirrors the create path). Entity type from the
      // re-read identity, falling back to the discriminator the caller supplied.
      const writtenType: 'idea' | 'epic' | 'task' = identity?.type ?? msg.entityType ?? 'idea';
      void handleEntityWrite(this.db, msg.runId, writtenType, this.logger).catch((err) => {
        this.logger?.warn('[Cyboflow MCP Query] entity-write mint rejected (ignored)', {
          runId: msg.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          task_id: taskId,
          stage_id: identity?.stage_id,
          version: identity?.version,
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  private async handleSetTaskStage(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-task-stage' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      taskId: msg.taskId,
      ...(msg.entityType !== undefined ? { entityType: msg.entityType } : {}),
      stageId: msg.stageId,
      expectedVersion: msg.expectedVersion,
    };

    try {
      const { taskId } = await TaskChangeRouter.getInstance().applyChange(ctx.projectId, change);
      const identity = this.readTaskIdentity(taskId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          task_id: taskId,
          stage_id: identity?.stage_id,
          version: identity?.version,
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  /**
   * Record a task->task dependency edge via the chokepoint. Routes through the
   * same run-context guards as the other task writes, then applies a
   * `dependsOnTaskId`-carrying TaskChange (the chokepoint's add-dependency
   * branch). Designed rejections surface as TaskChangeError.code
   * (invalid_dependency | dependency_cycle | not_found) via writeTaskChangeError.
   */
  private async handleAddTaskDependency(
    msg: Extract<McpQueryMessage, { type: 'mcp-add-task-dependency' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const change: TaskChange = {
      actor: ctx.actor,
      runId: msg.runId,
      entityType: 'task',
      taskId: msg.taskId,
      dependsOnTaskId: msg.dependsOnTaskId,
      ...(msg.dependencyKind !== undefined ? { dependencyKind: msg.dependencyKind } : {}),
    };

    try {
      const { taskId, dependsOnTaskId } = await TaskChangeRouter.getInstance().applyChange(
        ctx.projectId,
        change,
      );
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          // Echo the RESOLVED canonical ids for BOTH endpoints (the caller may
          // have passed display refs, e.g. TASK-001) so the response reflects
          // what was actually stored, not the raw input handles.
          task_id: taskId,
          depends_on_task_id: dependsOnTaskId ?? msg.dependsOnTaskId,
          kind: msg.dependencyKind ?? 'blocking',
        },
      });
    } catch (err) {
      this.writeTaskChangeError(client, msg.requestId, err);
    }
  }

  /**
   * Surface a chokepoint failure as an ok:false response. A TaskChangeError maps
   * to its discriminated .code (mirrors the tasks tRPC router); anything else is
   * logged and collapsed to the opaque 'task_change_failed'.
   */
  private writeTaskChangeError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof TaskChangeError) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] task change failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'task_change_failed',
    });
  }

  /**
   * Set one idea's component ledger state (cyboflow_set_idea_component) via
   * IdeaComponentRouter's 'set-component-state' op, source:'flow'. Resolves
   * `ideaId` id-then-ref exactly like handleGetTask (an opaque id wins; on a
   * miss, resolveBacklogRef scoped to this run's project), and rejects
   * 'not_found' when the resolved entity is missing, cross-project, or not an
   * idea (epics/tasks carry no ledger) — the same "indistinguishable from a
   * genuine miss" posture handleGetTask uses for its cross-project guard.
   *
   * `sourceRunId` and `builtAgainstVersion` are resolved HERE, never accepted
   * from the calling agent (per the brief: "the tool resolves those, never the
   * calling agent") — sourceRunId is this run's own id, and
   * builtAgainstVersion is the idea's CURRENT `version` at call time (the
   * version this component is being stamped AGAINST).
   */
  private async handleSetIdeaComponent(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-idea-component' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    let item = selectTaskById(this.db, msg.ideaId);
    if (!item) {
      const resolvedId = resolveBacklogRef(this.db, ctx.projectId, msg.ideaId);
      if (resolvedId) {
        item = selectTaskById(this.db, resolvedId);
      }
    }

    if (!item || item.project_id !== ctx.projectId || item.type !== 'idea') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }

    try {
      const { states } = await IdeaComponentRouter.getInstance().applyChange(ctx.projectId, {
        op: 'set-component-state',
        ideaId: item.id,
        component: msg.component,
        state: msg.state,
        source: 'flow',
        sourceRunId: msg.runId,
        builtAgainstVersion: item.version,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          idea_id: item.id,
          ref: item.ref,
          component: msg.component,
          state: msg.state,
          // The fresh merged hybrid snapshot (all five) — lets the calling
          // agent confirm staleness cleared without a separate get_task round
          // trip (setComponentState always clears stale_at/stale_reason as a
          // side effect; see ideaComponentRouter.ts).
          components: states,
        },
      });
    } catch (err) {
      this.writeIdeaComponentError(client, msg.requestId, err);
    }
  }

  /**
   * Surface an IdeaComponentRouter chokepoint failure as an ok:false response.
   * Mirrors writeTaskChangeError's shape for the sibling ledger chokepoint.
   */
  private writeIdeaComponentError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof IdeaComponentError) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] idea component change failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'idea_component_change_failed',
    });
  }

  // --------------------------------------------------------------------------
  // Read-only backlog listing (cyboflow_list_tasks / cyboflow_get_task)
  //
  // Both reuse resolveTaskRunContext for project scoping (the actor it also
  // returns is unused here — these paths never write). Neither ever calls
  // TaskChangeRouter or mutates any table; they read exclusively through the
  // shared taskListing.ts projection so the shape can never drift from the
  // tasks tRPC router's own reads.
  // --------------------------------------------------------------------------

  /**
   * The compact projection cyboflow_list_tasks returns per item — deliberately
   * WITHOUT `body` / `inFlow` / `children` (an agent enumerating the backlog
   * does not need the full markdown spec or the live-run overlay for every
   * row; cyboflow_get_task fetches one item's full body on demand).
   */
  private static toCompactTask(item: BacklogTaskItem): Record<string, unknown> {
    return {
      id: item.id,
      ref: item.ref,
      type: item.type,
      title: item.title,
      summary: item.summary,
      priority: item.priority,
      category: item.category,
      stage_id: item.stage_id,
      stage_position: item.stage_position,
      parent_epic_id: item.parent_epic_id,
      originating_idea_id: item.originating_idea_id,
      archived: item.archived_at !== null,
      decomposed: item.decomposed_at !== null,
      approved: item.approved_at !== null,
      is_done: item.isDone,
      awaiting_review: item.awaitingReview,
      // Only tasks carry a computed dependency overlay (selectProjectBacklog
      // applies it to type='task' rows only); ideas/epics are never blocked,
      // so an absent overlay defaults to "ready" rather than "unknown".
      ready_to_work: item.readyToWork ?? true,
      blocked_by: (item.blockedBy ?? []).map((dep) => dep.ref),
      version: item.version,
      updated_at: item.updated_at,
    };
  }

  /**
   * Project a full BacklogTaskItem for cyboflow_get_task. A CURATED ALLOW-LIST,
   * not a pass-through: the fields below are the tool's external contract, and a
   * field newly added to `BacklogTaskItem` is absent here until it is added
   * DELIBERATELY. It does include `body`, `blockedBy`/`relatedTo`/`readyToWork`
   * and (for an epic) `children`/`childCount`/`pendingTasks`.
   *
   * Deliberately omitted:
   *  - `inFlow` — an internal live-run overlay with no stable external contract;
   *  - `memberships` (sprint/experiment labels, TASK-190) — a backlog-UI filter
   *    overlay; no flow agent consumes it, and widening an agent-facing payload
   *    is a product decision, not a projection detail.
   */
  private static toFullTask(item: BacklogTaskItem): Record<string, unknown> {
    return {
      id: item.id,
      project_id: item.project_id,
      type: item.type,
      ref: item.ref,
      title: item.title,
      summary: item.summary,
      body: item.body,
      priority: item.priority,
      category: item.category,
      repo: item.repo,
      parent_epic_id: item.parent_epic_id,
      originating_idea_id: item.originating_idea_id,
      scope: item.scope,
      board_id: item.board_id,
      stage_id: item.stage_id,
      archived_at: item.archived_at,
      decomposed_at: item.decomposed_at,
      approved_at: item.approved_at,
      version: item.version,
      stage_position: item.stage_position,
      awaitingReview: item.awaitingReview,
      isDone: item.isDone,
      blockedBy: item.blockedBy,
      relatedTo: item.relatedTo,
      readyToWork: item.readyToWork,
      children: item.children,
      childCount: item.childCount,
      pendingTasks: item.pendingTasks,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  /**
   * Project an idea's image attachments (migration 028) into the MCP read shape
   * for cyboflow_get_task: [{ id, label, mimeType, path }], `path` RESOLVED to
   * an absolute on-disk path — never base64/dataURLs (flow agents fetch bytes
   * themselves via Read). Reuses the EXACT resolution + containment guard the
   * ideas:load-attachments IPC handler applies (main/src/ipc/ideaAttachments.ts)
   * so this read-only surface can never be used to escape the artifacts root:
   * an attachment whose stored path resolves outside CYBOFLOW_DIR/artifacts, or
   * that no longer exists on disk, is silently dropped rather than surfaced.
   */
  private static toMcpAttachments(attachments: IdeaAttachment[]): Array<{
    id: string;
    label: string;
    mimeType: string;
    path: string;
  }> {
    // Common case (an idea with no attachments — and every epic/task, though those
    // never reach here): nothing to resolve or containment-check, so return early
    // WITHOUT touching getCyboflowSubdirectory. Behaviour-preserving (the loop below
    // would yield [] anyway) and it keeps the read path off the CYBOFLOW_DIR
    // resolver for the zero-attachment majority.
    if (attachments.length === 0) return [];
    const artifactsRoot = path.resolve(getCyboflowSubdirectory('artifacts'));
    const result: Array<{ id: string; label: string; mimeType: string; path: string }> = [];
    for (const att of attachments) {
      const resolved = path.resolve(att.path);
      if (resolved !== artifactsRoot && !resolved.startsWith(artifactsRoot + path.sep)) {
        continue;
      }
      if (!existsSync(resolved)) continue;
      result.push({ id: att.id, label: att.name, mimeType: att.type, path: resolved });
    }
    return result;
  }

  /**
   * List the backlog for THIS run's project — read-only, run-bound (no project
   * argument; resolveTaskRunContext derives it from CYBOFLOW_RUN_ID).
   *
   * Reads via selectProjectBacklog (the SAME projection the tasks tRPC router
   * uses), then FLATTENS its one-level tree (top-level items + every epic's
   * `children`) into a single array — the compact shape has no nesting.
   *
   * Filter semantics (applied after flattening):
   *   - archived_at set          -> hidden unless includeArchived.
   *   - isDone===true OR
   *     decomposed_at set        -> hidden unless includeDone (a decomposed
   *                                  idea is retired off the board, which is
   *                                  its own flavor of "done").
   *   - taskType                 -> keep only that entity type.
   * `hidden_count` is the number of items the filters removed (from the flat,
   * pre-filter count) so a caller passing no filters and seeing a smaller list
   * than expected knows to reach for include_archived / include_done.
   */
  private handleListTasks(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-tasks' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const tree = selectProjectBacklog(this.db, ctx.projectId);
    const flat: BacklogTaskItem[] = [];
    for (const item of tree) {
      flat.push(item);
      if (item.type === 'epic' && item.children) {
        flat.push(...item.children);
      }
    }

    const includeArchived = msg.includeArchived ?? false;
    const includeDone = msg.includeDone ?? false;

    const filtered = flat.filter((item) => {
      if (item.archived_at !== null && !includeArchived) return false;
      const isDoneOrRetired = item.isDone === true || item.decomposed_at !== null;
      if (isDoneOrRetired && !includeDone) return false;
      if (msg.taskType !== undefined && item.type !== msg.taskType) return false;
      return true;
    });

    const tasks = filtered.map((item) => McpQueryHandler.toCompactTask(item));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        tasks,
        total: tasks.length,
        hidden_count: flat.length - tasks.length,
      },
    });
  }

  /**
   * Fetch ONE backlog entity with its full body, by opaque id OR display ref
   * (e.g. 'TASK-014') — read-only, project-scoped to THIS run.
   *
   * Resolution order: try selectTaskById(taskId) first (an opaque id wins
   * outright); when that misses, resolve taskId as a display ref scoped to
   * this run's project via resolveBacklogRef, then re-select by the resolved
   * id. Either path that still comes back null, OR resolves to an item whose
   * project_id does not match this run's project, replies 'not_found' — the
   * cross-project case is deliberately indistinguishable from a genuine miss
   * so this tool can never be used to probe another project's backlog.
   */
  private handleGetTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-task' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    let item = selectTaskById(this.db, msg.taskId);
    if (!item) {
      const resolvedId = resolveBacklogRef(this.db, ctx.projectId, msg.taskId);
      if (resolvedId) {
        item = selectTaskById(this.db, resolvedId);
      }
    }

    if (!item || item.project_id !== ctx.projectId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }

    // A/B SANDBOX read scoping (migration 053). A hidden experiment entity must
    // never surface to a by-id/by-ref fetch from outside its OWNING arm — otherwise
    // an arm that learns the sibling arm's id/ref could read (and then, via the
    // write guard's now-arm-scoped denial message, target) the other arm's work.
    // Return it ONLY when this run is the owning arm; else 'not_found', deliberately
    // indistinguishable from a genuine miss so the tool can't probe the sibling
    // sandbox. (list_tasks already hides ALL tagged rows via selectProjectBacklog.)
    if (item.experiment_id !== null) {
      const runCtx = this.runExperimentContext(msg.runId);
      const entityArm = this.entityExperimentArm(item.type, item.id);
      const ownedByThisArm =
        runCtx.experimentId !== null &&
        runCtx.experimentId === item.experiment_id &&
        runCtx.arm !== null &&
        runCtx.arm === entityArm;
      if (!ownedByThisArm) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'not_found',
        });
        return;
      }
    }

    const task = McpQueryHandler.toFullTask(item);
    // Ideas-only (migration 028 / IDEA-006): epics/tasks carry no attachments
    // column at all, so they get no `attachments` key; an idea with none gets
    // the empty array (a stable, documented shape either way).
    if (item.type === 'idea') {
      const attachments = selectIdeaAttachments(this.db, item.id);
      task['attachments'] = McpQueryHandler.toMcpAttachments(attachments);

      // Design Mode v0 (design-mode.md "Idea-bound artifact + read path"): the
      // zero-export handoff's prototype half. The '## Design spec' half is
      // already folded into `item.body` (Approve Step 2), so this is the other
      // half — the current approved prototype snapshot, when one exists. Absent
      // (never approved, or the only approval was superseded with no
      // replacement — which the Approve transaction prevents) omits the key
      // entirely, matching this handler's existing optional-field style.
      const approvedDesign = getCurrentApprovedDesign(this.db, item.id);
      if (approvedDesign) {
        task['approved_design'] = {
          approved_at: approvedDesign.approvedAt,
          draft_revision: approvedDesign.draftRevision,
          prototype_revision: approvedDesign.prototypeRevision,
          // RESOLVED absolute on-disk path (mirrors toMcpAttachments below) so a
          // planner/sprint agent can Read the file directly with no export step.
          // Host-written only (Approve's snapshot step, never agent-supplied),
          // so no containment check is needed here — snapshotBaseDir is already
          // an absolute CYBOFLOW_DIR path (main/src/index.ts).
          snapshot_path: path.resolve(approvedDesign.snapshotPath),
        };
      }

      // Idea component ledger (migration 101 / shared/types/ideaComponents.ts):
      // the hybrid read model, resolved fresh on every get_task rather than
      // trusted from the listing-path overlay so a same-turn stamp is never
      // stale. Always all FIVE components — never omitted for an idea (unlike
      // attachments/approved_design, there is no "component with none" case:
      // resolveIdeaComponents backfills every component via derivation when no
      // ledger row exists). Each entry carries `staleAt`, which is the field a
      // reading agent MUST check, not just `state`: `state: 'incomplete'` alone
      // is ambiguous between "never started" (staleAt: null) and "needs
      // review" (staleAt non-null — prior work exists and should be
      // re-verified against the diff, not redone from scratch). See
      // planner.md's "component ledger" section for how a flow is expected to
      // read and act on this.
      task['components'] = resolveIdeaComponents(this.db, item.id);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { task },
    });
  }

  /**
   * A/B SANDBOX read scoping (migration 053): the (experimentId, arm) THIS run
   * belongs to, or nulls when the run is not an experiment arm. Fail-soft on a
   * pre-048/053 DB (missing columns → nulls). Used only by handleGetTask.
   */
  private runExperimentContext(runId: string): { experimentId: string | null; arm: ExperimentArm | null } {
    try {
      const row = this.db
        .prepare('SELECT experiment_id AS experimentId, experiment_arm AS arm FROM workflow_runs WHERE id = ?')
        .get(runId) as { experimentId?: unknown; arm?: unknown } | undefined;
      const experimentId =
        typeof row?.experimentId === 'string' && row.experimentId.length > 0 ? row.experimentId : null;
      const arm = row?.arm;
      return { experimentId, arm: arm === 'A' || arm === 'B' ? arm : null };
    } catch {
      return { experimentId: null, arm: null };
    }
  }

  /** The experiment_arm tag on one entity row (migration 053), or null. Fail-soft. */
  private entityExperimentArm(type: TaskType, id: string): ExperimentArm | null {
    const table = type === 'idea' ? 'ideas' : type === 'epic' ? 'epics' : 'tasks';
    try {
      const row = this.db.prepare(`SELECT experiment_arm AS arm FROM ${table} WHERE id = ?`).get(id) as
        | { arm?: unknown }
        | undefined;
      const arm = row?.arm;
      return arm === 'A' || arm === 'B' ? arm : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Sprint lane write (cyboflow_update_sprint_task)
  //
  // Per-task progress for the SINGLE session-hosted sprint run: the sprint
  // orchestrator agent reports each task's lane status / current step, which
  // routes through the SprintLaneStore chokepoint (NOT TaskChangeRouter —
  // sprint_batch_tasks is a non-entity table; see migration 022's header).
  // The write is keyed by the calling run's workflow_runs.batch_id, stamped at
  // launch by RunLauncher; a run without a batch (quick session, planner, a
  // sprint launched without seed tasks) is rejected.
  // --------------------------------------------------------------------------

  /**
   * Update one sprint lane's status and/or current step.
   *
   * Guards: resolveTaskRunContext (sentinel / missing / terminal run — reused
   * for parity with the other task-scoped writes), then the run row must carry
   * a non-null batch_id ('sprint_lane_requires_batch_run'). Lane-level
   * validation (step vocabulary, status domain, at-least-one-field, unknown
   * lane) is enforced INSIDE SprintLaneStore.updateLane and surfaces here as
   * SprintLaneError.code (bad_request | lane_not_found) — DESIGNED rejections,
   * mapped by writeSprintLaneError (mirrors writeTaskChangeError).
   */
  private handleUpdateSprintTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-sprint-task' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // The lane substrate is keyed by the run's batch (workflow_runs.batch_id,
    // migration 022 — stamped by RunLauncher when the sprint launches with
    // seed tasks). Read defensively: a NULL/absent batch is a designed reject.
    const runRow = this.db
      .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
      .get(msg.runId) as { batchId?: unknown } | undefined;
    const batchId = typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
    if (!batchId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'sprint_lane_requires_batch_run',
      });
      return;
    }

    // Orchestrated-plane mirror of the programmatic plane's driveLane threading
    // (programmatic/workflowController.ts runFanOut: allowedStepIds = inner ids,
    // widened with AWAITING_VERIFY_STEP for the merge-gate park step). Resolve the
    // CALLING run's chain-derived vocabulary instead of validating against the
    // fixed SPRINT_LANE_STEP_IDS default. Fail-soft: an unresolvable run/definition
    // or a definition with no fanOut step yields `undefined`, so
    // SprintLaneStore.updateLane degrades to today's canonical default — never
    // fail-closed.
    const inner = resolveRunFanOutInner(this.db, msg.runId);
    const allowedStepIds = inner ? [...inner.map((s) => s.id), AWAITING_VERIFY_STEP] : undefined;

    try {
      const lane = SprintLaneStore.getInstance().updateLane({
        runId: msg.runId,
        batchId,
        taskId: msg.taskId,
        ...(msg.status !== undefined ? { status: msg.status } : {}),
        ...(msg.currentStepId !== undefined ? { currentStepId: msg.currentStepId } : {}),
        ...(msg.attempt !== undefined ? { attempt: msg.attempt } : {}),
        ...(allowedStepIds !== undefined ? { allowedStepIds } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          batch_id: lane.batchId,
          task_id: lane.taskId,
          status: lane.status,
          current_step_id: lane.currentStepId,
          attempts: lane.attempts,
          ref: lane.ref,
          title: lane.title,
          updated_at: lane.updatedAt,
        },
      });
    } catch (err) {
      this.writeSprintLaneError(client, msg.requestId, err);
    }
  }

  /**
   * Surface a lane-store failure as an ok:false response. A SprintLaneError
   * maps to its discriminated .code (mirrors writeTaskChangeError); anything
   * else is logged and collapsed to the opaque 'sprint_lane_failed'.
   */
  private writeSprintLaneError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof SprintLaneError) {
      // A createForRun 'no_eligible_tasks' (candidates exist but all failed the
      // eligibility guard) surfaces as the SAME ship-facing code the empty-set path
      // uses, so the ship agent gets one actionable signal. The WHY detail rides in
      // err.message (logged here — the wire response carries only the code string).
      if (err.code === 'no_eligible_tasks') {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch: no eligible tasks', {
          detail: err.message,
        });
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId,
          ok: false,
          error: 'ship_no_tasks_to_materialize',
        });
        return;
      }
      // createForRun's OWN batch-cap enforcement (Item 7) — the handler's step-5
      // pre-check above already returns this same 'ship_batch_too_large' code for
      // the common case, so this branch only fires when something changed the
      // eligible count BETWEEN that pre-check and the transaction (e.g. a
      // concurrent eligibility change) and the store's cap is what actually
      // caught it. Same wire code either way — callers see ONE signal.
      if (err.code === 'batch_too_large') {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch: batch too large', {
          detail: err.message,
        });
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId,
          ok: false,
          error: 'ship_batch_too_large',
        });
        return;
      }
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] sprint lane update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'sprint_lane_failed',
    });
  }

  // --------------------------------------------------------------------------
  // Mid-run sprint-batch materialization (cyboflow_create_sprint_batch)
  //
  // The HANDOFF SEAM for the 'ship' workflow: planner decomposition flows
  // directly into sprint execution in ONE continuous run. At the
  // 'materialize-batch' step the orchestrator calls this tool with the
  // human-approved task subset (from the approve-plan gate); the handler mints
  // the sprint batch + per-task lanes and stamps workflow_runs.batch_id MID-RUN
  // (RunLauncher only stamps it at launch for a seed-task sprint). Once batch_id
  // is non-null, the per-lane cyboflow_update_sprint_task writes succeed
  // (handleUpdateSprintTask reads batch_id live) and the swimlane canvas renders
  // (CyboflowRoot keys off activeRun.batch_id).
  //
  // IDEMPOTENT + transactional: a crash/resume re-call must not orphan a second
  // batch or reset lane status. Steps 2-7 (idempotency read → subset resolve →
  // empty/cap guards → createForRun → compare-and-set stamp) run in ONE
  // better-sqlite3 transaction; createForRun mints its own nested transaction
  // (savepoint), which composes safely.
  // --------------------------------------------------------------------------

  /**
   * Mint the sprint batch + lanes from the run's approved tasks and stamp
   * workflow_runs.batch_id, once.
   *
   * Guards (in order):
   *   1. resolveTaskRunContext — sentinel / missing / terminal run reject
   *      (parity with the other run-bound writes).
   *   2. IDEMPOTENCY — a run whose batch_id is already set returns
   *      { ok:true, batch_id, created:false } WITHOUT re-minting.
   *   3. SUBSET — the passed taskIds intersected with listRunCreatedTaskIds
   *      (ids the run did not create are dropped); the full created set when no
   *      subset is passed.
   *   4. EMPTY — no resolvable tasks → ok:false 'ship_no_tasks_to_materialize'.
   *   5. CAP backstop — more tasks than the effective per-substrate cap
   *      (resolveSprintMaxTasks over the user's Settings override) →
   *      ok:false 'ship_batch_too_large' (the human gate is the primary control).
   *   6. createForRun(projectId, substrate, taskIds) → { batchId }.
   *   7. COMPARE-AND-SET — UPDATE workflow_runs SET batch_id WHERE id AND
   *      batch_id IS NULL (a concurrent stamp loses, never double-mints).
   * On success emits a run-status-changed signal so activeRunsStore re-fetches
   * runs.list (now carrying batch_id) and the swimlane canvas mounts.
   */
  private handleCreateSprintBatch(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-sprint-batch' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // Resolve the run's substrate (cap is substrate-keyed). Read defensively —
    // a pre-migration-013 DB lacking the column degrades to the 'sdk' default.
    let substrate: CliSubstrate = 'sdk';
    try {
      const subRow = this.db
        .prepare('SELECT substrate FROM workflow_runs WHERE id = ?')
        .get(msg.runId) as { substrate?: unknown } | undefined;
      if (subRow?.substrate === 'interactive') {
        substrate = 'interactive';
      }
    } catch {
      // Pre-migration-013 DB (no substrate column) — keep the 'sdk' default.
    }

    type Outcome =
      | { ok: true; batchId: string; created: boolean }
      | { ok: false; error: string };

    let outcome: Outcome;
    try {
      // Steps 2-7 in ONE transaction so a re-call cannot orphan a batch or
      // reset lane status. createForRun mints a nested savepoint internally.
      const txn = this.db.transaction((): Outcome => {
        // 2. IDEMPOTENCY — already materialized → no re-mint.
        const runRow = this.db
          .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
          .get(msg.runId) as { batchId?: unknown } | undefined;
        const existingBatchId =
          typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
        if (existingBatchId) {
          return { ok: true, batchId: existingBatchId, created: false };
        }

        // 3. SUBSET — intersect the passed ids with the run's created tasks (drop
        // any id the run did not create); fall back to the full created set. The
        // agent may pass DISPLAY REFS (e.g. 'TASK-034'), which never equal the opaque
        // 'tsk_' ids in the created set — so resolve each passed handle ref-or-id →
        // opaque id BEFORE the intersection (parity with add_task_dependency /
        // update_sprint_task ref resolution via resolveBacklogRef). An opaque id that
        // is already in the created set is kept as-is; anything else is resolved as a
        // display ref (project-scoped) and re-tested, so a real ref matches and a
        // bogus handle still drops out.
        const createdTaskIds = listRunCreatedTaskIds(this.db, msg.runId);
        let taskIds: string[];
        if (msg.taskIds && msg.taskIds.length > 0) {
          const createdSet = new Set(createdTaskIds);
          const resolved = [...new Set(msg.taskIds)].map((handle) =>
            createdSet.has(handle) ? handle : (resolveBacklogRef(this.db, ctx.projectId, handle) ?? handle),
          );
          taskIds = resolved.filter((id) => createdSet.has(id));
        } else {
          taskIds = createdTaskIds;
        }

        // 4. EMPTY guard.
        if (taskIds.length === 0) {
          return { ok: false, error: 'ship_no_tasks_to_materialize' };
        }

        // 5. CAP backstop (defense — the human gate is the primary control).
        if (taskIds.length > resolveSprintMaxTasks(this.deps.getSprintMaxTasks?.(), substrate)) {
          return { ok: false, error: 'ship_batch_too_large' };
        }

        // 6. Mint the batch + lanes via the SprintLaneStore chokepoint.
        const { batchId } = SprintLaneStore.getInstance().createForRun(ctx.projectId, substrate, taskIds);

        // 7. COMPARE-AND-SET the stamp (only when still NULL).
        this.db
          .prepare(
            'UPDATE workflow_runs SET batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND batch_id IS NULL',
          )
          .run(batchId, msg.runId);

        return { ok: true, batchId, created: true };
      });
      outcome = (txn as () => Outcome)();
    } catch (err) {
      this.writeSprintLaneError(client, msg.requestId, err);
      return;
    }

    if (!outcome.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: outcome.error,
      });
      return;
    }

    // Move the materialized batch's tasks to 'In development' (migration 066):
    // capture entry stage + derive execution stage per lane. Idempotent, so both
    // the created:true and idempotent created:false paths recompute. Fire-and-
    // forget + best-effort — a task-side failure (or an uninitialized router) must
    // never invalidate the committed batch or block the synchronous response.
    try {
      void TaskChangeRouter.getInstance()
        .recomputeTasksForBatch(outcome.batchId)
        .catch((err: unknown) => {
          this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch task-stage derivation failed', {
            runId: msg.runId,
            batchId: outcome.batchId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err: unknown) {
      this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch task-stage derivation unavailable', {
        runId: msg.runId,
        batchId: outcome.batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 8. Emit a run-row-changed signal so activeRunsStore re-fetches runs.list
    // (now carrying batch_id) and the swimlane canvas mounts. The run stays
    // active; we re-assert its 'running' status. Best-effort — never let an
    // emit failure invalidate the committed batch.
    if (outcome.created) {
      try {
        runStatusEvents.emit('changed', {
          runId: msg.runId,
          status: 'running',
        } satisfies RunStatusChangedEvent);
      } catch (emitErr) {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch run-status emit failed', {
          runId: msg.runId,
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        });
      }

      // Retire the run's owned idea(s) to the Decomposed terminal stage. Ship has
      // no planner-style human Archive gate (its terminal `decompose` step is
      // dropped), so without this a shipped idea lingers forever in its planning
      // stage even though its tasks now carry the flow. Fired here — AFTER the
      // human-approved plan is materialized into sprint lanes — and fire-and-forget
      // + best-effort: a failure must never invalidate the committed batch or block
      // the synchronous response below.
      void this.retireRunOwnedIdeas(ctx.projectId, msg.runId);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { batch_id: outcome.batchId, created: outcome.created },
    });
  }

  /**
   * Retire every idea the run actually DECOMPOSED (via listRunDecomposedIdeaIds —
   * an owned idea with >=1 run-created child carrying its originating_idea_id
   * lineage; a seeded-but-childless idea in a multi-idea run is left on the board)
   * to the Decomposed terminal stage. The ship handoff seam's follow-on — see
   * handleCreateSprintBatch. Best-effort: each retire is idempotent (a no-op when
   * the idea is already at Decomposed) and individually guarded so one failure
   * can't starve the rest, and the whole pass is swallowed so it can never
   * invalidate the already-committed batch.
   */
  private async retireRunOwnedIdeas(projectId: number, runId: string): Promise<void> {
    try {
      const router = TaskChangeRouter.getInstance();
      for (const ideaId of listRunDecomposedIdeaIds(this.db, runId)) {
        await router.retireIdeaToDecomposed(projectId, ideaId).catch(() => {
          /* per-idea best-effort */
        });
      }
    } catch {
      /* best-effort housekeeping — never disturb the committed batch */
    }
  }

  // --------------------------------------------------------------------------
  // Review-item write (cyboflow_report_finding)
  //
  // Findings (and decisions / human_tasks) emitted by Sprint agents route
  // through the SINGLE review-queue chokepoint ReviewItemRouter.applyReviewItem —
  // they NEVER INSERT review_items directly. The item is NON-BLOCKING by default
  // (a finding never pauses the run): the handler validates the run context +
  // payload SYNCHRONOUSLY (so a bad request surfaces immediately), then enqueues
  // the create and writes the ok:true response WITHOUT awaiting the per-project
  // queue — the agent's run continues regardless of inbox contention. The soft
  // entity-link and per-kind-payload-discriminant validations are enforced INSIDE
  // applyReviewItem and surface as ReviewItemError.code via writeReviewItemError.
  // --------------------------------------------------------------------------

  /**
   * Resolve the calling run into the project scope + agent actor needed to create
   * a review item. Mirrors resolveTaskRunContext exactly:
   *   - the 'orchestrator' sentinel runId has no workflow_runs row → reject
   *     before any DB touch (finding_requires_real_run);
   *   - a missing run row → run_not_found;
   *   - a terminal run (completed | failed | canceled) must not write findings →
   *     run_not_active.
   * Actor derivation mirrors TaskChangeRouter.resolveAgentLabel
   * (agent:<snapshot[step] | step | 'unknown'>).
   *
   * The returned actor is typed as the narrower `` `agent:${string}` `` (NOT the
   * full ReviewActor union it is a subtype of) because the body below only ever
   * constructs `agent:${label}` — a review item minted through THIS run-context
   * seam is always agent-authored, never 'user', 'linear', or 'plane' (a tracker
   * sync writes through TaskChangeRouter/ReviewItemRouter directly with its own
   * provider actor, not through a workflow run's step context). Declaring the
   * true, narrower return type lets callers that need an even narrower actor
   * type (e.g. ArtifactActor) assign `ctx.actor` directly with no coercion.
   */
  /**
   * READ-ONLY sibling of {@link resolveReviewItemRunContext}: resolves the
   * project without the terminal-run refusal.
   *
   * The `run_not_active` gate exists to stop a settled run WRITING — a finding
   * filed or resolved after the human's gate closed lands where nobody looks.
   * Applying it to a READ was collateral damage, and it lands squarely on the
   * case that matters: the code-review eval fires at SETTLE (terminalEvalSubscriber
   * grades on awaiting_review|completed), so by the time its verdict exists the
   * run it graded is frequently already `completed` — and the human's very next
   * move is to open a chat and say "fix what the eval found". That ask was
   * refused outright, on a run whose findings were sitting in the table.
   *
   * A read cannot corrupt a settled run, so the only checks kept are the two that
   * say the request is meaningless: the 'orchestrator' sentinel (no run row at
   * all) and an unknown id. Writes keep the full guard — see
   * {@link resolveTargetInScope} for how a chat still resolves a settled sibling
   * run's finding without reviving that run.
   */
  private resolveReadOnlyRunContext(
    runId: string,
  ): { ok: true; projectId: number } | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'finding_requires_real_run' };
    }
    const row = this.db
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(runId) as { projectId?: unknown } | undefined;
    if (!row) {
      return { ok: false, error: 'run_not_found' };
    }
    const projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
    if (!Number.isFinite(projectId)) {
      return { ok: false, error: 'run_not_found' };
    }
    return { ok: true, projectId };
  }

  private resolveReviewItemRunContext(
    runId: string,
  ): { ok: true; projectId: number; actor: `agent:${string}` } | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'finding_requires_real_run' };
    }

    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, status, current_step_id AS currentStepId,
                steps_snapshot_json AS stepsSnapshotJson
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | {
          projectId?: unknown;
          status?: unknown;
          currentStepId?: unknown;
          stepsSnapshotJson?: unknown;
        }
      | undefined;

    if (!row) {
      return { ok: false, error: 'run_not_found' };
    }

    const status = typeof row.status === 'string' ? row.status : '';
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      return { ok: false, error: 'run_not_active' };
    }

    const projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
    const currentStepId = typeof row.currentStepId === 'string' ? row.currentStepId : null;
    const stepsSnapshotJson = typeof row.stepsSnapshotJson === 'string' ? row.stepsSnapshotJson : null;

    let label = 'unknown';
    if (currentStepId && stepsSnapshotJson) {
      try {
        const snapshot = JSON.parse(stepsSnapshotJson) as Record<string, unknown>;
        const agent = snapshot[currentStepId];
        if (typeof agent === 'string' && agent.length > 0) {
          label = resolveStepAgentKey(currentStepId, agent) ?? agent;
        } else {
          label = currentStepId;
        }
      } catch {
        label = currentStepId;
      }
    } else if (currentStepId) {
      label = currentStepId;
    }

    const actor: `agent:${string}` = `agent:${label}`;
    return { ok: true, projectId, actor };
  }

  /**
   * Report a finding/decision/human_task into the unified review queue.
   *
   * NON-BLOCKING contract: the run is never paused on the inbox. This handler
   * validates the run context AND parses/validates payload_json SYNCHRONOUSLY
   * (so a bad request fails fast), then fires ReviewItemRouter.applyReviewItem
   * and writes the ok:true response IMMEDIATELY — it does NOT await the
   * per-project queue. A late chokepoint rejection (e.g. invalid_entity from the
   * soft-link guard) is logged but cannot retroactively block the already-replied
   * run; the synchronous validations below catch the common misuse before reply.
   */
  private handleReportFinding(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-finding' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // 'notification' is orchestrator-minted only (agents cannot file one), so the
    // MCP report_finding tool excludes it alongside 'permission'.
    const kind: Exclude<ReviewItemKind, 'permission' | 'notification'> = msg.kind ?? 'finding';

    // Soft entity-link guard (both set together or both omitted) — surfaced
    // synchronously through writeReviewItemError so the caller gets the SAME
    // 'invalid_entity' code the chokepoint would have thrown, but BEFORE we reply
    // ok:true (the non-blocking create cannot un-reply the run after the fact).
    if ((msg.entityType === undefined) !== (msg.entityId === undefined)) {
      this.writeReviewItemError(
        client,
        msg.requestId,
        new ReviewItemError('invalid_entity', 'entityType and entityId must be set together or both omitted'),
      );
      return;
    }

    // Parse + validate the per-kind payload BEFORE the async create. The
    // discriminant must equal `kind` (the same check the chokepoint runs); doing
    // it here keeps the malformed-payload rejection synchronous.
    let payload: ReviewItemPayload | null = null;
    if (msg.payloadJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.payloadJson);
      } catch {
        this.writeReviewItemError(
          client,
          msg.requestId,
          new ReviewItemError('invalid_payload', 'payload_json is not valid JSON'),
        );
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { kind?: unknown }).kind !== kind
      ) {
        this.writeReviewItemError(
          client,
          msg.requestId,
          new ReviewItemError('invalid_payload', `payload.kind does not match item kind '${kind}'`),
        );
        return;
      }
      payload = parsed as ReviewItemPayload;
    }

    // Fold the structured finding extras (category / locations / suggestedFix /
    // impact) into the FindingPayload. These arrive UNVALIDATED from the MCP tool
    // (typed `unknown`); each shape is guarded and a malformed member is DROPPED
    // rather than erroring — an agent typo must never fail a non-blocking finding
    // write. Extras only apply to kind='finding'; for other kinds they are ignored.
    // An explicit payloadJson (parsed above) is the base; extras override per-field.
    if (kind === 'finding') {
      const extras = buildFindingExtras(msg);
      if (Object.keys(extras).length > 0) {
        const base: FindingPayload =
          payload !== null && payload.kind === 'finding' ? payload : { kind: 'finding' };
        payload = { ...base, ...extras };
      }
    }

    const create: ReviewItemCreate = {
      op: 'create',
      actor: ctx.actor,
      kind,
      title: msg.title,
      body: msg.body,
      blocking: msg.blocking ?? false,
      severity: msg.severity ?? null,
      source: ctx.actor,
      entityType: msg.entityType ?? null,
      entityId: msg.entityId ?? null,
      runId: msg.runId,
      payload,
    };

    // Fire-and-forget: the run is NEVER gated on the inbox. A late failure is
    // logged (it cannot un-reply the run), but the synchronous validations above
    // already caught the common misuse, so this path is for genuine DB faults.
    void ReviewItemRouter.getInstance()
      .applyReviewItem(ctx.projectId, create)
      .catch((err) => {
        this.logger?.error('[Cyboflow MCP Query] review-item create failed (non-blocking)', {
          runId: msg.runId,
          error: err instanceof ReviewItemError ? err.code : err instanceof Error ? err.message : String(err),
        });
      });

    // Reply IMMEDIATELY — do not await the queue.
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { accepted: true, kind, blocking: msg.blocking ?? false },
    });
  }

  // --------------------------------------------------------------------------
  // Compound-run findings (cyboflow_get_selected_findings / _resolve_finding)
  //
  // The triage tray seeds a compound run with the EXACT findings the human
  // selected (workflow_runs.seed_finding_ids, migration 034). These two handlers
  // let the seeded compound agent re-read that set and resolve each finding as it
  // acts on it. get-selected-findings is READ-ONLY; resolve-finding routes the
  // resolve through the SINGLE review-item chokepoint and is AWAITED (so a failed
  // resolve surfaces — diverging from the fire-and-forget report-finding path).
  // Both reuse the run-context guard, so they are callable only mid-run
  // (resolveReviewItemRunContext rejects terminal runs with run_not_active).
  // --------------------------------------------------------------------------

  /**
   * Return the findings the human seeded into THIS compound run, read from
   * workflow_runs.seed_finding_ids and shaped via selectFindingForSeed. Read-only
   * — never writes. Replies { findings: [] } when the column is null/unparseable
   * or no id resolves to a finding (a fail-soft empty set, not an error).
   */
  private handleGetSelectedFindings(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-selected-findings' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const runRow = this.db
      .prepare('SELECT seed_finding_ids AS seedFindingIds FROM workflow_runs WHERE id = ?')
      .get(msg.runId) as { seedFindingIds?: unknown } | undefined;
    const seedJson =
      typeof runRow?.seedFindingIds === 'string' && runRow.seedFindingIds.length > 0
        ? runRow.seedFindingIds
        : null;

    let ids: string[] = [];
    if (seedJson) {
      try {
        const parsed: unknown = JSON.parse(seedJson);
        if (Array.isArray(parsed)) {
          ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
      } catch {
        // Unparseable seed → fail-soft empty set (no error to the agent).
        ids = [];
      }
    }

    const findings = ids
      .map((id) => selectFindingForSeed(this.db, id))
      .filter((f): f is NonNullable<typeof f> => f !== null);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { findings },
    });
  }

  /**
   * Return the code-review eval's FULL verdict for a run in this session — the
   * score, band, CI, per-dimension breakdown, cap triggers, the sub-checks the
   * jury failed with its evidence, and every finding it raised cross-linked to
   * its review item.
   *
   * WHY IT EXISTS. The verdict lives in `run_evals`, and nothing in the run
   * tool scope read that table. What reached an agent instead was a filtered
   * slice via `review_items`: net-new or majority-catastrophic findings only,
   * deduped, advisory-capped at ten — and no score at all, because the one
   * summary item carrying the rollup is written only for `origin = 'adhoc'`,
   * which an automatic or A/B-tagged flow eval never is. So an agent asked to
   * fix what the eval flagged could see at most ten of the findings and never
   * the verdict, and had no way to discover that the rest existed.
   *
   * SCOPE. `targetRunId` is optional and usually omitted: a chat turn's own run
   * id is a `__quick__` sentinel that was never graded, so the default walks the
   * session's runs ({@link selectSessionRunScope}) and returns the first graded
   * one. Named explicitly, the target must belong to the caller's PROJECT —
   * a tighter check than the sibling `mcp-get-run`, which reads any run row by
   * id, and the right one here because this payload carries review content.
   *
   * NOT gated on a live run, by design: the eval fires AT settle, so the run it
   * graded is usually already terminal by the time anyone can ask about it.
   * Read-only throughout — no router, no write.
   */
  private handleGetEval(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-eval' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReadOnlyRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    if (msg.targetRunId !== undefined) {
      const target = this.resolveReadOnlyRunContext(msg.targetRunId);
      if (!target.ok) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: target.error,
        });
        return;
      }
      if (target.projectId !== ctx.projectId) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'run_not_in_project',
        });
        return;
      }
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          runScope: [msg.targetRunId],
          evaluation: selectEvalReadout(this.db, msg.targetRunId),
        },
      });
      return;
    }

    // Default: the first GRADED run in this session's scope. Scope order puts
    // the caller's own run first and then walks the session chronologically, so
    // a chat sentinel (never graded) falls through to the flow run behind it.
    const runScope = selectSessionRunScope(this.db, msg.runId);
    let evaluation = null;
    for (const candidate of runScope) {
      evaluation = selectEvalReadout(this.db, candidate);
      if (evaluation !== null) break;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { runScope, evaluation },
    });
  }

  /**
   * Return the still-open findings THIS run filed itself, each carrying the
   * `review_items.id` that `cyboflow_resolve_finding` needs. Read-only.
   *
   * This is the READ half of the report→act→resolve loop for a run acting on its
   * OWN findings (the sprint/ship `address-review` step). `report_finding` is
   * fire-and-forget by design — it never returns the minted id — so an agent
   * cannot resolve what it filed from memory alone. Reading back from the DB is
   * also the truer set: it spans every lane's `code-review` pass plus
   * `sprint-review` and the eval jury, including findings filed by a subagent
   * chain whose context is long gone.
   *
   * SCOPED TO THE SESSION'S RUNS, not to `msg.runId` alone. A flow step's run id
   * is its own, so nothing changes there; a CHAT turn's run id is the session's
   * `__quick__` sentinel, which by construction filed nothing, so the unwidened
   * read replied `{ findings: [] }` to every "go fix this run's findings" ask and
   * gave the agent no way to tell that empty apart from a genuinely clean run.
   * See selectSessionRunScope for the link and its fail-soft narrowing.
   *
   * READABLE AFTER SETTLE, unlike get-selected-findings / resolve-finding: it
   * takes the read-only run context, which drops the `run_not_active` refusal.
   * The eval fires AT settle, so gating this read on a live run refused exactly
   * the "the run finished, now go fix what review found" ask it exists to serve.
   * The write path keeps the full guard.
   *
   * AWAITED, unlike its read-only sibling get-selected-findings: this read must
   * observe the run's OWN prior `report_finding` writes, and those are enqueued
   * on the ReviewItemRouter's per-project queue and replied to BEFORE they
   * commit. Selecting straight from the table races them — the findings most
   * likely to still be in flight are the ones sprint-review filed moments ago,
   * i.e. exactly the ones this read exists to return. Draining the queue first
   * costs nothing on the common path (an idle queue resolves immediately) and
   * turns a silent under-read into a correct one.
   */
  private async handleListRunFindings(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-run-findings' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReadOnlyRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    await ReviewItemRouter.getInstance().awaitProjectWritesSettled(ctx.projectId);

    // SESSION scope, not this one run id. In a flow step the two are the same
    // set; in a CHAT turn they are never the same, because chatSentinelProvider
    // binds the turn to the session's `__quick__` sentinel — a run that filed
    // nothing — while the findings sit on the flow run the same session owns.
    // `runScope` rides along in the reply so the agent can see what was covered
    // rather than infer it from an empty list.
    const runScope = selectSessionRunScope(this.db, msg.runId);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { findings: selectRunFindingsForRuns(this.db, runScope), runScope },
    });
  }

  /**
   * Resolve a finding the compound run consumed. Builds the resolution string
   * from resolutionKind using the SHARED prefix consts (never hand-typed, so the
   * parseResolutionKind convention cannot drift), routes the resolve through the
   * ReviewItemRouter chokepoint, and AWAITs it — a failed resolve must surface to
   * the agent rather than silently leave the finding pending.
   *
   * Mid-run-only: resolveReviewItemRunContext returns run_not_active for a
   * terminal run, so the agent must call this immediately after each finding's
   * action lands (NOT batched at run end); the RunExecutor terminal-seam close-out
   * is the safety net for whatever was missed.
   *
   * SCOPE-GUARDED (see resolveTargetInScope): the router validates only
   * (projectId, status='pending'), so without this check a single mistyped or
   * hallucinated id would silently close ANY pending item in the project — an
   * unrelated run's finding, a `decision` gate row, a `human_task`. That was
   * tolerable while `resolve_finding` was a rare compound-only call; the
   * sprint/ship address-review step now calls it N times per run with ids the
   * model transcribed from a list, so the blast radius is no longer theoretical.
   */
  /**
   * Guard `resolve_finding`'s target: it must be a `kind='finding'` row that
   * THIS run is entitled to close. Three disjoint entitlements, matching the
   * tool's legitimate callers:
   *
   *  - the run FILED it (`run_id = runId`) — sprint/ship's address-review closing
   *    out its own code-review findings;
   *  - the run was SEEDED with it (`workflow_runs.seed_finding_ids`) — a compound
   *    run acting on findings a human selected, which by definition belong to
   *    EARLIER runs. This arm is why an ownership check cannot simply be
   *    `run_id = runId`: that would break compound entirely; or
   *  - a run in the caller's OWN SESSION filed it — a chat turn closing out the
   *    findings of the flow run it is sitting on top of. Without this arm the
   *    widened read is half a loop: the agent can now SEE the flow run's
   *    findings, fix them, and then be refused `finding_not_in_run_scope` on
   *    every single resolve, because a chat's run id is the `__quick__` sentinel
   *    and never the run that filed them.
   *
   * The third arm deliberately does NOT relax the CALLER's liveness check in
   * {@link handleResolveFinding}: the caller is the sentinel, which
   * chatSentinelProvider revives to 'running' for the turn, so a chat resolves a
   * settled sibling run's finding without that run being revived or written to.
   * Session membership is the entitlement, session-mate liveness is not.
   *
   * Anything else — another run's finding, a `decision` gate, a `human_task`, a
   * missing id — is refused rather than silently closed. Read-only; the actual
   * status transition stays the router's job.
   */
  private resolveTargetInScope(
    runId: string,
    reviewItemId: string,
  ): { ok: true } | { ok: false; error: string } {
    const row = this.db
      .prepare(`SELECT kind, run_id AS runId FROM review_items WHERE id = ?`)
      .get(reviewItemId) as { kind?: string; runId?: string | null } | undefined;

    // Keep the router's existing 'not_found' code for a missing id — agents and
    // tests already key on it; only the NEW refusals get new codes.
    if (row === undefined) return { ok: false, error: 'not_found' };
    if (row.kind !== 'finding') return { ok: false, error: 'not_a_finding' };
    if (row.runId === runId) return { ok: true };

    // Same-session arm. Checked before the seed arm because it is the common
    // case for a chat turn and needs no JSON parse.
    if (
      typeof row.runId === 'string' &&
      row.runId.length > 0 &&
      selectSessionRunScope(this.db, runId).includes(row.runId)
    ) {
      return { ok: true };
    }

    // Seeded arm: the compound path. Unparseable / absent seed json ⇒ no
    // entitlement (fail closed), mirroring handleGetSelectedFindings' fail-soft
    // read but in the refusing direction, since this one is a WRITE.
    const runRow = this.db
      .prepare('SELECT seed_finding_ids AS seedFindingIds FROM workflow_runs WHERE id = ?')
      .get(runId) as { seedFindingIds?: unknown } | undefined;
    const seedJson =
      typeof runRow?.seedFindingIds === 'string' && runRow.seedFindingIds.length > 0
        ? runRow.seedFindingIds
        : null;
    if (seedJson !== null) {
      try {
        const parsed: unknown = JSON.parse(seedJson);
        if (Array.isArray(parsed) && parsed.includes(reviewItemId)) return { ok: true };
      } catch {
        // fall through to refusal
      }
    }
    return { ok: false, error: 'finding_not_in_run_scope' };
  }

  private async handleResolveFinding(
    msg: Extract<McpQueryMessage, { type: 'mcp-resolve-finding' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const scope = this.resolveTargetInScope(msg.runId, msg.reviewItemId);
    if (!scope.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: scope.error,
      });
      return;
    }

    // Build the resolution from the matching prefix const. 'promoted' carries the
    // minted task id (mirrors the promote-to-task path); 'fixed'/'triaged' carry
    // the optional free-text note (e.g. 'compound') when present.
    let resolution: string;
    if (msg.resolutionKind === 'promoted') {
      const tail = msg.taskId ?? msg.note ?? '';
      resolution = `${RESOLUTION_PREFIX_PROMOTED}${tail}`;
    } else if (msg.resolutionKind === 'fixed') {
      resolution = `${RESOLUTION_PREFIX_FIXED}${msg.note ?? ''}`;
    } else {
      resolution = `${RESOLUTION_PREFIX_TRIAGED}${msg.note ?? ''}`;
    }

    const triage: ReviewItemTriage = {
      op: 'resolve',
      actor: ctx.actor,
      reviewItemId: msg.reviewItemId,
      resolution,
      runId: msg.runId,
    };

    try {
      // AWAIT — a failed resolve must surface (diverges from fire-and-forget
      // report-finding so the agent can retry rather than silently move on).
      await ReviewItemRouter.getInstance().applyReviewItem(ctx.projectId, triage);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { resolved: true, review_item_id: msg.reviewItemId },
      });
    } catch (err) {
      this.writeReviewItemError(client, msg.requestId, err);
    }
  }

  /**
   * Create (or idempotently re-derive) a run artifact via the ArtifactRouter
   * chokepoint. Unlike report-finding this AWAITS the write so it can reply with
   * the artifact id (the agent needs it to enrich/commit later). The project +
   * actor are resolved from the run; the artifact is minted isNew so its tab
   * pulses until focused.
   */
  private async handleReportArtifact(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-artifact' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    // ctx.actor is `agent:${string}` (see resolveReviewItemRunContext) — a
    // strict subtype of ArtifactActor, so no 'linear'/'plane' coercion is
    // needed here: a review-item run-context actor is always agent-authored.
    const actor: ArtifactActor = ctx.actor;
    // Design Mode v0 (design-mode.md "Idea-bound artifact + read path"): stamp
    // source_ref AND session_id SERVER-SIDE from the session's validated
    // design_idea_id (NEVER from the agent payload) — source_ref makes the
    // prototype discoverable by its idea downstream (planner/sprint), session_id
    // is what the canvas's DesignApproveControl render gate + tRPC calls key on.
    // A non-design session (or a run without a session) resolves null → neither
    // field is set and behavior is unchanged.
    const designStamp = this.resolveSessionDesignStamp(msg.runId);
    try {
      // Content-blesser (IDEA-039 / Approach C), driven by the atype's
      // `blessing` policy in the artifact registry — the SOLE authority on
      // prototype/canvas payload content:
      //   - 'prototype-file' (ui-prototype AND interactive-prototype): REJECT any
      //     inline top-level `html` key (a mockup is an on-disk file, never inline
      //     bytes), validate the on-disk static document, and MINT the canonical
      //     `{ fileName: 'prototype/index.html' }` pointer — discarding whatever
      //     path/payload the producing agent claimed;
      //   - 'html-reject-only' (generic): reject inline `html`, otherwise pass the
      //     `{ url }` payload through unchanged;
      //   - 'none': no blessing (every templated atype).
      // An atype MISSING from the registry fails LOUDLY here (design-mode.md
      // acceptance) rather than slipping past to a byte-free commit. The run
      // artifacts dir is derived from the TRUSTED runId — CYBOFLOW_RUN_ARTIFACTS_DIR
      // is never read here.
      const policy = ARTIFACT_POLICIES[msg.atype as ArtifactType] as
        | (typeof ARTIFACT_POLICIES)[ArtifactType]
        | undefined;
      if (policy === undefined) {
        throw new ArtifactError('invalid_atype', `unknown artifact atype '${msg.atype}' (no policy in the artifact registry)`);
      }
      let payloadJson: string | null = msg.payloadJson ?? null;
      if (policy.blessing !== 'none') {
        const parsed = this.parseArtifactPayload(msg.payloadJson);
        if (parsed !== null && Object.prototype.hasOwnProperty.call(parsed, 'html')) {
          throw new ArtifactError(
            'invalid_payload',
            `inline 'html' is not accepted for atype '${msg.atype}' — write a self-contained static document to ${PROTOTYPE_HTML_RELPATH} and report a fileName pointer`,
          );
        }
        if (policy.blessing === 'prototype-file') {
          const validatedPath = this.validatePrototypeFile(msg.runId);
          // `contentHash` makes the minted payload change whenever the on-disk
          // bytes change: the ArtifactRouter's revision bump is delta-gated on
          // stored fields, and a bare `{ fileName }` pointer is byte-identical
          // across re-reports — so an in-place prototype edit would never
          // advance `revision`, freezing the counter the design-spec draft
          // binding and the feedback ack's applied_prototype_revision rely on.
          // An idempotent re-report (same bytes) still mints the same payload
          // and correctly does NOT bump.
          const contentHash = createHash('sha256').update(readFileSync(validatedPath)).digest('hex');
          payloadJson = JSON.stringify({ fileName: PROTOTYPE_HTML_RELPATH, contentHash });
        }
      }
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'create',
        runId: msg.runId,
        atype: msg.atype,
        label: msg.label,
        payloadJson,
        sourceRef: designStamp?.designIdeaId ?? null,
        ...(designStamp ? { sessionId: designStamp.sessionId } : {}),
        isNew: true,
        actor,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { artifactId, atype: msg.atype },
      });
    } catch (err) {
      this.writeArtifactError(client, msg.requestId, err);
    }
  }

  /**
   * Parse an artifact `payload_json` string into a plain object for the
   * content-blesser's `html`-key check. Fail-soft: unparseable / non-object /
   * absent JSON reads as `null` (no `html` key), so a malformed payload never
   * throws here — only an EXPLICIT top-level `html` member is rejected upstream.
   */
  private parseArtifactPayload(payloadJson: string | undefined): Record<string, unknown> | null {
    if (payloadJson === undefined) return null;
    try {
      const parsed = JSON.parse(payloadJson) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Validate the on-disk static `ui-prototype` document under the run's TRUSTED
   * artifacts dir (`getCyboflowSubdirectory('artifacts','runs',runId)` — NEVER
   * `process.env.CYBOFLOW_RUN_ARTIFACTS_DIR`): the canonical `prototype/index.html`
   * must exist, be a regular file (no symlink), stay inside the run artifacts root
   * (containment + realpath re-verify against an intermediate symlinked dir), and
   * sit at or below the size ceiling. Throws `ArtifactError('invalid_payload',
   * 'prototype_missing|prototype_invalid|prototype_too_large: …')` on any failure
   * so the report tool surfaces a precise reason to the producing agent.
   */
  /** Returns the validated, realpath'd absolute path of the prototype document. */
  private validatePrototypeFile(runId: string): string {
    const runRoot = path.resolve(getCyboflowSubdirectory('artifacts', 'runs', runId));
    const target = path.resolve(runRoot, PROTOTYPE_HTML_RELPATH);
    // Containment on the resolved (pre-realpath) path — defense in depth even
    // though PROTOTYPE_HTML_RELPATH is a fixed constant.
    if (target !== runRoot && !target.startsWith(runRoot + path.sep)) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} escapes the run artifacts root`);
    }
    if (!existsSync(target)) {
      throw new ArtifactError('invalid_payload', `prototype_missing: ${PROTOTYPE_HTML_RELPATH} not found for run ${runId}`);
    }
    const lst = lstatSync(target);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} is not a regular file`);
    }
    // Realpath re-verify: an intermediate symlinked dir must not let the file
    // escape the run artifacts root (both sides realpath'd so a symlinked temp
    // root — e.g. macOS /tmp → /private/tmp — is not a false escape).
    const realRoot = realpathSync(runRoot);
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} resolves outside the run artifacts root`);
    }
    const st = statSync(realTarget);
    if (!st.isFile()) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} is not a regular file`);
    }
    if (st.size > MAX_PROTOTYPE_HTML_BYTES) {
      throw new ArtifactError('invalid_payload', `prototype_too_large: ${st.size} > ${MAX_PROTOTYPE_HTML_BYTES}`);
    }
    return realTarget;
  }

  /**
   * Commit a run artifact (flip committed) via the ArtifactRouter chokepoint.
   */
  private async handleCommitArtifact(
    msg: Extract<McpQueryMessage, { type: 'mcp-commit-artifact' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    // ctx.actor is `agent:${string}` (see resolveReviewItemRunContext) — a
    // strict subtype of ArtifactActor, so no 'linear'/'plane' coercion is
    // needed here: a review-item run-context actor is always agent-authored.
    const actor: ArtifactActor = ctx.actor;
    try {
      // The tool's optional `payload_json` ("store a final payload alongside the
      // commit") is applied as a SEPARATE `update` FIRST — commit itself is
      // IDENTITY-ONLY so a byte pointer can't be stripped mid-commit right before
      // the durability snapshot (see ArtifactCommit). ui-prototype's required byte
      // is canonical regardless of payload, so this ordering can't lose content.
      if (msg.payloadJson !== undefined) {
        await ArtifactRouter.getInstance().apply(ctx.projectId, {
          op: 'update',
          artifactId: msg.artifactId,
          payloadJson: msg.payloadJson,
          actor,
        });
      }
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'commit',
        artifactId: msg.artifactId,
        actor,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { artifactId, committed: true },
      });
    } catch (err) {
      this.writeArtifactError(client, msg.requestId, err);
    }
  }

  // --------------------------------------------------------------------------
  // Design Mode v0 (docs/ideas/design-mode.md) — the design-scoped MCP ops.
  //
  // Both start from resolveDesignRunContext, which re-validates the session's
  // idea link on EVERY call (integrity is chokepoint-enforced, not FK-enforced;
  // migration 085). source_ref/session_id stamping for the design prototype
  // rides the shared handleReportArtifact path (resolveSessionDesignStamp).
  // --------------------------------------------------------------------------

  /**
   * The run's design-session stamp — `{ designIdeaId, sessionId }` — or null for
   * a non-design session (or a run without a session). Read via the SAME
   * `workflow_runs LEFT JOIN sessions` shape as resolveRunPermissionMode. Used
   * ONLY to stamp an artifact's source_ref AND session_id SERVER-SIDE (never
   * from the agent payload): source_ref makes a design prototype discoverable by
   * its idea downstream (design-mode.md "Idea-bound artifact + read path"), and
   * session_id is what the frontend DesignApproveControl render gate keys on
   * (ArtifactTabRenderer's CanvasBody needs `artifact.sessionId` to call
   * `cyboflow.design.draftStatus`/`approve` — without it the Approve control
   * never renders, which the v0 live smoke caught). A join miss / NULL
   * design_idea_id yields null → neither field is set, so the report path for a
   * non-design session stays byte-identical.
   */
  private resolveSessionDesignStamp(runId: string): { designIdeaId: string; sessionId: string } | null {
    const row = this.db
      .prepare(
        `SELECT s.design_idea_id AS designIdeaId, r.session_id AS sessionId
           FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
          WHERE r.id = ?`,
      )
      .get(runId) as { designIdeaId?: unknown; sessionId?: unknown } | undefined;
    const ideaId = row?.designIdeaId;
    const sessionId = row?.sessionId;
    if (typeof ideaId !== 'string' || ideaId.length === 0) return null;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    return { designIdeaId: ideaId, sessionId };
  }

  /**
   * Resolve + re-validate the design-session context for a design-scoped MCP op
   * (design-mode.md "Idea link — integrity contract"): EVERY design-scoped op
   * re-runs this so a cross-project id, a deleted/decomposed/archived idea, or a
   * non-design session is rejected at the write chokepoint. Steps:
   *   - the 'orchestrator' sentinel has no run row → design_requires_real_run;
   *   - a missing run row → run_not_found;
   *   - the run's session carries no design_idea_id → not_a_design_session;
   *   - the linked idea is missing / decomposed / archived → the user-visible
   *     'idea_link_broken: idea link broken — relink or end the design session'
   *     soft state (contract (c)); a cross-project idea id → wrong_project
   *     (contract (b)).
   * On success returns the project + session ids and the validated idea identity.
   */
  private resolveDesignRunContext(
    runId: string,
  ):
    | {
        ok: true;
        projectId: number;
        sessionId: string;
        ideaId: string;
        idea: { id: string; ref: string; title: string; body: string | null; version: number };
      }
    | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'design_requires_real_run' };
    }

    const runRow = this.db
      .prepare(
        `SELECT r.project_id AS projectId, r.session_id AS sessionId, s.design_idea_id AS designIdeaId
           FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
          WHERE r.id = ?`,
      )
      .get(runId) as { projectId?: unknown; sessionId?: unknown; designIdeaId?: unknown } | undefined;
    if (!runRow) {
      return { ok: false, error: 'run_not_found' };
    }

    const designIdeaId =
      typeof runRow.designIdeaId === 'string' && runRow.designIdeaId.length > 0 ? runRow.designIdeaId : null;
    if (designIdeaId === null) {
      return { ok: false, error: 'not_a_design_session' };
    }
    const projectId = typeof runRow.projectId === 'number' ? runRow.projectId : Number(runRow.projectId);
    const sessionId = typeof runRow.sessionId === 'string' ? runRow.sessionId : '';

    const ideaRow = this.db
      .prepare(
        `SELECT id, project_id AS projectId, ref, title, body, version,
                decomposed_at AS decomposedAt, archived_at AS archivedAt
           FROM ideas WHERE id = ?`,
      )
      .get(designIdeaId) as
      | {
          id?: unknown;
          projectId?: unknown;
          ref?: unknown;
          title?: unknown;
          body?: unknown;
          version?: unknown;
          decomposedAt?: unknown;
          archivedAt?: unknown;
        }
      | undefined;
    // The idea was deleted / decomposed / archived mid-session, or was never a
    // real idea — the same user-visible broken-link state either way.
    if (!ideaRow) {
      return { ok: false, error: 'idea_link_broken: idea link broken — relink or end the design session' };
    }
    const ideaProjectId = typeof ideaRow.projectId === 'number' ? ideaRow.projectId : Number(ideaRow.projectId);
    if (ideaProjectId !== projectId) {
      // Cross-project id — contract (b). Distinct from the soft broken-link state.
      return { ok: false, error: 'wrong_project' };
    }
    if (ideaRow.decomposedAt !== null && ideaRow.decomposedAt !== undefined) {
      return { ok: false, error: 'idea_link_broken: idea link broken — relink or end the design session' };
    }
    if (ideaRow.archivedAt !== null && ideaRow.archivedAt !== undefined) {
      return { ok: false, error: 'idea_link_broken: idea link broken — relink or end the design session' };
    }

    return {
      ok: true,
      projectId,
      sessionId,
      ideaId: designIdeaId,
      idea: {
        id: designIdeaId,
        ref: typeof ideaRow.ref === 'string' ? ideaRow.ref : '',
        title: typeof ideaRow.title === 'string' ? ideaRow.title : '',
        body: typeof ideaRow.body === 'string' ? ideaRow.body : null,
        version: typeof ideaRow.version === 'number' ? ideaRow.version : Number(ideaRow.version),
      },
    };
  }

  /**
   * Return the design session's linked idea (ref/title/body/version). Re-runs
   * the full integrity re-validation via resolveDesignRunContext, so a broken
   * link surfaces here too (the agent's contract is to stop writing on it).
   */
  private handleDesignGetIdea(
    msg: Extract<McpQueryMessage, { type: 'mcp-design-get-idea' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveDesignRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        ref: ctx.idea.ref,
        title: ctx.idea.title,
        body: ctx.idea.body,
        version: ctx.idea.version,
      },
    });
  }

  /**
   * Persist the session's current design-spec draft with a per-session monotonic
   * draft_revision (COALESCE(MAX(draft_revision),0)+1), bound to the session's
   * CURRENT ui-prototype artifact (its id + `artifacts.revision`) so Approve can
   * CAS-reject a draft written against an older prototype (design-mode.md
   * "Design-spec draft"). The binding is NULL when no prototype exists yet (the
   * draft is not yet approvable). Replies { draftRevision, boundArtifactRevision }.
   */
  private handleDesignUpdateDraft(
    msg: Extract<McpQueryMessage, { type: 'mcp-design-update-draft' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveDesignRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // The session's single current prototype — THE prototype-family selection
    // rule, mirrored verbatim in draftStatus (design.ts router) and
    // pickPrototype (DesignModeSurface); change all three together:
    //   1. payload-bearing beats the bytes-less re-entry stub;
    //   2. 'interactive-prototype' beats 'ui-prototype' — an explicit
    //      mid-session tier switch leaves BOTH rows payload-bearing, and the
    //      interactive tier is the live canvas from then on (the lo-fi row may
    //      hold a HIGHER revision from its earlier life, which is why revision
    //      alone must never break this tie);
    //   3. revision, then created_at, as residual tie-breaks (one artifact per
    //      atype makes these near-moot, kept for determinism).
    // NULLs when none exists yet.
    const proto = this.db
      .prepare(
        `SELECT id, revision FROM artifacts
         WHERE run_id = ? AND atype IN ('ui-prototype', 'interactive-prototype')
         ORDER BY (payload_json IS NOT NULL) DESC, (atype = 'interactive-prototype') DESC,
                  revision DESC, created_at DESC
         LIMIT 1`,
      )
      .get(msg.runId) as { id?: unknown; revision?: unknown } | undefined;
    const boundArtifactId = typeof proto?.id === 'string' ? proto.id : null;
    const boundArtifactRevision = typeof proto?.revision === 'number' ? proto.revision : null;

    const draftId = `dsd_${randomBytes(12).toString('hex')}`;
    let draftRevision = 0;
    // MAX + INSERT in one transaction so draft_revision stays monotonic under the
    // UNIQUE(session_id, draft_revision) constraint even if two writes race.
    const txn = this.db.transaction(() => {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(draft_revision), 0) AS maxRev FROM design_spec_drafts WHERE session_id = ?')
        .get(ctx.sessionId) as { maxRev: number };
      draftRevision = (maxRow.maxRev ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO design_spec_drafts
             (id, session_id, idea_id, draft_revision, spec_markdown, bound_artifact_id, bound_artifact_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(draftId, ctx.sessionId, ctx.ideaId, draftRevision, msg.specMarkdown, boundArtifactId, boundArtifactRevision);
    });
    (txn as () => void)();

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { draftRevision, boundArtifactRevision },
    });
  }

  /**
   * Acknowledge a delivered design-feedback batch (Design Mode v1 —
   * design-mode.md "Design feedback v1 — acknowledged durable outbox"). The
   * revision turn carried the batch + attempt ids; the agent echoes them back
   * with the prototype artifact revision that now contains the change, and the
   * FeedbackRouter's ONE-RESULT CAS decides whether this ack is the winner.
   *
   * Guard chain, in order:
   *   - the full design-session integrity re-validation (resolveDesignRunContext),
   *     so a broken idea link / non-design session / cross-project id is rejected
   *     here exactly as on every other design-scoped op;
   *   - the batch must EXIST (`batch_not_found`) and must belong to THIS design
   *     session (`batch_not_in_session`) — a design session acking another
   *     session's batch would let one session close out another's feedback.
   *
   * The losing duplicate is DATA, not an error: `{ applied: false, note }`. Only
   * a genuinely malformed request or a chokepoint failure replies ok:false.
   */
  private async handleDesignAckFeedback(
    msg: Extract<McpQueryMessage, { type: 'mcp-design-ack-feedback' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveDesignRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const batch = this.db
      .prepare('SELECT id, session_id AS sessionId FROM feedback_batches WHERE id = ?')
      .get(msg.batchId) as { id?: unknown; sessionId?: unknown } | undefined;
    if (!batch) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: `batch_not_found: no feedback batch ${msg.batchId}`,
      });
      return;
    }
    if (batch.sessionId !== ctx.sessionId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: `batch_not_in_session: feedback batch ${msg.batchId} does not belong to this design session`,
      });
      return;
    }

    try {
      const result = await FeedbackRouter.getInstance().applyBatchResult({
        batchId: msg.batchId,
        attemptId: msg.attemptId,
        prototypeRevision: msg.prototypeRevision,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: result.applied
          ? { applied: true }
          : {
              applied: false,
              note: 'already resolved — this batch was acknowledged by an earlier attempt; nothing further to do',
            },
      });
    } catch (err) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error:
          err instanceof FeedbackError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Visual verification request (cyboflow_request_verification)
  //
  // FIRE-AND-CONTINUE producer seam (docs/proposals/visual-verification-design.md §"The
  // collision story" #1): resolve the run's IMMUTABLY-stamped verify posture
  // (migration 055 verify_enabled / verify_type / verify_chain), enqueue ONE
  // verification_requests row via the VerificationScheduler chokepoint, and reply
  // { requestId } SYNCHRONOUSLY — the lane is never held on the verdict. The
  // scheduler drains on its OWN setImmediate loop (NOT RunQueueRegistry), captures
  // + judges, and delivers the verdict asynchronously.
  //
  // Two invariants enforced here:
  //  - A run with verify_enabled=0 replies { skipped:true } — NEVER an error (a
  //    disabled run must not wedge a lane; mirrors the resolver's disabled posture).
  //  - typeOverride only NARROWS: the effective chain is intersected with the run's
  //    stamped verify_chain, so an override can neither enable a disabled run nor
  //    introduce a backend the host lacks (the stamped chain is the host-available
  //    set the resolver already filtered).
  // --------------------------------------------------------------------------

  /**
   * Narrow the camelCase viewports wire value to VerificationRequestInput.viewports,
   * keeping only well-formed entries ({ width:number, height:number, label?:string })
   * and dropping malformed ones. Returns undefined when the input is not an array OR
   * no entry survives — an agent typo never fails a fire-and-continue request.
   */
  private parseViewports(v: unknown): VerificationRequestInput['viewports'] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out: NonNullable<VerificationRequestInput['viewports']> = [];
    for (const entry of v) {
      if (!isRecord(entry) || typeof entry.width !== 'number' || typeof entry.height !== 'number') continue;
      out.push(
        typeof entry.label === 'string'
          ? { width: entry.width, height: entry.height, label: entry.label }
          : { width: entry.width, height: entry.height },
      );
    }
    return out.length > 0 ? out : undefined;
  }

  /**
   * Enqueue a visual-verification request for the run and reply { requestId }, or
   * { skipped:true } when the run has verify disabled. Synchronous (no await on the
   * verdict). Guards mirror the other run-bound writes (sentinel / missing /
   * terminal run reject via resolveReviewItemRunContext). Fully fail-soft: any
   * unexpected error is surfaced as an ok:false reply rather than throwing.
   *
   * DUAL-FORMAT (redesign §5.2): when `msg.task` is present it is strictly
   * validated (parseVerificationTaskV1) — an invalid task replies ok:false with
   * `invalid_verification_task: <error>` and enqueues nothing. A valid task is
   * authoritative: the legacy `deliverable_json` shape is DERIVED from it
   * (deriveLegacyInputFromTask) rather than from `intent`/`url`/`htmlPath`, and
   * both the derived input AND the task are passed to the scheduler so
   * `task_json` dual-writes alongside `deliverable_json`. `msg.task` absent ⇒ this
   * method's behavior is byte-identical to the pre-redesign legacy path.
   *
   * PHASE 2 (docs/proposals/verification-setup-flow.md §5.2 seams 1+3, §7.2)
   * inserts ONE shared step between validation and enqueue —
   * `prepareVerificationEnqueue`, the same function the programmatic
   * `enqueueTaskVerification` seam calls — which (a) REJECTS a task whose
   * build/serve mutates dependencies, with `forbidden_dependency_command: …`
   * named exactly like the `invalid_verification_task` rejection above, and (b)
   * injects the project's PROVEN runbook revision + its content-addressed pin.
   * Sharing it is the point: two enqueue paths applying two versions of one rule
   * is how a guard stops covering half the traffic.
   *
   * ASYNC as of that step (the runbook status re-validates a file against a
   * hash, an input-hash and a host fingerprint — all filesystem work). The reply
   * is still written before any verdict exists, so the fire-and-continue
   * contract the tool advertises is unchanged.
   *
   * SETUP PROOF (§3.6/§5.3). `setupProof` + the `runbookHash`/`runbookLocalVersion`
   * pin are the phase-2 setup flow's channel through this SAME handler rather
   * than a parallel one. Together they say "this request exists to PROVE the
   * revision I just registered": the row is stamped budget-exempt and
   * lower-priority, the §3.2 "no proven runbook" gate is bypassed (a project
   * cannot prove a runbook if being unproven blocks the proof), and a PASS is
   * what the ENGINE — never the flow — turns into `markProven`. The pin is
   * supplied rather than resolved for the same reason: the revision under proof
   * is by construction not yet proven, so the lookup would find nothing.
   *
   * `setupProof:true` is a self-declared EXEMPTION from both of those gates, so
   * (Codex adversarial-review finding 4) it is itself gated: authorized against
   * the run's FROZEN workflow identity (must be `verify-setup`) and required to
   * carry a pin that resolves to a draft actually registered via
   * `cyboflow_register_verify_runbook` — see the `msg.setupProof === true`
   * block below for the two checks and their reasoning.
   *
   * ORDINARY REQUESTS NEVER CARRY A WIRE PIN. A caller-supplied pin is
   * meaningful ONLY inside that authorized envelope; without `setupProof:true`
   * the `runbookHash`/`runbookLocalVersion` wire fields are dropped before
   * `prepareVerificationEnqueue` sees them, so the engine-resolved PROVEN
   * revision is the only pin an ordinary request can end up with. Otherwise the
   * pin's "authoritative, skip the lookup" semantics would let any caller
   * suppress the injection with an invented hash and ride the resulting
   * runbook/sha mismatch into an advancing skip (round-3 finding 1; the full
   * argument sits at the `wirePin` parse below).
   *
   * SNAPSHOT SHA is captured here too, from the run's worktree, so an
   * MCP-enqueued request gets the same lane-isolated snapshot build as a
   * programmatically enqueued one (round-3 finding 2; see the capture below).
   */
  private async handleRequestVerification(
    msg: Extract<McpQueryMessage, { type: 'mcp-request-verification' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // OWNERSHIP GUARD: when a programmatic run's workflow controller owns the
    // enqueue it is the ONLY legitimate enqueuer, and it goes through its direct
    // host capability (verify/enqueueFromTask.ts) — never this socket path. An
    // MCP-path call on such a run is therefore a step turn firing the tool it was
    // told not to (the per-spawn disallowedTools denial only reaches the Claude
    // SDK manager; Codex and interactive turns ignore it), so reject it here —
    // provider-independently — before a rogue keyless request can race the
    // controller's own enqueue at the merge gate. Fail-soft read: a missing /
    // pre-schema execution_model resolves null and falls through.
    //
    // SCOPED by `runHasControllerVisualVerify`, not by the execution model alone.
    // "Programmatic" was only ever a proxy for "the controller enqueues", and
    // `verify-setup` is the counterexample: programmatic, no fan-out, no
    // controller-owned visual-verify step, and its `prove` step's entire
    // deliverable is firing a `setup_proof` request through THIS path. Guarding
    // on the execution model alone rejected it, leaving the flow that bootstraps
    // verification unable to prove anything (live dogfood run, 2026-07-31). A run
    // with no such step has no controller enqueue to race. The predicate
    // fail-CLOSES on an unresolvable definition, so an unreadable run keeps the
    // old deny posture. Every other authorization below is unchanged — a
    // `setup_proof` claim still has to be a verify-setup run with a registered pin.
    if (
      this.readExecutionModel(msg.runId) === 'programmatic' &&
      runHasControllerVisualVerify(this.db, msg.runId)
    ) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error:
          'programmatic_run_verification_rejected: verification enqueues on this run are ' +
          'controller-owned (its chain has a visual-verify step). Do not fire this tool — print the ' +
          'visual-verification contract as TEXT in your final message and the controller will enqueue it.',
      });
      return;
    }

    // The run's FROZEN workflow identity, resolved ONCE up here because two
    // things below need it: the `__quick__` late-binding branch immediately
    // after, and the `setup_proof` authorization further down (which used to
    // make this call itself, inside its own block).
    const frozenSpec = resolveRunFrozenSpec(this.db, msg.runId);
    const isQuickRun = frozenSpec?.workflowName === QUICK_WORKFLOW_NAME;

    // Read the run's IMMUTABLE verify stamp (migration 055). Read defensively — a
    // pre-036 DB lacking the columns degrades to a disabled posture (skipped).
    let enabled = false;
    let stampedType: VerificationType | null = null;
    let stampedChain: VisualBackendId[] = [];
    try {
      const row = this.db
        .prepare(
          `SELECT verify_enabled AS verifyEnabled, verify_type AS verifyType, verify_chain AS verifyChain
             FROM workflow_runs WHERE id = ?`,
        )
        .get(msg.runId) as { verifyEnabled?: unknown; verifyType?: unknown; verifyChain?: unknown } | undefined;
      enabled = row?.verifyEnabled === 1 || row?.verifyEnabled === true;
      stampedType = isVerificationType(row?.verifyType) ? row.verifyType : null;
      stampedChain = this.parseStampedChain(row?.verifyChain);
    } catch {
      // Pre-migration-036 DB (no verify columns) — keep the disabled default.
      enabled = false;
    }

    // QUICK-SESSION LATE BINDING: a `__quick__` chat sentinel resolves its posture
    // NOW instead of reading the stamp above. See `getVisualVerifyConfig` on
    // McpQueryHandlerDeps for why the stamp cannot serve here (minted once per
    // session, no UPDATE path — a session predating the master switch would be
    // disabled forever).
    //
    // This honors the EXISTING enablement ladder rather than adding a setting:
    // the same `resolveVisualVerification` `createRun` calls, fed the same global
    // rung and the same project rung — just read at call time. The chain it
    // returns is used VERBATIM (not intersected) further down; that resolved
    // chain is what the scheduler's request-level dispatch key reads.
    let quickResolvedChain: VerifyChainEntry[] | null = null;
    if (isQuickRun && this.deps.getVisualVerifyConfig !== undefined) {
      const globalConfig = this.deps.getVisualVerifyConfig();
      // PROJECT RUNG, WORKTREE-FIRST — matching the runtime resolution order in
      // verifyConfigLoader's resolveDeliverableContext. A quick session editing
      // its own `.cyboflow/verify.json` must see that edit take effect without
      // merging first; reading the project checkout instead would make the
      // session's own config change inert, which is precisely the case this
      // late binding exists to serve. Falls back to the project checkout when the
      // worktree has no (or an unparseable) config.
      const worktreePath = this.resolveRunWorktree(msg.runId);
      let projectVerifyConfig = worktreePath === null ? null : await loadVerifyConfig(worktreePath, this.logger);
      if (projectVerifyConfig === null) {
        const projectPath = this.resolveProjectPath(ctx.projectId);
        if (projectPath !== null) projectVerifyConfig = await loadVerifyConfig(projectPath, this.logger);
      }

      const resolved = resolveVisualVerification({
        // No `setupFlowBootstrap` rung: a quick session is not the setup flow and
        // must not inherit its deadlock-breaking exemption.
        requestedEnabled: null,
        projectConfigEnabled: projectVerifyConfig?.enabled ?? null,
        globalDefaultEnabled: globalConfig.enabled,
        requestedType: isVerificationType(msg.typeOverride) ? msg.typeOverride : null,
        projectConfigDefaultType: projectVerifyConfig?.defaultType ?? null,
        globalDefaultType: globalConfig.defaultType,
        deliverable: null,
        availableBackends: SHIPPED_VERIFY_BACKENDS,
        // MUST be passed, exactly as createRun does (workflowRegistry.ts:1422).
        // Omitting it defaults to the AGENT engine, which would mint an agent
        // posture on a host explicitly rolled back to the legacy waterfall.
        legacyEngine: process.env.CYBOFLOW_VERIFY_LEGACY === '1',
      });
      enabled = resolved.enabled;
      stampedType = resolved.type;
      quickResolvedChain = resolved.enabled ? resolved.chain : null;
    }

    // Disabled run → no-op SKIP (never an error). A typeOverride cannot enable it.
    //
    // The ack ALWAYS names its reason. A bare `{ skipped: true }` is not a usable
    // answer for the caller: at least three different conditions skip a request
    // (this branch, plus the scheduler's §3.2 no-proven-runbook degrade and its
    // capability suppressions), and an agent handed an unlabelled skip has no way
    // to tell them apart — so it GUESSES, and the guess reads to a human as a
    // diagnosis. That is not hypothetical: a quick session skipped here for a
    // plain disabled switch reported "no proven verification runbook" to the user,
    // because that was the only skip reason named anywhere in its context.
    if (!enabled || stampedType === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { skipped: true, reason: this.disabledSkipReason(isQuickRun, enabled) },
      });
      return;
    }

    // Effective type: a valid typeOverride NARROWS to its own type; otherwise the
    // run's stamped type. (Validity is already guaranteed by the wire union, but we
    // re-guard since the field flows in untrusted across the socket.)
    const effectiveType: VerificationType = isVerificationType(msg.typeOverride) ? msg.typeOverride : stampedType;

    // Effective chain = FALLBACK_CHAINS[effectiveType] ∩ the run's stamped chain
    // (the host-available set the resolver already filtered). The intersection is
    // why typeOverride can only NARROW — it can never reach a backend the host lacks.
    // Order follows FALLBACK_CHAINS (easy→hard). An empty intersection still enqueues
    // (the scheduler treats an empty chain as a SKIP, never a fabricated fail).
    //
    // QUICK RUNS write their CALL-TIME-RESOLVED chain VERBATIM instead. This is
    // what makes the feature reachable at all: `VerificationScheduler.processRow`
    // decides the engine via `isAgentEngineRequest`, whose first rung is the
    // request's own `chain_json`. Intersecting here would erase the resolved
    // `['agent']` selector ('agent' is not a VisualBackendId, so it survives no
    // intersection), the row would fall to the legacy waterfall, select no
    // candidate, and terminate `skipped: 'no usable backend'` behind a
    // healthy-looking `{ requestId }` reply.
    //
    // FLOW RUNS ARE UNCHANGED — byte-for-byte. `quickResolvedChain` is null for
    // every non-quick run, and an agent-stamped flow run's intersection already
    // evaluates to `[]` today (parseStampedChain narrows to VisualBackendId[],
    // which drops 'agent'), so its dispatch still resolves off the run stamp
    // exactly as before.
    const chain =
      quickResolvedChain !== null
        ? [...quickResolvedChain]
        : FALLBACK_CHAINS[effectiveType].filter((backend) => stampedChain.includes(backend));

    // DUAL-FORMAT CONTRACT (redesign §5.2): when `task` is present it is
    // authoritative for the deliverable. Strictly validate it FIRST — an invalid
    // task must never fall through to a bogus legacy-shaped enqueue.
    let task: VerificationTaskV1 | undefined;
    if (msg.task !== undefined) {
      const parsed = parseVerificationTaskV1(msg.task);
      if (!parsed.ok) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `invalid_verification_task: ${parsed.error}`,
        });
        return;
      }
      task = parsed.task;
    }

    let input: VerificationRequestInput;
    if (task) {
      // taskRef precedence: task.taskRef ?? the wire task_ref arg (§5.2 "written
      // identically into both columns"). deriveLegacyInputFromTask applies exactly
      // this precedence; the legacy per-field url/htmlPath/baselineKey/viewports
      // wire args are superseded by the task (task is authoritative).
      const wireTaskRef = typeof msg.taskRef === 'string' && msg.taskRef.length > 0 ? msg.taskRef : undefined;
      input = deriveLegacyInputFromTask(task, wireTaskRef);
      // Neither the task nor the wire carried a taskRef: fall back to the existing
      // single-lane default (same mitigation as the legacy path below), and
      // reflect the defaulted value into BOTH the persisted input AND the task
      // object so deliverable_json and task_json agree (§5.2).
      if (input.taskRef === undefined) {
        const defaulted = this.defaultTaskRefForRun(msg.runId);
        if (defaulted !== undefined) {
          input.taskRef = defaulted;
          task = { ...task, taskRef: defaulted };
        }
      } else if (task.taskRef !== input.taskRef) {
        task = { ...task, taskRef: input.taskRef };
      }
    } else {
      // Build the deliverable input, dropping any malformed optional members.
      input = { intent: msg.intent };
      if (typeof msg.url === 'string') input.url = msg.url;
      if (typeof msg.htmlPath === 'string') input.htmlPath = msg.htmlPath;
      if (typeof msg.baselineKey === 'string') input.baselineKey = msg.baselineKey;
      // taskRef threads the lane attribution into deliverable_json so the async
      // merge-gate verdict can be driven onto the right lane (multi-lane batches).
      // When the agent OMITS it, best-effort default it from the lane context WHEN
      // unambiguous (a single-lane batch) — a belt-and-suspenders mitigation for the
      // gate's strict attribution (locked decision #2). A multi-lane batch CANNOT be
      // defaulted here (the wire carries no itemId), so it stays absent and the
      // gate's single-lane-only rule for a taskRef-less event is the invariant.
      if (typeof msg.taskRef === 'string' && msg.taskRef.length > 0) {
        input.taskRef = msg.taskRef;
      } else {
        const defaulted = this.defaultTaskRefForRun(msg.runId);
        if (defaulted !== undefined) input.taskRef = defaulted;
      }
      const viewports = this.parseViewports(msg.viewports);
      if (viewports !== undefined) input.viewports = viewports;
    }

    // §7.2 guard + §5.2 seam-3 injection, shared with the programmatic seam. A
    // rejection replies ok:false and enqueues NOTHING (mirroring the
    // invalid_verification_task posture above); an injection replaces the task's
    // build/serve/attestation with the proven runbook's and hands back the pin to
    // stamp. The legacy intent-only path (no `task`) passes through untouched.
    //
    // A CALLER-SUPPLIED PIN SHORT-CIRCUITS THE LOOKUP (§5.2/§5.3): the setup
    // flow's proof run pins the DRAFT it is trying to prove, which by definition
    // is not proven yet — requiring a proven record for it would be the same
    // bootstrap deadlock §3.6 exempts it from at the degrade gate. Both halves
    // must arrive together; half a pin is dropped rather than stamped, since the
    // runner's CAS would have nothing to validate against.
    //
    // PARSED HERE, THREADED ONLY UNDER THE SETUP-PROOF ENVELOPE (Codex round-3
    // finding 1). `prepareVerificationEnqueue`'s rule — "a caller-supplied pin
    // is authoritative, stamp it verbatim, skip the proven-runbook lookup" — was
    // written for the setup flow, whose pin the block below authorizes. Handing
    // an ORDINARY request the same short-circuit turns two optional wire fields
    // into a silent kill switch for verification itself: any orchestrated agent
    // sending `runbook_hash: 'bogus'` suppresses the engine's proven-revision
    // injection, the runner's CAS then rejects the pin as a runbook/sha
    // mismatch, and the mismatch env-SKIPS — and a skip ADVANCES the lane. No
    // real hash is needed, which is the whole point: the attack costs a string.
    // So the wire pin is parsed unconditionally (the authorization block needs
    // it to validate) but reaches the engine ONLY inside the authorized
    // setup-proof envelope; an ordinary request's pin fields are DROPPED, making
    // the engine-resolved proven revision the only pin such a request can ever
    // carry. Enforced at THIS seam because this is where untrusted input
    // crosses — the shared function has an in-process caller that was never the
    // threat model, and gating it there too would be a second belt.
    const wirePin =
      typeof msg.runbookHash === 'string' &&
      msg.runbookHash.length > 0 &&
      typeof msg.runbookLocalVersion === 'number' &&
      Number.isFinite(msg.runbookLocalVersion)
        ? { hash: msg.runbookHash, localVersion: msg.runbookLocalVersion }
        : undefined;

    // SETUP-PROOF AUTHORIZATION (Codex adversarial-review finding 4). The MCP
    // socket is the UNTRUSTED seam: any orchestrated agent's tool call — a
    // prompt-injected one, a copy-pasted example, an ordinary sprint/ship/
    // compound lane reaching for `setup_proof:true` because it read the
    // verify-setup workflow prompt once — can set this flag with no
    // authorization at all, and until this gate existed it was honored
    // unconditionally. `setupProof:true` BYPASSES both the §3.2 "no proven
    // runbook" degrade gate and the project's lifetime verification budget
    // (see the SETUP PROOF paragraph in this method's doc-comment above), so
    // an unauthorized claim is not a quota nuisance — it is a way to make
    // every subsequent verification for the project silently free and
    // gate-exempt. Enforced HERE, once, at the seam an untrusted caller
    // actually crosses.
    //
    // IN-PROCESS ENGINE CALLERS STAY FREE. `prepareVerificationEnqueue` is
    // shared with `enqueueTaskVerification` (verify/enqueueFromTask.ts), the
    // programmatic controller's direct host-capability seam — but that seam
    // takes no wire input for `setupProof`; only the socket path above threads
    // an agent-supplied flag through at all, and the ownership guard earlier
    // in this method already rejects any MCP call on a programmatic run
    // outright. Gating the shared function too would be a second enforcement
    // point for a caller that was never the threat model — "belt and
    // suspenders, not two belts and three suspenders."
    if (msg.setupProof === true) {
      // (1) AUTHORIZE from the run's FROZEN workflow identity, never the
      // agent's own say-so. resolveRunFrozenSpec is the same workflow_runs →
      // workflows.name lookup handleReportStep uses (keyed off the
      // (workflow_id, spec_hash) pair stamped at createRun), so a live edit to
      // `workflows.name` mid-run can never be raced into passing this check.
      // Only the verify-setup flow ever proves a runbook; any other workflow
      // asking for the exemption is rejected, and the error names the run's
      // ACTUAL workflow so a legitimate caller can see immediately why it was
      // denied rather than guessing.
      // `frozenSpec` is resolved ONCE near the top of this method (the quick-run
      // branch needs it too). Same lookup, same guarantee: it is keyed off the
      // (workflow_id, spec_hash) pair stamped at createRun, so a live edit to
      // `workflows.name` mid-run cannot be raced into passing this check.
      const actualWorkflow = frozenSpec?.workflowName ?? 'unknown';
      if (actualWorkflow !== VERIFY_SETUP_WORKFLOW_NAME) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `setup_proof_not_authorized: this run's workflow is '${actualWorkflow}', not '${VERIFY_SETUP_WORKFLOW_NAME}' — setup_proof is verify-setup-flow-only`,
        });
        return;
      }

      // (2) REQUIRE the pin. A setup_proof request with no registered draft
      // behind it can never actually be marked proven — VerifyRunbookStore's
      // proof flip has no record to flip — so an unpinned "proof" carries no
      // corresponding upside; it IS the budget/gate bypass and nothing else.
      // Require both wire halves (mirroring the `wirePin` parse above) AND
      // that the hash resolve through the SAME store the runner later
      // validates the pin against (§5.2 seam 3) — a hash nobody registered is
      // not a draft, whatever the caller claims about it. `modality` is
      // derived exactly as `prepareVerificationEnqueue` derives it below, so
      // this check resolves the identical (project, modality) record the pin
      // will actually be validated against.
      const store = this.deps.verifyRunbookStore;
      const modality = resolveTaskModality(effectiveType, task ?? null);
      const pinned =
        wirePin !== undefined && store !== undefined
          ? store.getByHash(ctx.projectId, modality, wirePin.hash)
          : null;
      if (wirePin === undefined || store === undefined || pinned === null) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error:
            'setup_proof_requires_pin: setup_proof requires both runbookHash and runbookLocalVersion, ' +
            'and the hash must resolve to a draft registered via cyboflow_register_verify_runbook',
        });
        return;
      }
    }

    // The ONLY pin that leaves this handler for the engine. Past the block
    // above, `msg.setupProof === true` means the claim was authorized against
    // the run's frozen workflow identity AND `wirePin` resolved to a registered
    // draft — so this is exactly "a validated setup-proof pin, or nothing". An
    // ordinary request lands on `undefined` no matter what it put on the wire,
    // and `prepareVerificationEnqueue` then resolves the project's proven
    // revision itself (see the PARSED HERE note above for why that matters).
    const authorizedPin = msg.setupProof === true ? wirePin : undefined;

    const prepared = await prepareVerificationEnqueue({
      projectId: ctx.projectId,
      runId: msg.runId,
      type: effectiveType,
      ...(task !== undefined ? { task } : {}),
      ...(authorizedPin !== undefined ? { pin: authorizedPin } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
    });
    if (!prepared.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: prepared.error,
      });
      return;
    }
    // A merged task supersedes both persisted columns, so the legacy input is
    // re-derived from it — `deliverable_json` must never describe a shape
    // `task_json` no longer carries.
    if (prepared.task !== undefined && prepared.task !== task) {
      task = prepared.task;
      input = deriveLegacyInputFromTask(task, input.taskRef);
    }

    // SNAPSHOT SHA (§5.5) — captured at ENQUEUE time, mirroring step (2) of the
    // programmatic seam (verify/enqueueFromTask.ts `enqueueTaskVerification`)
    // exactly, because a request row's isolation posture must not depend on
    // which of the two enqueue paths minted it (Codex round-3 finding 2). Until
    // this landed the MCP path never stamped one, so EVERY orchestrated
    // verification — the whole orchestrated plane, including verify-setup's own
    // proof runs — ran the runner's dirty live-worktree FALLBACK: no clone
    // isolation from sibling lanes still editing the shared worktree, and the
    // fallback's build/launch_failed→skipped carve-out (which exists to keep a
    // KNOWN-dirty tree from failing a lane on someone else's half-written file)
    // promoted from rare degradation to the normal path — i.e. an agent
    // reporting `build_failed` advanced its lane. Recording a sha ALWAYS
    // snapshots, so stamping one is what closes that carve-out.
    //
    // FAIL-SOFT, same posture as the programmatic seam: a missing worktree row
    // or a `git rev-parse` failure (not a repo, unborn HEAD) degrades to null —
    // the pre-existing fallback — rather than refusing the enqueue. This is a
    // capture, not a gate; hard-failing here would turn "cannot resolve HEAD"
    // into a lost verification, which is strictly worse than a dirty one. The
    // worktree LOOKUP is inside the same catch on purpose: this block sits
    // OUTSIDE the enqueue's try, so an escaping throw here would leave the
    // caller's socket with no reply at all — the one failure mode a
    // fire-and-continue seam must never have.
    let snapshotSha: string | null = null;
    let snapshotWorktreePath: string | null = null;
    // Does the worktree carry uncommitted work the snapshot at `snapshotSha`
    // will NOT contain? Probed for QUICK runs only — a sprint lane commits before
    // it verifies, so the answer there is both uninteresting and (with siblings
    // mid-edit in the shared worktree) usually a false alarm. Reported to the
    // caller rather than blocking: see `isWorktreeDirty`.
    let dirtyWorktree = false;
    try {
      snapshotWorktreePath = this.resolveRunWorktree(msg.runId);
      if (snapshotWorktreePath === null) {
        this.logger?.warn('[Cyboflow MCP Query] request-verification: no run worktree; enqueuing without a snapshot', {
          runId: msg.runId,
        });
      } else {
        snapshotSha = await captureSnapshotSha(snapshotWorktreePath);
        if (isQuickRun) dirtyWorktree = await isWorktreeDirty(snapshotWorktreePath);
      }
    } catch (err) {
      this.logger?.warn('[Cyboflow MCP Query] request-verification: snapshot sha capture failed', {
        runId: msg.runId,
        worktreePath: snapshotWorktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
      snapshotSha = null;
    }

    // Key the row to its lane attempt when the taskRef names a lane of this
    // run's batch (see laneEnqueueKeyFor for why, and for the dedup it implies);
    // anything else enqueues unkeyed as before. A setup proof is never lane
    // traffic, keyed or not.
    const lanes = msg.setupProof === true || input.taskRef === undefined ? null : this.lanesForRun(msg.runId);
    const enqueueKey =
      lanes !== null && input.taskRef !== undefined
        ? laneEnqueueKeyFor(msg.runId, input.taskRef, lanes)
        : undefined;

    try {
      const requestId = VerificationScheduler.getInstance().enqueue({
        runId: msg.runId,
        projectId: ctx.projectId,
        type: effectiveType,
        input,
        chain,
        task,
        snapshotSha,
        ...(enqueueKey !== undefined ? { enqueueKey } : {}),
        ...(msg.setupProof === true ? { setupProof: true } : {}),
        ...(prepared.pin
          ? { runbookHash: prepared.pin.hash, runbookLocalVersion: prepared.pin.localVersion }
          : {}),
      });
      // Reply SYNCHRONOUSLY (the lane continues), then kick the drain loop. enqueue
      // already nudges; the extra nudge is harmless (coalesced) and makes the
      // fire-and-continue contract explicit.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        // `snapshotSha` + `dirtyWorktree` travel WITH the ack so the caller learns
        // what is actually being verified at the moment it fires, not after the
        // verdict. A PASS on a dirty tree certifies `snapshotSha`, not the working
        // copy, and the tool description requires both be stated alongside any
        // verdict relayed to the user.
        data: { requestId, type: effectiveType, snapshotSha, dirtyWorktree },
      });
      VerificationScheduler.getInstance().nudge();
    } catch (err) {
      this.logger?.error('[Cyboflow MCP Query] request-verification enqueue failed', {
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_enqueue_failed',
      });
    }
  }

  /**
   * Request an AD-HOC code-review eval of the CALLING run's current diff
   * (cyboflow_run_eval) and reply synchronously with the queue status — the jury
   * grades asynchronously and posts its verdict to the review queue.
   *
   * Guards:
   *   - the 'orchestrator' sentinel runId has no workflow_runs row and no diff
   *     (mirrors resolveTaskRunContext's first guard) → eval_requires_real_run;
   *   - the dep being absent → eval_unavailable (the established degrade pattern
   *     shared with the workflowConfig / agentThreadStore tools).
   *
   * DELIBERATELY NOT resolveTaskRunContext: that helper also rejects TERMINAL
   * runs, but a quick session's sentinel run is 'running' for the whole chat and
   * a flow run may legitimately want a grade after settling. Run EXISTENCE is
   * checked inside the snapshot (rejected/run_not_found), which is the only part
   * of that guard this tool needs.
   */
  private async handleRunEval(
    msg: Extract<McpQueryMessage, { type: 'mcp-run-eval' }>,
    client: net.Socket,
  ): Promise<void> {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error:
          'eval_requires_real_run: an ad-hoc eval grades a specific run\'s diff, and the ' +
          'global-agent sentinel has neither a run row nor a worktree.',
      });
      return;
    }

    const runAdHocEval = this.deps.runAdHocEval;
    if (!runAdHocEval) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'eval_unavailable: the code-review eval worker is not wired in this process.',
      });
      return;
    }

    let result: AdHocSnapshotResult;
    try {
      result = await runAdHocEval(msg.runId);
    } catch (err) {
      this.logger?.error('[Cyboflow MCP Query] ad-hoc eval request failed', {
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'eval_request_failed',
      });
      return;
    }

    if (result.outcome !== 'rejected') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { status: result.outcome, rubricVersion: result.rubricVersion },
      });
      return;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: false,
      error: AD_HOC_EVAL_REJECTION_ERRORS[result.reason],
    });
  }

  /**
   * BLOCK until a verification request settles, then reply with its verdict
   * (docs/proposals/verification-setup-flow.md §5.2 seam 2 — "the setup flow's
   * test-execute step needs a wait-for-verdict seam, bounded, with the verdict
   * surfaced inline").
   *
   * THIS IS THE ONE VERIFICATION CALL THAT DOES NOT RETURN IMMEDIATELY, and the
   * asymmetry is deliberate. `mcp-request-verification` is fire-and-continue
   * because a sprint lane's turn ENDS at the enqueue — the verdict arrives later
   * and is driven onto the parked lane by the merge gate, with no live turn to
   * hand it to. The setup flow inverts that: "derive → prove by running →
   * diagnose → adjust → re-prove" is a loop inside a single turn, and each arrow
   * consumes the previous outcome. Long-blocking MCP calls are precedented here —
   * `handleRequestUserInput` holds this same socket open across an unbounded human
   * decision — and unlike that gate this one is BOUNDED by the caller's own
   * deadline.
   *
   * RUN-BOUND, like every other tool on this socket: the request must belong to
   * THIS run. Cross-run awaits are rejected as `not_your_request` rather than
   * served — a flow blocking on another run's request would both leak that run's
   * verdict and hold a socket for a deadline it does not control.
   *
   * TIMING OUT IS NOT CANCELING. On expiry the reply carries the request's CURRENT
   * (non-terminal) status with `errorMessage: 'await timeout'`; the request keeps
   * draining and still delivers its verdict to the screenshots artifact + the
   * review queue through the normal path. The flow's correct response is to report
   * that it stopped waiting — never to treat it as a failure of the deliverable.
   */
  private async handleAwaitVerification(
    msg: Extract<McpQueryMessage, { type: 'mcp-await-verification' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    if (typeof msg.verificationRequestId !== 'string' || msg.verificationRequestId.length === 0) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'invalid_arguments: request_id must be a non-empty verification request id',
      });
      return;
    }

    // OWNERSHIP GUARD (run-bound). A read failure is reported as not-found rather
    // than swallowed: awaiting a request this handler cannot even see would block
    // for the full deadline and then report a status it never read.
    let ownerRunId: string | null = null;
    try {
      const row = this.db
        .prepare('SELECT run_id FROM verification_requests WHERE id = ?')
        .get(msg.verificationRequestId) as { run_id?: unknown } | undefined;
      ownerRunId = typeof row?.run_id === 'string' ? row.run_id : null;
    } catch (err) {
      this.logger?.warn('[Cyboflow MCP Query] await-verification ownership read failed', {
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      ownerRunId = null;
    }
    if (ownerRunId === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_request_not_found',
      });
      return;
    }
    if (ownerRunId !== msg.runId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_your_request',
      });
      return;
    }

    // Clamp the wait budget. The ceiling is the AGENT request deadline itself:
    // waiting longer than the longest a request may legally run cannot surface a
    // verdict that does not exist, it only holds the socket. A non-positive /
    // malformed value falls back to the default rather than resolving instantly,
    // which would silently turn the blocking tool into a poll.
    const requested = typeof msg.timeoutMs === 'number' && Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : NaN;
    const timeoutMs =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, AGENT_REQUEST_TIMEOUT_CEILING_MS)
        : AWAIT_VERIFICATION_DEFAULT_TIMEOUT_MS;

    const scheduler = VerificationScheduler.tryGetInstance();
    if (scheduler === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_unavailable',
      });
      return;
    }

    try {
      const outcome = await scheduler.awaitTerminal(msg.verificationRequestId, timeoutMs);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          status: outcome.status,
          failureClass: outcome.failureClass,
          feedback: outcome.feedback,
          errorMessage: outcome.errorMessage,
        },
      });
    } catch (err) {
      this.logger?.error('[Cyboflow MCP Query] await-verification failed', {
        runId: msg.runId,
        verificationRequestId: msg.verificationRequestId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_await_failed',
      });
    }
  }

  /**
   * List THIS run's verification requests — the NON-BLOCKING cold read behind
   * `cyboflow_get_verifications`.
   *
   * WHY IT EXISTS. `awaitTerminal` already returns instantly for an
   * already-terminal request, so `cyboflow_await_verification` doubles as a
   * later-turn read — but ONLY while the caller still holds the request id. A
   * quick chat session fires-and-continues, and after a context compaction the
   * ids are gone; without this tool the agent that fired a verification cannot
   * find out what happened to it, while the human can see it in the artifacts
   * pane. That asymmetry is the gap this closes.
   *
   * RUN-SCOPED IN SQL (`listRequestsForRun`), not by post-filtering: a foreign
   * `request_id` yields an empty list rather than another run's verdict, and no
   * cross-run row is ever materialized. There is deliberately no `not_your_request`
   * error here — unlike `await`, which must distinguish "not yours" from "not
   * found" so a flow does not block on an id it will never be told about, a
   * listing's honest answer for a row it may not see is simply that the row is
   * not in the list.
   */
  private handleGetVerifications(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-verifications' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const scheduler = VerificationScheduler.tryGetInstance();
    if (scheduler === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_unavailable',
      });
      return;
    }

    const narrowTo =
      typeof msg.verificationRequestId === 'string' && msg.verificationRequestId.length > 0
        ? msg.verificationRequestId
        : undefined;
    const verifications = scheduler.listRequestsForRun(msg.runId, narrowTo);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { verifications },
    });
  }

  /**
   * Register (or refresh) the MACHINE-LOCAL half of this project's verification
   * runbook from the portable file committed in THIS run's worktree (§5.2 seam 1),
   * replying `{ hash, version }` — the content-addressed hash of the portable half
   * and the CAS version of the local record.
   *
   * THE WORKTREE IS THE SOURCE, NOT THE WIRE. The tool takes no runbook content:
   * the store reads `.cyboflow/verify-runbook.json` from the run's own worktree
   * itself. That is what makes the returned hash mean something — it addresses the
   * file the flow actually committed, not a payload the flow retyped, so a request
   * pinned to that hash executes the revision a human can `git show`.
   *
   * ERRORS COME BACK VERBATIM. `registerDraft` returns (never throws) messages
   * like "portable runbook is not valid JSON: …" and "portable runbook declares no
   * \"cdp-app\" modality", each naming the offending path or key. Collapsing those
   * into an opaque code would leave the setup flow guessing at a file it just
   * wrote; passing them through is what lets it fix the file and retry in the same
   * turn.
   *
   * `bindings_json` is validated as PARSEABLE JSON here and stored opaquely — the
   * store has no schema for it (§5.3 leaves the machine-local bindings shape to
   * the modality), but persisting text that is not even JSON would guarantee a
   * later reader fails on data this handler could have rejected at the door.
   */
  private async handleRegisterVerifyRunbook(
    msg: Extract<McpQueryMessage, { type: 'mcp-register-verify-runbook' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    if (!isVerifyRunbookModality(msg.modality)) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        // 'mobile' is deliberately NOT accepted: §4 defers it entirely, so a
        // record declaring it could never be satisfied by any execution path.
        error: "invalid_modality: expected 'web' | 'cdp-app' | 'native-screen'",
      });
      return;
    }

    if (msg.bindingsJson !== undefined) {
      try {
        JSON.parse(msg.bindingsJson);
      } catch (err) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `invalid_bindings_json: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    const store = this.deps.verifyRunbookStore;
    if (!store) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'runbook_store_unavailable',
      });
      return;
    }

    const worktreePath = this.resolveRunWorktree(msg.runId);
    if (worktreePath === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_worktree_unavailable',
      });
      return;
    }

    try {
      const result = await store.registerDraft(
        ctx.projectId,
        worktreePath,
        msg.modality,
        msg.bindingsJson,
      );
      if ('error' in result) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: result.error,
        });
        return;
      }
      // Migration-105 provenance: THIS registration came through the Verify
      // Setup flow, where a human reviews the proposal and every repo change it
      // wants before anything is touched. The lane bootstrap stamps
      // 'lane-bootstrap' on its own registrations, and a human deciding whether
      // to trust a proven runbook needs to be able to tell the two apart — both
      // are proven by the same engine-enforced run, and they did not earn the
      // same amount of trust. Fail-soft: a badge that could not be written must
      // never undo a registration that succeeded.
      store.setOrigin(ctx.projectId, msg.modality, 'setup-flow');
      // COMMITTED-AT-HEAD backstop. registerDraft reads the WORKING TREE, but
      // the proof runs against a detached snapshot at a commit — so a runbook
      // that never reached HEAD registers cleanly and then proves against a
      // snapshot that does not contain it. The common cause is mundane and
      // silent: many repos ignore or locally-exclude `.cyboflow/` (it is where
      // cyboflow keeps worktrees and local state), which makes a plain
      // `git add .cyboflow/verify-runbook.json` a no-op (observed live
      // 2026-07-31). Surface it here, where the flow can still fix it with
      // `git add -f`, rather than letting it resurface as an inexplicable proof
      // failure ten minutes later. Advisory only — the registration itself is
      // valid and stands.
      const committed = await isRunbookCommittedAtHead(worktreePath, VERIFY_RUNBOOK_RELATIVE_PATH);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          hash: result.hash,
          version: result.version,
          committed,
          ...(committed
            ? {}
            : {
                warning:
                  `${VERIFY_RUNBOOK_RELATIVE_PATH} is not present at HEAD, so the proof's detached ` +
                  'snapshot will not contain it. Commit it before proving — if `git add` appears to ' +
                  'do nothing, this project ignores or excludes `.cyboflow/`, so use `git add -f`.',
              }),
        },
      });
    } catch (err) {
      // registerDraft is total by contract; this is the belt-and-braces path so a
      // future non-total collaborator cannot take the socket down with it.
      this.logger?.error('[Cyboflow MCP Query] register-verify-runbook failed', {
        runId: msg.runId,
        modality: msg.modality,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'runbook_register_failed',
      });
    }
  }

  /**
   * Best-effort default for an OMITTED task_ref (locked decision #2 mitigation):
   * the sole lane's display ref (or opaque task id) when the calling run is a
   * batched sprint run with EXACTLY ONE lane — the only case a taskRef-less
   * request is unambiguous. A non-batch run, a run whose batch has zero or 2+
   * lanes, or any read failure returns undefined (the request stays taskRef-less
   * and the gate's strict attribution applies). Fully fail-soft — a defaulting
   * hiccup never fails a fire-and-continue request.
   */
  private defaultTaskRefForRun(runId: string): string | undefined {
    const lanes = this.lanesForRun(runId);
    if (lanes === null || lanes.length !== 1) return undefined; // multi-lane cannot be defaulted; non-lane run has none
    const only = lanes[0];
    return typeof only.ref === 'string' && only.ref.length > 0 ? only.ref : only.taskId;
  }

  /**
   * The sprint lanes of the run's batch, or `null` for a run with no batch
   * (a quick chat, a planner/verify-setup run) or when the lane store cannot
   * answer — both callers treat that as "no lane context", never as an error.
   */
  private lanesForRun(runId: string): SprintLaneRow[] | null {
    try {
      const runRow = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
      if (!batchId) return null;
      return SprintLaneStore.getInstance().listLanes(batchId);
    } catch {
      return null;
    }
  }

  /** Parse the run's stamped verify_chain JSON into a VisualBackendId[]; [] on null/malformed. */
  private parseStampedChain(v: unknown): VisualBackendId[] {
    if (typeof v !== 'string' || v.length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is VisualBackendId => typeof x === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Surface an ArtifactError code (or a generic message) as an ok:false reply. */
  private writeArtifactError(client: net.Socket, requestId: string, err: unknown): void {
    const error =
      err instanceof ArtifactError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    this.writeResponse(client, { type: 'mcp-query-response', requestId, ok: false, error });
  }

  /**
   * Surface a review-item failure as an ok:false response. A ReviewItemError maps
   * to its discriminated .code (mirrors writeTaskChangeError); anything else is
   * logged and collapsed to the opaque 'review_item_failed'.
   *
   * Used by the SYNCHRONOUS pre-create validations on the report-finding path
   * (entity-link + payload-discriminant), which construct ReviewItemError so the
   * codes are single-sourced from the chokepoint's error type. The async create
   * itself is fire-and-forget (the run is already replied to), so a late
   * chokepoint rejection there is logged, not written through this helper.
   */
  private writeReviewItemError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof ReviewItemError) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] review item failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'review_item_failed',
    });
  }

  // --------------------------------------------------------------------------
  // shell-approval-request (interactive substrate, IDEA-013 S5 / TASK-810)
  // --------------------------------------------------------------------------

  // OBSERVE-ONLY sprint-lane auto-derive lives in SprintLaneStore
  // .deriveLaneFromTaskDispatch (substrate-agnostic, shared with the SDK
  // PreToolUse seam in preToolUseHookHelper.ts). handleShellApprovalRequest
  // invokes it for the INTERACTIVE substrate; see the call at the top of that
  // method.

  /**
   * Async-deferred PreToolUse gate for the INTERACTIVE substrate.
   *
   * Unlike every other branch in this handler, this one does NOT writeResponse
   * synchronously. The hook subprocess (preToolUseShellHook.ts) blocks on the
   * held-open socket for the FULL human-decision window; we reply only once the
   * verdict is known — via the socketReply closure passed to requestApproval,
   * possibly minutes later. The per-connection socket therefore stays alive
   * across the wait (TASK-798's fire-and-forget dispatch tolerates this).
   *
   * Flow (mirrors the SDK PreToolUse hook at claudeCodeManager.ts:572-587):
   *   (a) reject the 'orchestrator' sentinel runId (parity with the checkpoint /
   *       report-step guards) — a deny with no approvals row;
   *   (a2) acceptEdits fast-path (Step F): when the run's effective mode (from
   *       permission_mode_snapshot) is 'acceptEdits' and the tool is in the
   *       acceptEdits auto-approve surface (Edit/Write/MultiEdit + the widened
   *       read-only surface — safe reads + provably read-only Bash/git, via
   *       isAcceptEditsAutoApprovable), AUTO-ALLOW with ZERO approvals row and NO
   *       folded review_item — SDK-mapper parity, applied BEFORE the allow-list check;
   *   (b) apply isToolAllowed(loadMergedPermissionRules(worktree)) and
   *       short-circuit ALLOW with ZERO approvals row (no double-prompt);
   *   (c) otherwise route through ApprovalRouter.requestApproval, writing the
   *       verdict back on the held-open socket from the socketReply closure.
   *
   * The 'auto'/'dontAsk' modes never install the wildcard shell hook (the
   * interactive settingsWriter opt-out), so this handler is only reached under
   * 'default' (full gate) and 'acceptEdits' (the (a2) fast-path + gate for
   * non-edit tools).
   *
   * P4 fold: requestApproval co-writes a blocking permission review_item into the
   * unified inbox (source 'approval:interactive', or 'approval:omp' when the
   * requester is the OMP gate extension) inside its own transaction. The
   * socket-held-open contract is UNCHANGED — the review_item is purely additive
   * and the socketReply closure remains the only place a verdict is written.
   *
   * CYBOFLOW_RUN_ID precondition (TASK-800): if runId is not a real
   * workflow_runs.id (e.g. still the Claude session UUID), requestApproval's
   * guarded UPDATE finds changes===0 → RunNotRunningError → we surface a logged
   * precondition failure and reply deny — never a silent swallow.
   *
   * AskUserQuestion is intentionally NOT special-cased here: a shell PreToolUse
   * hook has no `updatedInput` channel, so QuestionRouter is never wired on this
   * substrate (native-TUI-only, Probe A2). It simply routes as a normal gate.
   */
  private handleShellApprovalRequest(
    msg: Extract<McpQueryMessage, { type: 'shell-approval-request' }>,
    client: net.Socket,
  ): void {
    // AUTO-DERIVE sprint lane steps (observe-only). Fire-and-forget side-effect:
    // never writes to the socket, never alters the allow/deny verdict. Runs
    // BEFORE the gating flow so it is independent of the verdict path; the store
    // method is a strict no-op for non-sprint runs / non-Task tools / unknown
    // subagent_types / ambiguous attribution. getInstance() is wrapped because
    // some handler tests never initialize SprintLaneStore — a missing store must
    // not disturb the deny-gating contract below (byte-for-byte unchanged).
    try {
      SprintLaneStore.getInstance().deriveLaneFromTaskDispatch({
        runId: msg.runId,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
      });
    } catch {
      // SprintLaneStore not initialized — auto-derive is best-effort.
    }

    // (a) Orchestrator-sentinel guard — mirrors handleSubmitCheckpoint /
    // handleReportStep. The singleton MCP server runs with
    // CYBOFLOW_RUN_ID='orchestrator', which has no workflow_runs row.
    if (msg.runId === 'orchestrator') {
      this.writeShellVerdict(client, msg.requestId, { behavior: 'deny' });
      return;
    }

    // (a2) acceptEdits fast-path (Step F): when the run's effective 4-mode is
    // 'acceptEdits' and the tool is in the acceptEdits auto-approve surface
    // (Edit/Write/MultiEdit + the widened read-only surface), AUTO-ALLOW with
    // ZERO approvals row and NO folded review_item — parity with the SDK mapper's
    // acceptEdits branch (permissionModeMapper.ts shares the SAME
    // isAcceptEditsAutoApprovable predicate). This runs BEFORE the allow-list
    // check so a safe edit/read never needs a permissions.allow entry.
    //
    // The 'auto'/'dontAsk' modes never install the wildcard shell hook (the
    // settingsWriter opt-out — interactiveClaudeManager.ts), so the hook does not
    // fire and this handler is not reached for them; 'default' falls through to
    // the existing allow-list + router gate unchanged.
    const effectiveMode = this.resolveRunPermissionMode(msg.runId);
    if (
      effectiveMode === 'acceptEdits' &&
      isAcceptEditsAutoApprovable(msg.toolName, msg.toolInput)
    ) {
      this.writeShellVerdict(client, msg.requestId, { behavior: 'allow' });
      return;
    }

    // (b) Resolve runId → worktree (the run cwd) for the allow-list lookup.
    const worktree = this.resolveRunWorktree(msg.runId);
    if (worktree !== null) {
      try {
        const rules = loadMergedPermissionRules(worktree);
        if (isToolAllowed(msg.toolName, msg.toolInput, rules)) {
          // SDK parity: auto-allow with ZERO approvals row, no router round-trip.
          this.writeShellVerdict(client, msg.requestId, { behavior: 'allow' });
          return;
        }
      } catch (err) {
        // A settings-read failure must not crash the gate — fall through to the
        // router so the human is still asked (conservative, never auto-allow).
        this.logger?.warn(
          '[Cyboflow MCP Query] shell-approval allow-list check failed; routing to ApprovalRouter',
          { runId: msg.runId, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // (c0) omp-sdk lane: does this call already have an approval in flight?
    // A retry of an identical call must land on the ORIGINAL ask rather than
    // opening a second one — see DeferredOmpApproval. Two hits are possible:
    // a verdict that arrived while nobody was waiting (answer it now, single
    // use), or an ask still sitting in the human's queue (re-attach and wait).
    const ompKey = msg.substrate === 'omp' ? ompCallKey(msg.toolName, msg.toolInput) : null;
    if (ompKey !== null) {
      const deferred = this.ompDeferredApprovals.get(msg.runId)?.get(ompKey);
      if (deferred?.parked !== undefined) {
        const { decision, at } = deferred.parked;
        // Consumed either way — a stale verdict is spent, not left to be picked
        // up by a later retry.
        this.dropDeferredOmpApproval(msg.runId, ompKey);
        if (Date.now() - at <= OMP_PARKED_DECISION_MAX_AGE_MS) {
          this.logger?.debug(
            '[Cyboflow MCP Query] omp retry matched a decided approval — replaying the human verdict',
            { runId: msg.runId, toolName: msg.toolName, decision: decision.behavior },
          );
          this.writeShellVerdict(client, msg.requestId, decision);
          return;
        }
        // Too old to stand in for consent. Falling through opens a fresh
        // approval below, so the human is ASKED again rather than denied.
        this.logger?.debug(
          '[Cyboflow MCP Query] omp parked verdict expired — asking the human again',
          { runId: msg.runId, toolName: msg.toolName, ageMs: Date.now() - at },
        );
      } else if (deferred !== undefined) {
        // Still awaiting the human. Adopt the fresh socket as the requester and
        // register it so ITS disconnect is observed too; no second approvals row.
        deferred.client = client;
        deferred.requestId = msg.requestId;
        this.registerInFlightShellApproval(msg.runId, msg.requestId, client, msg.substrate);
        // Someone is blocked on this ask again — undo the un-awaited mark the
        // previous hangup left, so the queue stops describing a live wait as a
        // standing question.
        if (deferred.approvalId !== undefined) {
          this.setOmpApprovalAwaited(deferred.approvalId, true);
        }
        this.logger?.debug(
          '[Cyboflow MCP Query] omp retry re-attached to the pending approval',
          { runId: msg.runId, toolName: msg.toolName },
        );
        return;
      }
      this.putDeferredOmpApproval(msg.runId, ompKey, { client, requestId: msg.requestId });
    }

    // (c) Route through ApprovalRouter. Register the held-open socket FIRST so a
    // disconnect during the (async) requestApproval transaction is observed.
    const entry = this.registerInFlightShellApproval(
      msg.runId,
      msg.requestId,
      client,
      msg.substrate,
    );

    const router = ApprovalRouter.getInstance();
    void router
      .requestApproval(
        msg.runId,
        msg.toolName,
        msg.toolInput,
        (decision) => {
          // socketReply: the ONLY place a verdict is written for this transport.
          // (Under the SDK path this closure is a no-op; the shell transport uses
          // it — load-bearing, held open across the human-decision window.)
          this.completeInFlightShellApproval(msg.runId, entry);
          // On the omp lane the requester may have changed (a retry re-attached)
          // or gone (budget expired), so the deferred entry — not this closure's
          // captured socket — is the authority on where the verdict goes.
          if (ompKey !== null) {
            this.deliverDeferredOmpVerdict(msg.runId, ompKey, decision);
            return;
          }
          this.writeShellVerdict(client, msg.requestId, decision);
        },
        // P4: stamp the folded permission review_item with the substrate that
        // actually asked. Both transports arrive here, and reading every OMP ask
        // as an interactive-shell one makes the inbox lie about which agent is
        // blocked — the same attribution gap the pending-approval card had.
        // The co-write happens inside requestApproval's transaction (commit 1);
        // the socketReply closure above is unchanged.
        ompKey === null ? APPROVAL_SOURCE_INTERACTIVE : APPROVAL_SOURCE_OMP,
        // omp lane only: record which approval this deferred entry owns, so the
        // ~25s hangup can mark it un-awaited. The entry may already be gone (a
        // fail-closed catch dropped it); then there is nothing to record.
        ompKey === null
          ? undefined
          : (approvalId) => {
              const entry = this.ompDeferredApprovals.get(msg.runId)?.get(ompKey);
              if (entry === undefined) return;
              entry.approvalId = approvalId;
              // The gate can hang up DURING requestApproval's transaction, which
              // parks the entry before it ever learns its id. Reconcile here
              // rather than leaving the card claiming a wait that already ended.
              if (entry.client === null) this.setOmpApprovalAwaited(approvalId, false);
            },
      )
      .then((decision) => {
        // requestApproval resolves with the SAME decision the socketReply got
        // (or a synthetic deny when the run was canceled before the socketReply
        // fired). If the socketReply never ran (cancel/supersede path), settle
        // the held-open socket so the PTY does not hang.
        if (this.completeInFlightShellApproval(msg.runId, entry)) {
          if (ompKey !== null) {
            this.deliverDeferredOmpVerdict(msg.runId, ompKey, decision);
            return;
          }
          this.writeShellVerdict(client, msg.requestId, decision);
        }
      })
      .catch((err) => {
        // Precondition failure (TASK-800): a non-real runId binds a non-existent
        // workflow_runs row → guarded UPDATE changes===0 → RunNotRunningError.
        // Surface it loudly and fail closed (deny) rather than silently swallow.
        if (err instanceof RunNotRunningError) {
          this.logger?.error(
            '[Cyboflow MCP Query] shell-approval precondition failed: runId is not a running workflow_runs.id ' +
              '(is CYBOFLOW_RUN_ID the session UUID instead of workflow_runs.id?) — failing closed (deny)',
            { runId: msg.runId },
          );
        } else {
          this.logger?.error('[Cyboflow MCP Query] shell-approval requestApproval failed — failing closed (deny)', {
            runId: msg.runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (this.completeInFlightShellApproval(msg.runId, entry)) {
          const failClosed: ApprovalDecision = {
            behavior: 'deny',
            message: 'cyboflow approval precondition failed',
          };
          // A precondition failure is terminal for this ask: drop the deferred
          // entry so a retry re-asks cleanly rather than replaying the deny.
          if (ompKey !== null) this.dropDeferredOmpApproval(msg.runId, ompKey);
          this.writeShellVerdict(client, msg.requestId, failClosed);
        }
      });
  }

  /**
   * Deny-and-close every in-flight shell-approval socket for `runId`.
   *
   * This is the transport-aware twin of ApprovalRouter.clearPendingForRun,
   * which deliberately does NOT invoke socketReply ("the run is being torn down;
   * the socket is no longer meaningful") — correct for the in-process SDK
   * transport but WRONG for the shell transport, where a real socket is blocking
   * a real PTY. The interactive manager's cleanupCliResources (TASK-808) calls
   * this BEFORE killing the PTY so the blocked hook subprocess unblocks; it then
   * calls clearPendingForRun to settle the router's DB rows.
   *
   * For each in-flight socket: write a deny verdict (so the hook's fail-closed
   * path fires) and end the connection. Idempotent — safe to call when nothing
   * is in flight.
   *
   * @returns the number of sockets denied/closed.
   */
  cancelInFlightShellApprovals(runId: string): number {
    const set = this.inFlightShellApprovals.get(runId);
    if (!set || set.size === 0) return 0;

    // Snapshot before mutating — completeInFlightShellApproval deletes entries.
    const entries = [...set];
    for (const entry of entries) {
      if (!this.completeInFlightShellApproval(runId, entry)) continue;
      try {
        this.writeShellVerdict(entry.client, entry.requestId, {
          behavior: 'deny',
          message: 'Run was canceled before approval could be processed',
        });
      } catch (err) {
        this.logger?.debug('[Cyboflow MCP Query] shell-approval cancel write failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        entry.client.end();
      } catch {
        // best-effort close
      }
    }
    // Run teardown ends every deferred ask too: the parked verdicts and
    // still-pending entries are meaningless once the run is gone, and
    // clearPendingForRun's DB sweep settles their rows.
    this.ompDeferredApprovals.delete(runId);
    this.logger?.debug('[Cyboflow MCP Query] denied in-flight shell-approval sockets on cancel', {
      runId,
      count: entries.length,
    });
    return entries.length;
  }

  // --------------------------------------------------------------------------
  // interactive-turn-end (INTERACTIVE substrate Stop hook, IDEA-030)
  // --------------------------------------------------------------------------

  /**
   * Fire-and-ack: unlike shell-approval-request, there is no verdict to defer
   * — the Stop hook (stopShellHook.ts) does not gate anything, it only reports
   * that a turn ended, and it already applies its OWN bounded wait for this ack.
   * Routes to the injected `onInteractiveTurnEnd` dep (absent in tests/hosts
   * that never wired it — e.g. a bare OrchSocketServer in a unit test), which
   * this layer cannot reach directly (ORCHESTRATOR LAYERING RULE: no
   * main/src/services imports here).
   *
   * `ok:true` iff a live interactive run for `runId` was found and notified;
   * `ok:false` with `error:'turn_end_unavailable'` when the dep is missing OR
   * it reports no matching run — either way the hook script (which exits 0
   * unconditionally regardless of this response) has nothing to act on.
   */
  private handleInteractiveTurnEnd(
    msg: Extract<McpQueryMessage, { type: 'interactive-turn-end' }>,
    client: net.Socket,
  ): void {
    const notified = typeof msg.runId === 'string' && msg.runId.length > 0
      ? (this.deps.onInteractiveTurnEnd?.(msg.runId) ?? false)
      : false;

    if (!notified) {
      this.logger?.debug('[Cyboflow MCP Query] interactive-turn-end had no effect', {
        runId: msg.runId,
        depWired: this.deps.onInteractiveTurnEnd !== undefined,
      });
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: notified,
      ...(notified ? {} : { error: 'turn_end_unavailable' }),
    });
  }

  /**
   * "Parked on an AskUserQuestion gate" signal from the interactive
   * PreToolUse(AskUserQuestion) notify hook. Flips the run's quick-session board
   * state to `blocked` via the injected dep (interactiveClaudeManager
   * .notifyQuestionOpen). Fire-and-ack — the hook never gates the question, so we
   * always reply `ok:true` (the notification is best-effort; a missing dep just
   * means the board won't show `blocked` for this PTY session).
   */
  private handleInteractiveQuestionOpen(
    msg: Extract<McpQueryMessage, { type: 'interactive-question-open' }>,
    client: net.Socket,
  ): void {
    if (typeof msg.runId === 'string' && msg.runId.length > 0) {
      this.deps.onInteractiveQuestionOpen?.(msg.runId);
    }
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
    });
  }

  /**
   * The human-readable reason for a DISABLED-posture verification skip.
   *
   * Three conditions land in that one branch and they are not interchangeable —
   * each has a different fix, and only the caller can carry that to the user:
   *
   *   - a QUICK session whose posture resolved off ⇒ the master switch (or the
   *     project's `.cyboflow/verify.json`) is off. Fixable in Settings, and the
   *     late binding means it takes effect on the NEXT call — no restart, no new
   *     session. Naming that is the whole point: the fix is one toggle away.
   *   - a FLOW run stamped disabled ⇒ the stamp is immutable (migration 055, no
   *     UPDATE path), so no setting change rescues THIS run; it needs a new one.
   *   - enabled but no type resolved ⇒ a posture that survived the enablement
   *     ladder yet named no verification type. Rare, and worth saying plainly
   *     rather than folding into "disabled", which would be a lie.
   *
   * Deliberately NOT a reason this function can emit: anything about runbooks.
   * The runbook gate lives in the scheduler and fires only AFTER a row exists —
   * a request skipped here never reached it, so claiming it did would invent
   * evidence.
   */
  private disabledSkipReason(isQuickRun: boolean, enabled: boolean): string {
    if (enabled) {
      return (
        'visual verification is enabled but resolved no verification type — nothing was enqueued. ' +
        'Check the project/global visualVerify defaultType.'
      );
    }
    if (isQuickRun) {
      return (
        'visual verification is turned OFF — nothing was enqueued, no budget spent. ' +
        'Enable it in Settings (or in this project/worktree\'s .cyboflow/verify.json); a quick ' +
        'session reads the switch on every call, so the next request picks it up with no restart ' +
        'and no new session. This skip says NOTHING about whether the project has a runbook.'
      );
    }
    return (
      "this run's visual-verification posture was stamped disabled when the run was created, and " +
      'that stamp is immutable — changing the setting now cannot enable THIS run; a new run is ' +
      'required. This skip says NOTHING about whether the project has a runbook.'
    );
  }

  /**
   * Resolve the run's worktree_path (the session/run cwd) for the allow-list
   * lookup. Returns null when the run row is absent (the precondition check in
   * requestApproval then surfaces the failure loudly).
   */
  private resolveRunWorktree(runId: string): string | null {
    const row = this.db
      .prepare(`SELECT worktree_path FROM workflow_runs WHERE id = ?`)
      .get(runId) as { worktree_path?: unknown } | undefined;
    if (!row || typeof row.worktree_path !== 'string' || row.worktree_path.length === 0) {
      return null;
    }
    return row.worktree_path;
  }

  /**
   * Resolve a project's root checkout path. Used as the SECOND rung of the
   * quick-session verify-config lookup, behind the run's own worktree — a run's
   * commands execute in its worktree, so a recipe the branch under verification
   * added must win over the project checkout's copy.
   *
   * Fail-soft to null (absent row, missing column on an older schema): the caller
   * treats "no project config" and "could not read one" identically, falling to
   * the global rung, which is the same posture `createRun` takes when no project
   * config is injected.
   */
  private resolveProjectPath(projectId: number): string | null {
    try {
      const row = this.db
        .prepare('SELECT path FROM projects WHERE id = ?')
        .get(projectId) as { path?: unknown } | undefined;
      const p = row?.path;
      return typeof p === 'string' && p.length > 0 ? p : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the run's effective 4-mode agentPermissionMode from its owning
   * SESSION (`sessions.agent_permission_mode`), keyed on the run via the
   * `workflow_runs → sessions` join (permission-mode redesign §3c#3). The
   * session is the execution authority; the `permission_mode_snapshot` column is
   * demoted to audit-only.
   *
   * Returns null when the run row is absent, the join misses (a legacy sentinel
   * whose `session_id` was never backfilled ⇒ LEFT JOIN yields NULL), or the
   * column holds an unrecognized value — the caller then falls through to the
   * existing allow-list + router gate (conservative; never auto-allows on an
   * unknown/absent mode). The join-miss case cannot strand a dontAsk/acceptEdits
   * session in prompt-everything beyond the first mint-on-read turn (the
   * sentinel's `session_id` is stamped at creation). Used by the acceptEdits
   * fast-path; the 'auto'/'dontAsk' modes never reach this handler (no shell hook
   * installed).
   */
  private resolveRunPermissionMode(runId: string): PermissionMode | null {
    const row = this.db
      .prepare(
        `SELECT s.agent_permission_mode AS m
           FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
          WHERE r.id = ?`,
      )
      .get(runId) as { m?: unknown } | undefined;
    const m: unknown = row?.m;
    return isPermissionMode(m) ? m : null;
  }

  /**
   * Register a held-open shell-approval socket so the disconnect-cleanup and
   * cancel paths can find it. Attaches one-shot 'close'/'error' listeners that
   * clear the pending approval if the socket dies before a verdict (so the run
   * does not leak in awaiting_review).
   */
  private registerInFlightShellApproval(
    runId: string,
    requestId: string,
    client: net.Socket,
    substrate?: 'omp',
  ): InFlightShellApproval {
    const onDisconnect = (): void => {
      // Socket died before a verdict (orchestrator-down / hook subprocess died).
      if (!this.completeInFlightShellApproval(runId, entry)) return;

      // omp-sdk: the requester stopping is EXPECTED, not a death. OMP caps
      // extension handlers at 30s, so the gate hangs up at 25s on every ask a
      // human has not answered yet — settling here is what turned 17 live
      // approvals into 17 system rejections on 2026-08-19. Keep the ask (and its
      // review-queue card) alive, park the requester, and hand the run's gate
      // back so the session keeps executing.
      if (substrate === 'omp') {
        this.detachDeferredOmpRequester(runId, client);
        this.logger?.debug(
          '[Cyboflow MCP Query] omp gate stopped waiting — approval stays pending for the human',
          { runId },
        );
        try {
          ApprovalRouter.getInstance().orphanPendingForRun(runId);
        } catch (err) {
          this.logger?.debug('[Cyboflow MCP Query] orphanPendingForRun on disconnect failed', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      this.logger?.warn(
        '[Cyboflow MCP Query] shell-approval socket disconnected before verdict — clearing pending approval',
        { runId },
      );
      // Clear the pending approval so the run does not leak in awaiting_review.
      // ABANDONMENT, not termination: the run is still executing, only its
      // requester went away (gate-extension decision budget expired, hook
      // subprocess died). abandonPendingForRun therefore also restores
      // awaiting_review → running — clearPendingForRun would settle the approval
      // and leave the run wedged, making every later requestApproval loop in the
      // 'wait' branch with no row inserted and no gate ever shown. It is a no-op
      // socketReply path (correct here — the socket is already gone) and
      // idempotently settles the DB row.
      try {
        ApprovalRouter.getInstance().abandonPendingForRun(runId);
      } catch (err) {
        this.logger?.debug('[Cyboflow MCP Query] abandonPendingForRun on disconnect failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    client.on('close', onDisconnect);
    client.on('error', onDisconnect);

    const entry: InFlightShellApproval = {
      client,
      requestId,
      detachListeners: () => {
        client.off('close', onDisconnect);
        client.off('error', onDisconnect);
      },
    };

    let set = this.inFlightShellApprovals.get(runId);
    if (!set) {
      set = new Set<InFlightShellApproval>();
      this.inFlightShellApprovals.set(runId, set);
    }
    set.add(entry);

    this.logger?.debug('[Cyboflow MCP Query] shell-approval registered (held open)', { runId, requestId });
    return entry;
  }

  /**
   * Remove an in-flight entry and detach its disconnect listeners.
   *
   * @returns true if THIS call removed a live entry (so the caller should write
   *   the verdict); false if the entry was already settled by a concurrent path
   *   (disconnect / cancel / a prior resolve) — the caller must then NOT write,
   *   preserving the exactly-once verdict contract.
   */
  /** Record a fresh omp-lane ask so its retries and its verdict can find it. */
  private putDeferredOmpApproval(runId: string, key: string, entry: DeferredOmpApproval): void {
    let byKey = this.ompDeferredApprovals.get(runId);
    if (!byKey) {
      byKey = new Map<string, DeferredOmpApproval>();
      this.ompDeferredApprovals.set(runId, byKey);
    }
    byKey.set(key, entry);
  }

  private dropDeferredOmpApproval(runId: string, key: string): void {
    const byKey = this.ompDeferredApprovals.get(runId);
    if (!byKey) return;
    byKey.delete(key);
    if (byKey.size === 0) this.ompDeferredApprovals.delete(runId);
  }

  /**
   * Park the requester whose socket just died, WITHOUT touching the ask.
   *
   * Matched by socket identity, not by key: a retry may already have adopted
   * this entry with a newer socket, and the older socket's late 'close' must not
   * unhook the live one.
   */
  private detachDeferredOmpRequester(runId: string, client: net.Socket): void {
    const byKey = this.ompDeferredApprovals.get(runId);
    if (!byKey) return;
    for (const entry of byKey.values()) {
      if (entry.client !== client) continue;
      entry.client = null;
      // Nothing is blocked on this ask any more. The row stays pending — a
      // retry can still collect the verdict, even in a later turn — but the
      // queue must stop painting it as a halted agent.
      if (entry.approvalId !== undefined) this.setOmpApprovalAwaited(entry.approvalId, false);
    }
  }

  /**
   * Mark an omp approval awaited / un-awaited, fail-soft.
   *
   * Wrapped because both callers sit on hot, un-catchable paths — a socket
   * 'close' listener and the router's own onCreated callback — where a throw
   * would take down the disconnect handler or roll back a committed grab.
   */
  private setOmpApprovalAwaited(approvalId: string, awaited: boolean): void {
    try {
      ApprovalRouter.getInstance().setAwaited(approvalId, awaited);
    } catch (err) {
      this.logger?.debug('[Cyboflow MCP Query] setAwaited failed', {
        approvalId,
        awaited,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deliver an omp-lane verdict to whoever is waiting — or to nobody.
   *
   * With a requester attached this writes the verdict and the ask is done. With
   * none (the gate's budget expired and no retry has arrived yet) the decision
   * is PARKED for the next identical call, so a human answering a minute late
   * still authorizes the work instead of the model re-asking from scratch.
   */
  private deliverDeferredOmpVerdict(
    runId: string,
    key: string,
    decision: ApprovalDecision,
  ): void {
    const entry = this.ompDeferredApprovals.get(runId)?.get(key);
    if (!entry) return;
    if (entry.client === null) {
      entry.parked = { decision, at: Date.now() };
      this.logger?.debug(
        '[Cyboflow MCP Query] omp verdict arrived with no requester — parked for the retry',
        { runId, decision: decision.behavior },
      );
      return;
    }
    const { client, requestId } = entry;
    this.dropDeferredOmpApproval(runId, key);
    this.writeShellVerdict(client, requestId, decision);
  }

  private completeInFlightShellApproval(runId: string, entry: InFlightShellApproval): boolean {
    const set = this.inFlightShellApprovals.get(runId);
    if (!set || !set.has(entry)) return false;
    set.delete(entry);
    if (set.size === 0) this.inFlightShellApprovals.delete(runId);
    entry.detachListeners();
    return true;
  }

  /**
   * Write a PreToolUse verdict back to a held-open shell-approval socket. The
   * wire shape mirrors the synchronous branches:
   *   {type:'mcp-query-response',requestId,ok:true,data:{permissionDecision,...}}
   * The hook subprocess correlates the response by requestId on the shared socket.
   */
  private writeShellVerdict(
    client: net.Socket,
    requestId: string,
    decision: ApprovalDecision,
  ): void {
    const data: { permissionDecision: 'allow' | 'deny'; permissionDecisionReason?: string } = {
      permissionDecision: decision.behavior,
      ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
    };
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: true,
      data,
    });
  }

  // --------------------------------------------------------------------------
  // Workflow + variant configuration (cyboflow_*_workflow / _variant)
  //
  // All reach the WorkflowRegistry through the injected `workflowConfig` dep
  // (absent → 'workflow_config_unavailable'). Reads/writes are keyed by global
  // workflow/variant ids; only handleListWorkflows uses the run's projectId (for
  // the built-in reconcile + union). Registry guard Errors are mapped to ok:false
  // codes by writeWorkflowConfigError, mirroring the workflows/variants tRPC
  // routers. WARNING: editing a built-in edits the single global row shared by
  // every project — the tool descriptions call this out.
  // --------------------------------------------------------------------------

  /**
   * Shared preamble for the config handlers: require the injected dep AND a real,
   * non-terminal run (resolveTaskRunContext rejects the 'orchestrator' sentinel /
   * missing / terminal runs). Returns the config surface + projectId, or null
   * after writing the appropriate ok:false response.
   */
  private resolveWorkflowConfig(
    msg: Extract<McpQueryMessage, { runId: string; requestId: string }>,
    client: net.Socket,
  ): { cfg: WorkflowConfigLike; projectId: number } | null {
    const cfg = this.deps.workflowConfig;
    if (!cfg) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'workflow_config_unavailable',
      });
      return null;
    }
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return null;
    }
    return { cfg, projectId: ctx.projectId };
  }

  /** Compact workflow projection (no spec_json blob — see get_workflow for the definition). */
  private static toCompactWorkflow(row: WorkflowRow): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      project_id: row.project_id,
      scope: row.project_id === null ? 'global' : 'project',
      is_built_in: row.project_id === null && isCyboflowWorkflowName(row.name),
      permission_mode: row.permission_mode,
      // A non-empty, non-'{}' spec_json means the row's CUSTOM SLOT is filled
      // (migration 122) — i.e. `tuning_level: 'custom'` has something to
      // resolve. The full graph is on get_workflow, not here.
      has_custom_spec: hasCustomSpecSlot(row.spec_json),
      // Which definition this flow resolves (migration 122). Reported alongside
      // has_custom_spec because the two answer different questions: a flow can
      // hold a custom definition while running 'efficient'.
      tuning_level: row.tuning_level,
      // Which provider runs each step (migration 128). Orthogonal to the level;
      // the mix is materialized only into a RUN's frozen spec, so get_workflow's
      // definition stays mix-free and this stamp is the only place a reader sees it.
      runtime_mix: row.runtime_mix,
      created_at: row.created_at,
    };
  }

  /** Compact variant projection (omits the spec_json / agent_overrides_json blobs). */
  private static toCompactVariant(row: WorkflowVariantRow): Record<string, unknown> {
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      label: row.label,
      model: row.model,
      execution_model: row.execution_model,
      weight: row.weight,
      status: row.status,
      tuning_level: row.tuning_level,
      has_agent_overrides: row.agent_overrides_json !== null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Parse + validate a JSON-encoded WorkflowDefinition with the SAME strict
   * schema the tRPC write path runs as `.input()`. Returns the parsed definition
   * or null after writing an ok:false response (bad JSON → 'invalid_json',
   * schema violation → 'invalid_definition').
   */
  private parseDefinitionJson(
    definitionJson: string,
    requestId: string,
    client: net.Socket,
  ): WorkflowDefinition | null {
    let raw: unknown;
    try {
      raw = JSON.parse(definitionJson);
    } catch {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: 'invalid_json',
      });
      return null;
    }
    const parsed = workflowDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: 'invalid_definition',
      });
      return null;
    }
    return parsed.data;
  }

  /**
   * Map a WorkflowRegistry guard Error to an ok:false code by its distinguishable
   * message substring (parity with the workflows/variants tRPC error mapping):
   *   'not found' → not_found; 'run history' → run_history;
   *   'already exists' → already_exists; 'reserved' → reserved;
   *   otherwise → workflow_config_failed (logged).
   */
  private writeWorkflowConfigError(client: net.Socket, requestId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    let error = 'workflow_config_failed';
    if (message.includes('not found')) error = 'not_found';
    else if (message.includes('run history')) error = 'run_history';
    else if (message.includes('already exists')) error = 'already_exists';
    else if (message.includes('reserved')) error = 'reserved';
    else if (message.includes('unresolvable')) error = 'unresolvable';
    else if (message.includes('cannot reset')) error = 'not_a_builtin';
    else {
      this.logger?.error('[Cyboflow MCP Query] workflow config change failed', { error: message });
    }
    this.writeResponse(client, { type: 'mcp-query-response', requestId, ok: false, error });
  }

  private handleListWorkflows(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-workflows' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const { cfg, projectId } = resolved;
    // Reconcile the in-repo built-ins as global rows first (mirrors the tRPC
    // list) so a fresh project sees planner/sprint/compound/ship.
    cfg.ensureGlobalBuiltIns();
    const rows = cfg.listByProject(projectId);
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflows: rows.map((r) => McpQueryHandler.toCompactWorkflow(r)) },
    });
  }

  private handleGetWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const { cfg } = resolved;
    const row = cfg.getById(msg.workflowId);
    if (!row) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_found',
      });
      return;
    }
    // The EFFECTIVE definition the editor seeds from — the one this flow's
    // TUNING LEVEL selects (migration 122): a preset level's transform over the
    // built-in, the custom slot at 'custom', null for a broken custom flow.
    // The level itself rides along on the compact workflow projection, so a
    // caller can tell what it is looking at before editing it back.
    const definition = cfg.getEffectiveDefinition(msg.workflowId);
    const baselineRotation = cfg.getBaselineRotation(msg.workflowId);
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        workflow: McpQueryHandler.toCompactWorkflow(row),
        definition,
        baseline_rotation: baselineRotation,
      },
    });
  }

  private handleUpdateWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const definition = this.parseDefinitionJson(msg.definitionJson, msg.requestId, client);
    if (!definition) return;
    try {
      resolved.cfg.updateSpec(msg.workflowId, definition);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleResetWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-reset-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.resetSpec(msg.workflowId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleCreateWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    // Optional definition — omit to seed a default '{}' flow (createCustom's own
    // default). A supplied definition is validated with the strict schema.
    let specJson: string | undefined;
    if (msg.definitionJson !== undefined) {
      const definition = this.parseDefinitionJson(msg.definitionJson, msg.requestId, client);
      if (!definition) return;
      specJson = JSON.stringify(definition);
    }
    // scope 'project' pins the copy to THIS run's project; 'global' (default,
    // the product default per the tRPC router) mints a cross-project flow.
    const projectId = msg.scope === 'project' ? resolved.projectId : null;
    try {
      const row = resolved.cfg.createCustom({
        projectId,
        name: msg.name,
        ...(specJson !== undefined ? { specJson } : {}),
        ...(msg.permissionMode !== undefined ? { permissionMode: msg.permissionMode } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow: McpQueryHandler.toCompactWorkflow(row) },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleDeleteWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-delete-workflow' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.deleteWorkflow(msg.workflowId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId, deleted: true },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleListVariants(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-variants' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    const rows = resolved.cfg.listVariants(msg.workflowId);
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { variants: rows.map((r) => McpQueryHandler.toCompactVariant(r)) },
    });
  }

  private handleCreateVariant(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-variant' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    // An explicit definition seeds the variant's frozen graph instead of the
    // workflow's resolved one; validated the same way update_workflow validates
    // its payload (invalid_json / invalid_definition), so a malformed graph
    // never reaches the registry.
    let definition: WorkflowDefinition | undefined;
    if (msg.definitionJson !== undefined) {
      const parsed = this.parseDefinitionJson(msg.definitionJson, msg.requestId, client);
      if (!parsed) return;
      definition = parsed;
    }
    try {
      const row = resolved.cfg.createVariantFromCurrent(msg.workflowId, msg.label, {
        ...(definition !== undefined ? { definition } : {}),
        ...(msg.tuningLevel !== undefined ? { tuningLevel: msg.tuningLevel } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant: McpQueryHandler.toCompactVariant(row) },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleUpdateVariant(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-variant' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    // A supplied definition is validated + re-serialized; agent_overrides_json is
    // stored verbatim (already a JSON string or explicit null clearing it).
    let specJson: string | undefined;
    if (msg.definitionJson !== undefined) {
      const definition = this.parseDefinitionJson(msg.definitionJson, msg.requestId, client);
      if (!definition) return;
      specJson = JSON.stringify(definition);
    }
    try {
      resolved.cfg.updateVariant(msg.variantId, {
        ...(specJson !== undefined ? { specJson } : {}),
        ...(msg.agentOverridesJson !== undefined ? { agentOverridesJson: msg.agentOverridesJson } : {}),
        ...(msg.model !== undefined ? { model: msg.model } : {}),
        ...(msg.executionModel !== undefined ? { executionModel: msg.executionModel } : {}),
        ...(msg.weight !== undefined ? { weight: msg.weight } : {}),
        ...(msg.label !== undefined ? { label: msg.label } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant_id: msg.variantId },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleSetVariantStatus(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-variant-status' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.setVariantStatus(msg.variantId, msg.status);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant_id: msg.variantId, status: msg.status },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleDeleteVariant(
    msg: Extract<McpQueryMessage, { type: 'mcp-delete-variant' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.deleteVariant(msg.variantId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { variant_id: msg.variantId, deleted: true },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  private handleSetBaselineRotation(
    msg: Extract<McpQueryMessage, { type: 'mcp-set-baseline-rotation' }>,
    client: net.Socket,
  ): void {
    const resolved = this.resolveWorkflowConfig(msg, client);
    if (!resolved) return;
    try {
      resolved.cfg.setBaselineRotation(msg.workflowId, {
        ...(msg.inRotation !== undefined ? { inRotation: msg.inRotation } : {}),
        ...(msg.weight !== undefined ? { weight: msg.weight } : {}),
      });
      const updated = resolved.cfg.getBaselineRotation(msg.workflowId);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { workflow_id: msg.workflowId, baseline_rotation: updated },
      });
    } catch (err) {
      this.writeWorkflowConfigError(client, msg.requestId, err);
    }
  }

  // --------------------------------------------------------------------------
  // Global-agent tool family (S0.4)
  // --------------------------------------------------------------------------

  /** Read a raw `workflows` row directly (no WorkflowConfigLike dep needed for a read). Null when absent. */
  private readWorkflowRow(workflowId: string): WorkflowRow | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, tuning_level, runtime_mix, created_at, archived_at
           FROM workflows WHERE id = ?`,
      )
      .get(workflowId) as WorkflowRow | undefined;
    return row ?? null;
  }

  /**
   * Resolve a display ref (e.g. 'TASK-014') to its opaque id in ANY project.
   * Unlike resolveBacklogRef (single-project-scoped — used by the run-write
   * guarded tools to prevent cross-project ref-probing), the global agent has
   * legitimate cross-project visibility, so an unscoped scan is intended, not
   * a leak. Returns the FIRST match across ideas -> epics -> tasks; a ref
   * collision across two projects is NOT disambiguated here (pass an explicit
   * projectId to disambiguate).
   */
  private resolveBacklogRefAnyProject(ref: string): string | null {
    const tables = ['ideas', 'epics', 'tasks'] as const;
    for (const table of tables) {
      const row = this.db.prepare(`SELECT id FROM ${table} WHERE ref = ? LIMIT 1`).get(ref) as
        | { id: string }
        | undefined;
      if (row) return row.id;
    }
    return null;
  }

  private handleAgentOverview(
    msg: Extract<McpQueryMessage, { type: 'mcp-overview' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const projects = this.db
      .prepare('SELECT id, name FROM projects ORDER BY name')
      .all() as Array<{ id: number; name: string }>;

    interface SessionOverviewRow {
      session_id: string;
      session_name: string;
      session_status: string;
      project_id: number;
      is_quick: number;
      updated_at: string;
      run_id: string | null;
      run_status: string | null;
      current_step_id: string | null;
      workflow_name: string | null;
    }
    // Capped at the 200 most-recently-updated non-archived sessions across
    // every project — "active/recent" per the tool contract, not an
    // exhaustive dump. A run can never be session-less (WorkflowRegistry.
    // createRun's hard invariant), so this single LEFT JOIN also covers every
    // running/awaiting-human run — there is no run reachable ONLY off a
    // session-less path.
    const sessionRows = this.db
      .prepare(
        `SELECT s.id AS session_id, s.name AS session_name, s.status AS session_status,
                s.project_id AS project_id, s.is_quick AS is_quick, s.updated_at AS updated_at,
                wr.id AS run_id, wr.status AS run_status, wr.current_step_id AS current_step_id,
                w.name AS workflow_name
           FROM sessions s
           LEFT JOIN workflow_runs wr ON wr.id = s.run_id
           LEFT JOIN workflows w ON w.id = wr.workflow_id
          WHERE s.archived = 0
          ORDER BY s.updated_at DESC
          LIMIT 200`,
      )
      .all() as SessionOverviewRow[];

    const blockedRows = this.db
      .prepare(
        // audience='machine' items (migration 085) are the orchestrator's durable
        // mailbox — never human-actionable, so they must not inflate this
        // human-facing per-project blocked badge. NULL counts as human (pre-085 /
        // defensive; the NOT NULL default makes NULL impossible post-migration).
        `SELECT project_id, COUNT(*) AS n FROM review_items
          WHERE blocking = 1 AND status = 'pending' AND (audience IS NULL OR audience != 'machine')
          GROUP BY project_id`,
      )
      .all() as Array<{ project_id: number; n: number }>;
    const blockedByProject = new Map(blockedRows.map((r) => [r.project_id, r.n]));

    const questionRows = this.db
      .prepare(
        `SELECT wr.project_id AS project_id, COUNT(*) AS n
           FROM questions q JOIN workflow_runs wr ON wr.id = q.run_id
          WHERE q.status = 'pending'
          GROUP BY wr.project_id`,
      )
      .all() as Array<{ project_id: number; n: number }>;
    const questionsByProject = new Map(questionRows.map((r) => [r.project_id, r.n]));

    const sessionsByProject = new Map<number, Array<Record<string, unknown>>>();
    for (const row of sessionRows) {
      const bucket = sessionsByProject.get(row.project_id) ?? [];
      bucket.push({
        session_id: row.session_id,
        name: row.session_name,
        status: row.session_status,
        is_quick: row.is_quick === 1,
        updated_at: row.updated_at,
        run:
          row.run_id !== null
            ? {
                run_id: row.run_id,
                workflow_name: row.workflow_name,
                status: row.run_status,
                current_step_id: row.current_step_id,
              }
            : null,
      });
      sessionsByProject.set(row.project_id, bucket);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        projects: projects.map((p) => ({
          project_id: p.id,
          project_name: p.name,
          sessions: sessionsByProject.get(p.id) ?? [],
          blocked_gates_count: blockedByProject.get(p.id) ?? 0,
          pending_questions_count: questionsByProject.get(p.id) ?? 0,
        })),
      },
    });
  }

  private handleAgentBacklog(
    msg: Extract<McpQueryMessage, { type: 'mcp-backlog' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // selectProjectBacklog(db, null) merges EVERY project's backlog into one
    // list — the cross-project read this tool is for. msg.projectId narrows
    // to a single project exactly like cyboflow_list_tasks does.
    const tree = selectProjectBacklog(this.db, msg.projectId ?? null);
    const flat: BacklogTaskItem[] = [];
    for (const item of tree) {
      flat.push(item);
      if (item.type === 'epic' && item.children) {
        flat.push(...item.children);
      }
    }

    const includeArchived = msg.includeArchived ?? false;
    const includeDone = msg.includeDone ?? false;
    const filtered = flat.filter((item) => {
      if (item.archived_at !== null && !includeArchived) return false;
      const isDoneOrRetired = item.isDone === true || item.decomposed_at !== null;
      if (isDoneOrRetired && !includeDone) return false;
      if (msg.taskType !== undefined && item.type !== msg.taskType) return false;
      return true;
    });

    // Cross-project rows need project_id on the wire (the run-scoped
    // toCompactTask omits it — a single-project caller already knows its own
    // project); spread + add rather than duplicate the whole projection.
    const tasks = filtered.map((item) => ({
      ...McpQueryHandler.toCompactTask(item),
      project_id: item.project_id,
    }));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { tasks, total: tasks.length, hidden_count: flat.length - tasks.length },
    });
  }

  private handleAgentEntity(
    msg: Extract<McpQueryMessage, { type: 'mcp-entity' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    let item = selectTaskById(this.db, msg.taskId);
    if (!item) {
      const resolvedId =
        msg.projectId !== undefined
          ? resolveBacklogRef(this.db, msg.projectId, msg.taskId)
          : this.resolveBacklogRefAnyProject(msg.taskId);
      if (resolvedId) item = selectTaskById(this.db, resolvedId);
    }

    if (!item || (msg.projectId !== undefined && item.project_id !== msg.projectId)) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }

    // Hide experiment-sandboxed drafts (migration 053): a run-scoped
    // handleGetTask scopes this to the owning arm; the global agent has no
    // arm of its own to scope against, so a tagged row is never safe to
    // surface here — treat it exactly like a genuine miss.
    if (item.experiment_id) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }

    const task = McpQueryHandler.toFullTask(item);
    if (item.type === 'idea') {
      const attachments = selectIdeaAttachments(this.db, item.id);
      task['attachments'] = McpQueryHandler.toMcpAttachments(attachments);
    }

    this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: true, data: { task } });
  }

  private handleAgentQueue(
    msg: Extract<McpQueryMessage, { type: 'mcp-queue' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!(msg.includeResolved ?? false)) {
      clauses.push("status = 'pending'");
    }
    if (msg.projectId !== undefined) {
      clauses.push('project_id = ?');
      params.push(msg.projectId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    // Capped at 200 — an inbox digest, not an exhaustive dump.
    const rows = this.db
      .prepare(`SELECT * FROM review_items ${where} ORDER BY created_at ASC, id ASC LIMIT 200`)
      .all(...params) as ReviewItemDbRow[];
    const items = rows.map((r) => ReviewItemRouter.shapeRow(r));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { items, total: items.length },
    });
  }

  private handleAgentWorkflows(
    msg: Extract<McpQueryMessage, { type: 'mcp-workflows' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // Same exclusion + "must resolve to a usable definition" filter as
    // WorkflowRegistry.listByProject, but scanning every project at once
    // (or one project when msg.projectId narrows) rather than unioning
    // (project_id = ? OR project_id IS NULL) per-project — there is no
    // per-project repetition to dedupe here.
    const excluded = [QUICK_WORKFLOW_NAME, ...LEGACY_DROPPED_WORKFLOW_NAMES];
    const placeholders = excluded.map(() => '?').join(', ');
    const clauses = [`name NOT IN (${placeholders})`];
    const params: unknown[] = [...excluded];
    if (msg.projectId !== undefined) {
      clauses.push('(project_id = ? OR project_id IS NULL)');
      params.push(msg.projectId);
    }
    const rows = this.db
      .prepare(
        `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, tuning_level, runtime_mix, created_at, archived_at
           FROM workflows
          WHERE ${clauses.join(' AND ')}
          ORDER BY name`,
      )
      .all(...params) as WorkflowRow[];
    const usable = rows.filter(
      (row) => resolveEffectiveDefinition(row.name, row.spec_json, row.tuning_level) !== null,
    );

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflows: usable.map((r) => McpQueryHandler.toCompactWorkflow(r)) },
    });
  }

  private handleAgentWorkflow(
    msg: Extract<McpQueryMessage, { type: 'mcp-workflow' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const row = this.readWorkflowRow(msg.workflowId);
    if (!row) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    const definition = resolveEffectiveDefinition(row.name, row.spec_json, row.tuning_level);
    const baselineRow = this.db
      .prepare(
        'SELECT baseline_in_rotation AS inRotation, baseline_rotation_weight AS weight FROM workflows WHERE id = ?',
      )
      .get(msg.workflowId) as { inRotation: number; weight: number } | undefined;

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        workflow: McpQueryHandler.toCompactWorkflow(row),
        definition,
        baseline_rotation: baselineRow ? { inRotation: baselineRow.inRotation === 1, weight: baselineRow.weight } : null,
        // CAS material for a future cyboflow_propose_action{kind:'edit-workflow'}
        // call — null only when the row is a broken custom flow with no
        // resolvable definition (definition is also null in that case).
        spec_hash: definition !== null ? computeSpecHash(definition) : null,
      },
    });
  }

  private handleProposeAction(
    msg: Extract<McpQueryMessage, { type: 'mcp-propose-action' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const store = this.deps.agentThreadStore;
    if (!store) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'agent_thread_store_unavailable',
      });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(msg.payloadJson);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_json' });
      return;
    }
    const payload = parseAgentProposalPayload(raw);
    if (!payload) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_payload' });
      return;
    }

    // Preconditions are ALWAYS captured server-side here — the wire payload
    // carries no precondition field for the caller to even attempt to spoof;
    // this re-read is what makes that true rather than merely documented.
    let preconditions: AgentProposalPreconditions | null = null;
    if (payload.kind === 'edit-workflow') {
      const row = this.readWorkflowRow(payload.workflowId);
      if (!row) {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'workflow_not_found' });
        return;
      }
      // The EFFECTIVE definition (migration 122) — must match what the proposal
      // executor's `readEffectiveWorkflowSpec` re-reads at apply time, or the
      // CAS hash never matches and every edit-workflow proposal is refused.
      const definition = resolveEffectiveDefinition(row.name, row.spec_json, row.tuning_level);
      if (definition === null) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'workflow_unresolvable',
        });
        return;
      }
      preconditions = { kind: 'edit-workflow', specHash: computeSpecHash(definition) };
    } else if (payload.kind === 'reprioritize-backlog') {
      const expectedVersions: Record<string, number> = {};
      for (const item of payload.items) {
        const identity = this.readTaskIdentity(item.taskId);
        if (!identity) {
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: msg.requestId,
            ok: false,
            error: `task_not_found:${item.taskId}`,
          });
          return;
        }
        expectedVersions[item.taskId] = identity.version;
      }
      preconditions = { kind: 'reprioritize-backlog', expectedVersions };
    } else if (payload.kind === 'open-session') {
      // No preconditions (shared type contract), but the navigation target IS
      // enriched here with its OWNING project, resolved server-side from the
      // run/session row itself — never trust a caller-supplied projectId
      // (parseAgentNavigationTarget never even copies one out of the wire
      // payload, so this is the only source). The renderer
      // (frontend/src/components/agentRail/proposalNavigation.ts) activates
      // this project before dispatching navigation, since the global agent is
      // cross-project by design and the target run/session may not belong to
      // whatever project happens to be active when the card is confirmed. A
      // target that does not resolve to a real row is an agent mistake, not
      // something to persist as a broken card — reject the proposal outright
      // rather than let it round-trip a stale/typo'd id.
      const nav = payload.navigation;
      if (nav.target === 'run') {
        const row = this.db.prepare('SELECT project_id FROM workflow_runs WHERE id = ?').get(nav.runId) as
          | { project_id?: unknown }
          | undefined;
        if (!row || typeof row.project_id !== 'number') {
          this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'run_not_found' });
          return;
        }
        payload.navigation = { target: 'run', runId: nav.runId, projectId: row.project_id };
      } else {
        const row = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(nav.sessionId) as
          | { project_id?: unknown }
          | undefined;
        if (!row || typeof row.project_id !== 'number') {
          this.writeResponse(client, {
            type: 'mcp-query-response',
            requestId: msg.requestId,
            ok: false,
            error: 'session_not_found',
          });
          return;
        }
        payload.navigation =
          nav.runId !== undefined
            ? { target: 'quick-session', sessionId: nav.sessionId, runId: nav.runId, projectId: row.project_id }
            : { target: 'quick-session', sessionId: nav.sessionId, projectId: row.project_id };
      }
    } else if (payload.kind === 'create-backlog-items') {
      // No preconditions (a create has no prior version to race against), but the
      // project and every EXISTING entity the batch links to are validated here —
      // and each link is normalized from a display ref to an opaque id, the same
      // resolveBacklogRef pass handleCreateTask makes. Rejecting now, at propose
      // time, is what keeps a confirmed card from dying on a typo'd parent long
      // after the human approved it.
      const projectExists =
        this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(payload.projectId) !== undefined;
      if (!projectExists) {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'project_not_found' });
        return;
      }
      for (const item of payload.items) {
        if (item.parentEpicId !== undefined) {
          const resolved = this.resolveExistingEntity(payload.projectId, item.parentEpicId, 'epic');
          if (!resolved) {
            this.writeResponse(client, {
              type: 'mcp-query-response',
              requestId: msg.requestId,
              ok: false,
              error: `parent_epic_not_found:${item.parentEpicId}`,
            });
            return;
          }
          item.parentEpicId = resolved;
        }
        if (item.originatingIdeaId !== undefined) {
          const resolved = this.resolveExistingEntity(payload.projectId, item.originatingIdeaId, 'idea');
          if (!resolved) {
            this.writeResponse(client, {
              type: 'mcp-query-response',
              requestId: msg.requestId,
              ok: false,
              error: `originating_idea_not_found:${item.originatingIdeaId}`,
            });
            return;
          }
          item.originatingIdeaId = resolved;
        }
      }
    }
    // launch-run carries no preconditions (shared type contract).

    const proposal = store.createProposal({ threadId: ctx.threadId, payload, preconditions });
    store.appendEvent(
      ctx.threadId,
      'proposal-created',
      JSON.stringify({ proposalId: proposal.id, kind: proposal.kind }),
    );

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { proposalId: proposal.id },
    });
  }

  /**
   * Returns the cached readonly sibling connection, opening it on first use.
   * Throws (never returns a connection able to write) when `this.db.name` is
   * absent/empty or ':memory:' — an in-memory or adapter-less DatabaseLike
   * has no on-disk file for a sibling connection to point at (this is the
   * common shape in unit tests that don't go through makeDatabaseLike/
   * dbAdapter). Read-only is enforced BY CONSTRUCTION here via `{ readonly:
   * true }` — SQLite itself refuses any write attempted through this handle,
   * independent of validateReadonlySql's statement-shape checks.
   */
  private getGlobalAgentReadonlyDb(): BetterSqlite3Database.Database {
    if (this.globalAgentReadonlyDb) return this.globalAgentReadonlyDb;
    const dbPath = this.db.name;
    if (!dbPath || dbPath === ':memory:') {
      throw new Error('db_query_unavailable: no on-disk database file for this connection');
    }
    this.globalAgentReadonlyDb = new BetterSqlite3Database(dbPath, { readonly: true, fileMustExist: true });
    return this.globalAgentReadonlyDb;
  }

  private handleAgentDbQuery(
    msg: Extract<McpQueryMessage, { type: 'mcp-db-query' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const validation = validateReadonlySql(msg.sql);
    if (!validation.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: validation.reason });
      return;
    }

    // Errors from here (unreachable db file, sqlite syntax errors, unknown
    // tables, or SQLite's own readonly-connection write refusal) are left to
    // propagate — handleMessage's outer try/catch turns them into a
    // structured ok:false response carrying sqlite's message, same as every
    // other handler in this file.
    const readonlyDb = this.getGlobalAgentReadonlyDb();
    const stmt = readonlyDb.prepare(validation.sql);

    if (!stmt.reader) {
      // A non-reader statement (e.g. a write form that slipped past
      // validateReadonlySql, such as `WITH x AS (SELECT 1) INSERT ...`) is
      // NEVER executed — calling .run() is exactly the write attempt the
      // readonly connection exists to prevent, so we simply decline rather
      // than let SQLite throw mid-write.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { columns: [], rows: [], rowCount: 0, truncated: false, note: 'statement returned no rows' },
      });
      return;
    }

    const columns = stmt.columns().map((c) => c.name);
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    let payloadBytes = 0;
    for (const rawRow of stmt.iterate()) {
      if (rows.length >= DB_QUERY_MAX_ROWS) {
        truncated = true;
        break;
      }
      const sanitized = sanitizeDbQueryRow(rawRow as Record<string, unknown>);
      const size = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
      if (rows.length > 0 && payloadBytes + size > DB_QUERY_MAX_PAYLOAD_BYTES) {
        truncated = true;
        break;
      }
      rows.push(sanitized);
      payloadBytes += size;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { columns, rows, rowCount: rows.length, truncated },
    });
  }

  // --------------------------------------------------------------------------
  // Global-agent filesystem tools (cyboflow_fs_read / _list / _grep)
  //
  // READ-ONLY and FOLDER-SCOPED. Enforcement is entirely server-side here — the
  // agent's isolation contract (tools:[], PreToolUse allowing only
  // mcp__cyboflow__*) is untouched. The allowed roots are the registered
  // project paths PLUS the user-configured assistantFolderAccess extras; every
  // target is canonicalized with realpathSync and must land inside a
  // canonicalized root (defeating symlink escapes), and read/grep content
  // access additionally refuses secret files even when they are in scope.
  // --------------------------------------------------------------------------

  /**
   * The canonicalized set of folders the fs tools may read: every registered
   * `projects.path` plus every `getAssistantFolderAccess()` extra, each passed
   * through realpathSync (so a symlinked root is compared as its real target).
   * Roots that don't exist on disk are DROPPED rather than throwing — a stale
   * project row must never break the tools for the live folders. Cheap enough
   * to recompute per call (no caching).
   */
  private resolveFsAllowedRoots(): string[] {
    const raw = new Set<string>();
    // Project folders the user toggled off — subtracted from the project roots
    // below (compared by the raw stored path, exactly what the Settings UI
    // toggles off). Extras are never excluded.
    const excludedProjects = new Set(this.deps.getAssistantExcludedProjectPaths?.() ?? []);
    try {
      const rows = this.db.prepare('SELECT path FROM projects').all() as Array<{ path?: unknown }>;
      for (const row of rows) {
        if (typeof row.path === 'string' && row.path.length > 0 && !excludedProjects.has(row.path)) {
          raw.add(row.path);
        }
      }
    } catch {
      // A missing projects table (bare test fixture) simply yields no project
      // roots — the configured extras still apply.
    }
    const extras = this.deps.getAssistantFolderAccess?.() ?? [];
    for (const entry of extras) {
      if (typeof entry === 'string' && entry.length > 0) raw.add(entry);
    }
    const canonical: string[] = [];
    for (const root of raw) {
      try {
        canonical.push(realpathSync(root));
      } catch {
        // Skip a root that no longer exists — never throw.
      }
    }
    return canonical;
  }

  /**
   * Resolve + scope-check a requested path for the fs tools. Canonicalizes with
   * realpathSync (a nonexistent target throws → 'not_found') then requires the
   * real path to be inside one of the allowed roots (else 'scope_denied', whose
   * message names the roots so the model can self-correct). Shared by all three
   * fs handlers.
   */
  private resolveFsTarget(
    requestedPath: unknown,
  ):
    | { ok: true; real: string; roots: string[] }
    | { ok: false; error: string } {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      return { ok: false, error: 'invalid_arguments: path must be a non-empty string' };
    }
    const roots = this.resolveFsAllowedRoots();
    let real: string;
    try {
      real = realpathSync(requestedPath);
    } catch {
      return { ok: false, error: 'not_found' };
    }
    if (!isPathWithinRoots(real, roots)) {
      const rootList = roots.length > 0 ? roots.join(', ') : '(none registered)';
      return { ok: false, error: `scope_denied (allowed roots: ${rootList})` };
    }
    return { ok: true, real, roots };
  }

  /** True when a file's first BINARY_SNIFF_BYTES contain a NUL byte. */
  private fileLooksBinary(absPath: string): boolean {
    const fd = openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const read = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
      return bufferLooksBinary(buf.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  }

  private handleFsRead(
    msg: Extract<McpQueryMessage, { type: 'mcp-fs-read' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const resolved = this.resolveFsTarget(msg.path);
    if (!resolved.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: resolved.error });
      return;
    }
    if (isSecretPath(resolved.real)) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'denied_secret_pattern' });
      return;
    }
    let stat: Stats;
    try {
      stat = statSync(resolved.real);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    if (stat.isDirectory()) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'is_a_directory' });
      return;
    }
    if (this.fileLooksBinary(resolved.real)) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'binary_file' });
      return;
    }

    const buffer = readFileSync(resolved.real);
    const totalBytes = buffer.length;

    // Line-window paging (1-based offsetLine) for large files, else a raw
    // byte-capped slice. Either way the returned content is floored at
    // FS_READ_MAX_BYTES with `truncated` set when content was dropped.
    let content: string;
    let truncated = false;
    const hasLineWindow =
      (typeof msg.offsetLine === 'number' && msg.offsetLine > 0) ||
      (typeof msg.limitLines === 'number' && msg.limitLines > 0);
    if (hasLineWindow) {
      const lines = buffer.toString('utf8').split('\n');
      const start = typeof msg.offsetLine === 'number' && msg.offsetLine > 0 ? msg.offsetLine - 1 : 0;
      const count = typeof msg.limitLines === 'number' && msg.limitLines > 0 ? msg.limitLines : lines.length;
      const windowText = lines.slice(start, start + count).join('\n');
      if (start + count < lines.length || start > 0) truncated = true;
      const windowBuf = Buffer.from(windowText, 'utf8');
      if (windowBuf.length > FS_READ_MAX_BYTES) {
        content = windowBuf.subarray(0, FS_READ_MAX_BYTES).toString('utf8');
        truncated = true;
      } else {
        content = windowText;
      }
    } else if (totalBytes > FS_READ_MAX_BYTES) {
      content = buffer.subarray(0, FS_READ_MAX_BYTES).toString('utf8');
      truncated = true;
    } else {
      content = buffer.toString('utf8');
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { path: resolved.real, content, truncated, totalBytes },
    });
  }

  private handleFsList(
    msg: Extract<McpQueryMessage, { type: 'mcp-fs-list' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const resolved = this.resolveFsTarget(msg.path);
    if (!resolved.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: resolved.error });
      return;
    }
    let stat: Stats;
    try {
      stat = statSync(resolved.real);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    if (!stat.isDirectory()) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_a_directory' });
      return;
    }

    // Listing is metadata-only (NOT secret-filtered): a secret file's name is
    // surfaced but its content stays unreachable via read/grep.
    const dirents = readdirSync(resolved.real, { withFileTypes: true });
    const entries: Array<{ name: string; type: 'file' | 'dir' | 'symlink'; size: number }> = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (entries.length >= FS_LIST_MAX_ENTRIES) {
        truncated = true;
        break;
      }
      let type: 'file' | 'dir' | 'symlink';
      if (dirent.isSymbolicLink()) type = 'symlink';
      else if (dirent.isDirectory()) type = 'dir';
      else type = 'file';
      let size = 0;
      try {
        // lstat so a symlink (esp. a broken one) reports its own size, never
        // its (possibly out-of-scope / missing) target.
        size = lstatSync(path.join(resolved.real, dirent.name)).size;
      } catch {
        size = 0;
      }
      entries.push({ name: dirent.name, type, size });
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { path: resolved.real, entries, truncated },
    });
  }

  private handleFsGrep(
    msg: Extract<McpQueryMessage, { type: 'mcp-fs-grep' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    if (typeof msg.pattern !== 'string' || msg.pattern.length === 0) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_arguments: pattern must be a non-empty string' });
      return;
    }
    const resolved = this.resolveFsTarget(msg.path);
    if (!resolved.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: resolved.error });
      return;
    }

    let regex: RegExp;
    try {
      regex = new RegExp(msg.pattern, msg.caseSensitive === true ? '' : 'i');
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_regex' });
      return;
    }

    const maxResults = Math.max(
      1,
      Math.min(
        typeof msg.maxResults === 'number' && msg.maxResults > 0 ? Math.floor(msg.maxResults) : FS_GREP_MAX_RESULTS,
        FS_GREP_MAX_RESULTS,
      ),
    );
    const globRe = compileBasenameGlob(typeof msg.glob === 'string' ? msg.glob : '');

    const matches: Array<{ file: string; line: number; text: string }> = [];
    let filesScanned = 0;
    let truncated = false;

    // Grep a single file's content into `matches`. Returns false to signal the
    // caller to stop the whole walk (a cap was hit).
    const grepFile = (absPath: string): boolean => {
      let content: string;
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        return true; // unreadable — skip, keep walking
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[i])) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }
        const raw = lines[i];
        matches.push({
          file: absPath,
          line: i + 1,
          text: raw.length > FS_GREP_MAX_LINE_LEN ? `${raw.slice(0, FS_GREP_MAX_LINE_LEN)}…` : raw,
        });
      }
      return true;
    };

    // Depth-first walk with its OWN recursion — never follows symlinks (dir or
    // file) and skips GREP_SKIP_DIRS. Returns false when a cap stops the walk.
    const walk = (dir: string): boolean => {
      let dirents: Dirent[];
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        return true; // unreadable dir — skip
      }
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) continue; // never follow symlinks
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (GREP_SKIP_DIRS.has(dirent.name)) continue;
          if (!walk(full)) return false;
          continue;
        }
        if (!dirent.isFile()) continue;
        if (!matchesBasenameGlob(dirent.name, globRe)) continue;
        if (isSecretPath(full)) continue; // deny content of secret files
        if (filesScanned >= FS_GREP_MAX_FILES) {
          truncated = true;
          return false;
        }
        filesScanned += 1;
        try {
          // Oversized files are skipped outright — grepFile reads the whole
          // file into memory, so a giant in-scope log must not balloon the
          // main process.
          if (lstatSync(full).size > FS_GREP_MAX_FILE_BYTES) continue;
          if (this.fileLooksBinary(full)) continue; // skip binaries
        } catch {
          continue;
        }
        if (!grepFile(full)) return false;
      }
      return true;
    };

    let rootStat: Stats;
    try {
      rootStat = statSync(resolved.real);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }
    if (rootStat.isDirectory()) {
      walk(resolved.real);
    } else if (rootStat.isFile()) {
      // A single-file grep target: apply the same secret guard directly.
      if (isSecretPath(resolved.real)) {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'denied_secret_pattern' });
        return;
      }
      if (matchesBasenameGlob(path.basename(resolved.real), globRe)) {
        filesScanned += 1;
        try {
          if (
            lstatSync(resolved.real).size <= FS_GREP_MAX_FILE_BYTES &&
            !this.fileLooksBinary(resolved.real)
          ) {
            grepFile(resolved.real);
          }
        } catch {
          /* unreadable — leave matches empty */
        }
      }
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { matches, truncated, filesScanned },
    });
  }

  /**
   * cyboflow_history (mcp-history) — READ-ONLY search/paging over the CALLING
   * assistant thread's own `agent_thread_events` rows.
   *
   * THREAD SCOPING IS THE LOAD-BEARING GUARANTEE: `thread_id` is bound from
   * resolveGlobalAgentContext(msg.runId), which rejects any non-`agent:` runId
   * BEFORE a single DB read (mirroring handleAgentQueue). There is no
   * caller-supplied thread argument at all, so no argument can widen the scope
   * past the thread that is asking.
   *
   * TWO MODES over one walk:
   *   search (query given) — keep turns whose decoded text contains the
   *                          case-insensitive substring, each returned as an
   *                          excerpt around its FIRST occurrence, `matched:
   *                          true`. Plain indexOf, NEVER a caller regex — see
   *                          the mcp-history union member's doc for why.
   *   browse (no query)    — keep every decoded turn, head-truncated.
   *
   * The walk pages id-DESCENDING in HISTORY_BATCH_ROWS batches (never
   * `SELECT *` over the whole table — this table is append-only and permanent)
   * and stops at the first cap it hits: HISTORY_MAX_SCAN_ROWS rows examined,
   * HISTORY_MAX_PAYLOAD_BYTES of serialized turns, or a (limit+1)th qualifying
   * turn FOUND — the page is full and that unreturned find is the proof more
   * exists. Any of those sets `truncated` and reports `nextBeforeId` — the id
   * of the last FULLY PROCESSED row — so a follow-up call resumes exactly
   * where this one stopped, never re-emitting and never skipping. A walk that
   * fills the page exactly and then runs out of rows is NOT truncated: the
   * scan keeps going after the limit is reached purely to learn whether more
   * qualifying turns exist (bounded by the same scan cap), so `truncated:true`
   * always means "there is more". Rows running out ends the walk with
   * `truncated:false`, `nextBeforeId:null`.
   *
   * Rows whose payload carries no turn text (SDK tool_result plumbing, tool_use
   * -only assistant events, corrupt JSON) decode to null and are skipped — they
   * still count toward `scanned`, which is why the scan cap exists separately
   * from `limit`.
   */
  private handleAgentHistory(
    msg: Extract<McpQueryMessage, { type: 'mcp-history' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // --- argument validation ------------------------------------------------
    if (msg.role !== undefined && msg.role !== 'user' && msg.role !== 'assistant') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: "invalid_arguments: role must be 'user' or 'assistant'",
      });
      return;
    }
    for (const [name, value] of [
      ['daysBack', msg.daysBack],
      ['beforeId', msg.beforeId],
      ['limit', msg.limit],
    ] as const) {
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `invalid_arguments: ${name} must be a positive finite number`,
        });
        return;
      }
    }

    // An omitted OR empty query means browse mode (an empty needle would match
    // every turn, making the two modes differ only in excerpt shape — browsing
    // is the clearer contract for "no search term"). The needle is matched as
    // a case-insensitive PLAIN SUBSTRING via indexOf on lowercased text —
    // deliberately not a RegExp: this handler runs synchronously on the main
    // process, and a model-authored pattern with catastrophic backtracking
    // would wedge the entire app (see the mcp-history union member's doc).
    let needle: string | null = null;
    if (msg.query !== undefined) {
      if (typeof msg.query !== 'string') {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'invalid_arguments: query must be a string',
        });
        return;
      }
      if (msg.query.length > 0) {
        needle = msg.query.toLowerCase();
      }
    }

    const limit = Math.max(
      1,
      Math.min(msg.limit !== undefined ? Math.floor(msg.limit) : HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
    );
    const roleFilter = msg.role;
    // Bound as a PARAMETER to datetime('now', ?) — never interpolated into the
    // SQL text, even though it is derived from a validated number. Clamped to
    // HISTORY_MAX_DAYS_BACK: past the julian-day range datetime() returns NULL
    // and `created_at >= NULL` silently filters out EVERY row (see the
    // constant's doc) — a clamped huge value instead means "the whole table".
    const dayModifier =
      msg.daysBack !== undefined
        ? `-${Math.min(Math.max(1, Math.floor(msg.daysBack)), HISTORY_MAX_DAYS_BACK)} days`
        : null;

    // --- the id-descending walk ---------------------------------------------
    const turns: HistoryTurn[] = [];
    let cursor: number | null = msg.beforeId !== undefined ? Math.floor(msg.beforeId) : null;
    /** Id of the last row processed to completion — the resume point. */
    let lastProcessedId: number | null = null;
    let scanned = 0;
    let payloadBytes = 0;
    let truncated = false;
    let stopped = false;

    while (!stopped) {
      const clauses = [
        'thread_id = ?',
        "event_type IN ('user', 'assistant', 'agent_user', 'agent_assistant')",
      ];
      const params: unknown[] = [ctx.threadId];
      if (cursor !== null) {
        clauses.push('id < ?');
        params.push(cursor);
      }
      if (dayModifier !== null) {
        clauses.push("created_at >= datetime('now', ?)");
        params.push(dayModifier);
      }
      params.push(HISTORY_BATCH_ROWS);

      const rows = this.db
        .prepare(
          `SELECT id, event_type, payload_json, created_at
             FROM agent_thread_events
            WHERE ${clauses.join(' AND ')}
            ORDER BY id DESC
            LIMIT ?`,
        )
        .all(...params) as AgentThreadEventScanRow[];
      if (rows.length === 0) break; // exhausted — no more transcript to page

      for (const row of rows) {
        if (scanned >= HISTORY_MAX_SCAN_ROWS) {
          truncated = true;
          stopped = true;
          break;
        }
        scanned += 1;
        cursor = row.id;

        const turn = extractTurnText(row.event_type, row.payload_json);
        if (turn !== null && (roleFilter === undefined || turn.role === roleFilter)) {
          let text: string;
          let matched = false;
          if (needle !== null) {
            // Lowercase-both indexOf: unconditionally O(n), immune to the
            // backtracking blowups a caller regex could smuggle in. The rare
            // Unicode where toLowerCase changes string length can drift the
            // excerpt window a few chars — excerptAround clamps, so the worst
            // case is a slightly off-center excerpt, never a crash or a miss.
            const matchIndex = turn.text.toLowerCase().indexOf(needle);
            if (matchIndex === -1) {
              lastProcessedId = row.id;
              continue; // searched and missed — row is fully processed
            }
            text = excerptAround(turn.text, matchIndex);
            matched = true;
          } else {
            text = truncateHead(turn.text, TURN_TEXT_MAX_CHARS);
          }

          // Page already full? Then THIS qualifying turn is the proof that
          // more exists: report truncated WITHOUT emitting it, leaving
          // lastProcessedId pointing above it so the next page starts here.
          // (The scan deliberately continues past `limit` to reach this point
          // — an exact-limit walk that runs out of rows instead is complete,
          // not truncated, and never costs the caller a wasted empty page.)
          if (turns.length >= limit) {
            truncated = true;
            stopped = true;
            break;
          }

          const entry: HistoryTurn = {
            eventId: row.id,
            at: row.created_at,
            role: turn.role,
            text,
            ...(matched ? { matched: true } : {}),
          };
          const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
          // A single oversized turn is still returned when it would otherwise
          // be the empty answer — returning nothing would look like "no such
          // memory" rather than "one very long memory".
          if (turns.length > 0 && payloadBytes + entryBytes > HISTORY_MAX_PAYLOAD_BYTES) {
            truncated = true;
            stopped = true;
            break; // row NOT processed — lastProcessedId still points above it
          }
          turns.push(entry);
          payloadBytes += entryBytes;
        }

        lastProcessedId = row.id;
      }

      if (!stopped && rows.length < HISTORY_BATCH_ROWS) break; // short batch = exhausted
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        turns,
        truncated,
        nextBeforeId: truncated ? lastProcessedId : null,
        scanned,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Helper
  // --------------------------------------------------------------------------

  private writeResponse(client: net.Socket, response: McpQueryResponse): void {
    client.write(JSON.stringify(response) + '\n');
  }
}
