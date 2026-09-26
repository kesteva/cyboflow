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
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerificationRequest } from '../../../hooks/useVerificationRequests';

// ---------------------------------------------------------------------------
// Mocks (hoisted so the static component import binds to them).
// ---------------------------------------------------------------------------

const {
  useVerificationRequestsSpy,
  getAllSpy,
  budgetQuerySpy,
  healthQuerySpy,
  hostProbesQuerySpy,
  setupByProjectQuerySpy,
  provisionChromiumSpy,
  requestAccessibilitySpy,
  openScreenRecordingSettingsSpy,
  approveXcodeAccessSpy,
  goToWizardSpy,
} = vi.hoisted(() => ({
  useVerificationRequestsSpy: vi.fn(),
  getAllSpy: vi.fn(),
  budgetQuerySpy: vi.fn(),
  healthQuerySpy: vi.fn(),
  hostProbesQuerySpy: vi.fn(),
  setupByProjectQuerySpy: vi.fn(),
  provisionChromiumSpy: vi.fn(),
  requestAccessibilitySpy: vi.fn(),
  openScreenRecordingSettingsSpy: vi.fn(),
  approveXcodeAccessSpy: vi.fn(),
  goToWizardSpy: vi.fn(),
}));

vi.mock('../../../hooks/useVerificationRequests', () => ({
  useVerificationRequests: useVerificationRequestsSpy,
}));

vi.mock('../../../utils/api', () => ({
  API: { projects: { getAll: getAllSpy } },
}));

// The verify-budget header line (§3.6) is fetched by a direct trpc call, not
// through useVerificationRequests (judge_calls_used is deliberately excluded
// from the list row shape — see the router's own doc).
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      verificationRequests: {
        budget: { query: budgetQuerySpy },
        // The §6 health panel's procedures (VerifyHealthPanel).
        health: { query: healthQuerySpy },
        hostProbes: { query: hostProbesQuerySpy },
        setupByProject: { query: setupByProjectQuerySpy },
        provisionChromium: { mutate: provisionChromiumSpy },
        requestAccessibility: { mutate: requestAccessibilitySpy },
        openScreenRecordingSettings: { mutate: openScreenRecordingSettingsSpy },
        approveXcodeAccess: { mutate: approveXcodeAccessSpy },
      },
    },
  },
}));

vi.mock('../../../stores/navigationStore', () => {
  // The view reads activeProjectId via a selector; the health panel's setup CTA
  // reaches for the store imperatively (getState().goToWizard).
  const useNavigationStore = (selector: (s: { activeProjectId: number | null }) => unknown): unknown =>
    selector({ activeProjectId: 1 });
  useNavigationStore.getState = (): { goToWizard: typeof goToWizardSpy } => ({
    goToWizard: goToWizardSpy,
  });
  return { useNavigationStore };
});

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
    // Origin-session columns (LEFT-JOINed by the list query) — a run with no
    // session row reads back NULL on both.
    session_id: 'sess-1',
    session_name: 'twilight-leaf',
    ...over,
  };
}

beforeEach(() => {
  useVerificationRequestsSpy.mockReset();
  getAllSpy.mockReset();
  getAllSpy.mockResolvedValue({ success: true, data: [{ id: 1, name: 'ProjA', path: '/tmp/a' }] });
  budgetQuerySpy.mockReset();
  // Unlimited by default — the header line stays hidden unless a test opts a
  // project into a non-null budget.
  budgetQuerySpy.mockResolvedValue({ projectId: 1, projectName: 'ProjA', budgetCalls: null, usedCalls: 0 });
  healthQuerySpy.mockReset();
  healthQuerySpy.mockResolvedValue(emptyHealth());
  hostProbesQuerySpy.mockReset();
  hostProbesQuerySpy.mockResolvedValue({ probes: [], nativeScreenDeclared: false });
  setupByProjectQuerySpy.mockReset();
  setupByProjectQuerySpy.mockResolvedValue([]);
  provisionChromiumSpy.mockReset();
  requestAccessibilitySpy.mockReset();
  openScreenRecordingSettingsSpy.mockReset();
  goToWizardSpy.mockReset();
});

/** A health summary with nothing recorded — the default for the pre-existing suite. */
function emptyHealth(): {
  projectId: number;
  modalities: never[];
  unattributed: ReturnType<typeof emptyStats>;
  setupProof: ReturnType<typeof emptyStats>;
  setupProofCallsUsed: number;
  hostGeneration: number;
} {
  return {
    projectId: 1,
    modalities: [],
    unattributed: emptyStats(),
    setupProof: emptyStats(),
    setupProofCallsUsed: 0,
    hostGeneration: 0,
  };
}

function emptyStats(): {
  attempts: number;
  inFlight: number;
  passed: number;
  passRate: number | null;
  outcomes: Record<string, number>;
  failures: Record<string, number>;
  medianDurationMs: number | null;
} {
  return {
    attempts: 0,
    inFlight: 0,
    passed: 0,
    passRate: null,
    outcomes: {},
    failures: { env: 0, deliverable: 0, ambiguous: 0, unclassified: 0 },
    medianDurationMs: null,
  };
}

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

  // --- pending-first sectioning ------------------------------------------

  it('lists in-flight requests above history, oldest-enqueued first', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      // The hook hands back newest-enqueued FIRST (the list query's order).
      requests: [
        baseRow({ id: 'vr-new-pending', status: 'running', enqueued_at: '2026-06-28T00:00:30.000Z' }),
        baseRow({ id: 'vr-old-pending', status: 'queued', enqueued_at: '2026-06-28T00:00:10.000Z' }),
        baseRow({ id: 'vr-done', status: 'passed', enqueued_at: '2026-06-28T00:00:05.000Z' }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    const pending = await screen.findByTestId('verify-queue-pending-list');
    const history = screen.getByTestId('verify-queue-history-list');

    // Section membership: terminal rows never appear in the pending section.
    expect(pending).toContainElement(screen.getByTestId('verify-queue-row-vr-old-pending'));
    expect(pending).toContainElement(screen.getByTestId('verify-queue-row-vr-new-pending'));
    expect(history).toContainElement(screen.getByTestId('verify-queue-row-vr-done'));

    // Pending is drain order (oldest first), not the newest-first list order.
    const ids = Array.from(pending.children).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['verify-queue-row-vr-old-pending', 'verify-queue-row-vr-new-pending']);

    // The pending section renders before history in the DOM.
    expect(pending.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByTestId('verify-queue-pending-list-count')).toHaveTextContent('2');
    expect(screen.getByTestId('verify-queue-history-list-count')).toHaveTextContent('1');
  });

  it('shows a per-section empty line when one side of the split is empty', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-pending-list-empty')).toBeInTheDocument();
    expect(screen.getByTestId('verify-queue-history-list')).toBeInTheDocument();
  });

  // --- session pill --------------------------------------------------------

  it('shows the origin-session pill, falling back to the run id when unattributed', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({ id: 'vr-1', session_name: 'twilight-leaf' }),
        baseRow({ id: 'vr-2', run_id: 'run-orphan', session_id: null, session_name: null }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-session-vr-1')).toHaveTextContent('twilight-leaf');
    expect(screen.getByTestId('verify-queue-session-vr-2')).toHaveTextContent('run-orphan');
  });

  // --- detail dialog -------------------------------------------------------

  it('opens the detail dialog on card click and shows tested behaviors + criteria results', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'failed',
          task_json: JSON.stringify({
            version: 1,
            summary: 'Login redirects to the dashboard',
            behaviors: [
              { id: 'b1', description: 'Submit valid credentials', expected: 'Dashboard renders' },
              { id: 'b2', description: 'Submit bad credentials', expected: 'Inline error renders' },
            ],
          }),
          report_json: JSON.stringify({
            version: 1,
            behaviors: [
              { id: 'b1', result: 'pass', evidence: { screenshots: ['dash.png'], notes: 'dashboard visible' } },
              { id: 'b2', result: 'fail', evidence: { screenshots: [], notes: 'no error shown' } },
            ],
            screenshots: [{ fileName: 'dash.png', caption: 'Dashboard after login' }],
            outcome: 'fail',
            confidence: 0.8,
            feedback: 'The error path regressed.',
            issues: [],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-detail-modal')).toBeInTheDocument();
    // What was tested.
    expect(screen.getByTestId('verify-detail-summary')).toHaveTextContent(
      'Login redirects to the dashboard',
    );
    expect(screen.getByText('Submit valid credentials')).toBeInTheDocument();
    // Which criteria passed / failed.
    expect(screen.getByTestId('verify-detail-result-b1')).toHaveTextContent('pass');
    expect(screen.getByTestId('verify-detail-result-b2')).toHaveTextContent('fail');
    // What was captured (the byte load fails without electronAPI — the tile
    // still lists the file so the user knows what SHOULD be there).
    expect(screen.getByTestId('verify-detail-screenshots')).toHaveTextContent('dash.png');
    expect(screen.getByTestId('verify-detail-feedback')).toHaveTextContent('The error path regressed.');
  });

  it('renders a task behavior with no report entry as pending', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'running',
          task_json: JSON.stringify({
            version: 1,
            summary: 'Checks the dashboard',
            behaviors: [{ id: 'b1', description: 'Loads', expected: 'Renders' }],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-detail-result-b1')).toHaveTextContent('pending');
    expect(screen.getByTestId('verify-detail-no-screenshots')).toBeInTheDocument();
  });

  it('closes the detail dialog when the project filter changes', async () => {
    const user = userEvent.setup();
    getAllSpy.mockResolvedValue({
      success: true,
      data: [
        { id: 1, name: 'ProjA', path: '/tmp/a' },
        { id: 2, name: 'ProjB', path: '/tmp/b' },
      ],
    });
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));
    expect(await screen.findByTestId('verify-detail-modal')).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('verify-queue-project-filter'), '2');

    await waitFor(() =>
      expect(screen.queryByTestId('verify-detail-modal')).not.toBeInTheDocument(),
    );
  });

  // --- verify-budget header line (§3.6) ------------------------------------

  it('renders the budget line for a project with a non-null budget', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    budgetQuerySpy.mockResolvedValue({ projectId: 1, projectName: 'ProjA', budgetCalls: 50, usedCalls: 12 });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-budget-line')).toHaveTextContent('verify budget: 12/50');
  });

  it('hides the budget line for an unlimited (null) budget', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    budgetQuerySpy.mockResolvedValue({ projectId: 1, projectName: 'ProjA', budgetCalls: null, usedCalls: 3 });

    render(<VerifyQueueView />);

    await screen.findByTestId('verify-queue-empty');
    expect(screen.queryByTestId('verify-budget-line')).not.toBeInTheDocument();
  });

  it('hides the budget line when the budget query fails (non-fatal — the queue itself keeps rendering)', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    budgetQuerySpy.mockRejectedValue(new Error('boom'));

    render(<VerifyQueueView />);

    await screen.findByTestId('verify-queue-empty');
    expect(screen.queryByTestId('verify-budget-line')).not.toBeInTheDocument();
  });

  // --- failure-class chip + evidence (§3.1, detail dialog) -----------------

  it('shows the failure-class chip and evidence list on a classified terminal row', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'skipped',
          failureClass: 'env',
          failureEvidence: [
            { source: 'preflight', check: 'chromium', detail: 'chromium binary not resolvable' },
          ],
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);
    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-failure-class-chip')).toHaveTextContent('env');
    expect(screen.getByTestId('verify-detail-failure-evidence')).toHaveTextContent(
      'preflight (chromium): chromium binary not resolvable',
    );
  });

  it('omits the failure-class chip and evidence list when the row has neither', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);
    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-detail-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('verify-failure-class-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verify-detail-failure-evidence')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Phase-3 health panel (verification-setup-flow.md §6)
// ---------------------------------------------------------------------------

describe('VerifyQueueView — health panel', () => {
  it('offers a setup CTA per project and launches the wizard locked to that one', async () => {
    // verify-setup is hidden from the wizard's flow list, so these rows are its
    // entry point — and each launches for ITS project, not for whichever one
    // the queue filter happens to be showing.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    getAllSpy.mockResolvedValue({
      success: true,
      data: [
        { id: 1, name: 'ProjA', path: '/tmp/a' },
        { id: 2, name: 'ProjB', path: '/tmp/b' },
      ],
    });
    render(<VerifyQueueView />);

    await userEvent.click(await screen.findByTestId('verify-setup-cta-2'));

    expect(goToWizardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ preselectWorkflowName: 'verify-setup', lockProjectId: 2 }),
    );
  });

  it('shows every project\'s setup state, not just the selected one', async () => {
    // The question this panel is asked is "is verification set up?", and that
    // is per project. A single button could only ever answer for one of them.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    getAllSpy.mockResolvedValue({
      success: true,
      data: [
        { id: 1, name: 'ProjA', path: '/tmp/a' },
        { id: 2, name: 'ProjB', path: '/tmp/b' },
        { id: 3, name: 'ProjC', path: '/tmp/c' },
      ],
    });
    setupByProjectQuerySpy.mockResolvedValue([
      { projectId: 1, status: 'proven', provenModalities: ['web'] },
      { projectId: 2, status: 'unproven', provenModalities: [] },
    ]);
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-setup-status-1')).toHaveTextContent('Set up');
    expect(screen.getByTestId('verify-setup-cta-1')).toHaveTextContent('Re-run setup');
    // Runbooks exist but none is proven: the degrade gate skips every check, so
    // this must not read the same as a project that is genuinely configured.
    expect(screen.getByTestId('verify-setup-status-2')).toHaveTextContent('Not proven');
    expect(screen.getByTestId('verify-setup-cta-2')).toHaveTextContent('Set up');
    // Absent from the query entirely — absence IS the answer.
    expect(screen.getByTestId('verify-setup-status-3')).toHaveTextContent('Not set up');
  });

  it('renders the probe table with its live states', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      probes: [
        {
          id: 'browser-driving',
          state: 'missing',
          detail: 'chromium: not installed',
          fix: 'provision-chromium',
        },
        { id: 'screen-recording', state: 'ok', detail: 'granted', fix: null },
        { id: 'accessibility', state: 'ok', detail: 'granted', fix: null },
      ],
    });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-probe-browser-driving')).toBeInTheDocument();
    expect(screen.getByTestId('verify-probe-state-browser-driving')).toHaveTextContent('Pending action');
    expect(screen.getByTestId('verify-probe-fix-browser-driving')).toBeInTheDocument();
    expect(screen.getByTestId('verify-probe-state-screen-recording')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('verify-probe-state-accessibility')).toHaveTextContent('Healthy');
  });

  it('keeps the probe sentence as the row tooltip rather than on screen', async () => {
    // The status word is what a user scans; the reason is what they want the
    // one moment something is wrong. Dropping it entirely would make an
    // `unhealthy` row undiagnosable from the panel.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      probes: [{ id: 'browser-driving', state: 'ok', detail: '/path/to/chromium', fix: null }],
    });
    render(<VerifyQueueView />);

    const row = await screen.findByTestId('verify-probe-browser-driving');
    expect(row).toHaveAttribute('title', '/path/to/chromium');
    expect(row).not.toHaveTextContent('/path/to/chromium');
  });

  it('renders an inconclusive probe as unknown, with no fix offered', async () => {
    // The fail-open rule: a probe that declined to answer is not a failure, and
    // must not be dressed as one or given a remediation to chase.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      probes: [{ id: 'browser-driving', state: 'inconclusive', detail: 'chromium: EPERM', fix: null }],
    });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-probe-state-browser-driving')).toHaveTextContent('Unknown');
    expect(screen.queryByTestId('verify-probe-fix-browser-driving')).not.toBeInTheDocument();
  });

  it('provisioning chromium swaps the row to ok from the re-probed report', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      probes: [{ id: 'browser-driving', state: 'missing', detail: 'chromium: not installed', fix: 'provision-chromium' }],
    });
    provisionChromiumSpy.mockResolvedValue({
      probes: [{ id: 'browser-driving', state: 'ok', detail: '/chromium', fix: null }],
    });
    render(<VerifyQueueView />);

    await userEvent.click(await screen.findByTestId('verify-probe-fix-browser-driving'));

    await waitFor(() => {
      expect(screen.getByTestId('verify-probe-state-browser-driving')).toHaveTextContent('Healthy');
    });
  });

  it('§B8: "Approve Xcode access" SHOWS the command and the disclosure; the durable form is an opt-in', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    const row = {
      id: 'xcode-mcp',
      state: 'missing',
      detail: 'Xcode has no MCP grant for this build',
      fix: 'approve-xcode-access',
    };
    hostProbesQuerySpy.mockResolvedValue({ probes: [row] });
    approveXcodeAccessSpy.mockResolvedValue({
      report: { probes: [row] },
      approval: {
        outcome: 'prompted',
        detail: 'Xcode opened the scaffold project.',
        approveCommand: 'sudo xcrun mcp-server approve ABC-123 --for-24-hours',
        durableApproveCommand: 'sudo xcrun mcp-server approve ABC-123 --always',
        disclosure: 'Approving Cyboflow approves every agent it hosts — Claude and Codex alike.',
        scaffoldPath: '/data/xcode-approval/CyboflowApproval.xcodeproj',
      },
    });
    render(<VerifyQueueView />);

    const button = await screen.findByTestId('verify-probe-fix-xcode-mcp');
    expect(button).toHaveTextContent('Approve Xcode access');
    await userEvent.click(button);
    await waitFor(() => expect(approveXcodeAccessSpy).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('verify-xcode-approve-command')).toHaveTextContent(
      'sudo xcrun mcp-server approve ABC-123 --for-24-hours',
    );
    expect(screen.getByTestId('verify-xcode-approval-disclosure')).toHaveTextContent('every agent it hosts');
    // Durable trust is never shown until the user asks for it.
    expect(screen.queryByTestId('verify-xcode-durable-command')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('verify-xcode-show-durable'));
    expect(screen.getByTestId('verify-xcode-durable-command')).toHaveTextContent('--always');
    expect(provisionChromiumSpy).not.toHaveBeenCalled();
  });

  it('routes each grant row to its OWN action, not to the chromium installer', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    const denied = {
      probes: [
        {
          id: 'screen-recording',
          state: 'missing',
          detail: 'not granted',
          fix: 'open-screen-recording-settings',
        },
        { id: 'accessibility', state: 'missing', detail: 'not granted', fix: 'request-accessibility' },
      ],
    };
    hostProbesQuerySpy.mockResolvedValue(denied);
    openScreenRecordingSettingsSpy.mockResolvedValue(denied);
    requestAccessibilitySpy.mockResolvedValue({
      probes: [
        { id: 'screen-recording', state: 'missing', detail: 'not granted', fix: 'open-screen-recording-settings' },
        { id: 'accessibility', state: 'ok', detail: 'granted', fix: null },
      ],
    });
    render(<VerifyQueueView />);

    // The two grants live in DIFFERENT Settings panes; one button opening the
    // other's pane is worse than no button.
    await userEvent.click(await screen.findByTestId('verify-probe-fix-screen-recording'));
    await waitFor(() => expect(openScreenRecordingSettingsSpy).toHaveBeenCalledTimes(1));
    expect(requestAccessibilitySpy).not.toHaveBeenCalled();
    expect(provisionChromiumSpy).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByTestId('verify-probe-fix-accessibility'));
    await waitFor(() => {
      expect(screen.getByTestId('verify-probe-state-accessibility')).toHaveTextContent('Healthy');
    });
  });

  it('offers the grant remedy whatever the projects need', async () => {
    // The rows used to soften to a grey "unknown" when no runbook declared
    // native-screen — a capability you are told nothing about is one whose
    // absence you discover the first time you need it, and it put a
    // we-don't-know pill beside a live remedy button.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      probes: [
        {
          id: 'screen-recording',
          state: 'missing',
          detail: 'not granted',
          fix: 'open-screen-recording-settings',
        },
      ],
    });
    render(<VerifyQueueView />);

    const pill = await screen.findByTestId('verify-probe-state-screen-recording');
    expect(pill).toHaveTextContent('Pending action');
    expect(screen.getByTestId('verify-probe-fix-screen-recording')).toBeInTheDocument();
  });

  it('offers EXACTLY ONE setup affordance per project in the empty state', async () => {
    // The project list IS this state's affordance — it carries a row for the
    // selected project too, so the empty state no longer adds one of its own.
    // Two buttons doing the same thing a few pixels apart read as two actions.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-setup-cta-1')).toBeInTheDocument();
    expect(screen.queryByTestId('verify-queue-empty-setup-cta')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verify-health-setup-cta')).not.toBeInTheDocument();
  });

  it('keeps the setup list on a POPULATED queue', async () => {
    // The reachability rule: verify-setup is hidden from the wizard's flow
    // list, so these rows are its entry point. A populated queue is precisely
    // where the empty state is absent — if the list were conditional on having
    // no requests, the flow would be unlaunchable from here.
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });
    setupByProjectQuerySpy.mockResolvedValue([
      { projectId: 1, status: 'proven', provenModalities: ['web'] },
    ]);
    render(<VerifyQueueView />);

    // Present, but relabelled — presence tracks reachability, the label tracks
    // state. "Proven" here means ONE modality is, which is not "done", which is
    // why the row still offers a re-run.
    expect(await screen.findByTestId('verify-setup-cta-1')).toHaveTextContent('Re-run setup');
  });

  it('drops the probe table but keeps the CTA when the queries fail', async () => {
    // A failed query is not a reason to remove the launch path for the flow
    // that repairs verification — it is a reason to want it. The table goes
    // (there is nothing to show), the affordance stays. No second error surface
    // either: the queue's own banner covers the primary failure mode.
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });
    hostProbesQuerySpy.mockRejectedValue(new Error('nope'));
    setupByProjectQuerySpy.mockRejectedValue(new Error('nope'));
    render(<VerifyQueueView />);

    const cta = await screen.findByTestId('verify-setup-cta-1');
    expect(cta).toHaveTextContent('Set up');
    expect(screen.queryByTestId('verify-probe-browser-driving')).not.toBeInTheDocument();
  });

  it('probes the host ONCE per open, never on a timer', async () => {
    // Every probe pass shells out (resolving a Playwright browser path, asking
    // the OS about the screen-recording grant). None of it is fast-moving: a
    // grant or an installed binary changes when a human does something, not on
    // a fifteen-second tick. The setup rows are host-wide and load the same way.
    vi.useFakeTimers();
    try {
      useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
      render(<VerifyQueueView />);

      // Flush the mount effects' promises without waitFor, which would itself
      // be waiting on the timers we control here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(hostProbesQuerySpy).toHaveBeenCalledTimes(1);
      expect(setupByProjectQuerySpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(hostProbesQuerySpy).toHaveBeenCalledTimes(1);
      expect(setupByProjectQuerySpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads every project as not-set-up when the setup query fails', async () => {
    // Degrading to "already set up" would hide the only affordance for
    // repairing verification exactly when the panel is least healthy. The worst
    // this direction can do is offer setup to a project that has it.
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });
    setupByProjectQuerySpy.mockRejectedValue(new Error('nope'));
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-setup-status-1')).toHaveTextContent('Not set up');
    expect(screen.getByTestId('verify-setup-cta-1')).toBeInTheDocument();
  });
});
