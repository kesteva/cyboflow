import { describe, it, expect, beforeEach } from 'vitest';
import { useDesignModeStore } from '../designModeStore';

describe('designModeStore', () => {
  beforeEach(() => {
    useDesignModeStore.setState({ activeDesignSessionId: null });
  });

  it('enterDesignMode sets the active session id', () => {
    useDesignModeStore.getState().enterDesignMode('sess-1');
    expect(useDesignModeStore.getState().activeDesignSessionId).toBe('sess-1');
  });

  it('enterDesignMode is idempotent (same id keeps the same state object)', () => {
    const { enterDesignMode } = useDesignModeStore.getState();
    enterDesignMode('sess-1');
    const before = useDesignModeStore.getState();
    enterDesignMode('sess-1');
    const after = useDesignModeStore.getState();
    expect(after.activeDesignSessionId).toBe('sess-1');
    expect(after).toBe(before); // no-op set returns the same state reference
  });

  it('enterDesignMode with a different id switches the active session', () => {
    const { enterDesignMode } = useDesignModeStore.getState();
    enterDesignMode('sess-1');
    enterDesignMode('sess-2');
    expect(useDesignModeStore.getState().activeDesignSessionId).toBe('sess-2');
  });

  it('exitDesignMode clears the active session id', () => {
    const store = useDesignModeStore.getState();
    store.enterDesignMode('sess-1');
    store.exitDesignMode();
    expect(useDesignModeStore.getState().activeDesignSessionId).toBeNull();
  });

  it('exitDesignMode is a no-op when already cleared', () => {
    const before = useDesignModeStore.getState();
    before.exitDesignMode();
    expect(useDesignModeStore.getState()).toBe(before);
  });
});
