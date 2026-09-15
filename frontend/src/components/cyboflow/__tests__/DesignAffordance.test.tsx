/**
 * DesignAffordance tests — hidden/visible per forEntity resolution, and the two
 * click targets (open the center-pane tab when a sessionKey is in scope, else
 * a self-contained preview modal).
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesignAffordance } from '../DesignAffordance';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import type { IdeaComponentChangedEvent } from '../../../../../shared/types/ideaComponents';

const forEntityQuery = vi.fn();
const snapshotHtmlQuery = vi.fn();
const unsubscribeSpy = vi.fn();
let componentsChangedHandler: ((event: IdeaComponentChangedEvent) => void) | null = null;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      design: {
        forEntity: { query: (...args: unknown[]) => forEntityQuery(...args) },
        snapshotHtml: { query: (...args: unknown[]) => snapshotHtmlQuery(...args) },
      },
      ideaComponents: {
        onComponentsChanged: {
          subscribe: (_input: unknown, handlers: { onData: (e: IdeaComponentChangedEvent) => void }) => {
            componentsChangedHandler = handlers.onData;
            return { unsubscribe: unsubscribeSpy };
          },
        },
      },
    },
  },
}));

function resetCenterPaneStore(): void {
  useCenterPaneStore.setState({ bySession: {} });
}

describe('DesignAffordance', () => {
  beforeEach(() => {
    forEntityQuery.mockReset();
    snapshotHtmlQuery.mockReset();
    unsubscribeSpy.mockReset();
    componentsChangedHandler = null;
    resetCenterPaneStore();
  });

  it('renders nothing while forEntity resolves, and stays hidden when it resolves null', async () => {
    forEntityQuery.mockResolvedValue(null);
    const { container } = render(<DesignAffordance entityId="task-1" projectId={7} />);

    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(forEntityQuery).toHaveBeenCalledWith({ entityId: 'task-1' }));
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the Design button once forEntity resolves a bound idea', async () => {
    forEntityQuery.mockResolvedValue({
      ideaId: 'idea-1',
      ideaRef: 'IDEA-014',
      ideaTitle: 'Spend flow',
      approvedAt: '2026-09-10T00:00:00.000Z',
      source: 'flow',
      sourceRunId: 'run-1',
    });

    render(<DesignAffordance entityId="task-1" projectId={7} />);

    expect(await screen.findByTestId('design-affordance')).toBeInTheDocument();
  });

  it('WITH a sessionKey: clicking opens the approved-design tab in that session', async () => {
    forEntityQuery.mockResolvedValue({
      ideaId: 'idea-1',
      ideaRef: 'IDEA-014',
      ideaTitle: 'Spend flow',
      approvedAt: '2026-09-10T00:00:00.000Z',
      source: 'flow',
      sourceRunId: 'run-1',
    });

    render(<DesignAffordance entityId="task-1" projectId={7} sessionKey="sess-1" />);
    const button = await screen.findByTestId('design-affordance');

    fireEvent.click(button);

    const pane = useCenterPaneStore.getState().bySession['sess-1'];
    expect(pane.tabs.some((t) => t.kind === 'approved-design' && t.ideaId === 'idea-1')).toBe(true);
    expect(pane.activeTabId).toBe('design:idea-1');
    // No preview modal in this mode.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('WITHOUT a sessionKey: clicking opens a preview modal rendering the design', async () => {
    forEntityQuery.mockResolvedValue({
      ideaId: 'idea-1',
      ideaRef: 'IDEA-014',
      ideaTitle: 'Spend flow',
      approvedAt: '2026-09-10T00:00:00.000Z',
      source: 'flow',
      sourceRunId: 'run-1',
    });
    snapshotHtmlQuery.mockResolvedValue({ html: '<h1>x</h1>', approvedAt: '2026-09-10T00:00:00.000Z' });

    render(<DesignAffordance entityId="task-1" projectId={7} />);
    const button = await screen.findByTestId('design-affordance');

    fireEvent.click(button);

    expect(await screen.findByTestId('approved-design-tab')).toBeInTheDocument();
    expect(useCenterPaneStore.getState().bySession).toEqual({});
  });

  it('re-resolves on a project-scoped onComponentsChanged event', async () => {
    forEntityQuery.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ideaId: 'idea-1',
      ideaRef: 'IDEA-014',
      ideaTitle: 'Spend flow',
      approvedAt: '2026-09-10T00:00:00.000Z',
      source: 'flow',
      sourceRunId: 'run-1',
    });

    render(<DesignAffordance entityId="task-1" projectId={7} />);
    await waitFor(() => expect(forEntityQuery).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('design-affordance')).not.toBeInTheDocument();

    act(() => {
      componentsChangedHandler?.({ projectId: 7, ideaId: 'idea-1', states: [] });
    });

    expect(await screen.findByTestId('design-affordance')).toBeInTheDocument();
  });

  it('does NOT subscribe when projectId is null (one-shot resolution)', async () => {
    forEntityQuery.mockResolvedValue(null);
    render(<DesignAffordance entityId="task-1" projectId={null} />);
    await waitFor(() => expect(forEntityQuery).toHaveBeenCalledTimes(1));
    expect(componentsChangedHandler).toBeNull();
  });
});
