/**
 * prepareProposal — the shared server-side preparation of one agent proposal
 * (docs/proposals/CUSTOM-VIEWS.md §4.5).
 *
 * EXTRACTED VERBATIM from `mcpServer/mcpQueryHandler.ts`'s
 * `handleProposeAction`: the payload parser plus the per-kind enrichment that
 * captures preconditions SERVER-SIDE (the effective workflow spec hash, backlog
 * `expectedVersion`s), validates and normalizes entity references, and resolves
 * navigation ownership from the run/session row rather than from anything the
 * caller supplied.
 *
 * Two callers share it: the MCP `cyboflow_propose_action` tool (which keeps the
 * scope check, the store guard, the JSON parse, and the createProposal +
 * appendEvent + reply around it) and the custom-views widget action service,
 * where a widget CTA becomes the same proposal on the same executor. Every
 * error string here is the one the tool already returned, so its observable
 * replies are unchanged by the move.
 */
import {
  AGENT_PROPOSAL_KINDS,
  type AgentNavigationTarget,
  type AgentProposalKind,
  type AgentProposalPayload,
  type AgentProposalPreconditions,
  type CreateBacklogItem,
  type CreateBacklogItemsProposalPayload,
  type CreateWorkflowAgent,
  type CreateWorkflowProposalPayload,
  type EditWorkflowProposalPayload,
  type LaunchRunProposalPayload,
  type OpenSessionProposalPayload,
  type ReprioritizeBacklogItem,
  type ReprioritizeBacklogProposalPayload,
} from '../../../../shared/types/agentThread';
import { isCliSubstrate } from '../../../../shared/types/substrate';
import { isCyboflowWorkflowName } from '../../../../shared/types/workflows';
import type { PermissionMode, WorkflowDefinition, WorkflowRow } from '../../../../shared/types/workflows';
import type { EntityCategory, IdeaScope, Priority, TaskType } from '../../../../shared/types/tasks';
import { isCliTool } from '../../../../shared/types/cliTools';
import type { CliTool } from '../../../../shared/types/cliTools';
import { isAgentModelAlias } from '../../../../shared/types/agents';
import { HUMAN_GATE_AGENT, isCanonicalAgentKey } from '../../../../shared/types/agentIdentity';
import { resolveEffectiveDefinition } from '../../../../shared/tuning/workflowTuning';
import { computeSpecHash } from './specHash';
import { resolveBacklogRef } from '../taskListing';
import { workflowDefinitionSchema } from '../workflowDefinitionSchema';
import { workflowNameIssue } from '../workflowName';
import { QUICK_WORKFLOW_NAME } from '../workflowRegistry';
import { AgentOverrideError, deriveAgentKey, validateAgentDraft } from '../agents/agentValidation';
import type { DatabaseLike } from '../types';

/** A non-null object whose own keys can be safely indexed. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

// A workflow definition arrives as a JSON STRING per the contract, but a model
// composing `payload_json` nests it as a plain object just as readily (the
// first live create-workflow attempt did exactly that, five times in a row,
// and got back an opaque 'invalid_payload' each time). Accept both: an object
// is re-encoded so the validator downstream sees the one shape it expects.
function readDefinitionJson(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
  return null;
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

/**
 * Ceiling on the agents one create-workflow proposal may mint. A flow rarely
 * needs more than a handful of bespoke personas, and each one is a full
 * system prompt the human is being asked to approve on one card.
 */
const CREATE_WORKFLOW_MAX_AGENTS = 8;

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'default' || v === 'acceptEdits' || v === 'auto' || v === 'dontAsk';
}

/**
 * Narrow one create-workflow agent entry. Strict like {@link parseCreateBacklogItem}:
 * a malformed member rejects the whole payload — the card must describe exactly
 * the agent Confirm would mint. Shape only; the chokepoint-grade checks
 * (kebab key, single-writer prompt, non-empty tools) run in prepareProposal.
 */
function parseCreateWorkflowAgent(raw: unknown): CreateWorkflowAgent | null {
  if (!isRecord(raw)) return null;
  const name = raw.name;
  const description = raw.description;
  const systemPrompt = raw.systemPrompt;
  const tools = raw.tools;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof description !== 'string') return null;
  if (typeof systemPrompt !== 'string' || systemPrompt.length === 0) return null;
  if (!Array.isArray(tools) || !tools.every((t): t is CliTool => typeof t === 'string' && isCliTool(t))) return null;
  const agent: CreateWorkflowAgent = { name, description, systemPrompt, tools };

  const enabledMcps = raw.enabledMcps;
  if (enabledMcps !== undefined) {
    if (!isStringArray(enabledMcps)) return null;
    agent.enabledMcps = enabledMcps;
  }
  const role = raw.role;
  if (role !== undefined) {
    if (typeof role !== 'string') return null;
    agent.role = role;
  }
  const model = raw.model;
  if (model !== undefined) {
    if (typeof model !== 'string' || !isAgentModelAlias(model)) return null;
    agent.model = model;
  }
  return agent;
}

export function parseAgentNavigationTarget(raw: unknown): AgentNavigationTarget | null {
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

export function parseAgentProposalPayload(raw: unknown): AgentProposalPayload | null {
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
      const definitionJson = readDefinitionJson(raw.definitionJson);
      if (typeof workflowId !== 'string' || workflowId.length === 0) return null;
      if (definitionJson === null) return null;
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
    case 'create-workflow': {
      const projectId = raw.projectId;
      const name = raw.name;
      const definitionJson = readDefinitionJson(raw.definitionJson);
      if (typeof projectId !== 'number') return null;
      if (typeof name !== 'string' || name.trim().length === 0) return null;
      if (definitionJson === null) return null;
      const payload: CreateWorkflowProposalPayload = { kind: 'create-workflow', projectId, name, definitionJson };

      const scope = raw.scope;
      if (scope !== undefined) {
        if (scope !== 'project' && scope !== 'global') return null;
        payload.scope = scope;
      }
      const permissionMode = raw.permissionMode;
      if (permissionMode !== undefined) {
        if (!isPermissionMode(permissionMode)) return null;
        payload.permissionMode = permissionMode;
      }
      const agentsRaw = raw.agents;
      if (agentsRaw !== undefined) {
        if (!Array.isArray(agentsRaw) || agentsRaw.length > CREATE_WORKFLOW_MAX_AGENTS) return null;
        const agents: CreateWorkflowAgent[] = [];
        for (const entryRaw of agentsRaw) {
          const agent = parseCreateWorkflowAgent(entryRaw);
          if (!agent) return null;
          agents.push(agent);
        }
        payload.agents = agents;
      }
      const summary = raw.summary;
      if (summary !== undefined) {
        if (typeof summary !== 'string') return null;
        payload.summary = summary;
      }
      return payload;
    }
  }
}

// ---------------------------------------------------------------------------
// Server-side preparation
// ---------------------------------------------------------------------------

/**
 * The reads `prepareProposal` needs, each one a method the MCP handler already
 * had. Passed as a narrow bag rather than a class so the widget action service
 * can supply the same three closures over its own `DatabaseLike`.
 */
export interface PrepareProposalDeps {
  db: DatabaseLike;
  /** Raw `workflows` row by id, or null when absent. */
  readWorkflowRow(workflowId: string): WorkflowRow | null;
  /** Identity columns of a backlog entity by opaque id; undefined when absent. */
  readTaskIdentity(taskId: string): { ref: string; stage_id: string; version: number; type: TaskType } | undefined;
  /** A ref-or-id narrowed to the opaque id of an EXISTING entity of `type` in `projectId`, else null. */
  resolveExistingEntity(projectId: number, refOrId: string, type: TaskType): string | null;
  /**
   * Is a workflow named `name` already present where WorkflowRegistry.createCustom
   * would look? A GLOBAL flow's name is reserved across every scope, so a
   * project-scoped create (`projectId` set) also collides with a global row.
   */
  workflowNameTaken(projectId: number | null, name: string): boolean;
  /** Does `projectId` already carry a custom agent (an agent_overrides row) under `agentKey`? */
  customAgentExists(projectId: number, agentKey: string): boolean;
}

/**
 * `ok:false` carries the SAME error string the `cyboflow_propose_action` tool
 * writes to the wire today — `invalid_payload`, `workflow_not_found`,
 * `workflow_unresolvable`, `task_not_found:<id>`, `run_not_found`,
 * `session_not_found`, `project_not_found`, `parent_epic_not_found:<id>`,
 * `originating_idea_not_found:<id>`; and for create-workflow
 * `workflow_name_invalid:<why>`, `workflow_name_reserved`, `workflow_name_taken`,
 * `global_scope_with_agents`, `invalid_definition:<path: issue>`,
 * `agent_invalid:<key>:<why>`, `agent_key_reserved:<key>`,
 * `agent_key_taken:<key>`, `unknown_step_agent:<key>`.
 */
export type PrepareProposalResult =
  | { ok: true; payload: AgentProposalPayload; preconditions: AgentProposalPreconditions | null }
  | { ok: false; error: string };

/**
 * Validate a raw proposal payload and capture its preconditions.
 *
 * Preconditions are ALWAYS captured here, server-side — the wire payload
 * carries no precondition field for a caller to even attempt to spoof; this
 * re-read is what makes that true rather than merely documented.
 *
 * The returned payload may be ENRICHED relative to the input: an `open-session`
 * navigation gains the owning `projectId` resolved from the run/session row,
 * and `create-backlog-items` links are normalized from display refs to opaque
 * ids. Callers persist what comes back, never the raw input.
 */
export function prepareProposal(deps: PrepareProposalDeps, raw: unknown): PrepareProposalResult {
  const payload = parseAgentProposalPayload(raw);
  if (!payload) return { ok: false, error: 'invalid_payload' };

  let preconditions: AgentProposalPreconditions | null = null;

  if (payload.kind === 'edit-workflow') {
    const row = deps.readWorkflowRow(payload.workflowId);
    if (!row) return { ok: false, error: 'workflow_not_found' };
    // The EFFECTIVE definition (migration 122) — must match what the proposal
    // executor's `readEffectiveWorkflowSpec` re-reads at apply time, or the
    // CAS hash never matches and every edit-workflow proposal is refused.
    const definition = resolveEffectiveDefinition(row.name, row.spec_json, row.tuning_level);
    if (definition === null) return { ok: false, error: 'workflow_unresolvable' };
    preconditions = { kind: 'edit-workflow', specHash: computeSpecHash(definition) };
  } else if (payload.kind === 'reprioritize-backlog') {
    const expectedVersions: Record<string, number> = {};
    for (const item of payload.items) {
      const identity = deps.readTaskIdentity(item.taskId);
      if (!identity) return { ok: false, error: `task_not_found:${item.taskId}` };
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
      const row = deps.db.prepare('SELECT project_id FROM workflow_runs WHERE id = ?').get(nav.runId) as
        | { project_id?: unknown }
        | undefined;
      if (!row || typeof row.project_id !== 'number') return { ok: false, error: 'run_not_found' };
      payload.navigation = { target: 'run', runId: nav.runId, projectId: row.project_id };
    } else {
      const row = deps.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(nav.sessionId) as
        | { project_id?: unknown }
        | undefined;
      if (!row || typeof row.project_id !== 'number') return { ok: false, error: 'session_not_found' };
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
    const projectExists = deps.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(payload.projectId) !== undefined;
    if (!projectExists) return { ok: false, error: 'project_not_found' };
    for (const item of payload.items) {
      if (item.parentEpicId !== undefined) {
        const resolved = deps.resolveExistingEntity(payload.projectId, item.parentEpicId, 'epic');
        if (!resolved) return { ok: false, error: `parent_epic_not_found:${item.parentEpicId}` };
        item.parentEpicId = resolved;
      }
      if (item.originatingIdeaId !== undefined) {
        const resolved = deps.resolveExistingEntity(payload.projectId, item.originatingIdeaId, 'idea');
        if (!resolved) return { ok: false, error: `originating_idea_not_found:${item.originatingIdeaId}` };
        item.originatingIdeaId = resolved;
      }
    }
  } else if (payload.kind === 'create-workflow') {
    // No preconditions (nothing exists yet to race against), but everything the
    // confirm would otherwise die on is checked NOW: the name (Windows-safe,
    // not a built-in, free in scope), the definition (the strict write-path
    // schema — the same one the editor and the MCP writer use), each new agent
    // (the chokepoint's own draft checks + reserved/duplicate keys), and every
    // step binding (a step must name a builtin, the human gate, an existing
    // custom agent of the project, or one of the agents this proposal mints).
    // Rejecting at propose time means the assistant gets a precise error to
    // fix in the same turn instead of the human confirming a card that fails.
    const error = validateCreateWorkflow(deps, payload);
    if (error !== null) return { ok: false, error };
  }
  // launch-run carries no preconditions (shared type contract).

  return { ok: true, payload, preconditions };
}

/** Every `step.agent` a definition binds, fan-out inner steps included. */
function boundAgentKeys(definition: WorkflowDefinition): string[] {
  const keys: string[] = [];
  for (const phase of definition.phases) {
    for (const step of phase.steps) {
      keys.push(step.agent);
      for (const inner of step.fanOut?.inner ?? []) keys.push(inner.agent);
    }
  }
  return keys;
}

/** The create-workflow branch of prepareProposal; returns the error string or null when valid. */
function validateCreateWorkflow(deps: PrepareProposalDeps, payload: CreateWorkflowProposalPayload): string | null {
  const projectExists = deps.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(payload.projectId) !== undefined;
  if (!projectExists) return 'project_not_found';

  const name = payload.name.trim();
  payload.name = name;
  const nameIssue = workflowNameIssue(name);
  if (nameIssue !== null) return `workflow_name_invalid:${nameIssue}`;
  if (isCyboflowWorkflowName(name) || name === QUICK_WORKFLOW_NAME) return 'workflow_name_reserved';
  const scopeProjectId = payload.scope === 'global' ? null : payload.projectId;
  if (deps.workflowNameTaken(scopeProjectId, name)) return 'workflow_name_taken';

  // Custom agents are project-scoped, so a GLOBAL flow bound to one would only
  // ever spawn it in the project that owns it — refuse the combination rather
  // than mint a flow that silently breaks everywhere else.
  const agents = payload.agents ?? [];
  if (scopeProjectId === null && agents.length > 0) return 'global_scope_with_agents';

  let raw: unknown;
  try {
    raw = JSON.parse(payload.definitionJson);
  } catch {
    return 'invalid_definition:definitionJson is not valid JSON';
  }
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `invalid_definition:${where}: ${issue?.message ?? 'invalid'}`;
  }
  // Persist the NORMALIZED definition so the executor re-parses exactly what
  // was validated (strips nothing today, but keeps the two reads identical).
  payload.definitionJson = JSON.stringify(parsed.data);

  const newKeys = new Set<string>();
  for (const agent of agents) {
    const agentKey = deriveAgentKey(agent.name);
    try {
      validateAgentDraft({
        agentKey,
        name: `cyboflow-${agentKey}`,
        role: agent.role ?? null,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        tools: agent.tools,
        model: agent.model ?? null,
        enabledMcps: agent.enabledMcps ?? [],
        isCustom: true,
      });
    } catch (err) {
      const why = err instanceof AgentOverrideError ? err.message : err instanceof Error ? err.message : String(err);
      return `agent_invalid:${agentKey}:${why}`;
    }
    if (isCanonicalAgentKey(agentKey)) return `agent_key_reserved:${agentKey}`;
    if (newKeys.has(agentKey) || deps.customAgentExists(payload.projectId, agentKey)) {
      return `agent_key_taken:${agentKey}`;
    }
    newKeys.add(agentKey);
  }

  for (const key of boundAgentKeys(parsed.data)) {
    if (key === HUMAN_GATE_AGENT || isCanonicalAgentKey(key) || newKeys.has(key)) continue;
    if (deps.customAgentExists(payload.projectId, key)) continue;
    return `unknown_step_agent:${key}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// createPrepareProposalDeps — the PrepareProposalDeps.{readWorkflowRow,
// readTaskIdentity,resolveExistingEntity} bodies, factored out of
// McpQueryHandler's private methods of the same names so a SECOND caller (the
// custom-views widget action service, docs/proposals/CUSTOM-VIEWS.md §4.4)
// gets the identical reads over its own DatabaseLike without duplicating them.
// mcpQueryHandler.ts's handleProposeAction now builds its deps through this
// factory too, so there is exactly one implementation of each read.
// ---------------------------------------------------------------------------

/** Build a `PrepareProposalDeps` bag backed by plain reads on `db` — no class, no external state. */
export function createPrepareProposalDeps(db: DatabaseLike): PrepareProposalDeps {
  return {
    db,
    readWorkflowRow(workflowId: string): WorkflowRow | null {
      const row = db
        .prepare(
          `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, tuning_level, runtime_mix, created_at, archived_at
             FROM workflows WHERE id = ?`,
        )
        .get(workflowId) as WorkflowRow | undefined;
      return row ?? null;
    },
    readTaskIdentity(taskId: string): { ref: string; stage_id: string; version: number; type: TaskType } | undefined {
      const tables: Array<{ table: string; type: TaskType }> = [
        { table: 'ideas', type: 'idea' },
        { table: 'epics', type: 'epic' },
        { table: 'tasks', type: 'task' },
      ];
      for (const { table, type } of tables) {
        const row = db
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
    },
    resolveExistingEntity(projectId: number, refOrId: string, type: TaskType): string | null {
      const id = resolveBacklogRef(db, projectId, refOrId) ?? refOrId;
      const table = type === 'idea' ? 'ideas' : type === 'epic' ? 'epics' : 'tasks';
      const row = db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND project_id = ?`).get(id, projectId);
      return row !== undefined ? id : null;
    },
    workflowNameTaken(projectId: number | null, name: string): boolean {
      // Mirrors WorkflowRegistry.createCustom's two collision probes: a global
      // name is reserved everywhere; a project name must also be free in-project.
      const global = db.prepare('SELECT 1 FROM workflows WHERE project_id IS NULL AND name = ? LIMIT 1').get(name);
      if (global !== undefined) return true;
      if (projectId === null) return false;
      return db.prepare('SELECT 1 FROM workflows WHERE project_id = ? AND name = ? LIMIT 1').get(projectId, name) !== undefined;
    },
    customAgentExists(projectId: number, agentKey: string): boolean {
      return db.prepare('SELECT 1 FROM agent_overrides WHERE project_id = ? AND agent_key = ? LIMIT 1').get(projectId, agentKey) !== undefined;
    },
  };
}
