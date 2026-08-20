/**
 * Unit tests for SubstrateSelector's global-lock behavior.
 *
 * useForcedSubstrate is mocked to drive the three precedence states the backend
 * pin can produce (null / 'interactive' / 'sdk').
 *
 * Behaviors verified:
 *   1. No pin (null) → normal <select> with scope-aware Codex availability;
 *      value NOT force-synced.
 *   2. interactivePtyOnly lock ('interactive') → read-only locked UI + caveats,
 *      and the controlled value is synced to 'interactive' via onChange.
 *   3. Demo pin ('sdk') → normal <select> (NOT the "interactive locked" UI) and
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
import { runtimesWithCapability } from '../../../../../shared/types/agentCapabilities';

/** Drive the picker's provider gate through the real config store. */
function setProviderAccess(access: AgentProviderAccess | undefined): void {
  useConfigStore.setState({
    config: { gitRepoPath: '/repo', agentProviderAccess: access } as AppConfig,
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
  it('renders workflow runtimes with Codex SDK enabled and the Codex CLI runtime disabled', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(screen.getByRole('combobox', { name: /select agent runtime/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude SDK/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Claude interactive/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex \(CLI\)/i })).toBeDisabled();
    expect(screen.getByText(/Workflows run on any structured runtime/i)).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders quick-session runtimes with both Codex runtimes enabled', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex \(CLI\)/i })).not.toBeDisabled();
    expect(screen.getByText(/The structured runtimes run quick-session chat/i)).toBeInTheDocument();
  });

  it('keeps both Codex runtimes available on the mixed launcher', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex \(CLI\)/i })).not.toBeDisabled();
    expect(screen.getByText(/A structured runtime can run workflows or quick sessions/i)).toBeInTheDocument();
  });

  it('ignores programmatic changes to a runtime disabled for the current scope', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="workflow" />);

    fireEvent.change(screen.getByRole('combobox', { name: /select agent runtime/i }), {
      target: { value: 'codex-pty' },
    });
    expect(onChange).not.toHaveBeenCalled();
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

describe('SubstrateSelector — provider access toggles', () => {
  it('hides both Codex runtimes when the Codex provider is switched off', () => {
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByRole('option', { name: /Claude SDK/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Codex/i })).not.toBeInTheDocument();
    expect(screen.getByText(/turned off in Settings → Integrations are hidden/i)).toBeInTheDocument();
  });

  it('hides both Claude runtimes when the Claude provider is switched off', () => {
    setProviderAccess({ claude: false, codex: true });
    render(<SubstrateSelector value="codex-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.queryByRole('option', { name: /Claude/i })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).toBeInTheDocument();
  });

  it('snaps a selection whose provider was just switched off back to an available runtime', () => {
    const onChange = vi.fn();
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="codex-sdk" onChange={onChange} runtimeScope="mixed" />);

    expect(onChange).toHaveBeenCalledWith('claude-sdk');
  });

  it('refuses a programmatic change to a runtime whose provider is switched off', () => {
    const onChange = vi.fn();
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="mixed" />);

    fireEvent.change(screen.getByRole('combobox', { name: /select agent runtime/i }), {
      target: { value: 'codex-sdk' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers both legacy providers when the toggles were never touched (absent config field)', () => {
    setProviderAccess(undefined);
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude SDK/i })).toBeInTheDocument();
    // OMP's absent key floors to DISABLED, so its lanes are access-hidden and
    // the "…are hidden" note now fires — accurately: there IS a provider the
    // user could switch on in Settings → Integrations.
    expect(screen.queryByRole('option', { name: /OMP/i })).not.toBeInTheDocument();
    expect(screen.getByText(/turned off in Settings → Integrations are hidden/i)).toBeInTheDocument();
  });

  it('hides OMP Fleet when the bridge is not configured (availability false)', () => {
    setProviderAccess(undefined);
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: false });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByRole('option', { name: /OMP Fleet/i })).not.toBeInTheDocument();
  });

  it('offers OMP Fleet when available and the omp provider is enabled', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByRole('option', { name: /OMP Fleet/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /OMP Fleet/i })).not.toBeDisabled();
  });

  // The gap that made the feature look broken: Aria mode hides the LOCAL OMP
  // runtimes by design, so hiding omp-fleet too (for a missing bridge) left an
  // Aria install with no OMP row at all — and the hidden-runtimes note counts
  // against the flavor list, so nothing on screen said why.
  it('offers OMP Fleet DISABLED, naming the reason, when Aria is on but no bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    const fleet = screen.getByRole('option', { name: /OMP fleet.*\(bridge not configured\)/i });
    expect(fleet).toBeInTheDocument();
    expect(fleet).toBeDisabled();
    // The local runtimes stay hidden — the two flavors are still alternatives.
    expect(screen.queryByRole('option', { name: /^OMP$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /OMP \(CLI\)/ })).not.toBeInTheDocument();
  });

  it('drops the reason once the bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    const fleet = screen.getByRole('option', { name: /^OMP fleet/ });
    expect(fleet).not.toBeDisabled();
    expect(fleet.textContent).not.toMatch(/bridge not configured/);
  });

  // A disabled row must not become the value the picker snaps to when the
  // current selection's provider is switched off.
  it('never falls back to an unavailable runtime', () => {
    setProviderAccess({ claude: false, codex: false, omp: true });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: true });
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    for (const [next] of onChange.mock.calls) expect(next).not.toBe('omp-fleet');
  });

  it('hides OMP Fleet when the omp provider toggle is off even if the bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: false });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByRole('option', { name: /OMP Fleet/i })).not.toBeInTheDocument();
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

/**
 * The option list is hand-ordered for display, but WHICH runtimes appear is a
 * capability question — `RUNTIME_CAPABILITIES.selectableInPickers`. Ties the two
 * together so a runtime declared unofferable can never quietly show up here (and
 * a newly offerable one is not silently omitted).
 */
describe('SubstrateSelector — offers exactly the picker-selectable runtimes', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue(null));

  // Aria mode makes the two OMP flavors ALTERNATIVES (a panel is either a local
  // OMP process or a supervised remote worker), so no single render can offer
  // every selectable runtime. The capability tie is preserved across the UNION
  // of both flavors instead: nothing selectable may be unreachable in both
  // modes, and nothing unselectable may appear in either.
  it('offers, across both OMP flavors, exactly the selectable runtimes', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });

    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: false });
    const local = render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    const localOffered = screen.getAllByRole('option').map((o) => o.getAttribute('value'));
    local.unmount();

    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    const ariaOffered = screen.getAllByRole('option').map((o) => o.getAttribute('value'));

    const selectable = runtimesWithCapability('selectableInPickers');
    expect([...new Set([...localOffered, ...ariaOffered])].sort()).toEqual([...selectable].sort());
    // And the flavors are genuinely exclusive, not merely different.
    expect(localOffered).toContain('omp-sdk');
    expect(localOffered).toContain('omp-pty');
    expect(localOffered).not.toContain('omp-fleet');
    expect(ariaOffered).toContain('omp-fleet');
    expect(ariaOffered).not.toContain('omp-sdk');
    expect(ariaOffered).not.toContain('omp-pty');
  });

  // The rows exist regardless of access (label and order are decided with the
  // row, not bolted on later) — with the provider off, access is the only
  // thing keeping them off screen, and an explicit false behaves like absent.
  it('hides the OMP rows while the provider is off, and offers them once on', () => {
    setProviderAccess({ claude: true, codex: true, omp: false });
    const { unmount } = render(
      <SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />,
    );
    let offered = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(offered).not.toContain('omp-sdk');
    expect(offered).not.toContain('omp-pty');
    unmount();

    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    offered = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(offered).toContain('omp-sdk');
    expect(offered).toContain('omp-pty');
  });

  // The T1 promotion, at the picker: `omp-sdk` is a real workflow launch target
  // and `omp-pty` still is not. The scope filter reads `workflowRuntimeForLaunch`
  // (i.e. WORKFLOW_LAUNCHABLE_RUNTIMES), so this is what proves the launchable
  // set actually reaches the workflow scope rather than the two OMP rows being
  // treated alike because they share a provider.
  it('enables omp-sdk but disables omp-pty on a workflow launch', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="workflow" />);

    expect(screen.getByRole('option', { name: 'OMP' })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: 'OMP (CLI)' })).toBeDisabled();
    // The Codex split is unchanged — this promotion moved one runtime, not the
    // whole "PTY is quick-session-only" rule.
    expect(screen.getByRole('option', { name: /^Codex SDK$/ })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex \(CLI\)/ })).toBeDisabled();
  });

  it('leaves both OMP rows selectable on a quick session', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByRole('option', { name: 'OMP' })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: 'OMP (CLI)' })).not.toBeDisabled();
  });

  // The note reads "…are hidden" only when the PROVIDER TOGGLES removed
  // something. Counting against the raw row list instead of the selectable one
  // would make it fire permanently: codex-exec is always unselectable and its
  // absence must never be reported as a switched-off provider.
  it('does not claim runtimes are hidden when only unselectable ones are absent', () => {
    // Availability probe ON — without it the selectable omp-fleet row would be
    // availability-hidden and spuriously read as a provider-toggle removal.
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByText(/are hidden/i)).not.toBeInTheDocument();
  });

  // The note names the PROVIDER TOGGLES, so the flavor split must not trip it:
  // Aria mode always hides one OMP flavor, and counting that against the full
  // selectable list would fire the note permanently with the wrong explanation.
  it('does not claim runtimes are hidden merely because a flavor is inactive', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });

    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: false });
    const local = render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    expect(screen.queryByText(/are hidden/i)).not.toBeInTheDocument();
    local.unmount();

    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);
    expect(screen.queryByText(/are hidden/i)).not.toBeInTheDocument();
  });

  // Aria mode ON but the bridge is not usable yet. This case USED to offer no
  // OMP row at all — the local rows hidden because it is a fleet install, the
  // fleet row hidden because it would fail closed — which left a picker with no
  // OMP while Settings → Integrations still reported the provider enabled, and
  // no note explaining it. The fleet row is now offered and DISABLED, carrying
  // the reason, so the state is self-describing.
  it('offers the fleet row disabled, and still no local rows, when the fleet is not launchable', () => {
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: true });
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    const offered = screen.getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(offered).toContain('omp-fleet');
    expect(screen.getByRole('option', { name: /OMP fleet.*\(bridge not configured\)/i })).toBeDisabled();
    // The flavors are still alternatives — Aria mode means no local OMP.
    expect(offered).not.toContain('omp-sdk');
    expect(offered).not.toContain('omp-pty');
  });
});

/**
 * The OMP caveats panels (added alongside the row's pre-existing capability
 * gate — see the block above). `value` is forced directly so each runtime's
 * copy is exercised independently of provider-access settings.
 */
describe('SubstrateSelector — OMP caveats copy (v1 limits)', () => {
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

  it('shows no caveats panel for an ordinary claude-sdk value', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByTestId('substrate-caveats')).not.toBeInTheDocument();
  });
});
