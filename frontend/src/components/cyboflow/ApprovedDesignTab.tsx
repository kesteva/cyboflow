/**
 * ApprovedDesignTab — renders an idea's DURABLY-BOUND approved design (Tier 2,
 * item 8c). Backs the `approved-design` center-pane tab kind, NOT an artifacts
 * table row: the content is `approved_designs`' current row for the idea (a
 * Design Mode approval, or a flow's `bindApprovedDesignsForRun` bind), read via
 * two `cyboflow.design.*` procedures —
 *
 *   - `forEntity({ entityId })` resolves an idea/epic/task to its idea's current
 *     approved design (`{ ideaId, ideaRef, ideaTitle, approvedAt, source,
 *     sourceRunId } | null`) — used here with the tab's own `ideaId` (already
 *     resolved by whoever opened the tab) purely for the header metadata.
 *   - `snapshotHtml({ ideaId })` returns the on-disk snapshot's HTML
 *     (`{ html, approvedAt } | null`), rendered exactly the way the `ui-prototype`
 *     canvas renders a static mockup: `LiveCanvasEmbed`'s `{ html }` branch — a
 *     BARE-sandbox `srcDoc` iframe, no scripts, no same-origin.
 *
 * Both reads race independently (they answer different questions — identity vs.
 * bytes) and the tab renders once either resolves; a null from either after
 * loading means the design was superseded/removed since the tab was opened
 * (mid-session), which is a normal empty state, not an error.
 *
 * Stays live via `cyboflow.ideaComponents.onComponentsChanged` (`prototype`
 * flows through the same ledger channel as every other idea-scoped change): any
 * event naming this idea re-fetches both reads, silently — the current content
 * stays on screen while the refresh is in flight.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { LiveCanvasEmbed } from './LiveCanvasEmbed';

const RAIL = 'var(--color-bg-secondary)';
const HAIRLINE = 'var(--color-border-primary)';
const FAINT = 'var(--color-text-tertiary)';
const INK = 'var(--color-text-primary)';
const MUTED = 'var(--color-text-secondary)';
// Same accent as the tab strip's approved-design chip (CenterPaneTabStrip.tsx).
const ACCENT = '#b2478a';

interface ApprovedDesignTabProps {
  ideaId: string;
  /** Display ref (or a label fallback) shown in the header until forEntity resolves. */
  ideaRef: string;
  projectId: number | null;
}

interface DesignMeta {
  ideaRef: string;
  ideaTitle: string;
  approvedAt: string;
  source: 'design-mode' | 'flow';
}

function sourceLabel(source: DesignMeta['source']): string {
  return source === 'design-mode' ? 'Design Mode' : 'Concept prototype';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function ApprovedDesignTab({ ideaId, ideaRef, projectId }: ApprovedDesignTabProps): ReactElement {
  const [meta, setMeta] = useState<DesignMeta | null | undefined>(undefined); // undefined = loading
  const [html, setHtml] = useState<string | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      trpc.cyboflow.design.forEntity.query({ entityId: ideaId }).then(
        (result) => {
          if (cancelled) return;
          setMeta(
            result
              ? {
                  ideaRef: result.ideaRef,
                  ideaTitle: result.ideaTitle,
                  approvedAt: result.approvedAt,
                  source: result.source,
                }
              : null,
          );
        },
        () => {
          if (!cancelled) setMeta(null);
        },
      );
      trpc.cyboflow.design.snapshotHtml.query({ ideaId }).then(
        (result) => {
          if (cancelled) return;
          setHtml(result ? result.html : null);
        },
        () => {
          if (!cancelled) setHtml(null);
        },
      );
    };

    load();

    if (projectId === null) {
      return () => {
        cancelled = true;
      };
    }

    const sub = trpc.cyboflow.ideaComponents.onComponentsChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          if (event.ideaId === ideaId) load();
        },
        onError: (err: unknown) => console.warn('[ApprovedDesignTab] onComponentsChanged error:', err),
      },
    );

    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [ideaId, projectId]);

  const loading = meta === undefined || html === undefined;

  return (
    <div
      data-testid="approved-design-tab"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div
        data-testid="approved-design-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '9px 16px',
          background: RAIL,
          borderBottom: `1px solid ${HAIRLINE}`,
          flexShrink: 0,
        }}
      >
        <span
          data-testid="approved-design-eyebrow"
          style={{
            fontSize: '9px',
            fontWeight: 700,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: ACCENT,
            whiteSpace: 'nowrap',
          }}
        >
          Approved design
        </span>
        <span style={{ fontSize: '11px', fontWeight: 600, color: INK }}>{meta?.ideaRef ?? ideaRef}</span>
        {meta && (
          <span style={{ fontSize: '10px', color: MUTED }}>
            Approved {formatDate(meta.approvedAt)} · {sourceLabel(meta.source)}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {loading ? (
          <div
            data-testid="approved-design-loading"
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: FAINT }}
          >
            Loading design…
          </div>
        ) : html ? (
          <LiveCanvasEmbed html={html} />
        ) : (
          <div
            data-testid="approved-design-empty"
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontSize: '12px',
              color: FAINT,
              fontStyle: 'italic',
            }}
          >
            This idea no longer has an approved design.
          </div>
        )}
      </div>
    </div>
  );
}
