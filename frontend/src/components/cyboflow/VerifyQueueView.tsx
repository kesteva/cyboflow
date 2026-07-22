/**
 * VerifyQueueView — the L6 Verify-Queue panel (S7).
 *
 * A read-only, full-width observability view over the `verification_requests`
 * work queue. Live state comes from {@link useVerificationRequests} (the polling
 * list hook over `cyboflow.verificationRequests.list`). Per row it shows the
 * request id, verify type, an engine-identity chip (agent vs legacy — see
 * {@link isAgentEngineRow}), a status badge, the task summary, the current
 * backend + attempt counter, and a lifecycle/verdict summary line.
 *
 * verification-agent redesign §5.11: an agent-engine row (migration 078
 * `task_json` populated) carries a composed `VerificationTaskV1` instead of a
 * bare intent, and its terminal state is a `VerificationReportV1` in
 * `report_json` rather than a `VerdictV1` in `verdict_json` — a legacy-only
 * reader showed blank summaries and stale "Capturing / judging…" copy for
 * these rows. {@link taskSummary} / {@link statusSummary} branch on
 * {@link isAgentEngineRow} so both row formats render correctly; a legacy row
 * (`task_json === null`) renders byte-identical to before.
 *
 * NO mutations originate here (Accept-as-baseline was retired outright, §5.10).
 * The header carries a project filter — the list query is project-scoped (no
 * "all projects" option, unlike Insights, because the route requires a
 * positive projectId), defaulting to the active project.
 *
 * Styling mirrors the existing cyboflow panel idiom (SprintLanesPanel status
 * pills + InsightsView header / card surfaces).
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { API } from '../../utils/api';
import type { Project } from '../../types/project';
import { useNavigationStore } from '../../stores/navigationStore';
import {
  useVerificationRequests,
  type VerificationRequest,
} from '../../hooks/useVerificationRequests';
import type {
  RequestStatus,
  VerdictV1,
  VerificationRequestInput,
  VerificationTaskV1,
  VerificationReportV1,
} from '../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Status badge palette — same compact rounded-full pill convention as
// SprintLanesPanel's lane-status pills, extended across the full RequestStatus
// lifecycle.
// ---------------------------------------------------------------------------

const STATUS_PILL_CLASS: Readonly<Record<RequestStatus, string>> = {
  queued: 'bg-bg-tertiary text-text-tertiary',
  leased: 'bg-interactive/15 text-interactive',
  running: 'bg-interactive/15 text-interactive',
  passed: 'bg-status-success/15 text-status-success',
  failed: 'bg-status-error/15 text-status-error',
  low_confidence: 'bg-status-warning/15 text-status-warning',
  skipped: 'bg-bg-tertiary text-text-tertiary',
  timeout: 'bg-status-error/15 text-status-error',
};

// ---------------------------------------------------------------------------
// JSON-column parsers — the JSON columns are stored as TEXT; the renderer
// parses them defensively (a malformed payload degrades to a neutral fallback,
// never throws and never blanks the panel).
// ---------------------------------------------------------------------------

/** Parse the serialized VerificationRequestInput; null on any parse failure. */
function parseDeliverable(json: string): VerificationRequestInput | null {
  try {
    return JSON.parse(json) as VerificationRequestInput;
  } catch {
    return null;
  }
}

/** Parse the serialized VerdictV1; null when absent or malformed. */
function parseVerdict(json: string | null): VerdictV1 | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as VerdictV1;
  } catch {
    return null;
  }
}

/** Parse the serialized composed VerificationTaskV1 (migration 078 `task_json`); null when absent/malformed. */
function parseTask(json: string | null): VerificationTaskV1 | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as { summary?: unknown };
    return typeof parsed.summary === 'string' ? (parsed as VerificationTaskV1) : null;
  } catch {
    return null;
  }
}

/**
 * Just the `outcome` member of a serialized `VerificationReportV1` (migration
 * 078 `report_json`) — §5.11 asks for the report OUTCOME only, not the whole
 * report (behaviors/evidence live on the screenshots artifact's "Behaviors
 * tested" table, §5.9).
 */
function parseReportOutcome(json: string | null): VerificationReportV1['outcome'] | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as { outcome?: unknown };
    const outcome = parsed.outcome;
    return outcome === 'pass' || outcome === 'fail' || outcome === 'build_failed' || outcome === 'launch_failed'
      ? outcome
      : null;
  } catch {
    return null;
  }
}

/** Terminal request statuses — a row past this point has a final report/verdict (or none, if it failed to produce one). */
const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set([
  'passed',
  'failed',
  'low_confidence',
  'skipped',
  'timeout',
]);

/**
 * Engine identity: the CHEAPEST correct signal already on the row is
 * `task_json` presence — the dual-write contract (§5.2) populates it for
 * every request enqueued via the composed-task path (the agent engine), and
 * leaves it NULL for every legacy capture/judge request. The alternative
 * (joining the run's stamped `verify_chain`) needs a second read this
 * observability panel has no reason to pay for.
 */
function isAgentEngineRow(req: VerificationRequest): boolean {
  return req.task_json !== null;
}

/** The task summary line: the composed task's `summary` (agent rows), else the legacy `deliverable_json.intent`. */
function taskSummary(req: VerificationRequest): string {
  const task = parseTask(req.task_json);
  if (task !== null) return task.summary.trim();
  const deliverable = parseDeliverable(req.deliverable_json);
  return deliverable?.intent?.trim() ?? '';
}

/** Agent-appropriate lifecycle copy for a non-terminal agent-engine row. */
function agentLifecycleSummary(req: VerificationRequest): string {
  if (req.status === 'queued' || req.status === 'leased') return 'Awaiting the verification agent';
  if (req.status === 'running') return 'Agent building + driving the deliverable';
  return 'No verdict yet';
}

/** Legacy capture/judge lifecycle copy for a non-terminal legacy-engine row (unchanged from pre-§5.11). */
function legacyLifecycleSummary(req: VerificationRequest): string {
  if (req.status === 'queued') return 'Awaiting a free capture slot';
  if (req.status === 'leased' || req.status === 'running') return 'Capturing / judging…';
  if (req.status === 'skipped') return 'No backend could satisfy this type';
  return 'No verdict yet';
}

/**
 * A one-line status summary for a row: the judged VerdictV1 (legacy terminal
 * rows), else the report's `outcome` (agent terminal rows, §5.11), else the
 * last runtime error, else lifecycle-derived copy branched on engine identity.
 */
function statusSummary(req: VerificationRequest, isAgent: boolean): string {
  const verdict = parseVerdict(req.verdict_json);
  if (verdict !== null) {
    const pct = Math.round(verdict.confidence * 100);
    const feedback = verdict.feedback.trim();
    const head = `${verdict.status} · ${pct}%`;
    return feedback.length > 0 ? `${head} — ${feedback}` : head;
  }
  if (TERMINAL_STATUSES.has(req.status)) {
    const outcome = parseReportOutcome(req.report_json);
    if (outcome !== null) return `report outcome: ${outcome.replace('_', ' ')}`;
  }
  if (req.error_message !== null && req.error_message.trim().length > 0) {
    return req.error_message;
  }
  return isAgent ? agentLifecycleSummary(req) : legacyLifecycleSummary(req);
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function VerifyQueueRow({ req }: { req: VerificationRequest }): ReactElement {
  const isAgent = isAgentEngineRow(req);
  const summary = taskSummary(req);
  const status = statusSummary(req, isAgent);

  return (
    <div
      data-testid={`verify-queue-row-${req.id}`}
      className="flex flex-col gap-1 rounded-card border border-border-primary bg-bg-primary p-3"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-text-tertiary">{req.id}</span>
        <span className="rounded-button bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
          {req.verify_type}
        </span>
        <span
          data-testid={`verify-queue-engine-${req.id}`}
          className="rounded-button bg-interactive/10 px-1.5 py-0.5 text-[10px] font-medium text-interactive"
          title={isAgent ? 'Deployed as the centrally-run verification agent' : 'Legacy capture/judge backend'}
        >
          {isAgent ? 'agent' : 'legacy'}
        </span>
        <span
          data-testid={`verify-queue-status-${req.id}`}
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL_CLASS[req.status]}`}
        >
          {req.status}
        </span>
      </div>

      {summary.length > 0 && (
        <span className="truncate text-xs text-text-primary" title={summary}>
          {summary}
        </span>
      )}

      <div className="flex items-center gap-3 text-[10px] text-text-tertiary">
        <span>backend: {req.current_backend ?? '—'}</span>
        <span>attempt {req.attempt}</span>
        <span className="font-mono">{req.run_id}</span>
      </div>

      <span className="truncate text-[11px] text-text-secondary" title={status}>
        {status}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VerifyQueueView
// ---------------------------------------------------------------------------

export function VerifyQueueView(): ReactElement {
  const activeProjectId = useNavigationStore((s) => s.activeProjectId);
  const [projects, setProjects] = useState<Project[]>([]);
  // The selected project for the queue. Seeds from the active project; the user
  // can switch via the header filter. Null until a project is resolved.
  const [projectId, setProjectId] = useState<number | null>(activeProjectId);

  // One-shot project load on mount (the ProjectFilter / SessionStartWizard
  // pattern). A failure leaves the list empty — the control degrades to the
  // active project alone, never fatal.
  useEffect(() => {
    let active = true;
    void API.projects
      .getAll()
      .then((res) => {
        if (!active) return;
        if (res.success && Array.isArray(res.data)) {
          const list = res.data as Project[];
          setProjects(list);
          // Adopt the first project when there is no active project yet so the
          // queue has something to show on first open.
          setProjectId((cur) => cur ?? list[0]?.id ?? null);
        }
      })
      .catch(() => {
        // Swallow — keep rendering with whatever project is selected.
      });
    return () => {
      active = false;
    };
  }, []);

  const { requests, isLoading, error } = useVerificationRequests({ projectId });

  const handleProjectChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    setProjectId(raw === '' ? null : Number(raw));
  };

  const body = useMemo<ReactElement>(() => {
    if (projectId === null) {
      return (
        <div data-testid="verify-queue-no-project" className="text-sm text-text-tertiary">
          Select a project to view its verification queue.
        </div>
      );
    }
    if (isLoading && requests.length === 0) {
      return (
        <div data-testid="verify-queue-loading" className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 w-full animate-pulse rounded-card border border-border-primary bg-bg-secondary"
            />
          ))}
        </div>
      );
    }
    if (requests.length === 0) {
      return (
        <div data-testid="verify-queue-empty" className="text-sm text-text-tertiary">
          No verification requests for this project yet.
        </div>
      );
    }
    return (
      <div data-testid="verify-queue-list" className="flex flex-col gap-2">
        {requests.map((req) => (
          <VerifyQueueRow key={req.id} req={req} />
        ))}
      </div>
    );
  }, [projectId, isLoading, requests]);

  return (
    <div
      data-testid="verify-queue-view"
      className="flex h-full flex-col overflow-hidden bg-bg-secondary"
    >
      {/* Header — title + project filter (mirrors the Insights header idiom). */}
      <div className="flex items-center gap-3 border-b border-border-primary px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-text-primary">Verify Queue</h1>
          <p className="text-[11px] text-text-tertiary">
            Visual-verification requests · captures &amp; verdicts
          </p>
        </div>
        <label className="ml-auto flex items-center gap-2">
          <span className="eyebrow text-text-tertiary">Project</span>
          <select
            data-testid="verify-queue-project-filter"
            aria-label="Filter verification queue by project"
            value={projectId === null ? '' : String(projectId)}
            onChange={handleProjectChange}
            className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
          >
            {projectId === null && <option value="">Select a project…</option>}
            {projects.map((project) => (
              <option key={project.id} value={String(project.id)}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Non-fatal error banner — the panel keeps rendering the last good list. */}
      {error !== null && (
        <div
          data-testid="verify-queue-error"
          className="border-b border-border-primary bg-status-error/10 px-5 py-2 text-xs text-status-error"
        >
          Failed to refresh the verify queue: {error.message}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-5">{body}</div>
    </div>
  );
}
