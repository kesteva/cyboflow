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
 * the flat `key: value` blocks used by SoloFlow workflow .md files and
 * nothing more complex.
 */
import { readFileSync, readdirSync } from 'fs';
import { parseMarkdownFrontmatter } from './markdownFrontmatter';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { LoggerLike, DatabaseLike } from './types';
import type { PermissionMode, WorkflowRow, WorkflowRunRow, CyboflowWorkflowName, WorkflowDefinition } from '../../../shared/types/workflows';
import { isCyboflowWorkflowName } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import { resolveSubstrate } from './substrateResolver';

// ---------------------------------------------------------------------------
// Descriptor types
// ---------------------------------------------------------------------------

export interface WorkflowDescriptor {
  name: CyboflowWorkflowName;
  path: string;
}

// ---------------------------------------------------------------------------
// SoloFlow plugin root discovery
// ---------------------------------------------------------------------------

/**
 * Documented fallback constant for the SoloFlow plugin version.
 *
 * This value WILL go out of date as new versions of the plugin are released.
 * When the filesystem discovery path fails and the env-var is not set, the
 * resolver uses this constant AND emits a console.warn so the operator is
 * informed that the fallback is in use and should update it or set
 * SOLOFLOW_PLUGIN_ROOT.
 */
export const FALLBACK_SOLOFLOW_VERSION = '0.10.3';

/**
 * Resolve the SoloFlow plugin root directory at runtime.
 *
 * Resolution order:
 * 1. `env.SOLOFLOW_PLUGIN_ROOT` — if non-empty, return immediately without
 *    touching the filesystem.
 * 2. Filesystem discovery — list subdirectories under
 *    `<homeDir>/.claude/plugins/cache/soloflow/soloflow-dev/` that match
 *    the semver pattern `\d+\.\d+\.\d+`, sort descending by semver, and
 *    return the highest version.
 * 3. Fallback — return the path for `FALLBACK_SOLOFLOW_VERSION` and emit a
 *    `console.warn` (this function does not own a logger instance).
 *
 * @param homeDir  The user's home directory (typically `os.homedir()`).
 * @param env      The process environment object (defaults to `process.env`).
 */
export function resolveSoloFlowPluginRoot(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { root: string; source: 'env' | 'discovered' | 'fallback' } {
  // 1. Env-var override wins unconditionally.
  const envOverride = env['SOLOFLOW_PLUGIN_ROOT'];
  if (envOverride && envOverride.trim() !== '') {
    return { root: envOverride.trim(), source: 'env' };
  }

  // 2. Filesystem discovery.
  const cacheDir = path.join(homeDir, '.claude', 'plugins', 'cache', 'soloflow', 'soloflow-dev');
  try {
    const entries = readdirSync(cacheDir, { withFileTypes: true });
    const semverPattern = /^\d+\.\d+\.\d+$/;
    const versions = entries
      .filter((e) => e.isDirectory() && semverPattern.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const aParts = a.split('.').map(Number);
        const bParts = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      });

    if (versions.length > 0) {
      return { root: path.join(cacheDir, versions[0]), source: 'discovered' };
    }
  } catch {
    // cacheDir does not exist or is not readable — fall through to fallback.
  }

  // 3. Fallback with warning.
  console.warn(
    `[WorkflowRegistry] could not discover soloflow plugin under ${cacheDir}. ` +
      `Using fallback version ${FALLBACK_SOLOFLOW_VERSION}. ` +
      `Set SOLOFLOW_PLUGIN_ROOT to override.`,
  );
  return {
    root: path.join(cacheDir, FALLBACK_SOLOFLOW_VERSION),
    source: 'fallback',
  };
}

// ---------------------------------------------------------------------------
// Default workflow builders
// ---------------------------------------------------------------------------

/**
 * Build the 5 default SoloFlow workflow descriptors resolved against a
 * concrete plugin root directory.
 *
 * @param pluginRoot  Absolute path to the versioned plugin directory
 *                    (e.g. `~/.claude/plugins/cache/soloflow/soloflow-dev/0.10.3`).
 */
export function buildDefaultSoloFlowWorkflows(pluginRoot: string): WorkflowDescriptor[] {
  return [
    { name: 'soloflow', path: path.join(pluginRoot, 'commands', 'idea-extractor.md') },
    { name: 'planner',  path: path.join(pluginRoot, 'commands', 'planner.md') },
    { name: 'sprint',   path: path.join(pluginRoot, 'commands', 'sprint.md') },
    { name: 'compound', path: path.join(pluginRoot, 'commands', 'compound.md') },
    { name: 'prune',    path: path.join(pluginRoot, 'commands', 'prune.md') },
  ];
}

/**
 * Backward-compat export for `cyboflow.ts` which calls:
 *
 *   DEFAULT_SOLOFLOW_WORKFLOWS.map((wf) => ({
 *     name: wf.name,
 *     path: path.join(homeDir, wf.pathFromHome),
 *   }))
 *
 * `pathFromHome` stores a **relative** path (relative to the user's home
 * directory) so that `path.join(homeDir, wf.pathFromHome)` resolves correctly
 * on both POSIX and Windows.  Note: `path.join` does NOT anchor on an absolute
 * second segment — that is `path.resolve` behaviour.  Storing an absolute path
 * in `pathFromHome` would produce a doubled-prefix path such as
 * `/Users/me/Users/me/.claude/...` and cause all file lookups to fail.
 *
 * @cyboflow-hidden — TASK-610 owns cyboflow.ts and will replace this compat
 * shim with a direct call to buildDefaultSoloFlowWorkflows() +
 * resolveSoloFlowPluginRoot(). Remove this export when that task lands.
 */
export const DEFAULT_SOLOFLOW_WORKFLOWS: { name: CyboflowWorkflowName; pathFromHome: string }[] =
  (() => {
    const homeDir = os.homedir();
    return buildDefaultSoloFlowWorkflows(
      resolveSoloFlowPluginRoot(homeDir).root,
    ).map((d) => ({ name: d.name, pathFromHome: path.relative(homeDir, d.path) }));
  })();

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
   * Extract the `permission_mode` field from frontmatter, normalising to a
   * valid PermissionMode.  Absent or unrecognised values fall back to
   * `'default'`.
   */
  private extractPermissionMode(md: string): PermissionMode {
    const { frontmatter } = parseMarkdownFrontmatter(md);
    const raw = frontmatter['permission_mode'];
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
        let permissionMode: PermissionMode = 'default';
        try {
          const md = readFileSync(descriptor.path, 'utf-8');
          permissionMode = this.extractPermissionMode(md);
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
    const stmt = this.db.prepare(
      `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, created_at
       FROM workflows
       WHERE project_id = ? AND name != ?
       ORDER BY name`,
    );
    return stmt.all(projectId, QUICK_WORKFLOW_NAME) as WorkflowRow[];
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
   * Snapshots the workflow's current `permission_mode` onto the run row so the
   * ApprovalRouter can consult per-run policy without re-reading the workflow
   * file.  The caller (epic-8 deterministic naming task) will later UPDATE
   * `worktree_path` and `branch_name`.
   *
   * Stamps the resolved CLI substrate ('sdk' | 'interactive') onto the run row.
   * The substrate is resolved ONCE here and is immutable for the run lifetime —
   * there is intentionally no UPDATE path. IDEA-013 / TASK-806.
   *
   * Returns the generated runId, the snapshotted permissionMode, and the
   * stamped substrate.
   * Throws if the workflow does not exist.
   */
  createRun(workflowId: string): { runId: string; permissionMode: PermissionMode; substrate: CliSubstrate } {
    const workflow = this.getById(workflowId);
    if (!workflow) {
      throw new Error(`WorkflowRegistry.createRun: workflow ${workflowId} not found`);
    }

    const runId = randomUUID().replace(/-/g, '');
    const permissionMode = workflow.permission_mode;

    // Resolve the substrate via the override ladder. The registry does not yet
    // receive the project/global config or workflow frontmatter collaborators,
    // so v1 resolves from env (CYBOFLOW_SUBSTRATE) + the 'sdk' floor only.
    // TODO(S4/S7): thread frontmatterSubstrate / projectConfigSubstrate /
    // globalDefaultSubstrate through once those collaborators are injected here.
    // The floor and stamp are correct regardless — with no override every run
    // resolves 'sdk' (zero-behavior-change invariant).
    const substrate = resolveSubstrate({ env: process.env });

    const insert = this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `);

    const createTx = this.db.transaction(() => {
      insert.run(runId, workflowId, workflow.project_id, permissionMode, substrate);
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
      'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, current_step_id, task_id, outcome, base_branch, base_sha, steps_snapshot_json, substrate, started_at, ended_at, created_at, updated_at FROM workflow_runs WHERE id = ?',
    );
    const row = stmt.get(runId) as WorkflowRunRow | undefined;
    return row ?? null;
  }
}
