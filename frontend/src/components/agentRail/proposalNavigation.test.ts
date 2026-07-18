/**
 * proposalNavigation tests — the open-session discriminant dispatch. Mirrors
 * ReviewItemCard.test.tsx's "Review ideas navigates" test: setActiveRun /
 * setActiveQuickSession are stubbed out on the real store (they open a
 * run-event IPC subscription jsdom lacks) so only the navigation dispatch
 * itself is observed; goToSession is a plain state setter and runs for real.
 *
 * Also covers the cross-project fix: when the target carries a server-
 * resolved projectId, setActiveProjectId must fire BEFORE setActiveRun /
 * setActiveQuickSession (CyboflowRoot resolves the active run keyed off
 * whichever project is active at dispatch time); a target with no projectId
 * must leave today's behavior (no project activation call) unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { navigateToProposalTarget } from './proposalNavigation';
import { vi } from 'vitest';

const realSetActiveRun = useCyboflowStore.getState().setActiveRun;
const realSetActiveQuickSession = useCyboflowStore.getState().setActiveQuickSession;
const realSetActiveProjectId = useNavigationStore.getState().setActiveProjectId;

afterEach(() => {
  useCyboflowStore.setState({
    setActiveRun: realSetActiveRun,
    setActiveQuickSession: realSetActiveQuickSession,
  });
  useNavigationStore.setState({ view: 'home', setActiveProjectId: realSetActiveProjectId });
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

  it("activates the target's projectId BEFORE setActiveRun for a 'run' target", () => {
    const setActiveQuickSession = vi.fn();
    const calls: string[] = [];
    const setActiveProjectId = vi.fn((projectId: number | null) => {
      calls.push(`setActiveProjectId:${projectId}`);
    });
    const setActiveRun = vi.fn((runId: string) => {
      calls.push(`setActiveRun:${runId}`);
    });
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });
    useNavigationStore.setState({ setActiveProjectId });

    navigateToProposalTarget({ target: 'run', runId: 'run-9', projectId: 42 });

    expect(setActiveProjectId).toHaveBeenCalledWith(42);
    expect(calls).toEqual(['setActiveProjectId:42', 'setActiveRun:run-9']);
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it("activates the target's projectId BEFORE setActiveQuickSession for a 'quick-session' target", () => {
    const setActiveRun = vi.fn();
    const calls: string[] = [];
    const setActiveProjectId = vi.fn((projectId: number | null) => {
      calls.push(`setActiveProjectId:${projectId}`);
    });
    useCyboflowStore.setState({
      setActiveRun,
      setActiveQuickSession: vi.fn((sessionId: string, runId?: string) => {
        calls.push(`setActiveQuickSession:${sessionId}:${runId ?? 'undefined'}`);
      }),
    });
    useNavigationStore.setState({ setActiveProjectId });

    navigateToProposalTarget({ target: 'quick-session', sessionId: 'sess-7', runId: 'run-2', projectId: 11 });

    expect(setActiveProjectId).toHaveBeenCalledWith(11);
    expect(calls).toEqual(['setActiveProjectId:11', 'setActiveQuickSession:sess-7:run-2']);
    expect(setActiveRun).not.toHaveBeenCalled();
  });

  it('absent projectId keeps today\'s behavior: no project activation call', () => {
    const setActiveRun = vi.fn();
    const setActiveQuickSession = vi.fn();
    const setActiveProjectId = vi.fn();
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });
    useNavigationStore.setState({ setActiveProjectId });

    navigateToProposalTarget({ target: 'run', runId: 'run-1' });

    expect(setActiveProjectId).not.toHaveBeenCalled();
    expect(setActiveRun).toHaveBeenCalledWith('run-1');
  });
});
