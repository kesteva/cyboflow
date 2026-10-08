import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeCredentialDetection } from '../../../shared/types/onboarding';
import type { AppServices } from './types';

const presence = vi.hoisted(() => ({
  current: { found: true, source: 'keychain', account: null } as ClaudeCredentialDetection,
}));
vi.mock('../utils/claudeCredentials', () => ({
  detectClaudeCredentials: vi.fn(async () => presence.current),
}));
vi.mock('../utils/claudeBinaryDetection', () => ({
  detectClaudeBinary: vi.fn(async () => ({ found: false, path: null, version: null })),
}));

import { computeState, probeClaudeDetection } from './claudeDetection';

// The server-computed step-1 state mapping (shared/types/onboarding.ts):
//   credentials.found            -> 'detected'
//   !credentials.found && binary -> 'loggedOut'
//   neither                      -> 'missing'
describe('computeState (onboarding step-1 mapping)', () => {
  it('credentials found -> detected (regardless of binary)', () => {
    expect(computeState(true, true)).toBe('detected');
    expect(computeState(true, false)).toBe('detected');
  });

  it('no credentials but binary present -> loggedOut', () => {
    expect(computeState(false, true)).toBe('loggedOut');
  });

  it('neither -> missing', () => {
    expect(computeState(false, false)).toBe('missing');
  });
});

describe('probeClaudeDetection (CLI login cross-check)', () => {
  const services = { configManager: { getConfig: () => ({}) } } as unknown as AppServices;

  beforeEach(() => {
    presence.current = { found: true, source: 'keychain', account: null };
  });

  it('demotes a present-but-logged-out credential (CLI says loggedIn:false)', async () => {
    const result = await probeClaudeDetection(services, async () => ({ loggedIn: false, email: null, subscriptionType: null }));
    expect(result.state).toBe('missing');
    expect(result.credentials).toEqual({ found: false, source: null, account: null });
  });

  it('keeps the presence verdict when the CLI gives no answer (fail open)', async () => {
    const result = await probeClaudeDetection(services, async () => null);
    expect(result.state).toBe('detected');
    expect(result.credentials.source).toBe('keychain');
  });

  it('borrows the CLI account email when presence had no label', async () => {
    const result = await probeClaudeDetection(services, async () => ({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max' }));
    expect(result.state).toBe('detected');
    expect(result.credentials.account).toBe('me@example.com');
  });

  it('does not ask the CLI when no credential is present', async () => {
    presence.current = { found: false, source: null, account: null };
    const probe = vi.fn(async () => ({ loggedIn: true, email: null, subscriptionType: null }));
    const result = await probeClaudeDetection(services, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(result.state).toBe('missing');
  });
});
