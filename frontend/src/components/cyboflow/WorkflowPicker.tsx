/**
 * WorkflowPicker — dropdown of the cyboflow workflows (Planner + Sprint) +
 * Start Run button.
 *
 * Accepts a `projectId` prop; on mount it calls `trpc.cyboflow.workflows.list`
 * and populates a `<select>`.  Clicking "Start Run" calls
 * `trpc.cyboflow.runs.start.mutate` and stores the returned runId in
 * `cyboflowStore`.
 *
 * Also provides a "Quick Session" button that creates a quick session via
 * `sessions:create-quick` IPC, bootstraps both Claude and Terminal panels via
 * `panelApi.createPanel`, and navigates via `setActiveQuickSession`.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { trpc } from '../../trpc/client';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { useQuickSession } from '../../hooks/useQuickSession';
import { WorkflowEditorModal } from './WorkflowEditorModal';
import { IdeaPickerModal } from './IdeaPickerModal';
import type { WorkflowRow, PermissionMode } from '../../../../shared/types/workflows';
import { type CliSubstrate, DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';

/**
 * The per-run agent-permission options, mirroring the global control in
 * Settings.tsx. Selecting one threads it into runs.start as the highest-precedence
 * `requestedMode` rung of the permission ladder (per-run > frontmatter > global).
 */
const PERMISSION_MODE_OPTIONS: ReadonlyArray<{ id: PermissionMode; label: string; hint: string }> = [
  { id: 'default', label: 'Ask before edits', hint: 'Prompt for each edit' },
  { id: 'acceptEdits', label: 'Allow edits', hint: 'Auto-allow file edits' },
  { id: 'auto', label: 'Auto', hint: 'Native Claude classifier' },
  { id: 'dontAsk', label: "Don't ask", hint: 'No prompts · skip permissions' },
];

interface WorkflowPickerProps {
  projectId: number;
  onWorkflowStarted?: (runId: string) => void;
}

/**
 * The v1 limits of the interactive PTY substrate, surfaced when the user picks
 * 'interactive' (IDEA-013 / TASK-812). These are the UNCONDITIONAL caveats —
 * the interactive PreToolUse approval gating DID ship (Probe A passed via
 * TASK-810's shell-hook + async-deferred socket handler), so the
 * "approval routing unavailable" caveat is intentionally NOT listed here.
 */
const INTERACTIVE_CAVEATS: readonly string[] = [
  'AskUserQuestion is native-TUI-only — multiple-choice questions surface in the terminal, not the structured panel.',
  'Subagent gating is limited — only the main session reports step transitions; subagent tool calls are gated but not separately surfaced.',
  'Streaming is coarser — output arrives at turn-level granularity, not token-level deltas.',
];

export function WorkflowPicker({ projectId, onWorkflowStarted }: WorkflowPickerProps) {
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The per-run CLI substrate choice. Defaults to DEFAULT_SUBSTRATE ('sdk') —
   * the global ConfigManager.defaultSubstrate floor — and is threaded into
   * runs.start.mutate. The mutate input type is AppRouter-inferred (no local
   * mirror of the substrate field), and CliSubstrate is imported from the S1
   * shared type, never re-declared here.
   */
  const [substrate, setSubstrate] = useState<CliSubstrate>(DEFAULT_SUBSTRATE);

  /**
   * The per-run agent permission choice, seeded from the global default
   * (Settings → Agent Permission Mode) so an untouched picker forwards the same
   * value the run would otherwise inherit — never silently clobbering the global
   * default down to a hardcoded 'default'. The default is read REACTIVELY from
   * the config store (not once at mount) so a config fetch that resolves AFTER
   * this picker mounts still re-seeds the selection; `permissionTouchedRef`
   * guards against clobbering an explicit user pick once they interact.
   * Threaded into runs.start.mutate as `permissionMode` (the AppRouter-inferred
   * input; PermissionMode is imported from the shared type, never re-declared).
   */
  const globalDefaultPermissionMode =
    useConfigStore((state) => state.config?.defaultAgentPermissionMode) ?? 'default';
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(globalDefaultPermissionMode);
  const permissionTouchedRef = useRef(false);
  useEffect(() => {
    if (!permissionTouchedRef.current) setPermissionMode(globalDefaultPermissionMode);
  }, [globalDefaultPermissionMode]);

  // Blueprint editor — opened in 'edit' (selected flow) or 'create' (new flow) mode.
  const [editorMode, setEditorMode] = useState<'edit' | 'create' | null>(null);

  // Planner pre-launch idea-selection gate (migration 017). When the selected
  // workflow is the Planner, "Start Run" opens this picker first; the chosen
  // idea id is threaded into runs.start.mutate({ ideaId }).
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);

  /**
   * Synchronous in-flight latch for "Start Run". The `isStarting` STATE guard is
   * insufficient against a double-submit: two clicks fired in the same tick both
   * read isStarting=false and both fire runs.start (each spinning up a worktree),
   * and the `disabled` attribute only applies after the next render. A ref flips
   * synchronously so the second click is rejected. (Prevents the duplicate-run bug.)
   */
  const startInFlightRef = useRef(false);

  const {
    start: startQuickSession,
    isStarting: isQuickStarting,
    error: quickError,
  } = useQuickSession({
    projectId,
    onSuccess: (sessionId) => {
      onWorkflowStarted?.(sessionId);
    },
  });

  /**
   * Fetch the project's workflow list. Refactored out of the mount effect into a
   * callable so it can be re-invoked after the editor saves a new/edited flow.
   * `preferId`, when set, is selected after the refresh (used to focus a flow the
   * user just created/edited); otherwise selection is preserved or defaults to
   * the first row.
   */
  const loadWorkflows = useCallback(
    (preferId?: string): Promise<void> => {
      setIsLoading(true);
      setError(null);
      return trpc.cyboflow.workflows.list
        .query({ projectId })
        .then((rows) => {
          setWorkflows(rows);
          setSelectedId((prev) => {
            if (preferId && rows.some((r) => r.id === preferId)) return preferId;
            if (prev !== null && rows.some((r) => r.id === prev)) return prev;
            return rows.length > 0 ? rows[0].id : null;
          });
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load workflows');
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [projectId],
  );

  // Load workflows on mount (or when projectId changes).
  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  const handleEditorSaved = useCallback(
    (savedId: string) => {
      setEditorMode(null);
      void loadWorkflows(savedId);
    },
    [loadWorkflows],
  );

  /**
   * Fire the actual runs.start mutation. `ideaId` is the Planner's pre-launch
   * seed idea (migration 017) — undefined for Sprint (and any free Planner
   * launch). The synchronous in-flight latch flips HERE (at the real mutate),
   * NOT on modal open, so opening the picker is freely cancellable.
   */
  const launchRun = useCallback(
    async (workflowId: string, ideaId?: string): Promise<void> => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      setError(null);
      setIsStarting(true);
      try {
        // Ensure the run executes INSIDE a session (active one if selected, else
        // a freshly created session). The id is threaded into runs.start so the
        // run runs in that session's worktree, and used to nest the run under
        // the session in the store (setActiveRun's parentSessionId).
        const sessionId = await ensureSessionForLaunch(projectId);
        const result = await trpc.cyboflow.runs.start.mutate(
          ideaId === undefined
            ? { workflowId, projectId, substrate, sessionId, permissionMode }
            : { workflowId, projectId, substrate, sessionId, permissionMode, ideaId },
        );
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        onWorkflowStarted?.(result.runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start run');
      } finally {
        setIsStarting(false);
        startInFlightRef.current = false;
      }
    },
    [projectId, substrate, permissionMode, onWorkflowStarted],
  );

  const handleStartRun = async () => {
    if (selectedId === null || startInFlightRef.current) return;
    // Planner is gated behind the idea picker. Workflow `name` is the lowercase
    // CyboflowWorkflowName seeded by WorkflowRegistry — compare to 'planner'.
    const selected = workflows.find((wf) => wf.id === selectedId);
    if (selected?.name === 'planner') {
      setError(null);
      setIdeaPickerOpen(true);
      return;
    }
    await launchRun(selectedId);
  };

  const handleIdeaPicked = useCallback(
    (ideaId: string): void => {
      setIdeaPickerOpen(false);
      if (selectedId === null) return;
      void launchRun(selectedId, ideaId);
    },
    [selectedId, launchRun],
  );

  const combinedError = error ?? quickError;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Workflow</h2>

      {isLoading && (
        <p className="text-xs text-text-secondary">Loading workflows…</p>
      )}

      {!isLoading && workflows.length > 0 && (
        <select
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
          aria-label="Select workflow"
        >
          {workflows.map((wf) => (
            <option key={wf.id} value={wf.id}>
              {wf.name}
            </option>
          ))}
        </select>
      )}

      {/* Substrate selector — per-run CLI substrate choice (IDEA-013 / TASK-812). */}
      <div className="flex flex-col gap-1">
        <label
          htmlFor="workflow-picker-substrate"
          className="text-xs font-medium text-text-secondary"
        >
          CLI substrate
        </label>
        <select
          id="workflow-picker-substrate"
          value={substrate}
          onChange={(e) => setSubstrate(e.target.value === 'interactive' ? 'interactive' : 'sdk')}
          className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
          aria-label="Select CLI substrate"
        >
          <option value="sdk">SDK (default)</option>
          <option value="interactive">Interactive (PTY)</option>
        </select>
      </div>

      {/* Per-run agent permission selector — overrides the global default for
          this run only (highest-precedence `requestedMode` rung). Mirrors the
          global control in Settings.tsx. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-text-secondary">Agent permission</span>
        {PERMISSION_MODE_OPTIONS.map(({ id, label, hint }) => (
          <button
            key={id}
            type="button"
            onClick={() => {
              permissionTouchedRef.current = true;
              setPermissionMode(id);
            }}
            aria-pressed={permissionMode === id}
            aria-label={`Permission mode: ${label}`}
            className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
              permissionMode === id
                ? 'border-interactive bg-interactive-surface'
                : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
            }`}
          >
            <span className="text-text-primary font-medium text-sm">{label}</span>
            <span className="text-xs text-text-tertiary">{hint}</span>
          </button>
        ))}
      </div>

      {/* Interactive-substrate v1 caveats — surfaced prominently ONLY when the
          user selects 'interactive'. Approval routing DID ship for interactive
          (Probe A passed), so that caveat is intentionally not listed. */}
      {substrate === 'interactive' && (
        <div
          data-testid="workflow-picker-substrate-caveats"
          role="note"
          className="rounded-input border border-status-warning bg-bg-secondary px-3 py-2 text-xs text-text-secondary"
        >
          <p className="mb-1 font-semibold text-text-primary">Interactive substrate — v1 limits</p>
          <ul className="list-disc space-y-1 pl-4">
            {INTERACTIVE_CAVEATS.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </div>
      )}

      {combinedError && (
        <p className="text-xs text-status-error" role="alert">
          {combinedError}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleStartRun}
          disabled={selectedId === null || isLoading || isStarting || isQuickStarting}
          className="flex-1 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start Run
        </button>
        <button
          onClick={() => setEditorMode('edit')}
          disabled={selectedId === null || isLoading}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workflow-picker-edit"
        >
          Edit
        </button>
        <button
          onClick={() => setEditorMode('create')}
          disabled={isLoading}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workflow-picker-new-flow"
        >
          New flow
        </button>
      </div>

      {editorMode !== null && (
        <WorkflowEditorModal
          isOpen
          mode={editorMode}
          workflowId={selectedId ?? ''}
          projectId={projectId}
          onClose={() => setEditorMode(null)}
          onSaved={handleEditorSaved}
        />
      )}

      {ideaPickerOpen && (
        <IdeaPickerModal
          isOpen
          projectId={projectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
        />
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-border-primary pt-3">
        <p className="text-xs text-text-secondary">Or start without a workflow:</p>
        <button
          onClick={() => void startQuickSession()}
          disabled={isQuickStarting || isStarting}
          className="rounded-button border border-interactive bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="quick-session-button"
        >
          Quick Session
        </button>
      </div>
    </div>
  );
}
