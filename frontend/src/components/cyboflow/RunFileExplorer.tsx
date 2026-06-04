/**
 * RunFileExplorer — the File Explorer tab in the run's right rail.
 *
 * Renders the git worktree of the active workflow run as a lazy-loaded,
 * expand/collapse file tree (cyboflow.runs.listFiles). Clicking a file opens a
 * read-only viewer that takes over the panel (cyboflow.runs.readFile); a back
 * affordance returns to the tree. A refresh control re-reads the visible tree
 * because the worktree mutates while the agent works.
 *
 * Read-only by design — this is for inspecting what an agent produced, not
 * editing. Binary / oversized files show a notice instead of content.
 *
 * Paths on the wire are relative to the worktree root with POSIX separators
 * (see shared/types/runFiles.ts); the empty string denotes the root.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  File as FileIcon,
  FileText,
  FileCode,
  FileImage,
  RefreshCw,
  ArrowLeft,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import type { RunFileEntry, RunFileContent } from '../../../../shared/types/runFiles';

const ROOT = '';

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'cpp', 'cc', 'c', 'h',
  'hpp', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'scala', 'sh', 'bash',
  'zsh', 'sql', 'css', 'scss', 'less', 'html', 'vue', 'svelte',
]);
const DOC_EXT = new Set([
  'txt', 'md', 'mdx', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'csv',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif']);

function fileIcon(name: string): React.JSX.Element {
  const cls = 'w-3.5 h-3.5 shrink-0 text-text-tertiary';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (CODE_EXT.has(ext)) return <FileCode className={cls} />;
  if (IMAGE_EXT.has(ext)) return <FileImage className={cls} />;
  if (DOC_EXT.has(ext)) return <FileText className={cls} />;
  return <FileIcon className={cls} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RunFileExplorer({ runId }: { runId: string }): React.JSX.Element {
  // Tree state: directory contents keyed by relative dir path (ROOT === '').
  const [childrenByDir, setChildrenByDir] = useState<Record<string, RunFileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  // Viewer state: when openFile is non-null the viewer takes over the panel.
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<RunFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Staleness guards. The component instance is REUSED across runs (RunRightRail
  // renders it without a `key`), so an in-flight fetch from a previous run — or a
  // previous file open — can resolve after the user has moved on. The async
  // setState calls below bail when their request is no longer current:
  //   - runIdRef holds the live runId (updated synchronously in the root effect);
  //     a resolved fetch whose captured runId != runIdRef.current is dropped.
  //   - fileReqId increments on every openFileAt / closeFile; a resolved read
  //     whose captured id != fileReqIdRef.current is dropped (covers click-A →
  //     back → click-B, where A would otherwise paint under B's header).
  const runIdRef = useRef(runId);
  const fileReqIdRef = useRef(0);

  // Fetch one directory level into childrenByDir.
  const loadDir = useCallback(
    async (dirPath: string): Promise<void> => {
      const reqRunId = runId;
      setLoadingDirs((prev) => new Set(prev).add(dirPath));
      try {
        const entries = await trpc.cyboflow.runs.listFiles.query({
          runId: reqRunId,
          path: dirPath === ROOT ? undefined : dirPath,
        });
        if (runIdRef.current !== reqRunId) return; // run switched mid-flight — drop
        setChildrenByDir((prev) => ({ ...prev, [dirPath]: entries }));
        if (dirPath === ROOT) setRootError(null);
      } catch (err) {
        if (runIdRef.current !== reqRunId) return;
        const msg = err instanceof Error ? err.message : 'Failed to list files';
        if (dirPath === ROOT) setRootError(msg);
      } finally {
        if (runIdRef.current === reqRunId) {
          setLoadingDirs((prev) => {
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        }
      }
    },
    [runId],
  );

  // Load the root whenever the run changes; reset all per-run state first.
  useEffect(() => {
    // Mark this run current BEFORE any await so a prior run's in-flight loadDir /
    // openFileAt resolution sees the switch and drops itself.
    runIdRef.current = runId;
    let cancelled = false;
    setChildrenByDir({});
    setExpanded(new Set());
    setLoadingDirs(new Set());
    setOpenFile(null);
    setFileContent(null);
    setFileError(null);
    setRootError(null);
    setRootLoading(true);
    trpc.cyboflow.runs.listFiles
      .query({ runId })
      .then((entries) => {
        if (cancelled) return;
        setChildrenByDir({ [ROOT]: entries });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRootError(err instanceof Error ? err.message : 'Failed to list files');
      })
      .finally(() => {
        if (!cancelled) setRootLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const toggleDir = useCallback(
    (dirPath: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
          // Lazy-load children the first time a directory is opened.
          setChildrenByDir((current) => {
            if (current[dirPath] === undefined) void loadDir(dirPath);
            return current;
          });
        }
        return next;
      });
    },
    [loadDir],
  );

  const openFileAt = useCallback(
    async (filePath: string): Promise<void> => {
      const reqRunId = runId;
      const reqId = ++fileReqIdRef.current;
      const isCurrent = (): boolean => runIdRef.current === reqRunId && fileReqIdRef.current === reqId;
      setOpenFile(filePath);
      setFileContent(null);
      setFileError(null);
      setFileLoading(true);
      try {
        const content = await trpc.cyboflow.runs.readFile.query({ runId: reqRunId, path: filePath });
        if (!isCurrent()) return; // superseded by a newer open / run switch — drop
        setFileContent(content);
      } catch (err) {
        if (!isCurrent()) return;
        setFileError(err instanceof Error ? err.message : 'Failed to read file');
      } finally {
        if (isCurrent()) setFileLoading(false);
      }
    },
    [runId],
  );

  const closeFile = useCallback((): void => {
    // Abandon any in-flight read so it can't paint after we return to the tree.
    fileReqIdRef.current++;
    setOpenFile(null);
    setFileContent(null);
    setFileError(null);
  }, []);

  const refresh = useCallback((): void => {
    if (openFile !== null) {
      void openFileAt(openFile);
      return;
    }
    void loadDir(ROOT);
    for (const dir of expanded) {
      void loadDir(dir);
    }
  }, [openFile, openFileAt, loadDir, expanded]);

  // -------------------------------------------------------------------------
  // Viewer takeover
  // -------------------------------------------------------------------------
  if (openFile !== null) {
    return (
      <div data-testid="run-file-explorer-viewer" className="flex flex-col h-full">
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border-secondary bg-bg-secondary">
          <button
            type="button"
            data-testid="run-file-explorer-back"
            onClick={closeFile}
            className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            aria-label="Back to file tree"
            title="Back to file tree"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <span
            className="flex-1 min-w-0 truncate font-mono text-[11px] text-text-secondary"
            title={openFile}
          >
            {openFile}
          </span>
          {fileContent !== null && (
            <span className="shrink-0 text-[10px] text-text-tertiary tabular-nums">
              {formatBytes(fileContent.size)}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {fileLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-text-secondary">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : fileError !== null ? (
            <div
              data-testid="run-file-explorer-viewer-error"
              className="flex items-start gap-2 p-4 text-sm text-status-error"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="min-w-0 break-words">{fileError}</span>
            </div>
          ) : fileContent === null ? null : fileContent.unviewableReason !== null ? (
            <div
              data-testid="run-file-explorer-unviewable"
              className="p-4 text-sm text-text-tertiary"
            >
              {fileContent.unviewableReason === 'binary'
                ? 'Binary file — preview not available.'
                : `File too large to preview (${formatBytes(fileContent.size)}).`}
            </div>
          ) : fileContent.content === '' ? (
            <div className="p-4 text-sm text-text-tertiary italic">Empty file</div>
          ) : (
            <pre
              data-testid="run-file-explorer-content"
              className="p-3 text-[11px] leading-relaxed font-mono text-text-primary whitespace-pre"
            >
              {fileContent.content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Tree view
  // -------------------------------------------------------------------------
  const renderRows = (dirPath: string, depth: number): React.JSX.Element[] => {
    const entries = childrenByDir[dirPath] ?? [];
    return entries.flatMap((entry) => {
      const isOpen = expanded.has(entry.path);
      const indent = depth * 12 + 8;
      const row = (
        <button
          key={entry.path}
          type="button"
          data-testid={`run-file-explorer-node-${entry.path}`}
          onClick={() => (entry.isDirectory ? toggleDir(entry.path) : void openFileAt(entry.path))}
          style={{ paddingLeft: indent }}
          className="w-full flex items-center gap-1 pr-2 py-1 text-left text-xs text-text-primary hover:bg-bg-hover transition-colors"
          title={entry.path}
        >
          {entry.isDirectory ? (
            <>
              {isOpen ? (
                <ChevronDown className="w-3 h-3 shrink-0 text-text-tertiary" />
              ) : (
                <ChevronRight className="w-3 h-3 shrink-0 text-text-tertiary" />
              )}
              {isOpen ? (
                <FolderOpen className="w-3.5 h-3.5 shrink-0 text-interactive" />
              ) : (
                <Folder className="w-3.5 h-3.5 shrink-0 text-interactive" />
              )}
            </>
          ) : (
            <>
              <span className="w-3 shrink-0" />
              {fileIcon(entry.name)}
            </>
          )}
          <span className="min-w-0 truncate">{entry.name}</span>
        </button>
      );

      if (entry.isDirectory && isOpen) {
        const childLoading = loadingDirs.has(entry.path) && childrenByDir[entry.path] === undefined;
        const loadedChildren = childrenByDir[entry.path];
        const subRows: React.JSX.Element[] = childLoading
          ? [
              <div
                key={`${entry.path}__loading`}
                style={{ paddingLeft: (depth + 1) * 12 + 8 }}
                className="flex items-center gap-1.5 py-1 text-[11px] text-text-tertiary"
              >
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>,
            ]
          : loadedChildren !== undefined && loadedChildren.length === 0
            ? [
                <div
                  key={`${entry.path}__empty`}
                  style={{ paddingLeft: (depth + 1) * 12 + 8 }}
                  className="py-1 text-[11px] text-text-tertiary italic"
                >
                  empty
                </div>,
              ]
            : renderRows(entry.path, depth + 1);
        return [row, ...subRows];
      }
      return [row];
    });
  };

  const rootEntries = childrenByDir[ROOT];

  return (
    <div data-testid="run-file-explorer" className="flex flex-col h-full">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border-secondary bg-bg-secondary">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-text-tertiary">
          Worktree
        </span>
        <button
          type="button"
          data-testid="run-file-explorer-refresh"
          onClick={refresh}
          disabled={rootLoading}
          className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
          aria-label="Refresh file tree"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${rootLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-auto py-1">
        {rootLoading && rootEntries === undefined ? (
          <div
            data-testid="run-file-explorer-loading"
            className="flex items-center gap-2 p-4 text-sm text-text-secondary"
          >
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : rootError !== null ? (
          <div
            data-testid="run-file-explorer-error"
            className="flex items-start gap-2 p-4 text-sm text-text-secondary"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-text-tertiary" />
            <span className="min-w-0 break-words">{rootError}</span>
          </div>
        ) : rootEntries !== undefined && rootEntries.length === 0 ? (
          <div data-testid="run-file-explorer-empty-tree" className="p-4 text-sm text-text-tertiary">
            No files in this worktree.
          </div>
        ) : (
          <div data-testid="run-file-explorer-tree">{renderRows(ROOT, 0)}</div>
        )}
      </div>
    </div>
  );
}
