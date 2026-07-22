/**
 * VerifyQueueView tests (L6 Verify-Queue panel, S7).
 *
 * Behaviors verified:
 *   1. Empty state — the empty-list placeholder renders when the hook returns [].
 *   2. Populated state — one row per request with id / verify-type / status badge
 *      / current-backend + attempt / a verdict summary parsed from verdict_json.
 *   3. error-state banner renders (non-fatal) while the last list still shows.
 *   4. The project filter renders the loaded projects.
 *
 * The data hook (useVerificationRequests) + API.projects + the navigation store
 * are mocked so the test exercises the view's rendering contract in isolation.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerificationRequest } from '../../../hooks/useVerificationRequests';

// ---------------------------------------------------------------------------
// Mocks (hoisted so the static component import binds to them).
// ---------------------------------------------------------------------------

const { useVerificationRequestsSpy, getAllSpy } = vi.hoisted(() => ({
  useVerificationRequestsSpy: vi.fn(),
  getAllSpy: vi.fn(),
}));

vi.mock('../../../hooks/useVerificationRequests', () => ({
  useVerificationRequests: useVerificationRequestsSpy,
}));

vi.mock('../../../utils/api', () => ({
  API: { projects: { getAll: getAllSpy } },
}));

vi.mock('../../../stores/navigationStore', () => ({
  // The view reads only activeProjectId via a selector.
  useNavigationStore: (selector: (s: { activeProjectId: number | null }) => unknown) =>
    selector({ activeProjectId: 1 }),
}));

import { VerifyQueueView } from '../VerifyQueueView';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseRow(over: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    id: 'vr-1',
    run_id: 'run-1',
    project_id: 1,
    status: 'queued',
    verify_type: 'static-render-snapshot',
    deliverable_json: JSON.stringify({ intent: 'Renders the dashboard' }),
    chain_json: '["capturePage"]',
    current_backend: null,
    attempt: 0,
    verdict_json: null,
    error_message: null,
    enqueued_at: '2026-06-28T00:00:01.000Z',
    leased_at: null,
    ended_at: null,
    // Migration-078 columns (verification-agent redesign §5.2/§5.6) — NULL by
    // default (a legacy row); individual tests override via `over` for an
    // agent-engine row.
    task_json: null,
    report_json: null,
    delivery_state: null,
    snapshot_sha: null,
    enqueue_key: null,
    ...over,
  };
}

beforeEach(() => {
  useVerificationRequestsSpy.mockReset();
  getAllSpy.mockReset();
  getAllSpy.mockResolvedValue({ success: true, data: [{ id: 1, name: 'ProjA', path: '/tmp/a' }] });
});

describe('VerifyQueueView', () => {
  it('renders the empty state when there are no requests', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-empty')).toBeInTheDocument();
    expect(screen.getByTestId('verify-queue-view')).toBeInTheDocument();
  });

  it('renders one row per request with status badge + verdict summary', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({ id: 'vr-1', status: 'queued', deliverable_json: JSON.stringify({ intent: 'Queued check' }) }),
        baseRow({
          id: 'vr-2',
          status: 'passed',
          current_backend: 'capturePage',
          attempt: 1,
          verdict_json: JSON.stringify({
            status: 'pass',
            confidence: 0.92,
            issues: [],
            feedback: 'Looks correct',
            judgedFileNames: ['shot.png'],
            baselineUsed: false,
            model: 'fake',
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    // Both rows present.
    expect(await screen.findByTestId('verify-queue-row-vr-1')).toBeInTheDocument();
    expect(screen.getByTestId('verify-queue-row-vr-2')).toBeInTheDocument();

    // Status badges.
    expect(screen.getByTestId('verify-queue-status-vr-1')).toHaveTextContent('queued');
    expect(screen.getByTestId('verify-queue-status-vr-2')).toHaveTextContent('passed');

    // Intent + verdict summary (parsed from verdict_json) on the passed row.
    expect(screen.getByText('Renders the dashboard')).toBeInTheDocument();
    expect(screen.getByText(/pass · 92% — Looks correct/)).toBeInTheDocument();

    // Verify-type chip + backend/attempt line.
    expect(screen.getAllByText('static-render-snapshot').length).toBeGreaterThan(0);
    expect(screen.getByText('backend: capturePage')).toBeInTheDocument();
    expect(screen.getByText('attempt 1')).toBeInTheDocument();
  });

  it('renders a non-fatal error banner while keeping the list', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1' })],
      isLoading: false,
      error: new Error('refresh failed'),
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-error')).toHaveTextContent('refresh failed');
    expect(screen.getByTestId('verify-queue-row-vr-1')).toBeInTheDocument();
  });

  it('populates the project filter with the loaded projects', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });

    render(<VerifyQueueView />);

    const select = await screen.findByTestId('verify-queue-project-filter');
    await waitFor(() => expect(screen.getByRole('option', { name: 'ProjA' })).toBeInTheDocument());
    expect(select).toBeInTheDocument();
  });

  // --- engine identity + agent-row rendering (verification-agent redesign §5.11) ---

  it('tags a legacy row (no task_json) with the "legacy" engine chip', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-engine-vr-1')).toHaveTextContent('legacy');
  });

  it('tags an agent-engine row (task_json populated) with the "agent" chip and shows the task summary', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'queued',
          task_json: JSON.stringify({
            version: 1,
            summary: 'Submitting the login form navigates to the dashboard',
            behaviors: [],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-engine-vr-1')).toHaveTextContent('agent');
    expect(screen.getByText('Submitting the login form navigates to the dashboard')).toBeInTheDocument();
    expect(screen.getByText('Awaiting the verification agent')).toBeInTheDocument();
  });

  it('shows agent-appropriate lifecycle copy while running', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'running',
          task_json: JSON.stringify({ version: 1, summary: 'Checks the dashboard', behaviors: [] }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByText('Agent building + driving the deliverable')).toBeInTheDocument();
  });

  it('shows the report outcome (outcome only) for a terminal agent row', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'failed',
          task_json: JSON.stringify({ version: 1, summary: 'Checks the dashboard', behaviors: [] }),
          report_json: JSON.stringify({
            version: 1,
            behaviors: [],
            screenshots: [],
            outcome: 'build_failed',
            confidence: 0.9,
            feedback: 'The build failed — should not render here.',
            issues: [],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    const row = await screen.findByTestId('verify-queue-row-vr-1');
    expect(row).toHaveTextContent('report outcome: build failed');
    // Only the outcome renders — not the report's feedback text.
    expect(row).not.toHaveTextContent('should not render here');
  });

  it('a legacy row with a VerdictV1 still wins over any report_json (verdict takes precedence)', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-2',
          status: 'passed',
          current_backend: 'capturePage',
          attempt: 1,
          verdict_json: JSON.stringify({
            status: 'pass',
            confidence: 0.92,
            issues: [],
            feedback: 'Looks correct',
            judgedFileNames: ['shot.png'],
            baselineUsed: false,
            model: 'fake',
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-engine-vr-2')).toHaveTextContent('legacy');
    expect(screen.getByText(/pass · 92% — Looks correct/)).toBeInTheDocument();
  });
});
