/**
 * panelStore tests — the renderer panel registry (immer-backed zustand).
 *
 * Covers the mutation seams the ingestion core relies on: addPanel dedup +
 * active-set, removePanel active-clear semantics, and updatePanelState
 * in-place-by-id no-op safety.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePanelStore } from '../panelStore';
import type { ToolPanel } from '../../../../shared/types/panels';

function makePanel(id: string, sessionId: string): ToolPanel {
  return {
    id,
    sessionId,
    type: 'terminal',
    title: id,
    state: { isActive: false },
    metadata: { createdAt: '', lastActiveAt: '', position: 0 },
  };
}

describe('panelStore', () => {
  beforeEach(() => {
    usePanelStore.setState({ panels: {}, activePanels: {} });
  });

  describe('addPanel', () => {
    it('adds a panel and sets it active for the session', () => {
      usePanelStore.getState().addPanel(makePanel('p1', 's1'));
      const state = usePanelStore.getState();
      expect(state.panels['s1'].map((p) => p.id)).toEqual(['p1']);
      expect(state.activePanels['s1']).toBe('p1');
    });

    it('dedups on add — re-adding the same id does not duplicate or re-activate', () => {
      const { addPanel, setActivePanel } = usePanelStore.getState();
      addPanel(makePanel('p1', 's1'));
      addPanel(makePanel('p2', 's1'));
      // p2 became active on add; move active back to p1 then re-add p2.
      setActivePanel('s1', 'p1');
      addPanel(makePanel('p2', 's1'));
      const state = usePanelStore.getState();
      expect(state.panels['s1'].map((p) => p.id)).toEqual(['p1', 'p2']);
      // The dedup short-circuits BEFORE the active-set, so active stays p1.
      expect(state.activePanels['s1']).toBe('p1');
    });
  });

  describe('removePanel', () => {
    it('clears activePanels only when the removed panel was active', () => {
      const { addPanel, setActivePanel, removePanel } = usePanelStore.getState();
      addPanel(makePanel('p1', 's1'));
      addPanel(makePanel('p2', 's1')); // p2 now active
      setActivePanel('s1', 'p1'); // make p1 active
      // Remove the NON-active p2 → active stays p1.
      removePanel('s1', 'p2');
      expect(usePanelStore.getState().activePanels['s1']).toBe('p1');
      // Now remove the active p1 → active is cleared.
      removePanel('s1', 'p1');
      expect('s1' in usePanelStore.getState().activePanels).toBe(false);
      expect(usePanelStore.getState().panels['s1']).toEqual([]);
    });
  });

  describe('updatePanelState', () => {
    it('replaces the panel in place by id', () => {
      const { addPanel, updatePanelState } = usePanelStore.getState();
      addPanel(makePanel('p1', 's1'));
      const updated = { ...makePanel('p1', 's1'), title: 'renamed' };
      updatePanelState(updated);
      expect(usePanelStore.getState().panels['s1'][0].title).toBe('renamed');
    });

    it('is a no-op when that session has no panels loaded (background session)', () => {
      // No panels for s-bg — must not throw or create an entry.
      usePanelStore.getState().updatePanelState(makePanel('p1', 's-bg'));
      expect(usePanelStore.getState().panels['s-bg']).toBeUndefined();
    });

    it('is a no-op when the panel id is not present in the session', () => {
      const { addPanel, updatePanelState } = usePanelStore.getState();
      addPanel(makePanel('p1', 's1'));
      updatePanelState({ ...makePanel('p-other', 's1'), title: 'ghost' });
      const panels = usePanelStore.getState().panels['s1'];
      expect(panels).toHaveLength(1);
      expect(panels[0].id).toBe('p1');
    });
  });
});
