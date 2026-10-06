import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Cpu, Folder, X } from 'lucide-react';
import { useOcclusion } from '../../hooks/useOcclusion';
import { formatManifestBytes } from './formatManifestBytes';

export type ManifestTargetKind = 'worktree' | 'process';

export interface ManifestConfirmTarget {
  id: string;
  kind: ManifestTargetKind;
  /** Worktree name or process name. */
  name: string;
  /** Secondary line: worktree path, or `pid 1234`. */
  detail?: string;
  /** Uncommitted files in a worktree target; > 0 marks it dirty. */
  dirtyFileCount?: number;
  /**
   * The worktree is known dirty even though the file count is not (e.g. untracked
   * files are present). Marks it dirty exactly like `dirtyFileCount > 0`.
   */
  dirty?: boolean;
  /** Commits ahead of main in a worktree target; > 0 marks it ahead. */
  aheadOfMainCount?: number;
  /** Descendant PIDs that die with a process target. */
  descendantPidCount?: number;
  /** False when the process carries no cyboflow spawn marker. */
  taggedAsCyboflow?: boolean;
  /** Disk bytes this target frees; null/absent when not measured. */
  reclaimBytes?: number | null;
  /** RAM bytes this target frees; null/absent when not measured. */
  ramBytes?: number | null;
}

export interface ManifestConfirmData {
  id: string;
  targets: ManifestConfirmTarget[];
  /** Fresh-measured bytes the action frees; null when unknown. */
  reclaimableBytes: number | null;
  /** Total RAM the action frees; null/absent when unknown. */
  reclaimableRamBytes?: number | null;
}

export interface ManifestConfirmOptions {
  deleteBranch: boolean;
}

export interface ManifestConfirmDialogProps {
  isOpen: boolean;
  manifest: ManifestConfirmData;
  title: string;
  confirmText?: string;
  cancelText?: string;
  /** Extra banners rendered above the target list (e.g. the untagged-process warning). */
  banners?: ReactNode;
  /** Defaults to true when the manifest contains at least one worktree target. */
  showDeleteBranch?: boolean;
  /** Initial state of "Also delete branch" for each fresh manifest; defaults to unchecked. */
  initialDeleteBranch?: boolean;
  /** A confirm is in flight: Confirm and "Also delete branch" are disabled so it cannot be submitted twice. */
  busy?: boolean;
  /** Receives the exact manifest object that was passed in. */
  onConfirm: (manifest: ManifestConfirmData, options: ManifestConfirmOptions) => void;
  onCancel: () => void;
}

function plural(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

const bannerClass =
  'flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm text-text-primary';

export function ManifestConfirmDialog({
  isOpen,
  manifest,
  title,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  banners,
  showDeleteBranch,
  initialDeleteBranch = false,
  busy = false,
  onConfirm,
  onCancel,
}: ManifestConfirmDialogProps) {
  const [deleteBranch, setDeleteBranch] = useState(initialDeleteBranch);

  // Hand-rolled scrim (not ui/Modal), so it takes its own occlusion lease.
  useOcclusion(isOpen, 'manifest-confirm-dialog');

  // A fresh manifest (or a reopen) starts from the caller's choice — the branch kept by default.
  useEffect(() => {
    setDeleteBranch(initialDeleteBranch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on a new manifest / reopen
  }, [isOpen, manifest.id]);

  // Esc cancels. Enter is deliberately NOT bound: a stray Enter must never fire a
  // destructive action (unlike ConfirmDialog, which confirms on Enter).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const { targets, reclaimableBytes, reclaimableRamBytes } = manifest;
  const dirtyTargets = targets.filter((t) => t.dirty === true || (t.dirtyFileCount ?? 0) > 0);
  const aheadTargets = targets.filter((t) => (t.aheadOfMainCount ?? 0) > 0);
  const hasWorktree = targets.some((t) => t.kind === 'worktree');
  const deleteBranchVisible = showDeleteBranch ?? hasWorktree;
  const reclaimParts: string[] = [];
  if (reclaimableBytes != null) reclaimParts.push(`${formatManifestBytes(reclaimableBytes)} disk`);
  if (reclaimableRamBytes != null) reclaimParts.push(`${formatManifestBytes(reclaimableRamBytes)} RAM`);
  const subtitle =
    reclaimParts.length === 0
      ? plural(targets.length, 'target')
      : `${plural(targets.length, 'target')} · ${reclaimParts.join(' · ')} reclaimable`;

  return (
    <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50" data-testid="manifest-confirm-dialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manifest-confirm-title"
        className="bg-surface-primary rounded-lg shadow-xl max-w-lg w-full mx-4 p-6"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 id="manifest-confirm-title" className="text-lg font-medium text-text-primary">
              {title}
            </h3>
            <p className="mt-0.5 text-sm text-text-muted" data-testid="manifest-confirm-subtitle">
              {subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="text-text-muted hover:text-text-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2 mb-4">
          {banners}
          {dirtyTargets.length > 0 && (
            <div role="alert" className={bannerClass} data-testid="manifest-dirty-warning">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-status-warning" />
              <span>
                {plural(dirtyTargets.length, 'target')} ha{dirtyTargets.length === 1 ? 's' : 've'} uncommitted changes.
                Pruning discards them permanently — nothing is stashed.
              </span>
            </div>
          )}
          {aheadTargets.length > 0 && (
            <div role="alert" className={bannerClass} data-testid="manifest-ahead-warning">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-status-warning" />
              <span>
                {plural(aheadTargets.length, 'target')} ha{aheadTargets.length === 1 ? 's' : 've'} commits ahead of main
                that {aheadTargets.length === 1 ? 'is' : 'are'} not merged.
              </span>
            </div>
          )}
        </div>

        <ul className="mb-4 max-h-64 space-y-1 overflow-y-auto" aria-label="Targets" data-testid="manifest-targets">
          {targets.map((target) => {
            const isWorktree = target.kind === 'worktree';
            return (
              <li
                key={target.id}
                data-testid={`manifest-target-${target.id}`}
                data-kind={target.kind}
                className="flex items-center gap-3 rounded-md border border-border-primary bg-bg-secondary px-3 py-2"
              >
                {isWorktree ? (
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-none bg-status-info/10 text-status-info" aria-label="worktree">
                    <Folder className="w-3.5 h-3.5" />
                  </span>
                ) : (
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[var(--color-phase-compound)]/10 text-[var(--color-phase-compound)]" aria-label="process">
                    <Cpu className="w-3.5 h-3.5" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-text-primary">{target.name}</div>
                  {target.detail && <div className="truncate font-mono text-xs text-text-muted">{target.detail}</div>}
                </div>
                <div className="flex flex-shrink-0 flex-wrap justify-end gap-1 text-xs">
                  {(target.dirtyFileCount ?? 0) > 0 ? (
                    <span className="rounded border border-status-warning/40 bg-status-warning/10 px-1.5 py-0.5 text-status-warning">
                      {plural(target.dirtyFileCount ?? 0, 'dirty file')}
                    </span>
                  ) : (
                    target.dirty === true && (
                      <span className="rounded border border-status-warning/40 bg-status-warning/10 px-1.5 py-0.5 text-status-warning">
                        uncommitted changes
                      </span>
                    )
                  )}
                  {(target.aheadOfMainCount ?? 0) > 0 && (
                    <span className="rounded border border-status-warning/40 bg-status-warning/10 px-1.5 py-0.5 text-status-warning">
                      {target.aheadOfMainCount} ahead of main
                    </span>
                  )}
                  {target.reclaimBytes != null && (
                    <span
                      className="rounded border border-border-primary px-1.5 py-0.5 text-text-secondary"
                      data-testid={`manifest-target-${target.id}-disk`}
                    >
                      {formatManifestBytes(target.reclaimBytes)} disk
                    </span>
                  )}
                  {target.ramBytes != null && (
                    <span
                      className="rounded border border-border-primary px-1.5 py-0.5 text-text-secondary"
                      data-testid={`manifest-target-${target.id}-ram`}
                    >
                      {formatManifestBytes(target.ramBytes)} RAM
                    </span>
                  )}
                  {!isWorktree && target.descendantPidCount !== undefined && (
                    <span className="rounded border border-border-primary px-1.5 py-0.5 text-text-secondary">
                      {plural(target.descendantPidCount, 'descendant PID')}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {deleteBranchVisible && (
          <label className="mb-4 flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
              disabled={busy}
              data-testid="manifest-delete-branch"
            />
            Also delete branch
          </label>
        )}

        <p className="mb-3 text-right text-xs font-medium text-status-error" data-testid="manifest-irreversible">
          This cannot be undone
        </p>

        <div className="flex items-center justify-end space-x-3">
          <span className="text-xs text-text-muted" data-testid="manifest-esc-hint">
            Esc to cancel
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-md transition-colors"
            autoFocus
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(manifest, { deleteBranch })}
            disabled={busy}
            aria-busy={busy}
            className="px-4 py-2 text-sm font-medium rounded-md transition-colors bg-status-error hover:bg-status-error text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Working…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
