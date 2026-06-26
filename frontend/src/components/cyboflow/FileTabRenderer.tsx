/**
 * FileTabRenderer — center-pane file/diff tab content.
 *
 * Renders one file's working diff as the design's bespoke 3-col grid
 * (old line no │ new line no │ code) with `@@ … @@` hunk headers and +/- tinting,
 * under a header row (filename, ± counts, path). Diff data comes from
 * useFileDiffData (the run's combined diff, filtered to this file).
 *
 * Design hexes are inline (warm-paper palette); the M7 polish pass tokenizes them.
 * (An "Open in editor" affordance is deferred — it needs an editor-open IPC.)
 */
import type { ReactElement } from 'react';
import { useFileDiffData } from '../../hooks/useFileDiffData';
import type { DiffHunk, HunkLine } from '../../utils/parseFileHunks';
import type { FileTabStatus } from '../../../../shared/types/centerPane';

const RAIL = 'var(--color-bg-secondary)';
const HAIRLINE = 'var(--color-border-primary)';
const SOFT = 'var(--color-border-tertiary)';
const FAINT = 'var(--color-text-tertiary)';
const MUTED = 'var(--color-text-secondary)';
const GREEN = 'var(--color-status-success)';
const RUST = 'var(--color-interactive-primary)';
const INK = 'var(--color-text-primary)';
// Diff add/del row washes are kept as theme-stable literals (no --*-rgb channel
// triple exists for green/terracotta): additions read green, deletions rust in
// every theme, preserving the pairing. Do NOT map DEL_BG to --color-interactive-
// surface — it remaps to blue in dark mode and breaks the add/del contrast.
const ADD_BG = 'rgba(45,138,91,.12)';
const DEL_BG = 'rgba(201,100,66,.12)';

interface FileTabRendererProps {
  /** Center-pane session key (= the run's parent session) — the diff source. */
  sessionId: string;
  filePath: string;
  status?: FileTabStatus;
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}
function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
}

function rowPrefix(kind: HunkLine['kind']): string {
  if (kind === 'add') return '+ ';
  if (kind === 'del') return '− ';
  return '  ';
}

function HunkRows({ hunk }: { hunk: DiffHunk }): ReactElement {
  return (
    <>
      <div
        style={{
          fontSize: '10px',
          padding: '3px 16px',
          color: FAINT,
          background: RAIL,
          borderBottom: `1px dashed ${HAIRLINE}`,
          whiteSpace: 'pre',
        }}
      >
        {hunk.header}
      </div>
      {hunk.lines.map((ln, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '30px 30px 1fr',
            fontSize: '11px',
            lineHeight: 1.55,
            background: ln.kind === 'add' ? ADD_BG : ln.kind === 'del' ? DEL_BG : 'transparent',
          }}
        >
          <span style={{ padding: '0 6px', textAlign: 'right', color: FAINT, fontSize: '9.5px' }}>
            {ln.oldNo ?? ''}
          </span>
          <span style={{ padding: '0 6px', textAlign: 'right', color: FAINT, fontSize: '9.5px' }}>
            {ln.newNo ?? ''}
          </span>
          <span style={{ padding: '0 8px', whiteSpace: 'pre', color: ln.kind === 'context' ? MUTED : INK }}>
            {rowPrefix(ln.kind)}
            {ln.text}
          </span>
        </div>
      ))}
    </>
  );
}

export function FileTabRenderer({ sessionId, filePath, status }: FileTabRendererProps): ReactElement {
  const { loading, error, fileDiff } = useFileDiffData(sessionId, filePath);

  return (
    <div data-testid="file-tab-renderer" className="cf-scroll" style={{ height: '100%', overflow: 'auto', background: 'var(--color-bg-primary)' }}>
      {/* Header */}
      <div
        style={{
          padding: '9px 16px',
          fontSize: '11px',
          fontWeight: 700,
          borderBottom: `1px solid ${HAIRLINE}`,
          background: RAIL,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <span style={{ color: INK }}>{basename(filePath)}</span>
        {fileDiff && (
          <>
            <span style={{ color: GREEN }}>+{fileDiff.additions}</span>
            <span style={{ color: RUST }}>−{fileDiff.deletions}</span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {dirname(filePath) && (
          <span style={{ color: FAINT, fontWeight: 400, fontSize: '10px' }}>{dirname(filePath)}</span>
        )}
      </div>

      {/* Body */}
      {loading ? (
        <div data-testid="file-tab-loading" style={{ padding: 16, fontSize: '12px', color: MUTED }}>
          Loading diff…
        </div>
      ) : error ? (
        <div data-testid="file-tab-error" style={{ padding: 16, fontSize: '12px', color: RUST }}>
          {error}
        </div>
      ) : !fileDiff ? (
        <div data-testid="file-tab-empty" style={{ padding: 16, fontSize: '12px', color: MUTED }}>
          {status === 'A' ? 'New file — no diff to show.' : 'No changes in this file.'}
        </div>
      ) : fileDiff.isBinary ? (
        <div data-testid="file-tab-binary" style={{ padding: 16, fontSize: '12px', color: MUTED }}>
          Binary file — diff not shown.
        </div>
      ) : (
        <div data-testid="file-tab-hunks" style={{ borderBottom: `1px solid ${SOFT}` }}>
          {fileDiff.hunks.map((hunk, i) => (
            <HunkRows key={i} hunk={hunk} />
          ))}
        </div>
      )}
    </div>
  );
}
