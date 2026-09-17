/**
 * cyboflow.design sub-router — the design-session Approve action + the Approve
 * button's freshness read (design-mode.md "Approve — intent-first recoverable
 * state machine" + "Design-spec draft") + the reopen-in-design-mode idea
 * resolver (IDEA-013 "make any prototype reopenable").
 *
 *   approve          : mutation -> DesignApproveResult (drives the Approve state machine)
 *   draftStatus      : query    -> DesignDraftStatus | null (draft vs prototype freshness)
 *   resolveReopenIdea: query    -> { ideaId: string } | null (see reopenIdeaResolver.ts)
 *   forEntity        : query    -> ApprovedDesignForEntity | null (the approved design
 *                                  reachable from ANY backlog entity — idea, epic, task)
 *   snapshotHtml     : query    -> ApprovedDesignSnapshot | null (the snapshot bytes)
 *
 * The last two are the READ side of approved designs, which had no renderer surface
 * at all before: `approved_designs` was consumed only by `cyboflow_get_task` (for
 * agents) and by Design Mode's own approve flow, so a builder looking at a task card
 * had no path to the design that task is supposed to match. They live on THIS router
 * rather than a second one because a `cyboflow.designs` alongside `cyboflow.design`,
 * differing by one character and both about approved designs, is a durable trap.
 *
 * `approve` forwards to the boot-configured DesignHandoffService singleton (which
 * holds the electron-backed prototype reader + snapshot dir); business failures
 * come back as `{ ok: false, code }` on the discriminated result (NOT thrown), so
 * the renderer can branch on the exact reason. `draftStatus` reads the session's
 * latest draft, the current prototype artifact on its chat run, and the linked
 * idea's version/title in one call — everything the Approve button + freshness
 * indicator need. `resolveReopenIdea` is the renderer's ONLY way to resolve which
 * idea a sourceRef-less prototype belongs to (the renderer has no DB access) —
 * see reopenIdeaResolver.ts for the ownership + ambiguity policy.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * main/src/services/* (DesignHandoffService is orchestrator-local + standalone).
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import {
  DesignHandoffService,
  type DesignApproveResult,
} from '../../design/designHandoffService';
import { resolveReopenIdeaId } from '../../design/reopenIdeaResolver';
import {
  getCurrentApprovedDesign,
  type ApprovedDesignSource,
} from '../../design/approvedDesigns';

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[design.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/**
 * Everything the Approve button + freshness indicator need in one call. Null is
 * returned (from the procedure) when the session has no draft yet.
 */
export interface DesignDraftStatus {
  /** The latest design-spec draft revision for the session. */
  latestDraftRevision: number;
  /** The prototype revision that draft is bound to (null before any prototype). */
  boundArtifactRevision: number | null;
  /** The current prototype artifact revision on the session's chat run (null when none). */
  currentPrototypeRevision: number | null;
  /** The current prototype artifact id (null when the session has no prototype yet). */
  prototypeArtifactId: string | null;
  /** The linked idea's current version (Approve's expectedIdeaVersion), null when link broken. */
  ideaVersion: number | null;
  /** The linked idea's title, null when the link is broken. */
  ideaTitle: string | null;
  /** The linked idea's id, null when the link is broken (post-approve planner seed). */
  ideaId: string | null;
  /** True when the idea is missing / decomposed / cross-project (fail-soft relink state). */
  linkBroken: boolean;
}

interface SessionStatusRow {
  design_idea_id: string | null;
  project_id: number | null;
  chat_run_id: string | null;
}

interface DraftStatusRow {
  draft_revision: number;
  bound_artifact_revision: number | null;
}

interface PrototypeStatusRow {
  id: string;
  revision: number;
}

interface IdeaStatusRow {
  version: number;
  title: string;
  decomposed_at: string | null;
  project_id: number;
}

/**
 * What the renderer needs to offer (and label) a "Design" affordance on a task,
 * epic, or idea card. Null from the procedure means "this entity has no approved
 * design" — the affordance hides entirely rather than opening an empty tab.
 */
export interface ApprovedDesignForEntity {
  /** The idea the design belongs to (the entity's own, or its ancestor's). */
  ideaId: string;
  /** That idea's display ref, for the tab header. */
  ideaRef: string;
  ideaTitle: string;
  approvedAt: string;
  /** 'design-mode' = hand-refined in Design Mode; 'flow' = a run's approved prototype. */
  source: ApprovedDesignSource;
  /** The run that bound a flow-sourced design; null for design-mode. */
  sourceRunId: string | null;
}

/** The snapshot bytes behind an approved design, for the read-only viewer tab. */
export interface ApprovedDesignSnapshot {
  html: string;
  approvedAt: string;
}

/**
 * Cap on the snapshot bytes served to the renderer in one tRPC response.
 *
 * A design snapshot is a self-contained static page, so 4 MB is far above any
 * real prototype while still bounding what a corrupt or hand-edited file can push
 * through the IPC channel in one message.
 */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

interface EntityLineageRow {
  originating_idea_id: string | null;
  parent_epic_id?: string | null;
}

interface IdeaHeaderRow {
  id: string;
  ref: string;
  title: string;
}

/**
 * Resolve the idea an arbitrary backlog entity's design belongs to.
 *
 * The lineage, most direct first (mirrors the parent/originating chain
 * taskChangeRouter validates on every re-parent):
 *   - an IDEA is its own answer;
 *   - an EPIC points at its `originating_idea_id`;
 *   - a TASK carries `originating_idea_id` directly when it was minted straight
 *     under an idea, and otherwise reaches it through `parent_epic_id` → that
 *     epic's `originating_idea_id`.
 * Null when the entity is unknown or its lineage is broken — a card with no
 * resolvable idea simply shows no Design affordance.
 */
function resolveIdeaForEntity(db: DatabaseLike, entityId: string): IdeaHeaderRow | null {
  const readIdea = (ideaId: string | null): IdeaHeaderRow | null => {
    if (ideaId === null || ideaId.length === 0) return null;
    const row = db.prepare('SELECT id, ref, title FROM ideas WHERE id = ?').get(ideaId) as
      | IdeaHeaderRow
      | undefined;
    return row ?? null;
  };

  const own = readIdea(entityId);
  if (own) return own;

  const epic = db
    .prepare('SELECT originating_idea_id FROM epics WHERE id = ?')
    .get(entityId) as EntityLineageRow | undefined;
  if (epic) return readIdea(epic.originating_idea_id);

  const task = db
    .prepare('SELECT originating_idea_id, parent_epic_id FROM tasks WHERE id = ?')
    .get(entityId) as EntityLineageRow | undefined;
  if (!task) return null;
  const direct = readIdea(task.originating_idea_id);
  if (direct) return direct;
  if (typeof task.parent_epic_id !== 'string' || task.parent_epic_id.length === 0) return null;
  const parent = db
    .prepare('SELECT originating_idea_id FROM epics WHERE id = ?')
    .get(task.parent_epic_id) as EntityLineageRow | undefined;
  return parent ? readIdea(parent.originating_idea_id) : null;
}

/**
 * The design-snapshot tree, read off the boot-configured DesignHandoffService.
 *
 * Both writers publish into it — Design Mode's Approve and the flow binder — so
 * one containment root covers both. Reached through the service rather than
 * re-derived here because this module may not call the electron-backed
 * `getCyboflowSubdirectory` (standalone-typecheck invariant), and duplicating the
 * subdirectory name would let the two drift into a check that never matches.
 */
function snapshotBaseDir(): string {
  return DesignHandoffService.getInstance().depsBag.snapshotBaseDir;
}

export const designRouter = router({
  /**
   * Approve a design session's named draft revision — the host-owned, recoverable
   * Approve state machine. Returns the discriminated result; a business failure is
   * an `{ ok: false, code }` value, not a thrown error.
   */
  approve: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        draftRevision: z.number().int().positive(),
        expectedIdeaVersion: z.number().int().nonnegative(),
      }),
    )
    .mutation(async ({ input }): Promise<DesignApproveResult> => {
      return DesignHandoffService.getInstance().approve({
        sessionId: input.sessionId,
        draftRevision: input.draftRevision,
        expectedIdeaVersion: input.expectedIdeaVersion,
      });
    }),

  /**
   * Draft-vs-prototype freshness for the Approve button. Null when the session has
   * no draft yet. Resolves the current prototype via the session's chat_run_id +
   * the prototype family ('ui-prototype' | 'interactive-prototype'), preferring
   * a payload-bearing row over the bytes-less re-entry stub — the SAME selection
   * rule the draft-binding write uses (mcpQueryHandler.handleDesignUpdateDraft),
   * so freshness and binding can never disagree about WHICH prototype is current.
   * `linkBroken` mirrors the idea-link integrity contract.
   */
  draftStatus: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<DesignDraftStatus | null> => {
      const db = requireDb(ctx.db, 'draftStatus');

      const session = db
        .prepare('SELECT design_idea_id, project_id, chat_run_id FROM sessions WHERE id = ?')
        .get(input.sessionId) as SessionStatusRow | undefined;
      if (!session) return null;

      const draft = db
        .prepare(
          `SELECT draft_revision, bound_artifact_revision FROM design_spec_drafts
            WHERE session_id = ? ORDER BY draft_revision DESC LIMIT 1`,
        )
        .get(input.sessionId) as DraftStatusRow | undefined;
      if (!draft) return null;

      // The current prototype on the session's chat run — THE prototype-family
      // selection rule (payload-bearing, then interactive tier, then revision;
      // rationale at the draft-binding site in mcpQueryHandler); mirrored in
      // pickPrototype (DesignModeSurface). Change all three together.
      let prototype: PrototypeStatusRow | undefined;
      if (session.chat_run_id) {
        prototype = db
          .prepare(
            `SELECT id, revision FROM artifacts
              WHERE run_id = ? AND atype IN ('ui-prototype', 'interactive-prototype')
              ORDER BY (payload_json IS NOT NULL) DESC, (atype = 'interactive-prototype') DESC,
                       revision DESC, created_at DESC LIMIT 1`,
          )
          .get(session.chat_run_id) as PrototypeStatusRow | undefined;
      }

      let ideaVersion: number | null = null;
      let ideaTitle: string | null = null;
      let ideaId: string | null = null;
      let linkBroken = true;
      if (session.design_idea_id) {
        const idea = db
          .prepare('SELECT version, title, decomposed_at, project_id FROM ideas WHERE id = ?')
          .get(session.design_idea_id) as IdeaStatusRow | undefined;
        if (
          idea &&
          idea.decomposed_at === null &&
          (session.project_id == null || idea.project_id === session.project_id)
        ) {
          ideaVersion = idea.version;
          ideaTitle = idea.title;
          ideaId = session.design_idea_id;
          linkBroken = false;
        }
      }

      return {
        latestDraftRevision: draft.draft_revision,
        boundArtifactRevision: draft.bound_artifact_revision ?? null,
        currentPrototypeRevision: prototype?.revision ?? null,
        prototypeArtifactId: prototype?.id ?? null,
        ideaVersion,
        ideaTitle,
        ideaId,
        linkBroken,
      };
    }),

  /**
   * Resolves which idea a sourceRef-less prototype artifact belongs to, from
   * the run that produced it (ArtifactTabRenderer's "reopen in design mode"
   * CTA on a planner/sprint-produced ui-prototype/interactive-prototype —
   * IDEA-013). Returns null when zero or more-than-one idea resolves for the
   * run — see reopenIdeaResolver.ts for the ownership + ambiguity policy.
   */
  resolveReopenIdea: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<{ ideaId: string } | null> => {
      const db = requireDb(ctx.db, 'resolveReopenIdea');
      const ideaId = resolveReopenIdeaId(db, input.runId);
      return ideaId !== null ? { ideaId } : null;
    }),

  /**
   * The approved design (if any) reachable from ANY backlog entity — idea, epic,
   * or task — so a card anywhere in the backlog can offer to open it.
   *
   * This is what makes an approved design reachable from where the work happens.
   * Until now `approved_designs` was read only by `cyboflow_get_task` (for
   * agents) and by Design Mode's own approve flow; nothing in the renderer could
   * see it at all, so a builder looking at a task had no path to the design that
   * task is supposed to match.
   *
   * Null when the entity has no resolvable idea, or that idea has no current
   * approved design. The renderer HIDES the affordance on null rather than
   * showing a disabled one — there is nothing to explain.
   */
  forEntity: protectedProcedure
    .input(z.object({ entityId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<ApprovedDesignForEntity | null> => {
      const db = requireDb(ctx.db, 'forEntity');
      const idea = resolveIdeaForEntity(db, input.entityId);
      if (!idea) return null;
      const design = getCurrentApprovedDesign(db, idea.id);
      if (!design) return null;
      return {
        ideaId: idea.id,
        ideaRef: idea.ref,
        ideaTitle: idea.title,
        approvedAt: design.approvedAt,
        source: design.source,
        sourceRunId: design.sourceRunId,
      };
    }),

  /**
   * The snapshot HTML behind an idea's current approved design, for the read-only
   * viewer tab. Null when the idea has no approved design, the file is gone, or
   * it is too large to serve.
   *
   * PATH CONTAINMENT. `snapshot_path` is host-written on every path that exists
   * today (Approve's snapshot step and the flow binder both compose it from the
   * injected base dir), never agent-supplied — but this procedure hands raw file
   * bytes to the renderer off a DB column, which is exactly the shape that turns
   * one future writer's mistake into an arbitrary-file-read. The resolved path
   * must sit under the snapshot tree or this returns null, and the check is on
   * `path.resolve` output with a trailing separator so a sibling directory whose
   * name merely starts with the base cannot pass.
   */
  snapshotHtml: protectedProcedure
    .input(z.object({ ideaId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<ApprovedDesignSnapshot | null> => {
      const db = requireDb(ctx.db, 'snapshotHtml');
      const design = getCurrentApprovedDesign(db, input.ideaId);
      if (!design) return null;

      const resolved = path.resolve(design.snapshotPath);
      const base = path.resolve(snapshotBaseDir());
      if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;

      try {
        const stat = await fsp.stat(resolved);
        if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null;
        return { html: await fsp.readFile(resolved, 'utf-8'), approvedAt: design.approvedAt };
      } catch {
        // A missing or unreadable snapshot is a null design, not an error: the
        // approval row outlives the run, and the file could have been pruned.
        return null;
      }
    }),
});
