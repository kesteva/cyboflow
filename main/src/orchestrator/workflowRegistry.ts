/**
 * WorkflowRegistry — seeds and queries the `workflows` table, and creates
 * `workflow_runs` rows that snapshot the per-workflow permission policy.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron'
 * or any concrete service in main/src/services/*.  All collaborators are
 * injected via the constructor.
 *
 * Frontmatter parsing note: the parser lives in markdownFrontmatter.ts and
 * intentionally avoids js-yaml or any third-party YAML library.  It handles
 * the flat `key: value` blocks used by the in-repo workflow .md files and
 * nothing more complex.
 */
import { readFileSync } from 'fs';
import { parseMarkdownFrontmatter } from './markdownFrontmatter';
import { randomUUID } from 'crypto';
import type { LoggerLike, DatabaseLike } from './types';
import type { PermissionMode, WorkflowRow, WorkflowRunRow, CyboflowWorkflowName, WorkflowDefinition } from '../../../shared/types/workflows';
import { isCyboflowWorkflowName } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import { resolveSubstrate } from './substrateResolver';
import { resolvePermissionMode } from './permissionModeResolver';

// ---------------------------------------------------------------------------
// Descriptor types
// ---------------------------------------------------------------------------

export interface WorkflowDescriptor {
  name: CyboflowWorkflowName;
  path: string;
}

/**
 * Narrow config surface required by createRun to inject the global defaults
 * (agent permission mode + CLI substrate) into the resolvers.
 *
 * Injected as a provider object rather than the concrete ConfigManager so the
 * standalone-typecheck invariant holds (no concrete-service import). The real
 * ConfigManager satisfies this shape structurally. Optional so existing
 * test-fixture constructions (no config) keep flooring to 'default' / 'sdk'.
 */
export interface WorkflowConfigProvider {
  getDefaultAgentPermissionMode(): PermissionMode;
  getDefaultSubstrate(): CliSubstrate;
}

// The built-in workflow descriptors now live in-repo. See
// `workflows/builtInWorkflows.ts` (`buildBuiltInWorkflows()`), which points each
// flow at its sibling prompt `.md` file resolved relative to the compiled
// bundle. The historical plugin-cache discovery helpers were removed: the app
// no longer depends on the external plugin cache directory at runtime.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Name of the per-project sentinel workflow that represents quick sessions
 * in the workflow_runs pipeline (TASK-787 / IDEA-027).
 *
 * The sentinel row is inserted by migration 012_quick_workflow_sentinel.sql
 * for existing projects and by ensureQuickWorkflow() for new projects.
 * listByProject() excludes it so it never appears in the user-facing picker.
 */
export const QUICK_WORKFLOW_NAME = '__quick__' as const;

/**
 * Built-in workflow names dropped in the 2-flow refactor (SoloFlow removal).
 * Rows may still linger in a pre-refactor project DB. listByProject() filters
 * them so they never appear in the picker — they are NOT deleted, because
 * workflow_runs.workflow_id has no ON DELETE CASCADE and historical runs would
 * orphan. A future migration can clean them up with proper FK handling.
 */
export const LEGACY_DROPPED_WORKFLOW_NAMES = ['soloflow', 'compound', 'prune'] as const;

// ---------------------------------------------------------------------------
// WorkflowRegistry
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger: LoggerLike,
    /**
     * Optional global-config provider. When supplied, createRun injects the
     * global default agent permission mode + substrate into the resolvers.
     * When omitted (test fixtures), both fall through to their hard floors
     * ('default' / 'sdk').
     */
    private readonly config?: WorkflowConfigProvider,
  ) {}

  // --------------------------------------------------------------------------
  // Frontmatter helpers (no third-party YAML — flat key: value only)
  // --------------------------------------------------------------------------

  /**
   * Extract the `permission_mode` field from frontmatter.
   *
   * Returns the value only when a VALID PermissionMode key is present;
   * otherwise returns `null` (meaning UNSET — let the resolver decide at
   * createRun, falling through to the global default). An absent key OR an
   * unrecognised value both yield `null`. The built-in flows ship without a
   * frontmatter `permission_mode`, so this is the common (null) case.
   *
   * The `workflows.permission_mode` COLUMN stays non-null: seed/reconcile
   * coalesce this `null` to `'default'` when persisting (see seed /
   * reconcileBuiltIns), and createRun treats a column value of `'default'` as
   * "fall through to the global default".
   */
  private extractPermissionMode(md: string): PermissionMode | null {
    const { frontmatter } = parseMarkdownFrontmatter(md);
    const raw = frontmatter['permission_mode'];
    if (raw === 'acceptEdits' || raw === 'dontAsk' || raw === 'default' || raw === 'auto') {
      return raw;
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Seed the `workflows` table with the provided descriptors.
   *
   * Uses INSERT OR IGNORE on the deterministic primary key `wf-<projectId>-<name>`
   * so re-seeding the same project is idempotent — existing rows are not updated.
   *
   * If a workflow .md file cannot be read, logs ERROR (fail-loud) and inserts
   * the row with `permission_mode='default'` rather than throwing.  The ERROR
   * level is intentional: a missing file means the approval-policy mechanism
   * is silently broken and the operator must be informed.
   */
  seed(projectId: number, workflowDescriptors: WorkflowDescriptor[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO workflows (id, project_id, name, workflow_path, permission_mode)
      VALUES (?, ?, ?, ?, ?)
    `);

    const seedTx = this.db.transaction(() => {
      for (const descriptor of workflowDescriptors) {
        // Seed the non-null COLUMN with 'default' when frontmatter has no
        // (valid) permission_mode — a column value of 'default' is treated as
        // "fall through to the global default" at createRun.
        let permissionMode: PermissionMode = 'default';
        try {
          const md = readFileSync(descriptor.path, 'utf-8');
          permissionMode = this.extractPermissionMode(md) ?? 'default';
        } catch (err) {
          this.logger.error(
            `WorkflowRegistry.seed: could not read workflow file, defaulting permission_mode to 'default'`,
            {
              path: descriptor.path,
              error: err instanceof Error ? err.message : String(err),
            },
          );
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
   * Reconcile the in-repo built-in workflows for a project.
   *
   * Unlike seed() (INSERT OR IGNORE — first-write-wins), this UPSERTs each
   * built-in: a row from a PRIOR app version that still points at the old
   * SoloFlow plugin-cache `workflow_path` is re-pointed at the current in-repo
   * prompt, and its `permission_mode` is re-derived from that file. A fresh
   * project gets the rows inserted. `spec_json` (user step edits) is preserved.
   *
   * Dropped legacy built-ins (soloflow/compound/prune) are intentionally NOT
   * removed here — listByProject() filters them from the picker instead (see
   * LEGACY_DROPPED_WORKFLOW_NAMES; deleting them would orphan historical runs).
   */
  reconcileBuiltIns(projectId: number, workflowDescriptors: WorkflowDescriptor[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workflow_path = excluded.workflow_path,
        permission_mode = excluded.permission_mode
    `);

    const reconcileTx = this.db.transaction(() => {
      for (const descriptor of workflowDescriptors) {
        // Seed the non-null COLUMN with 'default' when frontmatter has no
        // (valid) permission_mode — a column value of 'default' is treated as
        // "fall through to the global default" at createRun.
        let permissionMode: PermissionMode = 'default';
        try {
          const md = readFileSync(descriptor.path, 'utf-8');
          permissionMode = this.extractPermissionMode(md) ?? 'default';
        } catch (err) {
          this.logger.error(
            `WorkflowRegistry.reconcileBuiltIns: could not read workflow file, defaulting permission_mode to 'default'`,
            {
              path: descriptor.path,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        const deterministicId = `wf-${projectId}-${descriptor.name}`;
        upsert.run(deterministicId, projectId, descriptor.name, descriptor.path, permissionMode);
      }
    });

    reconcileTx();
  }

  /**
   * Look up a workflow by its text primary key.
   * Returns null if no row exists with the given id.
   */
  getById(workflowId: string): WorkflowRow | null {
    const stmt = this.db.prepare(
      'SELECT id, project_id, name, workflow_path, permission_mode, spec_json, created_at FROM workflows WHERE id = ?',
    );
    const row = stmt.get(workflowId) as WorkflowRow | undefined;
    return row ?? null;
  }

  /**
   * Persist an edited `WorkflowDefinition` onto a workflow's `spec_json` column.
   *
   * Used by the blueprint editor's "Save" action. The definition is the
   * authoritative effective graph for the row from this point on — see
   * `resolveWorkflowDefinition` (READ path) which prefers a parsed `spec_json`
   * over the built-in fallback.
   *
   * Caller must have validated the definition with the strict zod write-path
   * schema (`workflowDefinitionSchema`) before calling this — the registry does
   * NOT re-validate, it only serialises.
   *
   * Throws if no row matches `workflowId` (0 rows updated).
   */
  updateSpec(workflowId: string, definition: WorkflowDefinition): void {
    const stmt = this.db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?');
    const tx = this.db.transaction(() => stmt.run(JSON.stringify(definition), workflowId));
    const result = tx();
    if (result.changes === 0) {
      throw new Error(`WorkflowRegistry.updateSpec: workflow ${workflowId} not found`);
    }
  }

  /**
   * Reset a BUILT-IN workflow's `spec_json` to `'{}'` so it falls back to its
   * static `WORKFLOW_DEFINITIONS` definition.
   *
   * Refuses to reset a custom ("save as new") flow: those rows have no built-in
   * fallback, so clearing `spec_json` would leave `resolveWorkflowDefinition`
   * returning null (an error state). The editor only offers "Reset to default"
   * for built-in flows for this reason.
   *
   * Throws if the row is missing or its name is not a built-in.
   */
  resetSpec(workflowId: string): void {
    const row = this.getById(workflowId);
    if (!row) {
      throw new Error(`WorkflowRegistry.resetSpec: workflow ${workflowId} not found`);
    }
    if (!isCyboflowWorkflowName(row.name)) {
      throw new Error(
        `WorkflowRegistry.resetSpec: cannot reset a custom workflow to default (${workflowId})`,
      );
    }
    const stmt = this.db.prepare("UPDATE workflows SET spec_json = '{}' WHERE id = ?");
    const tx = this.db.transaction(() => {
      stmt.run(workflowId);
    });
    tx();
  }

  /**
   * Create a brand-new custom workflow row from an edited definition
   * ("Save as new flow").
   *
   * The name must not collide with a built-in name, the `__quick__` sentinel,
   * or any existing workflow name in the same project — collisions throw so the
   * router can map to a CONFLICT.
   *
   * The generated id mirrors the seed/sentinel convention but adds a random
   * suffix so multiple custom flows can coexist:
   *   `wf-<projectId>-custom-<8 lowercase hex chars>`.
   *
   * Caller must have validated the definition with `workflowDefinitionSchema`.
   *
   * @returns The freshly inserted `WorkflowRow`.
   */
  createCustom(
    projectId: number,
    name: string,
    definition: WorkflowDefinition,
    permissionMode: PermissionMode,
  ): WorkflowRow {
    if (isCyboflowWorkflowName(name) || name === QUICK_WORKFLOW_NAME) {
      throw new Error(
        `WorkflowRegistry.createCustom: name '${name}' is reserved`,
      );
    }

    const collisionStmt = this.db.prepare(
      'SELECT 1 FROM workflows WHERE project_id = ? AND name = ? LIMIT 1',
    );
    const existing = collisionStmt.get(projectId, name);
    if (existing !== undefined) {
      throw new Error(
        `WorkflowRegistry.createCustom: a workflow named '${name}' already exists in this project`,
      );
    }

    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const newId = `wf-${projectId}-custom-${suffix}`;

    const insert = this.db.prepare(`
      INSERT INTO workflows (id, project_id, name, spec_json, workflow_path, permission_mode)
      VALUES (?, ?, ?, ?, NULL, ?)
    `);

    const tx = this.db.transaction(() => {
      insert.run(newId, projectId, name, JSON.stringify(definition), permissionMode);
    });
    tx();

    const row = this.getById(newId);
    if (!row) {
      // Should be unreachable — the INSERT just succeeded inside a transaction.
      throw new Error(
        `WorkflowRegistry.createCustom: inserted workflow ${newId} could not be read back`,
      );
    }
    return row;
  }

  /**
   * List all workflows registered for a project.
   * Used by the frontend workflow picker.
   *
   * Excludes the __quick__ sentinel row — that row is an internal implementation
   * detail for the quick-session pipeline and must never appear in user-facing
   * workflow pickers (TASK-787 / IDEA-027).
   */
  listByProject(projectId: number): WorkflowRow[] {
    // Exclude the __quick__ sentinel AND any dropped legacy built-ins
    // (soloflow/compound/prune) that linger in a pre-refactor project DB — they
    // must never appear in the user-facing picker. Filtered, not deleted, to
    // preserve the workflow_runs FK for historical runs.
    const excluded = [QUICK_WORKFLOW_NAME, ...LEGACY_DROPPED_WORKFLOW_NAMES];
    const placeholders = excluded.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, created_at
       FROM workflows
       WHERE project_id = ? AND name NOT IN (${placeholders})
       ORDER BY name`,
    );
    return stmt.all(projectId, ...excluded) as WorkflowRow[];
  }

  /**
   * Ensure a __quick__ sentinel workflow exists for the given project.
   *
   * Uses INSERT OR IGNORE with a deterministic primary key so the call is
   * idempotent — calling it multiple times for the same projectId is safe.
   *
   * The deterministic id format is `wf-{projectId}-__quick__`, which mirrors
   * the pattern used by seed() and migration 012.
   *
   * @returns The workflow_id of the sentinel row (whether it was just created
   *          or already existed).
   */
  ensureQuickWorkflow(projectId: number): string {
    const workflowId = `wf-${projectId}-${QUICK_WORKFLOW_NAME}`;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode)
      VALUES (?, ?, ?, '{}', 'default')
    `);

    const tx = this.db.transaction(() => {
      insert.run(workflowId, projectId, QUICK_WORKFLOW_NAME);
    });

    tx();

    return workflowId;
  }

  /**
   * Create a new workflow_runs row for the given workflow.
   *
   * Snapshots the RESOLVED `permission_mode` onto the run row so the
   * ApprovalRouter / substrate mapper can consult per-run policy without
   * re-reading the workflow file.  The caller (epic-8 deterministic naming
   * task) will later UPDATE `worktree_path` and `branch_name`.
   *
   * Permission-mode resolution (resolvePermissionMode):
   *   per-run override (DEFERRED) > flow frontmatter > global default > 'default'.
   * The workflow row's `permission_mode` column is the frontmatter rung, but a
   * column value of `'default'` is treated as UNSET (fall through to the global
   * default) — built-in flows ship without an explicit per-agent override, so
   * only an opt-in 'acceptEdits' / 'auto' / 'dontAsk' on the column wins over
   * the global default. The global default comes from the injected config
   * (ConfigManager.getDefaultAgentPermissionMode()); when no config is injected
   * (test fixtures) resolution floors to 'default'.
   *
   * Stamps the resolved CLI substrate ('sdk' | 'interactive') onto the run row.
   * The substrate is resolved ONCE here and is immutable for the run lifetime —
   * there is intentionally no UPDATE path. IDEA-013 / TASK-806.
   *
   * `sessionId` (session<->run restructure, Phase 1 / migration 019) is OPTIONAL:
   * when supplied it links the run to the owning chat session at INSERT time so a
   * session can own many runs over its lifetime. When omitted the column stays
   * NULL — the legacy parentless-run path, byte-identical to before.
   *
   * Returns the generated runId, the snapshotted permissionMode, and the
   * stamped substrate.
   * Throws if the workflow does not exist.
   */
  createRun(
    workflowId: string,
    requestedSubstrate?: CliSubstrate,
    sessionId?: string,
  ): { runId: string; permissionMode: PermissionMode; substrate: CliSubstrate } {
    const workflow = this.getById(workflowId);
    if (!workflow) {
      throw new Error(`WorkflowRegistry.createRun: workflow ${workflowId} not found`);
    }

    const runId = randomUUID().replace(/-/g, '');

    // Resolve the agent permission mode via the override ladder. The column's
    // 'default' sentinel means "unset → fall through to the global default", so
    // it is passed as undefined frontmatterMode; any explicit opt-in value on
    // the column wins. The per-run override rung (requestedMode) is DEFERRED.
    const frontmatterMode =
      workflow.permission_mode === 'default' ? undefined : workflow.permission_mode;
    const permissionMode = resolvePermissionMode({
      frontmatterMode,
      globalDefaultMode: this.config?.getDefaultAgentPermissionMode(),
    });

    // Resolve the substrate via the override ladder. The explicit per-run UI
    // choice (requestedSubstrate, from WorkflowPicker → runs.start →
    // RunLauncher.launch) is the HIGHEST-precedence level and is threaded here.
    // The global default comes from the injected config; frontmatter /
    // project-config rungs are not yet wired (still resolve from env + floor).
    // With no override at any level every run resolves 'sdk' (zero-behavior-change).
    const substrate = resolveSubstrate({
      requestedSubstrate,
      globalDefaultSubstrate: this.config?.getDefaultSubstrate(),
      env: process.env,
    });

    const insert = this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate, session_id)
      VALUES (?, ?, ?, 'queued', ?, ?, ?)
    `);

    const createTx = this.db.transaction(() => {
      insert.run(runId, workflowId, workflow.project_id, permissionMode, substrate, sessionId ?? null);
    });

    createTx();

    return { runId, permissionMode, substrate };
  }

  /**
   * Look up a workflow run by its string primary key.
   * Returns null if no row exists.
   */
  getRunById(runId: string): WorkflowRunRow | null {
    const stmt = this.db.prepare(
      'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, current_step_id, task_id, seed_idea_id, claude_session_id, session_id, outcome, base_branch, base_sha, steps_snapshot_json, substrate, started_at, ended_at, created_at, updated_at FROM workflow_runs WHERE id = ?',
    );
    const row = stmt.get(runId) as WorkflowRunRow | undefined;
    return row ?? null;
  }
}
