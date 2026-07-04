/**
 * FileTabRenderer — center-pane file/diff tab content.
 *
 * One file, three views selectable from a header segmented control:
 *   - Diff    — the design's bespoke unified 3-col grid (old no │ new no │ code)
 *               with `@@ … @@` hunk headers and +/- tinting.
 *   - Split   — the same hunks rendered side-by-side (old | new), del/add rows
 *               paired per hunk.
 *   - Preview — the plain file contents (Markdown is rendered for .md files).
 *
 * Diff data comes from useFileDiffData (the run's combined diff, filtered to this
 * file); the Preview body and the no-diff fallback come from useFileContentData
 * (cyboflow.files.read). When a file is unchanged there is no diff to show, so
 * the view falls back to Preview rather than a dead-end message.
 *
 * The chosen view persists in localStorage so it carries across tabs/sessions.
 *
 * Design hexes are inline (warm-paper palette); the M7 polish pass tokenizes them.
 */
import { Fragment, useState } from 'react';
import type { ReactElement } from 'react';
import { useFileDiffData } from '../../hooks/useFileDiffData';
import { useFileContentData } from '../../hooks/useFileContentData';
import { MarkdownPreview } from '../MarkdownPreview';
import type { DiffHunk, HunkLine, ParsedFileDiff } from '../../utils/parseFileHunks';
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

type ViewMode = 'diff' | 'split' | 'preview';
const VIEW_MODE_KEY = 'cyboflow.fileTab.viewMode';

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
function isMarkdown(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

function readInitialViewMode(): ViewMode {
  if (typeof localStorage === 'undefined') return 'diff';
  const saved = localStorage.getItem(VIEW_MODE_KEY);
  return saved === 'diff' || saved === 'split' || saved === 'preview' ? saved : 'diff';
}

function rowPrefix(kind: HunkLine['kind']): string {
  if (kind === 'add') return '+ ';
  if (kind === 'del') return '− ';
  return '  ';
}

// ---------------------------------------------------------------------------
// Unified (Diff) view
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Split (side-by-side) view — built from the same hunk lines.
// ---------------------------------------------------------------------------

interface SplitCell {
  no: number | null;
  text: string;
  kind: 'context' | 'del' | 'add';
}
interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
}

/**
 * Pair a hunk's lines into side-by-side rows: a context line fills both sides;
 * a run of deletions pairs positionally with the following run of additions
 * (leftover dels are left-only, leftover adds right-only). This is the standard
 * GitHub-style alignment and reads correctly without per-token diffing.
 */
function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };
  for (const ln of hunk.lines) {
    if (ln.kind === 'del') {
      dels.push({ no: ln.oldNo, text: ln.text, kind: 'del' });
    } else if (ln.kind === 'add') {
      adds.push({ no: ln.newNo, text: ln.text, kind: 'add' });
    } else {
      flush();
      rows.push({
        left: { no: ln.oldNo, text: ln.text, kind: 'context' },
        right: { no: ln.newNo, text: ln.text, kind: 'context' },
      });
    }
  }
  flush();
  return rows;
}

const SPLIT_NO_STYLE = { padding: '0 6px', textAlign: 'right' as const, color: FAINT, fontSize: '9.5px' };
const SPLIT_TEXT_STYLE = { padding: '0 12px', whiteSpace: 'pre' as const };

/**
 * SplitView — side-by-side diff as ONE horizontally-scrollable grid:
 * [old# │ old code │ new# │ new code]. The text columns are `max-content` so
 * each sizes to its widest line and long lines never bleed across the divider —
 * the whole grid scrolls horizontally as a unit instead. Hunk headers span all
 * four columns. Left cells carry old line numbers (context/deletions), right
 * cells the new (context/additions); a null cell is just blank, keeping rows
 * aligned to a single line height.
 */
function SplitView({ hunks }: { hunks: DiffHunk[] }): ReactElement {
  return (
    <div data-testid="file-tab-split" style={{ overflowX: 'auto', borderBottom: `1px solid ${SOFT}` }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'min-content max-content min-content max-content',
          fontSize: '11px',
          lineHeight: 1.55,
          minWidth: '100%',
        }}
      >
        {hunks.map((hunk, hi) => (
          <Fragment key={hi}>
            <div
              style={{
                gridColumn: '1 / -1',
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
            {toSplitRows(hunk).map((row, ri) => {
              const leftBg = row.left?.kind === 'del' ? DEL_BG : 'transparent';
              const rightBg = row.right?.kind === 'add' ? ADD_BG : 'transparent';
              return (
                <Fragment key={ri}>
                  <span style={{ ...SPLIT_NO_STYLE, background: leftBg }}>{row.left?.no ?? ''}</span>
                  <span
                    style={{
                      ...SPLIT_TEXT_STYLE,
                      background: leftBg,
                      color: row.left?.kind === 'del' ? INK : MUTED,
                      borderRight: `1px solid ${SOFT}`,
                    }}
                  >
                    {row.left?.text ?? ''}
                  </span>
                  <span style={{ ...SPLIT_NO_STYLE, background: rightBg }}>{row.right?.no ?? ''}</span>
                  <span
                    style={{
                      ...SPLIT_TEXT_STYLE,
                      background: rightBg,
                      color: row.right?.kind === 'add' ? INK : MUTED,
                    }}
                  >
                    {row.right?.text ?? ''}
                  </span>
                </Fragment>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/**
 * DiffBody — the unified/split hunk renderer for one file's parsed diff. Exported
 * (internals otherwise module-private) so ExperimentComparisonView (A/B testing
 * slice C) can render the SAME diff body for each arm's frozen text instead of
 * forking a duplicate.
 */
export function DiffBody({ fileDiff, mode }: { fileDiff: ParsedFileDiff; mode: 'diff' | 'split' }): ReactElement {
  if (fileDiff.isBinary) {
    return (
      <div data-testid="file-tab-binary" style={{ padding: 16, fontSize: '12px', color: MUTED }}>
        Binary file — diff not shown.
      </div>
    );
  }
  if (mode === 'split') {
    return <SplitView hunks={fileDiff.hunks} />;
  }
  return (
    <div data-testid="file-tab-hunks" style={{ borderBottom: `1px solid ${SOFT}` }}>
      {fileDiff.hunks.map((hunk, i) => (
        <HunkRows key={i} hunk={hunk} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview / no-diff content view
// ---------------------------------------------------------------------------

/**
 * FileContentView — plain (or rendered-Markdown) file contents. Used for the
 * Preview mode and as the no-diff fallback. Mirrors the File Explorer takeover
 * viewer's states (loading / error / binary / too-large / empty / text).
 */
function FileContentView({ sessionId, filePath }: { sessionId: string; filePath: string }): ReactElement {
  const { loading, error, content } = useFileContentData(sessionId, filePath);

  if (loading) {
    return (
      <div data-testid="file-tab-content-loading" style={{ padding: 16, fontSize: '12px', color: MUTED }}>
        Loading file…
      </div>
    );
  }
  if (error) {
    return (
      <div data-testid="file-tab-content-error" style={{ padding: 16, fontSize: '12px', color: RUST }}>
        {error}
      </div>
    );
  }
  if (content === null) {
    return (
      <div data-testid="file-tab-empty" style={{ padding: 16, fontSize: '12px', color: MUTED }}>
        No changes in this file.
      </div>
    );
  }
  if (content.unviewableReason !== null) {
    return (
      <div data-testid="file-tab-content-unviewable" style={{ padding: 16, fontSize: '12px', color: MUTED }}>
        {content.unviewableReason === 'binary'
          ? 'Binary file — preview not available.'
          : 'File too large to preview.'}
      </div>
    );
  }
  if (content.content === null || content.content === '') {
    return (
      <div data-testid="file-tab-content-empty" style={{ padding: 16, fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
        Empty file
      </div>
    );
  }
  if (isMarkdown(filePath)) {
    return (
      <div data-testid="file-tab-content-markdown" style={{ padding: '12px 16px' }}>
        <MarkdownPreview content={content.content} />
      </div>
    );
  }
  return (
    <pre
      data-testid="file-tab-content"
      className="cf-scroll"
      style={{
        margin: 0,
        padding: '12px 16px',
        fontSize: '11px',
        lineHeight: 1.55,
        color: INK,
        whiteSpace: 'pre',
        fontFamily: 'var(--font-mono, monospace)',
      }}
    >
      {content.content}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// View-mode segmented control
// ---------------------------------------------------------------------------

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'diff', label: 'Diff' },
  { id: 'split', label: 'Split' },
  { id: 'preview', label: 'Preview' },
];

function ViewModeControl({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="File view mode"
      style={{ display: 'inline-flex', border: `1px solid ${HAIRLINE}`, borderRadius: 6, overflow: 'hidden' }}
    >
      {MODES.map((m) => {
        const active = m.id === mode;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`file-tab-mode-${m.id}`}
            onClick={() => onChange(m.id)}
            style={{
              padding: '2px 10px',
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '0.04em',
              border: 'none',
              cursor: 'pointer',
              background: active ? 'var(--color-interactive-primary)' : 'transparent',
              color: active ? 'var(--color-text-on-interactive, #fff)' : FAINT,
            }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function FileTabRenderer({ sessionId, filePath }: FileTabRendererProps): ReactElement {
  const { loading, error, fileDiff } = useFileDiffData(sessionId, filePath);
  const [mode, setMode] = useState<ViewMode>(readInitialViewMode);

  const changeMode = (m: ViewMode) => {
    setMode(m);
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_MODE_KEY, m);
  };

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
        {dirname(filePath) && (
          <span style={{ color: FAINT, fontWeight: 400, fontSize: '10px' }}>{dirname(filePath)}</span>
        )}
        <span style={{ flex: 1 }} />
        <ViewModeControl mode={mode} onChange={changeMode} />
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
      ) : mode === 'preview' ? (
        <FileContentView sessionId={sessionId} filePath={filePath} />
      ) : !fileDiff ? (
        // No diff for this file (unchanged) → show its contents rather than a
        // dead-end message; Diff/Split have nothing to render.
        <FileContentView sessionId={sessionId} filePath={filePath} />
      ) : (
        <DiffBody fileDiff={fileDiff} mode={mode} />
      )}
    </div>
  );
}
