/**
 * WorkflowRegistry — seeds and queries the `workflows` table, and creates
 * `workflow_runs` rows that snapshot the per-workflow permission policy.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron'
 * or any concrete service in main/src/services/*.  All collaborators are
 * injected via the constructor.
 *
 * Frontmatter parsing note: the inline parser intentionally avoids js-yaml
 * or any third-party YAML library.  It handles the flat `key: value` blocks
 * used by SoloFlow workflow .md files and nothing more complex.
 */
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import type { LoggerLike, DatabaseLike } from './types';
import type { PermissionMode, WorkflowRow, WorkflowRunRow, SoloFlowWorkflowName } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Descriptor types
// ---------------------------------------------------------------------------

export interface WorkflowDescriptor {
  name: SoloFlowWorkflowName;
  path: string;
}

// ---------------------------------------------------------------------------
// Default workflow list (resolved against os.homedir() by the caller)
// ---------------------------------------------------------------------------

/**
 * Default SoloFlow workflow descriptors.
 * `pathFromHome` is resolved against `os.homedir()` by the caller before
 * passing the resolved paths to `seed()`.  Exported so integration tasks
 * (e.g. TASK-355) can override them in tests.
 */
export const DEFAULT_SOLOFLOW_WORKFLOWS: { name: SoloFlowWorkflowName; pathFromHome: string }[] = [
  { name: 'soloflow', pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/idea-extractor.md' },
  { name: 'planner',  pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/planner.md' },
  { name: 'sprint',   pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/sprint.md' },
  { name: 'compound', pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/compound.md' },
  { name: 'prune',    pathFromHome: '.claude/plugins/cache/soloflow/soloflow-dev/0.9.12/commands/prune.md' },
];

// ---------------------------------------------------------------------------
// WorkflowRegistry
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger: LoggerLike,
  ) {}

  // --------------------------------------------------------------------------
  // Frontmatter helpers (no third-party YAML — flat key: value only)
  // --------------------------------------------------------------------------

  /**
   * Parse the leading `--- ... ---` frontmatter block of a markdown file.
   * Handles CRLF and LF line endings.  Strips surrounding single/double quotes
   * from values.  Returns an empty object if no frontmatter block is found.
   */
  private parseFrontmatter(md: string): Record<string, string> {
    const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const out: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      // Strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[m[1]] = val;
    }
    return out;
  }

  /**
   * Extract the `permission_mode` field from frontmatter, normalising to a
   * valid PermissionMode.  Absent or unrecognised values fall back to
   * `'default'`.
   */
  private extractPermissionMode(md: string): PermissionMode {
    const fm = this.parseFrontmatter(md);
    const raw = fm['permission_mode'];
    if (raw === 'acceptEdits' || raw === 'dontAsk' || raw === 'default') {
      return raw;
    }
    return 'default';
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Seed the `workflows` table with the provided descriptors.
   *
   * Uses INSERT OR IGNORE on the `(project_id, name)` unique constraint so
   * re-seeding the same project is idempotent — existing rows are not updated.
   *
   * If a workflow .md file cannot be read, logs WARN and inserts the row with
   * `permission_mode='default'` rather than throwing.
   */
  seed(projectId: number, workflowDescriptors: WorkflowDescriptor[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO workflows (id, project_id, name, workflow_path, permission_mode)
      VALUES (?, ?, ?, ?, ?)
    `);

    const seedTx = this.db.transaction(() => {
      for (const descriptor of workflowDescriptors) {
        let permissionMode: PermissionMode = 'default';
        try {
          const md = readFileSync(descriptor.path, 'utf-8');
          permissionMode = this.extractPermissionMode(md);
        } catch (err) {
          this.logger.warn(`WorkflowRegistry.seed: could not read workflow file, defaulting permission_mode to 'default'`, {
            path: descriptor.path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // Use a deterministic ID so INSERT OR IGNORE is idempotent across seed calls.
        // Format: "wf-<projectId>-<name>" (URL-safe, unique per project+name pair).
        const deterministicId = `wf-${projectId}-${descriptor.name}`;
        insert.run(deterministicId, projectId, descriptor.name, descriptor.path, permissionMode);
      }
    });

    seedTx();
  }

  /**
   * Look up a workflow by its text primary key.
   * Returns null if no row exists with the given id.
   */
  getById(workflowId: string): WorkflowRow | null {
    const stmt = this.db.prepare(
      'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
    );
    const row = stmt.get(workflowId) as WorkflowRow | undefined;
    return row ?? null;
  }

  /**
   * List all workflows registered for a project.
   * Used by the frontend workflow picker.
   */
  listByProject(projectId: number): WorkflowRow[] {
    const stmt = this.db.prepare(
      'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE project_id = ? ORDER BY name',
    );
    return stmt.all(projectId) as WorkflowRow[];
  }

  /**
   * Create a new workflow_runs row for the given workflow.
   *
   * Snapshots the workflow's current `permission_mode` onto the run row so the
   * ApprovalRouter can consult per-run policy without re-reading the workflow
   * file.  The caller (epic-8 deterministic naming task) will later UPDATE
   * `worktree_path` and `branch_name`.
   *
   * Returns the generated runId and the snapshotted permissionMode.
   * Throws if the workflow does not exist.
   */
  createRun(workflowId: string): { runId: string; permissionMode: PermissionMode } {
    const workflow = this.getById(workflowId);
    if (!workflow) {
      throw new Error(`WorkflowRegistry.createRun: workflow ${workflowId} not found`);
    }

    const runId = randomUUID().replace(/-/g, '');
    const permissionMode = workflow.permission_mode;

    const insert = this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
      VALUES (?, ?, ?, 'queued', ?)
    `);

    const createTx = this.db.transaction(() => {
      insert.run(runId, workflowId, workflow.project_id, permissionMode);
    });

    createTx();

    return { runId, permissionMode };
  }

  /**
   * Look up a workflow run by its string primary key.
   * Returns null if no row exists.
   */
  getRunById(runId: string): WorkflowRunRow | null {
    const stmt = this.db.prepare(
      'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, created_at, updated_at FROM workflow_runs WHERE id = ?',
    );
    const row = stmt.get(runId) as WorkflowRunRow | undefined;
    return row ?? null;
  }
}
