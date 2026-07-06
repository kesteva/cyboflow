import { describe, it, expect } from 'vitest';
import { isSystemicStepError, parseLimitResetDelayMs } from '../systemicError';

describe('isSystemicStepError', () => {
  const positives: Array<[string, string]> = [
    ['epoch-suffixed usage limit', 'Claude AI usage limit reached|1751234567'],
    ["you've reached your usage limit", "You've reached your usage limit"],
    ['bare usage limit reached', 'usage limit reached'],
    ['5-hour window limit reached with reset clock', '5-hour limit reached ∙ resets 2:20pm'],
    ['7-day window limit reached', '7-day limit reached ∙ resets at 9am'],
    ['weekly limit hit phrasing', 'Weekly limit hit, try again later'],
    ['session limit reached phrasing', 'Session limit reached'],
    ['rate limit phrase', 'rate limit exceeded'],
    ['rate_limit_error subtype', 'rate_limit_error: too many requests'],
    [
      'per-minute rate limit token message',
      'Number of request tokens has exceeded your per-minute rate limit',
    ],
    ['http 429', 'Request failed with status code 429'],
    ['overloaded_error subtype', 'overloaded_error: the server is overloaded'],
    ['Overloaded literal', 'Overloaded'],
    ['http 529', 'Request failed with status code 529'],
    ['low credit balance', 'Your credit balance is too low to access the Claude API'],
    ['quota exceeded', 'quota exceeded for this billing period'],
    ['authentication_failed', 'authentication_failed: invalid credentials'],
    ['invalid api key', 'Invalid API Key provided'],
    ['401 unauthorized', '401 Unauthorized'],
    ['oauth token expired', 'OAuth token has expired'],
    [
      'real mid-run Anthropic authentication_error shape',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ],
    ['authentication_error subtype alone', 'authentication_error: invalid credentials'],
    ['invalid x-api-key phrasing', 'invalid x-api-key'],
  ];

  it.each(positives)('matches: %s', (_label, error) => {
    expect(isSystemicStepError(error)).toBe(true);
  });

  const negatives: Array<[string, string | undefined]> = [
    ['undefined', undefined],
    ['empty string', ''],
    ['generic terminal fallback literal', 'The agent session ended with an error.'],
    ['ordinary tool/build failure', 'Command failed: eslint . --max-warnings=0'],
    ['model not found (availability, not systemic)', 'model not found: claude-fable-5'],
    ['model 404', 'Request failed with status code 404: model not available'],
    ['controller execution bound text', 'Step exceeded the execution bound of 30 minutes'],
    ['error_max_turns-ish text', 'error_max_turns: the step hit its max turn allowance'],
    ['ordinary text mentioning authentication alone (no error/failed word)', 'Please check your authentication settings'],
  ];

  it.each(negatives)('does not match: %s', (_label, error) => {
    expect(isSystemicStepError(error)).toBe(false);
  });
});

describe('parseLimitResetDelayMs', () => {
  const nowMs = Date.UTC(2026, 6, 6, 12, 0, 0); // 2026-07-06T12:00:00Z

  it('parses a 10-digit epoch-seconds suffix', () => {
    const epochSeconds = Math.floor(nowMs / 1000) + 3600; // +1h
    const error = `Claude AI usage limit reached|${epochSeconds}`;
    const delay = parseLimitResetDelayMs(error, nowMs);
    expect(delay).not.toBeNull();
    expect(delay).toBeCloseTo(3600 * 1000, -2);
  });

  it('parses a 13-digit epoch-ms suffix', () => {
    const epochMs = nowMs + 1800 * 1000; // +30min
    const error = `Claude AI usage limit reached|${epochMs}`;
    expect(parseLimitResetDelayMs(error, nowMs)).toBe(1800 * 1000);
  });

  it('returns null for an epoch suffix in the past', () => {
    const epochSeconds = Math.floor(nowMs / 1000) - 3600; // -1h
    const error = `Claude AI usage limit reached|${epochSeconds}`;
    expect(parseLimitResetDelayMs(error, nowMs)).toBeNull();
  });

  it('parses an am/pm wall-clock time later today', () => {
    // nowMs is 12:00 UTC on the local machine's date; use a local-time-based
    // fixture instead so the test is timezone-agnostic: build "now" and the
    // expected target both from local wall-clock components.
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const localNowMs = now.getTime();
    const error = '5-hour limit reached ∙ resets 2:30pm';
    const delay = parseLimitResetDelayMs(error, localNowMs);
    expect(delay).not.toBeNull();
    const expectedTarget = new Date(localNowMs);
    expectedTarget.setHours(14, 30, 0, 0);
    expect(delay).toBe(expectedTarget.getTime() - localNowMs);
  });

  it('rolls an already-past am/pm time to tomorrow', () => {
    const now = new Date();
    now.setHours(15, 0, 0, 0);
    const localNowMs = now.getTime();
    const error = 'limit reached ∙ resets 9:00am';
    const delay = parseLimitResetDelayMs(error, localNowMs);
    expect(delay).not.toBeNull();
    const expectedTarget = new Date(localNowMs);
    expectedTarget.setDate(expectedTarget.getDate() + 1);
    expectedTarget.setHours(9, 0, 0, 0);
    expect(delay).toBe(expectedTarget.getTime() - localNowMs);
  });

  it('parses "resets at <ISO-8601>"', () => {
    const error = 'limit reached, resets at 2026-07-06T13:00:00Z';
    expect(parseLimitResetDelayMs(error, nowMs)).toBe(3600 * 1000);
  });

  it('returns null when unparseable', () => {
    expect(parseLimitResetDelayMs('usage limit reached, try again later', nowMs)).toBeNull();
  });

  it('returns null when the computed delay exceeds 7 days', () => {
    const farFuture = nowMs + 8 * 24 * 60 * 60 * 1000;
    const error = `Claude AI usage limit reached|${Math.floor(farFuture / 1000)}`;
    expect(parseLimitResetDelayMs(error, nowMs)).toBeNull();
  });

  it('returns null for undefined error text', () => {
    expect(parseLimitResetDelayMs(undefined, nowMs)).toBeNull();
  });
});
