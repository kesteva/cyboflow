/**
 * Shared types for the global-agent chat thread (migration 074).
 *
 * A thread is a standing SDK-hosted conversation that lives OUTSIDE the
 * project/run model — there is no workflow_runs sentinel behind it. Events
 * mirror raw_events' shape but are thread-keyed; proposals are the
 * promptable-action cards the agent offers the user, each carrying a
 * per-kind payload and (for the mutating kinds) preconditions checked at
 * CAS-claim time.
 *
 * Keep this file free of Node.js built-ins so it imports in any environment
 * (main process AND renderer).
 */

import type { CyboflowWorkflowName, PermissionMode } from './workflows';
import type { CliSubstrate } from './substrate';
import type { EntityCategory, IdeaScope, Priority, TaskType } from './tasks';
import type { CliTool } from './cliTools';
import type { AgentModelAlias } from './agents';
import {
  isAgentRuntime,
  PROVIDER_DEFAULT_RUNTIME,
  providerForRuntime,
  type AgentProvider,
} from './agentRuntime';

// ---------------------------------------------------------------------------
// Assistant runtime (docs/proposals/ASSISTANT-CODEX-RUNTIME.md §1)
// ---------------------------------------------------------------------------

/**
 * The runtimes the global assistant can be hosted on. A deliberate SUBSET of
 * `ALL_AGENT_RUNTIMES`: the assistant's hermetic spawn contract (isolation,
 * scoped MCP family, injected transcript sink) is implemented by the Claude SDK
 * manager and the Codex app-server manager only. OMP / pi as the user's primary
 * runtime leave the assistant on Claude.
 */
export const ASSISTANT_RUNTIMES = ['claude-sdk', 'codex-sdk'] as const;

export type AssistantRuntime = (typeof ASSISTANT_RUNTIMES)[number];

/** Floor when nothing resolves — the pre-existing (Claude-only) behaviour. */
export const DEFAULT_ASSISTANT_RUNTIME: AssistantRuntime = 'claude-sdk';

export function isAssistantRuntime(value: unknown): value is AssistantRuntime {
  return (ASSISTANT_RUNTIMES as readonly unknown[]).includes(value);
}

/** The provider an assistant runtime spawns through. */
export function assistantRuntimeProvider(runtime: AssistantRuntime): 'claude' | 'codex' {
  return runtime === 'codex-sdk' ? 'codex' : 'claude';
}

export interface ResolveAssistantRuntimeInput {
  /** `AppConfig.assistantRuntime` — the explicit Settings → Assistant pick (may be absent/invalid). */
  assistantRuntime?: unknown;
  /** `AppConfig.defaultAgentRuntime` — the launch default the onboarding "default agent" step writes. */
  defaultAgentRuntime?: string | null;
  /** Provider-access gate (Settings → Integrations); a disabled provider is never resolved. */
  isProviderEnabled: (provider: AgentProvider) => boolean;
}

/**
 * The ONE resolver for "which runtime hosts the assistant", shared by
 * ConfigManager (main) and the renderer so the two never disagree:
 *   1. the explicit `assistantRuntime`, when valid and its provider is enabled;
 *   2. else the provider of `defaultAgentRuntime` mapped through
 *      PROVIDER_DEFAULT_RUNTIME, when that provider is claude|codex and enabled —
 *      this is what lets the onboarding "Codex is my default" choice reach the
 *      assistant with no extra UI;
 *   3. else DEFAULT_ASSISTANT_RUNTIME.
 * Step 3 does NOT consult the Claude access toggle: an install with every
 * provider switched off still needs a deterministic answer, and the spawn seam's
 * own provider gate (assertProviderEnabled) is what refuses the turn.
 */
export function resolveAssistantRuntime(input: ResolveAssistantRuntimeInput): AssistantRuntime {
  if (isAssistantRuntime(input.assistantRuntime)) {
    if (input.isProviderEnabled(assistantRuntimeProvider(input.assistantRuntime))) {
      return input.assistantRuntime;
    }
  }
  // config.json is user-editable: an unknown runtime string is treated as
  // absent rather than routed through the loud `providerForRuntimeValue`.
  const launchProvider = isAgentRuntime(input.defaultAgentRuntime)
    ? providerForRuntime(input.defaultAgentRuntime)
    : null;
  if (launchProvider === 'codex' || launchProvider === 'claude') {
    const candidate = PROVIDER_DEFAULT_RUNTIME[launchProvider];
    if (isAssistantRuntime(candidate) && input.isProviderEnabled(launchProvider)) {
      return candidate;
    }
  }
  return DEFAULT_ASSISTANT_RUNTIME;
}

// ---------------------------------------------------------------------------
// Proposal kind / status enums
// ---------------------------------------------------------------------------

export const AGENT_PROPOSAL_KINDS = [
  'launch-run',
  'reprioritize-backlog',
  'edit-workflow',
  'open-session',
  'create-backlog-items',
  'create-workflow',
] as const;

export type AgentProposalKind = (typeof AGENT_PROPOSAL_KINDS)[number];

export const AGENT_PROPOSAL_STATUSES = [
  'proposed',
  'executing',
  'executed',
  'failed',
  'dismissed',
  'superseded',
] as const;

export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Thread + event shapes (mirror agent_threads / agent_thread_events columns)
// ---------------------------------------------------------------------------

/** 'global' today; Stage 3 widens this to a run-scoped `'run:<runId>'` form. */
export type AgentThreadScope = 'global';

// ---------------------------------------------------------------------------
// Context retention strategy
// ---------------------------------------------------------------------------

/**
 * How the assistant's standing SDK conversation is treated at each LOCAL-day
 * boundary (checked on the first turn of a new day, digest or human):
 *   - 'clear-daily'   — start a fresh conversation (the stored resume id is
 *                       dropped; the durable UI transcript in agent_thread_events
 *                       is untouched). The default: each day starts clean.
 *   - 'compact-daily' — keep the conversation but fire a `/compact` turn first,
 *                       so each day starts from a compacted context.
 *   - 'auto-compact'  — do nothing; rely on the SDK's built-in auto-compaction.
 */
export const ASSISTANT_CONTEXT_RETENTION_MODES = [
  'clear-daily',
  'compact-daily',
  'auto-compact',
] as const;

export type AssistantContextRetention = (typeof ASSISTANT_CONTEXT_RETENTION_MODES)[number];

/** Floor applied on read for an absent/invalid stored value. */
export const DEFAULT_ASSISTANT_CONTEXT_RETENTION: AssistantContextRetention = 'clear-daily';

export function isAssistantContextRetention(value: unknown): value is AssistantContextRetention {
  return (ASSISTANT_CONTEXT_RETENTION_MODES as readonly unknown[]).includes(value);
}

export interface AgentThread {
  id: string;
  scope: AgentThreadScope;
  model: string | null;
  /**
   * The provider-owned conversation id threaded back as the warm-resume handle.
   * The column name `claude_session_id` is FROZEN (migration 074) and the field
   * keeps it, but the id is no longer necessarily Claude's — see
   * {@link AgentThread.sessionRuntime}.
   */
  claudeSessionId: string | null;
  /**
   * Which runtime {@link AgentThread.claudeSessionId} was captured under
   * (migration 131). The two providers' conversation ids are NOT interchangeable
   * — handing a Claude session id to Codex's `thread/resume`, or the reverse,
   * fails the turn — so AgentThreadService clears the stored id and cold-starts
   * whenever the resolved assistant runtime differs from this. NULL means no
   * runtime was recorded (every thread predating the column, all of which were
   * necessarily Claude), and is treated as "no mismatch".
   */
  sessionRuntime: AssistantRuntime | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentThreadEvent {
  id: number;
  threadId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Spawn identity (panelId === sessionId === runId for a global-agent thread)
// ---------------------------------------------------------------------------

/**
 * Prefix for the synthetic spawn identity of a global-agent thread:
 * `agent:<threadId>`. The thread's SDK conversation spawns with
 * panelId === sessionId === runId === this identity — no
 * sessions/panels/workflow_runs row exists for it by design, so any
 * Crystal-era session/panel validation must treat an id carrying this prefix
 * as exempt rather than log a "not found" failure against those tables.
 */
export const AGENT_THREAD_SPAWN_PREFIX = 'agent:';

/**
 * True iff `id` is a global-agent thread's synthetic spawn identity — starts
 * with {@link AGENT_THREAD_SPAWN_PREFIX} and has a non-empty threadId
 * remainder. `'agent:'` alone (empty remainder) does not count.
 */
export function isAgentThreadSpawnId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(AGENT_THREAD_SPAWN_PREFIX) && id.length > AGENT_THREAD_SPAWN_PREFIX.length;
}

// ---------------------------------------------------------------------------
// Navigation target (open-session proposal)
// ---------------------------------------------------------------------------

/**
 * Where an 'open-session' proposal navigates. An idle quick session has no
 * live run, so it must route through setActiveQuickSession — never
 * setActiveRun — hence the two-armed discriminant instead of a single runId.
 */
export type AgentNavigationTarget =
  | {
      target: 'run';
      runId: string;
      /**
       * Resolved server-side at propose time (never trust a caller-supplied
       * value); the renderer activates this project before dispatching
       * navigation, since the global agent is cross-project by design and the
       * target run may not belong to the CURRENTLY active project.
       */
      projectId?: number;
    }
  | {
      target: 'quick-session';
      sessionId: string;
      runId?: string;
      /**
       * Resolved server-side at propose time (never trust a caller-supplied
       * value); the renderer activates this project before dispatching
       * navigation, since the global agent is cross-project by design and the
       * target session may not belong to the CURRENTLY active project.
       */
      projectId?: number;
    };

// ---------------------------------------------------------------------------
// Per-kind proposal payloads
// ---------------------------------------------------------------------------

export interface LaunchRunProposalPayload {
  kind: 'launch-run';
  projectId: number;
  workflowName: CyboflowWorkflowName;
  substrate?: CliSubstrate;
  taskIds?: string[];
  ideaIds?: string[];
  findingIds?: string[];
  note?: string;
}

/** One backlog task's proposed priority/stage move within a reprioritize-backlog proposal. */
export interface ReprioritizeBacklogItem {
  taskId: string;
  priority?: Priority;
  stageId?: string;
}

export interface ReprioritizeBacklogProposalPayload {
  kind: 'reprioritize-backlog';
  projectId: number;
  items: ReprioritizeBacklogItem[];
}

export interface EditWorkflowProposalPayload {
  kind: 'edit-workflow';
  workflowId: string;
  definitionJson: string;
  summary?: string;
}

export interface OpenSessionProposalPayload {
  kind: 'open-session';
  navigation: AgentNavigationTarget;
}

/**
 * One backlog entity the assistant proposes CREATING (idea / epic / task).
 * Field names mirror the TaskChangeRouter create-path fields (main/src/
 * orchestrator/taskChangeRouter.ts `TaskChange`) so the executor's mapping onto
 * that chokepoint is one-to-one.
 *
 * `parentEpicId` / `originatingIdeaId` may only reference entities that ALREADY
 * exist — a batch cannot link one of its own members to another, because the
 * ids of the entities this proposal creates do not exist until the human
 * confirms it. The propose handler resolves both from a display ref
 * (`EPIC-002` / `IDEA-009`) to an opaque id server-side and rejects the
 * proposal outright when one does not resolve, so a confirmed card never dies
 * on a typo'd parent.
 */
export interface CreateBacklogItem {
  /** Which entity table to create in. Required — the assistant must be explicit. */
  taskType: TaskType;
  title: string;
  /** Short one-line board caption. */
  summary?: string;
  /** Full markdown body — the spec / description + acceptance criteria. */
  body?: string;
  /** Defaults to 'P2' at the chokepoint when omitted. */
  priority?: Priority;
  /** Defaults to 'feature' at the chokepoint when omitted. */
  category?: EntityCategory;
  /** Ideas only; ignored by the chokepoint for epics/tasks. */
  scope?: IdeaScope;
  /** Tasks only — an EXISTING epic (opaque id or ref, resolved server-side). */
  parentEpicId?: string;
  /** Epics/tasks only — an EXISTING idea (opaque id or ref, resolved server-side). */
  originatingIdeaId?: string;
}

export interface CreateBacklogItemsProposalPayload {
  kind: 'create-backlog-items';
  projectId: number;
  items: CreateBacklogItem[];
}

/**
 * The scope a create-workflow proposal mints its flow in. `'project'` (the
 * default) pins the flow to `projectId`, which is also where its agents live;
 * `'global'` shares the flow across every project — only sensible when the
 * definition binds NO new agents, since custom agents are project-scoped
 * (`agent_overrides`) and a global flow bound to one would only spawn in the
 * project that owns it.
 */
export type CreateWorkflowScope = 'project' | 'global';

/**
 * One custom agent the assistant proposes CREATING alongside a new workflow.
 * Field names mirror the `AgentOverrideRouter` createCustom-path fields
 * (`main/src/orchestrator/agentOverrideRouter.ts` `AgentCreateCustomChange`)
 * so the executor's mapping onto that chokepoint is one-to-one.
 *
 * The agent KEY the workflow's steps bind to is DERIVED from `name` the same
 * way the chokepoint derives it (lower-case, non-alphanumerics collapsed to
 * single hyphens) — `"Docs Writer"` → `docs-writer`. The propose handler
 * derives the same key and checks every step binding against it, so a
 * confirmed card never mints an agent no step can reach.
 */
export interface CreateWorkflowAgent {
  /** Display name; the kebab agent key is derived from it. */
  name: string;
  /** Non-empty one-liner (rendered as the subagent's description). */
  description: string;
  /** The full system prompt (no frontmatter fence; must not reference cyboflow_* writers). */
  systemPrompt: string;
  /** At least one CLI tool. */
  tools: CliTool[];
  /** MCP server names this agent may call; defaults to none. */
  enabledMcps?: string[];
  /** Optional role caption. */
  role?: string;
  /** Pinned model alias; omitted inherits the run model. */
  model?: AgentModelAlias;
}

/**
 * Create a brand-new CUSTOM workflow, optionally minting the custom agents its
 * steps bind to in the same confirm. The definition is validated with the
 * strict write-path schema at PROPOSE time (so a malformed graph is rejected
 * before a card exists, not after the human confirms it), and every step's
 * `agent` must resolve to a builtin key, the `human` gate, an EXISTING custom
 * agent of `projectId`, or one of `agents`.
 */
export interface CreateWorkflowProposalPayload {
  kind: 'create-workflow';
  /** The project whose agents the flow binds; also the flow's home when scope is 'project'. */
  projectId: number;
  /** The flow's display name (Windows-safe, not a built-in name, unique in scope). */
  name: string;
  /** JSON-encoded WorkflowDefinition (the complete graph, never a partial). */
  definitionJson: string;
  /** Defaults to 'project'. */
  scope?: CreateWorkflowScope;
  /** Defaults to 'default'. */
  permissionMode?: PermissionMode;
  /** Custom agents to create BEFORE the flow, so its bindings resolve on first run. */
  agents?: CreateWorkflowAgent[];
  /** One-line human summary rendered on the card. */
  summary?: string;
}

export type AgentProposalPayload =
  | LaunchRunProposalPayload
  | ReprioritizeBacklogProposalPayload
  | EditWorkflowProposalPayload
  | OpenSessionProposalPayload
  | CreateBacklogItemsProposalPayload
  | CreateWorkflowProposalPayload;

// ---------------------------------------------------------------------------
// Per-kind proposal preconditions
// ---------------------------------------------------------------------------

/** CAS material for edit-workflow: the spec hash the proposal was drafted against. */
export interface EditWorkflowPreconditions {
  kind: 'edit-workflow';
  specHash: string;
}

/** CAS material for reprioritize-backlog: each task's expected version at draft time. */
export interface ReprioritizeBacklogPreconditions {
  kind: 'reprioritize-backlog';
  expectedVersions: Record<string, number>;
}

/**
 * launch-run, open-session, create-backlog-items, and create-workflow carry no
 * preconditions — nothing to CAS-check (a create has no prior version to race
 * against; the parent/lineage links and agent bindings it references are
 * validated at propose time instead, and a name that gets taken in between is
 * a plain executor failure).
 */
export type AgentProposalPreconditions = EditWorkflowPreconditions | ReprioritizeBacklogPreconditions;

// ---------------------------------------------------------------------------
// Proposal row (mirrors agent_proposals columns; JSON columns parsed on read)
// ---------------------------------------------------------------------------

export interface AgentProposal {
  id: string;
  threadId: string;
  kind: AgentProposalKind;
  payload: AgentProposalPayload;
  preconditions: AgentProposalPreconditions | null;
  status: AgentProposalStatus;
  /** Parsed result_json; null when the proposal hasn't been finalized yet. */
  result: unknown;
  idempotencyKey: string | null;
  createdAt: string;
  decidedAt: string | null;
}

// ---------------------------------------------------------------------------
// Composer image attachments
// ---------------------------------------------------------------------------

/**
 * The image media types the assistant composer accepts — exactly the set the
 * Anthropic Messages API's base64 `image` content block supports. Narrowed at
 * the composer (attach time) AND re-validated by the tRPC input schema, so a
 * renderer bug can never hand the SDK a `media_type` it will reject mid-turn.
 */
export const AGENT_THREAD_IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type AgentThreadImageMediaType = (typeof AGENT_THREAD_IMAGE_MEDIA_TYPES)[number];

export function isAgentThreadImageMediaType(value: unknown): value is AgentThreadImageMediaType {
  return (AGENT_THREAD_IMAGE_MEDIA_TYPES as readonly unknown[]).includes(value);
}

/**
 * One image attached to an assistant turn.
 *
 * This is a TRUE content block, not the "write the file, cite its path, let the
 * agent Read it" convention every other attachment path in the app uses: the
 * assistant spawns with `tools: []` and folder-scoped MCP reads only, so it can
 * never open a cited path. `base64` is therefore the RAW base64 payload with
 * NO `data:<media-type>;base64,` prefix — exactly what the Anthropic
 * `{ type: 'image', source: { type: 'base64', ... } }` block wants.
 *
 * `name` is display-only (the transcript's `📎 image: …` line); nothing resolves
 * it as a path.
 */
export interface AgentThreadImageAttachment {
  name: string;
  mediaType: AgentThreadImageMediaType;
  base64: string;
}

/**
 * Per-turn attachment limits. `maxBytesEach` bounds the DECODED image; the wire
 * schema bounds the base64 string instead (see
 * {@link AGENT_THREAD_IMAGE_MAX_BASE64_CHARS}) because that is what actually
 * crosses IPC.
 */
export const AGENT_THREAD_IMAGE_LIMITS = {
  maxImages: 4,
  maxBytesEach: 5 * 1024 * 1024,
} as const;

/**
 * Wire-side cap on one attachment's base64 string. Base64 inflates by 4/3 plus
 * padding, so a 5 MB file encodes to ~6.67 MB; 7 MB leaves headroom without
 * admitting a materially larger image.
 */
export const AGENT_THREAD_IMAGE_MAX_BASE64_CHARS = 7 * 1024 * 1024;

/** Decoded byte count of a base64 payload (padding-aware). Display/limit use only. */
export function agentThreadImageByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
