/**
 * NotificationsSection — the grey FYI band. Covers the kicker/verbs that make it
 * distinct from the red "Needs your input" band (an FYI is never "Asked you" and
 * never offers "Answer →"), the Details toggle, and the Dismiss wiring.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewItem } from '../../../../../shared/types/reviews';

const { dismissMock } = vi.hoisted(() => ({ dismissMock: vi.fn().mockResolvedValue(true) }));

vi.mock('../../../hooks/useReviewItemActions', () => ({
  useReviewItemActions: () => ({ dismiss: dismissMock, pendingItemId: null }),
}));

import { NotificationsSection } from '../NotificationsSection';

function makeNotification(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'rvw-note',
    project_id: 1,
    run_id: 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'notification',
    status: 'pending',
    blocking: false,
    audience: 'human',
    title: 'Dynamic workflow finished: onboarding-impl-recon',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: 'dynamic_workflow',
    payload: null,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

const NOW = Date.parse('2026-07-06T01:00:00.000Z');

const baseProps = {
  items: [] as ReviewItem[],
  projectNameById: { 1: 'cyboflow' },
  nowMs: NOW,
  onOpen: vi.fn(),
  onDismissed: vi.fn(),
};

beforeEach(() => {
  dismissMock.mockClear();
});

describe('NotificationsSection', () => {
  it('renders nothing when there are no notifications', () => {
    const { container } = render(<NotificationsSection {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels a finished workflow as an FYI, never as an ask', () => {
    render(<NotificationsSection {...baseProps} items={[makeNotification()]} />);
    expect(screen.getByText('FYI')).toBeInTheDocument();
    expect(screen.queryByText('Asked you')).not.toBeInTheDocument();
    expect(screen.queryByText('Answer →')).not.toBeInTheDocument();
    expect(screen.getByText('Dynamic workflow finished: onboarding-impl-recon')).toBeInTheDocument();
    expect(screen.getByText('cyboflow')).toBeInTheDocument();
  });

  it('opens the filing run via onOpen', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const item = makeNotification();
    render(<NotificationsSection {...baseProps} items={[item]} onOpen={onOpen} />);

    await user.click(screen.getByText('Open →'));
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it('omits Open for a notification with no run to jump to', () => {
    render(<NotificationsSection {...baseProps} items={[makeNotification({ run_id: null })]} />);
    expect(screen.queryByText('Open →')).not.toBeInTheDocument();
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
  });

  it('dismisses through the review-item chokepoint and reports back', async () => {
    const user = userEvent.setup();
    const onDismissed = vi.fn();
    render(<NotificationsSection {...baseProps} items={[makeNotification()]} onDismissed={onDismissed} />);

    await user.click(screen.getByText('Dismiss'));
    expect(dismissMock).toHaveBeenCalledWith(1, 'rvw-note');
    expect(onDismissed).toHaveBeenCalled();
  });

  it('swaps the truncated preview for the full body on Details toggle', async () => {
    const user = userEvent.setup();
    const item = makeNotification({ body: '3 subagents ran.\nSession: crisp-plateau' });
    render(<NotificationsSection {...baseProps} items={[item]} />);

    expect(screen.getByText(/3 subagents ran\./).tagName).toBe('SPAN');
    await user.click(screen.getByText('Details ▸'));
    expect(screen.getByText(/3 subagents ran\./).tagName).toBe('P');
  });
});
