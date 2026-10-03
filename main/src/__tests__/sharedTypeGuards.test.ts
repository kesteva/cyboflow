/**
 * Table-driven guards for the leaf shared modules that ride the IPC/tRPC wire.
 *
 * These helpers are the runtime narrowing points for values that arrive
 * from config / frontmatter / env / the DB (all `unknown` at the boundary). A
 * silent regression here (accepting a bad value, or rejecting a good one) does
 * not fail the build — it corrupts a run's substrate or mis-sorts a finding.
 * Pin the exact contracts.
 *
 * Covered:
 *   1. isCliSubstrate — valid union members, invalid strings, null/undefined/objects.
 *   2. isFindingPriority — the P0/P1/P2 domain, plus null (the "un-prioritized"
 *      sentinel that must NOT pass the guard).
 *   3. isAgentThreadSpawnId — the global-agent thread's synthetic
 *      `agent:<threadId>` spawn identity vs. a cyboflow workflow-run id, a
 *      Crystal session id, and the empty-remainder edge case.
 *   4. isBaselineArm / isQuickArm — the two experiment-arm sentinel guards
 *      (`'__baseline__'` / `'__quick__'`), pinned mutually exclusive so the
 *      deliberate `QUICK_ARM_SENTINEL` / `QUICK_WORKFLOW_NAME` namespace
 *      overload (see doc block above `BASELINE_VARIANT_SENTINEL`) never gets
 *      conflated with the baseline sentinel or a real `wfv_…` variant id.
 */
import { describe, it, expect } from 'vitest';
import { isCliSubstrate, DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';
import { isFindingPriority, FINDING_PRIORITIES } from '../../../shared/types/reviews';
import { isAgentThreadSpawnId, AGENT_THREAD_SPAWN_PREFIX } from '../../../shared/types/agentThread';
import {
  BASELINE_VARIANT_SENTINEL,
  isBaselineArm,
  QUICK_ARM_SENTINEL,
  isQuickArm,
} from '../../../shared/types/experiments';

describe('isCliSubstrate', () => {
  it.each([
    ['sdk', true],
    ['interactive', true],
  ] as const)('accepts the union member %s', (value, expected) => {
    expect(isCliSubstrate(value)).toBe(expected);
  });

  it.each([
    ['SDK'], // wrong case — the CHECK domain is case-sensitive
    ['Interactive'],
    ['pty'],
    ['claude'],
    [''],
    ['sdk '], // trailing space must not pass
  ])('rejects the non-member string %j', (value) => {
    expect(isCliSubstrate(value)).toBe(false);
  });

  it.each([
    [null],
    [undefined],
    [0],
    [1],
    [true],
    [{}],
    [['sdk']],
  ])('rejects the non-string value %j', (value) => {
    expect(isCliSubstrate(value)).toBe(false);
  });

  it('the DEFAULT_SUBSTRATE is itself a valid substrate (self-consistency)', () => {
    expect(isCliSubstrate(DEFAULT_SUBSTRATE)).toBe(true);
  });
});

describe('isFindingPriority', () => {
  it.each([...FINDING_PRIORITIES])('accepts the domain member %s', (value) => {
    expect(isFindingPriority(value)).toBe(true);
  });

  it.each([
    ['P3'], // one past the top of the domain
    ['p0'], // wrong case
    ['0'],
    ['high'],
    [''],
  ])('rejects the out-of-domain string %j', (value) => {
    expect(isFindingPriority(value)).toBe(false);
  });

  it('rejects null — the un-prioritized sentinel must NOT be treated as a priority', () => {
    // NULL priority is a legacy/un-triaged finding; consumers render it as an
    // explicit "unset" badge and sort it LAST. If the guard ever accepted null
    // it would fabricate a bogus label. Pin the rejection.
    expect(isFindingPriority(null)).toBe(false);
  });

  it.each([
    [undefined],
    [1],
    [{ priority: 'P0' }],
    [['P0']],
  ])('rejects the non-string value %j', (value) => {
    expect(isFindingPriority(value)).toBe(false);
  });
});

describe('isAgentThreadSpawnId', () => {
  it('accepts a real spawn identity — prefix plus a non-empty threadId', () => {
    expect(isAgentThreadSpawnId('agent:x')).toBe(true);
    expect(isAgentThreadSpawnId(`${AGENT_THREAD_SPAWN_PREFIX}550e8400-e29b-41d4-a716-446655440000`)).toBe(true);
  });

  it('rejects the bare prefix with an empty threadId remainder', () => {
    // 'agent:' alone must NOT count — an empty threadId is not a real thread.
    expect(isAgentThreadSpawnId('agent:')).toBe(false);
  });

  it('rejects a cyboflow workflow-run id (32-char no-dash hex)', () => {
    // The sibling isCyboflowRunId exemption's shape — must not cross-match.
    expect(isAgentThreadSpawnId('0d33e5082da8447eb1234567890abcd')).toBe(false);
  });

  it('rejects a Crystal session id (36-char dashed uuid)', () => {
    expect(isAgentThreadSpawnId('91e56989-0674-4e9a-9abc-1234567890ab')).toBe(false);
  });

  it('rejects null, undefined, and the empty string', () => {
    expect(isAgentThreadSpawnId(null)).toBe(false);
    expect(isAgentThreadSpawnId(undefined)).toBe(false);
    expect(isAgentThreadSpawnId('')).toBe(false);
  });

  it('is case-sensitive — a wrong-case prefix does not match', () => {
    expect(isAgentThreadSpawnId('Agent:x')).toBe(false);
    expect(isAgentThreadSpawnId('AGENT:x')).toBe(false);
  });
});

describe('experiment arm sentinels: isBaselineArm / isQuickArm', () => {
  it('sentinels carry their exact literal values', () => {
    // Pinned literals, not just "truthy" — the DB stores these strings verbatim
    // in experiments.variant_a_id / variant_b_id.
    expect(BASELINE_VARIANT_SENTINEL).toBe('__baseline__');
    expect(QUICK_ARM_SENTINEL).toBe('__quick__');
  });

  it('isBaselineArm accepts only the baseline sentinel', () => {
    expect(isBaselineArm(BASELINE_VARIANT_SENTINEL)).toBe(true);
    expect(isBaselineArm('wfv_abc123')).toBe(false);
  });

  it('isQuickArm accepts only the quick-arm sentinel', () => {
    expect(isQuickArm(QUICK_ARM_SENTINEL)).toBe(true);
    expect(isQuickArm('wfv_abc123')).toBe(false);
  });

  it('the two sentinels are mutually exclusive — neither guard conflates them', () => {
    // This is the invariant the doc comment calls out explicitly: QUICK_ARM_SENTINEL
    // and QUICK_WORKFLOW_NAME are a deliberate literal overload, but the two
    // experiment-arm guards themselves must never cross-match each other's sentinel.
    expect(isBaselineArm(QUICK_ARM_SENTINEL)).toBe(false);
    expect(isQuickArm(BASELINE_VARIANT_SENTINEL)).toBe(false);
  });
});
