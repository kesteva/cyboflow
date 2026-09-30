/**
 * cyboflow.monitorReap sub-router — the two-step gate in front of every destructive
 * System view action (Prune, Kill tree, Kill all, Reap all stale):
 *
 *   resolve  → the server builds a `ReapManifest` for a selection and stashes it
 *              (in memory, ~60s TTL) under an id IT minted;
 *   execute  → the client hands back ONLY that id (plus an optional branch-delete
 *              choice); the server looks the manifest up and runs exactly its
 *              target list. A fabricated, expired, replayed or drifted id is
 *              rejected with zero destructive effect — never silently re-resolved.
 *
 * Errors: unknown/fabricated/replayed id → NOT_FOUND; expired id or a target set
 * that changed since resolve → CONFLICT with message prefix `MANIFEST_STALE`.
 * Execution survivors / failures are surfaced in the response's `errors` array,
 * derived from the results here so an executor cannot report them as bare success.
 *
 * Deliberately NOT `monitor.ts` (per-run supervisor chat), `system.ts` (the
 * read-only aggregated snapshot) or `worktreeMonitor.ts` (registry/disk queries).
 * All renderer→main traffic goes through tRPC — no `ipcMain.handle`.
 *
 * Pattern: setter-injected provider, mirroring `health.ts`; the concrete provider
 * is services/monitor/monitorReapService.ts, wired at boot in main/src/index.ts.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type {
  ReapExecutionError,
  ReapExecutionResult,
  ReapManifest,
  ReapSelection,
} from '../../reapTypes';

export const MANIFEST_STALE = 'MANIFEST_STALE';

export type MonitorReapResolveResult =
  | { ok: true; manifest: ReapManifest }
  | { ok: false; code: 'not_found' | 'not_prunable'; message: string };

export type MonitorReapExecuteResult =
  | { ok: true; manifest: ReapManifest; alsoDeleteBranch: boolean; results: ReapExecutionResult[] }
  | { ok: false; code: 'not_found' | 'expired' | 'stale' | 'unavailable'; message: string };

export interface MonitorReapProvider {
  resolve(
    projectId: number,
    selection: ReapSelection,
    options: { alsoDeleteBranch?: boolean },
  ): Promise<MonitorReapResolveResult>;
  execute(
    manifestId: string,
    override: { alsoDeleteBranch?: boolean },
  ): Promise<MonitorReapExecuteResult>;
}

let _provider: MonitorReapProvider | null = null;

/** Inject the provider at boot (main/src/index.ts), before tRPC handles requests. */
export function setMonitorReapProvider(provider: MonitorReapProvider | null): void {
  _provider = provider;
}

function requireProvider(): MonitorReapProvider {
  if (!_provider) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'monitorReap is not ready yet' });
  }
  return _provider;
}

const selectionSchema: z.ZodType<ReapSelection> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('row'),
    worktreePaths: z.array(z.string().min(1)).optional(),
    pids: z.array(z.number().int().positive()).optional(),
  }),
  z.object({ kind: z.literal('card'), worktreePath: z.string().min(1) }),
  z.object({
    kind: z.literal('kill-all-of-type'),
    processType: z.enum(['claude-cli', 'codex-cli', 'pi-cli', 'omp-cli', 'shell-pty', 'codex-broker', 'unknown']),
  }),
  z.object({ kind: z.literal('reap-all-stale') }),
]);

/** Survivors and failures, lifted out of the results so they can never read as success. */
function executionErrors(results: readonly ReapExecutionResult[]): ReapExecutionError[] {
  const errors: ReapExecutionError[] = [];
  for (const r of results) {
    if (r.kind === 'survived') {
      errors.push({
        targetId: r.targetId,
        message: `Process(es) survived SIGKILL: ${(r.survivorPids ?? []).join(', ') || 'unknown pids'}`,
        survivorPids: r.survivorPids ?? [],
      });
    } else if (r.kind === 'failed') {
      errors.push({ targetId: r.targetId, message: r.error ?? 'Execution failed' });
    }
  }
  return errors;
}

export const monitorReapRouter = router({
  /** Build + stash a manifest for a prospective destructive action. Performs no destruction. */
  resolve: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int(),
        selection: selectionSchema,
        alsoDeleteBranch: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ manifest: ReapManifest }> => {
      const out = await requireProvider().resolve(input.projectId, input.selection, {
        alsoDeleteBranch: input.alsoDeleteBranch,
      });
      if (!out.ok) {
        throw new TRPCError({
          code: out.code === 'not_found' ? 'NOT_FOUND' : 'BAD_REQUEST',
          message: out.message,
        });
      }
      return { manifest: out.manifest };
    }),

  /** Execute a previously-resolved, unexpired, single-use manifest by id. */
  execute: protectedProcedure
    .input(z.object({ manifestId: z.string().min(1), alsoDeleteBranch: z.boolean().optional() }))
    .mutation(
      async ({
        input,
      }): Promise<{
        manifestId: string;
        alsoDeleteBranch: boolean;
        results: ReapExecutionResult[];
        errors: ReapExecutionError[];
      }> => {
        const out = await requireProvider().execute(input.manifestId, {
          alsoDeleteBranch: input.alsoDeleteBranch,
        });
        if (!out.ok) {
          switch (out.code) {
            case 'not_found':
              throw new TRPCError({ code: 'NOT_FOUND', message: `${MANIFEST_STALE}: ${out.message}` });
            case 'expired':
            case 'stale':
              throw new TRPCError({ code: 'CONFLICT', message: `${MANIFEST_STALE}: ${out.message}` });
            case 'unavailable':
              throw new TRPCError({ code: 'PRECONDITION_FAILED', message: out.message });
          }
        }
        return {
          manifestId: out.manifest.id,
          alsoDeleteBranch: out.alsoDeleteBranch,
          results: out.results,
          errors: executionErrors(out.results),
        };
      },
    ),
});
