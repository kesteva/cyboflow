/**
 * startAuthoring — the kickoff that ties customViewsStore/agentThreadStore/
 * layoutStore together for one call (docs/proposals/CUSTOM-VIEWS.md §7.1).
 * Exercised against fakes of the three stores' relevant slices — no real
 * zustand store, no trpc — since the function itself is a plain synchronous
 * orchestration with no I/O of its own.
 */
import { describe, it, expect, vi } from 'vitest';
import { startAuthoring } from '../../authoring/startAuthoring';
import type {
  StartAuthoringAgentThreadStore,
  StartAuthoringCustomViewsStore,
  StartAuthoringLayoutStore,
} from '../../authoring/startAuthoring';

function fakeCustomViews(sessionId: string): StartAuthoringCustomViewsStore & { openAuthoring: ReturnType<typeof vi.fn> } {
  return { openAuthoring: vi.fn(() => sessionId) };
}

function fakeAgentThread(): StartAuthoringAgentThreadStore & {
  setComposerDraft: ReturnType<typeof vi.fn>;
  setPendingContextHint: ReturnType<typeof vi.fn>;
} {
  return { setComposerDraft: vi.fn(), setPendingContextHint: vi.fn() };
}

function fakeLayout(collapsed: boolean): StartAuthoringLayoutStore & { toggleAgentRail: ReturnType<typeof vi.fn> } {
  return { agentRailCollapsed: collapsed, toggleAgentRail: vi.fn() };
}

describe('startAuthoring', () => {
  it('mode "create": opens the slot, expands a collapsed rail, and pre-fills the composer + pending contextHint', () => {
    const customViews = fakeCustomViews('sess-1');
    const agentThread = fakeAgentThread();
    const layout = fakeLayout(true);

    startAuthoring(customViews, agentThread, layout, {
      mode: 'create',
      surface: 'review-queue',
      at: 2,
      viewName: 'Ship week',
      projectId: 7,
    });

    expect(customViews.openAuthoring).toHaveBeenCalledWith({ surface: 'review-queue', mode: 'create', at: 2 });
    expect(layout.toggleAgentRail).toHaveBeenCalledTimes(1);

    expect(agentThread.setComposerDraft).toHaveBeenCalledTimes(1);
    const draft = agentThread.setComposerDraft.mock.calls[0][0] as string;
    expect(draft).toContain('Review Queue');
    expect(draft).toContain('What it should show:');
    expect(draft).toContain('What it should let me do:');

    expect(agentThread.setPendingContextHint).toHaveBeenCalledTimes(1);
    const hint = agentThread.setPendingContextHint.mock.calls[0][0] as string;
    expect(hint).toContain('[custom-widget-session]');
    expect(hint).toContain('sessionId=sess-1');
    expect(hint).toContain('surface=review-queue');
    expect(hint).toContain('viewName="Ship week"');
    expect(hint).toContain('projectId=7');
    expect(hint).toContain('mode=create');
    expect(hint).not.toContain('widgetId=');
  });

  it('mode "edit": passes instanceId/widgetId through and includes widgetId in the contextHint', () => {
    const customViews = fakeCustomViews('sess-2');
    const agentThread = fakeAgentThread();
    const layout = fakeLayout(false);

    startAuthoring(customViews, agentThread, layout, {
      mode: 'edit',
      surface: 'project-overview',
      instanceId: 'i-1',
      widgetId: 'w-9',
      viewName: 'Default',
      projectId: null,
    });

    expect(customViews.openAuthoring).toHaveBeenCalledWith({
      surface: 'project-overview',
      mode: 'edit',
      instanceId: 'i-1',
      widgetId: 'w-9',
    });
    // Rail already expanded — never toggled.
    expect(layout.toggleAgentRail).not.toHaveBeenCalled();

    const draft = agentThread.setComposerDraft.mock.calls[0][0] as string;
    expect(draft).toContain('Project Overview');
    expect(draft).toContain('Change this custom widget');

    const hint = agentThread.setPendingContextHint.mock.calls[0][0] as string;
    expect(hint).toContain('sessionId=sess-2');
    expect(hint).toContain('projectId=null');
    expect(hint).toContain('mode=edit widgetId=w-9');
  });
});
