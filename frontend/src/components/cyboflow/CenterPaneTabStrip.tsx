/**
 * CenterPaneTabStrip — the 40px tab strip atop the run center pane.
 *
 * Renders the open tabs (pinned Flow + file/diff + artifact tabs) with the design
 * handoff's typed accents: each kind has an edge color (active tab top border +
 * label), artifact tabs show an 18×18 glyph chip (solid border = templated,
 * dashed = live canvas), ephemeral (uncommitted) artifact tabs get the amber
 * treatment (italic label + amber bottom border), and freshly-minted artifact
 * tabs pulse a rust "new" dot until focused. Non-pinned tabs show a close button
 * that stops propagation so it does not also focus the tab.
 *
 * Colors are inline design hexes (warm-paper palette) for fidelity; the M7 polish
 * pass migrates them to `var(--cf-*)` tokens.
 */
import type { ReactElement } from 'react';
import type { TabItem } from '../../../../shared/types/centerPane';
import {
  ARTIFACT_COLORS,
  ARTIFACT_GLYPHS,
  isCanvasArtifact,
} from '../../../../shared/types/artifacts';

// Warm-paper palette (design handoff) — theme-remapped semantic tokens.
const INK = 'var(--color-text-primary)';
const HAIRLINE = 'var(--color-border-primary)';
const PAGE = 'var(--color-bg-primary)';
const RAIL = 'var(--color-bg-secondary)';
const FAINT = 'var(--color-text-tertiary)';
const DISABLED = 'var(--color-text-disabled)';
const CHIP_IDLE = '#cabfa3'; // no exact token match in colors.css — left as literal
const FILE_EDGE = 'var(--color-text-secondary)';
const RUST = 'var(--color-interactive-primary)';
const AMBER = 'var(--human-border)';
const STATUS_M = 'var(--color-status-warning)';
const STATUS_A = 'var(--color-status-success)';

interface CenterPaneTabStripProps {
  tabs: TabItem[];
  activeTabId: string;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}

/** Edge / accent color for a tab by kind. */
function edgeColor(tab: TabItem): string {
  if (tab.kind === 'flow') return INK;
  if (tab.kind === 'file') return FILE_EDGE;
  return ARTIFACT_COLORS[tab.atype ?? 'generic'];
}

/** Glyph for a tab (file → git status letter; artifact canvas → ◳). */
function tabGlyph(tab: TabItem, canvas: boolean): string {
  if (tab.kind === 'flow') return '▦';
  if (tab.kind === 'file') return tab.status ?? '·';
  return canvas ? '◳' : ARTIFACT_GLYPHS[tab.atype ?? 'generic'];
}

/** Color for a file tab's status-letter glyph. */
function fileStatusColor(status: TabItem['status']): string {
  if (status === 'M') return STATUS_M;
  if (status === 'A') return STATUS_A;
  return FAINT;
}

export function CenterPaneTabStrip({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
}: CenterPaneTabStripProps): ReactElement {
  return (
    <div
      role="tablist"
      data-testid="center-pane-tab-strip"
      className="cf-scroll"
      style={{
        height: 40,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        background: RAIL,
        borderBottom: `1px solid ${HAIRLINE}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const edge = edgeColor(tab);
          const isArtifact = tab.kind === 'artifact';
          const canvas = isArtifact && isCanvasArtifact(tab.atype ?? 'generic');
          const ephemeral = isArtifact && !tab.committed;
          const glyph = tabGlyph(tab, canvas);

          const labelColor = active ? (isArtifact ? edge : INK) : FAINT;

          const wrapStyle: React.CSSProperties = {
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '0 11px',
            height: '100%',
            cursor: 'pointer',
            position: 'relative',
            whiteSpace: 'nowrap',
            borderRight: `1px solid ${HAIRLINE}`,
            flexShrink: 0,
            fontSize: '10.5px',
            background: active ? PAGE : ephemeral ? 'rgba(168,107,29,.04)' : 'transparent',
            borderTop: `2px solid ${active ? edge : 'transparent'}`,
            ...(ephemeral
              ? { borderBottom: `1px ${canvas ? 'solid' : 'dashed'} ${AMBER}` }
              : null),
          };

          const labelStyle: React.CSSProperties = {
            color: labelColor,
            fontWeight: active ? 700 : 500,
            letterSpacing: '-.005em',
            ...(ephemeral ? { fontStyle: 'italic' } : null),
          };

          // Artifact glyph renders inside an 18×18 chip (solid=template, dashed=canvas).
          const glyphStyle: React.CSSProperties = isArtifact
            ? {
                flexShrink: 0,
                fontSize: '10px',
                width: 18,
                height: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: `1px ${canvas ? 'dashed' : 'solid'} ${active ? edge : CHIP_IDLE}`,
                color: active ? edge : FAINT,
              }
            : {
                flexShrink: 0,
                fontSize: '10px',
                fontWeight: 700,
                color:
                  tab.kind === 'file'
                    ? fileStatusColor(tab.status)
                    : active
                      ? edge
                      : DISABLED,
              };

          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              data-testid={`center-pane-tab-${tab.id}`}
              onClick={() => onTabClick(tab.id)}
              style={wrapStyle}
            >
              <span style={glyphStyle}>{glyph}</span>
              <span style={labelStyle}>{tab.label}</span>
              {tab.isNew && (
                <span
                  data-testid={`center-pane-tab-new-${tab.id}`}
                  className="animate-cfpulse"
                  style={{ width: 6, height: 6, borderRadius: '50%', background: RUST, flexShrink: 0 }}
                  aria-hidden="true"
                />
              )}
              {!tab.pinned && (
                <span
                  role="button"
                  aria-label={`Close ${tab.label}`}
                  data-testid={`center-pane-tab-close-${tab.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  style={{
                    flexShrink: 0,
                    width: 15,
                    height: 15,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 3,
                    fontSize: '13px',
                    lineHeight: 1,
                    color: FAINT,
                    opacity: active ? 0.8 : 0.45,
                  }}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
      </div>
      {/* Trailing affordance (design shows a passive "+" cell). */}
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px',
          borderLeft: `1px solid ${HAIRLINE}`,
          color: FAINT,
          fontSize: '13px',
          cursor: 'default',
        }}
      >
        +
      </div>
    </div>
  );
}
