/** useIsRemoteSession — the renderer's one test for "this session lives on a remote environment" (M2). */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsRemoteSession, isRemoteSession } from '../useIsRemoteSession';
import { useSessionStore } from '../../stores/sessionStore';

afterEach(() => {
  act(() => {
    useSessionStore.setState({ sessions: [], activeMainRepoSession: null });
  });
});

describe('useIsRemoteSession', () => {
  it('is true only for a session whose hostId names a remote environment', () => {
    act(() => {
      useSessionStore.setState({
        sessions: [{ id: 'r', hostId: 'host-a' } as never, { id: 'l', hostId: null } as never, { id: 'x', hostId: 'local' } as never],
      });
    });
    expect(renderHook(() => useIsRemoteSession('r')).result.current).toBe(true);
    expect(renderHook(() => useIsRemoteSession('l')).result.current).toBe(false);
    expect(renderHook(() => useIsRemoteSession('x')).result.current).toBe(false);
    expect(renderHook(() => useIsRemoteSession('unknown')).result.current).toBe(false);
    expect(renderHook(() => useIsRemoteSession(null)).result.current).toBe(false);
  });

  it('isRemoteSession', () => {
    expect(isRemoteSession({ hostId: 'h' })).toBe(true);
    expect(isRemoteSession({ hostId: 'local' })).toBe(false);
    expect(isRemoteSession(undefined)).toBe(false);
  });
});
