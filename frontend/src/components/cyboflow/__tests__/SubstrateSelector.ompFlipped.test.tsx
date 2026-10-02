/**
 * SubstrateSelector under the FLIPPED `selectableInPickers` state for OMP.
 *
 * Separate file from SubstrateSelector.test.tsx on purpose: it mocks the
 * capability module so the OMP lanes are picker-selectable regardless of what
 * the shipped RUNTIME_CAPABILITIES table says (the "last Phase-1 step"
 * docs/proposals/omp-provider-integration.md §5.5 describes) — proving the
 * provider column, its onChange wiring, and the provider-toggle interplay all
 * work under the flip, with everything else (every other runtime's
 * selectability) delegating to the real implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../hooks/useForcedSubstrate', () => ({
  useForcedSubstrate: () => null,
}));

vi.mock('../../../../../shared/types/agentCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../shared/types/agentCapabilities')>();
  return {
    ...actual,
    isRuntimeSelectableInPickers: (runtime: string | null | undefined) =>
      runtime === 'omp-sdk' || runtime === 'omp-pty' ? true : actual.isRuntimeSelectableInPickers(runtime),
  };
});

import { SubstrateSelector } from '../SubstrateSelector';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';
import type { AgentProviderAccess } from '../../../../../shared/types/agentRuntime';

function setProviderAccess(access: AgentProviderAccess | undefined): void {
  useConfigStore.setState({
    config: { agentProviderAccess: access } as AppConfig,
  });
}

beforeEach(() => {
  useConfigStore.setState({ config: null });
});

describe('SubstrateSelector — OMP lanes once selectableInPickers flips', () => {
  it('offers the OMP provider with both lanes enabled once flipped AND the provider is on', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="omp-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByTestId('substrate-select-provider-omp')).toBeInTheDocument();
    expect(screen.getByTestId('substrate-select-mode-chat')).not.toBeDisabled();
    expect(screen.getByTestId('substrate-select-mode-cli')).not.toBeDisabled();
  });

  it('still hides the OMP column when flipped but the provider itself is off (absent ⇒ disabled)', () => {
    setProviderAccess({ claude: true, codex: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByTestId('substrate-select-provider-omp')).not.toBeInTheDocument();
  });

  it('clicking the OMP provider segment fires onChange with the runtime id', () => {
    const onChange = vi.fn();
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    fireEvent.click(screen.getByTestId('substrate-select-provider-omp'));
    expect(onChange).toHaveBeenCalledWith('omp-sdk');
  });

  it('renders the OMP — v1 limits caveats once omp-sdk is the live selected value', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="omp-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByTestId('substrate-caveats')).toHaveTextContent('OMP — v1 limits');
  });
});
