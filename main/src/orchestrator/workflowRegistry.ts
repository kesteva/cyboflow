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
import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';
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
 * By using absolute paths for `pathFromHome`, `path.join(homeDir, absolutePath)`
 * resolves to `absolutePath` on POSIX systems (the absolute segment wins), so
 * the callsite keeps working without modification.
 *
 * @cyboflow-hidden — TASK-610 owns cyboflow.ts and will replace this compat
 * shim with a direct call to buildDefaultSoloFlowWorkflows() +
 * resolveSoloFlowPluginRoot(). Remove this export when that task lands.
 */
export const DEFAULT_SOLOFLOW_WORKFLOWS: { name: SoloFlowWorkflowName; pathFromHome: string }[] =
  buildDefaultSoloFlowWorkflows(
    resolveSoloFlowPluginRoot(
      process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    ).root,
  ).map((d) => ({ name: d.name, pathFromHome: d.path }));

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
