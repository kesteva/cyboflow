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

import type { CyboflowWorkflowName } from './workflows';
import type { CliSubstrate } from './substrate';
import type { Priority } from './tasks';

// ---------------------------------------------------------------------------
// Proposal kind / status enums
// ---------------------------------------------------------------------------

export const AGENT_PROPOSAL_KINDS = [
  'launch-run',
  'reprioritize-backlog',
  'edit-workflow',
  'open-session',
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

export interface AgentThread {
  id: string;
  scope: AgentThreadScope;
  model: string | null;
  claudeSessionId: string | null;
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
// Navigation target (open-session proposal)
// ---------------------------------------------------------------------------

/**
 * Where an 'open-session' proposal navigates. An idle quick session has no
 * live run, so it must route through setActiveQuickSession — never
 * setActiveRun — hence the two-armed discriminant instead of a single runId.
 */
export type AgentNavigationTarget =
  | { target: 'run'; runId: string }
  | { target: 'quick-session'; sessionId: string; runId?: string };

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

export type AgentProposalPayload =
  | LaunchRunProposalPayload
  | ReprioritizeBacklogProposalPayload
  | EditWorkflowProposalPayload
  | OpenSessionProposalPayload;

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

/** launch-run and open-session carry no preconditions — nothing to CAS-check. */
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
