/**
 * classifyVerificationFailure — the §3.1 conservative three-way failure
 * classifier (docs/proposals/verification-setup-flow.md §3.1, "Attribution
 * split — conservative by construction"). PURE: takes the already-collected
 * evidence (a preflight result, the runner's terminal status, the agent's
 * own report outcome, a few harness-detected booleans) and returns a
 * classification + the evidence backing it. No DB, no side effects — the
 * caller (the runner / verdict-delivery path) persists the verdict on the
 * request row (`failure_class` / `failure_evidence_json`, migration 095).
 *
 * WHY CONSERVATIVE (read before touching precedence): today a snapshot-mode
 * `build_failed`/`launch_failed` maps to `status:'failed'` — a merge-gate
 * FAIL charged to the lane's implement-retry budget, sending an agent to
 * "fix" working code because a port was taken. The naive fix — treat any
 * build/launch failure as environmental and `skipped` it — is WORSE than the
 * bug it fixes: `skipped` ADVANCES the lane at the merge gate
 * (mergeGateLaneAdvance.ts), so a genuinely broken deliverable
 * misclassified as `env` ships silently. A bad lockfile commit, a broken
 * package script, and a startup regression all present IDENTICALLY to a
 * squatted port in a log excerpt — model prose alone cannot tell them apart.
 * So the asymmetry is deliberate: a false `'env'` verdict is dangerous (it
 * advances the lane); a false `'ambiguous'` verdict is merely annoying (it
 * stays blocking, exactly like today's undifferentiated `'failed'`). When
 * the evidence does not clearly say `'env'`, this classifier picks
 * `'ambiguous'` — it never guesses toward the dangerous side.
 *
 * THE AUDITABLE INVARIANT: every `'env'` verdict this function returns
 * carries at least one {@link VerificationFailureEvidence} entry naming the
 * HARNESS source that produced it (`'preflight'` / `'port-probe'` /
 * `'instance-lock'` / `'runner'`) — never bare model judgment. `'deliverable'`
 * and `'ambiguous'` verdicts also carry evidence (sourced `'report'` /
 * `'runner'` respectively) so every classification is traceable, but only
 * the `'env'` evidence set is what the classifier's OWN precedence rule is
 * gated on.
 *
 * Standalone-typecheck invariant: imports ONLY shared types + this module's
 * sibling `preflight.ts` — no 'electron' / 'better-sqlite3' / 'fs' import.
 */
import type {
  VerificationFailureClass,
  VerificationFailureEvidence,
  VerificationReportOutcome,
  RequestStatus,
} from '../../../../shared/types/visualVerification';
import type { AgentPreflightResult } from './preflight';

/**
 * The classifier's inputs. Each field is the ALREADY-DETERMINED harness fact
 * (this module does no probing itself — `preflight.ts` and the runner
 * produce these):
 *   - `preflight`               — the pre-deploy check result (§3.5), or
 *     `null` when preflight never ran for this request (e.g. a legacy path,
 *     or a request that failed before preflight was reached).
 *   - `runnerStatus`            — the terminal `RequestStatus` the runner
 *     mapped this outcome to (`'failed'` / `'timeout'` / etc.) — carried for
 *     the ambiguous-case evidence detail, not itself a classification input
 *     beyond that (the classifier's rules key on `preflight` / `reportOutcome`
 *     / the booleans below, never on `runnerStatus` alone).
 *   - `reportOutcome`           — the agent's own `VerificationReportV1.outcome`
 *     when a report was produced, else `null` (no report reached — e.g. a
 *     timeout, a preflight skip, a spawn failure). Typed off the shared
 *     outcome union, so `'unverifiable'` / `'wrong_environment'` are accepted
 *     — and, being model-authored, can never by themselves reach `'env'` (only
 *     harness evidence does) nor `'deliverable'` (only a judged `'fail'` does):
 *     they fall to `'ambiguous'` like every other unattributed outcome.
 *   - `provisionMode`           — `'snapshot'` (the normal detached-worktree
 *     path, §5.2 pinned injection) or `'fallback'` (a degraded provisioning
 *     path — never eligible for `'deliverable'`, see below), or `null` when
 *     provisioning never started.
 *   - `instanceLockContention`  — Electron single-instance-lock contention
 *     detected by the runner (root cause (b), §1). A future-wired harness
 *     seam; always `false` today (no detector exists yet) until it lands.
 *   - `runbookMismatch`         — the §5.2 pinned-injection "runbook/sha
 *     mismatch" rejection. A phase-2 seam; always `false` today (no runbook
 *     contract exists yet) until it lands.
 */
export interface FailureClassifierInputs {
  preflight: AgentPreflightResult | null;
  runnerStatus: RequestStatus;
  reportOutcome: VerificationReportOutcome | null;
  provisionMode: 'snapshot' | 'fallback' | null;
  instanceLockContention: boolean;
  runbookMismatch: boolean;
}

/** The classifier's output: the verdict plus the evidence backing it (persisted verbatim on the request row). */
export interface ClassifiedFailure {
  failureClass: VerificationFailureClass;
  evidence: VerificationFailureEvidence[];
}

/**
 * Classify a terminal verification failure into `'env'` | `'deliverable'` |
 * `'ambiguous'`, in strict precedence order:
 *
 * 1. `'env'` — ANY of:
 *    - a supplied `preflight` result with at least one FAILED check (one
 *      evidence entry per failed check; `source: 'port-probe'` for the
 *      `'port-free'`/`'driver-port-free'` checks, `source: 'preflight'` for
 *      `'node'`/`'chromium'`/`'driver-cli'`), OR
 *    - `instanceLockContention` (one `source: 'instance-lock'` entry), OR
 *    - `runbookMismatch` (one `source: 'runner'` entry).
 *    All applicable evidence is collected (not just the first match) so a
 *    request that trips more than one signal at once carries the full
 *    audit trail.
 *
 * 2. `'deliverable'` — ONLY a JUDGED snapshot-mode failure:
 *    `provisionMode === 'snapshot' && reportOutcome === 'fail'` — behaviors
 *    were actually driven and a report was rendered with a genuine fail
 *    verdict. Deliberately EXCLUDES `'build_failed'`/`'launch_failed'`: per
 *    §3.1 verbatim, "a port squatter and a broken lockfile present
 *    identically in a log excerpt" — those fall through to `'ambiguous'`
 *    below (the `reportOutcome === 'fail'` guard excludes them by
 *    construction, no separate check needed). `provisionMode === 'fallback'`
 *    is NEVER `'deliverable'` (a degraded provisioning path cannot attest to
 *    the deliverable's own health).
 *
 * 3. `'ambiguous'` — everything else, INCLUDING every model-authored
 *    `'build_failed'`/`'launch_failed'` outcome with no harness
 *    corroboration. One `source: 'runner'` evidence entry names both
 *    `runnerStatus` and `reportOutcome` so the audit trail records what was
 *    actually observed. REMAINS BLOCKING downstream — this classifier never
 *    downgrades an ambiguous result to a skip.
 */
export function classifyVerificationFailure(inputs: FailureClassifierInputs): ClassifiedFailure {
  const { preflight, runnerStatus, reportOutcome, provisionMode, instanceLockContention, runbookMismatch } =
    inputs;

  const envEvidence: VerificationFailureEvidence[] = [];

  if (preflight !== null) {
    for (const check of preflight.checks) {
      if (check.ok) continue;
      const source: VerificationFailureEvidence['source'] =
        check.id === 'port-free' || check.id === 'driver-port-free' ? 'port-probe' : 'preflight';
      envEvidence.push({ source, check: check.id, detail: check.detail });
    }
  }

  if (instanceLockContention) {
    envEvidence.push({
      source: 'instance-lock',
      check: 'instance-lock',
      detail: 'Electron single-instance-lock contention detected by the runner',
    });
  }

  if (runbookMismatch) {
    envEvidence.push({
      source: 'runner',
      check: 'runbook-mismatch',
      detail: 'runbook/sha mismatch — the runner rejected execution against a stale or unresolved revision',
    });
  }

  if (envEvidence.length > 0) {
    return { failureClass: 'env', evidence: envEvidence };
  }

  // Only a JUDGED snapshot-mode fail is 'deliverable' — build_failed /
  // launch_failed (and anything under provisionMode 'fallback') falls
  // through to 'ambiguous' below.
  if (provisionMode === 'snapshot' && reportOutcome === 'fail') {
    return {
      failureClass: 'deliverable',
      evidence: [
        {
          source: 'report',
          check: 'report-outcome',
          detail: "snapshot-mode judged failure (reportOutcome: 'fail')",
        },
      ],
    };
  }

  return {
    failureClass: 'ambiguous',
    evidence: [
      {
        source: 'runner',
        check: 'runner-status',
        detail: `runnerStatus=${runnerStatus}, reportOutcome=${reportOutcome ?? 'null'}, provisionMode=${provisionMode ?? 'null'}`,
      },
    ],
  };
}
