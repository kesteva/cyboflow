/**
 * agentProviderGuard — pure module-level behavior (the resolver plumbing and
 * the IPC message helper), with no main-side consumer wired in.
 *
 * The call-level installations of this guard (loadSdkQuery, AbstractCliManager,
 * relayOrSpawnPtyPanel) are main-only modules and stay tested alongside them at
 * main/src/services/__tests__/agentProviderGuard.test.ts — this file covers only
 * what shared/agents/agentProviderGuard.ts itself is responsible for:
 *   - the default resolver allows everything (unit/headless byte-identical);
 *   - a throwing resolver fails OPEN (a bad resolver must not become an outage);
 *   - the IPC propagation helper that recovers a disabled-provider message.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  AgentProviderDisabledError,
  agentProviderDisabledMessage,
  assertAgentProviderAllowed,
  isAgentProviderAllowed,
  isAgentProviderDisabled,
  setAgentProviderAccessResolver,
} from '../agentProviderGuard';
import { parseAgentProviderDisabled } from '../../types/agentRuntime';

afterEach(() => {
  // Never leak an installed resolver across files.
  setAgentProviderAccessResolver(null);
});

describe('agentProviderGuard', () => {
  it('allows every provider with no resolver installed (the inert default)', () => {
    expect(isAgentProviderAllowed('claude')).toBe(true);
    expect(isAgentProviderAllowed('codex')).toBe(true);
    expect(() => assertAgentProviderAllowed('codex', 'a turn')).not.toThrow();
  });

  it('refuses only the switched-off provider, and names it on the error', () => {
    setAgentProviderAccessResolver((p) => p !== 'codex');

    expect(isAgentProviderAllowed('claude')).toBe(true);
    expect(() => assertAgentProviderAllowed('codex', 'this chat turn')).toThrow(
      AgentProviderDisabledError,
    );
    try {
      assertAgentProviderAllowed('codex', 'this chat turn');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentProviderDisabledError);
      expect((error as AgentProviderDisabledError).provider).toBe('codex');
      // The wire form carries the machine code plus the user-facing sentence.
      expect((error as Error).message).toMatch(/^ERR_AGENT_PROVIDER_DISABLED\[codex\]:/);
      expect((error as Error).message).toMatch(/Codex is turned off/);
      expect((error as Error).message).toMatch(/this chat turn cannot run/);
      expect((error as Error).message).toMatch(/Settings → Integrations/);
    }
  });

  it('fails OPEN when the resolver itself throws (a bad resolver is not an outage)', () => {
    setAgentProviderAccessResolver(() => {
      throw new Error('config read blew up');
    });

    expect(isAgentProviderAllowed('claude')).toBe(true);
    expect(() => assertAgentProviderAllowed('claude', 'a turn')).not.toThrow();
  });

  it('re-reads the resolver on every call, so a toggle applies without a restart', () => {
    let codexOn = false;
    setAgentProviderAccessResolver((p) => (p === 'codex' ? codexOn : true));

    expect(isAgentProviderAllowed('codex')).toBe(false);
    codexOn = true;
    expect(isAgentProviderAllowed('codex')).toBe(true);
  });

  it('restores the allow-all default when the resolver is cleared', () => {
    setAgentProviderAccessResolver(() => false);
    expect(isAgentProviderAllowed('claude')).toBe(false);

    setAgentProviderAccessResolver(null);
    expect(isAgentProviderAllowed('claude')).toBe(true);
  });
});

describe('agentProviderDisabledMessage — the IPC propagation helper', () => {
  it('returns the user-facing message, parseable back into provider + prose', () => {
    const error = new AgentProviderDisabledError('claude', 'this chat turn');
    const message = agentProviderDisabledMessage(error);

    expect(message).not.toBeNull();
    // The renderer must be able to recover the provider and strip the code — this
    // is the contract that makes the composer's "Open Settings" action possible.
    expect(parseAgentProviderDisabled(message)).toMatchObject({ provider: 'claude' });
    expect(parseAgentProviderDisabled(message)?.message).toMatch(/Claude is turned off/);
  });

  it('recognizes an error that lost its prototype crossing a boundary', () => {
    const plain = new Error('ERR_AGENT_PROVIDER_DISABLED[codex]: Codex is turned off.');
    plain.name = 'AgentProviderDisabledError';
    expect(agentProviderDisabledMessage(plain)).toMatch(/Codex is turned off/);
  });

  it('returns null for an ordinary error, so generic copy still wins', () => {
    expect(agentProviderDisabledMessage(new Error('worktree locked'))).toBeNull();
    expect(agentProviderDisabledMessage('nope')).toBeNull();
    expect(agentProviderDisabledMessage(undefined)).toBeNull();
  });
});

describe('isAgentProviderDisabled', () => {
  it('matches a live refusal, scoped to a provider when one is given', () => {
    const codex = new AgentProviderDisabledError('codex', 'an eval juror');
    expect(isAgentProviderDisabled(codex)).toBe(true);
    expect(isAgentProviderDisabled(codex, 'codex')).toBe(true);
    expect(isAgentProviderDisabled(codex, 'claude')).toBe(false);
  });

  it('matches a boundary-crossed refusal by name, even when scoped', () => {
    const crossed = new Error('provider off');
    crossed.name = 'AgentProviderDisabledError';
    expect(isAgentProviderDisabled(crossed)).toBe(true);
    expect(isAgentProviderDisabled(crossed, 'codex')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAgentProviderDisabled(new Error('worktree locked'))).toBe(false);
    expect(isAgentProviderDisabled('AgentProviderDisabledError')).toBe(false);
    expect(isAgentProviderDisabled(undefined)).toBe(false);
  });
});
