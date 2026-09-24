/**
 * CenterPaneTabStrip — the `web` tab arm.
 *
 * Why this test exists: `edgeColor` and `tabGlyph` both END in the artifact
 * branch (`ARTIFACT_COLORS[tab.atype ?? 'generic']`), so an unhandled tab kind
 * does not fail to render — it renders silently MIS-STYLED, wearing the generic
 * artifact glyph. Nothing else in the suite would catch that, so the web arm is
 * pinned here, including the agent/user distinction (a tab the user did not open
 * must not pass for one of their own).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CenterPaneTabStrip } from '../CenterPaneTabStrip';
import { ARTIFACT_GLYPHS } from '../../../../../shared/types/artifacts';
import { makeFlowTab, type TabItem } from '../../../../../shared/types/centerPane';

const USER_TAB: TabItem = {
  id: 'web:aaaa',
  kind: 'web',
  label: 'docs.anthropic.com',
  initialUrl: 'https://docs.anthropic.com/',
  currentUrl: 'https://docs.anthropic.com/',
  openedBy: 'user',
};

const AGENT_TAB: TabItem = {
  ...USER_TAB,
  id: 'web:bbbb',
  label: 'localhost',
  openedBy: 'agent',
  openedByRunId: 'run-1',
};

function renderStrip(tabs: TabItem[], activeTabId = 'flow') {
  return render(
    <CenterPaneTabStrip
      tabs={[makeFlowTab(), ...tabs]}
      activeTabId={activeTabId}
      onTabClick={vi.fn()}
      onTabClose={vi.fn()}
    />,
  );
}

describe('CenterPaneTabStrip — web tabs', () => {
  it('gives a web tab its own glyph rather than the generic artifact fallback', () => {
    renderStrip([USER_TAB]);
    const tab = screen.getByTestId('center-pane-tab-web:aaaa');
    expect(tab).toHaveTextContent('docs.anthropic.com');
    expect(tab.textContent).not.toContain(ARTIFACT_GLYPHS.generic);
    expect(tab.textContent).toContain('◍');
  });

  it('distinguishes an agent-opened tab from a user-opened one', () => {
    renderStrip([USER_TAB, AGENT_TAB]);
    expect(screen.getByTestId('center-pane-tab-web:bbbb').textContent).toContain('◎');
    expect(screen.getByTestId('center-pane-tab-web:aaaa').textContent).not.toContain('◎');
  });

  it('is closeable (a web tab is never pinned)', () => {
    renderStrip([USER_TAB]);
    expect(screen.getByTestId('center-pane-tab-close-web:aaaa')).toBeInTheDocument();
  });

  it('does not get the uncommitted-artifact amber treatment', () => {
    // `ephemeral` is `isArtifact && !committed`; a web tab has no `committed`, so
    // a missed `isArtifact` guard would render every web tab as ephemeral amber.
    renderStrip([USER_TAB], 'web:aaaa');
    const tab = screen.getByTestId('center-pane-tab-web:aaaa');
    expect(tab.style.borderBottom).toBe('');
  });
});
