import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Bug, ChevronRight, ChevronDown, AlertTriangle, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useSessionStore } from '../stores/sessionStore';
import { Toggle } from './ui/Toggle';
import {
  BUG_REPORT_LIMITS,
  type BugReportPreview,
  type BugReportRunLink,
  type BugReportSubmitResponse,
} from '../../../shared/types/bugReport';
import { useOcclusion } from '../hooks/useOcclusion';

interface BugReportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type SendState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'done'; response: BugReportSubmitResponse }
  | { phase: 'error'; message: string };

/**
 * Human-readable outcome text per delivery state.
 *
 * `detail` is absent for the one outcome that needs no explaining: a report that
 * simply sent. Every other state is telling the user something happened to their
 * report, so it says what.
 */
function describeDelivery(response: BugReportSubmitResponse): {
  tone: 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
} {
  switch (response.delivery) {
    case 'accepted':
      return {
        tone: 'success',
        title: 'Report sent',
      };
    case 'queued':
      return {
        tone: 'warning',
        title: 'Report queued',
        detail: "It couldn't be delivered right now and will be retried automatically.",
      };
    case 'rate-limited':
      return {
        tone: 'warning',
        title: 'Not sent yet',
        detail:
          response.error ??
          `Please wait ${response.retryAfterSeconds ?? 30}s before sending another report.`,
      };
    case 'unavailable':
      return {
        tone: 'error',
        title: "This build can't send reports",
        detail:
          response.error ??
          'No reporting endpoint is configured in this build. Please file an issue on GitHub instead.',
      };
    default:
      return {
        tone: 'error',
        title: "Report couldn't be sent",
        detail: response.error ?? 'An unexpected error occurred.',
      };
  }
}

export function BugReportDialog({ isOpen, onClose }: BugReportDialogProps) {
  useOcclusion(isOpen, 'bug-report-dialog');
  const [whatHappened, setWhatHappened] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [email, setEmail] = useState('');
  const [sessionId, setSessionId] = useState<string>('');
  const [includeLogs, setIncludeLogs] = useState(false);
  // Expanded from the start: the point of the panel is that the user sees what
  // they are about to send without having to go looking for it.
  const [showDiagnostics, setShowDiagnostics] = useState(true);
  const [preview, setPreview] = useState<BugReportPreview | null>(null);
  const [send, setSend] = useState<SendState>({ phase: 'idle' });

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  /**
   * The run the chosen session will be tagged with, resolved by the main process.
   *
   * Deliberately NOT read from the rail's active-runs store, which retains only
   * non-terminal runs: a report is usually filed about a run that has already
   * failed or finished, so that store is empty of exactly the run worth linking.
   * Resolving through the same channel the submit path uses also keeps this line
   * honest — it reports what will actually be sent, not a second guess at it.
   */
  const [linkedRun, setLinkedRun] = useState<BugReportRunLink | null>(null);

  /**
   * One generation per open (and per close). The dialog stays mounted while
   * closed, so anything resolving late — an in-flight submit, a slow preview —
   * must not write state belonging to a different opening.
   *
   * A boolean "is it open" ref is not enough: closing and reopening before an
   * in-flight submit resolves makes it true again, and the old result lands in
   * the new dialog.
   */
  const generationRef = useRef(0);

  /**
   * Read at open time only. Seeding the session picker from a live subscription
   * would silently overwrite the user's choice whenever the app switched
   * sessions behind the dialog.
   */
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  /**
   * One key per dialog session, deliberately stable across retries: the handler
   * only remembers keys it actually filed, so reusing the key is what stops a
   * retry-after-timeout from filing the same report twice.
   */
  const idempotencyKeyRef = useRef('');

  const resetForm = useCallback(() => {
    setWhatHappened('');
    setSteps('');
    setExpected('');
    setEmail('');
    setIncludeLogs(false);
    setShowDiagnostics(true);
    // Cleared with the rest: a preview held across a close is the PREVIOUS
    // opening's diagnostics, and the next one would submit — and could show —
    // recorded errors and a log tail the user never reviewed in this dialog.
    setPreview(null);
    setLinkedRun(null);
    setSend({ phase: 'idle' });
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    if (!isOpen) {
      resetForm();
      return;
    }
    const generation = generationRef.current;
    setSessionId(activeSessionIdRef.current ?? '');
    idempotencyKeyRef.current = crypto.randomUUID();
    void (async () => {
      try {
        const result = await window.electronAPI.bugReport.getPreview();
        if (generationRef.current !== generation) return;
        if (result.success && result.data) {
          setPreview(result.data);
        }
      } catch {
        // Preview is best-effort; the report can still be sent without it.
      }
    })();
  }, [isOpen, resetForm]);

  /**
   * Re-resolve whenever the chosen session changes. Generation-guarded like the
   * preview: a resolution in flight when the user switches sessions — or closes
   * the dialog — must not label the next choice with the previous one's run.
   */
  useEffect(() => {
    if (!isOpen) return;
    const generation = generationRef.current;
    if (!sessionId) {
      setLinkedRun(null);
      return;
    }
    void (async () => {
      try {
        const result = await window.electronAPI.bugReport.resolveRun(sessionId);
        if (generationRef.current !== generation) return;
        setLinkedRun(result.success ? (result.data ?? null) : null);
      } catch {
        // Best-effort: the tag is still derived in the main process at submit.
        if (generationRef.current === generation) setLinkedRun(null);
      }
    })();
  }, [isOpen, sessionId]);

  const canSubmit =
    whatHappened.trim().length > 0 &&
    whatHappened.length <= BUG_REPORT_LIMITS.whatHappenedMax &&
    send.phase !== 'sending';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const generation = generationRef.current;
    setSend({ phase: 'sending' });
    try {
      const result = await window.electronAPI.bugReport.submit({
        whatHappened,
        stepsToReproduce: steps,
        expectedBehavior: expected,
        email: email.trim() || undefined,
        // The session id is the only id sent: the run and flow name are derived
        // from it in the main process, which can see runs the rail has dropped.
        sessionId: sessionId || undefined,
        // Send exactly what the user previewed, so what they read is what leaves
        // the machine — both the log text and the recorded-failure list, which is
        // the one part of the diagnostics payload that can change while the
        // dialog is open.
        logText: includeLogs ? preview?.logTail.text : undefined,
        recentErrors: preview?.diagnostics.recentErrors ?? [],
        idempotencyKey: idempotencyKeyRef.current,
      });
      if (generationRef.current !== generation) return;
      if (result.success && result.data) {
        setSend({ phase: 'done', response: result.data });
      } else {
        setSend({ phase: 'error', message: result.error ?? 'Failed to send report.' });
      }
    } catch (error) {
      if (generationRef.current !== generation) return;
      setSend({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (!isOpen) return null;

  const diagnostics = preview?.diagnostics;
  const logTail = preview?.logTail;

  return (
    <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-primary flex-shrink-0">
          <div className="flex items-center space-x-3">
            <Bug className="w-5 h-5 text-text-secondary" />
            <h2 className="text-xl font-semibold text-text-primary">Report a bug</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {send.phase === 'done' ? (
            <ResultPanel
              response={send.response}
              onClose={onClose}
              // Return to the filled-in form, not a blank one: the report is
              // still there and retrying is the whole point of the button.
              onAgain={() => setSend({ phase: 'idle' })}
            />
          ) : (
            <>
              <Field
                label="What happened?"
                required
                value={whatHappened}
                onChange={setWhatHappened}
                max={BUG_REPORT_LIMITS.whatHappenedMax}
                placeholder="Describe what went wrong."
                rows={3}
              />
              <Field
                label="Steps to reproduce"
                value={steps}
                onChange={setSteps}
                max={BUG_REPORT_LIMITS.stepsMax}
                placeholder="1. …&#10;2. …"
                rows={3}
              />
              <Field
                label="What did you expect to happen?"
                value={expected}
                onChange={setExpected}
                max={BUG_REPORT_LIMITS.expectedMax}
                placeholder="What you expected instead."
                rows={2}
              />

              {/* Session / run association */}
              <div className="space-y-1.5">
                <label htmlFor="bug-report-session" className="block text-sm font-medium text-text-secondary">
                  Where did this happen?
                </label>
                <select
                  id="bug-report-session"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="">Not related to a specific session</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {linkedRun && (
                  <p className="text-xs text-text-tertiary">
                    {linkedRun.flowName
                      ? `Linked to the ${linkedRun.flowName} run in this session.`
                      : 'Linked to the run in this session.'}
                  </p>
                )}
              </div>

              {/* Contact. No consent checkbox: filling the field in IS the
                  consent, and a separate flag can only ever disagree with it. */}
              <div className="pt-4 border-t border-border-primary space-y-2">
                <label className="block text-sm font-medium text-text-secondary" htmlFor="bug-report-email">
                  Email
                  <span className="block text-xs font-normal text-text-tertiary">
                    Optional, and only used to follow up on this report. See
                    &ldquo;What&apos;s included&rdquo; below for everything else the report carries.
                  </span>
                </label>
                <input
                  id="bug-report-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  maxLength={BUG_REPORT_LIMITS.emailMax}
                  placeholder="you@example.com"
                  className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                />
              </div>

              {/* What's included */}
              <div className="pt-4 border-t border-border-primary space-y-3">
                <button
                  type="button"
                  onClick={() => setShowDiagnostics((v) => !v)}
                  className="flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
                >
                  {showDiagnostics ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  What&apos;s included
                </button>

                {showDiagnostics && (
                  <div className="rounded-md border border-border-primary bg-surface-secondary p-3 space-y-1.5">
                    {diagnostics ? (
                      <>
                        <DiagRow label="Version" value={diagnostics.appVersion} />
                        <DiagRow label="Platform" value={`${diagnostics.platform} · ${diagnostics.arch}`} />
                        <DiagRow label="Electron" value={diagnostics.electronVersion} />
                        <DiagRow label="Build" value={diagnostics.environment} />
                        <DiagRow label="Install ID" value={diagnostics.installId || '(none)'} />
                        <DiagRow
                          label="Recent errors"
                          value={
                            diagnostics.recentErrors.length === 0
                              ? 'none'
                              : `${diagnostics.recentErrors.length} recorded`
                          }
                        />
                        {diagnostics.recentErrors.length > 0 && (
                          <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface-primary p-2 text-[11px] leading-relaxed text-text-tertiary whitespace-pre-wrap">
                            {diagnostics.recentErrors
                              .map((e) => `${e.at} · ${e.seam} · ${e.errorClass}: ${e.message}`)
                              .join('\n')}
                          </pre>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-text-tertiary">Loading…</p>
                    )}
                  </div>
                )}

                {/* Logs — deliberately separate, off by default, shown before sending */}
                <div className="flex items-start gap-2.5">
                  <Toggle
                    size="sm"
                    checked={includeLogs}
                    onChange={setIncludeLogs}
                    // Switching this on before the preview arrives would attach
                    // nothing while telling the user their logs were included.
                    disabled={!logTail || logTail.unavailable}
                    aria-label="Include recent session logs"
                    className="mt-0.5 flex-shrink-0"
                  />
                  <span className="text-sm text-text-secondary">
                    Include recent session logs (prompts and file contents excluded)
                    <span className="block text-xs text-text-tertiary">
                      {!logTail
                        ? 'Loading…'
                        : logTail.unavailable
                          ? 'No log file is available in this build.'
                          : 'Off by default. Read it below before including it.'}
                    </span>
                  </span>
                </div>

                {includeLogs && logTail && !logTail.unavailable && (
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2.5">
                      <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-text-secondary leading-relaxed">
                        Logs can contain file paths, repository names, prompts, command output, and
                        occasionally credentials. Automated redaction cannot always reliably remove
                        these. Please review the logs below for sensitive details.
                      </p>
                    </div>
                    <p className="text-[11px] text-text-tertiary font-mono truncate" title={logTail.filePath}>
                      {logTail.filePath}
                    </p>
                    <pre className="max-h-48 overflow-auto rounded bg-surface-secondary p-2 text-[11px] leading-relaxed text-text-tertiary whitespace-pre-wrap">
                      {logTail.text || '(empty)'}
                    </pre>
                  </div>
                )}
              </div>

              {send.phase === 'error' && (
                <p className="flex items-center gap-1.5 text-xs text-status-error">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{send.message}</span>
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {send.phase !== 'done' && (
          <div className="flex items-center justify-end gap-3 p-6 border-t border-border-primary flex-shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-text-on-interactive hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {send.phase === 'sending' && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{send.phase === 'sending' ? 'Sending…' : 'Send report'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className="text-xs text-text-secondary font-mono truncate" title={value}>
        {value}
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  max,
  placeholder,
  rows,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  placeholder: string;
  rows: number;
  required?: boolean;
}) {
  const id = `bug-report-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-text-secondary">
        {label}
        {required && <span className="text-status-error ml-0.5">*</span>}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={max}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary resize-y"
      />
    </div>
  );
}

function ResultPanel({
  response,
  onClose,
  onAgain,
}: {
  response: BugReportSubmitResponse;
  onClose: () => void;
  onAgain: () => void;
}) {
  const { tone, title, detail } = describeDelivery(response);
  const Icon = tone === 'success' ? CheckCircle : tone === 'warning' ? AlertTriangle : AlertCircle;
  const color =
    tone === 'success'
      ? 'text-status-success'
      : tone === 'warning'
        ? 'text-status-warning'
        : 'text-status-error';

  return (
    <div className="space-y-4 py-4 text-center">
      <Icon className={`w-10 h-10 mx-auto ${color}`} />
      <div className="space-y-1">
        <h3 className="text-base font-medium text-text-primary">{title}</h3>
        {detail && <p className="text-sm text-text-secondary">{detail}</p>}
      </div>
      <div className="flex items-center justify-center gap-3 pt-2">
        {response.delivery !== 'accepted' && response.delivery !== 'queued' && (
          <button
            onClick={onAgain}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            Try again
          </button>
        )}
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-text-on-interactive hover:bg-interactive-hover transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
