/**
 * VerifyHealthPanel — the phase-3 health surface on the Verify Queue
 * (docs/proposals/verification-setup-flow.md §6).
 *
 * Two tables, both LIVE rather than remembered:
 *
 *   - PROJECTS — whether each project has verification set up, and a launch for
 *     the flow that sets it up.
 *   - HOST — one row per capability the user can act on (browser driving, and
 *     the two macOS TCC grants), re-run on every panel open. Never a stored
 *     checkbox: a TCC grant rots silently on any app-path or version change
 *     while a remembered "configured" keeps claiming otherwise, which is the
 *     failure this replaces. Each row carries whatever remedy exists — an
 *     in-place install for chromium, the OS prompt or the right Settings pane
 *     for a grant.
 *
 * The per-modality OUTCOMES block — runbook state, attempts, pass rate, failure
 * histogram, median duration, capability suppressions, and the unattributed /
 * setup-proof counters — is deliberately not rendered here for now. It answered
 * a question ("how has verification been going?") that nobody was asking of a
 * panel they open to find out whether verification WORKS, and on a project with
 * a proven runbook and no lane traffic yet it was four em-dashes and a number
 * about the budget.
 *
 * KNOWN GAP while it is gone: the project row reads `set up` when ANY modality
 * is proven, so a project with `web` proven and `native-screen` not shows no
 * sign that native-screen checks are silently skipping. `verificationRequests
 * .health` still serves all of it — this is a rendering decision, not a
 * teardown — so restoring the block is a UI change alone.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { useNavigationStore } from '../../stores/navigationStore';
import { VERIFY_SETUP_WORKFLOW_NAME } from './wizard/workflowMeta';
import type {
  VerifyHostProbeReport,
  VerifyProbeRow,
  VerifyProjectSetupRow,
  XcodeAccessApproval,
} from '../../../../shared/types/visualVerification';
import {
  PROBE_LABEL,
  PROBE_STATUS_LABEL,
  probeFixLabel,
  probeFixPendingLabel,
  probeStatus,
  probeStatusClass,
  projectSetupLine,
  setupIsLaneDerived,
  setupStatusFor,
} from './verifyHealthModel';

// ---------------------------------------------------------------------------
// Setup CTA
// ---------------------------------------------------------------------------

/**
 * Launches the verify-setup flow by opening the session wizard PRESELECTED to
 * it, rather than calling `runs.start` here.
 *
 * The flow is hidden from the wizard's own list (it configures the project
 * rather than doing project work), so this CTA is its primary entry point —
 * see `wizard/workflowMeta.ts` SETUP_WORKFLOW_NAMES. That is why the button is
 * rendered UNCONDITIONALLY rather than only when setup looks needed: a health
 * query that failed, or one modality already proven while another is not, must
 * not be able to hide the only affordance for repairing the rest.
 *
 * A flow launch needs a host session, a resolved substrate/provider pair, a
 * model and a permission mode — all of which the wizard already owns. Starting
 * a run directly from this panel would duplicate that ladder and drift from it.
 */
export function VerifySetupCta({
  projectId,
  label,
  testId,
}: {
  projectId: number | null;
  label: string;
  testId: string;
}): ReactElement {
  const onClick = useCallback(() => {
    useNavigationStore.getState().goToWizard({
      preselectWorkflowName: VERIFY_SETUP_WORKFLOW_NAME,
      ...(projectId !== null ? { lockProjectId: projectId } : {}),
    });
  }, [projectId]);

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:border-border-emphasized hover:bg-bg-hover focus:border-border-emphasized focus:outline-none"
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Project setup list
// ---------------------------------------------------------------------------

/**
 * Every project and whether verification is actually set up for it.
 *
 * This replaced a single "Set up verification" button in the panel header. A
 * runbook is registered against ONE project, so that button could only ever
 * configure whichever project the queue filter happened to be showing — and it
 * said nothing at all about the others, which is exactly the question someone
 * opening this panel is asking. Listing them turns an action with hidden scope
 * into a state you can read.
 *
 * The project names come from the caller (which already loads them for the
 * queue's filter); this component only joins them against the setup rows.
 */
export function VerifyProjectSetupList({
  projects,
  rows,
}: {
  projects: readonly { id: number; name: string }[];
  /** `null` while loading or after a failed query — every project then reads `not set up`. */
  rows: readonly VerifyProjectSetupRow[] | null;
}): ReactElement | null {
  if (projects.length === 0) return null;
  return (
    <div
      data-testid="verify-setup-projects"
      className="rounded-card border border-border-primary bg-bg-primary px-3 py-1"
    >
      {projects.map((project) => {
        const status = setupStatusFor(rows, project.id);
        // Migration-105 provenance (lane-runbook-bootstrap): a project whose
        // verification a RUN configured, rather than a human at a gate, says so
        // here. Both are proven the same way; this is the only durable record of
        // which happened, and someone deciding whether to trust it needs it.
        const line = projectSetupLine(status, setupIsLaneDerived(rows, project.id));
        return (
          <div
            key={project.id}
            data-testid={`verify-setup-project-${project.id}`}
            className="flex items-center gap-2 border-b border-border-primary/50 py-1.5 last:border-b-0"
          >
            <span
              data-testid={`verify-setup-status-${project.id}`}
              className={`w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-medium ${line.className}`}
            >
              {line.text}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{project.name}</span>
            <VerifySetupCta
              projectId={project.id}
              label={status === 'proven' ? 'Re-run setup' : 'Set up'}
              testId={`verify-setup-cta-${project.id}`}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The mutation behind a row's fix, or `null` for a row that offers none.
 *
 * A `switch` rather than a lookup table so adding a `VerifyProbeFix` variant is
 * a compile error here instead of a button that silently does nothing.
 */
function fixMutation(
  fix: VerifyProbeRow['fix'],
): (() => Promise<{ report: VerifyHostProbeReport; approval?: XcodeAccessApproval }>) | null {
  const reportOnly = (run: () => Promise<VerifyHostProbeReport>) => async () => ({ report: await run() });
  switch (fix) {
    case 'provision-chromium':
      return reportOnly(() => trpc.cyboflow.verificationRequests.provisionChromium.mutate());
    case 'request-accessibility':
      return reportOnly(() => trpc.cyboflow.verificationRequests.requestAccessibility.mutate());
    case 'open-screen-recording-settings':
      return reportOnly(() => trpc.cyboflow.verificationRequests.openScreenRecordingSettings.mutate());
    case 'approve-xcode-access':
      // §B8: the main process raises Xcode's own prompt; what comes back is
      // the command to SHOW (never run) plus the re-probed rows.
      return () => trpc.cyboflow.verificationRequests.approveXcodeAccess.mutate();
    case null:
      return null;
  }
}

/**
 * The §B8 result: what happened, the exact `sudo xcrun mcp-server approve …`
 * command to run in Terminal (shown, never run by the app), and the disclosure
 * that must accompany it. The durable `--always` form is an explicit opt-in:
 * hidden until the user asks for it, and only ever offered on a signed build.
 */
function XcodeApprovalNotice({ approval }: { approval: XcodeAccessApproval }): ReactElement {
  const [showDurable, setShowDurable] = useState(false);
  return (
    <div
      data-testid="verify-xcode-approval"
      className="flex flex-col gap-1.5 rounded-card border border-border-primary bg-bg-primary px-3 py-2 text-[11px] text-text-secondary"
    >
      <span className="text-text-primary">{approval.detail}</span>
      <span data-testid="verify-xcode-approval-disclosure">{approval.disclosure}</span>
      {approval.approveCommand !== null && (
        <>
          <span>To approve for 24 hours, run this in Terminal (Cyboflow never runs it for you):</span>
          <code
            data-testid="verify-xcode-approve-command"
            className="select-all break-all rounded bg-bg-tertiary px-1.5 py-1 font-mono text-text-primary"
          >
            {approval.approveCommand}
          </code>
        </>
      )}
      {approval.durableApproveCommand !== null && !showDurable && (
        <button
          type="button"
          data-testid="verify-xcode-show-durable"
          onClick={() => setShowDurable(true)}
          className="self-start text-[11px] text-text-tertiary underline hover:text-text-primary focus:outline-none"
        >
          Show the durable (no-expiry) command instead…
        </button>
      )}
      {approval.durableApproveCommand !== null && showDurable && (
        <code
          data-testid="verify-xcode-durable-command"
          className="select-all break-all rounded bg-bg-tertiary px-1.5 py-1 font-mono text-text-primary"
        >
          {approval.durableApproveCommand}
        </code>
      )}
    </div>
  );
}

function ProbeTableRow({
  row,
  onFix,
  fixInFlight,
}: {
  row: VerifyProbeRow;
  onFix: (row: VerifyProbeRow) => void;
  fixInFlight: boolean;
}): ReactElement {
  const fixLabel = probeFixLabel(row);
  const pendingLabel = probeFixPendingLabel(row.fix);
  return (
    // The probe's own sentence — a chromium path, the reason a grant could not
    // be read — survives as the row's tooltip rather than on screen. It is what
    // you want the moment something is wrong and noise every other moment, and
    // a row that says only `healthy` is the one a user can actually scan.
    <div
      data-testid={`verify-probe-${row.id}`}
      title={row.detail}
      className="flex items-center gap-2 border-b border-border-primary/50 py-1.5 last:border-b-0"
    >
      <span
        data-testid={`verify-probe-state-${row.id}`}
        className={`w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-medium ${probeStatusClass(row)}`}
      >
        {PROBE_STATUS_LABEL[probeStatus(row)]}
      </span>
      <span className="min-w-0 flex-1 text-xs text-text-primary">{PROBE_LABEL[row.id]}</span>
      {fixLabel !== null && (
        <button
          type="button"
          data-testid={`verify-probe-fix-${row.id}`}
          disabled={fixInFlight}
          onClick={() => onFix(row)}
          className="shrink-0 rounded-button border border-border-primary bg-bg-primary px-2 py-0.5 text-[11px] text-text-primary transition-colors hover:border-border-emphasized hover:bg-bg-hover disabled:opacity-50 focus:border-border-emphasized focus:outline-none"
        >
          {fixInFlight && pendingLabel !== null ? pendingLabel : fixLabel}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function VerifyHealthPanel({
  projectId,
  projects = [],
}: {
  projectId: number | null;
  /**
   * Every project, for the setup list. Supplied by the caller rather than
   * fetched here: the Verify Queue already loads this list for its own filter,
   * and a second loader would drift from it.
   */
  projects?: readonly { id: number; name: string }[];
}): ReactElement | null {
  const [probes, setProbes] = useState<VerifyHostProbeReport | null>(null);
  const [setupRows, setSetupRows] = useState<VerifyProjectSetupRow[] | null>(null);
  const [fixInFlight, setFixInFlight] = useState(false);
  const [xcodeApproval, setXcodeApproval] = useState<XcodeAccessApproval | null>(null);

  // PROBES run ONCE per panel open, never on a poll. Each pass shells out — resolving a Playwright browser path and asking the
  // OS about the screen-recording grant — and none of it is project-scoped or
  // fast-moving: a TCC grant or an installed binary changes when a human does
  // something about it, not every fifteen seconds. §6 asks for "probed at call
  // time, no remembered state", and an open is a call; a background poll of
  // subprocess work is a different thing wearing the same words.
  //
  // No race with the fix-it mutation: the fix button only exists once these
  // rows have rendered, so there is never an in-flight probe to overwrite the
  // mutation's fresher report.
  useEffect(() => {
    let cancelled = false;
    void trpc.cyboflow.verificationRequests.hostProbes
      .query()
      .then((res) => {
        if (!cancelled) setProbes(res);
      })
      .catch(() => {
        if (!cancelled) setProbes(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // SETUP rows are host-wide rather than project-scoped, so they load once per
  // panel open like the probes do. A failure
  // degrades to `null`, which reads every project as `not set up`: the panel's
  // whole job here is to offer the setup flow, and the worst it can do while
  // the query is down is offer it to a project that already has it.
  useEffect(() => {
    let cancelled = false;
    void trpc.cyboflow.verificationRequests.setupByProject
      .query()
      .then((res) => {
        if (!cancelled) setSetupRows(res);
      })
      .catch(() => {
        if (!cancelled) setSetupRows(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Every fix is the same shape — do the thing, take the RE-PROBED report back —
  // which is what lets a grant action and an install share one handler. The
  // mutation returning fresh rows (rather than a boolean) is why a success is
  // reflected immediately instead of waiting out the poll interval.
  //
  // A grant action will usually come back with the row STILL missing, because
  // the user has not flipped the switch yet. That is the honest reading of the
  // host at that instant, not a failure, and the next panel open picks it up.
  const handleFix = useCallback((row: VerifyProbeRow) => {
    const run = fixMutation(row.fix);
    if (run === null) return;
    setFixInFlight(true);
    void run()
      .then((result) => {
        setProbes(result.report);
        if (result.approval !== undefined) setXcodeApproval(result.approval);
      })
      .catch(() => {
        // Soft-fail: none of these throw for an ordinary "could not do it" —
        // the re-probed row carries that outcome. An actual transport error
        // leaves the previous rows in place.
      })
      .finally(() => setFixInFlight(false));
  }, []);

  if (projectId === null) return null;

  // The panel renders even when EVERY query failed. It degrades to a header and
  // the setup list rather than disappearing: this is the launch path for the
  // flow that repairs verification, and a failing query is not a reason to take
  // it away — it is a reason to want it.
  return (
    <section data-testid="verify-health-panel" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="eyebrow text-text-tertiary">Health</h2>
        <span className="text-[10px] text-text-tertiary">live probes · setup state</span>
      </div>

      <VerifyProjectSetupList projects={projects} rows={setupRows} />

      {probes !== null && (
        <div className="rounded-card border border-border-primary bg-bg-primary px-3 py-1">
          {probes.probes.map((row) => (
            <ProbeTableRow
              key={row.id}
              row={row}
              onFix={handleFix}
              fixInFlight={fixInFlight}
            />
          ))}
        </div>
      )}
      {xcodeApproval !== null && <XcodeApprovalNotice approval={xcodeApproval} />}

    </section>
  );
}
