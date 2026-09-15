/**
 * flowDesignBinding — bind a FLOW run's UI prototype to the ideas that run owns,
 * as a durable `approved_designs` row (migration 133, `source='flow'`).
 *
 * WHY THIS EXISTS. Until now "the design was approved" left no durable trace on a
 * Launch/Planner/Ship run: the gate resolved, the run advanced, and the only thing
 * that survived was the `ui-prototype`/`interactive-prototype` ARTIFACT — which
 * hangs off `artifacts.run_id` with `ON DELETE CASCADE` (migration 102), so it
 * disappears with the run. A sprint that builds the ideas weeks later then has
 * nothing to match. Design Mode already solved the durability half for its own
 * pathway: `approved_designs` deliberately carries NO foreign keys (082's header)
 * and its `snapshot_path` points into an app-data-dir tree that no cascade can
 * reach. This module gives the flow pathway the same durable anchor.
 *
 * WHAT IT IS AND IS NOT. The durable value is the SNAPSHOT PATH. It is NOT the
 * idea-component ledger: `resolveIdeaComponents` already derives `prototype:
 * complete` for an idea whose run holds a prototype artifact, so the bind is not
 * what makes the component read complete. The ledger stamp here is therefore
 * NARROW on purpose — it fires only when the idea's OWN body carries a
 * `## Design spec` section, i.e. only when "this idea's screens are designed" is
 * a true statement. A ledger ROW is authoritative over derivation (migration 101,
 * "full stop"), so stamping every approved idea complete off ONE whole-concept
 * Launch mockup would permanently tell every later Planner run that idea #7's UI
 * is designed when the mockup may never show idea #7's screens.
 *
 * PRECEDENCE. A Design Mode approval always outranks a flow prototype: an idea
 * whose CURRENT row is `source='design-mode'` is SKIPPED, never superseded. That
 * is the "arrived with an approved design → leave it alone" rule the planner
 * prompts already state, made durable.
 *
 * IDEMPOTENCE. Re-entry (a gate resolved twice, the settle reconciliation
 * re-running the same bind) is a no-op when the current row already carries this
 * run id AND the same prototype revision. A NEWER prototype revision from the
 * same run DOES rebind — that is a genuine re-approval of different bytes.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3', or
 * any concrete service in main/src/services/*. The DB is the narrow DatabaseLike;
 * the (electron-backed) prototype-byte reader and the snapshot base dir are
 * INJECTED, exactly as designHandoffService.ts takes them. `node:fs`/`node:path`
 * (atomic snapshot write) mirror that module and are allowed.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseLike, LoggerLike } from '../types';
import { extractDesignSpecSection } from '../../../../shared/types/artifacts';
import type { IdeaComponentRouter } from '../ideaComponents/ideaComponentRouter';

/** The prototype-family atypes, in binding preference order (interactive wins). */
const PROTOTYPE_ATYPES = ['interactive-prototype', 'ui-prototype'] as const;
type PrototypeAtype = (typeof PROTOTYPE_ATYPES)[number];

export interface FlowDesignBindingDeps {
  db: DatabaseLike;
  /**
   * Base dir the design snapshots publish under: `<base>/<ideaId>/flow-<runId>.html`.
   * The SAME tree Design Mode writes into (index.ts injects
   * `getCyboflowSubdirectory('design-snapshots')` to both), so one reader serves
   * both pathways.
   */
  snapshotBaseDir: string;
  /**
   * Read the CURRENT canonical prototype HTML bytes for a run — null when absent.
   * Injected so this module never imports the electron-backed path resolvers;
   * identical contract to DesignHandoffDeps.loadPrototypeHtml.
   */
  loadPrototypeHtml: (runId: string, atype: string) => Promise<string | null>;
  /** The idea-component ledger chokepoint (narrowed to the one method used). */
  ideaComponentRouter?: { applyChange: IdeaComponentRouter['applyChange'] };
  logger?: LoggerLike;
  /** Injectable clock (ISO string) for deterministic tests. */
  now?: () => string;
}

export interface BindApprovedDesignsArgs {
  runId: string;
  projectId: number;
  /** The ideas to bind — normally `listRunOwnedIdeaIds(db, runId)`, optionally intersected with a gate's approved refs. */
  ideaIds: readonly string[];
}

/** Why an idea was not bound. Stable strings — logged and asserted in tests. */
export type BindSkipReason =
  /** The run holds no ui-prototype / interactive-prototype artifact. */
  | 'no-prototype-artifact'
  /** The prototype artifact's canonical HTML could not be read (transient). */
  | 'no-prototype-bytes'
  /** The idea's current approved design came from Design Mode — it outranks this. */
  | 'design-mode-current'
  /** Already bound by THIS run at THIS prototype revision. */
  | 'already-bound'
  /** The idea row is gone (deleted mid-run) or belongs to another project. */
  | 'unknown-idea'
  /** The snapshot write or the publish transaction failed — nothing was recorded. */
  | 'bind-failed';

export interface BindApprovedDesignsResult {
  /** Idea ids that now carry a current `source='flow'` approved design. */
  bound: string[];
  skipped: Array<{ ideaId: string; reason: BindSkipReason }>;
}

interface PrototypeArtifactRow {
  id: string;
  atype: string;
  revision: number;
}

interface IdeaRow {
  project_id: number;
  version: number;
  body: string | null;
}

interface CurrentDesignRow {
  id: string;
  source: string;
  source_run_id: string | null;
  prototype_revision: number;
}

function nowOf(deps: FlowDesignBindingDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

/**
 * The run's prototype artifact to bind, or null when it holds none.
 *
 * Selection mirrors the design-mode freshness read (trpc/routers/design.ts
 * `draftStatus`) and `ideaArtifacts.resolveComponentArtifact`: prefer a
 * payload-bearing row over a bytes-less re-entry stub, then the interactive tier
 * over the static one, then the highest revision. Keeping the three in agreement
 * is what stops "which prototype is current" from having two answers.
 */
export function selectRunPrototypeArtifact(
  db: DatabaseLike,
  runId: string,
): { id: string; atype: PrototypeAtype; revision: number } | null {
  let row: PrototypeArtifactRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT id, atype, revision FROM artifacts
          WHERE run_id = ? AND atype IN ('ui-prototype', 'interactive-prototype')
          ORDER BY (payload_json IS NOT NULL) DESC, (atype = 'interactive-prototype') DESC,
                   revision DESC, created_at DESC LIMIT 1`,
      )
      .get(runId) as PrototypeArtifactRow | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  const atype = PROTOTYPE_ATYPES.find((a) => a === row.atype);
  if (atype === undefined) return null;
  return { id: row.id, atype, revision: row.revision };
}

/** The idea's CURRENT approved design row (superseded_at IS NULL), or null. */
function currentDesignRow(db: DatabaseLike, ideaId: string): CurrentDesignRow | null {
  const row = db
    .prepare(
      `SELECT id, source, source_run_id, prototype_revision
         FROM approved_designs WHERE idea_id = ? AND superseded_at IS NULL LIMIT 1`,
    )
    .get(ideaId) as CurrentDesignRow | undefined;
  return row ?? null;
}

/**
 * Bind the run's prototype to each named idea as a durable flow-sourced approved
 * design. Never throws: every per-idea failure lands in `skipped` and the rest of
 * the batch still binds. A run with no prototype artifact skips EVERY idea with
 * 'no-prototype-artifact' and writes nothing at all (in particular, no ledger row
 * — the absence of a prototype is not a fact about the idea's design state).
 */
export async function bindApprovedDesignsForRun(
  deps: FlowDesignBindingDeps,
  args: BindApprovedDesignsArgs,
): Promise<BindApprovedDesignsResult> {
  const { db } = deps;
  const { runId, projectId } = args;
  const result: BindApprovedDesignsResult = { bound: [], skipped: [] };
  const ideaIds = [...new Set(args.ideaIds)].filter((id) => typeof id === 'string' && id.length > 0);
  if (ideaIds.length === 0) return result;

  const artifact = selectRunPrototypeArtifact(db, runId);
  if (!artifact) {
    for (const ideaId of ideaIds) result.skipped.push({ ideaId, reason: 'no-prototype-artifact' });
    return result;
  }

  // Read the bytes ONCE for the whole batch — every idea in a Launch approve-ideas
  // batch binds the SAME whole-concept mockup, so re-reading per idea would be N
  // identical disk reads for one payload.
  let html: string | null = null;
  try {
    html = await deps.loadPrototypeHtml(runId, artifact.atype);
  } catch (err) {
    deps.logger?.warn('[flowDesignBinding] prototype read threw (binding nothing)', {
      runId,
      atype: artifact.atype,
      error: err instanceof Error ? err.message : String(err),
    });
    html = null;
  }
  if (html === null) {
    for (const ideaId of ideaIds) result.skipped.push({ ideaId, reason: 'no-prototype-bytes' });
    return result;
  }

  // Ledger stamps are deferred until AFTER every bind commits: the router is an
  // async per-project queue, and a stamp failure must never roll an approval back
  // (designHandoffService.stampPrototypeComplete makes the same argument).
  const toStamp: Array<{ ideaId: string; version: number }> = [];

  for (const ideaId of ideaIds) {
    const idea = db
      .prepare('SELECT project_id, version, body FROM ideas WHERE id = ?')
      .get(ideaId) as IdeaRow | undefined;
    if (!idea || idea.project_id !== projectId) {
      result.skipped.push({ ideaId, reason: 'unknown-idea' });
      continue;
    }

    const current = currentDesignRow(db, ideaId);
    if (current && current.source === 'design-mode') {
      result.skipped.push({ ideaId, reason: 'design-mode-current' });
      continue;
    }
    if (
      current &&
      current.source_run_id === runId &&
      current.prototype_revision === artifact.revision
    ) {
      result.skipped.push({ ideaId, reason: 'already-bound' });
      continue;
    }

    let snapshotPath: string;
    try {
      snapshotPath = await publishFlowSnapshot(deps, { ideaId, runId, html });
    } catch (err) {
      deps.logger?.warn('[flowDesignBinding] snapshot write failed (idea not bound)', {
        runId,
        ideaId,
        error: err instanceof Error ? err.message : String(err),
      });
      result.skipped.push({ ideaId, reason: 'bind-failed' });
      continue;
    }

    try {
      publishFlowApprovedDesign(deps, {
        ideaId,
        projectId,
        runId,
        artifactId: artifact.id,
        prototypeRevision: artifact.revision,
        snapshotPath,
        now: nowOf(deps),
      });
    } catch (err) {
      deps.logger?.warn('[flowDesignBinding] approved-design publish failed (idea not bound)', {
        runId,
        ideaId,
        error: err instanceof Error ? err.message : String(err),
      });
      result.skipped.push({ ideaId, reason: 'bind-failed' });
      continue;
    }

    result.bound.push(ideaId);
    // NARROW ledger stamp — see the module header. Only an idea carrying its OWN
    // '## Design spec' section can honestly claim `prototype: complete`; a
    // whole-concept mockup bound to eight ideas must not declare idea #7's
    // screens designed. Derivation still answers for the rest, which is the
    // truthful 'incomplete'.
    if (extractDesignSpecSection(idea.body) !== null) {
      toStamp.push({ ideaId, version: idea.version });
    }
  }

  for (const { ideaId, version } of toStamp) {
    await stampPrototypeComplete(deps, { projectId, ideaId, runId, version });
  }

  return result;
}

/**
 * Write `<snapshotBaseDir>/<ideaId>/flow-<runId>.html` atomically (temp + rename),
 * mirroring designHandoffService's `runSnapshotStep`. Distinct filename shape from
 * Design Mode's `<handoffId>.html` so the two pathways can never collide in the
 * same idea directory, and stable per (idea, run) so a re-bind of a newer
 * prototype revision overwrites in place rather than littering the tree.
 */
async function publishFlowSnapshot(
  deps: FlowDesignBindingDeps,
  args: { ideaId: string; runId: string; html: string },
): Promise<string> {
  const ideaDir = path.join(deps.snapshotBaseDir, args.ideaId);
  await fs.mkdir(ideaDir, { recursive: true });
  const snapshotPath = path.join(ideaDir, `flow-${args.runId}.html`);
  const tmp = path.join(ideaDir, `.tmp-flow-${args.runId}-${randomBytes(6).toString('hex')}.html`);
  await fs.writeFile(tmp, args.html, 'utf-8');
  await fs.rename(tmp, snapshotPath);
  return snapshotPath;
}

/**
 * Supersede the prior current row and insert the new flow-sourced one in ONE
 * transaction, so there is always exactly one `superseded_at IS NULL` row per idea
 * (the invariant migration 133's partial unique index now enforces). Mirrors
 * designHandoffService's `runPublishStep` Step 3.
 */
function publishFlowApprovedDesign(
  deps: FlowDesignBindingDeps,
  args: {
    ideaId: string;
    projectId: number;
    runId: string;
    artifactId: string;
    prototypeRevision: number;
    snapshotPath: string;
    now: string;
  },
): void {
  const { db } = deps;
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE approved_designs SET superseded_at = ?
        WHERE idea_id = ? AND superseded_at IS NULL`,
    ).run(args.now, args.ideaId);
    db.prepare(
      `INSERT INTO approved_designs
         (id, idea_id, project_id, handoff_id, session_id, draft_revision,
          prototype_artifact_id, prototype_revision, snapshot_path, approved_at,
          superseded_at, source, source_run_id)
       VALUES (?, ?, ?, NULL, NULL, 0, ?, ?, ?, ?, NULL, 'flow', ?)`,
    ).run(
      `apd_${randomBytes(10).toString('hex')}`,
      args.ideaId,
      args.projectId,
      args.artifactId,
      args.prototypeRevision,
      args.snapshotPath,
      args.now,
      args.runId,
    );
  });
  (txn as () => void)();
}

/**
 * Best-effort `prototype: complete` ledger stamp — the flow sibling of
 * designHandoffService's `stampPrototypeComplete`, with the same fail-soft
 * contract: a ledger write failure must never undo an approval whose
 * `approved_designs` row already committed.
 */
async function stampPrototypeComplete(
  deps: FlowDesignBindingDeps,
  args: { projectId: number; ideaId: string; runId: string; version: number },
): Promise<void> {
  if (!deps.ideaComponentRouter) return;
  try {
    await deps.ideaComponentRouter.applyChange(args.projectId, {
      op: 'set-component-state',
      ideaId: args.ideaId,
      component: 'prototype',
      state: 'complete',
      source: 'flow',
      sourceRunId: args.runId,
      builtAgainstVersion: args.version,
    });
  } catch (err) {
    deps.logger?.warn('[flowDesignBinding] idea-component ledger stamp failed (bind already committed)', {
      runId: args.runId,
      ideaId: args.ideaId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
