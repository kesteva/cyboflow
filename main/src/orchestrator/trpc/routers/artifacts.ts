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
 * Reads go through ctx.db + ArtifactRouter.shapeRow (the single row->API mapper);
 * the commit mutation forwards to the ArtifactRouter chokepoint. Artifact CREATE
 * is owned by the orchestrator auto-mint + the MCP tools, not this router.
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
  type ArtifactDbRow,
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

/** Map an ArtifactError code to a TRPCError so the renderer can branch on it. */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof ArtifactError) {
    const codeMap: Record<ArtifactError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_atype: 'BAD_REQUEST',
      already_committed: 'CONFLICT',
      run_not_found: 'NOT_FOUND',
      wrong_project: 'NOT_FOUND',
    };
    throw new TRPCError({ code: codeMap[err.code], message: `${err.code}: ${err.message}`, cause: err });
  }
  throw err;
}

export const artifactsRouter = router({
  /** List a run's artifacts (oldest first), optionally filtered by commit state. */
  list: protectedProcedure
    .input(z.object({ runId: z.string().min(1), committed: z.boolean().optional() }))
    .query(async ({ input, ctx }): Promise<Artifact[]> => {
      const db = requireDb(ctx.db, 'list');
      const clauses = ['run_id = ?'];
      const params: unknown[] = [input.runId];
      if (input.committed !== undefined) {
        clauses.push('committed = ?');
        params.push(input.committed ? 1 : 0);
      }
      const rows = db
        .prepare(`SELECT * FROM artifacts WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, id ASC`)
        .all(...params) as ArtifactDbRow[];
      return rows.map((r) => ArtifactRouter.shapeRow(r));
    }),

  /**
   * List a SESSION's artifacts across ALL its runs (oldest first) — the
   * '__quick__' chat sentinel plus any flow runs the session hosted. Backs the
   * session-keyed center-pane tab store (useSessionArtifactsList) so tabs
   * survive the RunCenterPane <-> QuickSessionCenterPane host switch: each host
   * shares the same centerPaneStore session key, but a run-scoped list only
   * sees ITS run's rows, so switching hosts made the other host's artifacts
   * read as "vanished" and get pruned even though their DB rows still exist.
   */
  listBySession: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<Artifact[]> => {
      const db = requireDb(ctx.db, 'listBySession');
      const rows = db
        .prepare(
          `SELECT a.* FROM artifacts a
           JOIN workflow_runs wr ON wr.id = a.run_id
           WHERE wr.session_id = ?
           ORDER BY a.created_at ASC, a.id ASC`,
        )
        .all(input.sessionId) as ArtifactDbRow[];
      return rows.map((r) => ArtifactRouter.shapeRow(r));
    }),

  /** Fetch a single artifact by id (null when absent). */
  get: protectedProcedure
    .input(z.object({ artifactId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<Artifact | null> => {
      const db = requireDb(ctx.db, 'get');
      const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(input.artifactId) as
        | ArtifactDbRow
        | undefined;
      return row ? ArtifactRouter.shapeRow(row) : null;
    }),

  /**
   * Commit an artifact to the repo. Forwards op='commit' as actor='user'.
   * Re-committing surfaces code:'already_committed' (TRPCError 'CONFLICT').
   * (The disk-snapshot persistence is layered on in the lifecycle milestone.)
   */
  commit: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        artifactId: z.string().min(1),
        payloadJson: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ artifactId: string }> => {
      try {
        const { artifactId } = await ArtifactRouter.getInstance().apply(input.projectId, {
          op: 'commit',
          artifactId: input.artifactId,
          actor: 'user',
          ...(input.payloadJson !== undefined ? { payloadJson: input.payloadJson } : {}),
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
