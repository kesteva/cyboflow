import { describe, it, expect } from 'vitest';
import {
  formatClock,
  formatCountdown,
  isValidHandle,
  linkParts,
  pairingRemainingMs,
  slugifyHandle,
  utf8ByteLength,
  validateDisplayName,
} from '../agentsEnvFormat';
import { failureCopy } from '../agentsVocabulary';
import type { PersistentAgentsErrorCode } from '../../../../../shared/types/persistentAgents';

describe('formatClock', () => {
  it('shows only the clock on the same local day', () => {
    const now = new Date(2026, 9, 7, 18, 0);
    const iso = new Date(2026, 9, 7, 17, 44).toISOString();
    expect(formatClock(iso, now)).toBe('17:44');
  });

  it('prefixes the date on another day', () => {
    const now = new Date(2026, 9, 7, 18, 0);
    const iso = new Date(2026, 8, 28, 17, 44).toISOString();
    expect(formatClock(iso, now)).toMatch(/^\w{3} \d{1,2} \d{2}:\d{2}$/);
  });

  it('parses the unzoned SQLite shape as UTC', () => {
    const now = new Date('2026-10-06T23:00:00Z');
    const out = formatClock('2026-10-06 17:44:00', new Date('2026-10-06T17:50:00Z'));
    const expected = formatClock('2026-10-06T17:44:00Z', new Date('2026-10-06T17:50:00Z'));
    expect(out).toBe(expected);
    expect(out).not.toBe('');
    expect(now).toBeInstanceOf(Date);
  });

  it('returns an empty string for invalid input', () => {
    expect(formatClock('not a date')).toBe('');
  });
});

describe('linkParts', () => {
  it('extracts the domain of an https link', () => {
    const p = linkParts('https://github.com/a/b');
    expect(p.domain).toBe('github.com');
    expect(p.href).toBe('https://github.com/a/b');
  });

  it('keeps punycode for an internationalised host', () => {
    expect(linkParts('https://xn--pple-43d.com/x').domain).toBe('xn--pple-43d.com');
  });

  it('refuses javascript: and ftp: links', () => {
    expect(linkParts('javascript:alert(1)').href).toBeNull();
    expect(linkParts('javascript:alert(1)').domain).toBe('unsupported link');
    expect(linkParts('ftp://x').href).toBeNull();
  });

  it('truncates a very long display to 78 characters', () => {
    const url = `https://example.com/${'a'.repeat(180)}`;
    const p = linkParts(url);
    expect(p.display.length).toBe(78);
    expect(p.display.endsWith('…')).toBe(true);
  });
});

describe('countdown', () => {
  it('formats m:ss and clamps negatives', () => {
    expect(formatCountdown(581_000)).toBe('9:41');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-4_000)).toBe('0:00');
  });

  it('pairingRemainingMs clamps at zero and treats garbage as expired', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(pairingRemainingMs('2026-10-07T12:10:00Z', now)).toBe(600_000);
    expect(pairingRemainingMs('2026-10-07T11:00:00Z', now)).toBe(0);
    expect(pairingRemainingMs('garbage', now)).toBe(0);
  });
});

describe('utf8ByteLength', () => {
  it('counts bytes, not code units', () => {
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('abc')).toBe(3);
  });
});

describe('handles', () => {
  it('slugifies display names', () => {
    expect(slugifyHandle('My Dot!')).toBe('my-dot');
    expect(slugifyHandle('Ünïcode Agent')).toBe('unicode-agent');
    expect(slugifyHandle('')).toBe('agent');
    expect(slugifyHandle('!!!')).toBe('agent');
    const long = slugifyHandle(`${'ab '.repeat(30)}`);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith('-')).toBe(false);
  });

  it('validates handles', () => {
    expect(isValidHandle('my-dot')).toBe(true);
    expect(isValidHandle('a')).toBe(true);
    expect(isValidHandle('-bad')).toBe(false);
    expect(isValidHandle('bad-')).toBe(false);
    expect(isValidHandle('Upper')).toBe(false);
    expect(isValidHandle('a'.repeat(33))).toBe(false);
    expect(isValidHandle('')).toBe(false);
  });
});

describe('validateDisplayName', () => {
  it('flags empty, too long and control characters', () => {
    expect(validateDisplayName('   ')).toBe('Give the agent a name.');
    expect(validateDisplayName('x'.repeat(81))).toBe('Keep the name under 80 characters.');
    expect(validateDisplayName('a\u0007b')).toBe("The name can't contain control characters.");
    expect(validateDisplayName('x'.repeat(80))).toBeNull();
    expect(validateDisplayName('ok')).toBeNull();
  });
});

describe('failureCopy', () => {
  const fixed: Array<[PersistentAgentsErrorCode, string]> = [
    ['feature_disabled', 'Agents & Environments is turned off.'],
    ['not_found', 'This agent or connection no longer exists.'],
    ['too_large', 'Messages can be at most 64 KB.'],
    ['handle_taken', 'Another agent already uses this handle.'],
    ['no_connection', "This agent isn't connected."],
    ['connection_revoked', "This agent's connection was revoked. Use Reconnect to keep messaging in this thread."],
    ['agent_archived', 'This agent was archived.'],
    ['control_not_supported', "This agent can't be stopped from cyboflow."],
    ['pairing_not_supported', "This connection doesn't use a pairing code."],
    ['cloud_locked', 'Unlocking your cyboflow cloud sign-in. Try again in a moment.'],
    ['not_entitled', "The cyboflow Bridge is in private beta and isn't enabled for this account yet."],
    ['rate_limited', 'Too many requests to the Bridge. Wait a minute and try again.'],
    ['service_unavailable', "Couldn't reach the cyboflow Bridge. Check your connection and try again."],
    ['connection_limit', 'This account already has 20 Bridge connections. Disconnect one you no longer use first.'],
    ['connection_gone', 'This connection no longer exists on the Bridge. Close this and connect again.'],
    ['auth_rejected', 'The API key was rejected. Rotate it in Settings → Integrations.'],
    ['secrets_unavailable', "This computer's keychain isn't available, so cyboflow can't store this safely."],
    ['credential_undecryptable', "The stored key can't be read on this computer. Re-enter it."],
  ];

  it.each(fixed)('%s has its fixed copy regardless of the server message', (error, copy) => {
    expect(failureCopy({ error, message: 'server text that must not leak' }).copy).toBe(copy);
  });

  it.each(['swap_in_progress', 'no_swap_in_progress', 'connector_unavailable', 'connector_disabled', 'other_account', 'upgrade_required', 'conflict'] as const)(
    '%s shows the message verbatim',
    (error) => {
      expect(failureCopy({ error, message: 'Exact words.' }).copy).toBe('Exact words.');
    },
  );

  it('invalid_input goes under its field when it names one, else it is a banner', () => {
    expect(failureCopy({ error: 'invalid_input', message: 'Too short.', field: 'displayName' })).toMatchObject({ field: 'displayName', copy: 'Too short.' });
    expect(failureCopy({ error: 'invalid_input', message: 'Bad.', field: 'secret' }).field).toBeNull();
    expect(failureCopy({ error: 'invalid_input', message: 'Bad.' }).field).toBeNull();
  });

  it('handle_taken is a handle field error', () => {
    expect(failureCopy({ error: 'handle_taken', message: 'x' }).field).toBe('handle');
  });

  it('not_signed_in and device_revoked ask for a sign-in; cloud_locked asks for an unlock', () => {
    expect(failureCopy({ error: 'not_signed_in', message: 'x' }).needsSignIn).toBe(true);
    expect(failureCopy({ error: 'device_revoked', message: 'x' }).needsSignIn).toBe(true);
    expect(failureCopy({ error: 'cloud_locked', message: 'x' }).cloudLocked).toBe(true);
    expect(failureCopy({ error: 'rate_limited', message: 'x' }).needsSignIn).toBe(false);
  });

  it('unknown shows the message, else the generic copy', () => {
    expect(failureCopy({ error: 'unknown', message: 'Boom.' }).copy).toBe('Boom.');
    expect(failureCopy({ error: 'unknown', message: '  ' }).copy).toBe('Something went wrong. Try again.');
  });
});
