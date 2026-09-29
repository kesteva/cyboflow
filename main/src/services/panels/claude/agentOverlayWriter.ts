/**
 * agentOverlayWriter — the substrate-shared seam that materializes a project's
 * EFFECTIVE agent set (built-in catalogue + `agent_overrides`) into a run's
 * worktree `.claude/agents/` directory, so BOTH CLI substrates auto-discover the
 * project's customized agents at spawn (migration 029 / agent gallery feature).
 *
 * This is layered ON TOP of `WorkflowBundleWriter`: that writer places a flow's
 * sibling-bundle agents verbatim; this overlay then writes the FULL effective set
 * (every builtin, override-applied, plus any custom agents) so a custom/quick flow
 * with no sibling bundle still gets the project's agents, and an overridden builtin
 * gets its override body instead of the bundled body. Each file is written as
 * `cyboflow-<agentKey>.md` — the same namespace `WorkflowBundleWriter` owns, so a
 * later overlay write simply re-writes (overrides) the bundle's file for that key.
 *
 * For an UNOVERRIDDEN builtin we write `effective.rawContent` VERBATIM (byte-for-byte
 * the bundled `.md`); otherwise we render via `renderAgentMarkdown` (which forces the
 * frontmatter name to `cyboflow-<key>` regardless of any stored name).
 *
 * The effective set is composed low→high as
 * `builtin → project agent_overrides → WORKFLOW agentConfigs → variant deltas →
 * RUN agent-target overrides`: a workflow-scoped agent config (from the run's frozen
 * `spec_json.agentConfigs`) is applied ON TOP of the project overrides, an A/B
 * variant's per-agent deltas on top of that, and the run's operator-written
 * runtime/model re-targets (migration 144) LAST — so a workflow config beats the
 * Agents-pane pin/body, a variant delta beats the workflow config, and a mid-run
 * "Switch runtime & retry" beats them all. Every layer read is fail-soft (a broken
 * spec / variant / override blob is skipped, never a spawn break).
 *
 * NEVER removes/clears anything (the bundle writer owns the cyboflow-* lifecycle) and
 * NEVER throws — an overlay failure must not break a spawn (wrapped in try/catch +
 * `logger?.warn`).
 *
 * DEVIATION FROM PLAN: the overlay is fully SYNCHRONOUS (better-sqlite3 reads and
 * `writeFileSync` are sync) and is invoked inside the synchronous
 * `installWorkflowBundle` seam — the plan speculated an async wrapper invoked from
 * each manager, but synchronous-at-the-single-seam is simpler and requires no
 * manager call-site changes (both substrates inherit it from that one seam).
 *
 * Like `workflowBundleInstall`, this helper bridges DB + catalogue + renderer, so it
 * MAY import better-sqlite3 and the orchestrator agent modules.
 */
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { LoggerLike } from '../../../orchestrator/types';
import type { AgentOverrideRow } from '../../../database/models';
import { loadBuiltInAgents } from '../../../orchestrator/agents/agentCatalogue';
import {
  computeEffectiveAgents,
  applyWorkflowAgentConfigs,
  applyVariantAgentDeltas,
  applyPromptAddenda,
  applyRunAgentTargetOverrides,
  type EffectiveAgent,
} from '../../../orchestrator/agents/effectiveAgents';
import { renderAgentMarkdown } from '../../../orchestrator/agents/agentMarkdown';
import { computeAgentUsage } from '../../../orchestrator/agents/agentUsage';
import { resolveRunFrozenSpec } from '../../../orchestrator/runFrozenSpec';
import {
  parseRunAgentTargetOverrides,
  parseWorkflowDefinition,
  type RunAgentTargetOverrides,
  type WorkflowAgentConfig,
} from '../../../../../shared/types/workflows';
import {
  AGENT_PROVIDERS,
  providerForRuntime,
  type AgentProvider,
} from '../../../../../shared/types/agentRuntime';
import type { WorkflowVariantAgentOverrides } from '../../../../../shared/types/experiments';
import { bareModelId } from '../../../../../shared/agents/modelContext';
import { isModelUsable } from '../../modelAvailabilityService';
import type { EffectiveAgentsResolver } from '../../../orchestrator/runStepModels';

/** The `.claude/agents` subpath (relative to the worktree) the overlay writes into. */
const AGENTS_DIR = ['.claude', 'agents'] as const;

/** The cyboflow filename namespace — every written file is `cyboflow-<agentKey>.md`. */
const CYBOFLOW_PREFIX = 'cyboflow-';

/**
 * Resolve the run's `project_id` from `workflow_runs`. Fail-soft to `null` on a
 * missing run row or a DB error (mirrors `workflowBundleInstall.getRunWorkflowPath`).
 */
function getRunProjectId(db: Database.Database, runId: string, logger?: LoggerLike): number | null {
  try {
    const row = db
      .prepare(`SELECT project_id AS projectId FROM workflow_runs WHERE id = ?`)
      .get(runId) as { projectId?: unknown } | undefined;
    return typeof row?.projectId === 'number' ? row.projectId : null;
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] project_id lookup failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Read the project's `agent_overrides` rows. Wrapped in try/catch → `[]` when the
 * table is absent (a DB predating migration 029) or on any read error — the overlay
 * then writes the pure built-in set.
 */
function readOverrides(db: Database.Database, projectId: number, logger?: LoggerLike): AgentOverrideRow[] {
  try {
    return db
      .prepare(`SELECT * FROM agent_overrides WHERE project_id = ?`)
      .all(projectId) as AgentOverrideRow[];
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] agent_overrides read failed for projectId=${projectId} (table absent?): ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Read a run's VARIANT agent deltas (A/B testing, migration 048): resolve the
 * run's `variant_id`, load the variant's `agent_overrides_json`, and parse it into
 * a `WorkflowVariantAgentOverrides` map. Returns `null` (apply nothing) when the
 * run is not variant-tagged, the variant/column is absent, or the JSON is
 * malformed — a broken variant must NEVER break a spawn (fail-soft, warn once).
 */
function readVariantAgentDeltas(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): WorkflowVariantAgentOverrides | null {
  let variantId: string | null;
  try {
    const runRow = db
      .prepare('SELECT variant_id AS variantId FROM workflow_runs WHERE id = ?')
      .get(runId) as { variantId?: unknown } | undefined;
    variantId = typeof runRow?.variantId === 'string' ? runRow.variantId : null;
  } catch {
    // Pre-048 DB (column absent) — no variants exist, so nothing to apply.
    return null;
  }
  if (variantId === null) return null;

  let overridesJson: string | null;
  try {
    const variantRow = db
      .prepare('SELECT agent_overrides_json AS overridesJson FROM workflow_variants WHERE id = ?')
      .get(variantId) as { overridesJson?: unknown } | undefined;
    overridesJson = typeof variantRow?.overridesJson === 'string' ? variantRow.overridesJson : null;
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] variant lookup failed for runId=${runId} variant=${variantId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (overridesJson === null) return null;

  try {
    const parsed: unknown = JSON.parse(overridesJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // Trust the stored shape (the router validated it on write); a downstream
    // delta with the wrong field types is tolerated by applyVariantAgentDeltas.
    return parsed as WorkflowVariantAgentOverrides;
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] malformed agent_overrides_json for variant=${variantId} (runId=${runId}); skipping variant deltas: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Read a run's WORKFLOW agent configs (workflow-scoped agent configs): resolve the
 * run's FROZEN spec via resolveRunFrozenSpec (its variant graph, else the live
 * spec — already keyed by the run's `(workflow_id, spec_hash)`), parse it with
 * parseWorkflowDefinition, and return `definition.agentConfigs`. Returns `null`
 * (apply nothing) when the run/spec is missing, the spec is malformed, or it carries
 * no agentConfigs — a broken spec must NEVER break a spawn (fail-soft, warn once,
 * never throw; resolveRunFrozenSpec can rethrow a genuine DB error, which this
 * catch degrades to the skip path).
 */
function readWorkflowAgentConfigs(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): Record<string, WorkflowAgentConfig> | null {
  try {
    const frozen = resolveRunFrozenSpec(db, runId);
    const definition = parseWorkflowDefinition(frozen?.specJson);
    return definition?.agentConfigs ?? null;
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] workflow agentConfigs read failed for runId=${runId}; skipping workflow layer: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Run ids whose malformed agent_target_overrides_json was already warned about (warn once). */
const warnedMalformedRunTargets = new Set<string>();

/**
 * Read a run's operator-written AGENT-TARGET overrides (migration 144 —
 * workflow_runs.agent_target_overrides_json, written only by
 * switchRunAgentsHandler). Returns `null` (apply nothing) when the column is
 * absent (a pre-144 / fixture DB: `no such column`), NULL, or malformed — a broken
 * override blob must NEVER break a spawn (fail-soft; a malformed blob warns once
 * per run).
 */
export function readRunAgentTargetOverrides(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): RunAgentTargetOverrides | null {
  let json: string | null;
  try {
    const row = db
      .prepare('SELECT agent_target_overrides_json AS json FROM workflow_runs WHERE id = ?')
      .get(runId) as { json?: unknown } | undefined;
    json = typeof row?.json === 'string' ? row.json : null;
  } catch {
    // Pre-144 DB (column absent) — no run-level overrides can exist.
    return null;
  }
  if (json === null) return null;
  const parsed = parseRunAgentTargetOverrides(json);
  if (parsed === null && !warnedMalformedRunTargets.has(runId)) {
    warnedMalformedRunTargets.add(runId);
    logger?.warn(
      `[AgentOverlay] malformed agent_target_overrides_json for runId=${runId}; skipping run-level overrides`,
    );
  }
  return parsed;
}

/**
 * Resolve the run's FULL effective agent set — the same assembly
 * `installAgentOverlay` writes to disk, exposed as a pure DB read for callers that
 * need the resolved `EffectiveAgent[]` in memory (e.g. the programmatic per-step
 * `resolveStepAgent` seam) rather than materialized `.md` files. Returns `[]` when
 * the run resolves to no project (mirrors `installAgentOverlay`'s no-op).
 *
 * Precedence (low → high), applied left-to-right below:
 *   builtin → project `agent_overrides` → WORKFLOW `agentConfigs` → variant deltas
 *   → RUN agent-target overrides.
 * The WORKFLOW layer (workflow-scoped agent configs) applies its per-agent config
 * ON TOP of the project-override effective set — so a workflow config WINS over the
 * project override — and a variant run's per-agent deltas (A/B testing, migration
 * 048) then apply, so a variant delta still WINS over the workflow config for
 * the fields it touches. The RUN layer (migration 144 — the operator's mid-run
 * "Switch runtime & retry" on a limit-paused programmatic run) applies last among
 * the target layers: it is a live directive and must beat every frozen/launch-time
 * layer for runtime/model/providerModel/effort. It touches no prompt field.
 *
 * A workflow agent config's `promptAddendum` (tuning levels, plan D5) is then
 * APPENDED to whichever system prompt that merge resolved — after the variant
 * delta, so it composes with a wholesale variant replacement too. It is a pure
 * append: no other field of the resolved agent moves. Doing it here, at the one
 * point where the effective prompt is finished, is what makes it reach BOTH planes
 * — the orchestrated overlay `.md` files and the programmatic `resolveStepAgent`
 * seam both read this function's return value.
 */
export function resolveRunEffectiveAgents(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): EffectiveAgent[] {
  const projectId = getRunProjectId(db, runId, logger);
  if (projectId === null) {
    logger?.debug(`[AgentOverlay] no project for runId=${runId} — nothing to overlay`);
    return [];
  }

  const overrides = readOverrides(db, projectId, logger);
  let effective: EffectiveAgent[] = computeEffectiveAgents(loadBuiltInAgents(), overrides);
  const workflowConfigs = readWorkflowAgentConfigs(db, runId, logger);
  if (workflowConfigs) {
    effective = applyWorkflowAgentConfigs(effective, workflowConfigs);
  }
  const variantDeltas = readVariantAgentDeltas(db, runId, logger);
  if (variantDeltas) {
    effective = applyVariantAgentDeltas(effective, variantDeltas);
  }
  const runTargets = readRunAgentTargetOverrides(db, runId, logger);
  if (runTargets) {
    effective = applyRunAgentTargetOverrides(effective, runTargets);
  }
  if (workflowConfigs) {
    effective = applyPromptAddenda(effective, workflowConfigs);
  }
  return effective;
}

/**
 * The effective agents THIS RUN's frozen definition binds — the roles a non-Claude
 * runtime registers natively (Codex agent roles, OMP project agents) so its
 * `cyboflow-<key>` delegations resolve to the run's actual role prompts.
 *
 * Unlike {@link listRunAgentTargets}, an unresolvable definition yields `[]`
 * rather than the whole catalogue: every registered role is advertised in the
 * runtime's delegation-tool description, so a quick chat or a definition-less
 * custom flow would otherwise pay for two dozen roles it never deploys.
 */
export function resolveRunDeployableAgents(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): EffectiveAgent[] {
  const used = usedAgentKeysForRun(db, runId, logger);
  if (used === null) return [];
  return resolveRunEffectiveAgents(db, runId, logger).filter((agent) => used.has(agent.agentKey));
}

/**
 * The agents THIS RUN can spawn, each paired with the PROVIDER it resolves onto:
 * its pinned runtime's provider when one is set, else the run row's
 * `agent_provider` stamp (absent/unknown ⇒ 'claude'). Backs the "Switch runtime &
 * retry" handler's 'provider' scope (every agent currently on the blocked
 * provider).
 *
 * "This run's agents" = the keys its FROZEN definition binds (outer steps +
 * fan-out inner chains, via computeAgentUsage) — not the whole built-in
 * catalogue, which would make a switch write a dozen overrides for agents the
 * run never deploys and pad the run's override chip with them. A run whose
 * frozen spec cannot be resolved (a custom flow with no definition, a minimal
 * fixture) falls back to the full effective set, so a switch is never silently
 * empty. Fail-soft: an unresolvable run yields `[]`.
 */
export function listRunAgentTargets(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): Array<{ agentKey: string; provider: AgentProvider }> {
  let runProvider: AgentProvider = 'claude';
  try {
    const row = db
      .prepare('SELECT agent_provider AS provider FROM workflow_runs WHERE id = ?')
      .get(runId) as { provider?: unknown } | undefined;
    const p = row?.provider;
    if (typeof p === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(p)) {
      runProvider = p as AgentProvider;
    }
  } catch {
    // Pre-062 DB (column absent) — every run is a Claude run.
  }
  const used = usedAgentKeysForRun(db, runId, logger);
  return resolveRunEffectiveAgents(db, runId, logger)
    .filter((agent) => used === null || used.has(agent.agentKey))
    .map((agent) => ({
      agentKey: agent.agentKey,
      provider: agent.runtime ? providerForRuntime(agent.runtime) : runProvider,
    }));
}

/**
 * The agent keys the run's frozen definition binds, or null when the definition
 * cannot be resolved (⇒ callers fall back to the full effective set). Read
 * through the same frozen-spec seam the workflow-config layer uses, so the
 * agent set and the per-agent configs always describe the same revision.
 */
function usedAgentKeysForRun(
  db: Database.Database,
  runId: string,
  logger?: LoggerLike,
): ReadonlySet<string> | null {
  try {
    const frozen = resolveRunFrozenSpec(db, runId);
    const definition = parseWorkflowDefinition(frozen?.specJson);
    if (!definition) return null;
    // computeAgentUsage pre-seeds EVERY canonical key (the catalogue shows
    // unused agents too) — only an entry some step actually binds counts.
    const usage = computeAgentUsage([{ name: frozen?.workflowName ?? 'run', definition }]);
    const used = new Set<string>();
    for (const [key, entry] of usage) if (entry.usedBy.length > 0) used.add(key);
    return used.size > 0 ? used : null;
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] frozen definition read failed for runId=${runId}; listing every effective agent: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Bind {@link resolveRunEffectiveAgents} to a live db-handle getter, producing
 * the `ContextDeps.resolveRunEffectiveAgents` closure `attachOrchestratorTrpcToWindow`
 * (main/src/index.ts) wires into the tRPC context for `runs.getStepModels`
 * (IDEA-061 per-step model rail) — the standalone orchestrator tree never
 * imports this file directly (see `runStepModels.ts`'s "DEPENDENCY INJECTION"
 * note). `getDb` is read LIVE on every call (the real better-sqlite3 handle
 * this function needs) rather than the narrowed `DatabaseLike` the closure
 * itself receives. Extracted here (out of index.ts, which sits at its frozen
 * size ratchet, issue #19) rather than left inline at the call site.
 */
export function createRunEffectiveAgentsResolver(getDb: () => Database.Database): EffectiveAgentsResolver {
  return (_db, runId, logger) => resolveRunEffectiveAgents(getDb(), runId, logger);
}

/**
 * Materialize the project's full effective agent set into `<worktreePath>/.claude/agents/`
 * as `cyboflow-<agentKey>.md` files. No-op (writes nothing) when the run row is missing.
 * Never removes anything; never throws — a failure here must not break a spawn.
 */
export function installAgentOverlay(
  db: Database.Database,
  runId: string,
  worktreePath: string,
  logger?: LoggerLike,
): void {
  try {
    const effective = resolveRunEffectiveAgents(db, runId, logger);
    if (effective.length === 0) return;

    const dir = path.join(worktreePath, ...AGENTS_DIR);
    fs.mkdirSync(dir, { recursive: true });

    let written = 0;
    for (const agent of effective) {
      // Unoverridden builtins carry their verbatim `.md` (write byte-for-byte);
      // overrides + custom agents have no rawContent and are rendered. A pinned
      // model alias is resolved to its bare concrete snapshot id for the
      // subagent `model:` frontmatter (null/inherit emits no model line); a
      // guarded model that's been pulled (Fable 5.1) falls back to Opus so the `.md`
      // never writes a dead model.
      const content =
        agent.rawContent ??
        renderAgentMarkdown({ ...agent, model: bareModelId(agent.model, isModelUsable) });
      const target = path.join(dir, `${CYBOFLOW_PREFIX}${agent.agentKey}.md`);
      fs.writeFileSync(target, content, 'utf8');
      written += 1;
    }

    logger?.debug('[AgentOverlay] installed effective agent overlay', {
      worktreePath,
      written,
    });
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] overlay failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
