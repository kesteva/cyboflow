/**
 * builtInWorkflows — the in-repo, self-contained source of cyboflow's built-in
 * workflows: the two user-facing flows (Planner + Sprint) PLUS the three
 * scheduler-internal parallel-sprint flows (task / sprint-init / sprint-finalize).
 *
 * All five are seeded as `workflows` rows so the registry has a row to launch by
 * `wf-<projectId>-<name>`; the three internal flows are filtered out of the
 * user-facing picker by `WorkflowRegistry.listByProject` (derived from each
 * definition's `internal: true` flag — see `isInternalWorkflowName`). The
 * internal flows are launched programmatically by the `SprintBatchScheduler`.
 *
 * This SEVERS the historical runtime dependency on the SoloFlow plugin cache
 * (`~/.claude/plugins/cache/soloflow/...`). The prompt BODIES now live in this
 * repo as sibling `.md` files (`planner.md`, `sprint.md`, `task.md`,
 * `sprint-init.md`, `sprint-finalize.md`), and `workflow_path` points at them so
 * `WorkflowRegistry.seed()` can read each file's frontmatter `permission_mode`.
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
 * Build the in-repo built-in workflow descriptors (Planner + Sprint + the three
 * internal parallel-sprint flows), each pointing at its sibling prompt `.md`
 * file resolved relative to the compiled bundle.
 *
 * The returned set is keyed exactly by `CYBOFLOW_WORKFLOW_NAMES` — adding or
 * removing a flow name there is a compile-time tripwire on this map. Internal
 * flows are included here (they need a `workflows` row to launch) but are hidden
 * from the picker by `WorkflowRegistry.listByProject`.
 */
export function buildBuiltInWorkflows(): WorkflowDescriptor[] {
  const promptPath = (name: CyboflowWorkflowName): string => join(__dirname, `${name}.md`);
  return CYBOFLOW_WORKFLOW_NAMES.map((name) => ({ name, path: promptPath(name) }));
}
