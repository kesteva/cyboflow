/**
 * NeedsInputSection — the three ask sources (blocked quick session, review
 * item, permission approval): headline content, Answer/Details wiring, and
 * the Approve/Reject inline actions.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import type { ReviewItem } from '../../../../../shared/types/reviews';
import type { QueueItem } from '../../../utils/reviewQueueSelectors';
import type { Approval } from '../../../../../shared/types/approvals';

const { approveMock, rejectMock, approveRestOfRunMock } = vi.hoisted(() => ({
  approveMock: vi.fn().mockResolvedValue({ ok: true }),
  rejectMock: vi.fn().mockResolvedValue({ ok: true }),
  approveRestOfRunMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        approve: { mutate: approveMock },
        reject: { mutate: rejectMock },
        approveRestOfRun: { mutate: approveRestOfRunMock },
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
  nowMs: NOW,
  showWhenEmpty: false,
  flashing: false,
  onOpenQuickSession: vi.fn(),
  onOpenReviewItem: vi.fn(),
  onApprovalDecided: vi.fn(),
};

beforeEach(() => {
  approveMock.mockClear();
  rejectMock.mockClear();
  approveRestOfRunMock.mockClear();
});

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

  it('shows the total count and flashing ring class in the header', () => {
    render(<NeedsInputSection {...baseProps} quickRows={[quickRow()]} flashing />);
    const section = screen.getByTestId('rq-needs-input-section');
    expect(within(section).getByText('1')).toBeInTheDocument();
    expect(section.className).toMatch(/shadow-\[0_0_0_2px/);
  });
});
