/**
 * QuickSessionCenterPane — the tabbed center surface for a worktree-backed quick
 * session with NO active run. Mirrors RunCenterPane's shell so a quick session
 * gets the SAME tabbed center pane: a pinned home tab hosting the resting
 * QuickSessionCanvas, plus file/diff tabs opened from the right-rail Diff list
 * AND artifact tabs (deliverables the session's chat produced), over the
 * collapsible TerminalDock (chat / panel surface) below.
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
 * Artifacts: a quick session has no workflow run, but `cyboflow_report_artifact`
 * still attaches rows to the session's persistent '__quick__' chat-sentinel run
 * (`session.chatRunId`, migration 040) — the same run id chat turns gate on. This
 * component queries the SESSION's artifacts (across ALL its runs — the chat
 * sentinel AND any past flow runs it hosted) via useSessionArtifactsList and
 * syncs tabs for them via useArtifactTabsSync (the SAME sync used by
 * RunCenterPane), so a deliverable minted mid-chat surfaces itself here exactly
 * as it would in a flow run's center pane — and a past flow run's deliverables
 * stay reachable here after that run ends (both hosts share the same
 * centerPaneStore session key, so the list backing the tab store must be
 * session-scoped or the prune effect closes tabs minted under the session's
 * other runs).
 *
 * The tab strip is shown only once a second tab exists (progressive disclosure): a
 * resting quick session with just its home tab looks exactly as before. The
 * TerminalDock (the chat) stays mounted across tab switches — only the top plane
 * swaps between the canvas and a file/artifact tab.
 */
import { useEffect, type ReactNode, type ReactElement } from 'react';
import { QuickSessionCanvas } from './QuickSessionCanvas';
import { CenterPaneTabStrip } from './CenterPaneTabStrip';
import { FileTabRenderer } from './FileTabRenderer';
import { ArtifactTabRenderer } from './ArtifactTabRenderer';
import { TerminalDock } from './TerminalDock';
import { useCenterPaneStore, useCenterPaneSession } from '../../stores/centerPaneStore';
import { FLOW_TAB_ID } from '../../../../shared/types/centerPane';
import { useSessionArtifactsList } from '../../hooks/useArtifactsList';
import { useArtifactTabsSync } from '../../hooks/useArtifactTabsSync';
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

  // The session's artifacts across ALL its runs — the persistent '__quick__'
  // chat-sentinel run (session.chatRunId, migration 040) plus any past flow
  // runs the session hosted. Session-scoped (not run-scoped) because the tab
  // store below is keyed by sessionKey: a run-scoped list would read a past
  // flow run's tabs as "vanished" the moment this component (re)mounts.
  const { artifacts, loaded } = useSessionArtifactsList(sessionKey, projectId);
  useArtifactTabsSync(sessionKey, artifacts, loaded);

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
    if (activeTab && activeTab.kind === 'artifact') {
      // Resolve the backing artifact row from the live list. Prefer the tab's
      // stored artifactId (set when auto-opened); fall back to atype (chip-opened
      // tabs carry only atype until the row arrives). The artifacts table is one
      // row per (run, atype) so atype is a stable secondary key.
      const artifact =
        artifacts.find((a) => a.id === activeTab.artifactId) ??
        artifacts.find((a) => a.atype === activeTab.atype);
      if (artifact) {
        // The artifact's OWN runId (not the chat sentinel) — the list is now
        // session-scoped, so a tab's backing row may belong to a past flow run
        // rather than the '__quick__' sentinel.
        return <ArtifactTabRenderer artifact={artifact} projectId={projectId} runId={artifact.runId} />;
      }
      // Row not loaded yet (chip-opened tab before the list resolves, or the
      // artifact hasn't been minted) — small loading state.
      return (
        <div className="flex h-full items-center justify-center text-sm text-text-secondary">
          Loading {activeTab.label}…
        </div>
      );
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
