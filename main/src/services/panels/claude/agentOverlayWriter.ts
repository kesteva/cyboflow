/**
 * agentOverlayWriter — the substrate-shared seam that materializes a project's
 * EFFECTIVE agent set (built-in catalogue + `agent_overrides`) into a run's
 * worktree `.claude/agents/` directory, so BOTH CLI substrates auto-discover the
 * project's customized agents at spawn (migration 028 / agent gallery feature).
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
import { computeEffectiveAgents } from '../../../orchestrator/agents/effectiveAgents';
import { renderAgentMarkdown } from '../../../orchestrator/agents/agentMarkdown';

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
 * table is absent (a DB predating migration 028) or on any read error — the overlay
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
    const projectId = getRunProjectId(db, runId, logger);
    if (projectId === null) {
      logger?.debug(`[AgentOverlay] no project for runId=${runId} — nothing to overlay`);
      return;
    }

    const overrides = readOverrides(db, projectId, logger);
    const effective = computeEffectiveAgents(loadBuiltInAgents(), overrides);
    if (effective.length === 0) return;

    const dir = path.join(worktreePath, ...AGENTS_DIR);
    fs.mkdirSync(dir, { recursive: true });

    let written = 0;
    for (const agent of effective) {
      // Unoverridden builtins carry their verbatim `.md` (write byte-for-byte);
      // overrides + custom agents have no rawContent and are rendered.
      const content = agent.rawContent ?? renderAgentMarkdown(agent);
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
