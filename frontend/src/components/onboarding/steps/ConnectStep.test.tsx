import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  ClaudeDetectionResult,
  CodexDetectionResult,
} from '../../../../../shared/types/onboarding';
import { ConnectStep } from './ConnectStep';

const CLAUDE_DETECTED: ClaudeDetectionResult = {
  credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
  binary: { found: true, path: '/usr/bin/claude', version: '1.2.3' },
  state: 'detected',
};

const CODEX_DETECTED: CodexDetectionResult = {
  runtime: { found: true, path: '/app/codex', version: '0.143.0' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
  state: 'detected',
};

const baseProps = {
  claudeDetection: CLAUDE_DETECTED,
  claudeConnected: false,
  codexDetection: CODEX_DETECTED,
  codexConnected: false,
  checking: false,
  onToggleClaude: vi.fn(),
  onToggleCodex: vi.fn(),
  onRecheck: vi.fn(),
  onLocate: vi.fn(),
  onInstall: vi.fn(),
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
});
