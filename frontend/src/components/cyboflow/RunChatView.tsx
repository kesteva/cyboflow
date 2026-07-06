/**
 * RunChatView — workflow-run host for the shared <UnifiedChatView>.
 *
 * Resolves the active run row (substrate, worktree, branch, status), feeds the
 * run's fully-correlated conversation via `useUnifiedRunMessages`
 * (`cyboflow.runs.listUnifiedMessages` + debounced live re-fetch on
 * streamEvents), and renders the SHARED <UnifiedChatView> — the exact same chat
 * surface a quick session renders (ClaudePanel). This file owns only the
 * run-specific wiring:
 *   - the interactive-substrate body (the live PTY xterm, InteractiveTerminalView),
 *   - the inline `AskUserQuestionCard` injected at its tool_use position (via
 *     UnifiedChatView's `renderToolCallExtra` hook) + its artifact "open in pane"
 *     affordances,
 *   - the bottom region: the per-run `PendingApprovalsForRun` strip, the
 *     permission-change confirmation toast, and the run composer (`ChatInput`).
 *
 * Modes:
 *  - runId non-null: full conversation view (this file's main branch)
 *  - runId null + selectedSessionId non-null: quick-session placeholder
 *  - runId null + selectedSessionId null: "No active run" placeholder
 */
import { useMemo, useState, useEffect, useCallback, type ReactElement, type ReactNode } from 'react';
import { ChatInput } from './ChatInput';
import { SessionActionToast } from './SessionActionToast';
import { MODEL_OPTIONS } from './unified/ModelPill';
import { API } from '../../utils/api';
import { InteractiveTerminalView } from './InteractiveTerminalView';
import { UnifiedChatView } from './unified/UnifiedChatView';
import { deriveRunContextUsageParts, formatContextUsage } from './unified/runContextUsage';
import { trpc } from '../../trpc/client';
import { useUnifiedRunMessages } from './unified/useUnifiedRunMessages';
import { usePendingSendStore } from '../../stores/pendingSendStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useQuestionStore } from '../../stores/questionStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { useArtifactsList } from '../../hooks/useArtifactsList';
import { AskUserQuestionCard } from '../AskUserQuestion/AskUserQuestionCard';
import { PendingApprovalsForRun } from '../ReviewQueue/PendingApprovalsForRun';
import type { Artifact } from '../../../../shared/types/artifacts';

/**
 * Pick the run's PRIMARY artifact for the question-card "open in pane" affordances:
 * prefer an `idea-spec` artifact when present, else the most-recently-created one
 * (by `createdAt`). Returns null when the run has no artifacts.
 */
function selectPrimaryArtifact(artifacts: Artifact[]): Artifact | null {
  if (artifacts.length === 0) return null;
  const ideaSpec = artifacts.find((a) => a.atype === 'idea-spec');
  if (ideaSpec) return ideaSpec;
  return artifacts.reduce((latest, a) => (a.createdAt > latest.createdAt ? a : latest), artifacts[0]);
}

export function RunChatView({ runId }: { runId: string | null }): ReactElement {
  const selectedSessionId = useCyboflowStore((s) => s.selectedSessionId);
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const questionQueue = useQuestionStore((s) => s.queue);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const openArtifactTab = useCenterPaneStore((s) => s.openArtifactTab);

  // -------------------------------------------------------------------------
  // Substrate gate (IDEA-013 / IDEA-030). Resolve the run row the same way
  // ChatInput does — scan `runsByProject` for the row whose id === runId.
  // -------------------------------------------------------------------------
  const run = useMemo(() => {
    if (runId === null) return null;
    for (const rows of Object.values(runsByProject)) {
      const found = rows.find((r) => r.id === runId);
      if (found) return found;
    }
    return null;
  }, [runId, runsByProject]);
  const isInteractive = run?.substrate === 'interactive';
  const running = run?.status === 'running' || run?.status === 'starting';
  const worktreePath = run?.worktree_path ?? null;
  const branchName = run?.branch_name ?? null;
  const folderLabel = worktreePath !== null ? worktreePath.split('/').filter(Boolean).pop() ?? null : null;

  // Live context-% for the meta strip. Flow runs have no server-side
  // contextUsage (the backend extractor skips cyboflow run ids), so we derive it
  // on the renderer from the run's structured stream. Interactive runs put NO
  // events on the structured stream (Q3 store isolation), so they stay "--%".
  //
  // BASELINE BACKFILL: the live `streamEvents` buffer starts empty on every run
  // activation, and the meter's denominator only arrives on step-boundary
  // `result` events — so after any view switch the meter sat at "--" until the
  // next step completed. Recover both facts from the persisted raw_events via
  // `runs.contextUsage` once per runId; live values (fresher) win per-side.
  const [baselineUsage, setBaselineUsage] = useState<{
    used: number | null;
    contextWindow: number | null;
  }>({ used: null, contextWindow: null });
  useEffect(() => {
    setBaselineUsage({ used: null, contextWindow: null });
    if (runId === null || isInteractive) return;
    let aborted = false;
    void trpc.cyboflow.runs.contextUsage
      .query({ runId })
      .then((r) => {
        if (!aborted) setBaselineUsage({ used: r.usedTokens, contextWindow: r.contextWindow });
      })
      .catch(() => {
        // Fail-soft: the meter simply stays live-only.
      });
    return () => {
      aborted = true;
    };
  }, [runId, isInteractive]);
  const contextUsage = useMemo(() => {
    if (isInteractive) return null;
    const live = deriveRunContextUsageParts(streamEvents);
    return formatContextUsage(
      live.used ?? baselineUsage.used,
      live.contextWindow ?? baselineUsage.contextWindow,
    );
  }, [isInteractive, streamEvents, baselineUsage]);

  // Messages — run-scoped source. Interactive runs keep the live xterm as the
  // transcript, so the structured fetch is disabled there.
  const { messages, loadError } = useUnifiedRunMessages(runId, !isInteractive);

  // Pending-send (optimistic echo) — keyed by runId (the flow host key + railId).
  // Reconcile against the run transcript so a 'sending'/'queued' row is dropped
  // once the real user turn appears in the stream.
  const pendingSends = usePendingSendStore((s) => (runId != null ? s.byHost[runId] : undefined));
  const reconcilePending = usePendingSendStore((s) => s.reconcile);
  const requestReopenPending = usePendingSendStore((s) => s.requestReopen);
  useEffect(() => {
    if (runId != null) reconcilePending(runId, messages);
  }, [messages, runId, reconcilePending]);

  // -------------------------------------------------------------------------
  // Run artifacts → question-card "open in pane" affordances (#8 / #9).
  // -------------------------------------------------------------------------
  const sessionKey = selectedSessionId ?? activeRunId;
  const projectId = run?.project_id ?? null;
  const { artifacts } = useArtifactsList(activeRunId, projectId);
  const primaryArtifact = useMemo(() => selectPrimaryArtifact(artifacts), [artifacts]);

  const onOpenArtifact = useMemo(() => {
    if (primaryArtifact === null || sessionKey === null) return undefined;
    const artifact = primaryArtifact;
    return () => {
      openArtifactTab(sessionKey, {
        atype: artifact.atype,
        label: artifact.label,
        artifactId: artifact.id,
        committed: artifact.committed,
        focus: true,
      });
    };
  }, [primaryArtifact, sessionKey, openArtifactTab]);

  // Confirmation toast for a run permission-mode change (ISSUE #2). ChatInput
  // (the composer adapter) raises onPermissionApplied; this host renders it. The
  // SAME slot also surfaces a mid-call model fallback (below).
  const [permissionToast, setPermissionToast] = useState<string | null>(null);

  // Mid-call model fallback (Fable 5 pulled → Opus): the run's turn discovered its
  // pinned model was unavailable and retried on the fallback. The read-only model
  // pill already swaps reactively (availability store); this raises a one-off toast
  // so the swap isn't silent — mirroring the quick-session composer. Filtered to
  // THIS run (flow runs: notice.panelId === notice.sessionId === runId).
  useEffect(() => {
    if (runId === null) return;
    const unsubscribe = API.models.onModelFallback((notice) => {
      if (notice.panelId !== runId && notice.sessionId !== runId) return;
      const fallbackLabel =
        MODEL_OPTIONS.find((o) => o.id === notice.fallbackAlias)?.label ?? notice.fallbackAlias;
      setPermissionToast(
        `${notice.unavailableLabel} is unavailable — switched to ${fallbackLabel} for this run.`,
      );
    });
    return unsubscribe;
  }, [runId]);

  // -------------------------------------------------------------------------
  // Inline AskUserQuestionCard injection at the AskUserQuestion tool_use position.
  // -------------------------------------------------------------------------
  const renderToolCallExtra = useCallback(
    (toolCallId: string): ReactNode => {
      const question = questionQueue.find((q) => q.toolUseId === toolCallId);
      if (question != null) {
        return (
          <AskUserQuestionCard
            item={question}
            onOpenArtifact={onOpenArtifact}
            openArtifactLabel={primaryArtifact?.label}
          />
        );
      }
      return null;
    },
    [questionQueue, onOpenArtifact, primaryArtifact],
  );

  // -------------------------------------------------------------------------
  // Placeholder branches (no active run)
  // -------------------------------------------------------------------------
  if (runId === null && selectedSessionId !== null) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        Quick session chat (history rendered by panel surface)
      </div>
    );
  }

  if (runId === null) {
    return <div className="p-4 text-sm text-text-secondary">No active run</div>;
  }

  // -------------------------------------------------------------------------
  // Full conversation view — the shared chat surface.
  // -------------------------------------------------------------------------
  return (
    <UnifiedChatView
      name={isInteractive ? 'Terminal' : 'Claude'}
      transport={isInteractive ? 'interactive' : 'sdk'}
      mode="flow"
      running={running}
      runStatus={run?.status ?? null}
      messages={messages}
      loadError={loadError}
      folderLabel={folderLabel}
      folderTitle={worktreePath}
      branchName={branchName}
      contextUsage={contextUsage}
      railId={runId}
      renderToolCallExtra={renderToolCallExtra}
      pendingSends={isInteractive ? undefined : pendingSends}
      onReopenPending={(entry) => {
        // A server-buffered 'queued' entry must also be dropped from the run's
        // queue so the reopened text is not ALSO delivered at the rest boundary
        // (behavior 3 — no double delivery). Matched by text on the server.
        if (entry.status === 'queued') {
          void trpc.cyboflow.runs.dequeueInput.mutate({ runId, text: entry.text });
        }
        requestReopenPending(runId, entry.id);
      }}
      interactiveBody={isInteractive ? <InteractiveTerminalView runId={runId} /> : undefined}
      bottomSlot={
        <>
          <PendingApprovalsForRun runId={runId} />

          {/* Permission-change confirmation — copy supplied by ChatInput's pill
              (SDK runs apply the change on the next message). */}
          {permissionToast !== null && (
            <div className="pointer-events-none relative">
              <div className="pointer-events-auto absolute bottom-2 left-1/2 z-20 -translate-x-1/2">
                <SessionActionToast
                  message={permissionToast}
                  isVisible={permissionToast !== null}
                  onDismiss={() => setPermissionToast(null)}
                />
              </div>
            </div>
          )}

          <ChatInput runId={runId} onPermissionApplied={setPermissionToast} />
        </>
      }
    />
  );
}
