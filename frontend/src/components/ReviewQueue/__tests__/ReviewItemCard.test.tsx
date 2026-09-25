/**
 * Component tests for ReviewItemCard — the kind-polymorphic review_items card.
 *
 * Covers:
 *   - all FIVE kinds render with their kind label.
 *   - the blocking badge renders only when item.blocking === true.
 *   - decision Approve routes to reviewItems.resolve (flow advancement).
 *   - finding/human_task Promote routes to reviewItems.promoteToTask.
 *   - human_task Dismiss routes to reviewItems.dismiss.
 *   - a notification offers ONLY Dismiss (no Resolve / Promote) → reviewItems.dismiss.
 *   - permission Approve/Reject reuse the approval resolution path
 *     (cyboflow.approvals.approve/reject via the folded approvalId).
 *   - finding accept-routing: a proposedTarget renders the '→ TARGET' chip and
 *     makes the primary action contextual ('backlog' → Promote-to-task relabel,
 *     'docs'/'prompt' → Accept resolving 'triaged:accepted-<target>'); a finding
 *     with no / malformed proposedTarget renders the legacy actions unchanged.
 *
 * The tRPC client is mocked at the canonical import path so both the actions
 * hook and the card's direct approval calls route through one set of spies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ReviewItem, ReviewItemKind, ReviewItemPayload } from '../../../../../shared/types/reviews';

const {
  mockResolve,
  mockDismiss,
  mockPromote,
  mockApprovalApprove,
  mockApprovalReject,
  mockAnswerRecovery,
  mockLaunchSeparatePlanner,
  mockReturnIdeaToBacklog,
  mockEnsureSessionForLaunch,
  mockCanAddressReviewFindings,
  mockAddressReviewFindings,
  mockSwitchPausedStepAgents,
  mockClearRunAgentTargets,
  mockRunAgentTargets,
} = vi.hoisted(() => ({
  mockResolve: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1', resumed: true }),
  mockDismiss: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1' }),
  mockPromote: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1', taskId: 'tsk_1' }),
  mockApprovalApprove: vi.fn().mockResolvedValue(undefined),
  mockApprovalReject: vi.fn().mockResolvedValue(undefined),
  mockAnswerRecovery: vi.fn().mockResolvedValue({ resolved: true, nudge: { delivered: true } }),
  mockLaunchSeparatePlanner: vi
    .fn()
    .mockResolvedValue({ runId: 'run_child', worktreePath: '/tmp/wt', branchName: 'quick-child' }),
  mockReturnIdeaToBacklog: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1', ideaId: 'idea_1' }),
  mockEnsureSessionForLaunch: vi.fn().mockResolvedValue('sess-child'),
  mockCanAddressReviewFindings: vi.fn().mockResolvedValue({ eligible: true }),
  mockAddressReviewFindings: vi.fn().mockResolvedValue({ delivered: true, stepId: 'address-review', abortedLiveWalk: false, fanOutKeptSettled: false }),
  mockSwitchPausedStepAgents: vi.fn().mockResolvedValue({ delivered: true, agentKeys: ['implement'], target: { runtime: 'codex-sdk' }, retried: true }),
  mockClearRunAgentTargets: vi.fn().mockResolvedValue({ delivered: true }),
  mockRunAgentTargets: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        resolve: { mutate: mockResolve },
        dismiss: { mutate: mockDismiss },
        promoteToTask: { mutate: mockPromote },
      },
      approvals: {
        approve: { mutate: mockApprovalApprove },
        reject: { mutate: mockApprovalReject },
      },
      runs: {
        answerRecoveryGate: { mutate: mockAnswerRecovery },
        launchSeparatePlanner: { mutate: mockLaunchSeparatePlanner },
        returnIdeaToBacklog: { mutate: mockReturnIdeaToBacklog },
        canAddressReviewFindings: { query: mockCanAddressReviewFindings },
        addressReviewFindings: { mutate: mockAddressReviewFindings },
        switchPausedStepAgents: { mutate: mockSwitchPausedStepAgents },
        clearRunAgentTargets: { mutate: mockClearRunAgentTargets },
        runAgentTargets: { query: mockRunAgentTargets },
      },
    },
  },
}));

// The guard's launch CTA creates the child's FRESH host session before mutating
// (via useReviewItemActions) — stub the session helper so no real IPC fires.
vi.mock('../../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: mockEnsureSessionForLaunch,
}));

// The inline switch form is SystemicPauseSwitchForm.test.tsx's job (readiness
// probing, model/effort pickers, submit payload shape) — stub it here so these
// card-level tests stay focused on the card's OWN trio/labels/note and don't
// pull in provider-detection/model-catalog machinery.
vi.mock('../SystemicPauseSwitchForm', () => ({
  SystemicPauseSwitchForm: ({ onDone }: { onDone: () => void }) => (
    <button type="button" data-testid="pause-switch-form-stub" onClick={onDone}>
      switch form stub
    </button>
  ),
}));

import { ReviewItemCard } from '../ReviewItemCard';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeItem(
  kind: ReviewItemKind,
  overrides: Partial<ReviewItem> = {},
  payload: ReviewItemPayload | null = null,
): ReviewItem {
  return {
    id: overrides.id ?? `rvw_${kind}`,
    project_id: overrides.project_id ?? 5,
    run_id: overrides.run_id ?? 'run-1',
    entity_type: overrides.entity_type ?? null,
    entity_id: overrides.entity_id ?? null,
    kind,
    status: overrides.status ?? 'pending',
    blocking: overrides.blocking ?? false,
    audience: 'human',
    title: overrides.title ?? `${kind} title`,
    body: overrides.body ?? null,
    severity: overrides.severity ?? null,
    priority: overrides.priority ?? null,
    staged_at: overrides.staged_at ?? null,
    selected: overrides.selected ?? false,
    source: overrides.source ?? null,
    payload,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    resolved_by: overrides.resolved_by ?? null,
    resolution: overrides.resolution ?? null,
  };
}

beforeEach(() => {
  mockResolve.mockClear();
  mockDismiss.mockClear();
  mockPromote.mockClear();
  mockApprovalApprove.mockClear();
  mockApprovalReject.mockClear();
  mockAnswerRecovery.mockClear();
  mockLaunchSeparatePlanner.mockClear();
  mockReturnIdeaToBacklog.mockClear();
  mockEnsureSessionForLaunch.mockClear();
  mockEnsureSessionForLaunch.mockResolvedValue('sess-child');
  mockCanAddressReviewFindings.mockClear();
  mockCanAddressReviewFindings.mockResolvedValue({ eligible: true });
  mockAddressReviewFindings.mockClear();
  mockAddressReviewFindings.mockResolvedValue({
    delivered: true,
    stepId: 'address-review',
    abortedLiveWalk: false,
    fanOutKeptSettled: false,
  });
  mockSwitchPausedStepAgents.mockClear();
  mockClearRunAgentTargets.mockClear();
  mockRunAgentTargets.mockClear();
});

describe('ReviewItemCard', () => {
  it('renders all five kinds with their kind label', () => {
    const kinds: Array<[ReviewItemKind, string]> = [
      ['finding', 'Finding'],
      ['permission', 'Permission'],
      ['decision', 'Decision'],
      ['human_task', 'Action'],
      ['notification', 'Notice'],
    ];
    for (const [kind, label] of kinds) {
      const { unmount } = render(<ReviewItemCard item={makeItem(kind)} />);
      expect(screen.getByTestId('review-item-kind')).toHaveTextContent(label);
      unmount();
    }
  });

  it('renders the blocking badge only when blocking is true', () => {
    const { rerender } = render(<ReviewItemCard item={makeItem('decision', { blocking: true })} />);
    expect(screen.getByTestId('blocking-badge')).toBeInTheDocument();

    rerender(<ReviewItemCard item={makeItem('finding', { blocking: false })} />);
    expect(screen.queryByTestId('blocking-badge')).not.toBeInTheDocument();
  });

  it('decision Approve resolves the item with outcome=approve (flow advancement)', async () => {
    render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_dec', blocking: true })} surface="session" />);
    fireEvent.click(screen.getByTestId('decision-resolve'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_dec',
        outcome: 'approve',
        // TASK-222: the resolving surface is stamped alongside the outcome.
        surface: 'session',
      }),
    );
  });

  it('decision Reject resolves the item with outcome=reject (no dismiss)', async () => {
    render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_dec_r', blocking: true })} surface="session" />);
    fireEvent.click(screen.getByTestId('decision-reject'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_dec_r',
        outcome: 'reject',
        surface: 'session',
      }),
    );
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('generic decision gates keep the plain Approve & resume / Reject copy', () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_plan', blocking: true, source: 'gate:human-step:approve-plan' })}
        surface="session"
      />,
    );
    expect(screen.getByTestId('decision-resolve')).toHaveTextContent('Approve & resume');
    expect(screen.getByTestId('decision-reject')).toHaveTextContent('Reject');
  });

  it("the approve-design gate (Tier 2, item 12b) relabels the buttons for its revision loop, by SOURCE", () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_design', blocking: true, source: 'gate:human-step:approve-design' })}
        surface="session"
      />,
    );
    expect(screen.getByTestId('decision-resolve')).toHaveTextContent('Continue, log as findings');
    expect(screen.getByTestId('decision-reject')).toHaveTextContent('Rerun planning with findings');
  });

  it("the approve-design gate's rerun button resolves with outcome=revise, never reject (a reject ends the run)", async () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_design_rr', blocking: true, source: 'gate:human-step:approve-design' })}
        surface="session"
      />,
    );
    fireEvent.click(screen.getByTestId('decision-reject'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_design_rr',
        outcome: 'revise',
        surface: 'session',
      }),
    );
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it("the approve-design gate's rerun button resolves with outcome=revise from the QUEUE surface too (never collapses into the default Dismiss=reject pair)", async () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_design_queue', blocking: true, source: 'gate:human-step:approve-design' })}
      />,
    );
    // The queue's usual option-less collapse (Open in session + Dismiss) never
    // applies to this gate — it renders its own Approve/Revise pair directly.
    expect(screen.queryByTestId('open-in-session')).not.toBeInTheDocument();
    expect(screen.queryByTestId('default-dismiss')).not.toBeInTheDocument();
    expect(screen.getByTestId('decision-resolve')).toHaveTextContent('Continue, log as findings');
    expect(screen.getByTestId('decision-reject')).toHaveTextContent('Rerun planning with findings');
    fireEvent.click(screen.getByTestId('decision-reject'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_design_queue',
        outcome: 'revise',
        surface: 'queue',
      }),
    );
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('the approve-design gate offers a revise note, and only there', () => {
    // The textarea belongs to the revision loop: it is the human's chance to say
    // "only AR-2 matters". A generic gate has no such loop, so it never renders
    // it; the QUEUE surface renders the same approve-design pair (TASK-222 checks
    // it before usesDefaultActions), so the note is there too.
    const { rerender } = render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_note', blocking: true, source: 'gate:human-step:approve-design' })}
        surface="session"
      />,
    );
    expect(screen.getByTestId('design-gate-note')).toHaveAttribute(
      'placeholder',
      'Optional: what to change — e.g. only AR-2 matters, drop AR-11',
    );

    rerender(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_plan_n', blocking: true, source: 'gate:human-step:approve-plan' })}
        surface="session"
      />,
    );
    expect(screen.queryByTestId('design-gate-note')).not.toBeInTheDocument();

    rerender(
      <ReviewItemCard
        item={makeItem('decision', {
          id: 'rvw_note_q',
          blocking: true,
          source: 'gate:human-step:approve-design',
          run_id: 'run_1',
        })}
        surface="queue"
      />,
    );
    expect(screen.getByTestId('design-gate-note')).toBeInTheDocument();
  });

  it("sends the typed note alongside outcome=revise, and nothing when it is blank", async () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_note_send', blocking: true, source: 'gate:human-step:approve-design' })}
        surface="session"
      />,
    );
    fireEvent.change(screen.getByTestId('design-gate-note'), {
      target: { value: '  only AR-2 matters, drop AR-11  ' },
    });
    fireEvent.click(screen.getByTestId('decision-reject'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_note_send',
        outcome: 'revise',
        resolution: 'only AR-2 matters, drop AR-11',
        surface: 'session',
      }),
    );

    // Approve never carries the note — it is guidance for a RE-RUN.
    mockResolve.mockClear();
    fireEvent.click(screen.getByTestId('decision-resolve'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_note_send',
        outcome: 'approve',
        surface: 'session',
      }),
    );
  });

  it('an empty note sends no resolution at all (the stored verdict stays bare)', async () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_note_empty', blocking: true, source: 'gate:human-step:approve-design' })}
        surface="session"
      />,
    );
    fireEvent.change(screen.getByTestId('design-gate-note'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('decision-reject'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_note_empty',
        outcome: 'revise',
        surface: 'session',
      }),
    );
  });

  it('the approve-design gate also relabels by PAYLOAD when minted on the orchestrated plane (no gate:human-step source)', () => {
    render(
      <ReviewItemCard
        item={makeItem(
          'decision',
          { id: 'rvw_design_orch', blocking: true, source: 'agent:planner' },
          { kind: 'decision', gate: 'approve-design' } as unknown as ReviewItemPayload,
        )}
        surface="session"
      />,
    );
    expect(screen.getByTestId('decision-resolve')).toHaveTextContent('Continue, log as findings');
    expect(screen.getByTestId('decision-reject')).toHaveTextContent('Rerun planning with findings');
  });

  it('ask-user-question-recovery gate renders the recovered options as answer buttons', () => {
    const item = makeItem(
      'decision',
      { id: 'rvw_rec', blocking: true, source: 'gate:ask-user-question-recovery' },
      {
        kind: 'decision',
        gate: 'ask-user-question-recovery',
        recoveredQuestions: [
          {
            question: 'Approve the plan?',
            header: 'Approve',
            multiSelect: false,
            options: [{ label: 'Approve' }, { label: 'Revise' }, { label: 'Reject' }],
          },
        ],
      },
    );
    render(<ReviewItemCard item={item} />);
    const answers = screen.getAllByTestId('recovery-gate-answer');
    expect(answers.map((b) => b.textContent)).toEqual(['Approve', 'Revise', 'Reject']);
    // NOT the generic approve/reject gate buttons.
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
  });

  it('answering a recovery gate calls runs.answerRecoveryGate with the chosen label', async () => {
    const item = makeItem(
      'decision',
      { id: 'rvw_rec2', blocking: true, source: 'gate:ask-user-question-recovery' },
      {
        kind: 'decision',
        gate: 'ask-user-question-recovery',
        recoveredQuestions: [
          { question: 'Approve the plan?', header: 'Approve', multiSelect: false, options: [{ label: 'Approve' }, { label: 'Reject' }] },
        ],
      },
    );
    const onResolved = vi.fn();
    render(<ReviewItemCard item={item} onResolved={onResolved} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() =>
      expect(mockAnswerRecovery).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_rec2', answerText: 'Approve' }),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('keeps the recovery card + shows an error when the resume is refused (answer not lost)', async () => {
    mockAnswerRecovery.mockResolvedValueOnce({ resolved: false, nudge: { noOp: true, reason: 'no_session' } });
    const item = makeItem(
      'decision',
      { id: 'rvw_rec_fail', blocking: true, source: 'gate:ask-user-question-recovery' },
      {
        kind: 'decision',
        gate: 'ask-user-question-recovery',
        recoveredQuestions: [
          { question: 'Approve the plan?', header: 'Approve', multiSelect: false, options: [{ label: 'Approve' }] },
        ],
      },
    );
    const onResolved = vi.fn();
    render(<ReviewItemCard item={item} onResolved={onResolved} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(screen.getByTestId('recovery-gate-error')).toBeInTheDocument());
    // The card is NOT removed — the gate stays open for retry.
    expect(onResolved).not.toHaveBeenCalled();
    // The answer buttons are still present.
    expect(screen.getByTestId('recovery-gate-answer')).toBeInTheDocument();
  });

  it('an OPTION-LESS recovery gate offers a free-text answer, NOT the generic gate buttons (adversarial-review regression)', () => {
    const item = makeItem(
      'decision',
      { id: 'rvw_rec3', blocking: true, source: 'gate:ask-user-question-recovery' },
      { kind: 'decision', gate: 'ask-user-question-recovery', recoveredQuestions: [] },
    );
    render(<ReviewItemCard item={item} />);
    // Free-text answer path is present…
    expect(screen.getByTestId('recovery-gate-input')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-gate-free-answer')).toBeInTheDocument();
    // …and the generic resolve/dismiss buttons are NOT — those would clear the
    // gate without delivering the answer (the data-loss hole Codex flagged).
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decision-reject')).not.toBeInTheDocument();
  });

  it('answering an OPTION-LESS recovery gate delivers the typed text via answerRecoveryGate, never reviewItems.resolve', async () => {
    const item = makeItem(
      'decision',
      { id: 'rvw_rec4', blocking: true, source: 'gate:ask-user-question-recovery' },
      { kind: 'decision', gate: 'ask-user-question-recovery', recoveredQuestions: [] },
    );
    const onResolved = vi.fn();
    render(<ReviewItemCard item={item} onResolved={onResolved} />);
    // Submit is disabled until the human types something.
    expect(screen.getByTestId('recovery-gate-free-answer')).toBeDisabled();
    fireEvent.change(screen.getByTestId('recovery-gate-input'), { target: { value: '  Ship it  ' } });
    fireEvent.click(screen.getByTestId('recovery-gate-free-answer'));
    await waitFor(() =>
      expect(mockAnswerRecovery).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_rec4', answerText: 'Ship it' }),
    );
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    // The generic triage route is never taken.
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('finding Promote mints a task via promoteToTask', async () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_find' })} />);
    fireEvent.click(screen.getByTestId('promote-to-task'));
    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_find' }));
  });

  it('human_task Dismiss routes through reviewItems.dismiss', async () => {
    render(<ReviewItemCard item={makeItem('human_task', { id: 'rvw_ht' })} />);
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_ht' }));
  });

  it('a notification renders the Notice label and offers ONLY Dismiss (no Resolve / Promote)', async () => {
    render(<ReviewItemCard item={makeItem('notification', { id: 'rvw_note', source: 'dynamic_workflow' })} />);
    expect(screen.getByTestId('review-item-kind')).toHaveTextContent('Notice');
    expect(screen.queryByText('Resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('promote-to-task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_note' }));
  });

  it('permission Approve reuses the approval resolution path (folded approvalId)', async () => {
    const item = makeItem(
      'permission',
      { id: 'rvw_perm', blocking: true },
      { kind: 'permission', toolName: 'Bash', toolInput: {}, approvalId: 'apr_42' },
    );
    render(<ReviewItemCard item={item} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(mockApprovalApprove).toHaveBeenCalledWith({ approvalId: 'apr_42' }));
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('permission Reject reuses the approval rejection path', async () => {
    const item = makeItem(
      'permission',
      { id: 'rvw_perm2' },
      { kind: 'permission', toolName: 'Bash', toolInput: {}, approvalId: 'apr_7' },
    );
    render(<ReviewItemCard item={item} />);
    fireEvent.click(screen.getByText('Reject'));
    await waitFor(() => expect(mockApprovalReject).toHaveBeenCalledWith({ approvalId: 'apr_7' }));
  });

  it('calls onResolved after a successful triage', async () => {
    const onResolved = vi.fn();
    render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_dec2' })} onResolved={onResolved} surface="session" />);
    fireEvent.click(screen.getByTestId('decision-resolve'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  // -- Accept-routing (proposedTarget) ------------------------------------

  it('renders the target chip per proposedTarget', () => {
    const cases: Array<['backlog' | 'docs' | 'prompt', string]> = [
      ['backlog', '→ Backlog'],
      ['docs', '→ Docs'],
      ['prompt', '→ Prompt'],
    ];
    for (const [target, label] of cases) {
      const { unmount } = render(
        <ReviewItemCard
          item={makeItem('finding', { id: `rvw_${target}` }, { kind: 'finding', proposedTarget: target })}
        />,
      );
      const chip = screen.getByTestId('proposed-target-chip');
      expect(chip).toHaveTextContent(label);
      expect(chip).toHaveAttribute('data-target', target);
      unmount();
    }
  });

  it("renders the proposed-target chip for a 'fix' finding (runtime guard widened)", () => {
    // Regression: the findingProposedTarget runtime guard must admit 'fix' (the
    // D3 union widening) — a missing branch would SILENTLY DROP the chip and fall
    // the card back to legacy Promote (FIND-SPRINT-024-4 class), not crash.
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_fix' }, { kind: 'finding', proposedTarget: 'fix' })}
      />,
    );
    const chip = screen.getByTestId('proposed-target-chip');
    expect(chip).toHaveAttribute('data-target', 'fix');
    expect(chip).toHaveTextContent('→ Quick fix');
  });

  it("proposedTarget 'docs' Accept resolves with triaged:accepted-docs", async () => {
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_docs' }, { kind: 'finding', proposedTarget: 'docs' })}
      />,
    );
    fireEvent.click(screen.getByTestId('accept-finding'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_docs',
        resolution: 'triaged:accepted-docs',
      }),
    );
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("proposedTarget 'prompt' Accept resolves with triaged:accepted-prompt", async () => {
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_prompt' }, { kind: 'finding', proposedTarget: 'prompt' })}
      />,
    );
    fireEvent.click(screen.getByTestId('accept-finding'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_prompt',
        resolution: 'triaged:accepted-prompt',
      }),
    );
  });

  it("proposedTarget 'backlog' keeps promote-to-task (relabelled Accept → task)", async () => {
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_bk' }, { kind: 'finding', proposedTarget: 'backlog' })}
      />,
    );
    const btn = screen.getByTestId('promote-to-task');
    expect(btn).toHaveTextContent('Accept → task');
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_bk' }));
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('a BLOCKING finding renders Resolve & resume in-session (routes to resolve, no outcome)', async () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_bf', blocking: true })} surface="session" />);
    // Blocking findings get a distinct resolve-and-resume affordance (not the
    // accept-routing legacy actions).
    expect(screen.getByTestId('finding-resolve')).toHaveTextContent('Resolve');
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('finding-resolve'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_bf' }));
  });

  it('a non-blocking finding does NOT render the resolve-and-resume affordance', () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_nbf', blocking: false })} />);
    expect(screen.queryByTestId('finding-resolve')).not.toBeInTheDocument();
    expect(screen.getByTestId('promote-to-task')).toBeInTheDocument();
  });

  it('a finding with NO proposedTarget renders the legacy actions unchanged', () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_legacy' })} />);
    expect(screen.queryByTestId('proposed-target-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    const promote = screen.getByTestId('promote-to-task');
    expect(promote).toHaveTextContent('Promote to task');
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
  });

  it('a malformed proposedTarget behaves exactly like no payload', () => {
    // A non-union proposedTarget must fall through the defensive guard so the
    // card keeps its legacy actions (zero behavior change).
    const payload = { kind: 'finding', proposedTarget: 'editor' } as unknown as ReviewItemPayload;
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_bad' }, payload)} />);
    expect(screen.queryByTestId('proposed-target-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    expect(screen.getByTestId('promote-to-task')).toHaveTextContent('Promote to task');
  });

  // -- Default (option-less) escalation CTAs: Open in session / Dismiss ------

  describe('option-less escalations default to Open in session / Dismiss', () => {
    // A blocking finding, a human_task, and a generic gate:human-step decision all
    // reach the human carrying NO options of their own, so the QUEUE surface must
    // route to the run instead of inventing resolve / promote verdicts.
    const optionLess: Array<[string, ReviewItem]> = [
      ['blocking finding', makeItem('finding', { id: 'rvw_q_bf', blocking: true })],
      ['human_task', makeItem('human_task', { id: 'rvw_q_ht', blocking: true })],
      [
        'generic human-step gate',
        makeItem('decision', { id: 'rvw_q_gate', blocking: true, source: 'gate:human-step:approve-plan' }),
      ],
    ];

    for (const [label, item] of optionLess) {
      it(`${label}: queue offers ONLY Open in session + Dismiss`, () => {
        render(<ReviewItemCard item={item} />);
        expect(screen.getByTestId('open-in-session')).toHaveTextContent('Open in session');
        expect(screen.getByText('Dismiss')).toBeInTheDocument();
        // None of the verdict-inventing affordances survive on this surface.
        expect(screen.queryByTestId('finding-resolve')).not.toBeInTheDocument();
        expect(screen.queryByTestId('promote-to-task')).not.toBeInTheDocument();
        expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
        expect(screen.queryByTestId('decision-reject')).not.toBeInTheDocument();
        expect(screen.queryByText('Resolve')).not.toBeInTheDocument();
      });
    }

    it('Open in session activates the run and switches to the session view', async () => {
      const { useNavigationStore } = await import('../../../stores/navigationStore');
      const { useCyboflowStore } = await import('../../../stores/cyboflowStore');
      useNavigationStore.setState({ activeProjectId: null });
      // The real setActiveRun opens a run-event IPC subscription (window.electron),
      // which jsdom lacks — stub it so the handler's navigation half is observable.
      const setActiveRun = vi.fn();
      const realSetActiveRun = useCyboflowStore.getState().setActiveRun;
      useCyboflowStore.setState({ setActiveRun });
      try {
        render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_q_nav', blocking: true })} />);

        fireEvent.click(screen.getByTestId('open-in-session'));

        expect(setActiveRun).toHaveBeenCalledWith('run-1');
        expect(useNavigationStore.getState().activeProjectId).toBe(5);
        expect(useNavigationStore.getState().view).toBe('session');
        // Navigation is NOT triage — the item stays pending.
        expect(mockResolve).not.toHaveBeenCalled();
        expect(mockDismiss).not.toHaveBeenCalled();
      } finally {
        useCyboflowStore.setState({ setActiveRun: realSetActiveRun });
      }
    });

    it('a finding Dismiss routes through reviewItems.dismiss (aggregate-unblock resume)', async () => {
      render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_q_dis', blocking: true })} />);
      fireEvent.click(screen.getByTestId('default-dismiss'));
      await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_q_dis' }));
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('a human_task Dismiss routes through reviewItems.dismiss', async () => {
      render(<ReviewItemCard item={makeItem('human_task', { id: 'rvw_q_htd', blocking: true })} />);
      fireEvent.click(screen.getByTestId('default-dismiss'));
      await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_q_htd' }));
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('a DECISION Dismiss rejects via resolve — never dismiss — so gate teardown runs', async () => {
      // A dismissed gate is read as a rejection either way (humanGate onChange),
      // but ONLY resolve(outcome:'reject') runs deleteRunCreatedEntities for an
      // approve-plan gate. Routing through dismiss would reject the plan and
      // orphan its pending draft epics/tasks on the board.
      const item = makeItem('decision', {
        id: 'rvw_q_gate_dis',
        blocking: true,
        source: 'gate:human-step:approve-plan',
      });
      render(<ReviewItemCard item={item} />);
      fireEvent.click(screen.getByTestId('default-dismiss'));
      await waitFor(() =>
        expect(mockResolve).toHaveBeenCalledWith({
          projectId: 5,
          reviewItemId: 'rvw_q_gate_dis',
          outcome: 'reject',
          surface: 'queue',
        }),
      );
      expect(mockDismiss).not.toHaveBeenCalled();
    });

    it('a DECISION Dismiss on the approve-design gate never reaches the default pair (revise, not reject)', async () => {
      // Unlike approve-plan above, approve-design is checked BEFORE the queue's
      // default-actions collapse, so it never has a 'default-dismiss' button to
      // click at all — it renders the real Approve/Revise pair directly, even on
      // the queue surface. This pins that regression guard.
      const item = makeItem('decision', {
        id: 'rvw_q_design_dis',
        blocking: true,
        source: 'gate:human-step:approve-design',
      });
      render(<ReviewItemCard item={item} />);
      expect(screen.queryByTestId('default-dismiss')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('decision-reject'));
      await waitFor(() =>
        expect(mockResolve).toHaveBeenCalledWith({
          projectId: 5,
          reviewItemId: 'rvw_q_design_dis',
          outcome: 'revise',
          surface: 'queue',
        }),
      );
      expect(mockDismiss).not.toHaveBeenCalled();
    });

    it('a RUN-LESS item keeps its full action set (Open in session has no destination)', () => {
      // `makeItem` defaults run_id via `??`, so a null must be applied after it.
      const item: ReviewItem = { ...makeItem('human_task', { id: 'rvw_q_norun' }), run_id: null };
      render(<ReviewItemCard item={item} />);
      expect(screen.queryByTestId('open-in-session')).not.toBeInTheDocument();
      // Manual work must still be completable and promotable, not just discardable.
      expect(screen.getByText('Resolve')).toBeInTheDocument();
      expect(screen.getByTestId('promote-to-task')).toBeInTheDocument();
      expect(screen.getByText('Dismiss')).toBeEnabled();
    });

    it('a RUN-LESS blocking finding keeps resolve + promote too', () => {
      const item: ReviewItem = { ...makeItem('finding', { id: 'rvw_q_nf', blocking: true }), run_id: null };
      render(<ReviewItemCard item={item} />);
      expect(screen.queryByTestId('open-in-session')).not.toBeInTheDocument();
      expect(screen.getByTestId('finding-resolve')).toBeInTheDocument();
      expect(screen.getByTestId('promote-to-task')).toBeInTheDocument();
    });

    it('an option-CARRYING gate is unaffected on the queue surface', () => {
      // The idea-size guard provides its own two mutations — it must NOT collapse
      // into the default pair.
      const item = makeItem(
        'decision',
        { id: 'rvw_q_guard', blocking: true },
        { kind: 'decision', gate: 'idea-size-guard', ideaRef: 'IDEA-014' },
      );
      render(<ReviewItemCard item={item} />);
      expect(screen.getByTestId('guard-launch-separate')).toBeInTheDocument();
      expect(screen.getByTestId('guard-return-backlog')).toBeInTheDocument();
      expect(screen.queryByTestId('open-in-session')).not.toBeInTheDocument();
    });
  });

  // -- A/B testing slice C: experiment-comparison decision routing -----------

  it("a decision with gate:'experiment-comparison' routes to 'View comparison' instead of resolve/dismiss", async () => {
    const { useNavigationStore } = await import('../../../stores/navigationStore');
    useNavigationStore.setState({ experimentComparisonId: null });

    const item = makeItem(
      'decision',
      { id: 'rvw_exp', blocking: true },
      {
        kind: 'decision',
        gate: 'experiment-comparison',
        experimentId: 'exp_42',
        comparisonPreference: 'A',
        suggestedWinnerRunId: 'run-a',
      },
    );
    render(<ReviewItemCard item={item} />);

    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    const button = screen.getByTestId('decision-view-comparison');
    expect(button).toHaveTextContent('View comparison');

    fireEvent.click(button);
    expect(useNavigationStore.getState().experimentComparisonId).toBe('exp_42');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('a decision with a foreign gate keeps the legacy resolve/dismiss actions in-session', () => {
    const item = makeItem('decision', { id: 'rvw_gate' }, { kind: 'decision', gate: 'approve-idea' });
    render(<ReviewItemCard item={item} surface="session" />);
    expect(screen.queryByTestId('decision-view-comparison')).not.toBeInTheDocument();
    expect(screen.getByTestId('decision-resolve')).toBeInTheDocument();
  });

  // -- IDEA-009 idea-size guard ------------------------------------------

  function makeGuardItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
    return makeItem(
      'decision',
      { id: 'rvw_guard', blocking: true, entity_type: 'idea', entity_id: 'idea_1', ...overrides },
      { kind: 'decision', gate: 'idea-size-guard', ideaRef: 'IDEA-042' },
    );
  }

  it('a pending idea-size-guard renders both CTAs + the idea ref, not the generic resolve/dismiss', () => {
    render(<ReviewItemCard item={makeGuardItem()} />);
    expect(screen.getByTestId('guard-idea-ref')).toHaveTextContent('IDEA-042');
    expect(screen.getByTestId('guard-launch-separate')).toBeInTheDocument();
    expect(screen.getByTestId('guard-return-backlog')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decision-reject')).not.toBeInTheDocument();
  });

  it('clicking Launch a separate planner creates a fresh session then calls launchSeparatePlanner once', async () => {
    const onResolved = vi.fn();
    render(<ReviewItemCard item={makeGuardItem()} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId('guard-launch-separate'));
    await waitFor(() =>
      expect(mockLaunchSeparatePlanner).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_guard',
        sessionId: 'sess-child',
      }),
    );
    // The child's host session is FORCED fresh — the parent's is parked behind this guard.
    expect(mockEnsureSessionForLaunch).toHaveBeenCalledWith(5, { forceNew: true });
    expect(mockLaunchSeparatePlanner).toHaveBeenCalledTimes(1);
    expect(mockReturnIdeaToBacklog).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it('clicking Return to backlog calls returnIdeaToBacklog exactly once with {projectId, reviewItemId}', async () => {
    const onResolved = vi.fn();
    render(<ReviewItemCard item={makeGuardItem()} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId('guard-return-backlog'));
    await waitFor(() =>
      expect(mockReturnIdeaToBacklog).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_guard' }),
    );
    expect(mockReturnIdeaToBacklog).toHaveBeenCalledTimes(1);
    expect(mockLaunchSeparatePlanner).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it('surfaces a launchSeparatePlanner error via the hook error idiom (already-resolved guard) and keeps the card actionable', async () => {
    mockLaunchSeparatePlanner.mockRejectedValueOnce(new Error("Review item rvw_guard is already 'resolved'"));
    const onResolved = vi.fn();
    render(<ReviewItemCard item={makeGuardItem()} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId('guard-launch-separate'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already'));
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('surfaces a returnIdeaToBacklog error via the hook error idiom (already-resolved guard)', async () => {
    mockReturnIdeaToBacklog.mockRejectedValueOnce(new Error("Review item rvw_guard is already 'resolved'"));
    const onResolved = vi.fn();
    render(<ReviewItemCard item={makeGuardItem()} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId('guard-return-backlog'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already'));
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('a resolved guard shows the separate-planner path, not the CTAs', () => {
    const item = makeGuardItem({ status: 'resolved', resolution: 'separate-planner:run_child' });
    render(<ReviewItemCard item={item} />);
    expect(screen.getByTestId('guard-resolved')).toHaveTextContent('Launched a separate planner');
    expect(screen.queryByTestId('guard-launch-separate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('guard-return-backlog')).not.toBeInTheDocument();
  });

  it('a resolved guard shows the return-to-backlog path, not the CTAs', () => {
    const item = makeGuardItem({ status: 'resolved', resolution: 'return-to-backlog:idea_1' });
    render(<ReviewItemCard item={item} />);
    expect(screen.getByTestId('guard-resolved')).toHaveTextContent('Returned to the backlog');
    expect(screen.queryByTestId('guard-launch-separate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('guard-return-backlog')).not.toBeInTheDocument();
  });

  it('a guard payload missing ideaRef still activates the guard branch, falling back to the entity link', () => {
    const item = makeItem(
      'decision',
      { id: 'rvw_guard', blocking: true, entity_type: 'idea', entity_id: 'idea_77' },
      { kind: 'decision', gate: 'idea-size-guard' },
    );
    render(<ReviewItemCard item={item} />);
    expect(screen.getByTestId('guard-idea-ref')).toHaveTextContent('idea_77');
    expect(screen.getByTestId('guard-launch-separate')).toBeInTheDocument();
    expect(screen.getByTestId('guard-return-backlog')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decision-reject')).not.toBeInTheDocument();
  });

  // -- IDEA-009 approve-ideas BATCH gate ------------------------------------

  it('a pending approve-ideas gate routes to the session, NOT the generic Approve/Reject (payload-keyed, agent mint)', () => {
    // The default ORCHESTRATED planner's mint: source 'agent:<label>' — the gate
    // is discoverable ONLY via the payload discriminant (TASK-035B landmine).
    const item = makeItem(
      'decision',
      { id: 'rvw_ai', blocking: true, source: 'agent:planner' },
      { kind: 'decision', gate: 'approve-ideas', ideaRefs: ['IDEA-1', 'IDEA-2'] },
    );
    render(<ReviewItemCard item={item} />);
    expect(screen.getByTestId('decision-review-ideas')).toHaveTextContent('Review ideas');
    // A generic scalar Approve/Reject would clear the gate with no per-idea
    // decision recorded — the backend refuses it, so the card must not offer it.
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decision-reject')).not.toBeInTheDocument();
  });

  it('a pending approve-ideas gate is also recognized by the programmatic source alone', () => {
    const item = makeItem('decision', {
      id: 'rvw_ai_prog',
      blocking: true,
      source: 'gate:human-step:approve-ideas',
    });
    render(<ReviewItemCard item={item} />);
    expect(screen.getByTestId('decision-review-ideas')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-resolve')).not.toBeInTheDocument();
  });

  it('clicking Review ideas navigates to the run session without firing any triage mutation', async () => {
    const { useNavigationStore } = await import('../../../stores/navigationStore');
    const { useCyboflowStore } = await import('../../../stores/cyboflowStore');
    useNavigationStore.setState({ activeProjectId: null });
    // The real setActiveRun opens a run-event IPC subscription (window.electron),
    // which jsdom lacks — stub it so the handler's navigation half is observable.
    const setActiveRun = vi.fn();
    const realSetActiveRun = useCyboflowStore.getState().setActiveRun;
    useCyboflowStore.setState({ setActiveRun });
    try {
      const item = makeItem(
        'decision',
        { id: 'rvw_ai_nav', blocking: true, source: 'agent:planner', run_id: 'run-ai' },
        { kind: 'decision', gate: 'approve-ideas', ideaRefs: ['IDEA-1'] },
      );
      render(<ReviewItemCard item={item} />);
      fireEvent.click(screen.getByTestId('decision-review-ideas'));
      expect(setActiveRun).toHaveBeenCalledWith('run-ai');
      expect(useNavigationStore.getState().activeProjectId).toBe(5);
      expect(useNavigationStore.getState().view).toBe('session');
      expect(mockResolve).not.toHaveBeenCalled();
      expect(mockDismiss).not.toHaveBeenCalled();
    } finally {
      useCyboflowStore.setState({ setActiveRun: realSetActiveRun });
    }
  });

  it('a resolved approve-ideas gate shows the submitted state, not the CTA', () => {
    const item = makeItem(
      'decision',
      {
        id: 'rvw_ai_done',
        blocking: true,
        source: 'agent:planner',
        status: 'resolved',
        resolution: 'idea-verdicts: {"IDEA-1":"approve"}',
      },
      { kind: 'decision', gate: 'approve-ideas', ideaRefs: ['IDEA-1'] },
    );
    render(<ReviewItemCard item={item} />);
    expect(screen.getByTestId('approve-ideas-resolved')).toHaveTextContent('Decisions submitted');
    expect(screen.queryByTestId('decision-review-ideas')).not.toBeInTheDocument();
  });

  // -- Supervisor recommendation chip --------------------------------------
  //
  // The monitor's advice lives INSIDE the body as a `## Supervisor recommendation`
  // section (the router's `annotate` op), so the chip is a pure function of the
  // body and must render on BOTH surfaces — the queue row is where a human
  // triaging their inbox sees it first.

  it.each([['queue'], ['session']] as const)('renders the supervisor chip on the %s surface', (surface) => {
    const item = makeItem('decision', {
      id: 'rvw_rec',
      blocking: true,
      body: 'The gate body.\n\n## Supervisor recommendation\n\nRecommended: rerun — AR-2 is still unaddressed\n',
    });
    render(<ReviewItemCard item={item} surface={surface} />);
    const chip = screen.getByTestId('supervisor-recommendation');
    // The chip shows the BUTTON COPY, not the raw choice word.
    expect(chip).toHaveTextContent('Supervisor recommends: Rerun planning with findings');
    expect(chip).toHaveAttribute('data-choice', 'rerun');
  });

  it('maps each choice to its button copy', () => {
    const cases: Array<[string, string]> = [
      ['approve', 'Approve'],
      ['reject', 'Reject'],
      ['continue', 'Continue, log as findings'],
      ['dismiss', 'Continue without logging'],
    ];
    for (const [choice, label] of cases) {
      const { unmount } = render(
        <ReviewItemCard
          item={makeItem('decision', {
            id: `rvw_${choice}`,
            body: `## Supervisor recommendation\n\nRecommended: ${choice} — because\n`,
          })}
        />,
      );
      expect(screen.getByTestId('supervisor-recommendation')).toHaveTextContent(`Supervisor recommends: ${label}`);
      unmount();
    }
  });

  it('renders no chip when the body carries no section, a malformed one, or nothing at all', () => {
    for (const body of [
      null,
      'Just the gate body.',
      // A `Recommended:` line OUTSIDE the section must never emphasize anything.
      'Recommended: reject — the reviewer quoting itself\n\n## Findings\n\nAR-1\n',
      '## Supervisor recommendation\n\nprose with no machine line\n',
    ]) {
      const { unmount } = render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_none', body })} />);
      expect(screen.queryByTestId('supervisor-recommendation')).not.toBeInTheDocument();
      unmount();
    }
  });

  // -- "Continue without logging" + recommendation-driven emphasis ------------
  //
  // The approve-design gate's THIRD choice, and the only place the supervisor's
  // advice becomes actionable rather than informational: the recommended button
  // is the primary one.

  /** The approve-design gate item, optionally annotated with a recommendation. */
  function designGateItem(id: string, choice?: string): ReviewItem {
    return makeItem('decision', {
      id,
      blocking: true,
      source: 'gate:human-step:approve-design',
      ...(choice !== undefined
        ? { body: `The gate body.\n\n## Supervisor recommendation\n\nRecommended: ${choice} — because\n` }
        : {}),
    });
  }

  /**
   * The ORCHESTRATED plane's approve-design item: discoverable only by payload,
   * with an `agent:<label>` source. The server refuses the `no-findings`
   * modifier on it, so it keeps the two-button shape.
   */
  function payloadDesignGateItem(id: string): ReviewItem {
    return makeItem(
      'decision',
      { id, blocking: true, source: 'agent:planner' },
      { kind: 'decision', gate: 'approve-design' } as unknown as ReviewItemPayload,
    );
  }

  /** The class list is the only observable of a Button's variant. */
  function isPrimary(el: HTMLElement): boolean {
    return el.className.includes('bg-interactive');
  }

  it('renders THREE buttons in-session for the approve-design gate', () => {
    render(<ReviewItemCard item={designGateItem('rvw_d3')} surface="session" />);
    expect(screen.getByTestId('decision-resolve')).toHaveTextContent('Continue, log as findings');
    expect(screen.getByTestId('decision-reject')).toHaveTextContent('Rerun planning with findings');
    expect(screen.getByTestId('decision-continue-no-findings')).toHaveTextContent('Continue without logging');
  });

  it('offers NO third button on a plain decision gate', () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_plain3', blocking: true, source: 'gate:human-step:approve-plan' })}
        surface="session"
      />,
    );
    expect(screen.queryByTestId('decision-continue-no-findings')).not.toBeInTheDocument();
  });

  it('"Continue without logging" resolves approve WITH the no-findings modifier', async () => {
    render(<ReviewItemCard item={designGateItem('rvw_nf')} surface="session" />);
    fireEvent.click(screen.getByTestId('decision-continue-no-findings'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_nf',
        outcome: 'approve',
        modifier: 'no-findings',
        surface: 'session',
      }),
    );
  });

  it('emphasizes the recommended button and demotes the others', () => {
    const cases: Array<[string, string]> = [
      ['continue', 'decision-resolve'],
      ['rerun', 'decision-reject'],
      ['dismiss', 'decision-continue-no-findings'],
    ];
    const all = ['decision-resolve', 'decision-reject', 'decision-continue-no-findings'];
    for (const [choice, expected] of cases) {
      const { unmount } = render(
        <ReviewItemCard item={designGateItem(`rvw_emph_${choice}`, choice)} surface="session" />,
      );
      for (const id of all) {
        expect(isPrimary(screen.getByTestId(id))).toBe(id === expected);
      }
      unmount();
    }
  });

  it('keeps today’s emphasis (approve primary) when there is no recommendation', () => {
    render(<ReviewItemCard item={designGateItem('rvw_noemph')} surface="session" />);
    expect(isPrimary(screen.getByTestId('decision-resolve'))).toBe(true);
    expect(isPrimary(screen.getByTestId('decision-reject'))).toBe(false);
    expect(isPrimary(screen.getByTestId('decision-continue-no-findings'))).toBe(false);
  });

  const plainGateItem = (id: string, choice: string): ReviewItem =>
    makeItem('decision', {
      id,
      blocking: true,
      source: 'gate:human-step:approve-plan',
      body: `## Supervisor recommendation\n\nRecommended: ${choice} — because\n`,
    });

  it('emphasizes Reject for a reject recommendation on a plain gate', () => {
    render(<ReviewItemCard item={plainGateItem('rvw_plain_reject', 'reject')} surface="session" />);
    expect(isPrimary(screen.getByTestId('decision-reject'))).toBe(true);
    expect(isPrimary(screen.getByTestId('decision-resolve'))).toBe(false);
  });

  it('renders NO chip and keeps today’s emphasis for a stale `revise` on a plain gate', () => {
    // CX-3: a plain gate has no Revise control and its Reject ENDS the run, so
    // `revise` is off the vocabulary — it must not parse, and must not push the
    // human at the destructive button.
    render(<ReviewItemCard item={plainGateItem('rvw_plain_revise', 'revise')} surface="session" />);
    expect(screen.queryByTestId('supervisor-recommendation')).toBeNull();
    expect(isPrimary(screen.getByTestId('decision-resolve'))).toBe(true);
    expect(isPrimary(screen.getByTestId('decision-reject'))).toBe(false);
  });

  it('the QUEUE surface offers the same three approve-design controls — no default discard can reject the run', async () => {
    // TASK-222 renders the approve-design pair on every surface (checked before
    // usesDefaultActions), so the queue gets the third choice too, and the
    // run-ending default discard is not reachable for this gate at all.
    render(<ReviewItemCard item={designGateItem('rvw_q_design')} surface="queue" />);
    expect(screen.queryByTestId('default-dismiss')).not.toBeInTheDocument();
    expect(screen.getByTestId('decision-resolve')).toHaveTextContent('Continue, log as findings');
    expect(screen.getByTestId('decision-reject')).toHaveTextContent('Rerun planning with findings');

    fireEvent.click(screen.getByTestId('decision-continue-no-findings'));

    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_q_design',
        outcome: 'approve',
        modifier: 'no-findings',
        surface: 'queue',
      }),
    );
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('offers NO third button on the PAYLOAD-discriminated approve-design item', () => {
    // The orchestrated plane mints this one with source 'agent:<label>'. The
    // server admits `approve[no-findings]` only on the singular
    // 'gate:human-step:approve-design' source, so offering the button here would
    // hand the human a control whose resolve is refused.
    render(<ReviewItemCard item={payloadDesignGateItem('rvw_orch_nf')} surface="session" />);
    expect(screen.getByTestId('decision-resolve')).toHaveTextContent('Continue, log as findings');
    expect(screen.getByTestId('decision-reject')).toHaveTextContent('Rerun planning with findings');
    expect(screen.getByTestId('design-gate-note')).toBeInTheDocument();
    expect(screen.queryByTestId('decision-continue-no-findings')).not.toBeInTheDocument();
  });

  it('the PAYLOAD-discriminated approve-design item on the QUEUE renders the pair without the third button, and its decline is a revise', async () => {
    render(<ReviewItemCard item={payloadDesignGateItem('rvw_orch_q')} surface="queue" />);
    expect(screen.queryByTestId('default-dismiss')).not.toBeInTheDocument();
    expect(screen.queryByTestId('decision-continue-no-findings')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('decision-reject'));

    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_orch_q',
        outcome: 'revise',
        surface: 'queue',
      }),
    );
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('the QUEUE discard on every OTHER decision gate still rejects', async () => {
    render(
      <ReviewItemCard
        item={makeItem('decision', { id: 'rvw_q_other', blocking: true, source: 'gate:human-step:approve-plan' })}
        surface="queue"
      />,
    );
    const discard = screen.getByTestId('default-dismiss');
    expect(discard).toHaveTextContent('Dismiss');

    fireEvent.click(discard);

    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_q_other',
        outcome: 'reject',
        surface: 'queue',
      }),
    );
  });

  // -- TASK-277: eval-sourced finding triage --------------------------------

  function makeEvalFinding(overrides: Partial<ReviewItem> = {}, payload: ReviewItemPayload | null = null): ReviewItem {
    return makeItem(
      'finding',
      { id: 'rvw_eval', source: 'agent:eval', ...overrides },
      payload ?? ({ kind: 'finding', category: 'robustness' } as unknown as ReviewItemPayload),
    );
  }

  it('an eval finding offers Address review findings / Log as findings / Dismiss, never Promote to task', async () => {
    render(<ReviewItemCard item={makeEvalFinding()} />);
    await waitFor(() => expect(mockCanAddressReviewFindings).toHaveBeenCalledWith({ runId: 'run-1' }));
    expect(screen.getByTestId('address-review-findings')).toHaveTextContent('Address review findings');
    expect(screen.getByTestId('log-as-findings')).toHaveTextContent('Log as findings');
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
    expect(screen.queryByTestId('promote-to-task')).not.toBeInTheDocument();
  });

  it('a BLOCKING eval finding (the synthesized catastrophic-cap item) also gets the eval triage set, not Resolve & resume', async () => {
    render(<ReviewItemCard item={makeEvalFinding({ blocking: true })} />);
    await waitFor(() => expect(mockCanAddressReviewFindings).toHaveBeenCalled());
    expect(screen.getByTestId('address-review-findings')).toBeInTheDocument();
    expect(screen.getByTestId('log-as-findings')).toBeInTheDocument();
    expect(screen.queryByTestId('finding-resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-in-session')).not.toBeInTheDocument();
  });

  it('the Address button is enabled once eligibility resolves eligible, and rewinds the run', async () => {
    render(<ReviewItemCard item={makeEvalFinding()} />);
    await waitFor(() => expect(screen.getByTestId('address-review-findings')).toBeEnabled());
    fireEvent.click(screen.getByTestId('address-review-findings'));
    await waitFor(() => expect(mockAddressReviewFindings).toHaveBeenCalledWith({ runId: 'run-1' }));
    // The finding is NOT resolved/dismissed by this action — address-review
    // resolves each finding itself as it works through them.
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
  });

  it('the Address button renders disabled with a tooltip when the run already completed', async () => {
    mockCanAddressReviewFindings.mockResolvedValueOnce({ eligible: false, reason: 'completed' });
    render(<ReviewItemCard item={makeEvalFinding()} />);
    await waitFor(() => expect(screen.getByTestId('address-review-findings')).toBeDisabled());
    expect(screen.getByTestId('address-review-findings')).toHaveAttribute(
      'title',
      'Run already completed — log or dismiss',
    );
    // Log / Dismiss stay usable.
    expect(screen.getByTestId('log-as-findings')).toBeEnabled();
    expect(screen.getByText('Dismiss')).toBeEnabled();
  });

  it('the Address button renders disabled with a tooltip when the flow has no address-review step', async () => {
    mockCanAddressReviewFindings.mockResolvedValueOnce({ eligible: false, reason: 'no_step' });
    render(<ReviewItemCard item={makeEvalFinding()} />);
    await waitFor(() => expect(screen.getByTestId('address-review-findings')).toBeDisabled());
    expect(screen.getByTestId('address-review-findings')).toHaveAttribute(
      'title',
      'This flow has no address-review step',
    );
  });

  it('a canAddressReviewFindings transport failure renders disabled with an "unavailable" tooltip, never the false "Run already completed" (rvw_898ebd7f)', async () => {
    mockCanAddressReviewFindings.mockRejectedValueOnce(new Error('boom'));
    render(<ReviewItemCard item={makeEvalFinding()} />);
    await waitFor(() => expect(screen.getByTestId('address-review-findings')).toBeDisabled());
    expect(screen.getByTestId('address-review-findings')).toHaveAttribute(
      'title',
      'Could not check eligibility — try again',
    );
  });

  it('after a successful Address click the button goes disabled+tooltip instead of re-enabling on stale eligibility (rvw_2ae3779e)', async () => {
    render(<ReviewItemCard item={makeEvalFinding()} />);
    await waitFor(() => expect(screen.getByTestId('address-review-findings')).toBeEnabled());
    fireEvent.click(screen.getByTestId('address-review-findings'));
    await waitFor(() => expect(mockAddressReviewFindings).toHaveBeenCalled());
    // addressBusy resets in .finally, but eligibility must already read
    // in_progress locally — never a re-enabled stale eligible:true.
    await waitFor(() => expect(screen.getByTestId('address-review-findings')).toBeDisabled());
    expect(screen.getByTestId('address-review-findings')).toHaveAttribute(
      'title',
      'Address review is already running for this run',
    );
  });

  it('Log as findings resolves with triaged:logged and does not promote to a task', async () => {
    const onResolved = vi.fn();
    render(<ReviewItemCard item={makeEvalFinding()} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId('log-as-findings'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_eval',
        resolution: 'triaged:logged',
      }),
    );
    expect(mockPromote).not.toHaveBeenCalled();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it('Dismiss on an eval finding routes through reviewItems.dismiss like any other finding', async () => {
    render(<ReviewItemCard item={makeEvalFinding()} />);
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_eval' }));
  });

  it('the ad-hoc eval summary item (quick session) offers only Log / Dismiss — no Address button at all', async () => {
    const item = makeEvalFinding(
      { id: 'rvw_eval_adhoc', blocking: false },
      { kind: 'finding', category: 'eval' } as unknown as ReviewItemPayload,
    );
    render(<ReviewItemCard item={item} />);
    // No eligibility check is even made — the run has no address-review step
    // to reopen for a quick session, so there is nothing to pre-check.
    expect(mockCanAddressReviewFindings).not.toHaveBeenCalled();
    expect(screen.queryByTestId('address-review-findings')).not.toBeInTheDocument();
    expect(screen.getByTestId('log-as-findings')).toBeInTheDocument();
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
  });

  it('a non-eval finding is unaffected by the eval triage set (source null)', () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_nf' })} />);
    expect(screen.queryByTestId('address-review-findings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('log-as-findings')).not.toBeInTheDocument();
    expect(screen.getByTestId('promote-to-task')).toBeInTheDocument();
  });

  // -- Plan v2: switch runtime/model on a systemic pause, then retry ---------

  function makePauseItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
    return makeItem('decision', {
      id: 'rvw_pause',
      blocking: true,
      source: 'gate:systemic-pause:implement',
      ...overrides,
    });
  }

  /** The payload-discriminated form — no `gate:systemic-pause:` source prefix. */
  function makePausePayloadItem(
    overrides: Partial<ReviewItem> = {},
    origin?: 'step' | 'triage',
  ): ReviewItem {
    return makeItem(
      'decision',
      { id: 'rvw_pause_payload', blocking: true, source: 'agent:programmatic-run-host', ...overrides },
      {
        kind: 'decision',
        gate: 'systemic-pause',
        ...(origin !== undefined ? { origin } : {}),
      } as unknown as ReviewItemPayload,
    );
  }

  describe('systemic-pause pause card', () => {
    it('renders the trio in-session, keyed by the SOURCE prefix', () => {
      render(<ReviewItemCard item={makePauseItem()} surface="session" />);
      expect(screen.getByTestId('pause-retry')).toHaveTextContent('Retry now');
      expect(screen.getByTestId('pause-switch-toggle')).toHaveTextContent('Switch runtime');
      expect(screen.getByTestId('pause-stop')).toHaveTextContent('Stop waiting');
      // Never the option-less default pair — this gate has real actions.
      expect(screen.queryByTestId('open-in-session')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-dismiss')).not.toBeInTheDocument();
    });

    it('renders the trio in-session, keyed by the PAYLOAD gate (no gate:systemic-pause: source)', () => {
      render(<ReviewItemCard item={makePausePayloadItem()} surface="session" />);
      expect(screen.getByTestId('pause-retry')).toBeInTheDocument();
      expect(screen.getByTestId('pause-switch-toggle')).toBeInTheDocument();
      expect(screen.getByTestId('pause-stop')).toBeInTheDocument();
    });

    it('on the (hostless) QUEUE surface renders Retry now / Stop waiting only — the landing row owns the queue-side switch', () => {
      render(<ReviewItemCard item={makePauseItem({ id: 'rvw_pause_q' })} />);
      expect(screen.getByTestId('pause-retry')).toBeInTheDocument();
      expect(screen.getByTestId('pause-stop')).toBeInTheDocument();
      expect(screen.queryByTestId('pause-switch-toggle')).not.toBeInTheDocument();
      expect(screen.queryByTestId('pause-switch-open')).not.toBeInTheDocument();
      // Never the option-less default pair either.
      expect(screen.queryByTestId('open-in-session')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-dismiss')).not.toBeInTheDocument();
    });

    it('the QUEUE pair is also recognized by the PAYLOAD gate alone', () => {
      render(<ReviewItemCard item={makePausePayloadItem({ id: 'rvw_pause_payload_q' })} />);
      expect(screen.getByTestId('pause-retry')).toBeInTheDocument();
      expect(screen.getByTestId('pause-stop')).toBeInTheDocument();
    });

    it('Retry now resolves WITHOUT an outcome, in-session', async () => {
      render(<ReviewItemCard item={makePauseItem({ id: 'rvw_pause_retry_s' })} surface="session" />);
      fireEvent.click(screen.getByTestId('pause-retry'));
      await waitFor(() =>
        expect(mockResolve).toHaveBeenCalledWith({
          projectId: 5,
          reviewItemId: 'rvw_pause_retry_s',
          surface: 'session',
        }),
      );
    });

    it('Retry now resolves WITHOUT an outcome, on the queue', async () => {
      render(<ReviewItemCard item={makePauseItem({ id: 'rvw_pause_retry_q' })} />);
      fireEvent.click(screen.getByTestId('pause-retry'));
      await waitFor(() =>
        expect(mockResolve).toHaveBeenCalledWith({
          projectId: 5,
          reviewItemId: 'rvw_pause_retry_q',
          surface: 'queue',
        }),
      );
    });

    it('Stop waiting dismisses (never resolves), on either surface', async () => {
      render(<ReviewItemCard item={makePauseItem({ id: 'rvw_pause_stop' })} surface="session" />);
      fireEvent.click(screen.getByTestId('pause-stop'));
      await waitFor(() =>
        expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_pause_stop' }),
      );
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('never sends outcome "reject" for a systemic-pause item, from any action or surface', async () => {
      render(<ReviewItemCard item={makePauseItem({ id: 'rvw_pause_noreject_s' })} surface="session" />);
      fireEvent.click(screen.getByTestId('pause-retry'));
      await waitFor(() => expect(mockResolve).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId('pause-stop'));
      await waitFor(() => expect(mockDismiss).toHaveBeenCalled());

      mockResolve.mockClear();
      mockDismiss.mockClear();
      render(<ReviewItemCard item={makePauseItem({ id: 'rvw_pause_noreject_q' })} />);
      fireEvent.click(screen.getAllByTestId('pause-retry')[1]);
      await waitFor(() => expect(mockResolve).toHaveBeenCalled());
      fireEvent.click(screen.getAllByTestId('pause-stop')[1]);
      await waitFor(() => expect(mockDismiss).toHaveBeenCalled());

      for (const call of mockResolve.mock.calls) {
        expect((call[0] as { outcome?: string }).outcome).not.toBe('reject');
      }
    });

    it('Switch runtime & retry toggles the inline switch form in-session, and it can close itself', () => {
      const onResolved = vi.fn();
      render(
        <ReviewItemCard item={makePauseItem({ id: 'rvw_pause_toggle' })} surface="session" onResolved={onResolved} />,
      );
      expect(screen.queryByTestId('pause-switch-form-stub')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('pause-switch-toggle'));
      expect(screen.getByTestId('pause-switch-form-stub')).toBeInTheDocument();

      // The form's own onDone collapses it again (and bubbles onResolved).
      fireEvent.click(screen.getByTestId('pause-switch-form-stub'));
      expect(screen.queryByTestId('pause-switch-form-stub')).not.toBeInTheDocument();
      expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it('a resolved item that was switched shows "Switched & retried"', () => {
      render(
        <ReviewItemCard
          item={makePauseItem({
            id: 'rvw_pause_resolved_switch',
            status: 'resolved',
            resolution: 'retry: switched 2 agent(s) (implement, code-review) → codex-sdk',
          })}
        />,
      );
      expect(screen.getByTestId('pause-resolved')).toHaveTextContent('Switched & retried');
    });

    it('a resolved item that was plainly retried (or auto-retried, or has no resolution) shows "Retried"', () => {
      const cases: Array<[string, string | null]> = [
        ['bare retry note', 'retry: implement'],
        ['auto-resume note', 'auto-retry: reset at 7:10pm'],
        ['no note at all', null],
      ];
      for (const [label, resolution] of cases) {
        const { unmount } = render(
          <ReviewItemCard item={makePauseItem({ id: `rvw_pause_retried_${label}`, status: 'resolved', resolution })} />,
        );
        expect(screen.getByTestId('pause-resolved')).toHaveTextContent('Retried');
        unmount();
      }
    });

    it('a DISMISSED item, or one resolved with a "stop waiting" note, shows "Stopped waiting"', () => {
      const { unmount: unmount1 } = render(
        <ReviewItemCard item={makePauseItem({ id: 'rvw_pause_dismissed', status: 'dismissed' })} />,
      );
      expect(screen.getByTestId('pause-resolved')).toHaveTextContent('Stopped waiting');
      unmount1();

      render(
        <ReviewItemCard
          item={makePauseItem({ id: 'rvw_pause_stopnote', status: 'resolved', resolution: 'stop waiting' })}
        />,
      );
      expect(screen.getByTestId('pause-resolved')).toHaveTextContent('Stopped waiting');
    });

    it('a TRIAGE-origin pause renders the note and HIDES the switch on both surfaces (Retry now / Stop waiting only)', () => {
      const { rerender } = render(<ReviewItemCard item={makePausePayloadItem({}, 'triage')} surface="session" />);
      expect(screen.getByTestId('pause-triage-note')).toHaveTextContent(
        "The run's supervisor (always Claude) hit the limit",
      );
      expect(screen.queryByTestId('pause-switch-toggle')).not.toBeInTheDocument();
      expect(screen.getByTestId('pause-retry')).toBeInTheDocument();
      expect(screen.getByTestId('pause-stop')).toBeInTheDocument();

      rerender(<ReviewItemCard item={makePausePayloadItem({ id: 'rvw_pause_triage_q' }, 'triage')} />);
      expect(screen.getByTestId('pause-triage-note')).toBeInTheDocument();
      expect(screen.queryByTestId('pause-switch-toggle')).not.toBeInTheDocument();
      expect(screen.getByTestId('pause-retry')).toBeInTheDocument();
      expect(screen.getByTestId('pause-stop')).toBeInTheDocument();
    });

    it('a STEP-origin pause (or one with no origin) renders no note and keeps the switch', () => {
      const { rerender } = render(
        <ReviewItemCard item={makePausePayloadItem({ id: 'rvw_pause_step' }, 'step')} surface="session" />,
      );
      expect(screen.queryByTestId('pause-triage-note')).not.toBeInTheDocument();
      expect(screen.getByTestId('pause-switch-toggle')).toBeInTheDocument();

      // No `origin` at all (e.g. the source-prefix-only form) also renders no note.
      rerender(<ReviewItemCard item={makePauseItem({ id: 'rvw_pause_noorigin' })} surface="session" />);
      expect(screen.queryByTestId('pause-triage-note')).not.toBeInTheDocument();
      expect(screen.getByTestId('pause-switch-toggle')).toBeInTheDocument();
    });
  });
});
