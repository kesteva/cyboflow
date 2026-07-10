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
import type {
  ExperimentArm,
  WorkflowVariantRow,
  WorkflowVariantStatus,
} from '../../../shared/types/experiments';
import type {
  ResolvedVisualVerifyConfig,
  VerificationType,
  VerifyConfigFile,
  VerificationRequestInput,
} from '../../../shared/types/visualVerification';
import { resolveSubstrate } from './substrateResolver';
import { resolveExecutionModel } from './executionModelResolver';
import { resolveVisualVerification, SHIPPED_VERIFY_BACKENDS } from './visualVerificationResolver';
import { resolvePermissionMode } from './permissionModeResolver';
import { computeSpecHash } from './specHash';
import { reconcileRotationExperiment, revalidateRotationAttribution } from './experimentStore';
import { BASELINE_VARIANT_SENTINEL } from '../../../shared/types/experiments';

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
  /**
   * Fully-resolved global visual-verification block (P2 ConfigManager getter),
   * consulted by resolveVisualVerification for the global enablement + default
   * type rungs. Optional + absent => createRun floors the run to the DISABLED
   * posture (verify_enabled=0 / verify_type=NULL / verify_chain=NULL), the
   * zero-behavior-change default, so existing fixtures without config stamp a
   * disabled run exactly as before migration 055.
   */
  getVisualVerifyConfig?(): ResolvedVisualVerifyConfig;
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

  // --------------------------------------------------------------------------
  // Workflow variants (A/B testing, migration 048)
  // --------------------------------------------------------------------------

  /** Read a single variant row by id. Returns null when absent. */
  getVariantById(variantId: string): WorkflowVariantRow | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_variants WHERE id = ?')
      .get(variantId) as WorkflowVariantRow | undefined;
    return row ?? null;
  }

  /** List a workflow's variants, newest-first. */
  listVariants(workflowId: string): WorkflowVariantRow[] {
    return this.db
      .prepare('SELECT * FROM workflow_variants WHERE workflow_id = ? ORDER BY created_at DESC, id DESC')
      .all(workflowId) as WorkflowVariantRow[];
  }

  /**
   * Create a variant snapshotting the workflow's RESOLVED effective definition
   * ("Create variant from current").
   *
   * Snapshots `resolveWorkflowDefinition(name, spec_json)` — so a built-in with a
   * live `spec_json='{}'` freezes the CONCRETE static graph rather than '{}'
   * (independent of later built-in code changes). Seeds `status='draft'` (rotation
   * is explicit opt-in — a fresh variant is pinnable + experiment-usable but never
   * auto-rotated), `weight=1`, NULL model/execution_model/agent_overrides_json.
   *
   * Guards (distinguishable Error messages the router maps to TRPCError):
   *   - missing workflow → 'not found' (NOT_FOUND)
   *   - reserved sentinel (__quick__) → 'reserved' (BAD_REQUEST)
   *   - unresolvable definition (broken custom flow) → 'unresolvable' (BAD_REQUEST)
   *   - label collision (UNIQUE) → 'already exists' (CONFLICT)
   */
  createVariantFromCurrent(workflowId: string, label: string): WorkflowVariantRow {
    const workflow = this.getById(workflowId);
    if (!workflow) {
      throw new Error(`WorkflowRegistry.createVariantFromCurrent: workflow ${workflowId} not found`);
    }
    if (workflow.name === QUICK_WORKFLOW_NAME) {
      throw new Error(
        `WorkflowRegistry.createVariantFromCurrent: '${workflow.name}' is a reserved sentinel and cannot have variants`,
      );
    }
    const definition = resolveWorkflowDefinition(workflow.name, workflow.spec_json);
    if (definition === null) {
      throw new Error(
        `WorkflowRegistry.createVariantFromCurrent: workflow ${workflowId} has an unresolvable definition`,
      );
    }
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      throw new Error('WorkflowRegistry.createVariantFromCurrent: label must be non-empty');
    }
    // Collision pre-check for a clean CONFLICT message (the UNIQUE index is the
    // authoritative guard; a concurrent insert would still throw the raw error).
    const collision = this.db
      .prepare('SELECT 1 FROM workflow_variants WHERE workflow_id = ? AND label = ? LIMIT 1')
      .get(workflowId, trimmed);
    if (collision !== undefined) {
      throw new Error(
        `WorkflowRegistry.createVariantFromCurrent: a variant named '${trimmed}' already exists for this workflow`,
      );
    }

    const id = `wfv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const specJson = JSON.stringify(definition);
    const insert = this.db.prepare(`
      INSERT INTO workflow_variants (id, workflow_id, label, spec_json, status, weight)
      VALUES (?, ?, ?, ?, 'draft', 1)
    `);
    const tx = this.db.transaction(() => {
      insert.run(id, workflowId, trimmed, specJson);
    });
    tx();

    const row = this.getVariantById(id);
    if (!row) {
      throw new Error(
        `WorkflowRegistry.createVariantFromCurrent: inserted variant ${id} could not be read back`,
      );
    }
    return row;
  }

  /**
   * Patch a variant IN PLACE (re-snapshot). Any subset of fields may be supplied;
   * `updated_at` always touches. Past runs are unaffected — each froze its own
   * `spec_hash` into `workflow_revisions` at createRun. The caller pre-validates
   * `specJson`/`agentOverridesJson` (the router serializes zod-validated shapes);
   * the registry does NOT re-validate, it only persists.
   *
   * Throws 'not found' when the variant is missing (→ NOT_FOUND). A label
   * collision surfaces the UNIQUE constraint error (→ CONFLICT upstream).
   */
  updateVariant(
    variantId: string,
    patch: {
      specJson?: string;
      agentOverridesJson?: string | null;
      model?: string | null;
      executionModel?: 'orchestrated' | 'programmatic' | null;
      weight?: number;
      label?: string;
    },
  ): void {
    if (patch.weight !== undefined && (!Number.isInteger(patch.weight) || patch.weight < 0)) {
      throw new Error('WorkflowRegistry.updateVariant: weight must be a non-negative integer');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.specJson !== undefined) {
      sets.push('spec_json = ?');
      params.push(patch.specJson);
    }
    if (patch.agentOverridesJson !== undefined) {
      sets.push('agent_overrides_json = ?');
      params.push(patch.agentOverridesJson);
    }
    if (patch.model !== undefined) {
      sets.push('model = ?');
      params.push(patch.model);
    }
    if (patch.executionModel !== undefined) {
      sets.push('execution_model = ?');
      params.push(patch.executionModel);
    }
    if (patch.weight !== undefined) {
      sets.push('weight = ?');
      params.push(patch.weight);
    }
    if (patch.label !== undefined) {
      const trimmed = patch.label.trim();
      if (trimmed.length === 0) {
        throw new Error('WorkflowRegistry.updateVariant: label must be non-empty');
      }
      sets.push('label = ?');
      params.push(trimmed);
    }
    sets.push("updated_at = datetime('now')");
    const existing = this.getVariantById(variantId);
    if (!existing) {
      throw new Error(`WorkflowRegistry.updateVariant: variant ${variantId} not found`);
    }
    const stmt = this.db.prepare(`UPDATE workflow_variants SET ${sets.join(', ')} WHERE id = ?`);
    // Rotation-lifecycle chokepoint (migration 058): the write PLUS a pool
    // reconcile run atomically — a weight 0<->positive edit is a membership change,
    // so this can open/supersede/replace/close the workflow's rotation experiment.
    const tx = this.db.transaction(() => {
      const result = stmt.run(...params, variantId);
      if (result.changes === 0) {
        throw new Error(`WorkflowRegistry.updateVariant: variant ${variantId} not found`);
      }
      reconcileRotationExperiment(this.db, existing.workflow_id);
    });
    tx();
  }

  /** Transition a variant's rotation status. Throws 'not found' when absent. */
  setVariantStatus(variantId: string, status: WorkflowVariantStatus): void {
    const existing = this.getVariantById(variantId);
    if (!existing) {
      throw new Error(`WorkflowRegistry.setVariantStatus: variant ${variantId} not found`);
    }
    const stmt = this.db.prepare(
      "UPDATE workflow_variants SET status = ?, updated_at = datetime('now') WHERE id = ?",
    );
    // Rotation-lifecycle chokepoint (migration 058): activating/pausing an arm is a
    // membership change; reconcile atomically with the status write.
    const tx = this.db.transaction(() => {
      const result = stmt.run(status, variantId);
      if (result.changes === 0) {
        throw new Error(`WorkflowRegistry.setVariantStatus: variant ${variantId} not found`);
      }
      reconcileRotationExperiment(this.db, existing.workflow_id);
    });
    tx();
  }

  /**
   * Delete a variant. MIRRORS deleteWorkflow's run-history guard: refuses (throws
   * 'run history' → CONFLICT) when any workflow_runs.variant_id references it —
   * retire instead so per-variant stats stay resolvable. A variant with 0 runs is
   * hard-deleted. Throws 'not found' when the variant is missing.
   */
  deleteVariant(variantId: string): void {
    const variant = this.getVariantById(variantId);
    if (!variant) {
      throw new Error(`WorkflowRegistry.deleteVariant: variant ${variantId} not found`);
    }
    const { count } = this.db
      .prepare('SELECT COUNT(*) AS count FROM workflow_runs WHERE variant_id = ?')
      .get(variantId) as { count: number };
    if (count > 0) {
      throw new Error(
        `WorkflowRegistry.deleteVariant: variant ${variantId} has run history (${count} run(s)); retire it instead of deleting`,
      );
    }
    const workflowId = variant.workflow_id;
    // Rotation-lifecycle chokepoint (migration 058): deleting an arm is a membership
    // change; reconcile atomically after the row is gone.
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflow_variants WHERE id = ?').run(variantId);
      reconcileRotationExperiment(this.db, workflowId);
    });
    tx();
  }

  /**
   * Read a workflow's BASELINE rotation participation (migration 054). The baseline
   * is the workflow's own live definition; when `inRotation` it competes in the
   * randomized rotation on equal footing with active variants (weight = its share).
   * Returns null when the workflow row is missing.
   */
  getBaselineRotation(workflowId: string): { inRotation: boolean; weight: number } | null {
    const row = this.db
      .prepare(
        'SELECT baseline_in_rotation AS inRotation, baseline_rotation_weight AS weight FROM workflows WHERE id = ?',
      )
      .get(workflowId) as { inRotation: number; weight: number } | undefined;
    if (!row) return null;
    return { inRotation: row.inRotation === 1, weight: row.weight };
  }

  /**
   * Patch a workflow's BASELINE rotation participation (migration 054). Any subset
   * of `{ inRotation, weight }` may be supplied. `weight` must be a non-negative
   * integer. Throws 'not found' when the workflow is missing (→ NOT_FOUND upstream).
   */
  setBaselineRotation(workflowId: string, patch: { inRotation?: boolean; weight?: number }): void {
    if (patch.weight !== undefined && (!Number.isInteger(patch.weight) || patch.weight < 0)) {
      throw new Error('WorkflowRegistry.setBaselineRotation: weight must be a non-negative integer');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.inRotation !== undefined) {
      sets.push('baseline_in_rotation = ?');
      params.push(patch.inRotation ? 1 : 0);
    }
    if (patch.weight !== undefined) {
      sets.push('baseline_rotation_weight = ?');
      params.push(patch.weight);
    }
    if (sets.length === 0) return;
    const stmt = this.db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`);
    // Rotation-lifecycle chokepoint (migration 058): toggling the baseline into/out of
    // rotation (or its weight across 0) is a membership change; reconcile atomically.
    const tx = this.db.transaction(() => {
      const result = stmt.run(...params, workflowId);
      if (result.changes === 0) {
        throw new Error(`WorkflowRegistry.setBaselineRotation: workflow ${workflowId} not found`);
      }
      reconcileRotationExperiment(this.db, workflowId);
    });
    tx();
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
    opts?: {
      projectId?: number;
      requestedExecutionModel?: ExecutionModel;
      requestedModel?: string;
      requestedEvalEnabled?: boolean;
      // A/B testing (migration 048). variant* are supplied by the VariantResolver
      // via RunLauncher.launch; experiment* are supplied by slice B's experiment
      // launcher. All stamped immutably (no UPDATE path), mirroring model/substrate.
      variantId?: string;
      variantLabel?: string;
      /** The variant's frozen spec_json — the EFFECTIVE spec this run executes. */
      variantSpecJson?: string;
      variantModel?: string;
      variantExecutionModel?: ExecutionModel;
      experimentId?: string;
      experimentArm?: ExperimentArm;
      /**
       * Rotation-experiment attribution (migration 058) supplied by the
       * VariantResolver via RunLauncher.launch on a GENUINE weighted rotation pick.
       * SEPARATE from experimentId (the side-by-side sandbox tag) per the migration's
       * CRITICAL INVARIANT — rotation runs are normal runs. Stamped immutably.
       *
       * RE-VALIDATED at the INSERT (revalidateRotationAttribution): the id crosses
       * RunLauncher's await gap (loadVerifyConfig), during which a membership write
       * can delete/replace/supersede the rotation. A stale id re-attributes to the
       * current running rotation when the picked arm is still a member, else
       * stamps NULL — never a dead id.
       */
      rotationExperimentId?: string;
      /**
       * Per-run launch override for visual-verification ENABLEMENT (the highest
       * rung of the enablement ladder). The caller (RunLauncher.launch) threads
       * the launch-UI choice here. undefined => unset, falls through to the
       * project / global rungs. (S1 reserves the rung; no picker surfaces it yet.)
       */
      requestedVerifyEnabled?: boolean | null;
      /**
       * Per-run launch override for the visual-verification TYPE (the highest
       * type rung). undefined => unset, falls through to the project / inferred /
       * global rungs. (S1 reserves the rung; no picker surfaces it yet.)
       */
      requestedVerifyType?: VerificationType | null;
      /**
       * The resolved per-project `.cyboflow/verify.json` document, loaded ONCE by
       * the async caller (RunLauncher.launch) via loadVerifyConfig(projectPath) —
       * createRun is synchronous, so the single fail-soft file read happens at the
       * launch seam and the parsed result is threaded in. createRun owns the
       * resolve+stamp; the caller owns only the I/O. null/undefined => no project
       * config (absent or malformed file), the project rungs fall through.
       */
      projectVerifyConfig?: VerifyConfigFile | null;
      /**
       * The deliverable being verified, feeding the resolver's rung-C
       * infer-from-deliverable-kind type rung. undefined/null => the inference
       * rung is skipped. (S1 reserves it; the request-time deliverable is not yet
       * threaded from a launch surface.)
       */
      verifyDeliverable?: VerificationRequestInput | null;
    },
  ): { runId: string; permissionMode: PermissionMode; substrate: CliSubstrate; executionModel: ExecutionModel } {
    const workflow = this.getById(workflowId);
    if (!workflow) {
      throw new Error(`WorkflowRegistry.createRun: workflow ${workflowId} not found`);
    }

    // Session invariant (permission-mode redesign slice 1b): a run can NEVER be
    // session-less. The owning session is the sole execution authority for the
    // agent permission mode and the chat gate vehicle resolves through it, so a
    // NULL session_id would strand the run. This is the single hard chokepoint —
    // both callers (ipc/session.ts quick sentinel + runLauncher.launch) thread a
    // real session id. (The signature stays `sessionId?: string` only because
    // TS1016 forbids a required parameter after the preceding optional
    // `requestedSubstrate?`; this throw is the runtime enforcement and narrows
    // sessionId to a non-empty string for the INSERT below.)
    if (!sessionId) {
      throw new Error('WorkflowRegistry.createRun: sessionId is required (run cannot be session-less)');
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
    // to 'orchestrated' unless an override selects 'programmatic'. The explicit
    // per-run request (opts.requestedExecutionModel, from RunLauncher.launch) is
    // the highest override rung; frontmatter/project-config rungs are not yet
    // wired and resolution otherwise uses the global default + env + the
    // substrate hard-pin + floor. With no override every run resolves
    // 'orchestrated' (zero-behavior-change). Like substrate, this is stamped ONCE
    // at INSERT and is immutable for the run lifetime — there is no UPDATE path.
    // Execution-model ladder (A/B): explicit per-run request > variant default >
    // global default > env > 'orchestrated' floor (interactive still hard-pins).
    const executionModel = resolveExecutionModel({
      substrate,
      requestedExecutionModel: opts?.requestedExecutionModel ?? opts?.variantExecutionModel,
      globalDefaultExecutionModel: this.config?.getDefaultExecutionModel?.(),
      env: process.env,
    });

    // Per-run model pin (migration 037). The explicit launch choice
    // (opts.requestedModel, from the Configure surface → runs.start →
    // RunLauncher.launch) is a USER-FACING alias ('opus' | 'sonnet' | 'haiku' |
    // 'auto' | …) resolved to a concrete snapshot at the spawn seam. There is no
    // resolver ladder (unlike substrate / permission / execution model): a run
    // either pins a model or it does not. Stamped ONCE here and immutable for the
    // run; NULL (no pin) is the legacy/zero-behavior-change floor — RunExecutor
    // then passes no `model` and the SDK uses its own default.
    // Model ladder (A/B): explicit per-run request > variant default > NULL.
    const model = opts?.requestedModel ?? opts?.variantModel ?? null;

    // Per-run code-review-eval override (migration 044). Like model, there is no
    // resolver ladder: a run either pins an explicit ON/OFF or leaves it NULL to
    // inherit the GLOBAL codeReviewEvalEnabled toggle at the trigger seam
    // (snapshotRunForEval). Stamped ONCE here and immutable for the run; NULL — the
    // legacy/zero-behavior-change floor — means "no per-run pin". Stored as 0/1/NULL.
    const evalEnabled =
      opts?.requestedEvalEnabled === undefined ? null : opts.requestedEvalEnabled ? 1 : 0;

    // Resolve the layered visual-verification posture (migration 055 — the
    // third immutable run-stamp sibling to substrate / execution_model). Decides
    // whether this run participates in visual verification, which TYPE of check,
    // and the live easy→hard backend chain. The global enablement + default-type
    // rungs come from the injected config's getVisualVerifyConfig(); the per-run
    // launch override (opts.requestedVerify*) and the project-config rungs
    // (opts.projectVerifyConfig — the parsed .cyboflow/verify.json the async
    // RunLauncher loaded ONCE and threaded in, since createRun is sync) sit above
    // the global rung, and the deliverable feeds the rung-C inference. The
    // host-available backends are the build's SHIPPED_VERIFY_BACKENDS (the
    // backends registered in the scheduler at boot — capturePage + playwright so
    // far) so the stamped chain can list every shipped rung; the per-backend
    // runtime healthCheck at drain is the second gate. When no config is injected
    // (test fixtures) every rung is unset and the run floors to the DISABLED posture.
    // Like substrate, this is stamped ONCE at INSERT and is immutable for the run
    // lifetime — there is no UPDATE path (a long run can't change posture
    // mid-flight). With the master switch OFF (the default) every run stamps
    // verify_enabled=0 / verify_type=NULL / verify_chain=NULL
    // (zero-behavior-change).
    const visualVerifyConfig = this.config?.getVisualVerifyConfig?.();
    const projectVerifyConfig = opts?.projectVerifyConfig ?? null;
    const verify = resolveVisualVerification({
      requestedEnabled: opts?.requestedVerifyEnabled ?? null,
      projectConfigEnabled: projectVerifyConfig?.enabled ?? null,
      globalDefaultEnabled: visualVerifyConfig?.enabled ?? null,
      requestedType: opts?.requestedVerifyType ?? null,
      projectConfigDefaultType: projectVerifyConfig?.defaultType ?? null,
      globalDefaultType: visualVerifyConfig?.defaultType ?? null,
      deliverable: opts?.verifyDeliverable ?? null,
      availableBackends: SHIPPED_VERIFY_BACKENDS,
    });
    const verifyEnabled = verify.enabled ? 1 : 0;
    const verifyType = verify.type;
    const verifyChain = verify.enabled ? JSON.stringify(verify.chain) : null;

    // Freeze the run's EFFECTIVE spec onto the run as a content address
    // (migration 026 + A/B 048). For a VARIANT run the effective spec is the
    // variant's frozen spec_json; otherwise it is the workflow's live spec_json.
    // Like substrate, spec_hash is stamped ONCE at INSERT and is immutable for the
    // run lifetime — there is no UPDATE path. The six per-run "effective
    // definition" readers resolve the run's spec from (workflow_id, spec_hash) via
    // resolveRunFrozenSpec, so a variant run walks its OWN graph and a mid-run
    // workflow edit no longer changes a running definition.
    const effectiveSpecJson = opts?.variantSpecJson ?? workflow.spec_json ?? '{}';
    const specHash = computeSpecHash(effectiveSpecJson);

    const insert = this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate, execution_model, model, eval_enabled, verify_enabled, verify_type, verify_chain, session_id, spec_hash, experiment_id, experiment_arm, variant_id, variant_label, rotation_experiment_id)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const createTx = this.db.transaction(() => {
      // Rotation attribution re-check (migration 058): the resolver's pick crossed
      // RunLauncher's await gap (loadVerifyConfig), during which a membership write
      // may have deleted/replaced/superseded the rotation experiment. Validate
      // inside the SAME transaction as the INSERT so the stamped id can never
      // point at a dead or wrong-arm-set experiment (the arm identity is the
      // picked variant, or the baseline sentinel when the baseline won the spin).
      const rotationExperimentId =
        opts?.rotationExperimentId === undefined
          ? null
          : revalidateRotationAttribution(
              this.db,
              workflowId,
              opts.rotationExperimentId,
              opts.variantId ?? BASELINE_VARIANT_SENTINEL,
            );
      insert.run(
        runId,
        workflowId,
        runProjectId,
        permissionMode,
        substrate,
        executionModel,
        model,
        evalEnabled,
        verifyEnabled,
        verifyType,
        verifyChain,
        sessionId ?? null,
        specHash,
        opts?.experimentId ?? null,
        opts?.experimentArm ?? null,
        opts?.variantId ?? null,
        opts?.variantLabel ?? null,
        rotationExperimentId,
      );
      // Ensure the frozen hash is always resolvable to its spec: snapshot a
      // revision for the EFFECTIVE spec we just stamped. INSERT OR IGNORE keyed on
      // UNIQUE(workflow_id, spec_hash) makes this idempotent, so a workflow (or
      // variant) that ran the same spec before adds no row — but a spec that ONLY
      // ever ran (never saved via the editor) still gets a revision row here, so
      // historic spec text is never lost. Same transaction as the INSERT, so the
      // frozen hash is always resolvable.
      this.recordRevision(workflowId, effectiveSpecJson);
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
      'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, current_step_id, task_id, seed_idea_id, claude_session_id, session_id, batch_id, seed_finding_ids, outcome, base_branch, base_sha, steps_snapshot_json, substrate, execution_model, model, eval_enabled, verify_enabled, verify_type, verify_chain, experiment_id, experiment_arm, variant_id, variant_label, rotation_experiment_id, merge_sha, started_at, ended_at, created_at, updated_at FROM workflow_runs WHERE id = ?',
    );
    const row = stmt.get(runId) as WorkflowRunRow | undefined;
    return row ?? null;
  }
}
