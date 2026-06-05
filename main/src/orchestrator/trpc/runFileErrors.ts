/**
 * Shared RunFileError -> TRPCError mapping for the File Explorer tRPC routes.
 *
 * Both the canonical session-keyed router (trpc/routers/files.ts) and the
 * preserved legacy run-keyed routes (trpc/routers/runs.ts) re-throw a
 * RunFileError as a TRPCError with a stable code. This module is the SINGLE
 * source of truth for that mapping so the two routers cannot drift.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. TRPCError from '@trpc/server' is allowed in the
 * trpc/* subtree (the routers already import it).
 */
import { TRPCError } from '@trpc/server';
import { RunFileError } from '../runFileExplorer';
import type { RunFileErrorReason } from '../runFileExplorer';

/**
 * Map a RunFileError reason to the appropriate tRPC error code. The
 * handler's message is preserved by the caller so the File Explorer rail can show
 * why a read failed (e.g. "Session has no worktree" vs a path-traversal
 * rejection).
 */
export function runFileErrorCode(reason: RunFileErrorReason): TRPCError['code'] {
  // Exhaustive by construction — every RunFileErrorReason must map to a code, so
  // adding a new reason without a mapping is a compile error here. This is the
  // single source of truth for the mapping now (moved out of runs.ts).
  const codeByReason: Record<RunFileErrorReason, TRPCError['code']> = {
    'run-not-found': 'NOT_FOUND',
    'session-not-found': 'NOT_FOUND',
    'not-found': 'NOT_FOUND',
    'no-worktree': 'PRECONDITION_FAILED',
    'worktree-missing': 'PRECONDITION_FAILED',
    'invalid-path': 'BAD_REQUEST',
    'not-a-directory': 'BAD_REQUEST',
    'not-a-file': 'BAD_REQUEST',
  };
  return codeByReason[reason];
}

/**
 * Run an async File Explorer handler and re-throw RunFileError as a TRPCError
 * with a mapped code. Non-RunFileError failures (unexpected fs errors) bubble as
 * INTERNAL_SERVER_ERROR via tRPC's default handling.
 */
export async function withRunFileErrorMapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RunFileError) {
      throw new TRPCError({ code: runFileErrorCode(err.reason), message: err.message });
    }
    throw err;
  }
}
