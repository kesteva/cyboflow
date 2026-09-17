/**
 * RunDiffFileList — the rail Diff tab body: a FLAT list of changed files with
 * their +/- counts. No inline diff, no expand/collapse toggle — clicking a row
 * opens that file in the center pane (Diff / Split / Preview), which is where the
 * actual diff lives now.
 *
 * Parses the run/session working diff (a combined unified-diff string) into
 * per-file entries via parseFileDiffs. Rows are keyed by path+index so a rename
 * (distinct old/new path) or a duplicate never collides.
 *
 * When the optional `groups` prop (TASK-215) is supplied, the list instead
 * renders four sticky collapsible sections — Unstaged / Staged / Untracked /
 * Committed — each headed by its own `DiffGroupRollup` +/- numbers (NOT
 * recomputed from the diff blob, since a file can be both committed-since-base
 * and separately dirty with DIFFERENT numbers in each group). Absent `groups`,
 * behavior is byte-for-byte the original flat list.
 */
import { useState, type ReactElement } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { parseFileDiffs, type FileChangeType } from '../../utils/parseFileHunks';
import type {
  DiffGroupRollup,
  DiffGroupScope,
  WorktreeStatusEntry,
  WorktreeStatusPayload,
} from '../../../../shared/types/runFiles';

interface RunDiffFileListProps {
  /** Combined unified-diff text (empty string == no changes). */
  diff: string;
  /**
   * Open a file in the center pane. When omitted, rows are non-interactive.
   * The grouped arm (see `groups`) passes the row's group scope as a second
   * argument; the flat arm always calls this with exactly one argument.
   */
  onOpenFile?: (filePath: string, scope?: DiffGroupScope) => void;
  /**
   * Per-scope membership + rollups (TASK-209/210). When supplied, renders
   * four sticky collapsible groups instead of the flat list.
   */
  groups?: WorktreeStatusPayload;
}

/** Short tag for non-modify change types (modified renders no tag). */
function changeTag(type: FileChangeType): string | null {
  if (type === 'added') return 'A';
  if (type === 'deleted') return 'D';
  if (type === 'renamed') return 'R';
  return null;
}

/** Fixed render order + display chrome for each group (TASK-215). */
const GROUP_ORDER: DiffGroupScope[] = ['unstaged', 'staged', 'untracked', 'committed'];

const GROUP_CONFIG: Record<DiffGroupScope, { label: string; tag: string; colorClass: string }> = {
  unstaged: { label: 'Unstaged', tag: 'M', colorClass: 'text-status-warning' },
  staged: { label: 'Staged', tag: 'S', colorClass: 'text-status-success' },
  untracked: { label: 'Untracked', tag: 'U', colorClass: 'text-text-tertiary' },
  committed: { label: 'Committed', tag: 'C', colorClass: 'text-interactive' },
};

/** One row's worth of derived info for the grouped rendering. */
interface GroupRow {
  key: string;
  path: string;
  type: FileChangeType;
  additions: number;
  deletions: number;
  conflicted: boolean;
}

/**
 * Build the row list for one scope. Primarily keyed off the rollup's own
 * `files` membership (per-scope, may legitimately overlap with other
 * scopes — no dedup); per-file +/- come from the rollup's SCOPE-SPECIFIC
 * `fileStats` when the producer supplied them (a file both Staged and
 * Unstaged has different deltas in each), falling back to `parseFileDiffs`'
 * base-relative numbers only when absent; change-type comes from
 * `parseFileDiffs` (0/0 + 'modified' when a path isn't in the blob at all).
 * Unstaged additionally folds in any conflicted entries not already present
 * in the rollup; Staged defensively excludes conflicted entries (conflicted
 * paths never render there per the epic).
 */
function buildGroupRows(
  scope: DiffGroupScope,
  payload: WorktreeStatusPayload,
  parsedByPath: Map<string, ReturnType<typeof parseFileDiffs>[number]>,
  entryByPath: Map<string, WorktreeStatusEntry>,
): GroupRow[] {
  const rollup: DiffGroupRollup = payload.groups.find((g) => g.scope === scope) ?? {
    scope,
    files: [],
    additions: 0,
    deletions: 0,
  };

  let paths = rollup.files;

  if (scope === 'unstaged') {
    const seen = new Set(paths);
    const conflictPaths = payload.entries.filter((e) => e.conflicted).map((e) => e.path);
    const extra = conflictPaths.filter((p) => !seen.has(p));
    if (extra.length > 0) paths = [...paths, ...extra];
  } else if (scope === 'staged') {
    paths = paths.filter((p) => !entryByPath.get(p)?.conflicted);
  }

  return paths.map((path, i) => {
    const parsed = parsedByPath.get(path);
    const entry = entryByPath.get(path);
    const scoped = rollup.fileStats?.[path];
    return {
      key: `${scope}-${path}-${i}`,
      path,
      type: parsed?.type ?? 'modified',
      additions: scoped?.additions ?? parsed?.additions ?? 0,
      deletions: scoped?.deletions ?? parsed?.deletions ?? 0,
      conflicted: entry?.conflicted ?? false,
    };
  });
}

export function RunDiffFileList({ diff, onOpenFile, groups }: RunDiffFileListProps): ReactElement {
  const files = parseFileDiffs(diff ?? '');

  const [collapsed, setCollapsed] = useState<Set<DiffGroupScope>>(new Set());

  if (groups) {
    const parsedByPath = new Map(files.map((f) => [f.path, f] as const));
    const entryByPath = new Map(groups.entries.map((e) => [e.path, e] as const));

    return (
      <div data-testid="run-diff-file-list-grouped" className="cf-scroll h-full overflow-y-auto">
        {GROUP_ORDER.map((scope) => {
          const config = GROUP_CONFIG[scope];
          const rollup = groups.groups.find((g) => g.scope === scope) ?? {
            scope,
            files: [],
            additions: 0,
            deletions: 0,
          };
          const isCommittedUnavailable = scope === 'committed' && groups.committedUnavailable;
          const rows = isCommittedUnavailable
            ? []
            : buildGroupRows(scope, groups, parsedByPath, entryByPath);
          const isCollapsed = collapsed.has(scope);

          return (
            <section key={scope} data-testid={`run-diff-group-${scope}`}>
              <button
                type="button"
                data-testid={`run-diff-group-header-${scope}`}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(scope)) next.delete(scope);
                    else next.add(scope);
                    return next;
                  })
                }
                aria-expanded={!isCollapsed}
                className="sticky top-0 z-10 flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border-primary bg-bg-tertiary px-3 py-1.5 text-left"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-3 h-3 shrink-0 text-text-tertiary" />
                ) : (
                  <ChevronDown className="w-3 h-3 shrink-0 text-text-tertiary" />
                )}
                <span
                  className={[
                    'shrink-0 text-[10px] font-bold uppercase tracking-[0.1em]',
                    config.colorClass,
                  ].join(' ')}
                >
                  {config.label}
                </span>
                <span className="shrink-0 text-[10px] text-text-tertiary">
                  {rows.length} {rows.length === 1 ? 'file' : 'files'}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-[10px] font-medium">
                  {rollup.additions > 0 && (
                    <span className="text-status-success">+{rollup.additions}</span>
                  )}
                  {rollup.additions > 0 && rollup.deletions > 0 && ' '}
                  {rollup.deletions > 0 && (
                    <span className="text-interactive">−{rollup.deletions}</span>
                  )}
                </span>
              </button>

              {!isCollapsed && isCommittedUnavailable && (
                <div
                  data-testid="run-diff-group-committed-unavailable"
                  className="px-3 py-2 text-[11px] text-text-secondary"
                >
                  Committed changes are unavailable — no common base.
                </div>
              )}

              {!isCollapsed && !isCommittedUnavailable && rows.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-text-secondary">No changes.</div>
              )}

              {!isCollapsed && !isCommittedUnavailable && rows.length > 0 && (
                <ul className="divide-y divide-border-primary">
                  {rows.map((row) => {
                    const tag = changeTag(row.type);
                    return (
                      <li key={row.key}>
                        <button
                          type="button"
                          data-testid="run-diff-file-row"
                          disabled={!onOpenFile}
                          onClick={onOpenFile ? () => onOpenFile(row.path, scope) : undefined}
                          title={onOpenFile ? `Open ${row.path}` : row.path}
                          className={[
                            'flex w-full min-w-0 flex-wrap items-center gap-2 px-3 py-2 text-left transition-colors',
                            onOpenFile ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-default',
                          ].join(' ')}
                        >
                          <FileText className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
                          <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-text-primary">
                            {row.path}
                          </span>
                          {row.conflicted && (
                            <span
                              data-testid="run-diff-conflict-marker"
                              className="flex shrink-0 items-center gap-0.5 text-[9px] font-bold text-status-warning"
                              title="Conflicted"
                            >
                              <AlertTriangle className="w-3 h-3" />
                              Conflict
                            </span>
                          )}
                          {tag && (
                            <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-text-tertiary">
                              {tag}
                            </span>
                          )}
                          <span className="shrink-0 tabular-nums text-[11px] font-medium">
                            {row.additions > 0 && (
                              <span className="text-status-success">+{row.additions}</span>
                            )}
                            {row.additions > 0 && row.deletions > 0 && ' '}
                            {row.deletions > 0 && (
                              <span className="text-interactive">−{row.deletions}</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    );
  }

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
