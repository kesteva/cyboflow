import { describe, it, expect } from 'vitest';
import { isClaudeLoginRequiredError } from '../claudeAuth';

describe('isClaudeLoginRequiredError', () => {
  const loginFailures: Array<[string, string]> = [
    ['CLI synthetic text', 'Not logged in · Please run /login'],
    ['is_error result copy', 'Error: Not logged in · Please run /login'],
    ['Sentry d1a52bbe shape', 'Failed to authenticate: OAuth session expired and could not be refreshed'],
    ['bare failed to authenticate', 'Failed to authenticate.'],
    ['oauth token expired', 'OAuth token has expired'],
    ['oauth token revoked', 'oauth token revoked'],
    ['session expired with /login advice', 'Session expired. Please run /login to sign in again.'],
    ['your session has expired', 'Your session has expired. Please reauthenticate.'],
    ['token refresh failed', ': Token refresh failed'],
    ['failed to refresh the oauth token', 'failed to refresh the OAuth token'],
    ['claude auth login advice', 'Run `claude auth login` to re-authenticate'],
  ];

  it.each(loginFailures)('offers a sign-in for %s', (_label, text) => {
    expect(isClaudeLoginRequiredError(text)).toBe(true);
  });

  const notLoginFailures: Array<[string, string]> = [
    ['env API key', 'Invalid API key · Fix external API key'],
    ['external auth token', 'Invalid auth token · Fix external auth token'],
    ['custom headers', 'Invalid ANTHROPIC_CUSTOM_HEADERS · Fix the environment'],
    ['env var named in prose', 'authentication failed: ANTHROPIC_API_KEY was rejected'],
    ['MCP transport chatter', 'MCP session expired (server no longer recognizes session ID), triggering reconnection'],
    ['usage limit', "You've reached your usage limit"],
    ['ordinary tool failure', 'Command failed: eslint src/'],
    ['generic api error', 'API Error: 500 {"type":"error","error":{"type":"server_error"}}'],
    ['prompt too long', 'Prompt is too long'],
  ];

  it.each(notLoginFailures)('does not offer a sign-in for %s', (_label, text) => {
    expect(isClaudeLoginRequiredError(text)).toBe(false);
  });

  it('is total over empty input', () => {
    expect(isClaudeLoginRequiredError(undefined)).toBe(false);
    expect(isClaudeLoginRequiredError(null)).toBe(false);
    expect(isClaudeLoginRequiredError('')).toBe(false);
  });
});
