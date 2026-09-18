/**
 * verifyHealthModel — pure derivations behind the Verify health panel
 * (docs/proposals/verification-setup-flow.md §6).
 *
 * Mirrors `verifyRequestModel.ts`: no React, no tRPC, no Node built-ins — just
 * the row → display-string/class mappings, so the panel's judgement calls (what
 * counts as healthy, what a suppression actually means, when a number is
 * unknown vs zero) are unit-testable without rendering anything.
 *
 * The recurring rule here: NEVER render "no data" as a zero. A project with no
 * attempts has an unknown pass rate, not a 0% one, and the difference is the
 * whole point of the panel — a fresh project and a totally broken one must not
 * look the same.
 */
import type {
  VerificationCapabilityState,
  VerificationModalityHealth,
  VerificationOutcomeStats,
  VerificationRunbookState,
  VerifyProbeId,
  VerifyProbeRow,
  VerifyProjectSetupRow,
  VerifyProjectSetupStatus,
} from '../../../../shared/types/visualVerification';

/**
 * Human label for each probe row.
 *
 * Named for the CAPABILITY, not the mechanism: a user deciding whether their
 * project can be verified cares that a browser can be driven, not that
 * `driver-cli` resolved.
 */
export const PROBE_LABEL: Readonly<Record<VerifyProbeId, string>> = {
  'browser-driving': 'Playwright browser control',
  'screen-recording': 'Screen recording',
  accessibility: 'Computer control (accessibility)',
  'mobile-simulator': 'iOS simulator control',
};

/**
 * What a probe row says about the host, in one word.
 *
 * `unknown` is NOT a fourth wheel: a probe that could not answer is not a
 * probe that answered "no" (the fail-open rule in `preflight.ts`), and
 * folding it into `unhealthy` would send someone to fix a host that may be
 * perfectly fine. `n/a` covers machinery missing on OUR side, which is not a
 * verdict on the user's host at all.
 */
export type ProbeStatus = 'healthy' | 'pending action' | 'unhealthy' | 'unknown' | 'n/a';

/**
 * Pill classes per status.
 *
 * `unknown` and `n/a` are deliberately NEUTRAL rather than a warning colour,
 * for the reason above. `pending action` is amber, not red: there is a button
 * right there, so it is a step remaining rather than a fault.
 */
export const PROBE_STATUS_CLASS: Readonly<Record<ProbeStatus, string>> = {
  healthy: 'bg-status-success/15 text-status-success',
  'pending action': 'bg-status-warning/15 text-status-warning',
  unhealthy: 'bg-status-error/15 text-status-error',
  unknown: 'bg-bg-tertiary text-text-tertiary',
  'n/a': 'bg-bg-tertiary text-text-tertiary',
};

/**
 * The rendered spelling of each status.
 *
 * Separate from the {@link ProbeStatus} union so the values stay lowercase
 * identifiers to compare and switch on, while the panel shows sentence case.
 */
export const PROBE_STATUS_LABEL: Readonly<Record<ProbeStatus, string>> = {
  healthy: 'Healthy',
  'pending action': 'Pending action',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
  'n/a': 'N/A',
};

/**
 * The row's status word.
 *
 * An unmet capability is `pending action` exactly when the row carries a
 * remedy — the distinction the user acts on is "there is something I can do
 * here" versus "this is broken and the panel cannot help", and the fix button
 * IS that distinction.
 *
 * Deliberately NOT softened by what the current projects happen to need. An
 * earlier version reported an unmet grant no runbook depended on as `unknown`,
 * which was wrong twice: `unknown` means the probe could not answer, and this
 * probe answered clearly — and it rendered a grey "we don't know" beside a live
 * remedy button. All three capabilities are checked and reported the same way
 * on every host, because a capability you are told nothing about is one whose
 * absence you discover the first time you need it.
 */
export function probeStatus(row: VerifyProbeRow): ProbeStatus {
  switch (row.state) {
    case 'ok':
      return 'healthy';
    case 'inconclusive':
      return 'unknown';
    case 'blocked':
      return 'n/a';
    case 'missing':
      return row.fix === null ? 'unhealthy' : 'pending action';
  }
}

/** The CTA label for a probe row's offered fix, or null when it offers none. */
export function probeFixLabel(row: VerifyProbeRow): string | null {
  switch (row.fix) {
    case 'provision-chromium':
      return 'Install';
    case 'request-accessibility':
      return 'Grant access';
    case 'open-screen-recording-settings':
      return 'Open settings';
    case null:
      return null;
  }
}

/** The in-flight label while a fix runs, or null for one that completes instantly. */
export function probeFixPendingLabel(fix: VerifyProbeRow['fix']): string | null {
  return fix === 'provision-chromium' ? 'Installing…' : null;
}

/** The pill class for a row, via its status. */
export function probeStatusClass(row: VerifyProbeRow): string {
  return PROBE_STATUS_CLASS[probeStatus(row)];
}

/**
 * The word shown against a project in the setup list, and its pill class.
 *
 * `unproven` is NOT rolled into `none`. A project with runbooks that are all
 * unproven looks configured — the setup flow has been run — while the §3.2
 * degrade gate silently skips every check, so it is the state most worth
 * naming. It reads as an action remaining rather than a fault, because it is.
 */
export function projectSetupLine(
  status: VerifyProjectSetupStatus,
  /**
   * Migration-105 provenance: at least one proven runbook here was derived by a
   * lane mid-sprint rather than reviewed at a human gate. Qualifies `'Set up'`
   * and nothing else — an unproven project's real problem is that verification
   * is not running, not who wrote the draft.
   */
  laneDerived = false,
): {
  text: string;
  className: string;
} {
  switch (status) {
    case 'proven':
      // Still `healthy`: the proof means exactly the same thing whoever derived
      // it. What differs is how much review it got, which is a caveat on a
      // working state rather than a degraded one — colouring it as a warning
      // would tell people something is wrong when nothing is.
      return laneDerived
        ? { text: 'Set up (derived by a run)', className: PROBE_STATUS_CLASS.healthy }
        : { text: 'Set up', className: PROBE_STATUS_CLASS.healthy };
    case 'unproven':
      return { text: 'Not proven', className: PROBE_STATUS_CLASS['pending action'] };
    case 'none':
      return { text: 'Not set up', className: PROBE_STATUS_CLASS.unknown };
  }
}

/**
 * Fold the setup rows into a lookup keyed by project id.
 *
 * A project the query never mentioned is `none`: the router omits projects
 * with no runbook row at all, so absence IS the answer rather than missing
 * data (see its doc). That also makes a pre-096 DB degrade honestly — every
 * project reads `not set up`, which is the truth on a host that has never run
 * setup.
 */
export function setupStatusFor(
  rows: readonly VerifyProjectSetupRow[] | null,
  projectId: number,
): VerifyProjectSetupStatus {
  return rows?.find((r) => r.projectId === projectId)?.status ?? 'none';
}

/**
 * Whether this project's verification was configured, in part, by a run rather
 * than by a human (migration 105 `origin`).
 *
 * Defaults to `false` for a project the query never mentioned and for a pre-105
 * record — both are honestly unknown, and "a machine wrote this" is a claim that
 * must not be made on absent data.
 */
export function setupIsLaneDerived(
  rows: readonly VerifyProjectSetupRow[] | null,
  projectId: number,
): boolean {
  return rows?.find((r) => r.projectId === projectId)?.hasLaneDerivedRunbook === true;
}

/**
 * `'—'` when there were no attempts, else a whole-percent string.
 *
 * The em-dash is load-bearing: rendering `0%` for a project that has never run
 * a verification would report a catastrophe where there is merely no history.
 */
export function passRateText(stats: VerificationOutcomeStats): string {
  if (stats.passRate === null) return '—';
  return `${Math.round(stats.passRate * 100)}%`;
}

/** Compact duration ('—' when unknown, '840ms', '12s', '3m 04s'). */
export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * The failure histogram as `env 3 · deliverable 1` — zero-count classes are
 * OMITTED so the line stays scannable, and an all-zero histogram yields `''`
 * (the caller renders nothing rather than an empty label).
 */
export function failureHistogramText(stats: VerificationOutcomeStats): string {
  return Object.entries(stats.failures)
    .filter(([, count]) => count > 0)
    .map(([cls, count]) => `${cls} ${count}`)
    .join(' · ');
}

/** `'12 attempts'` / `'1 attempt'` / `'no attempts yet'`. */
export function attemptsText(stats: VerificationOutcomeStats): string {
  if (stats.attempts === 0) return 'no attempts yet';
  return `${stats.attempts} attempt${stats.attempts === 1 ? '' : 's'}`;
}

/**
 * The single most important line per modality: what its runbook state means for
 * whether verification will actually RUN.
 *
 * Absent or unproven ⇒ the §3.2 degrade gate skips every build/serve check for
 * this modality, which is why a project can show a clean queue while having
 * verified nothing. Said plainly, because the failure is silent by design.
 */
export function runbookLine(runbook: VerificationRunbookState | null): {
  text: string;
  tone: 'ok' | 'warn';
} {
  if (runbook === null) {
    return { text: 'no runbook — verification will skip', tone: 'warn' };
  }
  if (runbook.status === 'unproven-draft') {
    return { text: `runbook v${runbook.version} not proven — verification will skip`, tone: 'warn' };
  }
  return { text: `runbook v${runbook.version} proven`, tone: 'ok' };
}

/**
 * The capability line, or `null` when there is nothing worth saying.
 *
 * Reports only a suppression that is CURRENTLY IN FORCE. A tripped row whose
 * TTL lapsed (or whose host generation moved on) is inert — the next request
 * re-attempts freely — so surfacing it would tell the user a modality is
 * blocked when the engine has already moved past it.
 */
export function capabilityLine(
  capability: VerificationCapabilityState | null,
  now: number = Date.now(),
): string | null {
  if (capability === null) return null;
  if (!capability.suppressionActive) {
    // Not in force. Still worth showing the failure streak if one is building
    // toward the breaker, since that is a leading indicator rather than noise.
    return capability.consecutiveEnvFailures > 0
      ? `${capability.consecutiveEnvFailures} consecutive env failures`
      : null;
  }
  const verb = capability.status === 'unsupported' ? 'unsupported' : 'suppressed';
  const reason = capability.reason.trim();
  const until = capability.suppressedUntil === null ? null : Date.parse(capability.suppressedUntil);
  const retry =
    until !== null && Number.isFinite(until) && until > now
      ? ` · retries in ${durationText(until - now)}`
      : '';
  return `${verb}${reason.length > 0 ? `: ${reason}` : ''}${retry}`;
}

/**
 * Whether the project has ANY modality whose runbook is proven.
 *
 * Drives the setup CTA: with none, every build/serve verification on this
 * project degrades to a skip, so offering "set up verification" is the only
 * useful thing the panel can say.
 */
export function hasProvenRunbook(modalities: readonly VerificationModalityHealth[]): boolean {
  return modalities.some((m) => m.runbook?.status === 'proven');
}
