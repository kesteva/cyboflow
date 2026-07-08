/**
 * Unit tests for SubstrateSelector's global-lock behavior.
 *
 * useForcedSubstrate is mocked to drive the three precedence states the backend
 * pin can produce (null / 'interactive' / 'sdk').
 *
 * Behaviors verified:
 *   1. No pin (null) → normal <select> with enabled Claude options and disabled
 *      Codex roadmap options; value NOT force-synced.
 *   2. interactivePtyOnly lock ('interactive') → read-only locked UI + caveats,
 *      and the controlled value is synced to 'interactive' via onChange.
 *   3. Demo pin ('sdk') → normal <select> (NOT the "interactive locked" UI) and
 *      the value is left alone, so demo never falsely claims interactive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseForcedSubstrate } = vi.hoisted(() => ({
  mockUseForcedSubstrate: vi.fn<() => 'sdk' | 'interactive' | null>(() => null),
}));

vi.mock('../../../hooks/useForcedSubstrate', () => ({
  useForcedSubstrate: mockUseForcedSubstrate,
}));

import { SubstrateSelector } from '../SubstrateSelector';

beforeEach(() => {
  mockUseForcedSubstrate.mockReset();
  mockUseForcedSubstrate.mockReturnValue(null);
});

describe('SubstrateSelector — no forced pin', () => {
  it('renders the select with disabled Codex workflow runtimes and does not force-sync the value', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(screen.getByRole('combobox', { name: /select agent runtime/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude SDK/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Claude interactive/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex SDK/i })).toBeDisabled();
    expect(screen.queryByRole('option', { name: /Codex PTY/i })).toBeNull();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows Codex PTY only for session-capable runtime scopes, enabled', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByRole('option', { name: /Codex PTY/i })).not.toBeDisabled();
  });
});

describe('SubstrateSelector — interactive PTY-only lock', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue('interactive'));

  it('renders the read-only locked state with caveats and no <select>', () => {
    render(<SubstrateSelector value="claude-interactive" onChange={vi.fn()} />);

    expect(screen.getByTestId('substrate-locked')).toBeInTheDocument();
    expect(screen.getByTestId('substrate-caveats')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('syncs the controlled value to interactive when it was sdk', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith('claude-interactive');
  });

  it('does not re-fire onChange once the value is already interactive', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-interactive" onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SubstrateSelector — demo pin (sdk wins)', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue('sdk'));

  it('renders the normal select (not the interactive-locked UI) and leaves the value alone', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(screen.getByRole('combobox', { name: /select agent runtime/i })).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
