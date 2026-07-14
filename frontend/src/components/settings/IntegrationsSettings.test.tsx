import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClaudeDetectionResult,
  CodexDetectionResult,
} from '../../../../shared/types/onboarding';
import { IntegrationsSettings } from './IntegrationsSettings';

const detectClaude = vi.fn();
const detectCodex = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    claude: { detect: (...args: unknown[]) => detectClaude(...args) },
    codex: { detect: (...args: unknown[]) => detectCodex(...args) },
  },
}));

const CLAUDE_CONNECTED: ClaudeDetectionResult = {
  state: 'detected',
  credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
  binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
};

const CODEX_CONNECTED: CodexDetectionResult = {
  state: 'detected',
  runtime: { found: true, path: '/app/codex', version: '0.144.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
};

beforeEach(() => {
  detectClaude.mockReset().mockResolvedValue({ success: true, data: CLAUDE_CONNECTED });
  detectCodex.mockReset().mockResolvedValue({ success: true, data: CODEX_CONNECTED });
});

describe('IntegrationsSettings', () => {
  it('shows Claude and Codex account status independently', async () => {
    render(<IntegrationsSettings />);

    expect(await screen.findByText('claude@example.com')).toBeInTheDocument();
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
    expect(screen.getByText(/ChatGPT plus · Codex 0\.144\.3/)).toBeInTheDocument();
    expect(screen.getAllByText('Connected')).toHaveLength(2);
  });

  it('keeps a connected provider usable when its sibling needs sign-in', async () => {
    detectClaude.mockResolvedValue({
      success: true,
      data: {
        state: 'loggedOut',
        credentials: { found: false, source: null, account: null },
        binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
      } satisfies ClaudeDetectionResult,
    });

    render(<IntegrationsSettings />);

    expect(await screen.findByText('Sign-in required')).toBeInTheDocument();
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('reports one failed probe without hiding the other provider and retries both', async () => {
    detectCodex.mockResolvedValueOnce({ success: false, error: 'Account probe timed out' });
    render(<IntegrationsSettings />);

    expect(await screen.findByText('Account probe timed out')).toBeInTheDocument();
    expect(await screen.findByText('claude@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(detectClaude).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(detectCodex).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
  });
});
