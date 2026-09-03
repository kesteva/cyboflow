/**
 * FirstIdeaStep tests — guided step 10's backlog-idea composer: the hidden
 * onboarding context hint (buildFirstIdeaContextHint), the Send/threadReady
 * gating, the Cmd/Ctrl+Enter keybinding, and the guided-step eyebrow.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentThread } from '../../../../../shared/types/agentThread';
import { useOnboardingStore } from '../../../stores/onboardingStore';
import { buildFirstIdeaContextHint } from './firstIdeaHint';

const mockSendMessage = vi.fn().mockResolvedValue(undefined);
let mockThread: AgentThread | null = null;

interface FakeAgentThreadState {
  thread: AgentThread | null;
  sendMessage: typeof mockSendMessage;
}

vi.mock('../../../stores/agentThreadStore', () => ({
  useAgentThreadStore: (selector: (s: FakeAgentThreadState) => unknown) =>
    selector({ thread: mockThread, sendMessage: mockSendMessage }),
}));

import { FirstIdeaStep } from './FirstIdeaStep';

const PROJECT = { id: 7, name: 'dogwalkr' };

function makeThread(): AgentThread {
  return {
    id: 'thread-1',
    scope: 'global',
    model: null,
    claudeSessionId: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

beforeEach(() => {
  mockSendMessage.mockClear();
  mockThread = null;
  useOnboardingStore.setState({
    status: 'active',
    step: 10,
    hydrated: true,
    multiRuntime: true,
    assistantAvailable: true,
  });
});

describe('buildFirstIdeaContextHint', () => {
  it('names the project and steers toward a create-backlog-items proposal', () => {
    const hint = buildFirstIdeaContextHint(PROJECT);
    expect(hint).toContain('project_id 7');
    expect(hint).toContain('dogwalkr');
    expect(hint).toContain('create-backlog-items');
  });

  it('with no project asks about Cyboflow itself and forbids proposals', () => {
    const hint = buildFirstIdeaContextHint(null);
    expect(hint).toContain('What do you want to get done with Cyboflow?');
    expect(hint).toContain('Do NOT propose any action');
    expect(hint).not.toContain('project_id');
  });
});

describe('FirstIdeaStep', () => {
  it('disables Send with empty text, even with a loaded thread', () => {
    mockThread = makeThread();
    render(<FirstIdeaStep project={PROJECT} onSent={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.getByTestId('onboarding-first-idea-send')).toBeDisabled();
  });

  it('disables Send when the thread has not loaded, even with text', () => {
    mockThread = null;
    render(<FirstIdeaStep project={PROJECT} onSent={vi.fn()} onSkip={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Your first idea'), {
      target: { value: 'add a map view' },
    });

    expect(screen.getByTestId('onboarding-first-idea-send')).toBeDisabled();
  });

  it('Send calls sendMessage with the text and a contextHint, then fires onSent', () => {
    mockThread = makeThread();
    const onSent = vi.fn();
    render(<FirstIdeaStep project={PROJECT} onSent={onSent} onSkip={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Your first idea'), {
      target: { value: 'add a map view of nearby walkers' },
    });
    expect(screen.getByTestId('onboarding-first-idea-send')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('onboarding-first-idea-send'));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [text, opts] = mockSendMessage.mock.calls[0] as [string, { contextHint?: string }];
    expect(text).toBe('add a map view of nearby walkers');
    expect(opts.contextHint).toContain('dogwalkr');
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Enter sends', () => {
    mockThread = makeThread();
    const onSent = vi.fn();
    render(<FirstIdeaStep project={PROJECT} onSent={onSent} onSkip={vi.fn()} />);

    const textarea = screen.getByLabelText('Your first idea');
    fireEvent.change(textarea, { target: { value: 'the sign-up form breaks on iOS Safari' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it('Skip fires onSkip', () => {
    mockThread = makeThread();
    const onSkip = vi.fn();
    render(<FirstIdeaStep project={PROJECT} onSent={vi.fn()} onSkip={onSkip} />);

    fireEvent.click(screen.getByTestId('onboarding-guided-skip-ideas'));

    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('shows the guided-step eyebrow', () => {
    mockThread = makeThread();
    render(<FirstIdeaStep project={PROJECT} onSent={vi.fn()} onSkip={vi.fn()} />);

    expect(screen.getByTestId('guided-step-eyebrow')).toHaveTextContent('STEP 4 OF 8');
  });
});

describe('FirstIdeaStep — no project ("Not sure yet")', () => {
  it('asks what the user wants to get done with Cyboflow and sends with the no-project hint', () => {
    mockThread = makeThread();
    const onSent = vi.fn();
    render(<FirstIdeaStep project={null} onSent={onSent} onSkip={vi.fn()} />);

    expect(screen.getByText('What do you want to get done with Cyboflow?')).toBeInTheDocument();
    expect(screen.queryByText(/next thing you want to get done in/)).toBeNull();

    fireEvent.change(screen.getByLabelText('What you want to get done'), {
      target: { value: 'ship my side project faster' },
    });
    fireEvent.click(screen.getByTestId('onboarding-first-idea-send'));

    expect(mockSendMessage).toHaveBeenCalledWith('ship my side project faster', {
      contextHint: buildFirstIdeaContextHint(null),
    });
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});
