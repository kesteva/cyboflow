/**
 * QuickSessionCenterPane — the tabbed center surface for a worktree-backed quick
 * session with NO active run. Mirrors RunCenterPane's shell so a quick session
 * gets the SAME tabbed center pane: a pinned home tab hosting the resting
 * QuickSessionCanvas, plus file/diff tabs opened from the right-rail Diff list,
 * over the collapsible TerminalDock (chat / panel surface) below.
 *
 * Why this exists: the right-rail Diff click already calls
 * `centerPaneStore.openFileTab(sessionId, …)` even with no run, and a `file:<path>`
 * tab IS added to the store — but the tab strip + FileTabRenderer used to live
 * ONLY inside RunCenterPane (mounted only when a run is active). With no run,
 * CyboflowRoot rendered a bare QuickSessionCanvas with no tab strip, so the opened
 * tab went nowhere ("clicking a diff file opens nothing"). This component gives the
 * no-run branch that same tabbed shell, keyed by the SAME session id the Diff click
 * targets, so files/diffs open as secondary tabs without a running workflow.
 *
 * The tab strip is shown only once a file tab exists (progressive disclosure): a
 * resting quick session with just its home tab looks exactly as before. The
 * TerminalDock (the chat) stays mounted across tab switches — only the top plane
 * swaps between the canvas and a file tab.
 */
import { useEffect, type ReactNode, type ReactElement } from 'react';
import { QuickSessionCanvas } from './QuickSessionCanvas';
import { CenterPaneTabStrip } from './CenterPaneTabStrip';
import { FileTabRenderer } from './FileTabRenderer';
import { TerminalDock } from './TerminalDock';
import { useCenterPaneStore, useCenterPaneSession } from '../../stores/centerPaneStore';
import { FLOW_TAB_ID } from '../../../../shared/types/centerPane';
import type { Session } from '../../types/session';

interface QuickSessionCenterPaneProps {
  session: Session;
  projectId: number;
  projectName: string;
  onBrowseAll: () => void;
  onAddWorkflowToNewSession: () => void;
  /** The chat / panel surface rendered inside the collapsible terminal dock. */
  dockContent: ReactNode;
}

export function QuickSessionCenterPane({
  session,
  projectId,
  projectName,
  onBrowseAll,
  onAddWorkflowToNewSession,
  dockContent,
}: QuickSessionCenterPaneProps): ReactElement {
  // The SAME key the right-rail Diff click targets (RunRightRail openDiffFile →
  // openFileTab(selectedSessionId, …)) and the quick dock's collapse state used.
  const sessionKey = String(session.id);

  const ensureSession = useCenterPaneStore((s) => s.ensureSession);
  const focusTab = useCenterPaneStore((s) => s.focusTab);
  const closeTab = useCenterPaneStore((s) => s.closeTab);
  const toggleTerminal = useCenterPaneStore((s) => s.toggleTerminal);
  const pane = useCenterPaneSession(sessionKey);

  useEffect(() => {
    ensureSession(sessionKey);
  }, [ensureSession, sessionKey]);

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];

  // A quick session has no workflow, so relabel the shared pinned home (Flow) tab
  // to the session's name — it hosts the resting canvas, not a "Flow" graph.
  const homeLabel = session.name || 'Session';
  const stripTabs = pane.tabs.map((t) => (t.id === FLOW_TAB_ID ? { ...t, label: homeLabel } : t));

  // Progressive disclosure: no strip until a second (file) tab exists, so a
  // resting quick session is visually unchanged from before.
  const showStrip = pane.tabs.length > 1;

  const renderActiveTab = (): ReactElement => {
    if (activeTab && activeTab.kind === 'file' && activeTab.filePath) {
      // The diff/content source is the pane's session key — sessionId alone is
      // sufficient (no run / base-sha needed); see FileTabRenderer.
      return <FileTabRenderer sessionId={sessionKey} filePath={activeTab.filePath} status={activeTab.status} />;
    }
    // Home (Flow) tab, or any unknown kind → the resting session canvas.
    return (
      <QuickSessionCanvas
        session={session}
        projectId={projectId}
        projectName={projectName}
        onBrowseAll={onBrowseAll}
        onAddWorkflowToNewSession={onAddWorkflowToNewSession}
      />
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="quick-session-center-pane">
      {showStrip && (
        <CenterPaneTabStrip
          tabs={stripTabs}
          activeTabId={pane.activeTabId}
          onTabClick={(id) => focusTab(sessionKey, id)}
          onTabClose={(id) => closeTab(sessionKey, id)}
        />
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{renderActiveTab()}</div>
      <TerminalDock
        open={pane.terminalOpen}
        onToggle={() => toggleTerminal(sessionKey)}
        storageKey="cyboflow.quickSessionDock.height"
        defaultOpenHeight={420}
      >
        {dockContent}
      </TerminalDock>
    </div>
  );
}
