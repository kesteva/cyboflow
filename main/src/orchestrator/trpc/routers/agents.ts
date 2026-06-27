/**
 * cyboflow.agents sub-router — the typed tRPC contract for the Agents
 * catalogue / editor (the Workflows & Agents pane).
 *
 * Surfaces the 13 built-in agents merged with a project's `agent_overrides`
 * rows, plus any custom agents, each as an `AgentEntry` (the post-write
 * effective view: identity + tools + usage + stats). Reads compose the parsed
 * built-in catalogue (`loadBuiltInAgents`) with the chokepoint's per-project
 * override rows (`ctx.agentOverrideRouter.listByProject`) via
 * `computeEffectiveAgents` + `buildEffectiveEntry`; per-key usage is computed
 * over the project's resolved workflow definitions (`computeAgentUsage`).
 *
 * All mutating procedures funnel through the SINGLE write chokepoint
 * `ctx.agentOverrideRouter.applyChange`, then re-read and return the freshly
 * built `AgentEntry`. The chokepoint owns validation (kebab / forbidden-writer /
 * tool / reserved / duplicate / version / referential) and the post-commit
 * `AgentChangedEvent` emit; this router maps `AgentOverrideError.code` to a
 * `TRPCError` and pre-checks the precise reset/delete-on-wrong-kind codes.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { Context } from '../context';
import { eventToAsyncIterable } from './events';
import { buildBuiltInWorkflows } from '../../workflows/builtInWorkflows';
import { loadBuiltInAgents } from '../../agents/agentCatalogue';
import {
  computeEffectiveAgents,
  buildEffectiveEntry,
  type EffectiveAgent,
} from '../../agents/effectiveAgents';
import { computeAgentUsage, type WorkflowForUsage } from '../../agents/agentUsage';
import { AgentOverrideError } from '../../agents/agentValidation';
import {
  agentOverrideChangeEvents,
  agentOverrideProjectChannel,
} from '../../agentOverrideRouter';
import { CLI_TOOLS } from '../../../../../shared/types/cliTools';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';
import type { AgentOverrideRow } from '../../../database/models';
import type { AgentEntry, AgentChangedEvent, AgentUsage } from '../../../../../shared/types/agents';
import { AGENT_MODEL_ALIASES } from '../../../../../shared/types/agents';

// ---------------------------------------------------------------------------
// Context guard
// ---------------------------------------------------------------------------

/**
 * The deps every agents procedure requires. Narrowed from the optional context
 * fields so the body can use them without repeated `!` assertions.
 */
interface AgentsCtx {
  agentOverrideRouter: NonNullable<Context['agentOverrideRouter']>;
  workflowRegistry: NonNullable<Context['workflowRegistry']>;
}

/**
 * Assert the three deps the agents router needs are wired (override chokepoint,
 * workflow registry for usage, db for the registry's reads). Throws
 * PRECONDITION_FAILED — mirrors the workflows/reviewItems routers.
 */
function requireDeps(ctx: Context): AgentsCtx {
  if (!ctx.agentOverrideRouter || !ctx.workflowRegistry || !ctx.db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'agents router requires agentOverrideRouter + workflowRegistry + db in the tRPC context',
    });
  }
  return { agentOverrideRouter: ctx.agentOverrideRouter, workflowRegistry: ctx.workflowRegistry };
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map an `AgentOverrideError.code` to a `TRPCError` so the renderer can branch
 * on `error.data.code`. Re-throws other errors unchanged.
 */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof AgentOverrideError) {
    const codeMap: Record<AgentOverrideError['code'], TRPCError['code']> = {
      forbidden_writer_call: 'BAD_REQUEST',
      forbidden_tool: 'BAD_REQUEST',
      invalid_mcp: 'BAD_REQUEST',
      empty_tools: 'BAD_REQUEST',
      empty_description: 'BAD_REQUEST',
      invalid_key: 'BAD_REQUEST',
      invalid_model: 'BAD_REQUEST',
      reserved_key: 'CONFLICT',
      duplicate_key: 'CONFLICT',
      frontmatter_in_body: 'BAD_REQUEST',
      version_conflict: 'CONFLICT',
    };
    throw new TRPCError({
      code: codeMap[err.code],
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Effective-entry assembly
// ---------------------------------------------------------------------------

/**
 * Build the per-key `AgentUsage` map for a project: reconcile + list the
 * project's workflows, resolve each row to a `WorkflowDefinition` (built-in
 * fallback or spec_json override), and feed the resolved definitions to
 * `computeAgentUsage`. Rows whose definition resolves null (a custom flow with
 * a broken/empty spec) are skipped.
 */
function computeProjectUsage(ctx: AgentsCtx, projectId: number): Map<string, AgentUsage> {
  // Reconcile the in-repo built-ins as ONE GLOBAL set (migration 030) — a single
  // `wf-global-<name>` row per built-in, shared across projects. Project-
  // independent, so no projectId argument; the global rows surface in this
  // project's list via the union in listByProject.
  ctx.workflowRegistry.ensureGlobalBuiltIns(buildBuiltInWorkflows());
  const rows = ctx.workflowRegistry.listByProject(projectId);
  const workflows: WorkflowForUsage[] = [];
  for (const row of rows) {
    const definition = resolveWorkflowDefinition(row.name, row.spec_json);
    if (definition !== null) workflows.push({ name: row.name, definition });
  }
  return computeAgentUsage(workflows);
}

/**
 * Assemble the full `AgentEntry[]` for a project: every effective agent (the 13
 * builtins merged with their overrides, plus customs) built via
 * `buildEffectiveEntry` with its usage + backing override row (for lastEditedAt).
 */
function listEntries(ctx: AgentsCtx, projectId: number): AgentEntry[] {
  const builtins = loadBuiltInAgents();
  const overrides = ctx.agentOverrideRouter.listByProject(projectId);
  const usage = computeProjectUsage(ctx, projectId);

  const overrideByKey = new Map<string, AgentOverrideRow>();
  for (const row of overrides) overrideByKey.set(row.agent_key, row);

  const emptyUsage: AgentUsage = { workflowCount: 0, usedBy: [], dispatchedBy: [] };
  const effective = computeEffectiveAgents(builtins, overrides);
  return effective.map((eff) =>
    buildEffectiveEntry(
      eff,
      overrideByKey.get(eff.agentKey) ?? null,
      usage.get(eff.agentKey) ?? emptyUsage,
    ),
  );
}

/**
 * Build (and re-read) a single `AgentEntry` by key, or null when the key is not
 * an effective agent for the project. Used post-write to return the fresh entry.
 */
function getEntry(ctx: AgentsCtx, projectId: number, agentKey: string): AgentEntry | null {
  return listEntries(ctx, projectId).find((e) => e.agentKey === agentKey) ?? null;
}

/**
 * Locate the effective source agent for a `duplicate` seed (a builtin, a
 * builtin-override, or a custom). Returns null when the key is unknown.
 */
function findEffective(ctx: AgentsCtx, projectId: number, agentKey: string): EffectiveAgent | null {
  const builtins = loadBuiltInAgents();
  const overrides = ctx.agentOverrideRouter.listByProject(projectId);
  return computeEffectiveAgents(builtins, overrides).find((e) => e.agentKey === agentKey) ?? null;
}

// ---------------------------------------------------------------------------
// Zod input schemas
// ---------------------------------------------------------------------------

const toolsSchema = z.array(z.enum(CLI_TOOLS)).min(1);
const enabledMcpsSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).default([]);
const agentKeySchema = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
const projectIdSchema = z.number().int().positive();
/** Pinned model alias; null/omitted → inherit the run model. */
const modelSchema = z.enum(AGENT_MODEL_ALIASES).nullable().optional();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const agentsRouter = router({
  /**
   * List every effective agent for a project: the 13 builtins merged with their
   * `agent_overrides` rows, plus any custom agents, each as an `AgentEntry`
   * (source / isOverridden / isCustom / usage / stats).
   */
  list: protectedProcedure
    .input(z.object({ projectId: projectIdSchema }))
    .query(async ({ ctx, input }): Promise<AgentEntry[]> => {
      const deps = requireDeps(ctx);
      return listEntries(deps, input.projectId);
    }),

  /**
   * Fetch one effective agent by key. NOT_FOUND when the key is neither a
   * builtin nor a custom agent for the project.
   */
  get: protectedProcedure
    .input(z.object({ projectId: projectIdSchema, agentKey: agentKeySchema }))
    .query(async ({ ctx, input }): Promise<AgentEntry> => {
      const deps = requireDeps(ctx);
      const entry = getEntry(deps, input.projectId, input.agentKey);
      if (!entry) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Agent "${input.agentKey}" not found for project ${input.projectId}`,
        });
      }
      return entry;
    }),

  /**
   * Override a built-in agent (total-replace description / system prompt / tools
   * / role). Routes through the `upsert` chokepoint op; the chokepoint rejects a
   * non-builtin key (BAD_REQUEST) and a forbidden writer/tool. Returns the fresh
   * `AgentEntry`.
   */
  upsertOverride: protectedProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        agentKey: agentKeySchema,
        name: z.string().min(1),
        description: z.string().min(1),
        systemPrompt: z.string(),
        tools: toolsSchema,
        enabledMcps: enabledMcpsSchema,
        role: z.string().nullable().optional(),
        model: modelSchema,
      }),
    )
    .mutation(async ({ ctx, input }): Promise<AgentEntry> => {
      const deps = requireDeps(ctx);
      try {
        await deps.agentOverrideRouter.applyChange(input.projectId, {
          op: 'upsert',
          agentKey: input.agentKey,
          role: input.role ?? null,
          description: input.description,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          model: input.model ?? null,
          enabledMcps: input.enabledMcps,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
      const entry = getEntry(deps, input.projectId, input.agentKey);
      if (!entry) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Agent "${input.agentKey}" not found after upsert`,
        });
      }
      return entry;
    }),

  /**
   * Reset a built-in override (drop the row so the builtin shows through again).
   * Pre-checks for precise codes: NOT_FOUND when no override exists, BAD_REQUEST
   * when the key is a custom agent (use deleteCustom). Returns the fresh
   * (now-builtin) `AgentEntry`.
   */
  resetOverride: protectedProcedure
    .input(z.object({ projectId: projectIdSchema, agentKey: agentKeySchema }))
    .mutation(async ({ ctx, input }): Promise<AgentEntry> => {
      const deps = requireDeps(ctx);
      const existing = deps.agentOverrideRouter.getByKey(input.projectId, input.agentKey);
      if (!existing) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No override exists for agent "${input.agentKey}" in project ${input.projectId}`,
        });
      }
      if (existing.is_custom === 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Agent "${input.agentKey}" is a custom agent — use deleteCustom, not resetOverride`,
        });
      }
      try {
        await deps.agentOverrideRouter.applyChange(input.projectId, {
          op: 'reset',
          agentKey: input.agentKey,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
      const entry = getEntry(deps, input.projectId, input.agentKey);
      if (!entry) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Agent "${input.agentKey}" not found after reset`,
        });
      }
      return entry;
    }),

  /**
   * Create a brand-new custom agent (the chokepoint derives the kebab key from
   * `name`). CONFLICT on a key collision with an existing custom or a reserved
   * builtin key. Returns the fresh custom `AgentEntry`.
   */
  createCustom: protectedProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        name: z.string().min(1),
        description: z.string().min(1),
        systemPrompt: z.string(),
        tools: toolsSchema,
        enabledMcps: enabledMcpsSchema,
        role: z.string().nullable().optional(),
        model: modelSchema,
      }),
    )
    .mutation(async ({ ctx, input }): Promise<AgentEntry> => {
      const deps = requireDeps(ctx);
      let agentKey: string;
      try {
        ({ agentKey } = await deps.agentOverrideRouter.applyChange(input.projectId, {
          op: 'createCustom',
          name: input.name,
          role: input.role ?? null,
          description: input.description,
          systemPrompt: input.systemPrompt,
          tools: input.tools,
          model: input.model ?? null,
          enabledMcps: input.enabledMcps,
        }));
      } catch (err) {
        rethrowAsTRPCError(err);
      }
      const entry = getEntry(deps, input.projectId, agentKey);
      if (!entry) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Custom agent "${agentKey}" not found after create`,
        });
      }
      return entry;
    }),

  /**
   * Duplicate any effective agent (builtin / builtin-override / custom) into a
   * new custom agent under `newName`. Seeds description / system prompt / tools /
   * role from the source, then routes through `createCustom` (CONFLICT on key
   * collision). NOT_FOUND when the source key is unknown.
   */
  duplicate: protectedProcedure
    .input(
      z.object({
        projectId: projectIdSchema,
        agentKey: agentKeySchema,
        newName: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<AgentEntry> => {
      const deps = requireDeps(ctx);
      const source = findEffective(deps, input.projectId, input.agentKey);
      if (!source) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Agent "${input.agentKey}" not found to duplicate in project ${input.projectId}`,
        });
      }
      let agentKey: string;
      try {
        ({ agentKey } = await deps.agentOverrideRouter.applyChange(input.projectId, {
          op: 'createCustom',
          name: input.newName,
          role: source.role,
          description: source.description,
          systemPrompt: source.systemPrompt,
          tools: source.tools,
          model: source.model,
          enabledMcps: source.enabledMcps,
        }));
      } catch (err) {
        rethrowAsTRPCError(err);
      }
      const entry = getEntry(deps, input.projectId, agentKey);
      if (!entry) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Custom agent "${agentKey}" not found after duplicate`,
        });
      }
      return entry;
    }),

  /**
   * Delete a custom agent. Pre-checks: BAD_REQUEST when the key is a builtin
   * (no override or a builtin override — use resetOverride). The chokepoint's
   * referential guard surfaces a CONFLICT when a workflow step still binds it.
   */
  deleteCustom: protectedProcedure
    .input(z.object({ projectId: projectIdSchema, agentKey: agentKeySchema }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      const deps = requireDeps(ctx);
      const existing = deps.agentOverrideRouter.getByKey(input.projectId, input.agentKey);
      if (!existing || existing.is_custom !== 1) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Agent "${input.agentKey}" is not a custom agent — use resetOverride, not deleteCustom`,
        });
      }
      try {
        await deps.agentOverrideRouter.applyChange(input.projectId, {
          op: 'deleteCustom',
          agentKey: input.agentKey,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
      return { ok: true };
    }),

  /**
   * Subscribe to agent-override-changed notifications for a single project.
   *
   * Bridges the module-level `agentOverrideChangeEvents` EventEmitter (exported
   * from agentOverrideRouter.ts) on the project-scoped channel
   * `agent-override-project-<projectId>`. The chokepoint emits an
   * `AgentChangedEvent` on that channel after every committed write.
   */
  onChanged: protectedProcedure
    .input(z.object({ projectId: projectIdSchema }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<AgentChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<AgentChangedEvent>(
        agentOverrideChangeEvents,
        agentOverrideProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
