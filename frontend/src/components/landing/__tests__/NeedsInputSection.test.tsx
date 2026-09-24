/**
 * NeedsInputSection — the three ask sources (blocked quick session, review
 * item, permission approval): headline content, Answer/Details wiring, and
 * the Approve/Reject inline actions.
 */
import '@testing-library/jest-dom';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import type { ReviewItem } from '../../../../../shared/types/reviews';
import type { QueueItem } from '../../../utils/reviewQueueSelectors';
import type { Approval } from '../../../../../shared/types/approvals';

const { approveMock, rejectMock, approveRestOfRunMock, dismissAskMock, resolveItemMock, dismissItemMock } =
  vi.hoisted(() => ({
    approveMock: vi.fn().mockResolvedValue({ ok: true }),
    rejectMock: vi.fn().mockResolvedValue({ ok: true }),
    approveRestOfRunMock: vi.fn().mockResolvedValue({ ok: true }),
    dismissAskMock: vi.fn().mockResolvedValue({ success: true }),
    resolveItemMock: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_pause', resumed: true }),
    dismissItemMock: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_pause' }),
  }));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        approve: { mutate: approveMock },
        reject: { mutate: rejectMock },
        approveRestOfRun: { mutate: approveRestOfRunMock },
      },
      sessions: {
        dismissAsk: { mutate: dismissAskMock },
      },
      reviewItems: {
        resolve: { mutate: resolveItemMock },
        dismiss: { mutate: dismissItemMock },
      },
    },
  },
}));

import { NeedsInputSection } from '../NeedsInputSection';

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'tidy-valley',
    projectId: overrides.projectId ?? 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'blocked',
    idleSince: overrides.idleSince ?? null,
    unviewed: overrides.unviewed ?? false,
    restedAtIso: overrides.restedAtIso ?? '2026-07-06T00:00:00.000Z',
    rawStatus: overrides.rawStatus ?? 'running',
    exitCode: overrides.exitCode ?? null,
    summary: overrides.summary ?? null,
    summaryState: overrides.summaryState ?? null,
    waitingOn: overrides.waitingOn ?? 'Which branch should I target?',
    summarySupported: overrides.summarySupported ?? true,
    worktreeName: overrides.worktreeName ?? null,
    git: overrides.git ?? null,
  };
}

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: overrides.id ?? 'rvw_1',
    project_id: overrides.project_id ?? 1,
    run_id: overrides.run_id ?? 'run-1',
    entity_type: null,
    entity_id: null,
    kind: overrides.kind ?? 'decision',
    status: 'pending',
    blocking: overrides.blocking ?? true,
    audience: 'human',
    title: overrides.title ?? 'Approve workflow output',
    body: overrides.body ?? null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: overrides.source ?? null,
    payload: null,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    runId: 'run-1',
    workflowName: 'Ship',
    toolName: 'Bash',
    payloadPreview: 'rm -rf tmp',
    rationale: null,
    createdAt: '2026-07-06T00:00:00.000Z',
    status: 'pending',
    sessionName: 'busy-otter',
    worktreeName: 'busy-otter-20260706',
    agentProvider: null,
    awaited: true,
    ...overrides,
  };
}

const NOW = Date.parse('2026-07-06T01:00:00.000Z');

const baseProps = {
  quickRows: [] as QuickSessionRow[],
  reviewItems: [] as ReviewItem[],
  approvals: [] as QueueItem[],
  projectNameById: { 1: 'proj-1' },
  runProjectMap: { 'run-1': 1 },
  runSessionMap: {},
  nowMs: NOW,
  showWhenEmpty: false,
  flashing: false,
  onOpenQuickSession: vi.fn(),
  onOpenReviewItem: vi.fn(),
  onApprovalDecided: vi.fn(),
  onQuickSessionAskDismissed: vi.fn(),
};

beforeEach(() => {
  approveMock.mockClear();
  rejectMock.mockClear();
  approveRestOfRunMock.mockClear();
  dismissAskMock.mockClear();
  dismissAskMock.mockResolvedValue({ success: true });
  resolveItemMock.mockClear();
  dismissItemMock.mockClear();
});

/** A `gate:systemic-pause:<stepId>` decision — the one decision row that settles itself. */
function makePauseItem(overrides: Partial<ReviewItem> = {}, origin?: 'step' | 'triage'): ReviewItem {
  return makeReviewItem({
    id: 'rvw_pause',
    title: 'Paused: Claude usage limit reached',
    body: 'Auto-resumes in about 2 hours.',
    source: 'gate:systemic-pause:implement',
    payload:
      origin === undefined
        ? null
        : ({ kind: 'decision', gate: 'systemic-pause', stepId: 'implement', origin } as unknown as ReviewItem['payload']),
    ...overrides,
  });
}

describe('NeedsInputSection', () => {
  it('renders nothing when empty and showWhenEmpty is false', () => {
    const { container } = render(<NeedsInputSection {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the empty strip when showWhenEmpty is true', () => {
    render(<NeedsInputSection {...baseProps} showWhenEmpty />);
    expect(screen.getByText('Nothing needs your answer.')).toBeInTheDocument();
  });

  it('renders a blocked quick session with its waitingOn as the headline', () => {
    const row = quickRow({ waitingOn: 'Which branch should I target?' });
    render(<NeedsInputSection {...baseProps} quickRows={[row]} />);
    expect(screen.getByText('Which branch should I target?')).toBeInTheDocument();
  });

  it('shows both the session name and its branch when the session has been renamed', () => {
    const row = quickRow({ name: 'Tech debt cleanup', worktreeName: 'shiny-badger-20260902' });
    render(<NeedsInputSection {...baseProps} quickRows={[row]} />);
    expect(screen.getByText('Tech debt cleanup')).toBeInTheDocument();
    expect(screen.getByText('⌥ shiny-badger-20260902')).toBeInTheDocument();
  });

  it('shows the branch only when the session name still equals its worktree', () => {
    // An unrenamed session is named after its worktree; printing both would read
    // as "shiny-badger-20260902 ⌥ shiny-badger-20260902".
    const row = quickRow({ name: 'shiny-badger-20260902', worktreeName: 'shiny-badger-20260902' });
    render(<NeedsInputSection {...baseProps} quickRows={[row]} />);
    const card = screen.getByTestId('rq-needs-input-row');
    expect(within(card).getByText('⌥ shiny-badger-20260902')).toBeInTheDocument();
    expect(within(card).queryByText('shiny-badger-20260902')).not.toBeInTheDocument();
  });

  it('falls back to the session name alone when the row carries no worktree', () => {
    const row = quickRow({ name: 'Tech debt cleanup', worktreeName: null });
    render(<NeedsInputSection {...baseProps} quickRows={[row]} />);
    expect(screen.getByText('Tech debt cleanup')).toBeInTheDocument();
    expect(screen.queryByText(/^⌥ /)).not.toBeInTheDocument();
  });

  it('clicking Answer on a quick session opens it via setActiveQuickSession, not setActiveRun', async () => {
    const user = userEvent.setup();
    const onOpenQuickSession = vi.fn();
    const row = quickRow();
    render(<NeedsInputSection {...baseProps} quickRows={[row]} onOpenQuickSession={onOpenQuickSession} />);

    await user.click(screen.getByText('Answer →'));
    expect(onOpenQuickSession).toHaveBeenCalledWith(row);
  });

  it('opens a decision review item with a run_id via onOpenReviewItem', async () => {
    const user = userEvent.setup();
    const onOpenReviewItem = vi.fn();
    const item = makeReviewItem({ id: 'rvw-decision', run_id: 'run-9', title: 'Approve the plan' });
    render(<NeedsInputSection {...baseProps} reviewItems={[item]} onOpenReviewItem={onOpenReviewItem} />);

    expect(screen.getByText('Approve the plan')).toBeInTheDocument();
    await user.click(screen.getByText('Answer →'));
    expect(onOpenReviewItem).toHaveBeenCalledWith(item);
  });

  it('a systemic-pause item renders Retry now / Switch & retry… / Stop waiting instead of Answer →', () => {
    render(<NeedsInputSection {...baseProps} reviewItems={[makePauseItem()]} />);
    expect(screen.getByTestId('pause-retry')).toHaveTextContent('Retry now');
    expect(screen.getByTestId('pause-switch-open')).toHaveTextContent('Switch & retry');
    expect(screen.getByTestId('pause-stop')).toHaveTextContent('Stop waiting');
    expect(screen.queryByText('Answer →')).not.toBeInTheDocument();
    // The body is still available behind Details, like any decision row.
    expect(screen.getByText(/Details/)).toBeInTheDocument();
  });

  it('Retry now resolves the pause WITHOUT an outcome (surface queue) and refreshes the board', async () => {
    const user = userEvent.setup();
    const onReviewItemActed = vi.fn();
    render(<NeedsInputSection {...baseProps} reviewItems={[makePauseItem()]} onReviewItemActed={onReviewItemActed} />);
    await user.click(screen.getByTestId('pause-retry'));
    await waitFor(() =>
      expect(resolveItemMock).toHaveBeenCalledWith({ projectId: 1, reviewItemId: 'rvw_pause', surface: 'queue' }),
    );
    expect(dismissItemMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onReviewItemActed).toHaveBeenCalledTimes(1));
  });

  it('Stop waiting DISMISSES the pause (never a reject outcome) and refreshes the board', async () => {
    const user = userEvent.setup();
    const onReviewItemActed = vi.fn();
    render(<NeedsInputSection {...baseProps} reviewItems={[makePauseItem()]} onReviewItemActed={onReviewItemActed} />);
    await user.click(screen.getByTestId('pause-stop'));
    await waitFor(() => expect(dismissItemMock).toHaveBeenCalledWith({ projectId: 1, reviewItemId: 'rvw_pause' }));
    expect(resolveItemMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onReviewItemActed).toHaveBeenCalledTimes(1));
  });

  it('Switch & retry… opens the session via onOpenReviewItem (the runtime/model form lives there)', async () => {
    const user = userEvent.setup();
    const onOpenReviewItem = vi.fn();
    const item = makePauseItem();
    render(<NeedsInputSection {...baseProps} reviewItems={[item]} onOpenReviewItem={onOpenReviewItem} />);
    await user.click(screen.getByTestId('pause-switch-open'));
    expect(onOpenReviewItem).toHaveBeenCalledWith(item);
    expect(resolveItemMock).not.toHaveBeenCalled();
  });

  it('a TRIAGE-origin pause withholds the switch (Retry now / Stop waiting only)', () => {
    render(<NeedsInputSection {...baseProps} reviewItems={[makePauseItem({}, 'triage')]} />);
    expect(screen.getByTestId('pause-retry')).toBeInTheDocument();
    expect(screen.getByTestId('pause-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('pause-switch-open')).not.toBeInTheDocument();
  });

  it('routes an idle-session-sourced review item to the quick session, not the run', () => {
    // The page-level `openReviewItem` handler (LandingHome) is what decodes the
    // `idle-session:<id>` source prefix; NeedsInputSection's job is only to hand
    // the raw item back through onOpenReviewItem, which it does unconditionally.
    const onOpenReviewItem = vi.fn();
    const item = makeReviewItem({
      id: 'rvw-idle',
      source: 'idle-session:sess-z',
      title: 'Idle session needs your attention',
    });
    render(<NeedsInputSection {...baseProps} reviewItems={[item]} onOpenReviewItem={onOpenReviewItem} />);
    expect(screen.getByText('Idle session needs your attention')).toBeInTheDocument();
  });

  it('names the halted session on a review item, resolved from its run', () => {
    // Two "Human gate: Human review" cards are otherwise distinguishable only by
    // project; the item itself carries no session identity, so it comes from the
    // run map.
    const item = makeReviewItem({ run_id: 'run-7', title: 'Human gate: Human review' });
    render(
      <NeedsInputSection
        {...baseProps}
        reviewItems={[item]}
        runSessionMap={{ 'run-7': { sessionName: 'onboarding redesign', branchName: 'hidden-comet-20260901' } }}
      />,
    );
    expect(screen.getByText('onboarding redesign')).toBeInTheDocument();
    expect(screen.getByText('⌥ hidden-comet-20260901')).toBeInTheDocument();
  });

  it('renders a review item with no identity when its run is not in the map', () => {
    // A run outside `runsByProject` (or a manual item with run_id null) simply
    // resolves to nothing — the card renders exactly as it did before.
    const item = makeReviewItem({ run_id: 'run-unknown', title: 'Human gate: Human review' });
    render(<NeedsInputSection {...baseProps} reviewItems={[item]} runSessionMap={{}} />);
    const card = screen.getByTestId('rq-needs-input-row');
    expect(within(card).getByText('Human gate: Human review')).toBeInTheDocument();
    expect(within(card).queryByText(/^⌥ /)).not.toBeInTheDocument();
  });

  it('swaps the meta-row preview for the full body paragraph on Details toggle', async () => {
    // Collapsed: the meta row shows the truncated inline preview. Expanded: that
    // preview is replaced by the full-body paragraph below (mutually exclusive —
    // the text is present either way, but as a different element).
    const user = userEvent.setup();
    const item = makeReviewItem({ body: 'Full rationale for the ask.' });
    render(<NeedsInputSection {...baseProps} reviewItems={[item]} />);

    const collapsedPreview = screen.getByText('Full rationale for the ask.');
    expect(collapsedPreview.tagName).toBe('SPAN');

    await user.click(screen.getByText('Details ▸'));
    const expandedBody = screen.getByText('Full rationale for the ask.');
    expect(expandedBody.tagName).toBe('P');

    await user.click(screen.getByText('Details ▾'));
    const collapsedAgain = screen.getByText('Full rationale for the ask.');
    expect(collapsedAgain.tagName).toBe('SPAN');
  });

  it('renders a single permission approval with Approve/Reject', async () => {
    const user = userEvent.setup();
    const onApprovalDecided = vi.fn();
    const approval = makeApproval();
    const item: QueueItem = { kind: 'single', approval, isBlocking: true };
    render(<NeedsInputSection {...baseProps} approvals={[item]} onApprovalDecided={onApprovalDecided} />);

    expect(screen.getByText('rm -rf tmp')).toBeInTheDocument();
    const approveBtn = screen.getByText('Approve');
    const rejectBtn = screen.getByText('Reject');
    expect(approveBtn).toBeInTheDocument();
    expect(rejectBtn).toBeInTheDocument();

    await user.click(approveBtn);
    expect(approveMock).toHaveBeenCalledWith({ approvalId: 'appr-1' });
    await vi.waitFor(() => expect(onApprovalDecided).toHaveBeenCalled());
  });

  it('shows the session name and branch on an approval card', () => {
    // Approvals carry the same two identity fields as a quick session, joined
    // read-side from the run's session.
    const item: QueueItem = { kind: 'single', approval: makeApproval(), isBlocking: true };
    render(<NeedsInputSection {...baseProps} approvals={[item]} />);
    expect(screen.getByText('busy-otter')).toBeInTheDocument();
    expect(screen.getByText('⌥ busy-otter-20260706')).toBeInTheDocument();
  });

  it('rejects a single approval via the reject mutation', async () => {
    const user = userEvent.setup();
    const approval = makeApproval({ id: 'appr-2' });
    const item: QueueItem = { kind: 'single', approval, isBlocking: true };
    render(<NeedsInputSection {...baseProps} approvals={[item]} />);

    await user.click(screen.getByText('Reject'));
    expect(rejectMock).toHaveBeenCalledWith({ approvalId: 'appr-2' });
  });

  it('approves a grouped approval via approveRestOfRun', async () => {
    const user = userEvent.setup();
    const items: QueueItem[] = [
      {
        kind: 'group',
        runId: 'run-1',
        toolName: 'Bash',
        payloadSignature: 'sig',
        items: [makeApproval({ id: 'a1' }), makeApproval({ id: 'a2' })],
        isBlocking: true,
      },
    ];
    render(<NeedsInputSection {...baseProps} approvals={items} />);

    expect(screen.getByText('Bash · 2 identical requests')).toBeInTheDocument();
    await user.click(screen.getByText('Approve'));
    expect(approveRestOfRunMock).toHaveBeenCalledWith({ runId: 'run-1' });
  });

  /**
   * TASK-225: the dismissable ask — an IDLE session whose summarizer wrote
   * `needs_input`. A live `blocked` row (the helper's default) is a real
   * in-flight gate the dismiss mutation cannot clear, so it offers no Dismiss.
   */
  function dismissableRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
    return quickRow({
      state: 'idle',
      rawStatus: 'completed',
      idleSince: '2026-07-06T00:00:00.000Z',
      summaryState: 'needs_input',
      ...overrides,
    });
  }

  it('clicking Dismiss on a quick session calls dismissAsk and then onQuickSessionAskDismissed', async () => {
    const user = userEvent.setup();
    const onQuickSessionAskDismissed = vi.fn();
    const row = dismissableRow({ sessionId: 'sess-dismiss' });
    render(
      <NeedsInputSection
        {...baseProps}
        quickRows={[row]}
        onQuickSessionAskDismissed={onQuickSessionAskDismissed}
      />,
    );

    await user.click(screen.getByText('Dismiss'));
    expect(dismissAskMock).toHaveBeenCalledWith({ sessionId: 'sess-dismiss' });
    await vi.waitFor(() => expect(onQuickSessionAskDismissed).toHaveBeenCalled());
  });

  it('the top-right ✕ on a quick session card also dismisses it', async () => {
    const user = userEvent.setup();
    const onQuickSessionAskDismissed = vi.fn();
    const row = dismissableRow({ sessionId: 'sess-x' });
    render(
      <NeedsInputSection
        {...baseProps}
        quickRows={[row]}
        onQuickSessionAskDismissed={onQuickSessionAskDismissed}
      />,
    );

    await user.click(screen.getByTestId('rq-needs-input-dismiss-x'));
    expect(dismissAskMock).toHaveBeenCalledWith({ sessionId: 'sess-x' });
    await vi.waitFor(() => expect(onQuickSessionAskDismissed).toHaveBeenCalled());
  });

  it('does NOT call onQuickSessionAskDismissed when the dismiss mutation rejects', async () => {
    dismissAskMock.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    const onQuickSessionAskDismissed = vi.fn();
    render(
      <NeedsInputSection
        {...baseProps}
        quickRows={[dismissableRow()]}
        onQuickSessionAskDismissed={onQuickSessionAskDismissed}
      />,
    );

    await user.click(screen.getByText('Dismiss'));
    await vi.waitFor(() => expect(dismissAskMock).toHaveBeenCalled());
    expect(onQuickSessionAskDismissed).not.toHaveBeenCalled();
  });

  it('offers NO Dismiss (button or ✕) on a live blocked row — the mutation cannot clear an in-flight gate', () => {
    render(<NeedsInputSection {...baseProps} quickRows={[quickRow({ state: 'blocked' })]} />);

    expect(screen.queryByText('Dismiss')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rq-needs-input-dismiss-x')).not.toBeInTheDocument();
    // The card itself still renders with its Answer action.
    expect(screen.getByText('Answer →')).toBeInTheDocument();
  });

  it('issues exactly ONE dismiss for a rapid double-click across the ✕ and the Dismiss button', async () => {
    let settle: (value: { success: true }) => void = () => {};
    dismissAskMock.mockReturnValueOnce(
      new Promise<{ success: true }>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<NeedsInputSection {...baseProps} quickRows={[dismissableRow({ sessionId: 'sess-dbl' })]} />);

    await user.click(screen.getByText('Dismiss'));
    // While the first mutation is in flight both controls are disabled.
    expect(screen.getByText('Dismiss').closest('button')).toBeDisabled();
    expect(screen.getByTestId('rq-needs-input-dismiss-x')).toBeDisabled();
    await user.click(screen.getByTestId('rq-needs-input-dismiss-x'));
    await user.click(screen.getByText('Dismiss'));
    expect(dismissAskMock).toHaveBeenCalledTimes(1);

    settle({ success: true });
    await vi.waitFor(() => expect(screen.getByText('Dismiss').closest('button')).not.toBeDisabled());
  });

  it('renders the Dismiss action ONLY for quick-session rows, not decision items or approvals', () => {
    const item = makeReviewItem();
    const approvalItem: QueueItem = { kind: 'single', approval: makeApproval(), isBlocking: true };
    render(
      <NeedsInputSection
        {...baseProps}
        quickRows={[dismissableRow()]}
        reviewItems={[item]}
        approvals={[approvalItem]}
      />,
    );

    // Exactly one Dismiss action in the whole section — the quick-session row's.
    expect(screen.getAllByText('Dismiss')).toHaveLength(1);
    // The decision item and the approval card offer Answer/Approve/Reject, no Dismiss.
    expect(screen.getByText('Approve workflow output')).toBeInTheDocument();
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('shows the total count and flashing ring class in the header', () => {
    render(<NeedsInputSection {...baseProps} quickRows={[quickRow()]} flashing />);
    const section = screen.getByTestId('rq-needs-input-section');
    expect(within(section).getByText('1')).toBeInTheDocument();
    expect(section.className).toMatch(/shadow-\[0_0_0_2px/);
  });
});
