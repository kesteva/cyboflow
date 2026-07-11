/**
 * QuickSessionCanvas — the resting-view top plane for a session with no active
 * workflow run.
 *
 * A "quick session" is a session started WITHOUT a structured workflow (free-form
 * Claude Code). This is ALSO the view a session falls back to after a
 * workflow run ends (cancel / complete / fail) — the session's home base, from
 * which the operator can add another workflow. It mirrors the WorkflowCanvas slot
 * (the top ~46% of the centre column) so the layout never collapses, while the
 * chat / terminal panel surface stays in the bottom pane (rendered by CyboflowRoot).
 *
 * Direction "Concept C" (design handoff): a single live "session node" wired to
 * real session metrics, joined by a dashed edge to an "add a workflow" node — the
 * first-class path to promote the session into a structured run. Workflow buttons
 * read the REAL catalogue (cyboflow.workflows.list → planner / sprint / ship /
 * any custom flows), never a hardcoded list; clicking one launches it onto THIS
 * session (Planner AND Ship via the idea-picker gate, Sprint via the task-batch
 * picker gate). "Browse all" opens the full WorkflowPicker.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { trpc } from '../../trpc/client';
import {
  resolveWorkflowDefinition,
  type WorkflowRow,
} from '../../../../shared/types/workflows';
import { DEFAULT_WORKFLOW_NAME } from './wizard/workflowMeta';
import { useSessionMetrics, formatTokenCount } from '../../hooks/useSessionMetrics';
import { computeSessionCostUsd, formatCostUsd } from '../../utils/modelPricing';
import { DEFAULT_QUICK_MODEL } from './ModelSelector';
import { useLaunchWorkflow } from '../../hooks/useLaunchWorkflow';
import { IdeaPickerModal } from './IdeaPickerModal';
import { TaskBatchPickerModal } from './TaskBatchPickerModal';
import { DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import { ONBOARDING_ANCHOR_ATTR, ONBOARDING_ANCHORS } from '../../utils/onboarding';
import { useOnboardingStore } from '../../stores/onboardingStore';
import {
  useDynamicWorkflowStore,
  useDynamicWorkflowsForSession,
} from '../../stores/dynamicWorkflowStore';
import { DynamicWorkflowPanel } from './DynamicWorkflowPanel';
import { ConfirmDialog } from '../ConfirmDialog';
import type { Session } from '../../types/session';

interface QuickSessionCanvasProps {
  session: Session;
  projectId: number;
  /** Project (repo) name for the node sub-line, e.g. "tester-mctest". */
  projectName?: string;
  /** Open the full workflow chooser (CyboflowRoot's WorkflowPicker modal). */
  onBrowseAll: () => void;
  /**
   * Invoked instead of launching when THIS session is interactive (PTY): running
   * a second workflow inside a live-REPL session is descoped, so every
   * add-a-workflow affordance routes here to confirm + configure a workflow in a
   * SEPARATE new session (CyboflowRoot owns the confirm dialog + force-new picker).
   */
  onAddWorkflowToNewSession?: () => void;
}

// ---------------------------------------------------------------------------
// Stat cell — value over a wide-tracked micro-label.
// ---------------------------------------------------------------------------

function StatCell({
  value,
  label,
  testId,
  valueColor,
}: {
  value: React.ReactNode;
  label: string;
  testId: string;
  valueColor?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        data-testid={testId}
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: valueColor ?? 'var(--color-text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 8.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-text-tertiary)',
          fontWeight: 700,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow command button — phase dot + slash command + chevron, with the
// system "picker row" hover (hard drop shadow, chevron → rust).
// ---------------------------------------------------------------------------

function WorkflowCmdButton({
  label,
  dotColor,
  disabled,
  onClick,
  testId,
  onboardingAnchor,
  startHere = false,
}: {
  label: string;
  dotColor: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
  /** Onboarding coachmark anchor id (tour step 5 targets ONLY the /ship chip). */
  onboardingAnchor?: string;
  /** Tour step-5 treatment: rust inset bar + "Start here" tag (design packet step 5). */
  startHere?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      {...(onboardingAnchor !== undefined ? { [ONBOARDING_ANCHOR_ATTR]: onboardingAnchor } : {})}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        fontSize: 11,
        color: 'var(--color-text-primary)',
        border: startHere
          ? '1.4px solid var(--color-interactive-primary)'
          : `1px solid ${hovered && !disabled ? 'var(--color-text-primary)' : 'var(--color-border-primary)'}`,
        background: 'var(--color-surface-primary)',
        padding: '8px 11px',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        boxShadow: startHere
          ? 'inset 3px 0 0 var(--color-interactive-primary)'
          : hovered && !disabled
            ? '0 2px 0 var(--color-text-primary)'
            : 'none',
        transition: 'box-shadow .12s, border-color .12s',
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }}
      />
      <span style={{ fontWeight: 700 }}>{label}</span>
      {startHere && (
        <span
          style={{
            fontSize: 8.5,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--color-interactive-primary)',
            border: '1px solid var(--color-interactive-primary)',
            padding: '1px 5px',
            flexShrink: 0,
          }}
        >
          Start here
        </span>
      )}
      <span
        style={{
          marginLeft: 'auto',
          color: hovered && !disabled ? 'var(--color-phase-execute)' : 'var(--color-text-tertiary)',
        }}
      >
        ▸
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// QuickSessionCanvas
// ---------------------------------------------------------------------------

export function QuickSessionCanvas({
  session,
  projectId,
  projectName,
  onBrowseAll,
  onAddWorkflowToNewSession,
}: QuickSessionCanvasProps) {
  const metrics = useSessionMetrics(session);
  // Interactive (PTY) sessions can't host a second workflow inside their live
  // REPL (descoped) — every add-a-workflow click routes to the confirm + config
  // flow that launches in a SEPARATE session instead of the fast-lane launch.
  const isInteractive = session.substrate === 'interactive';
  // In-place (or main-repo) sessions work directly in the project checkout — a
  // workflow run can never execute there, so it must land in a fresh
  // worktree-backed session. Chip clicks confirm in-canvas then continue the
  // normal chip flow (idea/batch gates included) with forceNew; "Browse all"
  // defers to CyboflowRoot's confirm + force-new picker (same lane as PTY).
  const isRawCheckout = session.inPlace === true || session.isMainRepo === true;
  const { launch, isLaunching, error: launchError } = useLaunchWorkflow(projectId, {
    forceNew: isRawCheckout,
  });
  // Tour step-8 accent on the /ship chip (design packet: rust inset bar +
  // "Start here" tag while the coachmark points at it).
  const onboardingShipStep = useOnboardingStore((s) => s.status === 'active' && s.step === 8);

  // Detected Claude Code dynamic workflows (the Workflow tool / `ultracode`)
  // launched by THIS session's agent — rendered prominently above the picker.
  // init() is the store's idempotent singleton bootstrap (the landing home
  // calls it too); deliberately NOT torn down on unmount — the subscription is
  // shared across consumers (same treatment landingStore gives
  // useActiveRunsStore.init()).
  useEffect(() => {
    useDynamicWorkflowStore.getState().init();
  }, []);
  const dynamicWorkflows = useDynamicWorkflowsForSession(session.id);

  // Dismiss a terminal dynamic-workflow card. The tracker drops it and emits
  // `removed`; the store deletes the entry (the subscription, not this call,
  // is the source of truth). Fail-soft — a failed mutation just leaves the card.
  const dismissDynamicWorkflow = useCallback((wfRunId: string) => {
    void trpc.cyboflow.dynamicWorkflows.dismiss
      .mutate({ wfRunId })
      .catch((err: unknown) =>
        console.warn('[QuickSessionCanvas] dismiss dynamic workflow failed:', err),
      );
  }, []);

  // Canvas takeover: while any dynamic workflow is RUNNING the workflow view
  // replaces the resting-state chrome (session node + add-a-workflow picker).
  // Running workflows render as EXPANDED panels (per-agent rows); terminal
  // ones collapse to their compact cards below. When nothing is running the
  // canvas reverts to the resting layout unchanged.
  const runningDynamic = useMemo(
    () => dynamicWorkflows.filter((wf) => wf.status === 'running'),
    [dynamicWorkflows],
  );
  const terminalDynamic = useMemo(
    () => dynamicWorkflows.filter((wf) => wf.status !== 'running'),
    [dynamicWorkflows],
  );
  const dynamicTakeover = runningDynamic.length > 0;

  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  // Planner pre-launch idea gate (migration 017): a planner click opens the
  // picker first, then launches with the chosen ideaId.
  const [plannerIdForGate, setPlannerIdForGate] = useState<string | null>(null);
  // Sprint pre-launch task gate (parallel sprint): a sprint click opens the
  // multi-task picker first, then launches ONE seeded run with the taskIds.
  const [sprintIdForGate, setSprintIdForGate] = useState<string | null>(null);
  // In-place add-a-workflow confirm: a chip click on an in-place session first
  // confirms the run will open in a NEW worktree-backed session, holding the
  // chosen row until the user confirms (then the normal chip flow continues).
  const [pendingRawCheckoutRow, setPendingRawCheckoutRow] = useState<WorkflowRow | null>(null);
  const [addHovered, setAddHovered] = useState(false);
  const [browseHovered, setBrowseHovered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Clear any prior error before refetching so a stale message never lingers
    // once the list resolves (mirrors useLaunchWorkflow's setError(null)).
    setListError(null);
    trpc.cyboflow.workflows.list
      .query({ projectId })
      .then((rows) => {
        if (!cancelled) setWorkflows(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : 'Failed to load workflows');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Default workflow (sprint) first, then the rest in listed order.
  const ordered = useMemo(
    () =>
      [...workflows].sort(
        (a, b) =>
          Number(b.name === DEFAULT_WORKFLOW_NAME) - Number(a.name === DEFAULT_WORKFLOW_NAME),
      ),
    [workflows],
  );

  const phaseDotColor = useCallback((row: WorkflowRow): string => {
    const def = resolveWorkflowDefinition(row.name, row.spec_json);
    return def?.phases[0]?.color ?? 'var(--color-text-tertiary)';
  }, []);

  // Route a chosen workflow chip to its launch path: Planner/Ship are idea-gated,
  // Sprint is task-batch-gated (open the matching picker); other workflows launch
  // directly. Shared by the direct chip click and the in-place confirm's continue
  // path — for an in-place session the launch hook is forceNew, so either way the
  // run lands in a fresh worktree-backed session.
  const routeWorkflowChip = useCallback(
    (row: WorkflowRow) => {
      // Ship (planner ⊕ sprint in one run) is IDEA-seeded like the planner, so it
      // shares the idea gate (the task-subset choice happens later, at the in-run
      // approve-plan gate).
      if (row.name === 'planner' || row.name === 'ship') {
        setPlannerIdForGate(row.id);
        return;
      }
      if (row.name === 'sprint') {
        setSprintIdForGate(row.id);
        return;
      }
      void launch(row.id);
    },
    [launch],
  );

  const handleWorkflowClick = useCallback(
    (row: WorkflowRow) => {
      if (isLaunching) return;
      // Interactive (PTY) session: a second workflow is descoped here — route to
      // the confirm + config flow that launches in a SEPARATE session, rather
      // than the in-session fast-lane launch (which would collide with the live
      // REPL or silently run SDK in a stray session).
      if (isInteractive) {
        onAddWorkflowToNewSession?.();
        return;
      }
      // In-place session: a workflow can't run on the raw checkout — confirm the
      // run will open in a NEW isolated session first, then continue the chip flow.
      if (isRawCheckout) {
        setPendingRawCheckoutRow(row);
        return;
      }
      routeWorkflowChip(row);
    },
    [isLaunching, isInteractive, isRawCheckout, onAddWorkflowToNewSession, routeWorkflowChip],
  );

  const handleIdeaPicked = useCallback(
    (ideaId: string) => {
      const id = plannerIdForGate;
      setPlannerIdForGate(null);
      if (id !== null) void launch(id, { ideaId });
    },
    [plannerIdForGate, launch],
  );

  const handleBatchPicked = useCallback(
    (taskIds: string[]) => {
      const id = sprintIdForGate;
      setSprintIdForGate(null);
      if (id !== null && taskIds.length > 0) void launch(id, { taskIds });
    },
    [sprintIdForGate, launch],
  );

  const repo = projectName && projectName.length > 0 ? projectName : session.name;
  const branch = metrics.branch ?? '';
  const model = metrics.model ?? '—';
  const { plus, minus } = metrics.diff;
  const diffIsEmpty = plus === 0 && minus === 0;
  const { input, output, cacheWrite, cacheRead } = metrics.tokenBreakdown;
  const tokenCategories = [
    { key: 'input', label: 'Input', value: input },
    { key: 'output', label: 'Output', value: output },
    { key: 'cache-write', label: 'Cache write', value: cacheWrite },
    { key: 'cache-read', label: 'Cache read', value: cacheRead },
  ];
  // Estimated USD cost of the whole-session token usage at the model's list
  // price. A quick session always runs a Claude model, so an unset / 'auto'
  // model (no explicit pick) is priced at the quick-session default (Opus)
  // rather than rendering an unhelpful '—'.
  const pricingModel =
    metrics.model && metrics.model !== 'auto' ? metrics.model : DEFAULT_QUICK_MODEL;
  const costLabel = formatCostUsd(computeSessionCostUsd(metrics.tokenBreakdown, pricingModel));
  const error = launchError ?? listError;

  return (
    <div
      className="flex flex-col h-full bg-bg-primary"
      data-testid="quick-session-canvas"
    >
      {/* ── Pane header — mirrors the WorkflowCanvas meta row ─────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10,
          letterSpacing: '0.02em',
          color: 'var(--color-text-secondary)',
          padding: '7px 12px 6px',
          background: 'var(--color-bg-secondary)',
          borderBottom: '1px solid var(--color-border-primary)',
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
        data-testid="quick-session-canvas-header"
      >
        <b
          style={{
            color: 'var(--color-text-primary)',
            fontWeight: 700,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            fontSize: 10,
          }}
        >
          Quick session
        </b>
        {/* Calm static status label (design: "· session.live") — the branch is
            shown in the node sub-line, so it is not repeated here. */}
        <span style={{ color: 'var(--color-text-tertiary)' }} data-testid="quick-session-header-status">
          · session.live
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            fontWeight: 700,
            color: 'var(--color-phase-execute)',
            border: '1px solid var(--color-phase-execute)',
            padding: '1px 7px',
          }}
          data-testid="quick-session-interactive-pill"
        >
          <span
            className="animate-pulse motion-reduce:animate-none"
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--color-phase-execute)',
              display: 'inline-block',
            }}
          />
          live
        </span>
      </div>

      {dynamicTakeover ? (
        /* ── Takeover — the running workflow view REPLACES the resting chrome ── */
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '10px 12px',
            background: 'var(--color-bg-secondary)',
          }}
          data-testid="dynwf-takeover"
        >
          {runningDynamic.map((wf) => (
            <DynamicWorkflowPanel key={wf.wfRunId} state={wf} expanded />
          ))}
          {terminalDynamic.map((wf) => (
            <DynamicWorkflowPanel
              key={wf.wfRunId}
              state={wf}
              onDismiss={() => dismissDynamicWorkflow(wf.wfRunId)}
            />
          ))}
        </div>
      ) : (
        <>
        {/* ── Detected dynamic workflows — most recent first, ABOVE the picker ─── */}
        {dynamicWorkflows.length > 0 && (
          <div
            style={{
              flexShrink: 0,
              maxHeight: '55%',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px 12px',
              borderBottom: '1px solid var(--color-border-primary)',
              background: 'var(--color-bg-secondary)',
            }}
            data-testid="quick-session-dynamic-workflows"
          >
            {dynamicWorkflows.map((wf) => (
              <DynamicWorkflowPanel
                key={wf.wfRunId}
                state={wf}
                onDismiss={
                  wf.status === 'running'
                    ? undefined
                    : () => dismissDynamicWorkflow(wf.wfRunId)
                }
              />
            ))}
          </div>
        )}

        {/* ── Canvas body — 24px graph-paper grid, single node → edge → add ────── */}
        <div
          style={{
            position: 'relative',
            flex: 1,
            overflow: 'auto',
            display: 'flex',
            alignItems: 'center',
            padding: '26px 30px',
            background:
              'linear-gradient(var(--color-grid-line, rgba(106,94,68,0.06)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
              'linear-gradient(90deg, var(--color-grid-line, rgba(106,94,68,0.06)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
              'var(--color-bg-primary)',
          }}
          data-testid="quick-session-canvas-body"
        >
          {/* 1 · Session node */}
          <div
            style={{
              width: 300,
              flexShrink: 0,
              background: 'var(--color-surface-primary)',
              border: '1.4px solid var(--color-text-primary)',
              outline: '2px solid var(--color-phase-execute)',
              outlineOffset: 2,
            }}
            data-testid="quick-session-node"
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                background: 'var(--color-phase-execute)',
              }}
            >
              <span
                className="animate-pulse motion-reduce:animate-none"
                style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff', display: 'inline-block' }}
              />
              <span
                style={{
                  fontSize: 9,
                  letterSpacing: '0.16em',
                  textTransform: 'uppercase',
                  color: '#fff',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                Session
              </span>
              <span
                data-testid="quick-session-node-model"
                style={{
                  marginLeft: 'auto',
                  fontSize: 9,
                  color: 'rgba(255,255,255,0.85)',
                  whiteSpace: 'nowrap',
                }}
              >
                {model}
              </span>
            </div>
            <div style={{ padding: '13px 14px' }}>
              <div
                style={{ fontSize: 10.5, color: 'var(--color-text-tertiary)' }}
                data-testid="quick-session-node-sub"
              >
                {repo}
                {branch ? ` · ⌥ ${branch}` : ''}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '7px 12px',
                  marginTop: 13,
                }}
              >
                <StatCell value={metrics.elapsed} label="elapsed" testId="quick-session-stat-elapsed" />
                <StatCell value={metrics.tokens} label="tokens" testId="quick-session-stat-tokens" />
                <StatCell value={metrics.filesSeen} label="files seen" testId="quick-session-stat-files" />
                <StatCell
                  testId="quick-session-stat-diff"
                  label="diff"
                  value={
                    <span>
                      <span style={{ color: diffIsEmpty ? 'var(--color-text-tertiary)' : 'var(--color-status-success)' }}>
                        +{plus}
                      </span>{' '}
                      <span style={{ color: diffIsEmpty ? 'var(--color-text-tertiary)' : 'var(--color-phase-execute)' }}>
                        −{minus}
                      </span>
                    </span>
                  }
                />
              </div>

              {/* Token usage — granular breakdown across the WHOLE session
                  (quick chat + any workflow runs hosted by it). The headline
                  TOKENS stat above is input+output ONLY (excludes cache) by
                  design, so on a cache-dominated turn (e.g. a resumed session
                  re-feeding its context as cache_read) these Cache rows jump
                  while the headline moves only slightly — not a bug. */}
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: '1px solid var(--color-border-primary)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
                data-testid="quick-session-token-breakdown"
              >
                <span
                  style={{
                    fontSize: 8.5,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'var(--color-text-tertiary)',
                    fontWeight: 700,
                    marginBottom: 2,
                  }}
                >
                  Token usage
                </span>
                {tokenCategories.map((c) => (
                  <div
                    key={c.key}
                    data-testid={`quick-session-token-${c.key}`}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                      fontSize: 10.5,
                    }}
                  >
                    <span style={{ color: 'var(--color-text-tertiary)' }}>{c.label}</span>
                    <span
                      style={{
                        color: 'var(--color-text-primary)',
                        fontWeight: 700,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatTokenCount(c.value)}
                    </span>
                  </div>
                ))}
                {/* Estimated cost — whole-session token usage at the model's
                    list price; '—' when the model is unknown. */}
                <div
                  data-testid="quick-session-cost"
                  style={{
                    marginTop: 4,
                    paddingTop: 6,
                    borderTop: '1px dashed var(--color-border-primary)',
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    fontSize: 10.5,
                  }}
                >
                  <span style={{ color: 'var(--color-text-tertiary)' }}>Cost</span>
                  <span
                    style={{
                      color: 'var(--color-text-primary)',
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {costLabel}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 2 · Dashed edge with a ＋ chip */}
          <div
            aria-hidden
            style={{
              flex: '0 0 64px',
              height: 1.4,
              position: 'relative',
              background:
                'repeating-linear-gradient(90deg, var(--color-text-disabled) 0 5px, transparent 5px 10px)',
            }}
          >
            <span
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                background: 'var(--color-bg-primary)',
                color: 'var(--color-text-tertiary)',
                fontSize: 12,
                padding: '0 3px',
              }}
            >
              ＋
            </span>
          </div>

          {/* 3 · Add-workflow node */}
          <div
            onMouseEnter={() => setAddHovered(true)}
            onMouseLeave={() => setAddHovered(false)}
            style={{
              width: 230,
              flexShrink: 0,
              border: `1.4px dashed ${addHovered ? 'var(--color-phase-execute)' : 'var(--color-text-disabled)'}`,
              // Faint translucent "ghost" fill that stays visible across themes
              // (the design's rgba(255,255,255,.4) vanishes on a dark canvas).
              background: addHovered ? 'var(--color-surface-primary)' : 'rgba(var(--color-interactive-rgb), 0.06)',
              padding: '18px 16px',
              transition: 'border-color .12s, background .12s',
            }}
            data-testid="quick-session-add-workflow"
          >
            <div
              style={{
                fontSize: 9,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--color-text-tertiary)',
                fontWeight: 700,
              }}
            >
              Optional next step
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)', marginTop: 7 }}>
              Add a workflow
            </div>
            <div style={{ fontSize: 10.5, lineHeight: 1.45, color: 'var(--color-text-tertiary)', marginTop: 6 }}>
              Drop a structured pipeline onto this session at any point.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 13 }}>
              {ordered.map((row) => (
                <WorkflowCmdButton
                  key={row.id}
                  testId={`quick-session-launch-${row.name}`}
                  label={`/${row.name}`}
                  dotColor={phaseDotColor(row)}
                  disabled={isLaunching}
                  onClick={() => handleWorkflowClick(row)}
                  onboardingAnchor={row.name === 'ship' ? ONBOARDING_ANCHORS.shipChip : undefined}
                  startHere={row.name === 'ship' && onboardingShipStep}
                />
              ))}
            </div>

            <button
              type="button"
              data-testid="quick-session-browse-all"
              onClick={isInteractive || isRawCheckout ? () => onAddWorkflowToNewSession?.() : onBrowseAll}
              onMouseEnter={() => setBrowseHovered(true)}
              onMouseLeave={() => setBrowseHovered(false)}
              style={{
                width: '100%',
                marginTop: 8,
                fontSize: 9.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                fontWeight: 700,
                color: browseHovered ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                border: `1px solid ${browseHovered ? 'var(--color-text-primary)' : 'var(--color-border-primary)'}`,
                background: 'transparent',
                padding: '7px 11px',
                cursor: 'pointer',
                transition: 'color .12s, border-color .12s',
              }}
            >
              {workflows.length > 0 ? `Browse all ${workflows.length} workflows →` : 'Browse all workflows →'}
            </button>

            {error && (
              <p style={{ marginTop: 8, fontSize: 10, color: 'var(--color-status-error)' }} role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
        </>
      )}

      {/* Planner idea-selection gate (migration 017). */}
      {plannerIdForGate !== null && (
        <IdeaPickerModal
          isOpen
          projectId={projectId}
          onClose={() => setPlannerIdForGate(null)}
          onPicked={handleIdeaPicked}
        />
      )}

      {/* Sprint task-batch gate (parallel sprint) — the canvas fast lane uses
          DEFAULT_SUBSTRATE (mirrors useLaunchWorkflow), so the picker's cap
          resolves off the same value the launch will stamp. */}
      {sprintIdForGate !== null && (
        <TaskBatchPickerModal
          isOpen
          projectId={projectId}
          substrate={DEFAULT_SUBSTRATE}
          onClose={() => setSprintIdForGate(null)}
          onPicked={handleBatchPicked}
        />
      )}

      {/* In-place add-a-workflow confirm — a workflow can't run on the raw project
          checkout, so confirm it will open in a new, isolated session before
          continuing the chip flow (which launches with forceNew). */}
      {pendingRawCheckoutRow !== null && (
        <ConfirmDialog
          isOpen
          onClose={() => setPendingRawCheckoutRow(null)}
          onConfirm={() => {
            const row = pendingRawCheckoutRow;
            setPendingRawCheckoutRow(null);
            if (row !== null) routeWorkflowChip(row);
          }}
          title="Workflows run in their own worktree"
          message="This session works directly in the project checkout, so it can't host a workflow run. The workflow will open in a new session with an isolated worktree — this one stays open and untouched."
          confirmText="Open in new session"
          cancelText="Cancel"
          confirmButtonClass="bg-interactive hover:bg-interactive-hover text-text-on-interactive"
        />
      )}
    </div>
  );
}
