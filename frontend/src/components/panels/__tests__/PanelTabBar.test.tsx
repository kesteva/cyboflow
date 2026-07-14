import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { PanelTabBar } from '../PanelTabBar';

function panel(id: string, title: string): ToolPanel {
  return {
    id,
    sessionId: 'session-1',
    type: 'claude',
    title,
    state: { isActive: id === 'panel-1', customState: {} },
    metadata: {
      createdAt: '2026-07-13T00:00:00.000Z',
      lastActiveAt: '2026-07-13T00:00:00.000Z',
      position: 0,
    },
  };
}

describe('PanelTabBar chat labels', () => {
  it('renders legacy provider-generated titles as provider-neutral Chat tabs', () => {
    const panels = [
      panel('panel-1', 'Claude 1'),
      panel('panel-2', 'Codex'),
    ];

    render(
      <PanelTabBar
        panels={panels}
        activePanel={panels[0]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        context="project"
      />,
    );

    expect(screen.getByText('Chat 1')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.queryByText('Claude 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex')).not.toBeInTheDocument();
  });

  it('preserves a user-supplied chat panel title', () => {
    const customPanel = panel('panel-1', 'Planning notes');

    render(
      <PanelTabBar
        panels={[customPanel]}
        activePanel={customPanel}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        context="project"
      />,
    );

    expect(screen.getByText('Planning notes')).toBeInTheDocument();
  });
});
