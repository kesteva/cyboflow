/**
 * ArtifactHeader — the shared header bar atop every artifact tab.
 *
 * Renders the design's artifact-tab header row (bg `#ebe4d2`, hairline bottom):
 *   - an EYEBROW tinted with the atype's accent color (e.g. "Artifact · idea
 *     spec", or "◳ Live canvas · ui prototype" for canvas types),
 *   - a COMMIT-STATE badge — green `✓ in repo` when committed, else amber dashed
 *     `session-only · clears on close`,
 *   - optional muted META text + an arbitrary action slot,
 *   - a "Commit to repo" button (ghost, ink border) shown ONLY when the artifact
 *     is not yet committed; clicking it forwards to the artifacts.commit
 *     chokepoint via tRPC. The live ArtifactChanged subscription (owned by the
 *     store/right-rail) flips the badge once the commit lands, so this button
 *     does not optimistically mutate — it only disables itself while in flight.
 *
 * Design hexes are inline (warm-paper palette); the M7 polish pass tokenizes them.
 */
import { useState, type ReactNode, type ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import type { Artifact } from '../../../../shared/types/artifacts';
import { isCanvasArtifact } from '../../../../shared/types/artifacts';

const RAIL = '#ebe4d2';
const HAIRLINE = '#d8cfb8';
const FAINT = '#9c8e6c';
const INK = '#1a1815';
const PAGE = '#f5f1e8';
const GREEN = '#2d8a5b';
const AMBER = '#a86b1d';

interface ArtifactHeaderProps {
  artifact: Artifact;
  projectId: number;
  /** Accent color for the eyebrow (the atype's edge color). */
  accent: string;
  /** Eyebrow text, e.g. "Artifact · idea spec" / "◳ Live canvas · ui prototype". */
  eyebrow: string;
  /** Optional muted meta text (e.g. the source path · author). */
  meta?: ReactNode;
  /** Optional extra actions placed left of the Commit button (e.g. "Open in browser ↗"). */
  actions?: ReactNode;
}

export function ArtifactHeader({
  artifact,
  projectId,
  accent,
  eyebrow,
  meta,
  actions,
}: ArtifactHeaderProps): ReactElement {
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const isCanvas = isCanvasArtifact(artifact.atype);

  const onCommit = (): void => {
    if (committing || artifact.committed) return;
    setCommitting(true);
    setCommitError(null);
    trpc.cyboflow.artifacts.commit
      .mutate({
        projectId,
        artifactId: artifact.id,
        ...(artifact.payloadJson !== null ? { payloadJson: artifact.payloadJson } : {}),
      })
      .then(
        () => {
          // The ArtifactChanged subscription flips committed -> badge updates;
          // just release the in-flight lock here.
          setCommitting(false);
        },
        (err: unknown) => {
          setCommitting(false);
          setCommitError(err instanceof Error ? err.message : 'Commit failed.');
        },
      );
  };

  return (
    <div
      data-testid="artifact-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 16px',
        background: RAIL,
        borderBottom: `1px solid ${HAIRLINE}`,
        position: 'sticky',
        top: 0,
        zIndex: 1,
      }}
    >
      {/* Eyebrow (atype accent) */}
      <span
        data-testid="artifact-eyebrow"
        style={{
          fontSize: '9px',
          fontWeight: 700,
          letterSpacing: '.14em',
          textTransform: 'uppercase',
          color: accent,
          whiteSpace: 'nowrap',
        }}
      >
        {eyebrow}
      </span>

      {/* Commit-state badge */}
      {artifact.committed ? (
        <span
          data-testid="artifact-badge-committed"
          style={{
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '.04em',
            color: GREEN,
            border: `1px solid ${GREEN}`,
            borderRadius: 9,
            padding: '1px 7px',
            whiteSpace: 'nowrap',
          }}
        >
          ✓ in repo
        </span>
      ) : (
        <span
          data-testid="artifact-badge-session-only"
          style={{
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '.04em',
            color: AMBER,
            border: `1px dashed ${AMBER}`,
            borderRadius: 9,
            padding: '1px 7px',
            whiteSpace: 'nowrap',
          }}
        >
          session-only · clears on close
        </span>
      )}

      {/* Optional meta */}
      {meta && (
        <span
          data-testid="artifact-meta"
          style={{ fontSize: '10px', color: FAINT, fontWeight: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {meta}
        </span>
      )}

      <span style={{ flex: 1 }} />

      {commitError && (
        <span data-testid="artifact-commit-error" style={{ fontSize: '10px', color: '#c96442', fontWeight: 600 }}>
          {commitError}
        </span>
      )}

      {/* Extra per-atype actions (canvas: "Open in browser ↗") */}
      {actions}

      {/* Commit button — only when not yet committed */}
      {!artifact.committed && (
        <button
          type="button"
          data-testid="artifact-commit-button"
          onClick={onCommit}
          disabled={committing}
          aria-label={isCanvas ? 'Commit live canvas to repo' : 'Commit to repo'}
          style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '.02em',
            color: INK,
            background: PAGE,
            border: `1px solid ${INK}`,
            borderRadius: 3,
            padding: '3px 10px',
            cursor: committing ? 'default' : 'pointer',
            opacity: committing ? 0.55 : 1,
            whiteSpace: 'nowrap',
            transition: 'background-color 120ms, color 120ms',
          }}
        >
          {committing ? 'Committing…' : 'Commit to repo'}
        </button>
      )}
    </div>
  );
}
