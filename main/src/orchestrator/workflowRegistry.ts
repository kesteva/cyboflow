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
import { workflowNameIssue } from './workflowName';
import type { LoggerLike, DatabaseLike } from './types';
import type { PermissionMode, WorkflowRow, WorkflowRunRow, CyboflowWorkflowName, WorkflowDefinition } from '../../../shared/types/workflows';
import {
  hasCustomSpecSlot,
  isCyboflowWorkflowName,
  resolveWorkflowDefinition,
  parseWorkflowDefinition,
  VERIFY_SETUP_WORKFLOW_NAME,
} from '../../../shared/types/workflows';
import {
  getTuningPreset,
  isTuningLevel,
  resolveEffectiveDefinition,
  serializeDefinition,
  type TuningLevel,
} from '../../../shared/tuning/workflowTuning';
import {
  runtimeMixOverrideRejection,
  tuningOverrideRejection,
} from '../../../shared/tuning/workflowTuningErrors';
import {
  DEFAULT_RUNTIME_MIX,
  isRuntimeMix,
  materializeForLevelAndMix,
  primaryProviderForMix,
  type RuntimeMix,
} from '../../../shared/tuning/runtimeMix';
import {
  MixedProviderOrchestratedError,
  ProviderOrchestratedUnsupportedError,
  RuntimeMixOrchestratedError,
} from '../../../shared/types/executionModelErrors';
import { providerLabel, providerSupportsOrchestrated } from './providerExecutionSupport';
import { computeEffectiveAgents, applyWorkflowAgentConfigs } from './agents/effectiveAgents';
import { loadBuiltInAgents } from './agents/agentCatalogue';
import { resolveStepAgentKey } from '../../../shared/types/agentIdentity';
import type { AgentOverrideRow } from '../database/models';
import type { CliSubstrate } from '../../../shared/types/substrate';
import {
  AGENT_PROVIDER_LABELS,
  WORKFLOW_LAUNCHABLE_RUNTIMES,
  assertProviderRuntimeConsistent,
  claudeRuntimeFromSubstrate,
  isAgentProviderEnabled,
  sdkRuntimeForProvider,
  isWorkflowLaunchableRuntime,
  providerForRuntime,
  type AgentProvider,
  type AgentProviderAccess,
  type WorkflowLaunchableRuntime,
  type WorkflowRunStorableRuntime,
} from '../../../shared/types/agentRuntime';
import { normalizeAgentModelSelection } from '../../../shared/types/agentModels';
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
import {
  reconcileRotationExperiment,
  reconcileRotationExperimentsForWorkflow,
  revalidateRotationAttribution,
} from './experimentStore';
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
   * Global-default substrate for the QUICK sentinel specifically (floors to the
   * interactive PTY). Consulted below the explicit per-run request and below the
   * forced-substrate pin. Optional so existing test-fixture WorkflowConfigProviders
   * that omit it fall back to getDefaultSubstrate() (byte-identical 'sdk' floor).
   */
  getQuickSessionDefaultSubstrate?(): CliSubstrate;
  /**
   * Boot-profile override that PINS the substrate for every run, bypassing the
   * whole resolution ladder (even the explicit per-run UI choice). Demo mode
   * returns 'sdk' here so no run/session ever engages the real interactive
   * manager. null (or absent) = no pin, resolve normally.
   */
  getForcedSubstrate?(): CliSubstrate | null;
  /** True only for the scripted demo boot profile. */
  isDemoMode?(): boolean;
  /**
   * The user's per-provider access toggles (Settings → Integrations / onboarding
   * Connect step). Consulted by createRun BELOW demo mode: a run may not resolve
   * onto a provider the user switched off. Optional + absent => both providers
   * enabled (the byte-identical default), so existing fixtures are unaffected.
   */
  getAgentProviderAccess?(): AgentProviderAccess;
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

/**
 * The providers `createRun`'s stamp ladder knows how to resolve — derived from
 * the launchable runtime set rather than listed, so it grows the moment a
 * provider's runtime becomes launchable and cannot drift from that set.
 */
const LAUNCH_LADDER_PROVIDERS: ReadonlySet<AgentProvider> = new Set(
  WORKFLOW_LAUNCHABLE_RUNTIMES.map((runtime) => providerForRuntime(runtime)),
);

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
      'SELECT id, project_id, name, workflow_path, permission_mode, spec_json, tuning_level, runtime_mix, created_at, archived_at FROM workflows WHERE id = ?',
    );
    const row = stmt.get(workflowId) as WorkflowRow | undefined;
    return row ?? null;
  }

  /**
   * The EFFECTIVE definition for a workflow — the read-path entry point every
   * definition consumer on the WORKFLOW (as opposed to per-run) side must go
   * through (plan D1 / risk #1).
   *
   * Resolution is `resolveEffectiveDefinition(name, spec_json, tuning_level)`:
   * a preset level applies its transform to the built-in, `'custom'` resolves
   * the spec slot, `'standard'` applies the flow's aligned-defaults pins where
   * a matrix agreed them (identity elsewhere). Reading `row.spec_json`
   * directly instead silently runs Standard for an Efficient-stamped flow —
   * which is exactly the failure this accessor exists to make hard.
   *
   * Returns null on the same condition `resolveWorkflowDefinition` does: a
   * missing row, or a custom flow whose spec is missing/unparseable.
   *
   * NOT for per-run reads: a run walks its FROZEN spec (`resolveRunFrozenSpec`),
   * never the live workflow row — see docs/CODE-PATTERNS.md.
   */
  getEffectiveDefinition(workflowId: string): WorkflowDefinition | null {
    const row = this.getById(workflowId);
    if (!row) return null;
    return resolveEffectiveDefinition(row.name, row.spec_json, row.tuning_level);
  }

  /**
   * Stamp a workflow's tuning level (the dial). ONE cheap write — `spec_json`
   * is never touched, which is what makes level switching lossless: a custom
   * definition survives untouched while a preset level is selected, and
   * selecting Custom again resolves the same slot.
   *
   * Guards (each throws a distinguishable Error the routers map to a TRPCError,
   * mirroring resetSpec's guard style — these are user-reachable input errors,
   * not crashes):
   *   - Missing row → 'not found' (→ NOT_FOUND).
   *   - Not a TuningLevel → 'invalid tuning level' (→ BAD_REQUEST). Callers
   *     validate too; this is the chokepoint's own guard.
   *   - A non-built-in ("save as new") flow → 'not a built-in' (→ BAD_REQUEST).
   *     Those rows have no built-in baseline, so `efficient`/`thorough`/
   *     `standard` have nothing to transform and would silently keep resolving
   *     the flow's own spec. The selector is hidden for them; this is the
   *     server-side half of that rule.
   *   - `'custom'` with an EMPTY slot → 'empty custom slot' (→ BAD_REQUEST).
   *     There is nothing for Custom to select, and stamping it would leave the
   *     row resolving `null` — an unrenderable flow.
   *
   * Idempotent: re-stamping the level a row already carries is a no-op UPDATE.
   */
  setTuningLevel(workflowId: string, level: TuningLevel): void {
    if (!isTuningLevel(level)) {
      throw new Error(
        `WorkflowRegistry.setTuningLevel: invalid tuning level '${String(level)}' for workflow ${workflowId}`,
      );
    }
    const row = this.getById(workflowId);
    if (!row) {
      throw new Error(`WorkflowRegistry.setTuningLevel: workflow ${workflowId} not found`);
    }
    if (!isCyboflowWorkflowName(row.name)) {
      throw new Error(
        `WorkflowRegistry.setTuningLevel: workflow ${workflowId} is not a built-in flow, so it has no tuning baseline`,
      );
    }
    if (level === 'custom' && !hasCustomSpecSlot(row.spec_json)) {
      throw new Error(
        `WorkflowRegistry.setTuningLevel: workflow ${workflowId} has an empty custom slot; save a definition from the advanced editor first`,
      );
    }
    const stmt = this.db.prepare('UPDATE workflows SET tuning_level = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      stmt.run(level, workflowId);
    });
    tx();
  }

  /**
   * Stamp a workflow's RUNTIME MIX (migration 128) — the second dial, deciding
   * which provider runs each step. ONE cheap write, exactly like
   * {@link setTuningLevel}: `spec_json` is never touched, and neither is the
   * level. The two dials are orthogonal and compose at `createRun`.
   *
   * Guards (each a distinguishable Error the routers map to a TRPCError):
   *   - Not a RuntimeMix → 'invalid runtime mix' (→ BAD_REQUEST).
   *   - Missing row → 'not found' (→ NOT_FOUND).
   *   - A non-built-in ("save as new") flow → 'not a built-in' (→ BAD_REQUEST).
   *     Those flows have no verification-class table, so there is nothing to
   *     split between providers; the selector is hidden for them and their runs
   *     stamp a NULL mix.
   *
   * There is deliberately no `empty_custom_slot` analogue: the mix transforms
   * whatever graph the level resolves, so an empty slot is the level's problem.
   *
   * Idempotent: re-stamping the mix a row already carries is a no-op UPDATE.
   */
  setRuntimeMix(workflowId: string, mix: RuntimeMix): void {
    if (!isRuntimeMix(mix)) {
      throw new Error(
        `WorkflowRegistry.setRuntimeMix: invalid runtime mix '${String(mix)}' for workflow ${workflowId}`,
      );
    }
    const row = this.getById(workflowId);
    if (!row) {
      throw new Error(`WorkflowRegistry.setRuntimeMix: workflow ${workflowId} not found`);
    }
    if (!isCyboflowWorkflowName(row.name)) {
      throw new Error(
        `WorkflowRegistry.setRuntimeMix: workflow ${workflowId} is not a built-in flow, so it has no runtime mix to route`,
      );
    }
    const stmt = this.db.prepare('UPDATE workflows SET runtime_mix = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      stmt.run(mix, workflowId);
    });
    tx();
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
   * Also stamps `tuning_level = 'custom'` in the SAME transaction (migration
   * 122): writing the custom slot IS the "overwrite this flow" save, and a slot
   * written while the row still reads `'efficient'` would resolve the preset
   * and silently ignore the definition just saved. This is the single
   * chokepoint behind both writers — the tRPC editor save and MCP
   * `cyboflow_update_workflow` (which reaches it through `WorkflowConfigLike`),
   * so neither can write a slot without the stamp.
   *
   * Throws if no row matches `workflowId` (0 rows updated).
   */
  updateSpec(workflowId: string, definition: WorkflowDefinition): void {
    const specJson = JSON.stringify(definition);
    const stmt = this.db.prepare(
      "UPDATE workflows SET spec_json = ?, tuning_level = 'custom' WHERE id = ?",
    );
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
   * Also flips `tuning_level` from `'custom'` back to `'standard'` in the SAME
   * transaction (migration 122) — an emptied slot has nothing for Custom to
   * select, so leaving the stamp would strand the row resolving `null`. The
   * flip is CONDITIONAL: resetting the slot of a flow parked on `'efficient'`
   * (its slot held a definition it was not currently running) must not knock it
   * off that level.
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
    const stmt = this.db.prepare(
      `UPDATE workflows
          SET spec_json = '{}',
              tuning_level = CASE WHEN tuning_level = 'custom' THEN 'standard' ELSE tuning_level END
        WHERE id = ?`,
    );
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

  /**
   * List a workflow's variants, newest-first. ARCHIVED variants (migration 116)
   * are excluded unless `includeArchived` — mirroring listWorkflows' own
   * archived-row clause, so the default list is the live set.
   */
  listVariants(workflowId: string, opts?: { includeArchived?: boolean }): WorkflowVariantRow[] {
    const archivedClause = opts?.includeArchived === true ? '' : ' AND archived_at IS NULL';
    return this.db
      .prepare(
        `SELECT * FROM workflow_variants
          WHERE workflow_id = ?${archivedClause}
          ORDER BY created_at DESC, id DESC`,
      )
      .all(workflowId) as WorkflowVariantRow[];
  }

  /**
   * Archive a variant (migration 116): stamps `archived_at` so it drops out of
   * the management list, the launch pickers and the rotation pool, WITHOUT
   * touching its status, weight or run history. Idempotent — re-archiving an
   * archived variant re-stamps and is otherwise a no-op.
   *
   * Rotation-lifecycle chokepoint (migration 058): archiving an ACTIVE weight>0
   * variant removes an arm, so the reconcile runs atomically with the write,
   * exactly as pausing it would. Throws 'not found' when the variant is missing.
   */
  archiveVariant(variantId: string): void {
    this.setVariantArchived(variantId, true);
  }

  /**
   * Reverse {@link archiveVariant}: clears `archived_at` back to NULL. The
   * variant returns with the status it was archived under — so unarchiving one
   * that was ACTIVE puts it straight back into rotation, which is why this
   * reconciles too. Throws 'not found' when the variant is missing.
   */
  unarchiveVariant(variantId: string): void {
    this.setVariantArchived(variantId, false);
  }

  private setVariantArchived(variantId: string, archived: boolean): void {
    const existing = this.getVariantById(variantId);
    if (!existing) {
      const verb = archived ? 'archiveVariant' : 'unarchiveVariant';
      throw new Error(`WorkflowRegistry.${verb}: variant ${variantId} not found`);
    }
    const stmt = this.db.prepare(
      archived
        ? "UPDATE workflow_variants SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        : "UPDATE workflow_variants SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?",
    );
    const tx = this.db.transaction(() => {
      stmt.run(variantId);
      reconcileRotationExperiment(this.db, existing.workflow_id, existing.tuning_level ?? null);
    });
    tx();
  }

  /**
   * The tuning level a launch (or a variant) of `workflowId` belongs to
   * (migration 126) — the single place "which pool is this?" is decided.
   *
   * A BUILT-IN flow resolves `override ?? the workflow's saved stamp`; anything
   * else (a "save as new" custom flow, the `__quick__` sentinel) is outside the
   * level system and resolves NULL, which is a real pool key meaning "this
   * workflow has exactly one pool". Returns null for a missing workflow too —
   * callers that care about existence check that themselves.
   */
  resolveEffectiveTuningLevel(workflowId: string, override?: TuningLevel): TuningLevel | null {
    const workflow = this.getById(workflowId);
    if (!workflow) return null;
    if (!isCyboflowWorkflowName(workflow.name)) return null;
    return override ?? workflow.tuning_level;
  }

  /**
   * Create a variant snapshotting the workflow's RESOLVED effective definition
   * at ONE TUNING LEVEL ("Create variant from current").
   *
   * Snapshots the workflow's EFFECTIVE definition at `tuningLevel` (migration
   * 122: the level's materialized graph, `spec_json` when the level is
   * `'custom'`) — so a built-in with a live `spec_json='{}'` freezes the
   * CONCRETE static graph rather than '{}' (independent of later built-in code
   * changes), and "create variant from current" on the Efficient page snapshots
   * what Efficient actually runs rather than the untransformed built-in. Seeds
   * `status='draft'` (rotation is explicit opt-in — a fresh variant is pinnable +
   * experiment-usable but never auto-rotated), `weight=1`, NULL
   * model/execution_model/agent_overrides_json.
   *
   * `tuningLevel` (migration 126) is the level the variant CHALLENGES, and it is
   * stored: a variant only ever rotates within its own level's pool. Omitted, it
   * defaults to the workflow's saved stamp — the level the editor is showing
   * when no page context is threaded. A non-built-in flow is outside the level
   * system, so its variants are always stored NULL and an explicit level there
   * is rejected rather than silently dropped.
   *
   * `definition` overrides what gets frozen: the Advanced editor's "save as new
   * variant of this flow" (plan D3) carries the EDITED graph, which is not the
   * workflow's resolved definition and must not be re-derived from it — without
   * this the create would snapshot the unedited flow and the edit would need a
   * follow-up `updateVariant` to land. The workflow row (and its level stamp) is
   * untouched either way. Callers pass a definition they have already validated
   * with the strict write-path schema; the registry only serializes it.
   *
   * Guards (distinguishable Error messages the router maps to TRPCError):
   *   - missing workflow → 'not found' (NOT_FOUND)
   *   - reserved sentinel (__quick__) → 'reserved' (BAD_REQUEST)
   *   - a tuning level on a non-built-in flow → 'no tuning levels' (BAD_REQUEST)
   *   - unresolvable definition (broken custom flow, no explicit `definition`)
   *     → 'unresolvable' (BAD_REQUEST)
   *   - label collision within the SAME level (UNIQUE) → 'already exists' (CONFLICT)
   */
  createVariantFromCurrent(
    workflowId: string,
    label: string,
    opts?: { definition?: WorkflowDefinition; tuningLevel?: TuningLevel },
  ): WorkflowVariantRow {
    const workflow = this.getById(workflowId);
    if (!workflow) {
      throw new Error(`WorkflowRegistry.createVariantFromCurrent: workflow ${workflowId} not found`);
    }
    if (workflow.name === QUICK_WORKFLOW_NAME) {
      throw new Error(
        `WorkflowRegistry.createVariantFromCurrent: '${workflow.name}' is a reserved sentinel and cannot have variants`,
      );
    }
    const isBuiltInFlow = isCyboflowWorkflowName(workflow.name);
    if (opts?.tuningLevel !== undefined && !isBuiltInFlow) {
      throw new Error(
        `WorkflowRegistry.createVariantFromCurrent: workflow ${workflowId} is not a built-in flow, so it has no tuning levels to scope a variant to`,
      );
    }
    const variantLevel: TuningLevel | null = isBuiltInFlow
      ? opts?.tuningLevel ?? workflow.tuning_level
      : null;
    const definition =
      opts?.definition ??
      resolveEffectiveDefinition(workflow.name, workflow.spec_json, variantLevel ?? 'custom');
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
    // Scoped to the LEVEL (migration 126): the same label may name a challenger
    // of Standard and a challenger of Thorough. `IS` so the NULL level compares.
    const collision = this.db
      .prepare(
        'SELECT 1 FROM workflow_variants WHERE workflow_id = ? AND tuning_level IS ? AND label = ? LIMIT 1',
      )
      .get(workflowId, variantLevel, trimmed);
    if (collision !== undefined) {
      throw new Error(
        `WorkflowRegistry.createVariantFromCurrent: a variant named '${trimmed}' already exists for this workflow at tuning level '${variantLevel ?? 'none'}'`,
      );
    }

    const id = `wfv_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    // The canonical serializer, not a bare JSON.stringify: a variant's frozen
    // graph is hashed and compared alongside materialized preset specs, and two
    // structurally identical definitions must produce the same string whatever
    // key order their producer happened to use.
    const specJson = serializeDefinition(definition);
    const insert = this.db.prepare(`
      INSERT INTO workflow_variants (id, workflow_id, label, spec_json, status, weight, tuning_level)
      VALUES (?, ?, ?, ?, 'draft', 1, ?)
    `);
    const tx = this.db.transaction(() => {
      insert.run(id, workflowId, trimmed, specJson, variantLevel);
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
      agentProvider?: AgentProvider | null;
      agentRuntime?: WorkflowLaunchableRuntime | null;
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
    if (patch.agentProvider !== undefined) {
      sets.push('agent_provider = ?');
      params.push(patch.agentProvider);
    }
    if (patch.agentRuntime !== undefined) {
      sets.push('agent_runtime = ?');
      params.push(patch.agentRuntime);
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
      reconcileRotationExperiment(this.db, existing.workflow_id, existing.tuning_level ?? null);
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
      reconcileRotationExperiment(this.db, existing.workflow_id, existing.tuning_level ?? null);
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
      reconcileRotationExperiment(this.db, workflowId, variant.tuning_level ?? null);
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
    // The baseline is an arm of EVERY tuning level's pool (migration 126), so this
    // one write fans out across all of the workflow's levels — unlike a variant
    // mutation, which touches only its own level's pool.
    const tx = this.db.transaction(() => {
      const result = stmt.run(...params, workflowId);
      if (result.changes === 0) {
        throw new Error(`WorkflowRegistry.setBaselineRotation: workflow ${workflowId} not found`);
      }
      reconcileRotationExperimentsForWorkflow(this.db, workflowId);
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

    const nameIssue = workflowNameIssue(name);
    if (nameIssue !== null) {
      throw new Error(`WorkflowRegistry.createCustom: ${nameIssue}`);
    }

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
   * Soft-archive a workflow row (migration 078, mirrors the entity
   * `archived_at` pattern from migration 024): stamps `archived_at` and
   * leaves everything else untouched — NO cascade to `workflow_runs` /
   * `workflow_revisions` / Insights history, and (unlike `deleteWorkflow`)
   * SUCCEEDS even when the workflow has run history.
   *
   * Guards (each throws a distinguishable Error the router maps to a
   * TRPCError), mirroring `deleteWorkflow`'s reserved-built-in check but
   * WITHOUT its run-history guard:
   *   - Missing row → message contains 'not found' (→ NOT_FOUND).
   *   - A GLOBAL built-in (`project_id IS NULL` AND a `CyboflowWorkflowName`)
   *     or the `__quick__` sentinel → message contains 'reserved'
   *     (→ BAD_REQUEST): both re-seed on the next reconcile / quick session,
   *     so archiving them is futile.
   */
  archiveWorkflow(workflowId: string): void {
    const row = this.getById(workflowId);
    if (!row) {
      throw new Error(`WorkflowRegistry.archiveWorkflow: workflow ${workflowId} not found`);
    }
    if (
      (row.project_id === null && isCyboflowWorkflowName(row.name)) ||
      row.name === QUICK_WORKFLOW_NAME
    ) {
      throw new Error(
        `WorkflowRegistry.archiveWorkflow: '${row.name}' is a reserved built-in and cannot be archived`,
      );
    }
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE workflows SET archived_at = datetime('now') WHERE id = ?").run(workflowId);
    });
    tx();
  }

  /**
   * Reverse `archiveWorkflow`: clears `archived_at` back to NULL. Same guards
   * as `archiveWorkflow` (missing row / reserved built-in); unarchiving a
   * never-archived row is a harmless no-op.
   */
  unarchiveWorkflow(workflowId: string): void {
    const row = this.getById(workflowId);
    if (!row) {
      throw new Error(`WorkflowRegistry.unarchiveWorkflow: workflow ${workflowId} not found`);
    }
    if (
      (row.project_id === null && isCyboflowWorkflowName(row.name)) ||
      row.name === QUICK_WORKFLOW_NAME
    ) {
      throw new Error(
        `WorkflowRegistry.unarchiveWorkflow: '${row.name}' is a reserved built-in and cannot be unarchived`,
      );
    }
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE workflows SET archived_at = NULL WHERE id = ?').run(workflowId);
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
   * `includeArchived` (migration 078) defaults to `true` — the registry itself
   * stays behavior-preserving for every existing caller that omits the
   * parameter (byte-identical to pre-archive behavior). The default-HIDE
   * policy lives one layer up, at the tRPC `workflows.list` router, which
   * passes `includeArchived: false` unless the caller opts in. Pass `false`
   * here to additionally exclude archived rows (`archived_at IS NOT NULL`).
   *
   * Note: the global rows returned here repeat across every project's call, so
   * the renderer (workflowsStore) dedupes the cross-project fan-out by `row.id`.
   */
  listByProject(projectId: number, includeArchived = true): WorkflowRow[] {
    // Exclude the __quick__ sentinel AND any dropped legacy built-ins
    // (soloflow/prune) that linger in a pre-refactor DB — they must
    // never appear in the user-facing picker. Filtered, not deleted, to
    // preserve the workflow_runs FK for historical runs.
    const excluded = [QUICK_WORKFLOW_NAME, ...LEGACY_DROPPED_WORKFLOW_NAMES];
    const placeholders = excluded.map(() => '?').join(', ');
    const archivedClause = includeArchived ? '' : ' AND archived_at IS NULL';
    const stmt = this.db.prepare(
      `SELECT id, project_id, name, workflow_path, permission_mode, spec_json, tuning_level, runtime_mix, created_at, archived_at
       FROM workflows
       WHERE (project_id = ? OR project_id IS NULL) AND name NOT IN (${placeholders})${archivedClause}
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
    return rows.filter(
      (row) => resolveEffectiveDefinition(row.name, row.spec_json, row.tuning_level) !== null,
    );
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
   * Freezes the run's EFFECTIVE spec onto the run as `spec_hash` (sha256 of the
   * spec text; migration 026) following the SAME no-UPDATE discipline as
   * substrate, and INSERT-OR-IGNOREs a `workflow_revisions` snapshot for that
   * hash so the frozen address always resolves to its spec text — even for a
   * spec that only ever ran and was never explicitly saved via the editor.
   *
   * The effective spec is MATERIALIZED FROM THE TUNING LEVEL (migration 122 /
   * plan D1): `custom` freezes the workflow's slot, `standard` freezes `'{}'`
   * (the built-in fallback — byte-identical to what every run stamped before the
   * dial existed), and a preset level freezes its serialized transform. The level
   * that produced it is stamped alongside on `workflow_runs.tuning_level`, NULL
   * for a variant run or a non-built-in flow.
   *
   * The RUNTIME MIX (migration 128) composes on top: it is resolved before the
   * provider/execution ladders (it decides the base provider and forces the
   * programmatic plane), applied to the level's graph in the same freeze via
   * `materializeForLevelAndMix`, and stamped on `workflow_runs.runtime_mix` with
   * the same NULL-is-unattributed ladder.
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
      variantAgentProvider?: AgentProvider;
      variantAgentRuntime?: WorkflowLaunchableRuntime;
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
      requestedAgentProvider?: AgentProvider;
      /**
       * STORABLE, not launchable. The `__quick__` sentinel run is created
       * through this same method, and it must carry whatever runtime the quick
       * SESSION resolved onto — the dispatch facade reads the row back to pick
       * the owning manager, so narrowing this to the launchable set would drop
       * the identity of a session-legal runtime and misroute it. A runtime that
       * is storable but not launchable is refused below rather than resolved.
       */
      requestedAgentRuntime?: WorkflowRunStorableRuntime;
      /**
       * Defense-in-depth guard for Design Mode (design-mode.md "Session plumbing
       * — SDK-pinned, fail-closed"): design sessions MUST resolve to the SDK
       * substrate — never interactive-PTY, never Codex — because the MCP
       * scope mechanism that limits a design session's toolset exists only on
       * the SDK path. The caller (sessions:create-quick's design branch)
       * already fail-closes BEFORE calling createRun (Claude availability
       * pre-flight + an isInteractivePtyOnly() pre-check); this flag is the
       * belt for the same race — a config change landing between the
       * pre-flight and this call. Set true => throw post-resolution if the
       * substrate ladder above resolved anything other than 'sdk'. Mirrors the
       * codexSdkRequested guard immediately below.
       */
      requireSdkSubstrate?: boolean;
      /**
       * PER-RUN tuning-level override (migration 122 / plan D4) — the launch
       * wizard's "run this once at THIS level", threaded runs.start ->
       * RunLauncher.launch -> here. Undefined = no override, the workflow's own
       * `tuning_level` stamp decides. It never writes the workflows row.
       *
       * Validated here (the chokepoint): rejected for a non-built-in flow, for
       * `'custom'` with an empty slot, and in combination with an explicit
       * variant pin — see `shared/tuning/workflowTuningErrors.ts`.
       */
      tuningLevel?: TuningLevel;
      /**
       * PER-RUN runtime-mix override (migration 128 / runtime-mix plan D3) — the
       * launch wizard's "run this once with THIS routing", threaded runs.start ->
       * RunLauncher.launch -> here. Undefined = no override, the workflow's own
       * `runtime_mix` stamp decides. It never writes the workflows row.
       *
       * Validated here (the chokepoint): rejected for a non-built-in flow and in
       * combination with a variant — see `shared/tuning/workflowTuningErrors.ts`.
       */
      runtimeMix?: RuntimeMix;
      /**
       * INTERNAL restart provenance (plan D4) — NOT reachable from the tRPC
       * input. `runs.restart` recovers the failed run's EXACT frozen spec from
       * `workflow_revisions` (keyed by its `spec_hash`) and replays it verbatim
       * together with the level it was stamped with, so a preset recalibration
       * — or an edit to the workflow's slot — between run and restart cannot
       * change what restarts. The pair travels together on purpose: replaying
       * the spec without its stamp would file the run under the wrong level.
       *
       * `tuningLevel: null` is meaningful (a pre-feature or non-built-in run
       * restarts unattributed, exactly as it ran). `runtimeMix` travels in the
       * same triple for the same reason and additionally has PRECEDENCE over the
       * workflow's current stamp for provider/plane derivation (runtime-mix plan
       * D6): a mix changed between failure and restart must not re-route a spec
       * that is being replayed verbatim.
       */
      frozenSpec?: { specJson: string; tuningLevel: TuningLevel | null; runtimeMix: RuntimeMix | null };
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

    // Provider/runtime are the forward-compatible agent route. During the
    // migration window, Claude runtimes project to the legacy substrate. The
    // Codex SDK requests keep the substrate on the SDK compatibility path and
    // route through the provider/runtime dispatch facade.
    // Demo mode ignores every provider/runtime request: its scripted
    // manager consumes Claude-shaped events, and no persisted run may resolve to
    // a real Codex dispatch route.
    // Provider/runtime ladder (A/B): explicit per-run launch request > variant
    // default > undefined (Claude). Mirrors the model / execution-model ladders
    // (opts.requestedModel ?? opts.variantModel) below — the launch picker sets
    // provider + runtime together as a consistent pair, and so does the variant
    // editor, so the independent `?? variant` fallbacks never cross a codex
    // provider with a claude runtime in practice.
    const demoMode = this.config?.isDemoMode?.() === true;
    const requestedAgentProvider = demoMode
      ? undefined
      : opts?.requestedAgentProvider ?? opts?.variantAgentProvider;
    const requestedAgentRuntime = demoMode
      ? undefined
      : opts?.requestedAgentRuntime ?? opts?.variantAgentRuntime;
    assertProviderRuntimeConsistent(
      requestedAgentProvider,
      requestedAgentRuntime,
      'WorkflowRegistry.createRun',
    );

    // The `__quick__` sentinel is a ROW, not a workflow LAUNCH: it exists to
    // carry whatever runtime the quick SESSION resolved onto, and the dispatch
    // facade reads it back to pick the owning manager. Hoisted above the
    // launch-resolution guard below, which the sentinel is exempt from.
    const isQuickSentinel = workflow.name === QUICK_WORKFLOW_NAME;

    // The stamp ladder below resolves every provider whose runtime is STORABLE.
    // A real workflow LAUNCH is narrower: it may only name a runtime the flow
    // machinery can actually deploy on (WORKFLOW_LAUNCHABLE_RUNTIMES), and a
    // request naming any other would advertise support that does not exist.
    // Refuse it where a developer sees it rather than resolving it. The two sets
    // COINCIDE today (omp-sdk joined the launchable set in Phase 2), so nothing a
    // caller can currently name reaches the throw — it is the seam that keeps the
    // NEXT storable-first runtime out of a launch, not dead code.
    //
    // The SENTINEL is exempt precisely because it is not advertising anything:
    // dropping a quick session's own runtime there would fall through to
    // `claudeRuntimeFromSubstrate` and misroute an OMP chat to Claude, which is
    // the silent-floor failure the provider registry exists to prevent.
    const unstampable =
      !isQuickSentinel &&
      ((requestedAgentRuntime !== undefined && !isWorkflowLaunchableRuntime(requestedAgentRuntime)) ||
        (requestedAgentProvider !== undefined && !LAUNCH_LADDER_PROVIDERS.has(requestedAgentProvider)));
    if (unstampable) {
      throw new Error(
        `WorkflowRegistry.createRun: agentProvider ${requestedAgentProvider ?? '-'} / ` +
          `agentRuntime ${requestedAgentRuntime ?? '-'} has no launch resolution yet`,
      );
    }

    // Provider-access gate — the authoritative enforcement of the Settings →
    // Integrations / onboarding Connect toggles. Sits BELOW demo mode (which
    // never dispatches to a real provider and is therefore exempt) and ABOVE the
    // substrate ladder, since it decides WHICH provider the run may resolve onto.
    //
    // An EXPLICIT request for a switched-off provider fails closed here rather
    // than spawning an account the user disabled — the renderer's pickers already
    // hide it, but a variant default, a stale payload, or an MCP-written config
    // can still name it. An UNREQUESTED run whose default route (Claude) is
    // switched off REROUTES to the other enabled provider instead of failing, so
    // a Codex-only install can still launch every flow.
    const providerAccess = demoMode ? undefined : this.config?.getAgentProviderAccess?.();
    const claudeEnabled = isAgentProviderEnabled(providerAccess, 'claude');
    const codexEnabled = isAgentProviderEnabled(providerAccess, 'codex');
    // The provider this request EXPLICITLY names, through either half of the
    // pair (they are already known consistent — assertProviderRuntimeConsistent
    // ran above). Derived from the registry rather than a per-provider pair of
    // `=== 'codex'` tests, which each silently missed a third provider.
    const explicitProvider: AgentProvider | undefined =
      requestedAgentProvider ??
      (requestedAgentRuntime !== undefined ? providerForRuntime(requestedAgentRuntime) : undefined);
    if (explicitProvider !== undefined && !isAgentProviderEnabled(providerAccess, explicitProvider)) {
      throw new Error(
        `WorkflowRegistry.createRun: the ${AGENT_PROVIDER_LABELS[explicitProvider]} provider is disabled in Settings → Integrations`,
      );
    }
    // ── Runtime mix: resolve, fill in a provider, force the plane (migration
    //    128 / runtime-mix plan D3, amended — the mix no longer RECONCILES with
    //    the requested provider; the two are orthogonal dials)
    //
    // Resolved HERE — after the provider REQUEST is known but before the
    // provider/runtime ladder, the substrate and `resolveExecutionModel` —
    // because it feeds all three: the mix's primary FILLS IN the base provider
    // when the launch named none, and a non-claude mix forces the programmatic
    // plane (only that plane honors the per-agent `agentConfigs` pins the mix
    // writes).
    //
    // A non-built-in ("save as new") flow has no verification class to split, so
    // it is outside the mix system entirely and stamps NULL. The `__quick__`
    // sentinel lands there too, which is correct — a quick chat has no DAG to
    // route. Hoisted above the tuning block below, which reads the same predicate.
    const isBuiltInFlow = isCyboflowWorkflowName(workflow.name);
    const overrideMix = opts?.runtimeMix;
    if (overrideMix !== undefined) {
      if (!isRuntimeMix(overrideMix)) {
        throw runtimeMixOverrideRejection('invalid_mix', overrideMix, workflow.name);
      }
      if (!isBuiltInFlow) {
        throw runtimeMixOverrideRejection('not_built_in', overrideMix, workflow.name);
      }
      // No containment model to fall back on (contrast the tuning level, whose
      // variants are level-scoped since migration 126): a variant is its own
      // frozen graph and its runs stamp a NULL mix, so a mix asked for alongside
      // one could neither be applied nor recorded.
      if (opts?.variantId !== undefined || opts?.variantSpecJson !== undefined) {
        throw runtimeMixOverrideRejection('variant_conflict', overrideMix, workflow.name);
      }
    }
    // Every arm that voids the mix. A VARIANT (including a rotation pick, not
    // just an explicit pin) runs its own graph off the variant/legacy ladders;
    // demo mode never dispatches to a real provider; a single-provider lane
    // (omp/pi today — anything the mix vocabulary cannot name) has no
    // execution/verification split to route, so the stamp is ignored rather than
    // half-honoured.
    const mixSuppressed =
      opts?.variantId !== undefined ||
      opts?.variantSpecJson !== undefined ||
      demoMode ||
      !isBuiltInFlow ||
      (explicitProvider !== undefined &&
        explicitProvider !== 'claude' &&
        explicitProvider !== 'codex');
    // A drifted column value cannot reroute a run: an unreadable mix reads as the
    // identity, exactly as an absent column would.
    const savedMix: RuntimeMix = isRuntimeMix(workflow.runtime_mix)
      ? workflow.runtime_mix
      : DEFAULT_RUNTIME_MIX;
    const resolvedMix: RuntimeMix | null = mixSuppressed
      ? null
      : opts?.frozenSpec !== undefined
        ? // Restart precedence (plan D6): the replayed spec was materialized under
          // THIS mix, so re-deriving from the workflow's current stamp would route
          // a graph that no longer matches it.
          opts.frozenSpec.runtimeMix
        : overrideMix ?? savedMix;
    // The mix is taken VERBATIM — an explicit provider does not rewrite it. The
    // two are orthogonal dials: the requested provider is the run's ORCHESTRATOR,
    // the mix is the per-agent routing of the steps the flow dispatches, and
    // `applyRuntimeMix` pins every routed agent's runtime explicitly so a mixed
    // graph runs identically whichever provider the run itself resolved onto.
    // (This replaced a `reconcileMixWithProvider` swap that made picking
    // `codex-primary` in the wizard move the Runtime row to Codex.)
    const effectiveMix: RuntimeMix | null = resolvedMix;
    // The provider a SAVED mix FILLS IN when the launch named none at all — the
    // backlog/idea launchers and MCP, which carry no Runtime row to override.
    // Gated like an explicit request: a codex mix saved before the toggle flipped
    // must fail closed, not spawn a provider the user switched off in Settings.
    const mixDerivedProvider: AgentProvider | undefined =
      effectiveMix !== null &&
      explicitProvider === undefined &&
      primaryProviderForMix(effectiveMix) === 'codex'
        ? 'codex'
        : undefined;
    if (
      mixDerivedProvider !== undefined &&
      !isAgentProviderEnabled(providerAccess, mixDerivedProvider)
    ) {
      throw new Error(
        `WorkflowRegistry.createRun: the ${AGENT_PROVIDER_LABELS[mixDerivedProvider]} provider is disabled in Settings → Integrations`,
      );
    }

    // The provider this run actually resolves onto: the explicit request, else
    // the saved mix's primary, else the reroute. An UNREQUESTED run whose default
    // route (Claude) is switched off reroutes to Codex; every other provider is
    // absent⇒disabled, so reaching it always takes an explicit request and it is
    // never a reroute target.
    //
    // The mix-derived arm deliberately sits BELOW the explicit request (a chosen
    // orchestrator is never overridden by the mix) and ABOVE the reroute (a saved
    // mix is a stated intent; the reroute is a fallback).
    const resolvedProvider: AgentProvider | undefined =
      explicitProvider ?? mixDerivedProvider ?? (!claudeEnabled && codexEnabled ? 'codex' : undefined);
    /**
     * The STRUCTURED non-Claude runtime this run resolves onto, or undefined for
     * Claude. It drives the substrate projection ('sdk' — every structured
     * runtime piggybacks it), the sdk-substrate conflict guard, and both stamps.
     *
     * DERIVED from the provider registry rather than a per-provider ternary
     * chain. The chain this replaced had arms for codex and omp only, so an
     * explicit `pi` request fell through to `undefined` and was then stamped
     * `agentProvider: 'claude'` on a Claude runtime — a launch silently
     * executing on the wrong vendor, with pi's prompt envelope never rendered.
     * A missing arm is not a throw, it is a misroute, which is why the mapping
     * belongs on `AgentProviderDefinition.sdkRuntime` where a new provider
     * cannot omit it. A provider whose runtime is storable-but-not-launchable
     * can only reach here on the sentinel; the guard above refuses a real launch
     * that names one.
     */
    const structuredSdkRuntime: WorkflowRunStorableRuntime | undefined =
      resolvedProvider === undefined || resolvedProvider === 'claude'
        ? undefined
        : sdkRuntimeForProvider(resolvedProvider);
    const substrateFromRuntime: CliSubstrate | undefined =
      requestedAgentRuntime === 'claude-interactive'
        ? 'interactive'
        : requestedAgentRuntime === 'claude-sdk' || structuredSdkRuntime !== undefined
          ? 'sdk'
          : undefined;
    if (
      requestedSubstrate !== undefined &&
      substrateFromRuntime !== undefined &&
      requestedSubstrate !== substrateFromRuntime
    ) {
      throw new Error(
        // Name the runtime that actually caused the conflict: on a mix-derived
        // route there IS no requested runtime, and reporting `undefined` would
        // send the reader looking for a request nobody made.
        `WorkflowRegistry.createRun: substrate ${requestedSubstrate} conflicts with agentRuntime ${requestedAgentRuntime ?? structuredSdkRuntime}`,
      );
    }
    const substrateRequest = requestedSubstrate ?? substrateFromRuntime;

    // Resolve the substrate via the override ladder. The explicit per-run UI
    // choice (requestedSubstrate, from WorkflowPicker → runs.start →
    // RunLauncher.launch) is the HIGHEST-precedence level and is threaded here.
    // The global default comes from the injected config; frontmatter /
    // project-config rungs are not yet wired (still resolve from env + floor).
    // With no override at any level every run resolves 'sdk' (zero-behavior-change).
    // A boot-profile pin (demo mode → 'sdk') outranks the whole ladder,
    // including the explicit per-run UI choice — demo runs must never spawn a
    // real agent regardless of what the launch surface requested.
    const forcedSubstrate = demoMode
      ? 'sdk'
      : this.config?.getForcedSubstrate?.() ?? null;
    // Demo carve-out (illustration only): the boot-profile pin is 'sdk', but a
    // quick session that EXPLICITLY requested 'interactive' is honored so the
    // canned PTY terminal can be shown in demo mode. This is safe because the
    // real REPL is never spawned — the quick-session eager-spawn path and the
    // sessions:input relay both short-circuit in demo (see ipc/session.ts), and
    // DemoTerminalView paints a purely client-side scripted session. Scoped to
    // the __quick__ sentinel so no demo WORKFLOW run can ever resolve interactive
    // (which WOULD dispatch to the real interactive manager via the facade).
    const demoHonorsInteractive =
      demoMode &&
      isQuickSentinel &&
      substrateRequest === 'interactive';
    // The QUICK sentinel resolves against its OWN global-default rung
    // (getQuickSessionDefaultSubstrate, floor 'interactive' — quick sessions
    // default to the PTY); WORKFLOW runs keep getDefaultSubstrate (floor 'sdk').
    // Both sit below an explicit per-run request and below the forced pin, so
    // demo ('sdk') stays byte-identical: only an EXPLICIT interactive request
    // trips demoHonorsInteractive, never this default.
    const globalDefaultSubstrate = isQuickSentinel
      ? (this.config?.getQuickSessionDefaultSubstrate?.() ?? this.config?.getDefaultSubstrate())
      : this.config?.getDefaultSubstrate();
    const substrate = demoHonorsInteractive
      ? 'interactive'
      : forcedSubstrate ?? resolveSubstrate({
          requestedSubstrate: substrateRequest,
          globalDefaultSubstrate,
          env: process.env,
        });
    if (structuredSdkRuntime !== undefined && substrate !== 'sdk') {
      throw new Error(
        `WorkflowRegistry.createRun: ${structuredSdkRuntime} workflow runs require sdk substrate compatibility (got ${substrate})`,
      );
    }
    if (opts?.requireSdkSubstrate && substrate !== 'sdk') {
      throw new Error(
        `WorkflowRegistry.createRun: design sessions require sdk substrate compatibility (got ${substrate})`,
      );
    }
    const agentProvider: AgentProvider = demoMode || structuredSdkRuntime === undefined
      ? 'claude'
      : providerForRuntime(structuredSdkRuntime);
    const agentRuntime: WorkflowRunStorableRuntime = demoMode
      ? 'claude-sdk'
      : structuredSdkRuntime ?? claudeRuntimeFromSubstrate(substrate);

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
    // The __quick__ sentinel is ad-hoc chat, NOT a DAG walked by the programmatic
    // host loop (RunExecutor drives programmatic runs through WorkflowController),
    // so it is hard-pinned 'orchestrated' regardless of the global default — a
    // quick session must never be handed to the host loop. Real workflow runs
    // resolve normally: the global default now floors to 'programmatic' via
    // ConfigManager.getDefaultExecutionModel (SDK only; interactive hard-pins
    // orchestrated inside the resolver).
    const resolvedExecutionModel: ExecutionModel = isQuickSentinel
      ? 'orchestrated'
      : resolveExecutionModel({
          substrate,
          requestedExecutionModel: opts?.requestedExecutionModel ?? opts?.variantExecutionModel,
          globalDefaultExecutionModel: this.config?.getDefaultExecutionModel?.(),
          env: process.env,
        });

    // A non-claude mix routes individual agents through `agentConfigs` pins, and
    // ONLY the programmatic step runner honors those — the orchestrated plane's
    // overlay writes Claude subagent `.md` files with no Codex equivalent, so an
    // orchestrated mixed run would silently ignore every per-step tier the mix
    // promises. Silent degradation is exactly what the mixed-provider guard below
    // exists to prevent, so the mix forces the plane instead of tripping it
    // (runtime-mix plan D3 step 3).
    //
    // An inherit / global-default resolution is upgraded SILENTLY; only an
    // EXPLICIT `'orchestrated'` request is refused, because that is a
    // contradiction the caller stated and must not have resolved behind their
    // back. The wizard hides the Mode row under a non-claude mix, so only a raw
    // API/MCP caller can reach the throw.
    const mixForcesProgrammatic = effectiveMix !== null && effectiveMix !== 'claude';
    if (
      effectiveMix !== null &&
      mixForcesProgrammatic &&
      opts?.requestedExecutionModel === 'orchestrated'
    ) {
      throw new RuntimeMixOrchestratedError(effectiveMix);
    }
    const executionModel: ExecutionModel = mixForcesProgrammatic
      ? 'programmatic'
      : resolvedExecutionModel;

    // Whole-run provider / orchestrated guard. The mixed-provider guard below is
    // deliberately scoped to a CLAUDE base provider, because a whole-run
    // non-Claude request is one consistent provider rather than a mix. That
    // exemption assumes the provider can actually HOST an orchestrated run — one
    // process walking the DAG with the prompt envelope and question bridge — and
    // that is a per-provider capability, not a given: OMP shipped its
    // programmatic lane only. Refuse here, before any workflow_runs row exists,
    // so a launch that would otherwise start a main orchestrator outside the
    // shipped contract fails with a sentence naming the fix instead.
    //
    // The `__quick__` sentinel is EXEMPT and must stay so: it hard-pins
    // 'orchestrated' above (a quick chat is not a DAG), and its provider is
    // whatever the quick SESSION resolved onto — tripping this would make every
    // OMP quick session unlaunchable.
    if (
      executionModel === 'orchestrated' &&
      !isQuickSentinel &&
      !providerSupportsOrchestrated(agentProvider)
    ) {
      throw new ProviderOrchestratedUnsupportedError(providerLabel(agentProvider));
    }

    // ── Tuning level: resolve, validate, materialize (migration 122 / plan D1+D4)
    //
    // Resolved HERE — above the mixed-provider guard and the spec freeze — because
    // both consume the run's EFFECTIVE definition, and reading the raw
    // `workflow.spec_json` for either would silently run Standard for a flow the
    // user parked on Efficient (plan risk #1).
    //
    // A non-built-in ("save as new") flow is outside the level system entirely: it
    // has no built-in baseline for a preset to transform, so it keeps today's
    // behaviour (freeze its own spec) and stamps a NULL level. The `__quick__`
    // sentinel lands here too, which is correct — a quick chat has no DAG to tune.
    // (`isBuiltInFlow` is resolved with the runtime mix above — the same predicate
    // gates both dials.)
    const overrideLevel = opts?.tuningLevel;
    if (overrideLevel !== undefined) {
      if (!isTuningLevel(overrideLevel)) {
        throw tuningOverrideRejection('invalid_level', overrideLevel, workflow.name);
      }
      if (!isBuiltInFlow) {
        throw tuningOverrideRejection('not_built_in', overrideLevel, workflow.name);
      }
      // Level containment (migration 126, superseding plan D4's blanket mutual
      // exclusion): variants are scoped to a level, so the level picks the POOL
      // and rotation/baseline/pin picks inside it — an override paired with a
      // variant of THAT level is coherent and allowed. What is still rejected is
      // a pin of a variant belonging to some OTHER level: the variant's frozen
      // graph would win over the level the user just asked for, silently running
      // a different configuration under its name.
      //
      // A `variantSpecJson` with no `variantId` carries no level to compare, so
      // it stays rejected outright (no such caller exists today — RunLauncher
      // always threads the pair — but a bare spec is unattributable by
      // construction, not merely unverified).
      if (opts?.variantId !== undefined) {
        const pinned = this.getVariantById(opts.variantId);
        if (pinned !== null && (pinned.tuning_level ?? null) !== overrideLevel) {
          throw tuningOverrideRejection('variant_conflict', overrideLevel, workflow.name);
        }
      } else if (opts?.variantSpecJson !== undefined) {
        throw tuningOverrideRejection('variant_conflict', overrideLevel, workflow.name);
      }
      if (overrideLevel === 'custom' && !hasCustomSpecSlot(workflow.spec_json)) {
        throw tuningOverrideRejection('empty_custom_slot', overrideLevel, workflow.name);
      }
    }
    const effectiveLevel: TuningLevel | null = isBuiltInFlow
      ? overrideLevel ?? workflow.tuning_level
      : null;

    // The EFFECTIVE spec TEXT this run freezes, in precedence order:
    //   1. an explicit variant's frozen spec (a variant is its own definition);
    //   2. a restart's recovered frozen spec (replay, never re-derive — D4);
    //   3. the level×mix materialization (custom -> slot, standard -> '{}', preset
    //      -> the serialized transform; then the mix's provider pins on top).
    // Unreachable in combination: restart pins `baseline: true` exactly when the
    // failed run had no variant, so (1) and (2) never both apply.
    //
    // `materializeForLevelAndMix` short-circuits the `'claude'` arm through
    // `materializeForLevel` VERBATIM — no parse, no re-serialize — so a flow that
    // never touched the mix dial (and every non-built-in flow, whose mix is NULL)
    // freezes the byte-identical text, and therefore the identical spec_hash, it
    // froze before migration 128.
    const effectiveSpecJson =
      opts?.variantSpecJson ??
      opts?.frozenSpec?.specJson ??
      (effectiveLevel === null
        ? workflow.spec_json ?? '{}'
        : materializeForLevelAndMix(
            workflow.name,
            workflow.spec_json,
            effectiveLevel,
            effectiveMix ?? DEFAULT_RUNTIME_MIX,
          ));

    // The level this run is FILED under (migration 122). NULL is "unattributed":
    // a variant run (its spec is the variant's, not a level's — crediting a level
    // would poison the per-level estimate buckets), a non-built-in flow, or a
    // restart replaying a run that was itself unattributed.
    const tuningLevelStamp: TuningLevel | null =
      opts?.variantId !== undefined || opts?.variantSpecJson !== undefined
        ? null
        : opts?.frozenSpec !== undefined
          ? opts.frozenSpec.tuningLevel
          : effectiveLevel;

    // The mix this run is FILED under (migration 128), on the SAME provenance
    // ladder as the level: variant -> NULL (its graph is the variant's, not a
    // mix's), restart -> the replayed stamp, otherwise the effective mix. NULL is
    // "unattributed" for every other suppressed arm too (a non-built-in flow, an
    // omp/pi lane, demo mode) — never `'claude'`.
    const runtimeMixStamp: RuntimeMix | null =
      opts?.variantId !== undefined || opts?.variantSpecJson !== undefined
        ? null
        : opts?.frozenSpec !== undefined
          ? opts.frozenSpec.runtimeMix
          : effectiveMix;

    // Mixed-provider / orchestrated guard (Phase 2 slice D1). A per-agent
    // FOREIGN runtime pin — set EITHER in a workflow agent config
    // (`WorkflowAgentConfig.runtime`) OR in the project's `agent_overrides`
    // catalogue via the Agents editor — is only honored by the PROGRAMMATIC step
    // runner, which spawns each step as its own CLI process. An ORCHESTRATED run
    // is a single agent process for the whole DAG, so a per-step provider
    // override would be SILENTLY IGNORED there. Guard here, before any
    // workflow_runs row exists, so a mixed flow never launches silently-degraded —
    // a later slice's UI catches MixedProviderOrchestratedError to prompt "switch
    // to programmatic?" instead.
    //
    // SYMMETRIC in the run's base provider (runtime-mix plan D3, review finding
    // 6). The trip condition is a pin whose provider differs from the one the RUN
    // resolved onto — so a whole-run Codex request with every step on Codex is
    // still exempt (nothing is mixed), while a hand-pinned `claude-sdk` step on a
    // codex-base orchestrated run — which the old `agentProvider === 'claude'`
    // scoping waved through, silently ignoring the pin — now trips it. A
    // claude-base run behaves exactly as before: a claude pin on a claude run is
    // not foreign.
    //
    // A non-claude MIX never reaches here: it forced 'programmatic' above, which
    // is precisely the plane that honors the pins it wrote.
    //
    // The `__quick__` sentinel is EXEMPT: a quick chat is a single ad-hoc Claude
    // turn, not a DAG that dispatches step agents, so a per-agent pin is
    // inert there — and neither the quick-session nor the chat-sentinel createRun
    // caller catches MixedProviderOrchestratedError, so tripping it would brick
    // quick sessions project-wide the moment any agent is pinned off Claude.
    if (executionModel === 'orchestrated' && !isQuickSentinel) {
      // Resolve the definition from the SAME `effectiveSpecJson` the freeze
      // below stamps — including a tuning preset's `agentConfigs`, which can
      // themselves pin a runtime and so must be visible to this guard. For the
      // variant case, parseWorkflowDefinition (not resolveWorkflowDefinition) is
      // used deliberately — a frozen variant spec must stand on its own and
      // should never fall back to a built-in default the variant didn't ask for.
      // Fails soft to null on a missing/malformed definition (no throw): an
      // unreadable spec has no reachable agents to detect, so it can't be
      // "mixed" either — spec validation is a separate concern owned by the
      // workflow/variant editors, not this guard.
      const effectiveDefinitionForMixCheck: WorkflowDefinition | null =
        opts?.variantSpecJson !== undefined
          ? parseWorkflowDefinition(effectiveSpecJson)
          : resolveWorkflowDefinition(workflow.name, effectiveSpecJson);
      if (
        this.effectiveSetPinsForeignRuntime(
          runProjectId,
          effectiveDefinitionForMixCheck,
          agentProvider,
        )
      ) {
        throw new MixedProviderOrchestratedError();
      }
    }

    // Per-run model pin (migration 037). The explicit launch choice
    // (opts.requestedModel, from the Configure surface → runs.start →
    // RunLauncher.launch) is a provider-scoped USER-FACING alias. Normalize it
    // after provider/runtime resolution so a stale picker value from another
    // runtime is stored as no pin instead of being silently carried into this run.
    // Model ladder (A/B): explicit per-run request > variant default > NULL.
    // Runtime spawn seams still do concrete provider-specific translation.
    const model =
      normalizeAgentModelSelection(agentProvider, opts?.requestedModel ?? opts?.variantModel) ?? null;

    // Per-run code-review-eval override (migration 044). Like model, there is no
    // resolver ladder: a run either pins an explicit ON/OFF or leaves it NULL to
    // inherit the GLOBAL codeReviewEvalEnabled toggle at the trigger seam
    // (snapshotRunForEval). Stamped ONCE here and immutable for the run; NULL — the
    // legacy/zero-behavior-change floor — means "no per-run pin". Stored as 0/1/NULL.
    //
    // The tuning level supplies the DEFAULT when the wizard didn't pin one (plan
    // D6): `evalDefault` is the ONLY eval lever levels have — jury composition is
    // untouched at every level. Only the `efficient` presets carry it (false), so
    // standard / thorough / custom / variant / non-built-in runs all still stamp
    // NULL and behave byte-for-byte as before. Keyed off the STAMPED level, so a
    // variant run (NULL) consults no preset — its graph is the variant's, not a
    // level's.
    const levelEvalDefault =
      tuningLevelStamp === null
        ? undefined
        : getTuningPreset(workflow.name, tuningLevelStamp)?.evalDefault;
    const resolvedEvalEnabled = opts?.requestedEvalEnabled ?? levelEvalDefault;
    const evalEnabled = resolvedEvalEnabled === undefined ? null : resolvedEvalEnabled ? 1 : 0;

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
      // BOOTSTRAP RUNG (above the whole ladder): this run IS the verification
      // setup flow, whose only verification is the `setup_proof` that proves the
      // project's runbook. Resolving it through the ordinary ladder deadlocks the
      // bootstrap — with the master switch off (the shipped default) the flow can
      // only ever produce an unproven draft, and the switch it is gated behind is
      // the one it exists to make worth turning on. Observed live 2026-07-31.
      setupFlowBootstrap: workflow.name === VERIFY_SETUP_WORKFLOW_NAME,
      requestedEnabled: opts?.requestedVerifyEnabled ?? null,
      projectConfigEnabled: projectVerifyConfig?.enabled ?? null,
      globalDefaultEnabled: visualVerifyConfig?.enabled ?? null,
      requestedType: opts?.requestedVerifyType ?? null,
      projectConfigDefaultType: projectVerifyConfig?.defaultType ?? null,
      globalDefaultType: visualVerifyConfig?.defaultType ?? null,
      deliverable: opts?.verifyDeliverable ?? null,
      availableBackends: SHIPPED_VERIFY_BACKENDS,
      // Engine selector (redesign §5.8): the verification-AGENT engine is the
      // default; `CYBOFLOW_VERIFY_LEGACY=1` opts a NEW run back onto the legacy
      // capture/judge chain. Read once here at the (immutable) stamp — a pre-existing
      // run keeps whatever chain it was stamped with.
      legacyEngine: process.env.CYBOFLOW_VERIFY_LEGACY === '1',
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
    //
    // LEVEL-AWARE since migration 122 / plan phase 3: `effectiveSpecJson` is
    // resolved above (variant spec > restart replay > level materialization) and
    // the level it was materialized at is stamped alongside the hash, so the two
    // can never disagree about what this run executed.
    const specHash = computeSpecHash(effectiveSpecJson);

    const insert = this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate, agent_provider, agent_runtime, execution_model, model, eval_enabled, verify_enabled, verify_type, verify_chain, session_id, spec_hash, experiment_id, experiment_arm, variant_id, variant_label, rotation_experiment_id, tuning_level, runtime_mix)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              effectiveLevel,
              opts.rotationExperimentId,
              opts.variantId ?? BASELINE_VARIANT_SENTINEL,
            );
      insert.run(
        runId,
        workflowId,
        runProjectId,
        permissionMode,
        substrate,
        agentProvider,
        agentRuntime,
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
        tuningLevelStamp,
        runtimeMixStamp,
      );
      // Ensure the frozen hash is always resolvable to its spec: snapshot a
      // revision for the EFFECTIVE spec we just stamped. INSERT OR IGNORE keyed on
      // UNIQUE(workflow_id, spec_hash) makes this idempotent, so a workflow (or
      // variant) that ran the same spec before adds no row — but a spec that ONLY
      // ever ran (never saved via the editor) still gets a revision row here, so
      // historic spec text is never lost. Same transaction as the INSERT, so the
      // frozen hash is always resolvable.
      //
      // This is what makes a materialized PRESET spec durably recoverable, which
      // plan D4's restart depends on: an efficient/thorough run's graph exists
      // nowhere else (the dial never writes `spec_json`), so without this row a
      // restart would have only a hash pointing at nothing.
      this.recordRevision(workflowId, effectiveSpecJson);
    });

    createTx();

    return { runId, permissionMode, substrate, executionModel };
  }

  /**
   * Does an agent THIS workflow can actually dispatch resolve onto a runtime
   * belonging to a provider OTHER than the one the run resolved onto? — the
   * orchestrated mixed-provider trip condition.
   *
   * Two-part check:
   *   1. REACHABILITY — the agent keys the workflow can spawn: every phase step's
   *      agent plus every fan-out inner step's agent (resolveStepAgentKey maps a
   *      step label to its canonical key; the `human` gate → null). A pin on
   *      an agent this workflow never spawns (e.g. a planner-only agent pinned in
   *      the catalogue, launched under sprint) can't cause a mix, so it must NOT
   *      trip — scoping to reachable agents avoids blocking unrelated workflows.
   *   2. EFFECTIVE RUNTIME — the project `agent_overrides` catalogue layered UNDER
   *      the workflow's `agentConfigs` (the same precedence the spawn-time overlay
   *      applies; variant deltas can't touch `runtime`, so they're excluded).
   *      Consulting the RESOLVED set is what catches a pin set through the
   *      Agents editor, while a workflow config that pins an agent back to the
   *      run's own provider correctly MASKS a catalogue foreign pin (no false
   *      positive).
   *
   * The trip condition is "the pinned runtime's provider is not `runProvider`",
   * read through the runtime registry — NOT a literal `=== 'codex-sdk'`, and not
   * a one-way "is not Claude". The literal is exactly what would let an `omp-sdk`
   * per-agent pin launch an orchestrated run that silently ignores it; the
   * one-way form let a `claude-sdk` pin do the same on a codex-BASE run
   * (runtime-mix plan D3, review finding 6). The guard has to widen with the
   * launchable set, not stay one provider behind it.
   *
   * Fail-soft: an unresolvable definition (null) or any read/parse error yields
   * `false` — an unprovable mix must never break a launch. A missing catalogue
   * table is expected on a schema-narrow test DB (→ no overrides); a genuine read
   * error is logged so a silently-disabled guard stays diagnosable.
   */
  private effectiveSetPinsForeignRuntime(
    projectId: number,
    definition: WorkflowDefinition | null,
    runProvider: AgentProvider,
  ): boolean {
    try {
      if (definition === null) return false;
      const reachable = new Set<string>();
      for (const phase of definition.phases) {
        for (const step of phase.steps) {
          const key = resolveStepAgentKey(step.id, step.agent);
          if (key !== null) reachable.add(key);
          for (const inner of step.fanOut?.inner ?? []) {
            const innerKey = resolveStepAgentKey(inner.id, inner.agent);
            if (innerKey !== null) reachable.add(innerKey);
          }
        }
      }
      if (reachable.size === 0) return false;

      let overrides: AgentOverrideRow[] = [];
      try {
        overrides = this.db
          .prepare('SELECT * FROM agent_overrides WHERE project_id = ?')
          .all(projectId) as AgentOverrideRow[];
      } catch (err) {
        this.logger.warn(
          `WorkflowRegistry.effectiveSetPinsForeignRuntime: agent_overrides read failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      let effective = computeEffectiveAgents(loadBuiltInAgents(), overrides);
      if (definition.agentConfigs) {
        effective = applyWorkflowAgentConfigs(effective, definition.agentConfigs);
      }
      return effective.some(
        (agent) =>
          agent.runtime != null &&
          providerForRuntime(agent.runtime) !== runProvider &&
          reachable.has(agent.agentKey),
      );
    } catch (err) {
      this.logger.warn(
        `WorkflowRegistry.effectiveSetPinsForeignRuntime: resolution failed for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Look up a workflow run by its string primary key.
   * Returns null if no row exists.
   */
  getRunById(runId: string): WorkflowRunRow | null {
    const stmt = this.db.prepare(
      'SELECT id, workflow_id, project_id, status, permission_mode_snapshot, worktree_path, branch_name, policy_json, stuck_at, stuck_reason, error_message, current_step_id, task_id, seed_idea_id, claude_session_id, session_id, batch_id, seed_finding_ids, seed_idea_ids, seed_prompt, outcome, base_branch, base_sha, steps_snapshot_json, substrate, agent_provider, agent_runtime, execution_model, model, eval_enabled, verify_enabled, verify_type, verify_chain, experiment_id, experiment_arm, variant_id, variant_label, rotation_experiment_id, tuning_level, runtime_mix, merge_sha, started_at, ended_at, created_at, updated_at FROM workflow_runs WHERE id = ?',
    );
    const row = stmt.get(runId) as WorkflowRunRow | undefined;
    return row ?? null;
  }
}
