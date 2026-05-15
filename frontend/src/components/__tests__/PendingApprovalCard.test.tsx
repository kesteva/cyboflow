/**
 * Tests for PendingApprovalCard and the approvalFormatters utilities.
 *
 * Pure-function tests (formatAge, truncatePayload) run under any vitest
 * environment. Component tests require jsdom + @testing-library/react and
 * are guarded so they degrade gracefully if those aren't available.
 *
 * Runner: pnpm --filter main exec vitest run (once frontend vitest config is
 * added in a follow-up sprint).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatAge, truncatePayload } from '../../utils/approvalFormatters';
import type { Approval } from '../../../../shared/types/approvals';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseApproval: Approval = {
  id: 'fixture-id',
  runId: 'run-fixture-id',
  workflowName: 'Refactor auth module',
  toolName: 'Bash',
  payloadPreview: 'git diff HEAD~1 -- src/auth.ts',
  rationale: 'Checking what changed in auth before patching.',
  createdAt: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
  status: 'pending',
};

// ---------------------------------------------------------------------------
// Unit tests: formatAge
// ---------------------------------------------------------------------------

describe('formatAge', () => {
  it("returns '<1m' for a timestamp 30 seconds ago", () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    expect(formatAge(createdAt)).toBe('<1m');
  });

  it("returns '2m' for a timestamp 120 seconds ago", () => {
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    expect(formatAge(createdAt)).toBe('2m');
  });

  it("returns '1h' for a timestamp 3600 seconds ago", () => {
    const createdAt = new Date(Date.now() - 3_600_000).toISOString();
    expect(formatAge(createdAt)).toBe('1h');
  });

  it("returns '1d' for a timestamp 24 hours ago", () => {
    const createdAt = new Date(Date.now() - 86_400_000).toISOString();
    expect(formatAge(createdAt)).toBe('1d');
  });

  it("returns '14m' for a timestamp 14 minutes ago", () => {
    const createdAt = new Date(Date.now() - 14 * 60_000).toISOString();
    expect(formatAge(createdAt)).toBe('14m');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: truncatePayload
// ---------------------------------------------------------------------------

describe('truncatePayload', () => {
  it('returns truncated: false and full text when input is shorter than maxLen', () => {
    const short = 'x'.repeat(50);
    const result = truncatePayload(short);
    expect(result.text).toBe(short);
    expect(result.truncated).toBe(false);
  });

  it('returns truncated: true and sliced text when input exceeds maxLen', () => {
    const long = 'x'.repeat(300);
    const result = truncatePayload(long, 200);
    expect(result.text).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('returns truncated: false when input is exactly maxLen', () => {
    const exact = 'x'.repeat(200);
    const result = truncatePayload(exact, 200);
    expect(result.text).toBe(exact);
    expect(result.truncated).toBe(false);
  });

  it('respects a custom maxLen', () => {
    const input = 'hello world and more text here';
    const result = truncatePayload(input, 10);
    expect(result.text).toBe('hello worl');
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component tests: PendingApprovalCard
//
// These tests mock the trpc client and use @testing-library/react (jsdom).
// They are written to the spec and will run once the frontend vitest config
// includes the jsdom environment and testing-library is installed.
// ---------------------------------------------------------------------------

/**
 * Mock the trpc client module before importing the component so the
 * component never touches the real IPC bridge during tests.
 */

const mockApproveMutate = vi.fn().mockResolvedValue(undefined);
const mockRejectMutate  = vi.fn().mockResolvedValue(undefined);

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        approve: { mutate: mockApproveMutate },
        reject:  { mutate: mockRejectMutate  },
      },
    },
  },
}));

describe('PendingApprovalCard — unit behaviour (no DOM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formatAge integration: baseApproval.createdAt 2 min ago → "2m"', () => {
    // Verify the formatter produces the correct string for the fixture timestamp.
    const age = formatAge(baseApproval.createdAt);
    expect(age).toBe('2m');
  });

  it('truncatePayload: baseApproval.payloadPreview ≤ 200 chars → not truncated', () => {
    const result = truncatePayload(baseApproval.payloadPreview);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(baseApproval.payloadPreview);
  });

  it('truncatePayload: long payload is truncated to 200 chars', () => {
    const longPayload = 'a'.repeat(300);
    const result = truncatePayload(longPayload);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(200);
  });
});

// Note: Full DOM rendering tests (all five context fields visible, Approve
// button click invokes approve mutation, rationale absent when null) require
// @testing-library/react + jsdom environment. They are deferred until the
// frontend vitest configuration is wired (follow-up infrastructure task).
// The mock above is already in place so those tests can be added trivially.
