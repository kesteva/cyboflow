/**
 * IdeaProposalsStep tests — guided step 11 hosts the real global assistant
 * thread (AgentThreadView variant="guided") inside the guided column. This
 * file stubs the same collaborators AgentThreadView.test.tsx stubs
 * (UnifiedChatView, useUnifiedAgentThreadMessages, agentThreadStore,
 * ProposalCardList) so it exercises IdeaProposalsStep's OWN wiring — the
 * guided variant/placeholder passthrough and the footer callbacks — not
 * AgentThreadView's or UnifiedChatView's internals.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import type { AgentThread, AgentProposal } from '../../../../../shared/types/agentThread';
import { useOnboardingStore } from '../../../stores/onboardingStore';

interface UnifiedChatViewStubProps {
  mode: string;
  hidePromptRail?: boolean;
  bottomSlot?: ReactNode;
}

vi.mock('../../cyboflow/unified/UnifiedChatView', () => ({
  UnifiedChatView: ({ mode, bottomSlot, hidePromptRail }: UnifiedChatViewStubProps) => (
    <div
      data-testid="unified-chat-view-stub"
      data-mode={mode}
      data-hide-prompt-rail={hidePromptRail === true ? 'true' : 'false'}
    >
      {bottomSlot}
    </div>
  ),
}));

vi.mock('../../cyboflow/unified/useUnifiedAgentThreadMessages', () => ({
  useUnifiedAgentThreadMessages: () => ({ messages: [], isLoading: false, loadError: null }),
}));

vi.mock('../../agentRail/ProposalCardList', () => ({
  ProposalCardList: () => <div data-testid="proposal-card-list-stub" />,
}));

const mockSendMessage = vi.fn().mockResolvedValue(undefined);
let mockThread: AgentThread | null = null;
let mockProposals: AgentProposal[] = [];

interface FakeAgentThreadState {
  thread: AgentThread | null;
  sending: boolean;
  sendMessage: typeof mockSendMessage;
  proposals: AgentProposal[];
}

vi.mock('../../../stores/agentThreadStore', () => ({
  useAgentThreadStore: (selector: (s: FakeAgentThreadState) => unknown) =>
    selector({ thread: mockThread, sending: false, sendMessage: mockSendMessage, proposals: mockProposals }),
}));

async function loadIdeaProposalsStep(): Promise<ComponentType<{
  project: { id: number; name: string } | null;
  onContinue: () => void;
  onSkip: () => void;
}>> {
  const mod = await import('./IdeaProposalsStep');
  return mod.IdeaProposalsStep;
}

const PROJECT = { id: 7, name: 'dogwalkr' };

beforeEach(() => {
  vi.resetModules();
  mockSendMessage.mockClear();
  mockThread = null;
  mockProposals = [];
  useOnboardingStore.setState({
    status: 'active',
    step: 11,
    hydrated: true,
    multiRuntime: true,
    assistantAvailable: true,
  });
});

describe('IdeaProposalsStep', () => {
  it('renders the heading and the thread box', async () => {
    const IdeaProposalsStep = await loadIdeaProposalsStep();
    render(<IdeaProposalsStep project={PROJECT} onContinue={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.getByText('Here’s how I’d capture that')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-idea-thread')).toBeInTheDocument();
    expect(screen.getByTestId('unified-chat-view-stub')).toHaveAttribute('data-mode', 'agent');
  });

  it('hosts AgentThreadView in the guided variant: no suggestion chips, follow-up placeholder', async () => {
    const IdeaProposalsStep = await loadIdeaProposalsStep();
    render(<IdeaProposalsStep project={PROJECT} onContinue={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.queryByTestId('agent-suggestion-chips')).not.toBeInTheDocument();
    // The guided box needs its full 620px for the transcript — no prompt-history rail.
    expect(screen.getByTestId('unified-chat-view-stub')).toHaveAttribute('data-hide-prompt-rail', 'true');
    expect(
      screen.getByPlaceholderText('Not quite? Tell me what to change…'),
    ).toBeInTheDocument();
  });

  it('Continue fires onContinue', async () => {
    const onContinue = vi.fn();
    const IdeaProposalsStep = await loadIdeaProposalsStep();
    render(<IdeaProposalsStep project={PROJECT} onContinue={onContinue} onSkip={vi.fn()} />);

    fireEvent.click(screen.getByTestId('onboarding-idea-proposals-continue'));

    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('Skip fires onSkip', async () => {
    const onSkip = vi.fn();
    const IdeaProposalsStep = await loadIdeaProposalsStep();
    render(<IdeaProposalsStep project={PROJECT} onContinue={vi.fn()} onSkip={onSkip} />);

    fireEvent.click(screen.getByTestId('onboarding-guided-skip-ideas'));

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('shows the guided-step eyebrow', async () => {
    const IdeaProposalsStep = await loadIdeaProposalsStep();
    render(<IdeaProposalsStep project={PROJECT} onContinue={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.getByTestId('guided-step-eyebrow')).toHaveTextContent('STEP 5 OF 8');
  });
});

describe('IdeaProposalsStep — no project ("Not sure yet")', () => {
  it('renders the explanatory variant with no skip link', async () => {
    const IdeaProposalsStep = await loadIdeaProposalsStep();
    const onContinue = vi.fn();
    render(<IdeaProposalsStep project={null} onContinue={onContinue} onSkip={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Here’s how Cyboflow can help' })).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-idea-thread')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-guided-skip-ideas')).toBeNull();
    fireEvent.click(screen.getByTestId('onboarding-idea-proposals-continue'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
