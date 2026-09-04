/**
 * Unit tests for SubstrateSelector's global-lock behavior and the
 * provider + mode segmented rendering (incl. the OMP flavor swap and the
 * Aria-mode bridge gating).
 *
 * useForcedSubstrate is mocked to drive the three precedence states the backend
 * pin can produce (null / 'interactive' / 'sdk'); useOmpAvailability is mocked
 * to drive the OMP flavor (local vs Aria fleet) and bridge availability.
 *
 * Behaviors verified:
 *   1. No pin (null) → Runtime (provider) + Mode segments with scope-aware
 *      CLI availability; value NOT force-synced.
 *   2. interactivePtyOnly lock ('interactive') → read-only locked UI + caveats,
 *      and the controlled value is synced to 'interactive' via onChange.
 *   3. Demo pin ('sdk') → normal segments (NOT the "interactive locked" UI) and
 *      the value is left alone, so demo never falsely claims interactive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { mockUseForcedSubstrate } = vi.hoisted(() => ({
  mockUseForcedSubstrate: vi.fn<() => 'sdk' | 'interactive' | null>(() => null),
}));

vi.mock('../../../hooks/useForcedSubstrate', () => ({
  useForcedSubstrate: mockUseForcedSubstrate,
}));

const { mockUseOmpAvailability } = vi.hoisted(() => ({
  mockUseOmpAvailability: vi.fn<() => { launchable: boolean; ariaMode: boolean }>(() => ({
    launchable: false,
    ariaMode: false,
  })),
}));

vi.mock('../../../hooks/useOmpAvailability', () => ({
  useOmpAvailability: mockUseOmpAvailability,
}));

import { SubstrateSelector } from '../SubstrateSelector';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';
import type { AgentProviderAccess } from '../../../../../shared/types/agentRuntime';

/**
 * Drive the picker's provider gate through the real config store. `ariaMode`
 * matters because Aria-gated providers (pi) are forced off in
 * `useAgentProviderAccess` regardless of their access key.
 */
function setProviderAccess(access: AgentProviderAccess | undefined, ariaMode = false): void {
  useConfigStore.setState({
    config: { gitRepoPath: '/repo', agentProviderAccess: access, ariaMode } as AppConfig,
  });
}

beforeEach(() => {
  mockUseForcedSubstrate.mockReset();
  mockUseForcedSubstrate.mockReturnValue(null);
  mockUseOmpAvailability.mockReset();
  mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: false });
  useConfigStore.setState({ config: null });
});

describe('SubstrateSelector — no forced pin', () => {
  it('renders provider segments and HIDES the Mode row for Codex on a workflow launch', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="codex-sdk" onChange={onChange} />);

    expect(screen.getByRole('radiogroup', { name: 'Runtime' })).toBeInTheDocument();
    expect(screen.getByTestId('substrate-select-provider-claude')).toBeInTheDocument();
    expect(screen.getByTestId('substrate-select-provider-codex')).toHaveAttribute('aria-checked', 'true');
    // Codex has no launchable CLI lane on a workflow launch, so the whole Mode
    // row is hidden rather than showing a permanently-greyed CLI segment.
    expect(screen.queryByRole('radiogroup', { name: 'Mode' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('substrate-select-mode-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('substrate-select-mode-cli')).not.toBeInTheDocument();
    expect(screen.getByText(/Workflows run on any structured runtime/i)).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the Mode row (CLI enabled) for Claude on a workflow launch (claude-interactive is launchable)', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} />);

    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeInTheDocument();
    expect(screen.getByTestId('substrate-select-mode-cli')).not.toBeDisabled();
  });

  it('enables the Codex CLI lane on a quick-session launch', () => {
    render(<SubstrateSelector value="codex-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByTestId('substrate-select-mode-cli')).not.toBeDisabled();
    expect(screen.getByText(/The structured runtimes run quick-session chat/i)).toBeInTheDocument();
  });

  it('keeps the Codex CLI lane available on the mixed launcher', () => {
    render(<SubstrateSelector value="codex-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByTestId('substrate-select-mode-cli')).not.toBeDisabled();
    expect(screen.getByText(/A structured runtime can run workflows or quick sessions/i)).toBeInTheDocument();
  });

  it('offers no CLI segment at all for a provider whose CLI lane is scope-disabled', () => {
    render(<SubstrateSelector value="codex-sdk" onChange={vi.fn()} runtimeScope="workflow" />);

    expect(screen.queryByTestId('substrate-select-mode-cli')).not.toBeInTheDocument();
  });

  it('clicking a provider keeps the current mode when the target lane offers it', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    fireEvent.click(screen.getByTestId('substrate-select-provider-codex'));
    expect(onChange).toHaveBeenCalledWith('codex-sdk');
  });

  it('clicking a provider falls back to Chat when the current CLI mode is not offerable there', () => {
    const onChange = vi.fn();
    render(
      <SubstrateSelector value="claude-interactive" onChange={onChange} runtimeScope="workflow" />,
    );

    fireEvent.click(screen.getByTestId('substrate-select-provider-codex'));
    expect(onChange).toHaveBeenCalledWith('codex-sdk');
  });

  it('clicking the CLI mode segment reports the provider-matched CLI runtime', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="codex-sdk" onChange={onChange} runtimeScope="session" />);

    fireEvent.click(screen.getByTestId('substrate-select-mode-cli'));
    expect(onChange).toHaveBeenCalledWith('codex-pty');
  });
});

describe('SubstrateSelector — interactive PTY-only lock', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue('interactive'));

  it('renders the read-only locked state with caveats and no segments', () => {
    render(<SubstrateSelector value="claude-interactive" onChange={vi.fn()} />);

    expect(screen.getByTestId('substrate-locked')).toBeInTheDocument();
    expect(screen.getByTestId('substrate-caveats')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
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

describe('SubstrateSelector — provider access toggles', () => {
  it('hides the Codex provider segment when the Codex provider is switched off', () => {
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByTestId('substrate-select-provider-claude')).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-select-provider-codex')).not.toBeInTheDocument();
    expect(screen.getByText(/turned off in Settings → Integrations are hidden/i)).toBeInTheDocument();
  });

  it('hides the Claude provider segment when the Claude provider is switched off', () => {
    setProviderAccess({ claude: false, codex: true });
    render(<SubstrateSelector value="codex-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.queryByTestId('substrate-select-provider-claude')).not.toBeInTheDocument();
    expect(screen.getByTestId('substrate-select-provider-codex')).toBeInTheDocument();
  });

  it('snaps a selection whose provider was just switched off back to an available runtime', () => {
    const onChange = vi.fn();
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="codex-sdk" onChange={onChange} runtimeScope="mixed" />);

    expect(onChange).toHaveBeenCalledWith('claude-sdk');
  });

  it('offers both legacy providers when the toggles were never touched (absent config field)', () => {
    setProviderAccess(undefined);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByTestId('substrate-select-provider-claude')).toBeInTheDocument();
    expect(screen.getByTestId('substrate-select-provider-codex')).toBeInTheDocument();
    // OMP's and Pi's absent keys floor to DISABLED, so their columns are
    // access-hidden and the "…are hidden" note fires — accurately: there ARE
    // providers the user could switch on in Settings → Integrations.
    expect(screen.queryByTestId('substrate-select-provider-omp')).not.toBeInTheDocument();
    expect(screen.queryByTestId('substrate-select-provider-pi')).not.toBeInTheDocument();
    expect(screen.getByText(/turned off in Settings → Integrations are hidden/i)).toBeInTheDocument();
  });

  it('surfaces the PTY-only ⨯ Claude-off conflict instead of a picker with no options', () => {
    mockUseForcedSubstrate.mockReturnValue('interactive');
    const onChange = vi.fn();
    setProviderAccess({ claude: false, codex: true });
    render(<SubstrateSelector value="codex-sdk" onChange={onChange} />);

    expect(screen.getByTestId('substrate-provider-conflict')).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    // The lock's claude-interactive sync must NOT fire onto a disabled provider.
    expect(onChange).not.toHaveBeenCalledWith('claude-interactive');
  });
});

describe('SubstrateSelector — OMP flavor swap + fleet availability', () => {
  it('offers the LOCAL OMP lanes (Chat/CLI) while Aria mode is off', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: false });
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    fireEvent.click(screen.getByTestId('substrate-select-provider-omp'));
    expect(onChange).toHaveBeenCalledWith('omp-sdk');
  });

  it('offers the fleet lane when Aria is on and the bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    const ompSegment = screen.getByTestId('substrate-select-provider-omp');
    expect(ompSegment).not.toBeDisabled();
    fireEvent.click(ompSegment);
    expect(onChange).toHaveBeenCalledWith('omp-fleet');
  });

  it('renders no Mode row while the fleet lane is selected (a single-lane column)', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="omp-fleet" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByTestId('substrate-select-provider-omp')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radiogroup', { name: 'Mode' })).not.toBeInTheDocument();
  });

  // The gap that made the feature look broken: Aria mode hides the LOCAL OMP
  // runtimes by design, so hiding the column too (for a missing bridge) left an
  // Aria install with no OMP anywhere — and nothing on screen said why. It is
  // offered DISABLED with the reason instead.
  it('offers the OMP segment DISABLED, naming the reason, when Aria is on but no bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: true });
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    const ompSegment = screen.getByTestId('substrate-select-provider-omp');
    expect(ompSegment).toBeDisabled();
    expect(ompSegment).toHaveAttribute('title', 'bridge not configured');
    fireEvent.click(ompSegment);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('drops the disabled state once the bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    const ompSegment = screen.getByTestId('substrate-select-provider-omp');
    expect(ompSegment).not.toBeDisabled();
    expect(ompSegment).not.toHaveAttribute('title');
  });

  // A disabled lane must not become the value the picker snaps to when the
  // current selection's provider is switched off.
  it('never falls back to an unavailable runtime', () => {
    setProviderAccess({ claude: false, codex: false, omp: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: true });
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    for (const [next] of onChange.mock.calls) expect(next).not.toBe('omp-fleet');
  });

  it('hides the OMP column when the omp provider toggle is off even if the bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: false });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByTestId('substrate-select-provider-omp')).not.toBeInTheDocument();
  });
});

describe('SubstrateSelector — demo pin (sdk wins)', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue('sdk'));

  it('renders the normal segments (not the interactive-locked UI) and leaves the value alone', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(screen.getByRole('radiogroup', { name: 'Runtime' })).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * WHICH providers/lanes appear is a capability question —
 * `RUNTIME_CAPABILITIES.selectableInPickers` — plus the provider toggles and
 * the OMP flavor.
 */
describe('SubstrateSelector — offers exactly the picker-selectable providers', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue(null));

  it('renders one provider segment per provider when all are on', () => {
    // Aria mode too: pi is Aria-gated, so "all providers on" is not enough to
    // surface its column.
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true }, true);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    for (const provider of ['claude', 'codex', 'omp', 'pi']) {
      expect(screen.getByTestId(`substrate-select-provider-${provider}`)).toBeInTheDocument();
    }
  });

  /**
   * The Aria gate at the picker. pi's lane is materially less complete than the
   * others (no delegation tool, no cyboflow MCP surface), so a non-Aria install
   * must not be offered it even with its access key switched on — a key a
   * pre-gate config or an MCP-pinned agent config can carry.
   */
  it('hides the Pi column off Aria mode even when its access key is on', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true }, false);
    const { unmount } = render(
      <SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />,
    );
    expect(screen.queryByTestId('substrate-select-provider-pi')).not.toBeInTheDocument();
    // Its siblings are untouched by the gate.
    expect(screen.getByTestId('substrate-select-provider-claude')).toBeInTheDocument();
    expect(screen.getByTestId('substrate-select-provider-omp')).toBeInTheDocument();
    unmount();

    setProviderAccess({ claude: true, codex: true, omp: true, pi: true }, true);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    expect(screen.getByTestId('substrate-select-provider-pi')).toBeInTheDocument();
  });

  /** Aria mode surfaces pi; it does not switch it on. */
  it('still hides the Pi column under Aria mode when its access key is off', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: false }, true);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    expect(screen.queryByTestId('substrate-select-provider-pi')).not.toBeInTheDocument();
  });

  it('hides the OMP column while the provider is off, and offers it once on', () => {
    setProviderAccess({ claude: true, codex: true, omp: false, pi: true });
    const { unmount } = render(
      <SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />,
    );
    expect(screen.queryByTestId('substrate-select-provider-omp')).not.toBeInTheDocument();
    unmount();

    setProviderAccess({ claude: true, codex: true, omp: true, pi: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    expect(screen.getByTestId('substrate-select-provider-omp')).toBeInTheDocument();
  });

  // The T1 promotion, at the picker: `omp-sdk` is a real workflow launch target
  // and `omp-pty` still is not. The scope filter reads `workflowRuntimeForLaunch`
  // (i.e. WORKFLOW_LAUNCHABLE_RUNTIMES), so with OMP selected on a workflow
  // launch the Mode row hides (no launchable CLI lane).
  it('offers omp-sdk but hides the Mode row (no omp-pty) on a workflow launch', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true });
    render(<SubstrateSelector value="omp-sdk" onChange={vi.fn()} runtimeScope="workflow" />);

    expect(screen.getByTestId('substrate-select-provider-omp')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('radiogroup', { name: 'Mode' })).not.toBeInTheDocument();
  });

  it('leaves both OMP lanes selectable on a quick session', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true, agy: true });
    render(<SubstrateSelector value="omp-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByTestId('substrate-select-mode-chat')).not.toBeDisabled();
    expect(screen.getByTestId('substrate-select-mode-cli')).not.toBeDisabled();
  });

  it('leaves both Antigravity lanes selectable on a quick session', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true, agy: true });
    render(<SubstrateSelector value="agy-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByTestId('substrate-select-mode-chat')).not.toBeDisabled();
    expect(screen.getByTestId('substrate-select-mode-cli')).not.toBeDisabled();
  });

  // The note reads "…are hidden" only when the PROVIDER TOGGLES removed
  // something — never because an unselectable runtime (codex-exec) has no
  // segment, and never merely because the OMP flavor swapped lanes.
  it('does not claim runtimes are hidden when every provider is on', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true, agy: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByText(/are hidden/i)).not.toBeInTheDocument();
  });

  it('does not claim runtimes are hidden merely because a flavor is inactive', () => {
    setProviderAccess({ claude: true, codex: true, omp: true, pi: true, agy: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByText(/are hidden/i)).not.toBeInTheDocument();
  });
});

/**
 * The OMP/Pi caveats panels. `value` is forced directly so each runtime's copy
 * is exercised independently of provider-access settings.
 */
describe('SubstrateSelector — OMP + Pi caveats copy (v1 limits)', () => {
  it('shows the omp-sdk caveats when the value is forced to omp-sdk', () => {
    render(<SubstrateSelector value="omp-sdk" onChange={vi.fn()} runtimeScope="session" />);

    const panel = screen.getByTestId('substrate-caveats');
    expect(panel).toHaveTextContent('OMP — v1 limits');
    expect(panel).not.toHaveTextContent('No question gate yet');
    expect(panel).toHaveTextContent('Slow approvals (over 25s) are blocked and can be retried');
  });

  it('shows the omp-pty caveats when the value is forced to omp-pty', () => {
    render(<SubstrateSelector value="omp-pty" onChange={vi.fn()} runtimeScope="session" />);

    const panel = screen.getByTestId('substrate-caveats');
    expect(panel).toHaveTextContent('OMP (CLI) — v1 limits');
    expect(panel).toHaveTextContent('Approvals stay in the OMP CLI');
    expect(panel).toHaveTextContent('no Cyboflow review-queue integration');
  });

  it('shows the pi-sdk caveats when the value is forced to pi-sdk', () => {
    render(<SubstrateSelector value="pi-sdk" onChange={vi.fn()} runtimeScope="session" />);

    const panel = screen.getByTestId('substrate-caveats');
    expect(panel).toHaveTextContent('Pi — v1 limits');
    expect(panel).toHaveTextContent('Write-tier tools are blocked');
  });

  it('shows the pi-pty caveats when the value is forced to pi-pty', () => {
    render(<SubstrateSelector value="pi-pty" onChange={vi.fn()} runtimeScope="session" />);

    const panel = screen.getByTestId('substrate-caveats');
    expect(panel).toHaveTextContent('Pi (CLI) — v1 limits');
    expect(panel).toHaveTextContent('Approvals stay inside the pi TUI');
  });

  it('shows the agy-sdk caveats when the value is forced to agy-sdk', () => {
    render(<SubstrateSelector value="agy-sdk" onChange={vi.fn()} runtimeScope="session" />);

    const panel = screen.getByTestId('substrate-caveats');
    expect(panel).toHaveTextContent('Antigravity — v1 limits');
    expect(panel).toHaveTextContent('Auto-approves tool requests');
  });

  it('shows the agy-pty caveats when the value is forced to agy-pty', () => {
    render(<SubstrateSelector value="agy-pty" onChange={vi.fn()} runtimeScope="session" />);

    const panel = screen.getByTestId('substrate-caveats');
    expect(panel).toHaveTextContent('Antigravity (CLI) — v1 limits');
    expect(panel).toHaveTextContent('Approvals stay inside the Antigravity TUI');
  });

  it('shows no caveats panel for an ordinary claude-sdk value', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByTestId('substrate-caveats')).not.toBeInTheDocument();
  });
});
