/**
 * openWebLink — the single user-initiated open path (chat links + popups).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

const openMutate = vi.fn();
vi.mock('../../trpc/client', () => ({
  trpc: { cyboflow: { webViewer: { open: { mutate: (...a: unknown[]) => openMutate(...a) } } } },
}));

import { openUserWebTab, typedUrl, viewableHref } from '../openWebLink';
import { useCenterPaneStore } from '../../stores/centerPaneStore';

const KEY = 's1';
const webTabs = () =>
  (useCenterPaneStore.getState().bySession[KEY]?.tabs ?? []).filter((t) => t.kind === 'web');
const openExternal = vi.fn();

beforeEach(() => {
  openMutate.mockReset();
  openExternal.mockReset();
  useCenterPaneStore.setState({ bySession: {} });
  (window as unknown as { electronAPI: { openExternal: typeof openExternal } }).electronAPI = {
    openExternal,
  };
});

describe('viewableHref', () => {
  it('accepts absolute http(s) only and never resolves a relative href', () => {
    expect(viewableHref('https://example.com/a')).toBe('https://example.com/a');
    expect(viewableHref('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(viewableHref('/settings')).toBeNull();
    expect(viewableHref('mailto:a@b.c')).toBeNull();
    expect(viewableHref('javascript:alert(1)')).toBeNull();
    expect(viewableHref('file:///etc/passwd')).toBeNull();
    expect(viewableHref(undefined)).toBeNull();
  });
});

describe('typedUrl', () => {
  it('fills in the scheme a user leaves off: https for a host, http for a local dev server', () => {
    expect(typedUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(typedUrl('  docs.anthropic.com  ')).toBe('https://docs.anthropic.com/');
    expect(typedUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(typedUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(typedUrl('http://example.com')).toBe('http://example.com/');
  });

  it('refuses a search, a bare word, and any non-http(s) scheme', () => {
    expect(typedUrl('how to center a div')).toBeNull();
    expect(typedUrl('intranet')).toBeNull();
    expect(typedUrl('')).toBeNull();
    expect(typedUrl('file:///etc/passwd')).toBeNull();
    expect(typedUrl('javascript:alert(1)')).toBeNull();
    expect(typedUrl('mailto:a@b.c')).toBeNull();
  });
});

describe('openUserWebTab', () => {
  it('opens a focused user tab and asks main for that exact id', async () => {
    openMutate.mockResolvedValue({ ok: true, snapshot: {} });
    openUserWebTab(KEY, 'https://example.com/');
    const [tab] = webTabs();
    expect(useCenterPaneStore.getState().bySession[KEY].activeTabId).toBe(tab.id);
    expect(openMutate).toHaveBeenCalledWith({
      sessionId: KEY,
      tabId: tab.id,
      url: 'https://example.com/',
      openedBy: 'user',
    });
  });

  it('with the kill switch off, drops the tab and falls back to the OS browser', async () => {
    openMutate.mockResolvedValue({ ok: false, error: 'viewer_disabled' });
    openUserWebTab(KEY, 'https://example.com/');
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.com/'));
    expect(webTabs()).toHaveLength(0);
  });
});
