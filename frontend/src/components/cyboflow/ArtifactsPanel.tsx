/**
 * ArtifactsPanel — the right-rail "RUN DELIVERABLES" reopen surface.
 *
 * Lists every artifact a run has produced so closed center-pane tabs can be
 * reopened. Cards are grouped into "Templated deliverables" then "Live canvases"
 * (split by {@link isCanvasArtifact}). Clicking a card opens (or focuses) that
 * artifact's center-pane tab via `centerPaneStore.openArtifactTab`.
 *
 * "Already open" is derived from the session's current tabs: an artifact tab
 * dedupes on its atype (`art:<atype>`), so a tab whose atype matches the card
 * means the card is already in the tab strip (action reads "open · in tabs").
 *
 * Reads the live list via {@link useArtifactsList}. Colors are the design
 * handoff hexes inline (per-atype accents come from ARTIFACT_COLORS); the M7
 * polish pass migrates the warm-paper chrome hexes to `var(--cf-*)` tokens.
 *
 * Design ref: design_handoff_tabbed_center_pane/README.md "Right rail → Artifacts".
 */
import { useArtifactsList, useSessionArtifactsList } from '../../hooks/useArtifactsList';
import { useCenterPaneStore, useCenterPaneSession } from '../../stores/centerPaneStore';
import {
  ARTIFACT_COLORS,
  ARTIFACT_GLYPHS,
  isCanvasArtifact,
  type Artifact,
} from '../../../../shared/types/artifacts';

// --- design hexes (warm-paper chrome; tokenized to theme-aware var()s) ---
const INK = 'var(--color-text-primary)';
const MUTED = 'var(--color-text-secondary)';
const FAINT = 'var(--color-text-tertiary)';
const HAIRLINE_SOFT = 'var(--color-border-tertiary)';
const BORDER_HAIRLINE = 'var(--color-border-primary)';
const CARD_BG = 'var(--color-surface-primary)';
// rgba of the human-checkpoint amber (#a86b1d); no *-rgb channel token exists,
// so this stays a literal rgba (see report).
const SESSION_BG = 'rgba(168,107,29,.05)';
// #e6c9a8 has no exact token in colors.css — left as a literal (see report).
const SESSION_BORDER = '#e6c9a8';
const GREEN = 'var(--color-status-success)';
const AMBER = 'var(--human-border)';
const LIVE_GLYPH = '◳';

interface ArtifactsPanelProps {
  /**
   * Exactly ONE of `runId` / `sessionId` is set (the caller's scope):
   *   - `runId`     — a specific run's deliverables (e.g. an active flow run).
   *   - `sessionId` — a session's deliverables across ALL its runs (e.g. a
   *                   quick session with no active flow run, or any caller
   *                   whose tab store is session-keyed).
   */
  runId?: string;
  sessionId?: string;
  projectId: number;
  /** centerPaneStore key — the run's parent session id (or run id fallback). */
  sessionKey: string;
}

export function ArtifactsPanel({ runId, sessionId, projectId, sessionKey }: ArtifactsPanelProps) {
  // Both hooks are called unconditionally (Rules of Hooks) — each no-ops
  // (returns []) on a null input — and we select whichever scope the caller
  // actually passed.
  const runScoped = useArtifactsList(runId ?? null, projectId);
  const sessionScoped = useSessionArtifactsList(sessionId ?? null, projectId);
  const { artifacts } = sessionId !== undefined ? sessionScoped : runScoped;
  const openArtifactTab = useCenterPaneStore((s) => s.openArtifactTab);
  // Reactive: re-renders when a tab opens/closes so the "open · in tabs" action
  // and the card's opacity stay in sync with the tab strip.
  const session = useCenterPaneSession(sessionKey);
  const openAtypes = new Set(
    session.tabs.filter((t) => t.kind === 'artifact' && t.atype).map((t) => t.atype),
  );

  const templated = artifacts.filter((a) => !isCanvasArtifact(a.atype));
  const canvases = artifacts.filter((a) => isCanvasArtifact(a.atype));

  const handleOpen = (a: Artifact): void => {
    openArtifactTab(sessionKey, {
      atype: a.atype,
      label: a.label,
      artifactId: a.id,
      committed: a.committed,
      isNew: false,
    });
  };

  return (
    <div
      data-testid="artifacts-panel"
      className="h-full overflow-y-auto"
      style={{ padding: '12px 12px 16px', background: 'var(--color-bg-secondary)' }}
    >
      {/* Eyebrow + helper line */}
      <div
        style={{
          fontSize: 8.5,
          letterSpacing: '.18em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: FAINT,
        }}
      >
        Run deliverables
      </div>
      <p
        style={{
          marginTop: 6,
          marginBottom: 4,
          fontSize: 10,
          lineHeight: 1.5,
          color: MUTED,
        }}
      >
        Open in the center pane. Session-only artifacts are dropped when the run closes
        unless committed.
      </p>

      {artifacts.length === 0 ? (
        <div
          data-testid="artifacts-panel-empty"
          style={{ marginTop: 14, fontSize: 10.5, color: FAINT }}
        >
          No deliverables yet.
        </div>
      ) : (
        <>
          <ArtifactGroup
            heading="Templated deliverables"
            artifacts={templated}
            openAtypes={openAtypes}
            onOpen={handleOpen}
          />
          <ArtifactGroup
            heading="Live canvases"
            artifacts={canvases}
            openAtypes={openAtypes}
            onOpen={handleOpen}
          />
        </>
      )}
    </div>
  );
}

interface ArtifactGroupProps {
  heading: string;
  artifacts: Artifact[];
  openAtypes: Set<Artifact['atype'] | undefined>;
  onOpen: (a: Artifact) => void;
}

function ArtifactGroup({ heading, artifacts, openAtypes, onOpen }: ArtifactGroupProps) {
  if (artifacts.length === 0) return null;
  return (
    <div data-testid={`artifacts-group-${heading.toLowerCase().replace(/\s+/g, '-')}`}>
      <div
        style={{
          marginTop: 16,
          marginBottom: 8,
          paddingTop: 8,
          borderTop: `1px solid ${HAIRLINE_SOFT}`,
          fontSize: 8.5,
          letterSpacing: '.16em',
          textTransform: 'uppercase',
          fontWeight: 700,
          color: FAINT,
        }}
      >
        {heading}
      </div>
      {artifacts.map((a) => (
        <ArtifactCard
          key={a.id}
          artifact={a}
          open={openAtypes.has(a.atype)}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

interface ArtifactCardProps {
  artifact: Artifact;
  open: boolean;
  onOpen: (a: Artifact) => void;
}

function ArtifactCard({ artifact, open, onOpen }: ArtifactCardProps) {
  const accent = ARTIFACT_COLORS[artifact.atype];
  const canvas = isCanvasArtifact(artifact.atype);
  const glyph = canvas ? LIVE_GLYPH : ARTIFACT_GLYPHS[artifact.atype];
  const inRepo = artifact.committed;

  // Border / background per commit state (design "Artifact card"):
  //   in-repo            → solid hairline, white
  //   session templated  → solid amber-ish, amber wash
  //   session canvas     → dashed amber-ish, amber wash
  const border = inRepo
    ? `1px solid ${BORDER_HAIRLINE}`
    : `1px ${canvas ? 'dashed' : 'solid'} ${SESSION_BORDER}`;
  const background = inRepo ? CARD_BG : SESSION_BG;

  const subLine = `${artifact.stepOrigin ?? 'orchestrator'} · ${canvas ? 'live canvas' : 'template'}`;

  return (
    <button
      type="button"
      data-testid={`artifact-card-${artifact.atype}`}
      onClick={() => onOpen(artifact)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '11px 12px',
        marginBottom: 8,
        border,
        background,
        // Closed (not currently open in a tab) → dimmed so open items lead.
        opacity: open ? 1 : 0.82,
        transition: 'border-color 120ms, box-shadow 120ms',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = INK;
      }}
      onMouseLeave={(e) => {
        // Restore the commit-state border color (solid vs dashed kept by `border`).
        e.currentTarget.style.borderColor = inRepo ? BORDER_HAIRLINE : SESSION_BORDER;
      }}
    >
      {/* Card head: glyph chip + label + sub-line */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <span
          aria-hidden
          style={{
            flexShrink: 0,
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1px ${canvas ? 'dashed' : 'solid'} ${accent}`,
            color: accent,
            fontSize: 12,
            lineHeight: 1,
          }}
        >
          {glyph}
        </span>
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 700,
              color: open ? INK : MUTED,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {artifact.label}
          </span>
          <span
            data-testid={`artifact-card-${artifact.atype}-subline`}
            style={{
              display: 'block',
              marginTop: 2,
              fontSize: 9,
              color: FAINT,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subLine}
          </span>
        </span>
      </div>

      {/* Card footer: status badge + action */}
      <div
        style={{
          marginTop: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        {inRepo ? (
          <span
            data-testid={`artifact-badge-${artifact.atype}`}
            data-badge="in-repo"
            style={{
              fontSize: 8.5,
              letterSpacing: '.06em',
              padding: '2px 6px',
              border: `1px solid ${GREEN}`,
              color: GREEN,
            }}
          >
            ✓ in repo
          </span>
        ) : (
          <span
            data-testid={`artifact-badge-${artifact.atype}`}
            data-badge="session-only"
            style={{
              fontSize: 8.5,
              letterSpacing: '.06em',
              padding: '2px 6px',
              border: `1px dashed ${AMBER}`,
              color: AMBER,
            }}
          >
            session-only
          </span>
        )}
        <span
          data-testid={`artifact-action-${artifact.atype}`}
          style={{ fontSize: 9, fontWeight: 700, color: open ? FAINT : accent }}
        >
          {open ? 'open · in tabs' : 'open →'}
        </span>
      </div>
    </button>
  );
}
