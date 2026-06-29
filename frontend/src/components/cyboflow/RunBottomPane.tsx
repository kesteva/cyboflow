/**
 * Tab shell wrapping the run view content. Pill-styled tabs (matching the
 * quick-session PanelTabBar) plus a ＋terminal button that spawns ADDITIONAL
 * worktree shells — parity with quick sessions. Tab state is local;
 * cyboflowStore is unchanged.
 *
 * Tabs:
 *   - Chat        — the unified run transcript (default).
 *   - Agent       — the live AGENT PTY (interactive substrate) or the scripted
 *                   demo terminal. Present ONLY when such a terminal exists
 *                   (interactive run, or demo mode); SDK runs have no agent PTY.
 *   - Terminal N  — a PLAIN user shell ($SHELL) in the run's worktree, for
 *                   running commands against the code a flow built (e.g. a dev
 *                   server). The PRIMARY terminal (terminalId === runId) is ALWAYS
 *                   present; ＋terminal spawns additional, closeable terminals,
 *                   each an independent shell in the same worktree. Distinct
 *                   process + lifecycle from the agent terminal: they survive run
 *                   completion (torn down at run close-out).
 *   - Data Stream — the raw event log.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bot, MessageSquare, Plus, Terminal as TerminalIcon, X } from 'lucide-react';
import { RunView } from './RunView';
import { RunChatView } from './RunChatView';
import { DemoTerminalView } from './DemoTerminalView';
import { InteractiveTerminalView } from './InteractiveTerminalView';
import { RunShellTerminalView } from './RunShellTerminalView';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { trpc } from '../../trpc/client';
import { cn } from '../../utils/cn';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TabKind = 'chat' | 'agent' | 'terminal' | 'data-stream';

interface RunTab {
  /** Unique tab id — the kind for fixed tabs, the terminalId for terminal tabs. */
  id: string;
  kind: TabKind;
  label: string;
  /** For kind==='terminal': the per-terminal id (primary === runId). */
  terminalId?: string;
  /** Added terminals can be closed; fixed tabs (incl. the primary terminal) cannot. */
  closeable?: boolean;
}

function tabIcon(kind: TabKind) {
  switch (kind) {
    case 'chat':
      return <MessageSquare className="h-4 w-4" />;
    case 'agent':
      return <Bot className="h-4 w-4" />;
    case 'terminal':
      return <TerminalIcon className="h-4 w-4" />;
    case 'data-stream':
      return <Activity className="h-4 w-4" />;
  }
}

// ---------------------------------------------------------------------------
// RunBottomPane
// ---------------------------------------------------------------------------

export function RunBottomPane() {
  // Default to the unified Chat transcript so a run opens to the same rich
  // experience as a quick session.
  const [activeId, setActiveId] = useState<string>('chat');
  // Terminal ids of ADDED terminals (beyond the always-present primary) for the
  // CURRENTLY-selected run. Mirrors perRunTerminals.current[runId].ids; kept as
  // state so adds/closes re-render.
  const [extraTerminals, setExtraTerminals] = useState<string[]>([]);
  // Per-run added-terminal registry, persisted across run switches so returning
  // to a run restores its added terminals (and thus reaches their still-live
  // backend shells — e.g. a dev server). `seq` is a monotonic per-run counter so
  // a closed+re-added terminal never reuses an id (which could collide with a
  // still-live backend shell). RunBottomPane stays mounted across run switches,
  // so this ref survives them; entries are reaped with the run at close-out.
  const perRunTerminals = useRef<Map<string, { ids: string[]; seq: number }>>(new Map());
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  // Demo mode swaps the Agent tab for a canned, scripted Claude Code terminal so
  // the PTY surface can be illustrated end-to-end.
  const demoModeEnabled = useConfigStore((s) => s.config?.demoMode ?? false);

  // Resolve the run's substrate the same way RunChatView does (scan the
  // active-runs rows for this run id). Only the interactive substrate has a live
  // AGENT PTY; an SDK run's agent executes in-process and has none — so the Agent
  // tab is offered ONLY when an agent terminal actually exists (interactive run,
  // or demo mode). The worktree terminals are independent of this.
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const isInteractive = useMemo(() => {
    if (activeRunId === null) return false;
    for (const rows of Object.values(runsByProject)) {
      const found = rows.find((r) => r.id === activeRunId);
      if (found) return found.substrate === 'interactive';
    }
    return false;
  }, [activeRunId, runsByProject]);
  const agentTerminalAvailable = demoModeEnabled || isInteractive;

  // Terminal ids are run-scoped; on a run switch RESTORE the newly-selected run's
  // added terminals from the registry (not reset to []), so a run's added
  // terminals — and the live shells behind them — survive switching away and back.
  // Always land on Chat for the freshly-shown run.
  useEffect(() => {
    if (activeRunId === null) {
      setExtraTerminals([]);
      setActiveId('chat');
      return;
    }
    setExtraTerminals(perRunTerminals.current.get(activeRunId)?.ids ?? []);
    setActiveId('chat');
  }, [activeRunId]);

  const tabs = useMemo<RunTab[]>(() => {
    const list: RunTab[] = [{ id: 'chat', kind: 'chat', label: 'Chat' }];
    if (agentTerminalAvailable) list.push({ id: 'agent', kind: 'agent', label: 'Agent' });
    if (activeRunId !== null) {
      // Primary worktree terminal (terminalId === runId).
      list.push({ id: activeRunId, kind: 'terminal', label: 'Terminal', terminalId: activeRunId });
      extraTerminals.forEach((tid, i) =>
        list.push({
          id: tid,
          kind: 'terminal',
          label: `Terminal ${i + 2}`,
          terminalId: tid,
          closeable: true,
        }),
      );
    }
    list.push({ id: 'data-stream', kind: 'data-stream', label: 'Data Stream' });
    return list;
  }, [agentTerminalAvailable, activeRunId, extraTerminals]);

  // Resolve the active tab; if the selected id vanished (e.g. the Agent tab went
  // away with the substrate, or a terminal was closed), fall back to Chat.
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const handleAddTerminal = useCallback(() => {
    if (activeRunId === null) return;
    const entry = perRunTerminals.current.get(activeRunId) ?? { ids: [], seq: 1 };
    const tid = `${activeRunId}::t${entry.seq}`;
    const next = { ids: [...entry.ids, tid], seq: entry.seq + 1 };
    perRunTerminals.current.set(activeRunId, next);
    setExtraTerminals(next.ids);
    setActiveId(tid);
  }, [activeRunId]);

  const handleCloseTerminal = useCallback(
    (terminalId: string) => {
      // Kill the backend shell, then drop the tab. Fail-soft: a close-out race or
      // an unwired dep just leaves the tab removal.
      void trpc.cyboflow.runs.shellClose.mutate({ terminalId }).catch(() => undefined);
      if (activeRunId !== null) {
        const entry = perRunTerminals.current.get(activeRunId);
        if (entry) {
          const ids = entry.ids.filter((t) => t !== terminalId);
          perRunTerminals.current.set(activeRunId, { ids, seq: entry.seq });
          setExtraTerminals(ids);
        }
      }
      setActiveId((cur) => (cur === terminalId ? 'chat' : cur));
    },
    [activeRunId],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Pill tab bar — same visual language as the quick-session PanelTabBar. */}
      <div className="border-b border-border-primary bg-surface-secondary dark:border-border-hover">
        <div
          className="flex min-h-[2rem] flex-wrap items-center gap-x-1 px-2"
          role="tablist"
          aria-label="Run Panel Tabs"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-label={tab.label}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                data-testid={`run-bottom-pane-tab-${tab.id}`}
                onClick={() => setActiveId(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveId(tab.id);
                  }
                }}
                className={cn(
                  'group relative inline-flex h-8 cursor-pointer select-none items-center whitespace-nowrap px-3 text-sm',
                  'rounded-t-md border border-b-0 border-border-primary -mb-px dark:border-border-hover',
                  isActive
                    ? 'bg-surface-primary text-text-primary shadow-tactile'
                    : 'bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                )}
              >
                {tabIcon(tab.kind)}
                <span className="ml-2 text-sm">{tab.label}</span>
                {tab.closeable && tab.terminalId && (
                  <button
                    type="button"
                    aria-label={`Close ${tab.label}`}
                    className="ml-1 rounded p-0.5 text-text-muted transition-colors hover:bg-surface-hover hover:text-status-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCloseTerminal(tab.terminalId!);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}

          {/* ＋terminal — spawn an additional worktree shell (parity with quick). */}
          {activeRunId !== null && (
            <div className="ml-auto flex h-8 items-center pr-1">
              <button
                type="button"
                onClick={handleAddTerminal}
                aria-label="Add terminal"
                title="Add terminal"
                data-testid="run-bottom-pane-add-terminal"
                className="inline-flex h-7 items-center gap-1 rounded px-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
              >
                <Plus className="h-4 w-4" />
                <TerminalIcon className="h-4 w-4" />
                <span className="sr-only">Add terminal</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div role="tabpanel" className="flex-1 overflow-auto">
        {activeTab?.kind === 'data-stream' && <RunView />}
        {activeTab?.kind === 'agent' && agentTerminalAvailable && (
          demoModeEnabled ? (
            <div className="h-full" data-testid="run-bottom-pane-terminal-demo">
              <DemoTerminalView />
            </div>
          ) : (
            <div className="h-full" data-testid="run-bottom-pane-terminal-interactive">
              {activeRunId !== null && <InteractiveTerminalView runId={activeRunId} />}
            </div>
          )
        )}
        {activeTab?.kind === 'terminal' && activeRunId !== null && activeTab.terminalId && (
          <div className="h-full" data-testid="run-bottom-pane-terminal-shell">
            {/* key by terminalId so switching terminals mounts a fresh xterm; the
                backend shell survives the unmount and replays its backlog. */}
            <RunShellTerminalView
              key={activeTab.terminalId}
              runId={activeRunId}
              terminalId={activeTab.terminalId}
            />
          </div>
        )}
        {activeTab?.kind === 'chat' && <RunChatView runId={activeRunId} />}
      </div>
    </div>
  );
}
