/**
 * useGlobalKeyboardShortcuts tests — the ONE window keydown listener that drives
 * the six remappable app shortcuts.
 *
 * Real stores throughout (they are plain zustand, no IPC on these paths); only
 * the platform sniff is stubbed, since `getShortcutPlatform` decides whether
 * 'mod' means Cmd or Ctrl and jsdom is neither.
 *
 * Environment: jsdom.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';

import { useGlobalKeyboardShortcuts } from '../useGlobalKeyboardShortcuts';
import { useKeyboardShortcutsStore } from '../../stores/keyboardShortcutsStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig } from '../../types/config';
import { useNavigationStore } from '../../stores/navigationStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import {
  COMPOSER_FOCUS_ATTR,
  useComposerFocusStore,
} from '../../stores/composerFocusStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Force the platform 'mod' resolves against (getShortcutPlatform sniffs these). */
function setPlatform(platform: 'mac' | 'other'): void {
  Object.defineProperty(window.navigator, 'platform', {
    value: platform === 'mac' ? 'MacIntel' : 'Win32',
    configurable: true,
  });
  Object.defineProperty(window.navigator, 'userAgent', {
    value:
      platform === 'mac'
        ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    configurable: true,
  });
}

/** Fire a Ctrl-modified keydown on window (the 'other' platform's `mod`). */
function pressCtrl(key: string, extra: Record<string, unknown> = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

const trackedTextareas: HTMLTextAreaElement[] = [];

/** A focused textarea registered as the composer for `key`. */
function focusedComposer(key: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.setAttribute(COMPOSER_FOCUS_ATTR, key);
  document.body.appendChild(el);
  trackedTextareas.push(el);
  el.focus();
  return el;
}

beforeEach(() => {
  setPlatform('other');
  useKeyboardShortcutsStore.setState({ overrides: {}, hydrated: true });
  useLayoutStore.setState({
    leftRailCollapsed: false,
    rightRailCollapsed: false,
    agentRailCollapsed: false,
  });
  useConfigStore.setState({ config: null });
  useNavigationStore.setState({
    view: 'home',
    wizardOpts: null,
    humanReviewOpen: false,
    backlogOpen: false,
    agentsEnvOpen: false,
    agentsEnvAgentId: null,
    settingsOpen: false,
    settingsTab: 'general',
  });
  useCyboflowStore.setState({ activeRunId: null, selectedSessionId: null });
  useActiveRunsStore.setState({ runsByProject: {} });
  useCenterPaneStore.setState({ bySession: {} });
  useComposerFocusStore.setState({ request: null });
  localStorage.clear();
});

afterEach(() => {
  while (trackedTextareas.length > 0) trackedTextareas.pop()?.remove();
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — dispatch', () => {
  it('mod+n opens the new-session wizard with NO locked project', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('n');
    expect(useNavigationStore.getState().view).toBe('wizard');
    expect(useNavigationStore.getState().wizardOpts).toEqual({});
  });

  it('mod+[ toggles the left rail', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('[');
    expect(useLayoutStore.getState().leftRailCollapsed).toBe(true);
    pressCtrl('[');
    expect(useLayoutStore.getState().leftRailCollapsed).toBe(false);
  });

  it('mod+] toggles the run right rail in the session workspace', () => {
    useNavigationStore.setState({ view: 'session' });
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl(']');
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(true);
    expect(useLayoutStore.getState().agentRailCollapsed).toBe(false);
    expect(useLayoutStore.getState().leftRailCollapsed).toBe(false);
  });

  it('mod+] toggles the global-assistant rail on landing surfaces', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl(']');
    expect(useLayoutStore.getState().agentRailCollapsed).toBe(true);
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(false);
    pressCtrl(']');
    expect(useLayoutStore.getState().agentRailCollapsed).toBe(false);
  });

  it('mod+] does nothing in the wizard (no right-side rail there)', () => {
    useNavigationStore.setState({ view: 'wizard' });
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl(']');
    expect(useLayoutStore.getState().agentRailCollapsed).toBe(false);
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(false);
  });

  it('mod+] does nothing on landing surfaces when the assistant is disabled', () => {
    useConfigStore.setState({ config: { assistantEnabled: false } as AppConfig });
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl(']');
    expect(useLayoutStore.getState().agentRailCollapsed).toBe(false);
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(false);
  });

  it('mod+r toggles the human-review queue', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('r');
    expect(useNavigationStore.getState().humanReviewOpen).toBe(true);
    pressCtrl('r');
    expect(useNavigationStore.getState().humanReviewOpen).toBe(false);
  });

  it('mod+l toggles the backlog', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('l');
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
    pressCtrl('l');
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('mod+, opens Settings on the general tab', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl(',');
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsTab).toBe('general');
  });

  it('mod+/ opens Settings on the shortcuts tab', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('/');
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(useNavigationStore.getState().settingsTab).toBe('shortcuts');
  });

  it('calls preventDefault on a match (⌘[ / ⌘] are browser history nav)', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    const event = pressCtrl('[');
    expect(event.defaultPrevented).toBe(true);
  });

  it('fires from inside a textarea — these are mod-combos, not bare keys', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    const el = document.createElement('textarea');
    document.body.appendChild(el);
    trackedTextareas.push(el);
    el.focus();
    act(() => {
      fireEvent.keyDown(el, { key: 'l', ctrlKey: true, bubbles: true, cancelable: true });
    });
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — guards', () => {
  it('skips an event whose defaultPrevented is already set', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    const event = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('an unbound key does nothing', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('k');
    expect(useNavigationStore.getState().view).toBe('home');
    expect(useLayoutStore.getState().leftRailCollapsed).toBe(false);
  });

  it('a bare key with no modifier does nothing', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }),
      );
    });
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('stops firing after unmount', () => {
    const { unmount } = renderHook(() => useGlobalKeyboardShortcuts());
    unmount();
    pressCtrl('l');
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mod exclusivity
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — mod exclusivity', () => {
  it('on a non-mac platform Cmd+L does NOT fire a mod+l binding', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'l',
          metaKey: true,
          ctrlKey: false,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('on mac Ctrl+L does NOT fire a mod+l binding', () => {
    setPlatform('mac');
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('l');
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('on mac Cmd+L DOES fire', () => {
    setPlatform('mac');
    renderHook(() => useGlobalKeyboardShortcuts());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'l',
          metaKey: true,
          ctrlKey: false,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
  });

  it('Ctrl AND Cmd held together never match', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'l',
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });

  it('an extra Shift on a shift-less binding does not match', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('l', { shiftKey: true });
    expect(useNavigationStore.getState().backlogOpen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

describe('useGlobalKeyboardShortcuts — user overrides', () => {
  it('honours a remapped binding and drops the default it replaced', () => {
    useKeyboardShortcutsStore.setState({
      overrides: { toggleBacklog: 'mod+shift+b' },
      hydrated: true,
    });
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl('l');
    expect(useNavigationStore.getState().backlogOpen).toBe(false);

    pressCtrl('b', { shiftKey: true });
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
  });

  it('a malformed stored override degrades to the built-in default', () => {
    useKeyboardShortcutsStore.setState({
      overrides: { toggleBacklog: 'MOD+SHIFT' },
      hydrated: true,
    });
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl('l');
    expect(useNavigationStore.getState().backlogOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toggleChat (mod+')
// ---------------------------------------------------------------------------

describe("useGlobalKeyboardShortcuts — mod+' (toggle chat)", () => {
  /** Put the app on the session surface with a quick session selected. */
  function selectQuickSession(sessionId: string): void {
    useNavigationStore.setState({ view: 'session' });
    useCyboflowStore.setState({ activeRunId: null, selectedSessionId: sessionId });
  }

  it('no-ops when no session workspace is active', () => {
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl("'");
    expect(useComposerFocusStore.getState().request).toBeNull();
    expect(useCenterPaneStore.getState().bySession).toEqual({});
  });

  it('no-ops on the session surface with nothing selected', () => {
    useNavigationStore.setState({ view: 'session' });
    renderHook(() => useGlobalKeyboardShortcuts());
    pressCtrl("'");
    expect(useComposerFocusStore.getState().request).toBeNull();
  });

  it('an unseeded pane counts as OPEN (centerPaneStore seeds docks open) — focus only', () => {
    selectQuickSession('session-1');
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useComposerFocusStore.getState().request?.key).toBe('session-1');
    // No dock write: the pane was already (implicitly) open.
    expect(useCenterPaneStore.getState().bySession['session-1']).toBeUndefined();
  });

  it('a CLOSED dock opens and requests composer focus', () => {
    selectQuickSession('session-1');
    useCenterPaneStore.getState().setTerminalOpen('session-1', false);
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(true);
    expect(useComposerFocusStore.getState().request?.key).toBe('session-1');
  });

  it('an OPEN dock whose composer is NOT focused just requests focus', () => {
    selectQuickSession('session-1');
    useCenterPaneStore.getState().setTerminalOpen('session-1', true);
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(true);
    expect(useComposerFocusStore.getState().request?.key).toBe('session-1');
  });

  it('an OPEN dock with NO composer mounted collapses on the SECOND press', () => {
    // The collapse leg keys off "is the composer focused?", which is
    // permanently false where no composer exists (a quick session showing a
    // non-chat panel). Without the stale-request escape hatch every press would
    // just re-post a focus request nobody answers, and ⌘' could never put the
    // dock away again.
    selectQuickSession('session-1');
    useCenterPaneStore.getState().setTerminalOpen('session-1', true);
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useComposerFocusStore.getState().request?.key).toBe('session-1');
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(true);

    // Nothing consumed the request — the second press reads that as "no
    // composer is listening", clears it, and collapses instead.
    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(false);
    expect(useComposerFocusStore.getState().request).toBeNull();
  });

  it('a CONSUMED request does not trip the collapse hatch — focus is re-requested', () => {
    selectQuickSession('session-1');
    useCenterPaneStore.getState().setTerminalOpen('session-1', true);
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    const first = useComposerFocusStore.getState().request?.nonce;
    // A mounted composer answers it (what useComposerFocusRequest does).
    act(() => {
      useComposerFocusStore.getState().consumeFocusRequest('session-1');
    });

    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(true);
    expect(useComposerFocusStore.getState().request?.key).toBe('session-1');
    expect(useComposerFocusStore.getState().request?.nonce).not.toBe(first);
  });

  it('a pending request for ANOTHER composer does not trip the collapse hatch', () => {
    selectQuickSession('session-1');
    useCenterPaneStore.getState().setTerminalOpen('session-1', true);
    useComposerFocusStore.getState().requestFocus('some-other-run');
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(true);
    expect(useComposerFocusStore.getState().request?.key).toBe('session-1');
  });

  it('an OPEN dock whose composer IS focused collapses the dock', () => {
    selectQuickSession('session-1');
    useCenterPaneStore.getState().setTerminalOpen('session-1', true);
    focusedComposer('session-1');
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(false);
    expect(useComposerFocusStore.getState().request).toBeNull();
  });

  it("a DIFFERENT composer holding focus does not count as this session's", () => {
    selectQuickSession('session-1');
    useCenterPaneStore.getState().setTerminalOpen('session-1', true);
    focusedComposer('some-other-run');
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(true);
    expect(useComposerFocusStore.getState().request?.key).toBe('session-1');
  });

  it('for an active RUN the composer key is the RUN id but the dock key is its PARENT SESSION', () => {
    useNavigationStore.setState({ view: 'session' });
    useCyboflowStore.setState({ activeRunId: 'run-7', selectedSessionId: 'session-1' });
    useActiveRunsStore.setState({
      runsByProject: {
        1: [{ id: 'run-7', session_id: 'session-1' }],
      } as unknown as ReturnType<typeof useActiveRunsStore.getState>['runsByProject'],
    });
    // Start collapsed so the open-the-dock branch proves WHICH key it writes.
    useCenterPaneStore.getState().setTerminalOpen('session-1', false);
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    // Dock state lands on the parent session (RunCenterPane's own sessionKey)…
    expect(useCenterPaneStore.getState().bySession['session-1'].terminalOpen).toBe(true);
    // …while the focus request addresses the run's composer (ChatInput's runId).
    expect(useComposerFocusStore.getState().request?.key).toBe('run-7');
  });

  it('a legacy PARENTLESS run keys the dock by the run id', () => {
    useNavigationStore.setState({ view: 'session' });
    useCyboflowStore.setState({ activeRunId: 'run-9', selectedSessionId: null });
    useActiveRunsStore.setState({
      runsByProject: {
        1: [{ id: 'run-9', session_id: null }],
      } as unknown as ReturnType<typeof useActiveRunsStore.getState>['runsByProject'],
    });
    useCenterPaneStore.getState().setTerminalOpen('run-9', false);
    renderHook(() => useGlobalKeyboardShortcuts());

    pressCtrl("'");
    expect(useCenterPaneStore.getState().bySession['run-9'].terminalOpen).toBe(true);
    expect(useComposerFocusStore.getState().request?.key).toBe('run-9');
  });
});
