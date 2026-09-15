/**
 * workflowConfigHandlers — the cyboflow_*_workflow / cyboflow_*_variant MCP
 * handler family, extracted from mcpQueryHandler.ts (GitHub issue #19, the
 * god-file split, step 2).
 *
 * Free functions over an explicit WorkflowConfigHandlerContext rather than
 * class methods, so McpQueryHandler's switch arms stay put and simply pass
 * its own `workflowConfigCtx` (built once in the constructor) through. No
 * behavior change: every body below is moved verbatim apart from the
 * mechanical `this.x` -> `ctx.x` and static-call rewrites.
 */

import * as net from 'net';
import type { DatabaseLike, LoggerLike } from '../../types';
import type {
  McpQueryMessage,
  McpQueryResponse,
  McpQueryHandlerDeps,
  WorkflowConfigLike,
} from '../mcpQueryMessages';
import type { TaskActor } from '../../taskChangeRouter';
import type { WorkflowDefinition, WorkflowRow } from '../../../../../shared/types/workflows';
import { hasCustomSpecSlot, isCyboflowWorkflowName } from '../../../../../shared/types/workflows';
import type { WorkflowVariantRow } from '../../../../../shared/types/experiments';
import { workflowDefinitionSchema } from '../../workflowDefinitionSchema';

/**
 * Everything the workflow/variant config handlers need from McpQueryHandler,
 * built once in its constructor and reused for every call (see
 * `workflowConfigCtx` there).
 */
export interface WorkflowConfigHandlerContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
  resolveTaskRunContext(
    runId: string,
  ): { ok: true; projectId: number; actor: TaskActor } | { ok: false; error: string };
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
export function resolveWorkflowConfig(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { runId: string; requestId: string }>,
  client: net.Socket,
): { cfg: WorkflowConfigLike; projectId: number } | null {
  const cfg = ctx.deps.workflowConfig;
  if (!cfg) {
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: false,
      error: 'workflow_config_unavailable',
    });
    return null;
  }
  const runCtx = ctx.resolveTaskRunContext(msg.runId);
  if (!runCtx.ok) {
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: false,
      error: runCtx.error,
    });
    return null;
  }
  return { cfg, projectId: runCtx.projectId };
}

/** Compact workflow projection (no spec_json blob — see get_workflow for the definition). */
export function toCompactWorkflow(row: WorkflowRow): Record<string, unknown> {
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
export function toCompactVariant(row: WorkflowVariantRow): Record<string, unknown> {
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
export function parseDefinitionJson(
  ctx: WorkflowConfigHandlerContext,
  definitionJson: string,
  requestId: string,
  client: net.Socket,
): WorkflowDefinition | null {
  let raw: unknown;
  try {
    raw = JSON.parse(definitionJson);
  } catch {
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'invalid_json',
    });
    return null;
  }
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.writeResponse(client, {
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
export function writeWorkflowConfigError(
  ctx: WorkflowConfigHandlerContext,
  client: net.Socket,
  requestId: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  let error = 'workflow_config_failed';
  if (message.includes('not found')) error = 'not_found';
  else if (message.includes('run history')) error = 'run_history';
  else if (message.includes('already exists')) error = 'already_exists';
  else if (message.includes('reserved')) error = 'reserved';
  else if (message.includes('unresolvable')) error = 'unresolvable';
  else if (message.includes('cannot reset')) error = 'not_a_builtin';
  else {
    ctx.logger?.error('[Cyboflow MCP Query] workflow config change failed', { error: message });
  }
  ctx.writeResponse(client, { type: 'mcp-query-response', requestId, ok: false, error });
}

export function handleListWorkflows(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-list-workflows' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  const { cfg, projectId } = resolved;
  // Reconcile the in-repo built-ins as global rows first (mirrors the tRPC
  // list) so a fresh project sees planner/sprint/compound/ship.
  cfg.ensureGlobalBuiltIns();
  const rows = cfg.listByProject(projectId);
  ctx.writeResponse(client, {
    type: 'mcp-query-response',
    requestId: msg.requestId,
    ok: true,
    data: { workflows: rows.map((r) => toCompactWorkflow(r)) },
  });
}

export function handleGetWorkflow(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-get-workflow' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  const { cfg } = resolved;
  const row = cfg.getById(msg.workflowId);
  if (!row) {
    ctx.writeResponse(client, {
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
  ctx.writeResponse(client, {
    type: 'mcp-query-response',
    requestId: msg.requestId,
    ok: true,
    data: {
      workflow: toCompactWorkflow(row),
      definition,
      baseline_rotation: baselineRotation,
    },
  });
}

export function handleUpdateWorkflow(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-update-workflow' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  const definition = parseDefinitionJson(ctx, msg.definitionJson, msg.requestId, client);
  if (!definition) return;
  try {
    resolved.cfg.updateSpec(msg.workflowId, definition);
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflow_id: msg.workflowId },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleResetWorkflow(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-reset-workflow' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  try {
    resolved.cfg.resetSpec(msg.workflowId);
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflow_id: msg.workflowId },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleCreateWorkflow(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-create-workflow' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  // Optional definition — omit to seed a default '{}' flow (createCustom's own
  // default). A supplied definition is validated with the strict schema.
  let specJson: string | undefined;
  if (msg.definitionJson !== undefined) {
    const definition = parseDefinitionJson(ctx, msg.definitionJson, msg.requestId, client);
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
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflow: toCompactWorkflow(row) },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleDeleteWorkflow(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-delete-workflow' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  try {
    resolved.cfg.deleteWorkflow(msg.workflowId);
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflow_id: msg.workflowId, deleted: true },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleListVariants(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-list-variants' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  const rows = resolved.cfg.listVariants(msg.workflowId);
  ctx.writeResponse(client, {
    type: 'mcp-query-response',
    requestId: msg.requestId,
    ok: true,
    data: { variants: rows.map((r) => toCompactVariant(r)) },
  });
}

export function handleCreateVariant(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-create-variant' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  // An explicit definition seeds the variant's frozen graph instead of the
  // workflow's resolved one; validated the same way update_workflow validates
  // its payload (invalid_json / invalid_definition), so a malformed graph
  // never reaches the registry.
  let definition: WorkflowDefinition | undefined;
  if (msg.definitionJson !== undefined) {
    const parsed = parseDefinitionJson(ctx, msg.definitionJson, msg.requestId, client);
    if (!parsed) return;
    definition = parsed;
  }
  try {
    const row = resolved.cfg.createVariantFromCurrent(msg.workflowId, msg.label, {
      ...(definition !== undefined ? { definition } : {}),
      ...(msg.tuningLevel !== undefined ? { tuningLevel: msg.tuningLevel } : {}),
    });
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { variant: toCompactVariant(row) },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleUpdateVariant(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-update-variant' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  // A supplied definition is validated + re-serialized; agent_overrides_json is
  // stored verbatim (already a JSON string or explicit null clearing it).
  let specJson: string | undefined;
  if (msg.definitionJson !== undefined) {
    const definition = parseDefinitionJson(ctx, msg.definitionJson, msg.requestId, client);
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
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { variant_id: msg.variantId },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleSetVariantStatus(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-set-variant-status' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  try {
    resolved.cfg.setVariantStatus(msg.variantId, msg.status);
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { variant_id: msg.variantId, status: msg.status },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleDeleteVariant(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-delete-variant' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  try {
    resolved.cfg.deleteVariant(msg.variantId);
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { variant_id: msg.variantId, deleted: true },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

export function handleSetBaselineRotation(
  ctx: WorkflowConfigHandlerContext,
  msg: Extract<McpQueryMessage, { type: 'mcp-set-baseline-rotation' }>,
  client: net.Socket,
): void {
  const resolved = resolveWorkflowConfig(ctx, msg, client);
  if (!resolved) return;
  try {
    resolved.cfg.setBaselineRotation(msg.workflowId, {
      ...(msg.inRotation !== undefined ? { inRotation: msg.inRotation } : {}),
      ...(msg.weight !== undefined ? { weight: msg.weight } : {}),
    });
    const updated = resolved.cfg.getBaselineRotation(msg.workflowId);
    ctx.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { workflow_id: msg.workflowId, baseline_rotation: updated },
    });
  } catch (err) {
    writeWorkflowConfigError(ctx, client, msg.requestId, err);
  }
}

/** Read a raw `workflows` row directly (no WorkflowConfigLike dep needed for a read). Null when absent. */
export function readWorkflowRow(db: DatabaseLike, workflowId: string): WorkflowRow | null {
  const row = db
    .prepare(
      `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, tuning_level, runtime_mix, created_at, archived_at
           FROM workflows WHERE id = ?`,
    )
    .get(workflowId) as WorkflowRow | undefined;
  return row ?? null;
}
