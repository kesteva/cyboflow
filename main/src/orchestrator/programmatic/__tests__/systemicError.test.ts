import { describe, it, expect } from 'vitest';
import {
  isSystemicStepError,
  parseLimitResetDelayMs,
  classifyErrorPattern,
  describeErrorShape,
  digestErrorSkeleton,
  unclassifiedErrorTags,
  isSystemicErrorClass,
} from '../systemicError';

describe('isSystemicStepError', () => {
  const positives: Array<[string, string]> = [
    ['epoch-suffixed usage limit', 'Claude AI usage limit reached|1751234567'],
    ["you've reached your usage limit", "You've reached your usage limit"],
    ["you've hit your usage limit", "You've hit your usage limit"],
    ['bare usage limit reached', 'usage limit reached'],
    ['Codex usage-limit provider code', 'Unhandled error. (usageLimitExceeded)'],
    ['5-hour window limit reached with reset clock', '5-hour limit reached ∙ resets 2:20pm'],
    ['7-day window limit reached', '7-day limit reached ∙ resets at 9am'],
    ['weekly limit hit phrasing', 'Weekly limit hit, try again later'],
    ['session limit reached phrasing', 'Session limit reached'],
    // Verb-first CLI wording — the exact text behind the 2026-09-05 sprint-2
    // cascade, bare and in the wrapper the programmatic plane actually sees.
    [
      'verb-first session limit (2026-09-05 cascade fixture)',
      "You've hit your session limit · resets 6pm (America/Los_Angeles)",
    ],
    [
      'verb-first session limit wrapped in the SDK result prefix',
      "Claude Code returned an error result: You've hit your session limit · resets 6pm (America/Los_Angeles)",
    ],
    [
      'agent terminated early on a rate-limited API error',
      'Agent terminated early due to an API error: Request was rate limited (error type rate_limit, HTTP 429 from api.anthropic.com)',
    ],
    ['verb-first weekly limit', 'You have reached your weekly limit'],
    ['verb-first 5-hour limit', 'You have exceeded your 5-hour limit'],
    ['rate limit phrase', 'rate limit exceeded'],
    ['rate_limit_error subtype', 'rate_limit_error: too many requests'],
    ['Codex rate-limit provider code', 'Unhandled error. (rateLimitExceeded)'],
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
    ['Codex authentication-required provider code', 'Unhandled error. (authenticationRequired)'],
    ['Codex auth-token-expired provider code', 'Unhandled error. (authTokenExpired)'],
    ['invalid api key', 'Invalid API Key provided'],
    ['401 unauthorized', '401 Unauthorized'],
    ['oauth token expired', 'OAuth token has expired'],
    // The CLI's own auth-expiry wordings, harvested from the shipped binary.
    // The first is digest d1a52bbe — the string behind the 0.2.8 cascade that
    // was classified `other` and therefore never parked as systemic.
    [
      'CLI OAuth session expiry (digest d1a52bbe)',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    ],
    ['bare failed-to-authenticate', 'Failed to authenticate'],
    ['failed to authenticate through the broker', 'Failed to authenticate through the broker: '],
    ['session expired login prompt', 'Session expired. Please run /login to sign in again.'],
    ['your session has expired', 'Your session has expired. Please reauthenticate.'],
    ['SSO session expired', 'SSO session expired. Run:'],
    ['token refresh failed', 'Token refresh failed'],
    [
      'real mid-run Anthropic authentication_error shape',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    ],
    ['authentication_error subtype alone', 'authentication_error: invalid credentials'],
    ['invalid x-api-key phrasing', 'invalid x-api-key'],
    [
      'real mid-run connection-closed fixture',
      'Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete.',
    ],
    ['ECONNRESET code', 'ECONNRESET'],
    ['socket hang up', 'socket hang up'],
    ['fetch failed wrapper', 'fetch failed'],
  ];

  it.each(positives)('matches: %s', (_label, error) => {
    expect(isSystemicStepError(error)).toBe(true);
  });

  const negatives: Array<[string, string | undefined]> = [
    ['undefined', undefined],
    ['empty string', ''],
    ['generic terminal fallback literal', 'The agent session ended with an error.'],
    ['bare usage limit configuration label', 'usage limit'],
    ['usage limitation configuration label', 'usage limitation'],
    ['no usage limit configured', 'no usage limit configured'],
    ['ordinary tool/build failure', 'Command failed: eslint . --max-warnings=0'],
    // The verb-first pattern's noun list is closed: a build tool's own limits
    // must never park a run.
    ['build tool file-size limit', 'Upload failed: hit the file size limit'],
    ['bundler chunk limit', 'exceeded the chunk size limit of 500 kB'],
    ['model not found (availability, not systemic)', 'model not found: claude-fable-5'],
    ['model 404', 'Request failed with status code 404: model not available'],
    ['controller execution bound text', 'Step exceeded the execution bound of 30 minutes'],
    ['error_max_turns-ish text', 'error_max_turns: the step hit its max turn allowance'],
    ['ordinary text mentioning authentication alone (no error/failed word)', 'Please check your authentication settings'],
    [
      'MCP transport session expiry reconnects in-process, not a login failure',
      'MCP session expired (server no longer recognizes session ID), triggering reconnection',
    ],
    [
      'timeout wording without the word "connection" (boundary: not systemic)',
      'request timed out',
    ],
    [
      'connection mentioned in unrelated file-edit prose, not a failure',
      'the agent edited connection-pool.ts and the tests failed',
    ],
  ];

  it.each(negatives)('does not match: %s', (_label, error) => {
    expect(isSystemicStepError(error)).toBe(false);
  });
});

describe('classifyErrorPattern', () => {
  const cases: Array<[string, string | undefined, string]> = [
    // Systemic patterns win first — the label is the SystemicPattern.name.
    ['usage limit', 'Claude AI usage limit reached|1751234567', 'usage-limit-reached'],
    ['bare usage-limit configuration label', 'usage limit', 'other'],
    ['usage limitation configuration label', 'usage limitation', 'other'],
    ['no usage limit configured', 'no usage limit configured', 'other'],
    [
      'verb-first session limit (2026-09-05 cascade fixture)',
      "You've hit your session limit · resets 6pm (America/Los_Angeles)",
      'limit-verb-first',
    ],
    [
      'verb-first session limit wrapped in the SDK result prefix',
      "Claude Code returned an error result: You've hit your session limit · resets 6pm (America/Los_Angeles)",
      'limit-verb-first',
    ],
    ['rate limit', 'rate_limit_error: too many requests', 'rate-limit'],
    ['http 429', 'Request failed with status code 429', 'http-429'],
    ['overloaded', 'overloaded_error: the server is overloaded', 'overloaded'],
    ['low credit', 'Your credit balance is too low to access the Claude API', 'billing-credit-balance'],
    ['auth 401', '401 Unauthorized', 'auth-401'],
    [
      'CLI OAuth session expiry',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'auth-failed-to-authenticate',
    ],
    ['session expired without the word auth', 'Session expired. Please run /login to sign in again.', 'auth-session-expired'],
    ['token refresh failed', 'Token refresh failed', 'auth-token-refresh-failed'],
    [
      'MCP transport session expiry is not an auth class',
      'MCP session expired (server no longer recognizes session ID), triggering reconnection',
      'other',
    ],
    ['connection closed (systemic net)', 'API Error: Connection closed mid-response.', 'net-connection-closed'],
    ['ECONNRESET', 'ECONNRESET', 'net-econn-codes'],
    // Systemic net beats the generic non-systemic 'timed-out' bucket.
    ['connection timed out is net, not generic timeout', 'connection timed out', 'net-connection-failure'],
    // Non-systemic buckets.
    ['stream closed', 'Error: Stream closed unexpectedly', 'stream-closed'],
    ['first-event watchdog', 'SDK produced no events within 30000ms', 'first-event-timeout'],
    ['transcript discovery timeout', 'interactive transcript discovery timed out', 'first-event-timeout'],
    ['execution bound', 'Step exceeded the execution bound of 30 minutes', 'max-turns-or-execution-bound'],
    ['max turns', 'error_max_turns: the step hit its max turn allowance', 'max-turns-or-execution-bound'],
    ['spawn ENOENT', 'spawn claude ENOENT', 'binary-missing'],
    ['cli not available', 'Claude Code (Interactive) not available: claude executable not found in PATH', 'binary-missing'],
    ['failed to spawn', 'Failed to spawn claude: node-pty error', 'spawn-failed'],
    ['nonzero exit', 'Interactive Claude exited with code 1', 'nonzero-exit'],
    ['generic timeout last', 'request timed out', 'timed-out'],
    // Structural-shape tier — splits what used to all be 'other'. Consulted only
    // after systemic + non-systemic miss, so systemic 429/401/529 still win.
    ['js TypeError', "TypeError: Cannot read properties of undefined (reading 'id')", 'js-error-type'],
    ['http 5xx', 'API Error: 503 Service Unavailable', 'http-5xx'],
    ['http 4xx via status code', 'Request failed with status code 400: bad request', 'http-4xx'],
    // model-availability 404 now buckets by its status class — still NOT binary-missing.
    ['model 404 is http-4xx, not binary-missing', 'Request failed with status code 404: model not available', 'http-4xx'],
    ['api error envelope without a status code', 'Anthropic error {"type":"invalid_request_error"}', 'api-error-type'],
    ['sdk error subtype', 'error_during_execution: the agent session ended', 'sdk-error-subtype'],
    ['aborted', 'AbortError: The operation was aborted', 'aborted'],
    // A genuine local build/lint failure has no recognizable shape — stays 'other'.
    ['generic build failure', 'Command failed: eslint . --max-warnings=0', 'other'],
    // A stray 3-digit number in prose must NOT be mislabeled as an HTTP status.
    ['stray number is not http', 'processed 512 files before failing', 'other'],
    ['undefined', undefined, 'unknown'],
    ['empty', '', 'unknown'],
  ];

  it.each(cases)('classifies %s', (_label, error, expected) => {
    expect(classifyErrorPattern(error)).toBe(expected);
  });

  it('only ever returns a low-cardinality label from the fixed set', () => {
    const known = new Set([
      // systemic names
      'usage-limit-reached', 'window-limit-reached-or-hit', 'limit-verb-first',
      'rate-limit', 'http-429',
      'overloaded', 'http-529', 'billing-credit-balance', 'billing-quota-exceeded',
      'auth-failed', 'auth-invalid-api-key', 'auth-401', 'auth-oauth-expired',
      'auth-authentication-error-type', 'auth-invalid-x-api-key',
      'auth-failed-to-authenticate', 'auth-session-expired', 'auth-token-refresh-failed',
      'net-connection-closed',
      'net-connection-failure', 'net-econn-codes', 'net-fetch-failed',
      // non-systemic buckets
      'stream-closed', 'first-event-timeout', 'max-turns-or-execution-bound',
      'binary-missing', 'spawn-failed', 'nonzero-exit', 'timed-out',
      // structural-shape tier + fallbacks
      'js-error-type', 'http-5xx', 'http-4xx', 'api-error-type', 'sdk-error-subtype',
      'aborted', 'other', 'unknown',
    ]);
    const samples = [undefined, '', 'anything at all', 'ECONNREFUSED', 'Stream closed', 'weird 500'];
    for (const s of samples) {
      expect(known.has(classifyErrorPattern(s))).toBe(true);
    }
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

  it('parses the reset clock off the verb-first session-limit fixture', () => {
    // The whole point of classifying this shape systemic is that the run can be
    // resumed automatically when the window rolls over.
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const error = "You've hit your session limit · resets 6pm (America/Los_Angeles)";
    const delay = parseLimitResetDelayMs(error, now.getTime());
    expect(delay).not.toBeNull();
    expect(delay as number).toBeGreaterThan(0);
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

describe('describeErrorShape', () => {
  it.each([
    ['undefined', undefined, 'empty'],
    ['whitespace only', '   \n  ', 'empty'],
    ['JSON object envelope', '{"type":"overloaded"}', 'json-envelope'],
    ['JSON array envelope', '[{"code":1}]', 'json-envelope'],
    ['thrown stack', 'Boom\n    at run (index.js:1:1)', 'stack-trace'],
    ['multiline prose', 'Boom\nsomething else went wrong', 'multiline'],
    ['short one-liner', 'Boom', 'one-line-short'],
    ['long one-liner', 'x'.repeat(121), 'one-line-long'],
  ])('classifies %s', (_label, input, expected) => {
    expect(describeErrorShape(input)).toBe(expected);
  });

  it('prefers the stack shape over the plain multiline shape', () => {
    // Both rules match a stack; the more specific one must win or every stack
    // collapses into the generic 'multiline' bucket.
    expect(describeErrorShape('Boom\nsecond line\n    at run (index.js:1:1)')).toBe('stack-trace');
  });
});

describe('digestErrorSkeleton', () => {
  it('is stable for the same message', () => {
    expect(digestErrorSkeleton('spawn failed for panel')).toBe(digestErrorSkeleton('spawn failed for panel'));
  });

  it('is 8 lowercase hex characters', () => {
    expect(digestErrorSkeleton('anything at all')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('ignores the varying parts: paths, ids, numbers, urls, quoted spans', () => {
    // Two occurrences of ONE failure on two machines must group together.
    const a = 'failed to read /Users/ada/dev/repo/src/a.ts for panel 4f2c1a9b7d (attempt 3) from https://api.example.com/v1 saying "no such file"';
    const b = 'failed to read /Users/bob/work/other/src/zzz.ts for panel 91ce77aa02 (attempt 11) from https://api.other.dev/v2 saying "still missing"';
    expect(digestErrorSkeleton(a)).toBe(digestErrorSkeleton(b));
  });

  it('separates genuinely different failures', () => {
    expect(digestErrorSkeleton('spawn ENOENT')).not.toBe(digestErrorSkeleton('connection reset by peer'));
  });

  it('ignores case and whitespace runs', () => {
    expect(digestErrorSkeleton('Spawn   Failed')).toBe(digestErrorSkeleton('spawn failed'));
  });

  it('digests an absent message without throwing', () => {
    expect(digestErrorSkeleton(undefined)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('unclassifiedErrorTags', () => {
  it('adds shape + digest for the unclassified buckets', () => {
    const tags = unclassifiedErrorTags('other', 'something we could not name');
    expect(tags).toEqual({ errorShape: 'one-line-short', errorDigest: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(Object.keys(unclassifiedErrorTags('unknown', undefined))).toEqual(['errorShape', 'errorDigest']);
  });

  it('adds nothing to an already-classified failure', () => {
    // errorClass already names the cause; extra tags would only inflate cardinality.
    expect(unclassifiedErrorTags('auth-failure', 'invalid api key')).toEqual({});
    expect(unclassifiedErrorTags('binary-missing', 'spawn claude ENOENT')).toEqual({});
  });

  it('tags exactly the classes classifyErrorPattern leaves unnamed', () => {
    const unnamed = 'the quick brown fox jumped';
    expect(classifyErrorPattern(unnamed)).toBe('other');
    expect(unclassifiedErrorTags(classifyErrorPattern(unnamed), unnamed)).not.toEqual({});
  });
});

describe("classifyErrorPattern: the SDK's own unspecified-result literal", () => {
  it("names claudeCodeManager's fallback literal instead of dropping it in 'other'", () => {
    // The fallback the SDK result path uses when the result event carries no
    // text — the largest contributor to the opaque 'other' bucket.
    expect(classifyErrorPattern('The agent session ended with an error.')).toBe('sdk-result-unspecified');
  });

  it('still lets a real cause in the same message win', () => {
    expect(classifyErrorPattern('The agent session ended with an error. usage limit reached')).toBe(
      'usage-limit-reached',
    );
  });
});

describe('isSystemicErrorClass', () => {
  it('agrees with isSystemicStepError through classifyErrorPattern', () => {
    // The telemetry chokepoint only ever sees the label; it must reach the same
    // verdict the park decision reached from the raw text.
    for (const text of [
      "You've hit your limit · resets 3am",
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'API Error: Connection closed mid-response.',
      'Request timed out',
      'The agent session ended with an error.',
      'Command failed: eslint src',
    ]) {
      expect(isSystemicErrorClass(classifyErrorPattern(text))).toBe(isSystemicStepError(text));
    }
  });

  it('is false for unclassified and missing labels', () => {
    expect(isSystemicErrorClass('other')).toBe(false);
    expect(isSystemicErrorClass('unknown')).toBe(false);
    expect(isSystemicErrorClass(undefined)).toBe(false);
  });
});
