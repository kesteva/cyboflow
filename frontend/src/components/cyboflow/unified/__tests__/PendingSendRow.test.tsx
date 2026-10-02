/**
 * PendingSendRow — presentational optimistic-echo strip tests.
 *
 * Covers:
 *   - renders each status with its distinct treatment + the message text
 *   - 'queued' and 'failed' rows are clickable (call onReopen); 'sending' is not
 *   - empty entries → renders nothing
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingSendRow } from '../PendingSendRow';
import { useNavigationStore } from '../../../../stores/navigationStore';
import { useConfigStore } from '../../../../stores/configStore';
import type { AppConfig } from '../../../../types/config';
import { formatAgentProviderDisabled } from '../../../../../../shared/types/agentRuntime';
import type { PendingSend } from '../../../../stores/pendingSendStore';

function entry(over: Partial<PendingSend>): PendingSend {
  return { id: 'e1', text: 'hello world', createdAt: Date.now(), status: 'sending', ...over };
}

/** Drive the row's live provider-access read through the real config store. */
function setProviderAccess(access: { claude: boolean; codex: boolean } | undefined): void {
  useConfigStore.setState({
    config: { agentProviderAccess: access } as AppConfig,
  });
}

beforeEach(() => {
  // Default: Claude OFF, Codex on. NOT both-off — resolveAgentProviderAccess
  // floors an all-off map back to both-ON (the app must never be left unable to
  // launch anything), which would silently read as "recovered". Tests that need
  // a different posture set it themselves.
  setProviderAccess({ claude: false, codex: true });
});

describe('PendingSendRow', () => {
  it('renders nothing when there are no entries', () => {
    const { container } = render(<PendingSendRow entries={[]} onReopen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the text for each entry with a status-specific testid', () => {
    render(
      <PendingSendRow
        entries={[
          entry({ id: 's', text: 'sending one', status: 'sending' }),
          entry({ id: 'q', text: 'queued one', status: 'queued' }),
          entry({ id: 'f', text: 'failed one', status: 'failed' }),
        ]}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.getByTestId('pending-send-sending')).toHaveTextContent('sending one');
    expect(screen.getByTestId('pending-send-queued')).toHaveTextContent('queued one');
    expect(screen.getByTestId('pending-send-failed')).toHaveTextContent('failed one');
  });

  it('calls onReopen for queued and failed rows, but NOT for sending', () => {
    const onReopen = vi.fn();
    render(
      <PendingSendRow
        entries={[
          entry({ id: 's', status: 'sending' }),
          entry({ id: 'q', status: 'queued' }),
          entry({ id: 'f', status: 'failed' }),
        ]}
        onReopen={onReopen}
      />,
    );

    fireEvent.click(screen.getByTestId('pending-send-sending'));
    expect(onReopen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pending-send-queued'));
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(onReopen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'q' }));

    fireEvent.click(screen.getByTestId('pending-send-failed'));
    expect(onReopen).toHaveBeenCalledTimes(2);
    expect(onReopen).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'f' }));
  });

  it('shows the failure REASON so the row explains itself', () => {
    render(
      <PendingSendRow
        entries={[entry({ id: 'f', status: 'failed', error: 'Worktree is locked' })]}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.getByTestId('pending-send-reason')).toHaveTextContent('Worktree is locked');
  });

  it('never shows a stale reason on a non-failed row', () => {
    render(
      <PendingSendRow
        entries={[entry({ id: 'q', status: 'queued', error: 'stale' })]}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('pending-send-reason')).not.toBeInTheDocument();
  });

  it('offers Settings → Integrations for a provider-disabled failure, and strips the wire code', () => {
    useNavigationStore.setState({ settingsOpen: false, settingsTab: 'general' });
    const wire = formatAgentProviderDisabled(
      'claude',
      'Claude is turned off, so Claude agent calls cannot run.',
    );
    render(
      <PendingSendRow
        entries={[entry({ id: 'f', status: 'failed', error: wire })]}
        onReopen={vi.fn()}
      />,
    );

    // The machine prefix is display noise — the user reads the sentence only.
    const reason = screen.getByTestId('pending-send-reason');
    expect(reason).toHaveTextContent('Claude is turned off, so Claude agent calls cannot run.');
    expect(reason.textContent).not.toContain('ERR_AGENT_PROVIDER_DISABLED');

    fireEvent.click(screen.getByTestId('pending-send-open-integrations'));
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsTab).toBe('integrations');
  });

  it('offers no Settings shortcut for an ordinary failure', () => {
    render(
      <PendingSendRow
        entries={[entry({ id: 'f', status: 'failed', error: 'Failed to continue panel' })]}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('pending-send-open-integrations')).not.toBeInTheDocument();
  });

  it('keeps the retry click working alongside the Settings action', () => {
    setProviderAccess({ claude: true, codex: false });
    const onReopen = vi.fn();
    render(
      <PendingSendRow
        entries={[
          entry({
            id: 'f',
            status: 'failed',
            error: formatAgentProviderDisabled('codex', 'Codex is turned off.'),
          }),
        ]}
        onReopen={onReopen}
      />,
    );
    fireEvent.click(screen.getByTestId('pending-send-failed'));
    expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'f' }));
  });

  it('re-frames a provider-disabled row once that provider is switched back on', () => {
    setProviderAccess({ claude: true, codex: true });
    render(
      <PendingSendRow
        entries={[
          entry({
            id: 'f',
            text: 'You there?',
            status: 'failed',
            error: formatAgentProviderDisabled('codex', 'Codex is turned off, so it cannot run.'),
          }),
        ]}
        onReopen={vi.fn()}
      />,
    );

    // The stale reason and the now-pointless Settings shortcut both go...
    expect(screen.queryByTestId('pending-send-open-integrations')).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-send-reason')).toHaveTextContent('Codex is back on');
    expect(screen.queryByText(/Codex is turned off/)).not.toBeInTheDocument();
    // ...but the row itself STAYS: it holds the only copy of the unsent message.
    expect(screen.getByTestId('pending-send-failed')).toHaveTextContent('You there?');
    expect(screen.getByTestId('pending-send-failed')).toHaveTextContent('Not sent · click to retry');
  });

  it('keeps the disabled treatment while that provider is still off', () => {
    setProviderAccess({ claude: true, codex: false });
    render(
      <PendingSendRow
        entries={[
          entry({
            id: 'f',
            status: 'failed',
            error: formatAgentProviderDisabled('codex', 'Codex is turned off.'),
          }),
        ]}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.getByTestId('pending-send-open-integrations')).toBeInTheDocument();
    expect(screen.getByTestId('pending-send-reason')).toHaveTextContent('Codex is turned off.');
  });

  it('recovers per-provider — a Claude row is unaffected by Codex coming back', () => {
    setProviderAccess({ claude: false, codex: true });
    render(
      <PendingSendRow
        entries={[
          entry({
            id: 'f',
            status: 'failed',
            error: formatAgentProviderDisabled('claude', 'Claude is turned off.'),
          }),
        ]}
        onReopen={vi.fn()}
      />,
    );
    expect(screen.getByTestId('pending-send-open-integrations')).toBeInTheDocument();
    expect(screen.getByTestId('pending-send-reason')).toHaveTextContent('Claude is turned off.');
  });

  it('still reopens a recovered row so the retry actually sends', () => {
    setProviderAccess({ claude: true, codex: true });
    const onReopen = vi.fn();
    render(
      <PendingSendRow
        entries={[
          entry({
            id: 'f',
            status: 'failed',
            error: formatAgentProviderDisabled('codex', 'Codex is turned off.'),
          }),
        ]}
        onReopen={onReopen}
      />,
    );
    fireEvent.click(screen.getByTestId('pending-send-failed'));
    expect(onReopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'f' }));
  });
});
