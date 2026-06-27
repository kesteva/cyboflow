/**
 * AgentOverrideRouter — the SINGLE write chokepoint for `agent_overrides`
 * (migration 029).
 *
 * INVARIANT: every agent_overrides write (builtin override upsert, builtin
 * reset, custom-agent create, custom-agent delete) routes through applyChange.
 * Nothing INSERTs/UPDATEs/DELETEs `agent_overrides` directly.
 *
 * CRITICAL (I3/BLOCKER): unlike TaskChangeRouter / ReviewItemRouter, this router
 * MUST NOT write `entity_events`. The `entity_events.entity_type` CHECK forbids
 * an 'agent_override' type, so any such INSERT would abort the wrapping
 * transaction. We serialize per-project (PQueue concurrency=1), transaction-wrap
 * the single-table write, and emit a post-commit AgentChangedEvent on both the
 * per-project channel and the 'agent-override-all' channel.
 *
 * Mirrors ReviewItemRouter STRUCTURALLY (singleton + per-project queue + injected
 * DatabaseLike) so the chokepoint discipline reads the same across routers.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import type { AgentOverrideRow } from '../database/models';
import type { CliTool } from '../../../shared/types/cliTools';
import type { AgentChangedEvent } from '../../../shared/types/agents';
import type { WorkflowDefinition, WorkflowStep } from '../../../shared/types/workflows';
import { CANONICAL_AGENT_KEYS } from '../../../shared/types/agentIdentity';
import {
  AgentOverrideError,
  ensureResultSection,
  validateAgentDraft,
  type AgentDraft,
} from './agents/agentValidation';

// ---------------------------------------------------------------------------
// Public event emitter — exported HERE (mirroring reviewItemChangeEvents) so the
// tRPC subscription bridges this emitter without file contention with the events
// router. Two channels: per-project + a global 'agent-override-all' fan-out.
// ---------------------------------------------------------------------------

export const agentOverrideChangeEvents = new EventEmitter();

/** All-projects fan-out channel name. */
export const AGENT_OVERRIDE_ALL_CHANNEL = 'agent-override-all';

/** Build the per-project emit channel name. Exported so the tRPC subscription stays in sync. */
export function agentOverrideProjectChannel(projectId: number): string {
  return `agent-override-project-${projectId}`;
}

// ---------------------------------------------------------------------------
// Change request shapes
// ---------------------------------------------------------------------------

/** Override an existing builtin agent (shadows it; base_agent_key == agent_key). */
export interface AgentUpsertChange {
  op: 'upsert';
  agentKey: string;
  role: string | null;
  description: string;
  systemPrompt: string;
  tools: CliTool[];
  /** MCP server names this agent may call (rendered as `mcp__<server>__*`). */
  enabledMcps: string[];
  /** Optimistic-concurrency guard; when set must equal the current row version. */
  expectedVersion?: number;
}

/** Create a brand-new custom agent (is_custom=1, base_agent_key NULL). */
export interface AgentCreateCustomChange {
  op: 'createCustom';
  /** Display name; the kebab agentKey is derived from it. */
  name: string;
  role: string | null;
  description: string;
  systemPrompt: string;
  tools: CliTool[];
  /** MCP server names this agent may call (rendered as `mcp__<server>__*`). */
  enabledMcps: string[];
}

/** Reset a builtin override (DELETE its row → builtin shows through again). */
export interface AgentResetChange {
  op: 'reset';
  agentKey: string;
}

/** Delete a custom agent (DELETE its row; guarded against workflow references). */
export interface AgentDeleteCustomChange {
  op: 'deleteCustom';
  agentKey: string;
}

export type AgentOverrideChange =
  | AgentUpsertChange
  | AgentCreateCustomChange
  | AgentResetChange
  | AgentDeleteCustomChange;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Slugify a display name to a canonical kebab key. */
function kebab(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Narrow row of the workflows table needed for the referential guard. */
interface WorkflowSpecRow {
  name: string;
  spec_json: string | null;
}

// ---------------------------------------------------------------------------
// AgentOverrideRouter
// ---------------------------------------------------------------------------

export class AgentOverrideRouter {
  private static instance: AgentOverrideRouter | null = null;

  /** Per-project serialization queues (overrides are project-scoped). */
  private projectQueues = new Map<number, PQueue>();

  constructor(private readonly db: DatabaseLike) {}

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring ReviewItemRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike): AgentOverrideRouter {
    AgentOverrideRouter.instance = new AgentOverrideRouter(db);
    return AgentOverrideRouter.instance;
  }

  static getInstance(): AgentOverrideRouter {
    if (!AgentOverrideRouter.instance) {
      throw new Error(
        'AgentOverrideRouter has not been initialized. Call AgentOverrideRouter.initialize() from main/src/index.ts.',
      );
    }
    return AgentOverrideRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    AgentOverrideRouter.instance = null;
  }

  private getProjectQueue(projectId: number): PQueue {
    let q = this.projectQueues.get(projectId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.projectQueues.set(projectId, q);
    }
    return q;
  }

  /** Test/seam helper — exposes the per-project queue for `.onIdle()` waits. */
  _queueForProject(projectId: number): PQueue {
    return this.getProjectQueue(projectId);
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /** All override rows for a project (builtin overrides + custom agents). */
  listByProject(projectId: number): AgentOverrideRow[] {
    return this.db
      .prepare('SELECT * FROM agent_overrides WHERE project_id = ? ORDER BY agent_key')
      .all(projectId) as AgentOverrideRow[];
  }

  /** A single override row by (project, agentKey), or null when none exists. */
  getByKey(projectId: number, agentKey: string): AgentOverrideRow | null {
    const row = this.db
      .prepare('SELECT * FROM agent_overrides WHERE project_id = ? AND agent_key = ?')
      .get(projectId, agentKey) as AgentOverrideRow | undefined;
    return row ?? null;
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Apply a single override change atomically and emit the resulting event.
   * Serializes per project. Validation (kebab/forbidden/tool) runs via
   * validateAgentDraft for write ops; the router layers reserved/duplicate/
   * version/referential checks on top using project context. Emits an
   * AgentChangedEvent{projectId, agentKey} on the per-project + all channels
   * AFTER commit.
   */
  async applyChange(projectId: number, change: AgentOverrideChange): Promise<{ agentKey: string }> {
    return this.getProjectQueue(projectId).add(() => {
      switch (change.op) {
        case 'upsert':
          return this.runUpsert(projectId, change);
        case 'createCustom':
          return this.runCreateCustom(projectId, change);
        case 'reset':
          return this.runReset(projectId, change);
        case 'deleteCustom':
          return this.runDeleteCustom(projectId, change);
      }
    }) as Promise<{ agentKey: string }>;
  }

  // --------------------------------------------------------------------------
  // upsert — override an existing builtin
  // --------------------------------------------------------------------------

  private runUpsert(projectId: number, change: AgentUpsertChange): { agentKey: string } {
    const agentKey = change.agentKey;

    // A builtin override may only shadow a canonical builtin key.
    if (!CANONICAL_AGENT_KEYS.includes(agentKey as (typeof CANONICAL_AGENT_KEYS)[number])) {
      throw new AgentOverrideError(
        'invalid_key',
        `Agent key "${agentKey}" is not a builtin and cannot be overridden via upsert.`,
      );
    }

    const draft: AgentDraft = {
      agentKey,
      name: `cyboflow-${agentKey}`,
      role: change.role,
      description: change.description,
      systemPrompt: change.systemPrompt,
      tools: change.tools,
      enabledMcps: change.enabledMcps,
      isCustom: false,
    };
    validateAgentDraft(draft);
    const systemPrompt = ensureResultSection(draft.systemPrompt);

    const now = new Date().toISOString();
    const id = `ago_${randomBytes(10).toString('hex')}`;
    const toolsJson = JSON.stringify(change.tools);
    const enabledMcpsJson = JSON.stringify(change.enabledMcps);

    const txn = this.db.transaction(() => {
      // Optimistic concurrency: when expectedVersion is supplied, the existing
      // row (if any) must match — otherwise a concurrent edit clobbered it.
      if (change.expectedVersion !== undefined) {
        const existing = this.getByKey(projectId, agentKey);
        const currentVersion = existing?.version ?? 0;
        if (currentVersion !== change.expectedVersion) {
          throw new AgentOverrideError(
            'version_conflict',
            `Agent "${agentKey}" was modified concurrently (expected v${change.expectedVersion}, found v${currentVersion}).`,
          );
        }
      }

      this.db
        .prepare(
          `INSERT INTO agent_overrides
             (id, project_id, agent_key, base_agent_key, name, role, description,
              system_prompt, tools_json, enabled_mcps_json, is_custom, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
           ON CONFLICT(project_id, agent_key) DO UPDATE SET
             name = excluded.name,
             role = excluded.role,
             description = excluded.description,
             system_prompt = excluded.system_prompt,
             tools_json = excluded.tools_json,
             enabled_mcps_json = excluded.enabled_mcps_json,
             version = agent_overrides.version + 1,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          projectId,
          agentKey,
          agentKey, // base_agent_key == agent_key for a builtin override
          draft.name,
          change.role,
          change.description,
          systemPrompt,
          toolsJson,
          enabledMcpsJson,
          now,
          now,
        );
    });
    (txn as () => void)();

    this.emitChange(projectId, agentKey);
    return { agentKey };
  }

  // --------------------------------------------------------------------------
  // createCustom — mint a brand-new custom agent
  // --------------------------------------------------------------------------

  private runCreateCustom(projectId: number, change: AgentCreateCustomChange): { agentKey: string } {
    const agentKey = kebab(change.name);

    const draft: AgentDraft = {
      agentKey,
      name: `cyboflow-${agentKey}`,
      role: change.role,
      description: change.description,
      systemPrompt: change.systemPrompt,
      tools: change.tools,
      enabledMcps: change.enabledMcps,
      isCustom: true,
    };
    // Kebab/forbidden/tool/description shape checks (throws invalid_key for a bad slug).
    validateAgentDraft(draft);

    // A custom agent must not collide with a canonical builtin key.
    if (CANONICAL_AGENT_KEYS.includes(agentKey as (typeof CANONICAL_AGENT_KEYS)[number])) {
      throw new AgentOverrideError(
        'reserved_key',
        `Agent key "${agentKey}" is reserved by a builtin agent.`,
      );
    }

    const systemPrompt = ensureResultSection(draft.systemPrompt);
    const now = new Date().toISOString();
    const id = `ago_${randomBytes(10).toString('hex')}`;
    const toolsJson = JSON.stringify(change.tools);
    const enabledMcpsJson = JSON.stringify(change.enabledMcps);

    const txn = this.db.transaction(() => {
      if (this.getByKey(projectId, agentKey)) {
        throw new AgentOverrideError(
          'duplicate_key',
          `An agent with key "${agentKey}" already exists in this project.`,
        );
      }

      this.db
        .prepare(
          `INSERT INTO agent_overrides
             (id, project_id, agent_key, base_agent_key, name, role, description,
              system_prompt, tools_json, enabled_mcps_json, is_custom, version, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        )
        .run(
          id,
          projectId,
          agentKey,
          draft.name,
          change.role,
          change.description,
          systemPrompt,
          toolsJson,
          enabledMcpsJson,
          now,
          now,
        );
    });
    (txn as () => void)();

    this.emitChange(projectId, agentKey);
    return { agentKey };
  }

  // --------------------------------------------------------------------------
  // reset — drop a builtin override row
  // --------------------------------------------------------------------------

  private runReset(projectId: number, change: AgentResetChange): { agentKey: string } {
    const agentKey = change.agentKey;

    const txn = this.db.transaction(() => {
      const existing = this.getByKey(projectId, agentKey);
      if (!existing) {
        throw new AgentOverrideError(
          'invalid_key',
          `No override exists for agent "${agentKey}" in this project.`,
        );
      }
      if (existing.is_custom === 1) {
        throw new AgentOverrideError(
          'invalid_key',
          `Agent "${agentKey}" is a custom agent — use deleteCustom, not reset.`,
        );
      }
      this.db
        .prepare('DELETE FROM agent_overrides WHERE project_id = ? AND agent_key = ?')
        .run(projectId, agentKey);
    });
    (txn as () => void)();

    this.emitChange(projectId, agentKey);
    return { agentKey };
  }

  // --------------------------------------------------------------------------
  // deleteCustom — drop a custom agent (guarded against workflow references)
  // --------------------------------------------------------------------------

  private runDeleteCustom(projectId: number, change: AgentDeleteCustomChange): { agentKey: string } {
    const agentKey = change.agentKey;

    const txn = this.db.transaction(() => {
      const existing = this.getByKey(projectId, agentKey);
      if (!existing) {
        throw new AgentOverrideError(
          'invalid_key',
          `No custom agent "${agentKey}" exists in this project.`,
        );
      }
      if (existing.is_custom !== 1) {
        throw new AgentOverrideError(
          'invalid_key',
          `Agent "${agentKey}" is a builtin override — use reset, not deleteCustom.`,
        );
      }

      // Referential guard: a custom agent bound to any workflow step may not be
      // deleted. Surface the referencing workflow names.
      const referencing = this.workflowsReferencing(projectId, agentKey);
      if (referencing.length > 0) {
        throw new AgentOverrideError(
          'duplicate_key',
          `Agent "${agentKey}" is referenced by workflow(s): ${referencing.join(', ')}. Remove it from those steps first.`,
        );
      }

      this.db
        .prepare('DELETE FROM agent_overrides WHERE project_id = ? AND agent_key = ?')
        .run(projectId, agentKey);
    });
    (txn as () => void)();

    this.emitChange(projectId, agentKey);
    return { agentKey };
  }

  /**
   * Names of the project's workflows whose spec_json binds `agentKey` to any
   * step (step.agent === agentKey). Malformed spec_json is skipped.
   *
   * Migration-030 note: this checks only PROJECT-SCOPED workflows
   * (`project_id = ?`); a GLOBAL custom flow (project_id NULL) binding `agentKey`
   * is NOT caught by this per-project referential guard. Custom agents /
   * agent_overrides remain per-project (out of scope for the global-workflow
   * pass), so the common case — a per-project custom agent referenced by a
   * per-project flow — is fully covered; the gap is only a global flow vs a
   * per-project agent of the same key. Deliberately unchanged here.
   */
  private workflowsReferencing(projectId: number, agentKey: string): string[] {
    const rows = this.db
      .prepare('SELECT name, spec_json FROM workflows WHERE project_id = ?')
      .all(projectId) as WorkflowSpecRow[];

    const names: string[] = [];
    for (const row of rows) {
      if (!row.spec_json) continue;
      let spec: WorkflowDefinition;
      try {
        spec = JSON.parse(row.spec_json) as WorkflowDefinition;
      } catch {
        continue; // malformed spec — skip, don't block the delete on bad JSON
      }
      const phases = Array.isArray(spec.phases) ? spec.phases : [];
      const referenced = phases.some(
        (phase) =>
          Array.isArray(phase.steps) &&
          phase.steps.some((step: WorkflowStep) => step.agent === agentKey),
      );
      if (referenced) names.push(row.name);
    }
    return names;
  }

  // --------------------------------------------------------------------------
  // Emit
  // --------------------------------------------------------------------------

  private emitChange(projectId: number, agentKey: string): void {
    const event: AgentChangedEvent = { projectId, agentKey };
    agentOverrideChangeEvents.emit(agentOverrideProjectChannel(projectId), event);
    agentOverrideChangeEvents.emit(AGENT_OVERRIDE_ALL_CHANNEL, event);
  }
}
