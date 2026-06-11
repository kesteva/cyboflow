/**
 * builtInWorkflows — the in-repo, self-contained source of cyboflow's two
 * built-in workflows (Planner + Sprint), both seeded as `workflows` rows so the
 * registry has a row to launch by `wf-<projectId>-<name>`. A parallel sprint is
 * a single session-hosted `sprint` run (the orchestrator agent fans out
 * per-task subagents itself) — there are no scheduler-internal flows.
 *
 * This SEVERS the historical runtime dependency on the SoloFlow plugin cache
 * (`~/.claude/plugins/cache/soloflow/...`). The prompt BODIES now live in this
 * repo as sibling `.md` files (`planner.md`, `sprint.md`), and `workflow_path`
 * points at them so `WorkflowRegistry.seed()` can read each file's frontmatter
 * `permission_mode`.
 *
 * Path resolution mirrors `database.ts` `runFileBasedMigrations()`: resolve
 * relative to the compiled bundle's `__dirname`. `copy:assets` places the prompt
 * files at `dist/main/src/orchestrator/workflows/*.md` at build time, so at
 * runtime `join(__dirname, '<name>.md')` resolves correctly in both dev (ts via
 * the source tree) and packaged builds.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 */
import { join } from 'path';
import type { WorkflowDescriptor } from '../workflowRegistry';
import { CYBOFLOW_WORKFLOW_NAMES, type CyboflowWorkflowName } from '../../../../shared/types/workflows';

/**
 * Build the in-repo built-in workflow descriptors (Planner + Sprint), each
 * pointing at its sibling prompt `.md` file resolved relative to the compiled
 * bundle.
 *
 * The returned set is keyed exactly by `CYBOFLOW_WORKFLOW_NAMES` — adding or
 * removing a flow name there is a compile-time tripwire on this map.
 */
export function buildBuiltInWorkflows(): WorkflowDescriptor[] {
  const promptPath = (name: CyboflowWorkflowName): string => join(__dirname, `${name}.md`);
  return CYBOFLOW_WORKFLOW_NAMES.map((name) => ({ name, path: promptPath(name) }));
}
