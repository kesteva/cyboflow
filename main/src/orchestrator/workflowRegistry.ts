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
import { isCyboflowWorkflowName, resolveWorkflowDefinition } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import { resolveSubstrate } from './substrateResolver';
import { resolveExecutionModel } from './executionModelResolver';
import { resolvePermissionMode } from './permissionModeResolver';
import { computeSpecHash } from './specHash';

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
  /**
   * Boot-profile override that PINS the substrate for every run, bypassing the
   * whole resolution ladder (even the explicit per-run UI choice). Demo mode
   * returns 'sdk' here so no run/session ever engages the real interactive
   * manager. null (or absent) = no pin, resolve normally.
   */
  getForcedSubstrate?(): CliSubstrate | null;
  /**
   * Global default for the execution model (orchestrated vs programmatic),
   * consulted by resolveExecutionModel below its env level. Optional + absent =>
   * the resolver floors to 'orchestrated' (the zero-behavior-change default), so
   * existing fixtures that construct a registry without config are unaffected.
   */
  getDefaultExecutionModel?(): ExecutionModel | null;
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
 * Built-in workflow names dropped in the flow refactor (SoloFlow removal).
 * Rows may still linger in a pre-refactor project DB. listByProject() filters
 * them so they never appear in the picker — they are NOT deleted, because
 * workflow_runs.workflow_id has no ON DELETE CASCADE and historical runs would
 * orphan. A future migration can clean them up with proper FK handling.
 *
 * 'compound' is NOT in this list: it was rebuilt as a native third built-in
 * (CYBOFLOW_WORKFLOW_NAMES), so its rows must surface in the picker like
 * planner/sprint, not be filtered as legacy cruft.
 */
export const LEGACY_DROPPED_WORKFLOW_NAMES = ['soloflow', 'prune'] as const;

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
   * ensureGlobalBuiltIns), and createRun treats a column value of `'default'` as
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
   * Reconcile the in-repo built-in workflows as ONE GLOBAL set (migration 030).
   *
   * Replaces the old per-project `reconcileBuiltIns(projectId, …)`: instead of
   * minting a `wf-<projectId>-<name>` row for every project, this UPSERTs a
   * SINGLE `wf-global-<name>` row per built-in with `project_id = NULL` (GLOBAL
   * scope). Every project sees these via the union in `listByProject`. There is
   * no longer any per-project built-in seeding — the global rows are shared.
   *
   * Like the prior reconcile (and unlike `seed()`'s INSERT OR IGNORE), this
   * UPSERTs: a row from a PRIOR app version that still points at the old
   * SoloFlow plugin-cache `workflow_path` is re-pointed at the current in-repo
   * prompt, and its `permission_mode` is re-derived from that file. A fresh DB
   * gets the rows inserted. `spec_json` (user step edits) is PRESERVED — the
   * ON CONFLICT clause touches only `workflow_path` + `permission_mode`.
   *
   * Idempotent: keyed on the deterministic `wf-global-<name>` primary key, so
   * calling it on every `workflows.list` (project-independent) is safe.
   *
   * Dropped legacy built-ins (soloflow/prune) are intentionally NOT removed
   * here — listByProject() filters them from the picker instead (see
   * LEGACY_DROPPED_WORKFLOW_NAMES; deleting them would orphan historical runs).
   */
  ensureGlobalBuiltIns(workflowDescriptors: WorkflowDescriptor[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
      VALUES (?, NULL, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workflow_path = excluded.workflow_path,
        permission_mode = excluded.permission_mode
    `);

    // Defensive prune (shared-DB hardening): a STALE older build that still seeds
    // per-project built-ins (`wf-<projectId>-<name>`) can re-mint the phantom rows
    // migration 030 already collapsed into the global set, because the dev
    // sessions.db is shared across worktrees. On every reconcile, drop any
    // UNEDITED per-project built-in so the gallery never re-grows duplicate
    // built-in cards. Guards keep it safe + narrow:
    //   - name is a built-in (the descriptor set) — custom flows are never touched;
    //   - project_id IS NOT NULL — the canonical rows are the global ones;
    //   - spec_json '{}' — an EDITED project copy (non-empty spec) is PRESERVED;
    //   - no run history — a row with runs would cascade-delete them (FK ON DELETE
    //     CASCADE), so we leave it intact (mirrors deleteWorkflow's invariant;
    //     migration 030 re-pointed history before its own delete — this is the only
    //     at-rest guard we add here). An empty descriptor set skips the prune (an
    //     `IN ()` is invalid SQL).
    const builtInNames = workflowDescriptors.map((d) => d.name);
    const prunePhantoms =
      builtInNames.length > 0
        ? this.db.prepare(
            `DELETE FROM workflows
              WHERE name IN (${builtInNames.map(() => '?').join(', ')})
                AND project_id IS NOT NULL
                AND spec_json = '{}'
                AND id NOT IN (SELECT DISTINCT workflow_id FROM workflow_runs)`,
          )
        : null;

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
            `WorkflowRegistry.ensureGlobalBuiltIns: could not read workflow file, defaulting permission_mode to 'default'`,
            {
              path: descriptor.path,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        const globalId = `wf-global-${descriptor.name}`;
        upsert.run(globalId, descriptor.name, descriptor.path, permissionMode);
      }
      // After the global rows are in place, drop any re-seeded phantom
      // per-project built-ins (see the comment on prunePhantoms above).
      prunePhantoms?.run(...builtInNames);
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
   * Also INSERT-OR-IGNOREs a `workflow_revisions` snapshot for the new spec
   * (migration 026) so a run later stamped with this edit's `spec_hash` resolves
   * to its spec. UNIQUE(workflow_id, spec_hash) makes re-saving the SAME spec
   * idempotent — only a distinct edit adds a revision row.
   *
   * Throws if no row matches `workflowId` (0 rows updated).
   */
  updateSpec(workflowId: string, definition: WorkflowDefinition): void {
    const specJson = JSON.stringify(definition);
    const stmt = this.db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      const result = stmt.run(specJson, workflowId);
      if (result.changes === 0) {
        throw new Error(`WorkflowRegistry.updateSpec: workflow ${workflowId} not found`);
      }
      // Snapshot the NEW spec as a revision so the (workflow_id, spec_hash) pair
      // is resolvable forever. UNIQUE(workflow_id, spec_hash) makes re-saving the
      // SAME spec a no-op (INSERT OR IGNORE) — only a distinct edit adds a row.
      this.recordRevision(workflowId, specJson);
    });
    tx();
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
      // Snapshot the reset-to-'{}' spec as a revision (same idempotent path as
      // updateSpec). UNIQUE(workflow_id, spec_hash) means a workflow reset back to
      // an empty spec it already carried adds no duplicate row.
      this.recordRevision(workflowId, '{}');
    });
    tx();
  }

  /**
   * INSERT OR IGNORE a `workflow_revisions` snapshot for the workflow's current
   * spec text (migration 026), so every `spec_hash` that has ever run — or been
   * saved by an edit — is resolvable to its exact spec even after the live
   * `spec_json` moves on. Called by createRun (at freeze time) and by the edit
   * paths (updateSpec / resetSpec).
   *
   * Idempotency: the `UNIQUE(workflow_id, spec_hash)` constraint makes a re-save
   * of an already-snapshotted spec a silent no-op, so callers need not pre-check.
   * Must run INSIDE the caller's transaction (it does not open its own).
   */
  private recordRevision(workflowId: string, specJson: string): void {
    const specHash = computeSpecHash(specJson);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workflow_revisions (workflow_id, spec_hash, spec_json)
         VALUES (?, ?, ?)`,
      )
      .run(workflowId, specHash, specJson);
  }

  /**
   * Create a brand-new custom workflow row from an edited definition
   * ("Save as new flow" / "Create a project-specific copy").
   *
   * Scope (migration 030) is chosen by `params.projectId`:
   *   - `null`    → GLOBAL custom flow (shown across every project). The row is
   *                 inserted with `project_id NULL` and id
   *                 `wf-global-custom-<8 lowercase hex chars>`.
   *   - a number  → project-scoped custom flow (a "project copy"). The row is
   *                 inserted with `project_id = <projectId>` and id
   *                 `wf-<projectId>-custom-<8 lowercase hex chars>`.
   *
   * Name uniqueness (collisions throw so the router can map to a CONFLICT):
   *   1. Reserved-name guard is GLOBAL: a built-in `CyboflowWorkflowName` or the
   *      `__quick__` sentinel is rejected regardless of scope.
   *   2. A name already used by a GLOBAL flow (`project_id IS NULL`) is rejected
   *      for any scope — a project copy must not shadow a global flow's name.
   *   3. When `projectId !== null`, a name already used WITHIN that project is
   *      also rejected.
   *
   * `definition` defaults to the empty spec `'{}'` when `params.specJson` is
   * omitted, and `permissionMode` defaults to `'default'`.
   *
   * Caller must have validated any supplied `specJson` with
   * `workflowDefinitionSchema`. The registry does NOT re-validate, it only
   * persists the string.
   *
   * @returns The freshly inserted `WorkflowRow`.
   */
  createCustom(params: {
    projectId: number | null;
    name: string;
    specJson?: string;
    permissionMode?: PermissionMode;
  }): WorkflowRow {
    const { projectId, name } = params;
    const specJson = params.specJson ?? '{}';
    const permissionMode: PermissionMode = params.permissionMode ?? 'default';

    if (isCyboflowWorkflowName(name) || name === QUICK_WORKFLOW_NAME) {
      throw new Error(
        `WorkflowRegistry.createCustom: name '${name}' is reserved`,
      );
    }

    // (2) A GLOBAL flow's name is reserved across every scope.
    const globalCollision = this.db
      .prepare('SELECT 1 FROM workflows WHERE project_id IS NULL AND name = ? LIMIT 1')
      .get(name);
    if (globalCollision !== undefined) {
      throw new Error(
        `WorkflowRegistry.createCustom: a global workflow named '${name}' already exists`,
      );
    }

    // (3) For a project copy, the name must also be free within that project.
    if (projectId !== null) {
      const projectCollision = this.db
        .prepare('SELECT 1 FROM workflows WHERE project_id = ? AND name = ? LIMIT 1')
        .get(projectId, name);
      if (projectCollision !== undefined) {
        throw new Error(
          `WorkflowRegistry.createCustom: a workflow named '${name}' already exists in this project`,
        );
      }
    }

    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const newId =
      projectId === null
        ? `wf-global-custom-${suffix}`
        : `wf-${projectId}-custom-${suffix}`;

    const insert = this.db.prepare(`
      INSERT INTO workflows (id, project_id, name, spec_json, workflow_path, permission_mode)
      VALUES (?, ?, ?, ?, NULL, ?)
    `);

    const tx = this.db.transaction(() => {
      insert.run(newId, projectId, name, specJson, permissionMode);
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
   * Delete a workflow row ("Delete" on a gallery card).
   *
   * Guards (each throws a distinguishable Error the router maps to a TRPCError):
   *   - Missing row → message contains 'not found' (→ NOT_FOUND).
   *   - A GLOBAL built-in (`project_id IS NULL` AND a `CyboflowWorkflowName`) or the
   *     `__quick__` sentinel → message contains 'reserved' (→ BAD_REQUEST): both
   *     re-seed on the next reconcile / quick session, so deleting them is futile.
   *   - A workflow with ANY run history → message contains 'run history'
   *     (→ CONFLICT). `workflow_runs.workflow_id` AND `workflow_revisions.workflow_id`
   *     both reference `workflows(id) ON DELETE CASCADE` (schema.sql / migration
   *     030), so deleting a flow-with-runs would silently destroy its run +
   *     Insights history. We refuse instead (safe v1).
   *
   * With the zero-run guarantee the only cascade is the flow's OWN
   * `workflow_revisions` (editor save snapshots) — acceptable, since they describe
   * a flow that no longer exists. Runs inside a transaction.
   */
  deleteWorkflow(workflowId: string): void {
    const row = this.getById(workflowId);
    if (!row) {
      throw new Error(`WorkflowRegistry.deleteWorkflow: workflow ${workflowId} not found`);
    }
    if (
      (row.project_id === null && isCyboflowWorkflowName(row.name)) ||
      row.name === QUICK_WORKFLOW_NAME
    ) {
      throw new Error(
        `WorkflowRegistry.deleteWorkflow: '${row.name}' is a reserved built-in and cannot be deleted`,
      );
    }
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id = ?')
      .get(workflowId) as { count: number };
    if (count > 0) {
      throw new Error(
        `WorkflowRegistry.deleteWorkflow: workflow ${workflowId} has run history (${count} run(s)); refusing to delete`,
      );
    }
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);
    });
    tx();
  }

  /**
   * List the workflows visible to a project: the GLOBAL set
   * (`project_id IS NULL` — built-ins + global customs, migration 030) UNIONed
   * with that project's own scoped rows (`project_id = ?` — project-copy customs
   * and any edited per-project built-in 030 preserved).
   * Used by the frontend workflow picker.
   *
   * Excludes the __quick__ sentinel row — that row is an internal implementation
   * detail for the quick-session pipeline and must never appear in user-facing
   * workflow pickers (TASK-787 / IDEA-027). Also hides any row that does not
   * resolve to a usable definition (empty/unknown spec) — e.g. foreign internal
   * flows leaked via the shared dev DB — so the picker never shows dead cards.
   *
   * Note: the global rows returned here repeat across every project's call, so
   * the renderer (workflowsStore) dedupes the cross-project fan-out by `row.id`.
   */
  listByProject(projectId: number): WorkflowRow[] {
    // Exclude the __quick__ sentinel AND any dropped legacy built-ins
    // (soloflow/prune) that linger in a pre-refactor DB — they must
    // never appear in the user-facing picker. Filtered, not deleted, to
    // preserve the workflow_runs FK for historical runs.
    const excluded = [QUICK_WORKFLOW_NAME, ...LEGACY_DROPPED_WORKFLOW_NAMES];
    const placeholders = excluded.map(() => '?').join(', ');
    const stmt = this.db.prepare(
      `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, created_at
       FROM workflows
       WHERE (project_id = ? OR project_id IS NULL) AND name NOT IN (${placeholders})
       ORDER BY name`,
    );
    const rows = stmt.all(projectId, ...excluded) as WorkflowRow[];
    // Belt-and-suspenders beyond the name blocklist: hide any row that does NOT
    // resolve to a usable definition. Stale rows from the retired scheduler-era
    // flows (a worktree's task / sprint-init / sprint-finalize, possibly leaked
    // via the SHARED dev DB) carry an empty spec_json and aren't
    // CyboflowWorkflowNames, so they would otherwise render as dead
    // "0 steps / 0 phases" picker cards. Filtered, not deleted — they reappear
    // automatically once they carry a real definition.
    return rows.filter((row) => resolveWorkflowDefinition(row.name, row.spec_json) !== null);
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
   *   per-run override (requestedPermissionMode, from WorkflowPicker) >
   *   flow frontmatter > global default > 'default'.
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
   * Freezes the workflow's CURRENT spec onto the run as `spec_hash` (sha256 of
   * spec_json; migration 026) following the SAME no-UPDATE discipline as
   * substrate, and INSERT-OR-IGNOREs a `workflow_revisions` snapshot for that
   * hash so the frozen address always resolves to its spec text — even for a
   * spec that only ever ran and was never explicitly saved via the editor.
   *
   * `sessionId` (session<->run restructure, Phase 1 / migration 019) is OPTIONAL:
   * when supplied it links the run to the owning chat session at INSERT time so a
   * session can own many runs over its lifetime. When omitted the column stays
   * NULL — the legacy parentless-run path, byte-identical to before.
   *
   * `opts.projectId` (migration 030) is the EXPLICIT launch project stamped onto
   * `workflow_runs.project_id` (a NOT-NULL column). It MUST be supplied for a
   * GLOBAL workflow (`workflow.project_id IS NULL` — a built-in or a global
   * custom flow) because the workflow row no longer carries a project. When
   * omitted, it falls back to `workflow.project_id` (the per-project path: the
   * quick sentinel or an edited per-project built-in preserved by 030). Throws
   * if neither source yields a project (a global flow launched without an
   * explicit projectId).
   *
   * Returns the generated runId, the snapshotted permissionMode, and the
   * stamped substrate.
   * Throws if the workflow does not exist.
   */
  createRun(
    workflowId: string,
    requestedSubstrate?: CliSubstrate,
    sessionId?: string,
    requestedPermissionMode?: PermissionMode,
    opts?: { projectId?: number },
  ): { runId: string; permissionMode: PermissionMode; substrate: CliSubstrate; executionModel: ExecutionModel } {
    const workflow = this.getById(workflowId);
    if (!workflow) {
      throw new Error(`WorkflowRegistry.createRun: workflow ${workflowId} not found`);
    }

    // Stamp the EXPLICIT launch project (migration 030). For a GLOBAL workflow
    // (built-in or global custom) workflow.project_id is NULL, so the launch
    // project must be threaded by the caller (runs.start → runLauncher.launch).
    // For a per-project row (quick sentinel / edited built-in) it falls back to
    // the workflow's own project. workflow_runs.project_id is NOT NULL.
    const runProjectId = opts?.projectId ?? workflow.project_id;
    if (runProjectId === null || runProjectId === undefined) {
      throw new Error(
        `WorkflowRegistry.createRun: workflow ${workflowId} is global (project_id NULL); an explicit projectId is required`,
      );
    }

    const runId = randomUUID().replace(/-/g, '');

    // Resolve the agent permission mode via the override ladder. The explicit
    // per-run UI choice (requestedPermissionMode, from WorkflowPicker →
    // runs.start → RunLauncher.launch) is the HIGHEST-precedence rung and is
    // threaded here. The column's 'default' sentinel means "unset → fall through
    // to the global default", so it is passed as undefined frontmatterMode; any
    // explicit opt-in value on the column wins below the per-run override.
    const frontmatterMode =
      workflow.permission_mode === 'default' ? undefined : workflow.permission_mode;
    const permissionMode = resolvePermissionMode({
      requestedMode: requestedPermissionMode,
      frontmatterMode,
      globalDefaultMode: this.config?.getDefaultAgentPermissionMode(),
    });

    // Resolve the substrate via the override ladder. The explicit per-run UI
    // choice (requestedSubstrate, from WorkflowPicker → runs.start →
    // RunLauncher.launch) is the HIGHEST-precedence level and is threaded here.
    // The global default comes from the injected config; frontmatter /
    // project-config rungs are not yet wired (still resolve from env + floor).
    // With no override at any level every run resolves 'sdk' (zero-behavior-change).
    // A boot-profile pin (demo mode → 'sdk') outranks the whole ladder,
    // including the explicit per-run UI choice — demo runs must never spawn a
    // real agent regardless of what the launch surface requested.
    const forcedSubstrate = this.config?.getForcedSubstrate?.() ?? null;
    // Demo carve-out (illustration only): the boot-profile pin is 'sdk', but a
    // quick session that EXPLICITLY requested 'interactive' is honored so the
    // canned PTY terminal can be shown in demo mode. This is safe because the
    // real REPL is never spawned — the quick-session eager-spawn path and the
    // sessions:input relay both short-circuit in demo (see ipc/session.ts), and
    // DemoTerminalView paints a purely client-side scripted session. Scoped to
    // the __quick__ sentinel so no demo WORKFLOW run can ever resolve interactive
    // (which WOULD dispatch to the real interactive manager via the facade).
    const demoHonorsInteractive =
      forcedSubstrate === 'sdk' &&
      workflow.name === QUICK_WORKFLOW_NAME &&
      requestedSubstrate === 'interactive';
    const substrate = demoHonorsInteractive
      ? 'interactive'
      : forcedSubstrate ?? resolveSubstrate({
          requestedSubstrate,
          globalDefaultSubstrate: this.config?.getDefaultSubstrate(),
          env: process.env,
        });

    // Resolve the execution model (orchestrated vs programmatic) — the sibling
    // immutable stamp that decides WHO walks the run's DAG. The interactive
    // substrate hard-pins 'orchestrated' inside the resolver; an SDK run floors
    // to 'orchestrated' unless an override selects 'programmatic'. The
    // requested/frontmatter/project-config rungs are not yet wired (they land
    // with the programmatic consumer); resolution today uses the global default
    // + env + the substrate hard-pin + floor. With no override every run resolves
    // 'orchestrated' (zero-behavior-change). Like substrate, this is stamped ONCE
    // at INSERT and is immutable for the run lifetime — there is no UPDATE path.
    const executionModel = resolveExecutionModel({
      substrate,
      globalDefaultExecutionModel: this.config?.getDefaultExecutionModel?.(),
      env: process.env,
    });

    // Freeze the workflow's CURRENT spec onto the run as a content address
    // (migration 026). Like substrate, spec_hash is stamped ONCE at INSERT and
    // is immutable for the run lifetime — there is no UPDATE path. It lets
    // Insights bucket runs by the exact workflow revision they executed even
    // after the live spec_json is later edited.
    const specHash = computeSpecHash(workflow.spec_json);

    const insert = this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate, execution_model, session_id, spec_hash)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `);

    const createTx = this.db.transaction(() => {
      insert.run(runId, workflowId, runProjectId, permissionMode, substrate, executionModel, sessionId ?? null, specHash);
      // Ensure the frozen hash is always resolvable to its spec: snapshot a
      // revision for the spec we just stamped. INSERT OR IGNORE keyed on
      // UNIQUE(workflow_id, spec_hash) makes this idempotent, so a workflow that
      // ran the same spec before (or was explicitly edited to it) adds no row —
      // but a spec that ONLY ever ran (never saved via the editor) still gets a
      // revision row here, so historic spec text is never lost.
      this.recordRevision(workflowId, workflow.spec_json ?? '{}');
    });

    createTx();

    return { runId, permissionMode, substrate, executionModel };
  }

  /**
   * Look up a workflow run by its string primary key.
   * Returns null if no row exists.
   */
  getRunById(runId: string): WorkflowRunRow | null {
    const stmt = this.db.prepare(
      'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, current_step_id, task_id, seed_idea_id, claude_session_id, session_id, batch_id, outcome, base_branch, base_sha, steps_snapshot_json, substrate, execution_model, started_at, ended_at, created_at, updated_at FROM workflow_runs WHERE id = ?',
    );
    const row = stmt.get(runId) as WorkflowRunRow | undefined;
    return row ?? null;
  }
}
