/**
 * landingStore patches a project in place on the `project:updated` IPC event,
 * so a ProjectSettings edit (e.g. a new open_ide_command, which gates the Diff
 * tab's Open in IDE button) is visible without waiting for a lifecycle resync.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Project } from '../../types/project';

const { subscription, PROJECT } = vi.hoisted(() => {
  const project: Project = {
    id: 4,
    name: 'P4',
    path: '/p4',
    active: true,
    created_at: '2026-10-02 00:00:00',
    updated_at: '2026-10-02 00:00:00',
    open_ide_command: null,
  };
  return { subscription: () => ({ unsubscribe: () => {} }), PROJECT: project };
});

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        list: { query: vi.fn(async () => []) },
        onReviewItemChanged: { subscribe: vi.fn(subscription) },
      },
      events: {
        onRunStatusChanged: { subscribe: vi.fn(subscription) },
        onApprovalCreated: { subscribe: vi.fn(subscription) },
        onApprovalDecided: { subscribe: vi.fn(subscription) },
      },
    },
  },
}));

vi.mock('../activeRunsStore', () => ({
  isTerminalRunStatus: () => false,
  useActiveRunsStore: { getState: () => ({ init: vi.fn(), refresh: vi.fn() }) },
}));

vi.mock('../../utils/api', () => ({
  API: { projects: { getAll: vi.fn(async () => ({ success: true, data: [PROJECT] })) } },
}));

import { useLandingStore } from '../landingStore';

type ProjectUpdatedCallback = (project: Project) => void;

describe('landingStore — project:updated patch', () => {
  let teardown: (() => void) | null = null;

  afterEach(() => {
    teardown?.();
    teardown = null;
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('merges the updated project row into the cached list and unsubscribes on teardown', async () => {
    const captured: { cb: ProjectUpdatedCallback | null } = { cb: null };
    const unsubscribe = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        events: {
          onProjectUpdated: (cb: ProjectUpdatedCallback) => {
            captured.cb = cb;
            return unsubscribe;
          },
        },
      },
    });

    teardown = useLandingStore.getState().init();
    await vi.waitFor(() => expect(useLandingStore.getState().projects).toHaveLength(1));
    expect(captured.cb).not.toBeNull();

    captured.cb?.({ ...PROJECT, open_ide_command: 'code .' });
    expect(useLandingStore.getState().projects[0].open_ide_command).toBe('code .');

    teardown();
    teardown = null;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
