import { ShieldAlert } from 'lucide-react';
import { ManifestConfirmDialog } from './ManifestConfirmDialog';
import type { ManifestConfirmDialogProps } from './ManifestConfirmDialog';

const UNTAGGED_PROCESS_WARNING =
  "This process is not tagged as cyboflow's — killing it may affect other software";

export type KillProcessConfirmDialogProps = Omit<ManifestConfirmDialogProps, 'showDeleteBranch'>;

/**
 * Single-process-kill variant of ManifestConfirmDialog. Adds the harder
 * "not tagged as cyboflow's" banner (and a "Kill anyway" confirm) whenever any
 * target carries `taggedAsCyboflow === false`. An absent flag is treated as
 * unknown and does not trigger it.
 */
export function KillProcessConfirmDialog({
  banners,
  confirmText,
  ...rest
}: KillProcessConfirmDialogProps) {
  const untagged = rest.manifest.targets.some((t) => t.taggedAsCyboflow === false);
  return (
    <ManifestConfirmDialog
      {...rest}
      showDeleteBranch={false}
      confirmText={untagged ? 'Kill anyway' : (confirmText ?? 'Kill tree')}
      banners={
        <>
          {untagged && (
            <div
              role="alert"
              data-testid="untagged-process-warning"
              className="flex items-start gap-2 rounded-md border-2 border-status-error bg-status-error/10 px-3 py-2 text-sm font-medium text-status-error"
            >
              <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{UNTAGGED_PROCESS_WARNING}</span>
            </div>
          )}
          {banners}
        </>
      }
    />
  );
}
