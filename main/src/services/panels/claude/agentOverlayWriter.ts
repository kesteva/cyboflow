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
  applyVariantAgentDeltas,
  type EffectiveAgent,
} from '../../../orchestrator/agents/effectiveAgents';
import { renderAgentMarkdown } from '../../../orchestrator/agents/agentMarkdown';
import type { WorkflowVariantAgentOverrides } from '../../../../../shared/types/experiments';
import { bareModelId } from './modelContext';
import { isModelUsable } from '../../modelAvailabilityService';

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
 * Read a run's VARIANT agent deltas (A/B testing, migration 046): resolve the
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
    // Pre-046 DB (column absent) — no variants exist, so nothing to apply.
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
 * Materialize the project's full effective agent set into `<worktreePath>/.claude/agents/`
 * as `cyboflow-<agentKey>.md` files. No-op (writes nothing) when the run row is missing.
 * Never removes anything; never throws — a failure here must not break a spawn.
 *
 * A/B testing (migration 046): after computing the project-override effective set,
 * a variant run applies its per-agent deltas ON TOP via applyVariantAgentDeltas —
 * so the variant delta WINS over the project override for the fields it touches.
 */
export function installAgentOverlay(
  db: Database.Database,
  runId: string,
  worktreePath: string,
  logger?: LoggerLike,
): void {
  try {
    const projectId = getRunProjectId(db, runId, logger);
    if (projectId === null) {
      logger?.debug(`[AgentOverlay] no project for runId=${runId} — nothing to overlay`);
      return;
    }

    const overrides = readOverrides(db, projectId, logger);
    let effective: EffectiveAgent[] = computeEffectiveAgents(loadBuiltInAgents(), overrides);
    const variantDeltas = readVariantAgentDeltas(db, runId, logger);
    if (variantDeltas) {
      effective = applyVariantAgentDeltas(effective, variantDeltas);
    }
    if (effective.length === 0) return;

    const dir = path.join(worktreePath, ...AGENTS_DIR);
    fs.mkdirSync(dir, { recursive: true });

    let written = 0;
    for (const agent of effective) {
      // Unoverridden builtins carry their verbatim `.md` (write byte-for-byte);
      // overrides + custom agents have no rawContent and are rendered. A pinned
      // model alias is resolved to its bare concrete snapshot id for the
      // subagent `model:` frontmatter (null/inherit emits no model line); a
      // guarded model that's been pulled (Fable 5) falls back to Opus so the `.md`
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
      projectId,
      written,
      overrides: overrides.length,
    });
  } catch (err) {
    logger?.warn(
      `[AgentOverlay] overlay failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
