/**
 * verifyRequestModel — the report-outcome guard and labels after the
 * runbook-optional widening (docs/proposals/runbook-optional-verification.md,
 * "Report-contract widening (F6)"). The guard reads the SHARED outcome list, so
 * a report whose outcome the harness accepts must never degrade to "no report"
 * in the Verify Queue — which is exactly what a hand-kept four-member guard did
 * the moment `unverifiable` / `wrong_environment` existed.
 */
import { describe, it, expect } from 'vitest';
import { VERIFICATION_REPORT_OUTCOMES } from '../../../../../shared/types/visualVerification';
import type { VerificationRequest } from '../../../hooks/useVerificationRequests';
import {
  REPORT_OUTCOME_LABEL,
  parseReport,
  parseReportOutcome,
  statusSummary,
} from '../verifyRequestModel';

function reportJson(outcome: string): string {
  return JSON.stringify({
    version: 1,
    behaviors: [],
    screenshots: [],
    outcome,
    confidence: 0.5,
    feedback: 'agent feedback',
    issues: [],
    diagnosis: 'could not be exercised',
  });
}

function row(over: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    id: 'vr-1',
    run_id: 'run-1',
    project_id: 1,
    status: 'low_confidence',
    verify_type: 'static-render-snapshot',
    deliverable_json: JSON.stringify({ intent: 'Renders the dashboard' }),
    chain_json: '["agent"]',
    current_backend: null,
    attempt: 0,
    verdict_json: null,
    error_message: null,
    enqueued_at: '2026-09-24T00:00:01.000Z',
    leased_at: null,
    ended_at: null,
    task_json: JSON.stringify({ version: 1, summary: 'Checks the dashboard', behaviors: [] }),
    report_json: null,
    delivery_state: null,
    snapshot_sha: null,
    enqueue_key: null,
    session_id: 'sess-1',
    session_name: 'green-brook',
    ...over,
  };
}

describe('the report-outcome guard', () => {
  it('accepts every shared outcome, including unverifiable and wrong_environment', () => {
    for (const outcome of VERIFICATION_REPORT_OUTCOMES) {
      expect(parseReportOutcome(reportJson(outcome))).toBe(outcome);
      expect(parseReport(reportJson(outcome))?.outcome).toBe(outcome);
    }
  });

  it('still rejects an unknown outcome and a malformed payload', () => {
    expect(parseReportOutcome(reportJson('maybe'))).toBeNull();
    expect(parseReport(reportJson('maybe'))).toBeNull();
    expect(parseReportOutcome('{not json')).toBeNull();
    expect(parseReportOutcome(null)).toBeNull();
  });
});

describe('REPORT_OUTCOME_LABEL', () => {
  it('labels every shared outcome with human copy, never a raw snake_case token', () => {
    for (const outcome of VERIFICATION_REPORT_OUTCOMES) {
      expect(REPORT_OUTCOME_LABEL[outcome]).not.toContain('_');
    }
    expect(REPORT_OUTCOME_LABEL.unverifiable).toBe('unverifiable');
    expect(REPORT_OUTCOME_LABEL.wrong_environment).toBe('wrong environment');
  });

  it('drives the card status line for the new outcomes', () => {
    expect(statusSummary(row({ report_json: reportJson('unverifiable') }), true)).toBe(
      'report outcome: unverifiable',
    );
    expect(statusSummary(row({ report_json: reportJson('wrong_environment') }), true)).toBe(
      'report outcome: wrong environment',
    );
    // Unchanged copy for the pre-widening outcomes.
    expect(statusSummary(row({ status: 'failed', report_json: reportJson('launch_failed') }), true)).toBe(
      'report outcome: launch failed',
    );
  });
});
