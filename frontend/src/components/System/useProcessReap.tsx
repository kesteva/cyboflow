/**
 * useProcessReap — the process-side destructive actions of the System view, wired to
 * the `monitorReap` manifest contract: resolve → confirm → execute.
 *
 *   Kill tree (row, both groupings)  → `row` selection → KillProcessConfirmDialog
 *   Kill all processes (worktree card) → `row` selection of the card's pids
 *   Kill all (N) (process type)        → `kill-all-of-type` selection
 *   Reap all stale (toolbar, process half) → `row` selection of every orphan-bucket
 *                                         pid, in ONE manifest / dialog / execute
 *                                         (the worktree half is useWorktreeReap)
 *
 * The dialog renders the manifest `monitorReap.resolve` returned, and confirming
 * executes THAT manifest by its server-minted id — the client never fabricates a
 * target list. Failures (rejected execute, a stale manifest, a survivor PID) surface
 * as per-target errors in the returned `overlay`; nothing is swallowed.
 *
 * These manifests hold processes only, so no branch-delete choice is offered.
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { KillProcessConfirmDialog } from './KillProcessConfirmDialog';
import { ManifestConfirmDialog } from './ManifestConfirmDialog';
import type { SystemActionableProcess, SystemActionHandlers } from './SystemGroupedBody';
import { toManifestConfirmData, type ReapManifestData } from './reapManifestAdapter';
import { chooseKillDialog, summarizeExecution, type ReapFailure } from './processReapOutcome';

type Selection = Parameters<typeof trpc.cyboflow.monitorReap.resolve.mutate>[0]['selection'];

interface PendingReap {
  manifest: ReapManifestData;
  title: string;
  scope: 'single' | 'batch';
  /** `kill` may open the harder untagged-process dialog; `reap` (reap-all-stale) never does. */
  mode: 'kill' | 'reap';
  /** The action's own label for the confirm button ("Kill tree", "Kill all", "Reap all stale"). */
  confirmText: string;
}

interface ReapFeedback {
  /** Set when the action as a whole failed (resolve/execute rejected, stale manifest). */
  error: string | null;
  failures: ReapFailure[];
  /** Success summary; only when nothing failed. */
  summary: string | null;
}

export interface UseProcessReapResult {
  /** Wire onto `SystemGroupedBody` (`onKillTree` / `onKillAll`). */
  handlers: Required<Pick<SystemActionHandlers, 'onKillTree' | 'onKillAll'>>;
  /** Toolbar "Reap all stale", process half: one manifest of every listed orphan process. */
  reapAllStale: (orphans: readonly SystemActionableProcess[]) => void;
  /** True while a resolve or execute call is in flight. */
  busy: boolean;
  /** Confirm dialogs plus the visible per-target error / result strip. Render once. */
  overlay: ReactElement;
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.includes('MANIFEST_STALE')
    ? 'The targets changed since they were resolved — nothing was killed. Review the current list and try again.'
    : raw;
}

export function useProcessReap(args: {
  projectId: number | null;
  /** Called after an execute settles (success or not) so the snapshot refreshes. */
  onSettled?: () => void;
}): UseProcessReapResult {
  const { projectId, onSettled } = args;
  const [pending, setPending] = useState<PendingReap | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<ReapFeedback | null>(null);

  const resolve = useCallback(
    async (selection: Selection, meta: Omit<PendingReap, 'manifest'>): Promise<void> => {
      if (projectId === null) return;
      setFeedback(null);
      setBusy(true);
      try {
        const { manifest } = await trpc.cyboflow.monitorReap.resolve.mutate({ projectId, selection });
        if (manifest.targets.length === 0) {
          setFeedback({ error: null, failures: [], summary: 'Nothing to reap — no matching targets.' });
          return;
        }
        setPending({ ...meta, manifest });
      } catch (err) {
        setFeedback({ error: `Could not prepare ${meta.title.toLowerCase()}: ${messageOf(err)}`, failures: [], summary: null });
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const onKillTree = useCallback(
    (process: SystemActionableProcess): void => {
      void resolve(
        { kind: 'row', pids: [process.pid] },
        { title: 'Kill process tree', scope: 'single', mode: 'kill', confirmText: 'Kill tree' },
      );
    },
    [resolve],
  );

  const onKillAll = useCallback(
    (processes: SystemActionableProcess[], scope: { kind: 'worktree' | 'type'; label: string }): void => {
      if (processes.length === 0) return;
      const title = `Kill all ${scope.label} processes`;
      const meta = { title, scope: 'batch' as const, mode: 'kill' as const, confirmText: 'Kill all' };
      const type = processes[0].processType;
      if (scope.kind === 'type' && processes.every((p) => p.processType === type)) {
        void resolve({ kind: 'kill-all-of-type', processType: type }, meta);
      } else {
        void resolve({ kind: 'row', pids: processes.map((p) => p.pid) }, meta);
      }
    },
    [resolve],
  );

  const reapAllStale = useCallback(
    (orphans: readonly SystemActionableProcess[]): void => {
      const pids = orphans.filter((p) => p.bucket === 'orphan').map((p) => p.pid);
      if (pids.length === 0) return;
      void resolve(
        { kind: 'row', pids },
        { title: 'Reap stale processes', scope: 'batch', mode: 'reap', confirmText: 'Reap all stale' },
      );
    },
    [resolve],
  );

  const cancel = useCallback((): void => setPending(null), []);

  const confirm = useCallback(async (): Promise<void> => {
    if (pending === null) return;
    const { manifest } = pending;
    setPending(null);
    setBusy(true);
    setFeedback(null);
    try {
      // Execute the manifest the dialog rendered, by its server-minted id.
      const response = await trpc.cyboflow.monitorReap.execute.mutate({ manifestId: manifest.id });
      const outcome = summarizeExecution(manifest, response);
      const done = outcome.killed + outcome.pruned;
      setFeedback({
        error: null,
        failures: outcome.failures,
        summary:
          outcome.failures.length === 0
            ? `Reaped ${done} target${done === 1 ? '' : 's'}${outcome.skipped > 0 ? ` (${outcome.skipped} already gone)` : ''}.`
            : null,
      });
    } catch (err) {
      setFeedback({ error: messageOf(err), failures: [], summary: null });
    } finally {
      setBusy(false);
      onSettled?.();
    }
  }, [pending, onSettled]);

  let dialog: ReactElement | null = null;
  if (pending !== null) {
    const base = toManifestConfirmData(pending.manifest);
    // A manifest with no worktree target frees no disk: state nothing rather than "0 B".
    const hasWorktree = pending.manifest.targets.some((t) => t.kind === 'worktree');
    const data = hasWorktree ? base : { ...base, reclaimableBytes: null };
    const choice = chooseKillDialog(pending.manifest, pending.scope);
    const common = { isOpen: true, manifest: data, title: pending.title, onCancel: cancel };
    if (pending.mode === 'kill' && choice.dialog === 'kill-process') {
      dialog = (
        <KillProcessConfirmDialog
          {...common}
          confirmText={pending.confirmText}
          onConfirm={() => void confirm()}
        />
      );
    } else {
      dialog = (
        <ManifestConfirmDialog
          {...common}
          confirmText={pending.confirmText}
          showDeleteBranch={false}
          banners={
            choice.mixedUntagged > 0 ? (
              <div
                role="alert"
                data-testid="untagged-batch-note"
                className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm text-text-primary"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-status-warning" />
                <span>
                  {choice.mixedUntagged} of these processes {choice.mixedUntagged === 1 ? 'is' : 'are'} not tagged as
                  cyboflow's.
                </span>
              </div>
            ) : undefined
          }
          onConfirm={() => void confirm()}
        />
      );
    }
  }

  const overlay = (
    <>
      {dialog}
      {feedback !== null && (feedback.error !== null || feedback.failures.length > 0) && (
        <div
          role="alert"
          data-testid="reap-errors"
          className="border-b border-border-primary bg-status-error/10 px-7 py-3 text-xs text-status-error"
        >
          {feedback.error !== null && <div data-testid="reap-error">{feedback.error}</div>}
          {feedback.failures.length > 0 && (
            <>
              <div className="font-bold">Some targets were not reaped:</div>
              <ul className="mt-1 space-y-0.5">
                {feedback.failures.map((f) => (
                  <li key={f.targetId} data-testid={`reap-error-${f.targetId}`}>
                    <span className="font-medium">{f.label}</span> — {f.message}
                    {f.survivorPids.length > 0 && (
                      <span data-testid={`reap-survivors-${f.targetId}`}> · survivor pid{f.survivorPids.length === 1 ? '' : 's'} {f.survivorPids.join(', ')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {feedback?.summary != null && (
        <div
          role="status"
          data-testid="reap-summary"
          className="flex items-center gap-2 border-b border-border-primary bg-bg-secondary px-7 py-2 text-xs text-text-secondary"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-status-success" aria-hidden="true" />
          {feedback.summary}
        </div>
      )}
    </>
  );

  return { handlers: { onKillTree, onKillAll }, reapAllStale, busy, overlay };
}
