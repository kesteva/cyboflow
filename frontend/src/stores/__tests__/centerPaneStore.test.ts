/**
 * centerPaneStore tests — per-session, in-memory tabbed center-pane state.
 *
 * Verifies: a session seeds the pinned Flow tab; focus clears the new-dot;
 * file/artifact tabs open + dedupe + focus; closing focuses the previous tab and
 * the pinned Flow tab never closes; dock + right-rail toggles; clearSession.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useCenterPaneStore } from '../centerPaneStore';
import { FLOW_TAB_ID } from '../../../../shared/types/centerPane';

const KEY = 'session-1';

function reset(): void {
  useCenterPaneStore.setState({ bySession: {} });
}

function get() {
  return useCenterPaneStore.getState();
}

describe('centerPaneStore', () => {
  beforeEach(reset);

  it('seeds a session with the pinned Flow tab + dock open + steps rail', () => {
    get().ensureSession(KEY);
    const s = get().bySession[KEY];
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ id: FLOW_TAB_ID, kind: 'flow', pinned: true });
    expect(s.activeTabId).toBe(FLOW_TAB_ID);
    expect(s.terminalOpen).toBe(true);
    expect(s.rightTab).toBe('steps');
  });

  it('ensureSession is idempotent (no replacement of an existing entry)', () => {
    get().ensureSession(KEY);
    const first = get().bySession[KEY];
    get().ensureSession(KEY);
    expect(get().bySession[KEY]).toBe(first);
  });

  it('opens an artifact tab, focuses it, and dedupes on a second open', () => {
    get().ensureSession(KEY);
    get().openArtifactTab(KEY, { atype: 'idea-spec', label: 'IDEA-018', isNew: true });
    let s = get().bySession[KEY];
    expect(s.tabs).toHaveLength(2);
    expect(s.activeTabId).toBe('art:idea-spec');
    expect(s.tabs[1]).toMatchObject({ kind: 'artifact', atype: 'idea-spec', isNew: true });

    // Re-open the same atype: no duplicate, focuses, clears the new-dot.
    get().openArtifactTab(KEY, { atype: 'idea-spec', label: 'IDEA-018' });
    s = get().bySession[KEY];
    expect(s.tabs.filter((t) => t.atype === 'idea-spec')).toHaveLength(1);
    expect(s.tabs[1].isNew).toBe(false);
  });

  it('focusTab clears the focused tab new-dot', () => {
    get().ensureSession(KEY);
    get().openArtifactTab(KEY, { atype: 'screenshots', label: 'Shots', isNew: true });
    get().focusTab(KEY, FLOW_TAB_ID); // focus elsewhere first
    expect(get().bySession[KEY].tabs.find((t) => t.atype === 'screenshots')?.isNew).toBe(true);
    get().focusTab(KEY, 'art:screenshots');
    expect(get().bySession[KEY].tabs.find((t) => t.atype === 'screenshots')?.isNew).toBe(false);
    expect(get().bySession[KEY].activeTabId).toBe('art:screenshots');
  });

  it('opens a file tab and dedupes by path', () => {
    get().ensureSession(KEY);
    get().openFileTab(KEY, { filePath: 'src/a.ts', worktreePath: '/wt', status: 'M' });
    get().openFileTab(KEY, { filePath: 'src/a.ts', worktreePath: '/wt', status: 'M' });
    const s = get().bySession[KEY];
    expect(s.tabs.filter((t) => t.kind === 'file')).toHaveLength(1);
    expect(s.tabs.find((t) => t.kind === 'file')).toMatchObject({ label: 'a.ts', status: 'M' });
    expect(s.activeTabId).toBe('file:src/a.ts');
  });

  it('closing the active tab focuses the previous tab', () => {
    get().ensureSession(KEY);
    get().openFileTab(KEY, { filePath: 'a.ts', worktreePath: '/wt' });
    get().openArtifactTab(KEY, { atype: 'idea-spec', label: 'IDEA' });
    expect(get().bySession[KEY].activeTabId).toBe('art:idea-spec');
    get().closeTab(KEY, 'art:idea-spec');
    const s = get().bySession[KEY];
    expect(s.tabs.some((t) => t.id === 'art:idea-spec')).toBe(false);
    expect(s.activeTabId).toBe('file:a.ts');
  });

  it('never closes the pinned Flow tab', () => {
    get().ensureSession(KEY);
    get().closeTab(KEY, FLOW_TAB_ID);
    expect(get().bySession[KEY].tabs.some((t) => t.id === FLOW_TAB_ID)).toBe(true);
  });

  it('toggles the terminal dock and sets the right-rail tab', () => {
    get().ensureSession(KEY);
    get().toggleTerminal(KEY);
    expect(get().bySession[KEY].terminalOpen).toBe(false);
    get().setTerminalOpen(KEY, true);
    expect(get().bySession[KEY].terminalOpen).toBe(true);
    get().setRightTab(KEY, 'arts');
    expect(get().bySession[KEY].rightTab).toBe('arts');
  });

  it('clearSession drops the session entry', () => {
    get().ensureSession(KEY);
    get().clearSession(KEY);
    expect(get().bySession[KEY]).toBeUndefined();
  });
});
