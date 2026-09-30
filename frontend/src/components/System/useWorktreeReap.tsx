/**
 * useWorktreeReap — the System view's worktree destructive actions
 * (per-card / ⋯-menu "Prune worktree" and toolbar "Reap all stale"), each running the same three steps against the
 * `cyboflow.monitorReap` contract:
 *
 *   resolve → the SERVER builds + stashes a manifest for the selection;
 *   confirm → `ManifestConfirmDialog` renders that manifest verbatim;
 *   execute → the client hands back ONLY the manifest id it was shown.
 *
 * The branch-delete choice is locked into the manifest at resolve time and
 * execute cannot override it. So when the user ticks "Also delete branch" in the
 * dialog, the selection is re-resolved with `alsoDeleteBranch: true` and the NEW
 * manifest is shown in the dialog for a second confirmation — its figures (disk,
 * dirty work, ahead counts, descendants) may differ from the first, so it is never
 * executed unseen. Only a manifest the user confirmed as rendered is executed.
 *
 * Failures never vanish: a rejected resolve/execute, a stale manifest, and every
 * per-target failure/survivor in a partial result land in `error`, rendered by
 * {@link WorktreeReapError} in the view.
 */
import { useCallback, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import type { SystemSnapshotData } from '../../hooks/useSystemSnapshot';
import { ManifestConfirmDialog } from './ManifestConfirmDialog';
import type { ManifestConfirmData, ManifestConfirmOptions } from './ManifestConfirmDialog';
import { toManifestConfirmData, reapTargetId } from './reapManifestAdapter';
import type { ReapExecuteData, ReapManifestData } from './reapManifestAdapter';
import { basename } from './SystemGroupedBody';

type SystemWorktree = SystemSnapshotData['worktrees'][number];
type ReapSelection = Parameters<typeof trpc.cyboflow.monitorReap.resolve.mutate>[0]['selection'];

export interface WorktreeReapFailure {
  /** One-line headline. */
  message: string;
  /** Per-target detail lines (one per failed/surviving target). */
  details: string[];
}

interface PendingReap {
  projectId: number;
  selection: ReapSelection;
  title: string;
  raw: ReapManifestData;
  confirm: ManifestConfirmData;
  /** The confirm button's label: "Prune" for a worktree action, "Reap all stale" for the toolbar. */
  confirmText: string;
  /** True once the manifest was rebuilt for the branch choice and the user has yet to see it. */
  refreshed: boolean;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error';
}

function staleMessage(message: string): string {
  return message.includes('MANIFEST_STALE')
    ? 'The system changed after this list was built, so nothing was removed. Review it and try again.'
    : message;
}

/** Per-target failures/survivors from an execute response, plus any target with no outcome at all. */
function executionProblems(manifest: ReapManifestData, out: ReapExecuteData): string[] {
  const lines = out.errors.map((e) => `${labelFor(manifest, e.targetId)}: ${e.message}`);
  const reported = new Set(out.results.map((r) => r.targetId));
  for (const target of manifest.targets) {
    const id = reapTargetId(target);
    if (!reported.has(id) && !out.errors.some((e) => e.targetId === id)) {
      lines.push(`${labelFor(manifest, id)}: no result was reported`);
    }
  }
  return lines;
}

function labelFor(manifest: ReapManifestData, targetId: string): string {
  const hit = manifest.targets.find((t) => reapTargetId(t) === targetId);
  if (hit === undefined) return targetId;
  return hit.kind === 'worktree' ? basename(hit.path) : `pid ${hit.pid}`;
}

export interface UseWorktreeReapArgs {
  projectId: number | null;
  /** Called after every execute attempt (success or not) so the caller can refresh its snapshot. */
  onSettled?: () => void;
}

export interface UseWorktreeReapResult {
  /** Resolve a manifest for one worktree card and open the confirm dialog. */
  prune: (worktree: SystemWorktree) => void;
  /**
   * Toolbar "Reap all stale": ONE server-built `reap-all-stale` manifest covering every
   * orphan worktree AND orphan process, one dialog, one execute — never two halves.
   */
  reapAllStale: () => void;
  /** A resolve or execute is in flight. */
  busy: boolean;
  error: WorktreeReapFailure | null;
  clearError: () => void;
  /** Mount this once in the view. */
  dialog: ReactNode;
}

export function useWorktreeReap({ projectId, onSettled }: UseWorktreeReapArgs): UseWorktreeReapResult {
  const [pending, setPending] = useState<PendingReap | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WorktreeReapFailure | null>(null);
  // Synchronous single-flight guard. `busy` state cannot stop two clicks in the same tick:
  // both handlers close over the same `pending`, so the second would replay a consumed,
  // single-use manifest and surface a bogus stale-manifest error.
  const inFlightRef = useRef(false);

  const resolve = useCallback(
    async (
      selection: ReapSelection,
      title: (m: ReapManifestData) => string,
      confirmText: string,
    ): Promise<void> => {
      if (projectId === null || inFlightRef.current) return;
      inFlightRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const { manifest } = await trpc.cyboflow.monitorReap.resolve.mutate({ projectId, selection });
        if (manifest.targets.length === 0) {
          setError({ message: 'Nothing to remove — no matching targets were found.', details: [] });
          return;
        }
        setPending({ projectId, selection, title: title(manifest), raw: manifest, confirm: toManifestConfirmData(manifest), confirmText, refreshed: false });
      } catch (err: unknown) {
        setError({ message: `Could not prepare the removal: ${errorText(err)}`, details: [] });
      } finally {
        inFlightRef.current = false;
        setBusy(false);
      }
    },
    [projectId],
  );

  const prune = useCallback(
    (worktree: SystemWorktree): void => {
      if (!worktree.prunable) return;
      void resolve({ kind: 'card', worktreePath: worktree.path }, () => `Prune ${basename(worktree.path)}?`, 'Prune');
    },
    [resolve],
  );

  const reapAllStale = useCallback((): void => {
    void resolve(
      { kind: 'reap-all-stale' },
      (m) => `Reap ${m.targets.length} stale target${m.targets.length === 1 ? '' : 's'}?`,
      'Reap all stale',
    );
  }, [resolve]);

  const cancel = useCallback((): void => setPending(null), []);

  const confirm = useCallback(
    async (_shown: ManifestConfirmData, options: ManifestConfirmOptions): Promise<void> => {
      if (pending === null || inFlightRef.current) return;
      inFlightRef.current = true;
      setBusy(true);
      setError(null);
      try {
        if (pending.raw.alsoDeleteBranch !== options.deleteBranch) {
          // The branch choice is fixed at resolve time, so re-resolve with it. The rebuilt
          // manifest may differ in more than its targets (sizes, dirty work, ahead counts,
          // descendants) — never run one the user has not seen: show it and confirm again.
          const { manifest } = await trpc.cyboflow.monitorReap.resolve.mutate({
            projectId: pending.projectId,
            selection: pending.selection,
            alsoDeleteBranch: options.deleteBranch,
          });
          if (manifest.targets.length === 0) {
            setPending(null);
            setError({ message: 'Nothing to remove — no matching targets were found.', details: [] });
            return;
          }
          setPending({ ...pending, raw: manifest, confirm: toManifestConfirmData(manifest), refreshed: true });
          return;
        }
        const toRun = pending.raw;
        const out = await trpc.cyboflow.monitorReap.execute.mutate({ manifestId: toRun.id });
        setPending(null);
        const problems = executionProblems(toRun, out);
        if (problems.length > 0) {
          setError({
            message: `${problems.length} target${problems.length === 1 ? '' : 's'} could not be removed.`,
            details: problems,
          });
        }
      } catch (err: unknown) {
        setPending(null);
        setError({ message: staleMessage(errorText(err)), details: [] });
      } finally {
        inFlightRef.current = false;
        setBusy(false);
        onSettled?.();
      }
    },
    [pending, onSettled],
  );

  const untagged = pending?.raw.targets.some((t) => t.kind === 'process' && !t.taggedAsCyboflow) ?? false;
  const dialog: ReactNode =
    pending === null ? null : (
      <ManifestConfirmDialog
        isOpen
        manifest={pending.confirm}
        title={pending.title}
        confirmText={pending.confirmText}
        initialDeleteBranch={pending.raw.alsoDeleteBranch}
        busy={busy}
        banners={
          untagged || pending.refreshed ? (
            <>
              {pending.refreshed && <RefreshedManifestBanner />}
              {untagged && <UntaggedProcessBanner />}
            </>
          ) : undefined
        }
        onConfirm={(shown, options) => void confirm(shown, options)}
        onCancel={cancel}
      />
    );

  return { prune, reapAllStale, busy, error, clearError: () => setError(null), dialog };
}

/** Shown after the manifest was rebuilt for the branch choice: the figures may have moved. */
function RefreshedManifestBanner(): ReactElement {
  return (
    <div
      role="status"
      data-testid="prune-refreshed-notice"
      className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm text-text-primary"
    >
      The list was refreshed for your branch choice. Review it and confirm again.
    </div>
  );
}

/** A card prune also kills the card's processes; one without a cyboflow marker gets the harder warning. */
function UntaggedProcessBanner(): ReactElement {
  return (
    <div
      role="alert"
      data-testid="prune-untagged-warning"
      className="flex items-start gap-2 rounded-md border-2 border-status-error bg-status-error/10 px-3 py-2 text-sm font-medium text-status-error"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <span>A process in this worktree is not tagged as cyboflow's — killing it may affect other software</span>
    </div>
  );
}

/** Inline, dismissible error banner for a failed or partial reap. */
export function WorktreeReapError({
  error,
  onDismiss,
}: {
  error: WorktreeReapFailure;
  onDismiss: () => void;
}): ReactElement {
  return (
    <div
      role="alert"
      data-testid="system-reap-error"
      className="flex items-start gap-2 border-b border-border-primary bg-status-error/10 px-7 py-2 text-xs text-status-error"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div data-testid="system-reap-error-message" className="font-bold">{error.message}</div>
        {error.details.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {error.details.map((line) => (
              <li key={line} data-testid="system-reap-error-detail">{line}</li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss error"
        data-testid="system-reap-error-dismiss"
        onClick={onDismiss}
        className="flex-shrink-0 text-status-error hover:opacity-70"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
