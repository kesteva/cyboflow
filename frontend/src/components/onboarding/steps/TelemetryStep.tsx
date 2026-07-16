/**
 * Step 3 — telemetry consent. Two independent opt-out toggles (Sentry error
 * reporting, Aptabase usage metrics) mirroring the copy used by Settings'
 * "Privacy & Telemetry" card, so both surfaces read consistently. Purely
 * presentational/controlled like PermissionStep: the gate resolves the draft
 * from the live AppConfig, owns the submit/error/loading state, and persists
 * on Next — this component never reaches into a store.
 *
 * `value === null` means the draft hasn't resolved from config yet (loading);
 * toggles render disabled rather than guessing a default. `error` renders an
 * inline, non-dismissing banner — the footer's Next button (owned by the gate)
 * doubles as the retry action, so no separate retry control lives here.
 */
export interface TelemetryDraft {
  errorReportingEnabled: boolean;
  usageMetricsEnabled: boolean;
}

interface TelemetryStepProps {
  value: TelemetryDraft | null;
  onChange: (value: TelemetryDraft) => void;
  submitting: boolean;
  error: string | null;
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

function ToggleRow({ label, checked, disabled, onToggle }: ToggleRowProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3">
      <span className="min-w-0 flex-1 text-[11.5px] font-bold text-text-primary">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
          checked ? 'bg-interactive' : 'bg-border-primary'
        } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-[left]"
          style={{ left: checked ? 22 : 2 }}
        />
      </button>
    </div>
  );
}

export function TelemetryStep({ value, onChange, submitting, error }: TelemetryStepProps): React.JSX.Element {
  const loading = value === null;
  return (
    <div className="px-6 pb-2 pt-5">
      <div className="mb-[15px] text-[12px] leading-[1.6] text-text-primary">
        Help improve Cyboflow with anonymized diagnostics. Telemetry is fully anonymized — no source code, prompts,
        project or repository names, or file paths are ever sent. Either or both may be off; nothing here blocks you
        from continuing. Changes take effect after restarting the app.
      </div>
      {loading ? (
        <div className="flex items-center gap-3 border border-border-primary bg-surface-primary px-[15px] py-3.5">
          <span className="h-[7px] w-[7px] flex-shrink-0 animate-cfpulse rounded-full bg-interactive" />
          <span className="text-[11px] text-text-secondary">Loading your current settings…</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Send anonymized crash & error reports"
            checked={value.errorReportingEnabled}
            disabled={submitting}
            onToggle={() => onChange({ ...value, errorReportingEnabled: !value.errorReportingEnabled })}
          />
          <ToggleRow
            label="Send anonymized feature usage metrics"
            checked={value.usageMetricsEnabled}
            disabled={submitting}
            onToggle={() => onChange({ ...value, usageMetricsEnabled: !value.usageMetricsEnabled })}
          />
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-3 border border-status-error/30 bg-status-error/10 px-3.5 py-2.5 text-[10.5px] leading-[1.5] text-status-error"
        >
          {error} Use Next to try again.
        </div>
      )}
      <div className="mt-[13px] text-[10px] leading-[1.5] text-text-tertiary">
        Change this anytime in Settings → Privacy &amp; Telemetry.
      </div>
    </div>
  );
}
