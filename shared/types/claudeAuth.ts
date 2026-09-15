/**
 * Claude sign-in recovery — shared contract between the main-process login
 * runner (`main/src/services/claudeAuthLogin.ts`, served over the
 * `cyboflow.claudeAuth` tRPC router) and the chat's sign-in card.
 *
 * WHY THIS EXISTS
 * ---------------
 * The onboarding credential probe (shared/types/onboarding.ts) can only see
 * that a Claude Code login EXISTS — a Keychain entry, a credentials file — not
 * whether it still works. An OAuth session that expired and could not be
 * refreshed passes every preflight and then fails the first turn, which used to
 * land in the chat as a bare "Session Error" with the CLI's own "run /login"
 * advice — a slash command Cyboflow's SDK substrate has no way to run. This
 * contract is the in-app equivalent: detect that shape, and drive the bundled
 * CLI's `claude auth login` (a browser OAuth flow that hands back a code to
 * paste) without leaving the app.
 *
 * Only LOGIN failures qualify. A rejected `ANTHROPIC_API_KEY` / external auth
 * token is the same "authentication failed" family to the API but a sign-in
 * cannot fix it, so {@link isClaudeLoginRequiredError} deliberately leaves
 * those out — the plain error row is the honest surface there.
 */

/**
 * Lifecycle of one `claude auth login` attempt.
 *   idle            — nothing running (initial, after cancel, or after the
 *                     terminal states are acknowledged by a new start).
 *   starting        — the CLI is spawning; no URL yet.
 *   awaiting-code   — the browser was opened (URL known); the CLI is waiting
 *                     for the authorization code the browser hands the user.
 *   verifying       — a code was submitted; waiting for the CLI to finish.
 *   succeeded       — the CLI reported a successful login; `account` carries
 *                     the post-login status probe when it answered.
 *   failed          — the CLI exited without logging in; `error` says why.
 */
export type ClaudeLoginPhase =
  | 'idle'
  | 'starting'
  | 'awaiting-code'
  | 'verifying'
  | 'succeeded'
  | 'failed';

export interface ClaudeLoginState {
  phase: ClaudeLoginPhase;
  /**
   * The OAuth authorization URL the CLI printed, for the "open the browser
   * again" affordance. The CLI opens it itself when it can. null until seen.
   */
  authUrl: string | null;
  /** Human-readable failure reason; only set in 'failed'. */
  error: string | null;
  /** Post-login account probe (`claude auth status`); only set in 'succeeded'. */
  account: ClaudeAuthAccount | null;
}

/** The non-secret slice of `claude auth status --json` the UI shows. */
export interface ClaudeAuthAccount {
  loggedIn: boolean;
  email: string | null;
  /** e.g. "max", "pro", "team"; null when the CLI omits it. */
  subscriptionType: string | null;
}

export const IDLE_CLAUDE_LOGIN_STATE: ClaudeLoginState = {
  phase: 'idle',
  authUrl: null,
  error: null,
  account: null,
};

/**
 * The SDK's structured cause on a synthetic assistant message
 * (`SDKAssistantMessage.error`) when an API call was refused for want of a
 * usable login. The projection copies it onto `metadata.assistantError`; the
 * card trusts it ahead of any text match.
 */
export const CLAUDE_AUTHENTICATION_FAILED = 'authentication_failed';

/**
 * Text shapes the CLI / SDK surface when a LOGIN (not an API key) is no longer
 * usable. Harvested from the shipped binary and from Sentry (digest d1a52bbe):
 *   - "Not logged in · Please run /login"        (synthetic assistant text +
 *                                                  the is_error result)
 *   - "Failed to authenticate: OAuth session expired and could not be refreshed"
 *   - "OAuth token has expired" / "OAuth token expired|revoked"
 *   - "Session expired. Please run /login to sign in again."
 *   - "Your session has expired. Please reauthenticate."
 *   - "Token refresh failed" / "failed to refresh the OAuth token"
 *   - "Please run /login" / "run `claude auth login`" (any advice to log in)
 *
 * Kept narrower than systemicError.ts's auth family on purpose: that
 * classifier decides whether to PARK a flow run (where a false positive costs
 * a recoverable pause), this one decides whether to offer a sign-in (where a
 * false positive sends the user through an OAuth dance that cannot help).
 * The `(?<!mcp )` lookbehind mirrors systemicError's: the CLI's MCP transport
 * chatter ("MCP session expired … triggering reconnection") is not a login.
 */
const CLAUDE_LOGIN_REQUIRED_PATTERNS: readonly RegExp[] = [
  /\bnot logged in\b/i,
  /\brun\s+`?\/login\b/i,
  /\bclaude auth login\b/i,
  /failed to (?:re-?)?authenticate/i,
  /oauth[\s_-]*(?:session|token)(?:[\s_-]*has)?[\s_-]*(?:expired|revoked)/i,
  /(?<!mcp )\bsession (?:has )?expired\b/i,
  /token refresh failed|failed to refresh (?:the )?(?:oauth |access |auth )?token/i,
  /\bplease (?:re-?)?authenticate\b/i,
];

/**
 * Shapes that look like the family above but name a credential a sign-in
 * cannot replace — an env API key, an external bearer token, a custom header.
 * Checked FIRST so "Invalid auth token · Fix external auth token" never
 * offers the OAuth flow.
 */
const CLAUDE_EXTERNAL_CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /invalid[\s_-]*(?:x[\s_-]*)?api[\s_-]*key/i,
  /invalid auth token/i,
  /external (?:api key|auth token)/i,
  /ANTHROPIC_(?:API_KEY|AUTH_TOKEN|CUSTOM_HEADERS)/,
];

/**
 * True when `text` is a Claude LOGIN failure a fresh `claude auth login` can
 * fix. Pure and total: null/undefined/empty → false.
 */
export function isClaudeLoginRequiredError(text: string | null | undefined): boolean {
  if (!text) return false;
  if (CLAUDE_EXTERNAL_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return CLAUDE_LOGIN_REQUIRED_PATTERNS.some((pattern) => pattern.test(text));
}
