/**
 * RunDiffFileList — the rail Diff tab body: a FLAT list of changed files with
 * their +/- counts. No inline diff, no expand/collapse toggle — clicking a row
 * opens that file in the center pane (Diff / Split / Preview), which is where the
 * actual diff lives now.
 *
 * Parses the run/session working diff (a combined unified-diff string) into
 * per-file entries via parseFileDiffs. Rows are keyed by path+index so a rename
 * (distinct old/new path) or a duplicate never collides.
 */
import type { ReactElement } from 'react';
import { FileText } from 'lucide-react';
import { parseFileDiffs, type FileChangeType } from '../../utils/parseFileHunks';

interface RunDiffFileListProps {
  /** Combined unified-diff text (empty string == no changes). */
  diff: string;
  /** Open a file in the center pane. When omitted, rows are non-interactive. */
  onOpenFile?: (filePath: string) => void;
}

/** Short tag for non-modify change types (modified renders no tag). */
function changeTag(type: FileChangeType): string | null {
  if (type === 'added') return 'A';
  if (type === 'deleted') return 'D';
  if (type === 'renamed') return 'R';
  return null;
}

export function RunDiffFileList({ diff, onOpenFile }: RunDiffFileListProps): ReactElement {
  const files = parseFileDiffs(diff ?? '');

  if (files.length === 0) {
    return (
      <div
        data-testid="run-diff-file-list-empty"
        className="p-4 text-sm text-text-secondary"
      >
        No changes in this worktree yet.
      </div>
    );
  }

  return (
    <div data-testid="run-diff-file-list" className="cf-scroll h-full overflow-y-auto">
      <ul className="divide-y divide-border-primary">
        {files.map((file, i) => {
          const tag = changeTag(file.type);
          return (
            <li key={`${file.path}-${i}`}>
              <button
                type="button"
                data-testid="run-diff-file-row"
                disabled={!onOpenFile}
                onClick={onOpenFile ? () => onOpenFile(file.path) : undefined}
                title={onOpenFile ? `Open ${file.path}` : file.path}
                className={[
                  'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                  onOpenFile ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-default',
                ].join(' ')}
              >
                <FileText className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-primary">
                  {file.path}
                </span>
                {tag && (
                  <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-text-tertiary">
                    {tag}
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-[11px] font-medium">
                  {file.additions > 0 && (
                    <span className="text-status-success">+{file.additions}</span>
                  )}
                  {file.additions > 0 && file.deletions > 0 && ' '}
                  {file.deletions > 0 && (
                    <span className="text-interactive">−{file.deletions}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
