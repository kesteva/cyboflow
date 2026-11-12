import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderDetectionResult } from '../../../../../shared/types/onboarding';
import { ConnectStep } from './ConnectStep';

// The real flow drives `claude auth login` over tRPC; the step only owns when
// it is mounted and what happens on success.
vi.mock('../../session/ClaudeSignInCard', () => ({
  ClaudeSignInFlow: ({ onSignedIn, onClose }: { onSignedIn: () => void; onClose: () => void }) => (
    <div data-testid="claude-sign-in-flow-stub">
      <button type="button" onClick={onSignedIn}>stub-succeed</button>
      <button type="button" onClick={onClose}>stub-cancel</button>
    </div>
  ),
}));

const CLAUDE_DETECTED: ProviderDetectionResult<'claude'> = {
  credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
  binary: { found: true, path: '/usr/bin/claude', version: '1.2.3' },
  state: 'detected',
};

const CODEX_DETECTED: ProviderDetectionResult<'codex'> = {
  runtime: { found: true, path: '/app/codex', version: '0.153.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
  state: 'detected',
};

const OMP_DETECTED: ProviderDetectionResult<'omp'> = {
  binaryPath: '/usr/local/bin/omp',
  version: '17.3.3',
  state: 'detected',
};

const OMP_UNAVAILABLE: ProviderDetectionResult<'omp'> = {
  binaryPath: null,
  version: null,
  state: 'unavailable',
};

const baseProps = {
  claudeDetection: CLAUDE_DETECTED,
  claudeConnected: false,
  codexDetection: CODEX_DETECTED,
  codexConnected: false,
  ompDetection: OMP_DETECTED,
  ompConnected: false,
  checking: false,
  onToggleClaude: vi.fn(),
  onToggleCodex: vi.fn(),
  onToggleOmp: vi.fn(),
  onRecheck: vi.fn(),
  onLocate: vi.fn(),
  onInstall: vi.fn(),
  onClaudeSignedIn: vi.fn(),
};

const CLAUDE_MISSING: ProviderDetectionResult<'claude'> = {
  credentials: { found: false, source: null, account: null },
  binary: { found: false, path: null, version: null },
  state: 'missing',
};

describe('ConnectStep', () => {
  it('shows independent Claude and Codex account toggles', () => {
    const onToggleClaude = vi.fn();
    const onToggleCodex = vi.fn();
    render(
      <ConnectStep
        {...baseProps}
        onToggleClaude={onToggleClaude}
        onToggleCodex={onToggleCodex}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' }));
    expect(onToggleClaude).toHaveBeenCalledOnce();
    expect(onToggleCodex).toHaveBeenCalledOnce();
    expect(screen.getByText(/ChatGPT connected/)).toHaveTextContent('plus');
  });

  it('shows an independent OMP toggle that fires onToggleOmp', () => {
    const onToggleOmp = vi.fn();
    render(<ConnectStep {...baseProps} onToggleOmp={onToggleOmp} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Use OMP in Cyboflow' }));
    expect(onToggleOmp).toHaveBeenCalledOnce();
  });

  it('shows OMP as optional (never in the claude/codex must-fix panel) when its binary is missing', () => {
    render(<ConnectStep {...baseProps} ompDetection={OMP_UNAVAILABLE} />);

    // Claude and Codex are both ready, so the mandatory panel is absent...
    expect(screen.queryByText(/Claude Code is not installed/)).not.toBeInTheDocument();
    // ...but OMP still gets its own low-key, non-blocking hint.
    expect(screen.getByText(/OMP is optional/)).toBeInTheDocument();
    expect(screen.getByText(/curl -fsSL https:\/\/omp\.sh\/install \| sh/)).toBeInTheDocument();
  });

  it('disables a logged-out provider without disabling an authenticated sibling', () => {
    render(
      <ConnectStep
        {...baseProps}
        claudeDetection={{
          credentials: { found: false, source: null, account: null },
          binary: { found: true, path: '/usr/bin/claude', version: '1.2.3' },
          state: 'loggedOut',
        }}
        codexConnected
      />,
    );

    expect(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toBeEnabled();
    expect(screen.getByText(/Ready · choose the runtime/)).toBeInTheDocument();
  });

  it('offers an in-app sign-in (not an install) when Claude has no login and no CLI', () => {
    render(<ConnectStep {...baseProps} claudeDetection={CLAUDE_MISSING} />);
    expect(screen.getByText('Sign in required')).toBeInTheDocument();
    expect(screen.getByText(/nothing to install/)).toBeInTheDocument();
    expect(screen.queryByTestId('claude-sign-in-flow-stub')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('onboarding-claude-sign-in-start'));
    expect(screen.getByTestId('claude-sign-in-flow-stub')).toBeInTheDocument();
  });

  it('closes the flow and reports success so the gate can re-probe', () => {
    const onClaudeSignedIn = vi.fn();
    render(<ConnectStep {...baseProps} claudeDetection={CLAUDE_MISSING} onClaudeSignedIn={onClaudeSignedIn} />);
    fireEvent.click(screen.getByTestId('onboarding-claude-sign-in-start'));
    fireEvent.click(screen.getByText('stub-succeed'));
    expect(onClaudeSignedIn).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('claude-sign-in-flow-stub')).not.toBeInTheDocument();
  });

  it('cancelling returns to the sign-in button without reporting success', () => {
    const onClaudeSignedIn = vi.fn();
    render(<ConnectStep {...baseProps} claudeDetection={CLAUDE_MISSING} onClaudeSignedIn={onClaudeSignedIn} />);
    fireEvent.click(screen.getByTestId('onboarding-claude-sign-in-start'));
    fireEvent.click(screen.getByText('stub-cancel'));
    expect(onClaudeSignedIn).not.toHaveBeenCalled();
    expect(screen.getByTestId('onboarding-claude-sign-in-start')).toBeInTheDocument();
  });

  it('shows no Claude sign-in when Claude is detected', () => {
    render(<ConnectStep {...baseProps} codexDetection={{ ...CODEX_DETECTED, state: 'loggedOut' }} />);
    expect(screen.queryByTestId('onboarding-claude-sign-in')).not.toBeInTheDocument();
  });
});
