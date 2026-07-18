/**
 * proposalNavigation tests — the open-session discriminant dispatch. Mirrors
 * ReviewItemCard.test.tsx's "Review ideas navigates" test: setActiveRun /
 * setActiveQuickSession are stubbed out on the real store (they open a
 * run-event IPC subscription jsdom lacks) so only the navigation dispatch
 * itself is observed; goToSession is a plain state setter and runs for real.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { navigateToProposalTarget } from './proposalNavigation';
import { vi } from 'vitest';

const realSetActiveRun = useCyboflowStore.getState().setActiveRun;
const realSetActiveQuickSession = useCyboflowStore.getState().setActiveQuickSession;

afterEach(() => {
  useCyboflowStore.setState({
    setActiveRun: realSetActiveRun,
    setActiveQuickSession: realSetActiveQuickSession,
  });
  useNavigationStore.setState({ view: 'home' });
});

describe('navigateToProposalTarget', () => {
  it("routes {target: 'run'} through setActiveRun, never setActiveQuickSession", () => {
    const setActiveRun = vi.fn();
    const setActiveQuickSession = vi.fn();
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });

    navigateToProposalTarget({ target: 'run', runId: 'run-1' });

    expect(setActiveRun).toHaveBeenCalledWith('run-1');
    expect(setActiveQuickSession).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it("routes {target: 'quick-session'} through setActiveQuickSession with its runId, never setActiveRun", () => {
    const setActiveRun = vi.fn();
    const setActiveQuickSession = vi.fn();
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });

    navigateToProposalTarget({ target: 'quick-session', sessionId: 'sess-1', runId: 'run-2' });

    expect(setActiveQuickSession).toHaveBeenCalledWith('sess-1', 'run-2');
    expect(setActiveRun).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it("routes a RESTING quick session (no runId) through setActiveQuickSession with runId undefined — never setActiveRun's 'Loading workflow…' trap", () => {
    const setActiveRun = vi.fn();
    const setActiveQuickSession = vi.fn();
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });

    navigateToProposalTarget({ target: 'quick-session', sessionId: 'sess-idle' });

    expect(setActiveQuickSession).toHaveBeenCalledWith('sess-idle', undefined);
    expect(setActiveRun).not.toHaveBeenCalled();
  });
});
