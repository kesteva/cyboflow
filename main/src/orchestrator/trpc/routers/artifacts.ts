/**
 * cyboflow.artifacts sub-router.
 *
 * Typed tRPC contract for the renderer's run-artifact surface (center-pane tabs +
 * right-rail Artifacts panel):
 *   - list                : query        -> Artifact[] (a run's deliverables)
 *   - listBySession       : query        -> Artifact[] (a session's deliverables
 *                                            across ALL its runs)
 *   - get                 : query        -> Artifact | null
 *   - commit              : mutation     -> { artifactId } (persist to repo)
 *   - onArtifactChanged   : subscription -> ArtifactChangedEvent (project-scoped)
 *
 * Reads forward to the ArtifactRouter read-union methods (listForRun /
 * listForSession / getById — live DB rows UNION committed on-disk snapshots,
 * IDEA-039); the commit mutation forwards to the same ArtifactRouter chokepoint.
 * Artifact CREATE is owned by the orchestrator auto-mint + the MCP tools, not
 * this router. `projectId` for the read methods is resolved from workflow_runs.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import type { Artifact, ArtifactChangedEvent } from '../../../../../shared/types/artifacts';
import {
  ArtifactRouter,
  ArtifactError,
  artifactChangeEvents,
  artifactProjectChannel,
} from '../../artifactRouter';
import { eventToAsyncIterable } from './events';

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[artifacts.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/**
 * Stable oldest-first ordering for the read-union results (the read-union methods
 * on ArtifactRouter return DB rows + snapshots in scan order, not sorted). Ordered
 * by createdAt ASC then id ASC so the center-pane tab order is deterministic and
 * matches the pre-union `ORDER BY created_at ASC, id ASC`.
 */
function sortArtifactsOldestFirst(artifacts: Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

/** Map an ArtifactError code to a TRPCError so the renderer can branch on it. */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof ArtifactError) {
    const codeMap: Record<ArtifactError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_atype: 'BAD_REQUEST',
      already_committed: 'CONFLICT',
      run_not_found: 'NOT_FOUND',
      wrong_project: 'NOT_FOUND',
      not_verified: 'BAD_REQUEST',
      invalid_payload: 'BAD_REQUEST',
    };
    throw new TRPCError({ code: codeMap[err.code], message: `${err.code}: ${err.message}`, cause: err });
  }
  throw err;
}

export const artifactsRouter = router({
  /**
   * List a run's artifacts as the IDEA-039 read UNION (live DB rows — committed=0
   * AND legacy committed=1 — plus committed snapshots read back from the on-disk
   * commit store, deduped by identity with the DB row winning), optionally
   * filtered by commit state. `committed===undefined` → full union; `true` →
   * committed things only (snapshots + legacy committed=1); `false` → committed=0
   * rows only. Resolves the run's project from workflow_runs; an unknown run → [].
   */
  list: protectedProcedure
    .input(z.object({ runId: z.string().min(1), committed: z.boolean().optional() }))
    .query(async ({ input, ctx }): Promise<Artifact[]> => {
      const db = requireDb(ctx.db, 'list');
      const run = db
        .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
        .get(input.runId) as { projectId: number } | undefined;
      if (!run) return [];
      return sortArtifactsOldestFirst(
        await ArtifactRouter.getInstance().listForRun(run.projectId, input.runId, input.committed),
      );
    }),

  /**
   * List a SESSION's artifacts across ALL its runs (the IDEA-039 read UNION) — the
   * '__quick__' chat sentinel plus any flow runs the session hosted. Backs the
   * session-keyed center-pane tab store (useSessionArtifactsList) so tabs
   * survive the RunCenterPane <-> QuickSessionCenterPane host switch: each host
   * shares the same centerPaneStore session key, but a run-scoped list only
   * sees ITS run's rows, so switching hosts made the other host's artifacts
   * read as "vanished" and get pruned even though their DB rows still exist.
   * Resolves the session's project from its runs; a session with no runs → [].
   */
  listBySession: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<Artifact[]> => {
      const db = requireDb(ctx.db, 'listBySession');
      const run = db
        .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE session_id = ? LIMIT 1')
        .get(input.sessionId) as { projectId: number } | undefined;
      if (!run) return [];
      return sortArtifactsOldestFirst(
        await ArtifactRouter.getInstance().listForSession(run.projectId, input.sessionId),
      );
    }),

  /**
   * Fetch a single artifact by id (null when absent). DB-row first, else the
   * committed snapshot for `(runId, atype)` — both are required to resolve a
   * committed artifact whose DB row was deleted on commit (IDEA-039), so callers
   * that may hit a committed snapshot pass runId + atype.
   */
  get: protectedProcedure
    .input(z.object({ artifactId: z.string().min(1), runId: z.string().min(1).optional(), atype: z.string().min(1).optional() }))
    .query(async ({ input, ctx }): Promise<Artifact | null> => {
      requireDb(ctx.db, 'get');
      return ArtifactRouter.getInstance().getById(input.artifactId, input.runId, input.atype);
    }),

  /**
   * Commit an artifact to the repo (IDEA-039): the ArtifactRouter chokepoint
   * snapshots the artifact's durable content (manifest + on-disk bytes) into the
   * project-root commit store and THEN deletes the DB row (iff the snapshot
   * succeeded), emitting exactly one 'committed' event (never 'deleted').
   * Forwards op='commit' as actor='user'. Re-committing surfaces
   * code:'already_committed' (TRPCError 'CONFLICT'). Commit is IDENTITY-ONLY — no
   * payload override (a commit-time payload edit could strip a byte pointer right
   * before the durability snapshot and lose content; payload edits use `update`).
   */
  commit: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        artifactId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }): Promise<{ artifactId: string }> => {
      try {
        const { artifactId } = await ArtifactRouter.getInstance().apply(input.projectId, {
          op: 'commit',
          artifactId: input.artifactId,
          actor: 'user',
        });
        return { artifactId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * S5 — Accept the run's PASS-verdict screenshots as the golden baseline. Forwards
   * the accept-baseline GIT action through the ArtifactRouter chokepoint (which
   * delegates the fs-copy + git commit to the injected BaselineAcceptor). Returns the
   * baselineKey actually written. Native tRPC (no IPCResponse wrapper); the frontend
   * consumes the inferred return via AppRouter.
   */
  acceptAsBaseline: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        runId: z.string().min(1),
        baselineKey: z.string().min(1),
        fileNames: z.array(z.string().min(1)).min(1),
      }),
    )
    .mutation(async ({ input }): Promise<{ baselineKey: string }> => {
      try {
        return await ArtifactRouter.getInstance().acceptAsBaseline(input.projectId, {
          op: 'accept-baseline',
          runId: input.runId,
          baselineKey: input.baselineKey,
          fileNames: input.fileNames,
          actor: 'user',
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Project-scoped artifact change stream (created / updated / committed / deleted). */
  onArtifactChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<ArtifactChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<ArtifactChangedEvent>(
        artifactChangeEvents,
        artifactProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
