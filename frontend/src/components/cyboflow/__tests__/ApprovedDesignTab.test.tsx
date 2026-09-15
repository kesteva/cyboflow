/**
 * ApprovedDesignTab tests — the approved-design center-pane tab's two-fetch
 * (forEntity metadata + snapshotHtml bytes) render + live refresh.
 *
 * Mocks trpc.cyboflow.design (forEntity/snapshotHtml queries) and
 * trpc.cyboflow.ideaComponents.onComponentsChanged (the live channel), the same
 * way useArtifactData.test.ts mocks its subscriptions — a captured onData
 * handler so a test can push an event through the live path.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovedDesignTab } from '../ApprovedDesignTab';
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

// react-markdown-free static-mockup embed: LiveCanvasEmbed renders a plain
// srcDoc iframe — jsdom handles that fine, so it is NOT mocked here; assert on
// its own data-testid instead.

const META = {
  ideaId: 'idea-1',
  ideaRef: 'IDEA-014',
  ideaTitle: 'Spend flow',
  approvedAt: '2026-09-10T12:00:00.000Z',
  source: 'flow' as const,
  sourceRunId: 'run-1',
};

describe('ApprovedDesignTab', () => {
  beforeEach(() => {
    forEntityQuery.mockReset();
    snapshotHtmlQuery.mockReset();
    unsubscribeSpy.mockReset();
    componentsChangedHandler = null;
  });

  it('shows a loading state, then renders the header metadata and the static-mockup embed', async () => {
    forEntityQuery.mockResolvedValue(META);
    snapshotHtmlQuery.mockResolvedValue({ html: '<h1>Spend flow</h1>', approvedAt: META.approvedAt });

    render(<ApprovedDesignTab ideaId="idea-1" ideaRef="IDEA-014" projectId={7} />);

    expect(screen.getByTestId('approved-design-loading')).toBeInTheDocument();

    await waitFor(() => expect(screen.queryByTestId('approved-design-loading')).not.toBeInTheDocument());

    expect(screen.getByTestId('approved-design-header')).toHaveTextContent('IDEA-014');
    expect(screen.getByTestId('approved-design-header')).toHaveTextContent('Concept prototype');
    expect(screen.getByTestId('live-canvas-embed')).toBeInTheDocument();
    expect(forEntityQuery).toHaveBeenCalledWith({ entityId: 'idea-1' });
    expect(snapshotHtmlQuery).toHaveBeenCalledWith({ ideaId: 'idea-1' });
  });

  it('labels a design-mode approval distinctly from a flow-bound one', async () => {
    forEntityQuery.mockResolvedValue({ ...META, source: 'design-mode' as const });
    snapshotHtmlQuery.mockResolvedValue({ html: '<h1>x</h1>', approvedAt: META.approvedAt });

    render(<ApprovedDesignTab ideaId="idea-1" ideaRef="IDEA-014" projectId={7} />);

    await waitFor(() =>
      expect(screen.getByTestId('approved-design-header')).toHaveTextContent('Design Mode'),
    );
  });

  it('shows the empty state when the idea no longer has an approved design', async () => {
    forEntityQuery.mockResolvedValue(null);
    snapshotHtmlQuery.mockResolvedValue(null);

    render(<ApprovedDesignTab ideaId="idea-1" ideaRef="IDEA-014" projectId={7} />);

    expect(await screen.findByTestId('approved-design-empty')).toHaveTextContent(
      'This idea no longer has an approved design.',
    );
    expect(screen.queryByTestId('live-canvas-embed')).not.toBeInTheDocument();
  });

  it('does NOT subscribe when projectId is null (one-shot tab)', async () => {
    forEntityQuery.mockResolvedValue(META);
    snapshotHtmlQuery.mockResolvedValue({ html: '<h1>x</h1>', approvedAt: META.approvedAt });

    render(<ApprovedDesignTab ideaId="idea-1" ideaRef="IDEA-014" projectId={null} />);
    await waitFor(() => expect(screen.queryByTestId('approved-design-loading')).not.toBeInTheDocument());

    expect(componentsChangedHandler).toBeNull();
  });

  it('live-refreshes on an onComponentsChanged event naming THIS idea, silently', async () => {
    forEntityQuery.mockResolvedValueOnce(META).mockResolvedValueOnce({ ...META, ideaTitle: 'Spend flow v2' });
    snapshotHtmlQuery
      .mockResolvedValueOnce({ html: '<h1>v1</h1>', approvedAt: META.approvedAt })
      .mockResolvedValueOnce({ html: '<h1>v2</h1>', approvedAt: META.approvedAt });

    render(<ApprovedDesignTab ideaId="idea-1" ideaRef="IDEA-014" projectId={7} />);
    await waitFor(() => expect(screen.queryByTestId('approved-design-loading')).not.toBeInTheDocument());
    expect(forEntityQuery).toHaveBeenCalledTimes(1);

    act(() => {
      componentsChangedHandler?.({ projectId: 7, ideaId: 'idea-1', states: [] });
    });

    await waitFor(() => expect(forEntityQuery).toHaveBeenCalledTimes(2));
    // No loading flash on the silent refresh.
    expect(screen.queryByTestId('approved-design-loading')).not.toBeInTheDocument();
  });

  it('ignores an onComponentsChanged event for a DIFFERENT idea', async () => {
    forEntityQuery.mockResolvedValue(META);
    snapshotHtmlQuery.mockResolvedValue({ html: '<h1>x</h1>', approvedAt: META.approvedAt });

    render(<ApprovedDesignTab ideaId="idea-1" ideaRef="IDEA-014" projectId={7} />);
    await waitFor(() => expect(screen.queryByTestId('approved-design-loading')).not.toBeInTheDocument());
    expect(forEntityQuery).toHaveBeenCalledTimes(1);

    act(() => {
      componentsChangedHandler?.({ projectId: 7, ideaId: 'idea-OTHER', states: [] });
    });

    // Give any (incorrect) refetch a chance to fire, then assert it did not.
    await new Promise((r) => setTimeout(r, 0));
    expect(forEntityQuery).toHaveBeenCalledTimes(1);
  });
});
