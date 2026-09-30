/**
 * useWorktreeReap — the System view's worktree destructive actions
 * (per-card / ⋯-menu "Prune worktree" and the worktree half of toolbar
 * "Reap all stale"), each running the same three steps against the
 * `cyboflow.monitorReap` contract:
 *
 *   resolve → the SERVER builds + stashes a manifest for the selection;
 *   confirm → `ManifestConfirmDialog` renders that manifest verbatim;
 *   execute → the client hands back ONLY the manifest id it was shown.
 *
 * The branch-delete choice is locked into the manifest at resolve time and
 * execute cannot override it. So when the user ticks "Also delete branch" in the
 * dialog, the selection is re-resolved with `alsoDeleteBranch: true` and the NEW
 * manifest (same targets, or the dialog re-opens on the updated list) is what
 * runs. Without the tick the exact manifest the dialog rendered is executed.
 *
 * Failures never vanish: a rejected resolve/execute, a stale manifest, and every
 * per-target failure/survivor in a partial result land in `error`, rendered by
 * {@link WorktreeReapError} in the view.
 */
import { useCallback, useState } from 'react';
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

function sameTargets(a: ReapManifestData, b: ReapManifestData): boolean {
  const ids = (m: ReapManifestData): string => m.targets.map(reapTargetId).sort().join('\n');
  return ids(a) === ids(b);
}

export interface UseWorktreeReapArgs {
  projectId: number | null;
  /** Called after every execute attempt (success or not) so the caller can refresh its snapshot. */
  onSettled?: () => void;
}

export interface UseWorktreeReapResult {
  /** Resolve a manifest for one worktree card and open the confirm dialog. */
  prune: (worktree: SystemWorktree) => void;
  /** Resolve a manifest for every listed (prunable, stale) worktree and open one dialog. */
  reapAllStale: (worktrees: readonly SystemWorktree[]) => void;
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

  const resolve = useCallback(
    async (selection: ReapSelection, title: (m: ReapManifestData) => string): Promise<void> => {
      if (projectId === null) return;
      setBusy(true);
      setError(null);
      try {
        const { manifest } = await trpc.cyboflow.monitorReap.resolve.mutate({ projectId, selection });
        if (manifest.targets.length === 0) {
          setError({ message: 'Nothing to remove — no matching worktrees were found.', details: [] });
          return;
        }
        setPending({ projectId, selection, title: title(manifest), raw: manifest, confirm: toManifestConfirmData(manifest) });
      } catch (err: unknown) {
        setError({ message: `Could not prepare the removal: ${errorText(err)}`, details: [] });
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  const prune = useCallback(
    (worktree: SystemWorktree): void => {
      if (!worktree.prunable) return;
      void resolve({ kind: 'card', worktreePath: worktree.path }, () => `Prune ${basename(worktree.path)}?`);
    },
    [resolve],
  );

  const reapAllStale = useCallback(
    (worktrees: readonly SystemWorktree[]): void => {
      const paths = worktrees.filter((w) => w.prunable).map((w) => w.path);
      if (paths.length === 0) return;
      void resolve(
        { kind: 'row', worktreePaths: paths },
        (m) => `Reap ${m.targets.length} stale worktree${m.targets.length === 1 ? '' : 's'}?`,
      );
    },
    [resolve],
  );

  const cancel = useCallback((): void => setPending(null), []);

  const confirm = useCallback(
    async (_shown: ManifestConfirmData, options: ManifestConfirmOptions): Promise<void> => {
      if (pending === null) return;
      setBusy(true);
      setError(null);
      try {
        let toRun = pending.raw;
        if (toRun.alsoDeleteBranch !== options.deleteBranch) {
          // The choice is fixed at resolve time: re-resolve with it, and only run the
          // result if it still names exactly the targets the user confirmed.
          const { manifest } = await trpc.cyboflow.monitorReap.resolve.mutate({
            projectId: pending.projectId,
            selection: pending.selection,
            alsoDeleteBranch: options.deleteBranch,
          });
          if (!sameTargets(pending.raw, manifest)) {
            setPending({ ...pending, raw: manifest, confirm: toManifestConfirmData(manifest) });
            setError({ message: 'The targets changed while you were confirming. Review the updated list and confirm again.', details: [] });
            return;
          }
          toRun = manifest;
        }
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
        confirmText="Prune"
        banners={untagged ? <UntaggedProcessBanner /> : undefined}
        onConfirm={(shown, options) => void confirm(shown, options)}
        onCancel={cancel}
      />
    );

  return { prune, reapAllStale, busy, error, clearError: () => setError(null), dialog };
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
