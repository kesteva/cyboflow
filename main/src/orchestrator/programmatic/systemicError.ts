/**
 * systemicError.ts — pure classifier for programmatic-plane step failures.
 *
 * In the programmatic execution plane a failed step's `error` string is EXACTLY
 * one of:
 *   - the raw SDK `result` event's `.result` string, thrown as
 *     SdkSessionTerminalError by claudeCodeManager (or its fallback literal
 *     'The agent session ended with an error.' when the SDK omits `result`), or
 *   - a thrown SDK/spawn error's `.message` (auth failure, network error,
 *     process spawn failure).
 *
 * A SYSTEMIC error is an environment-level condition that no retry of the step
 * itself can fix — it can only clear externally (a usage-limit window rolling
 * over, a rate limit cooling down, an operator fixing credentials). The
 * programmatic controller uses {@link isSystemicStepError} to decide whether to
 * PARK the run (rather than retry-and-fail it) and {@link parseLimitResetDelayMs}
 * to decide how long to wait before an automatic resume attempt.
 *
 * Deliberately pure: no I/O, no `Date.now()`, no service imports — this file
 * must stay importable from anywhere in main/src/orchestrator/ (including
 * programmatic/) under the standalone-typecheck invariant (no `electron`,
 * `better-sqlite3`, or concrete main/src/services/* imports).
 */

/**
 * One named, documented systemic-error signal. Kept as a list (rather than one
 * giant regex) so new shapes can be appended without touching the matching
 * logic, and so a future debug log can report WHICH pattern fired.
 */
interface SystemicPattern {
  /** Short label for logs/debugging — not used for matching. */
  name: string;
  /** Case-insensitive regex tested against the raw error string. */
  pattern: RegExp;
}

/**
 * Every regex here is deliberately narrow enough to avoid tripping on ordinary
 * tool/build failures ("Command failed: eslint ...") or on the controller's own
 * "exceeded the execution bound" / `error_max_turns` text, which are NOT
 * systemic (they're either an environment-agnostic caller decision or the
 * recoverable-turn-cap case already filtered out upstream by
 * terminalResultError). Model-availability errors ("model not found", 404) are
 * also excluded — see isModelUnavailableError in modelAvailabilityService.ts
 * for that separate, non-systemic classifier.
 */
const SYSTEMIC_PATTERNS: SystemicPattern[] = [
  {
    // "Claude AI usage limit reached|1751234567" (epoch-suffixed subscription
    // limit), "reached/hit your usage limit" phrasing, and Codex's
    // `usageLimitExceeded` provider code. The terminal condition is required:
    // incidental configuration prose such as "no usage limit configured" must
    // not park a run.
    name: 'usage-limit-reached',
    pattern: /usage[\s_-]*limit[\s_-]*(?:reached|hit|exceeded|exhausted)|(?:reached|hit)(?: (?:your|the))? usage[\s_-]*limit/i,
  },
  {
    // "5-hour limit reached ∙ resets 2:20pm", 7-day/weekly/session variants,
    // and the "limit hit" phrasing some CLI builds use instead of "reached".
    name: 'window-limit-reached-or-hit',
    pattern: /\blimit\s+(reached|hit)\b/i,
  },
  {
    // VERB-FIRST wording, where the noun follows the verb and therefore misses
    // both patterns above: "You've hit your session limit · resets 6pm
    // (America/Los_Angeles)" — harvested verbatim from the 2026-09-05 sprint-2
    // cascade, where 24 lanes failed on it and not one was parked as systemic.
    // The noun list is CLOSED so an ordinary build failure ("hit the file size
    // limit", "exceeded the line limit") never parks a run.
    name: 'limit-verb-first',
    pattern:
      /\b(?:hit|reached|exceeded)\s+(?:your|the|a)?\s*(?:session|usage|weekly|daily|monthly|plan|subscription|token|spend(?:ing)?|\d+[- ]?(?:hour|day|minute))\s+limit\b/i,
  },
  {
    // Also covers Codex's `rateLimitExceeded` provider code.
    name: 'rate-limit',
    pattern: /rate[\s_-]*limit(?:[\s_-]*(?:reached|hit|exceeded|exhausted))?/i,
  },
  {
    name: 'http-429',
    pattern: /\b429\b/,
  },
  {
    name: 'overloaded',
    pattern: /overloaded(_error)?/i,
  },
  {
    name: 'http-529',
    pattern: /\b529\b/,
  },
  {
    name: 'billing-credit-balance',
    pattern: /credit balance is too low/i,
  },
  {
    name: 'billing-quota-exceeded',
    pattern: /quota exceeded/i,
  },
  {
    name: 'auth-failed',
    // Includes provider codes such as `authenticationRequired` and
    // `authTokenExpired`, whether camelCase, snake_case, or kebab-case.
    pattern: /auth(?:entication)?[\s_-]*(?:failed|required|expired|invalid)|auth[\s_-]*token[\s_-]*expired/i,
  },
  {
    name: 'auth-invalid-api-key',
    pattern: /invalid[\s_-]*api[\s_-]*key/i,
  },
  {
    name: 'auth-401',
    pattern: /\b401\b.*unauthorized|unauthorized.*\b401\b|\b401 unauthorized\b/i,
  },
  {
    name: 'auth-oauth-expired',
    pattern: /oauth[\s_-]*token(?:[\s_-]*has)?[\s_-]*expired/i,
  },
  {
    // The verb comes FIRST in the CLI's own wording, so `auth-failed` above —
    // which wants the failure word AFTER "auth" — misses every one of these.
    // Harvested verbatim from the shipped CLI binary: "Failed to authenticate",
    // "Failed to authenticate. ", "Failed to authenticate through the broker: "
    // and "Failed to authenticate: OAuth session expired and could not be
    // refreshed" (digest d1a52bbe — 52 events in one user's 8-minute cascade on
    // 0.2.8, every one of them classified `other`, so the run was never parked
    // as systemic and the monitor was asked to triage a dead login).
    name: 'auth-failed-to-authenticate',
    pattern: /failed to (?:re-?)?authenticate/i,
  },
  {
    // The expiry family the CLI surfaces when a login is no longer usable:
    // "OAuth session expired and could not be refreshed", "Session expired.
    // Please run /login to sign in again.", "Your session has expired. Please
    // reauthenticate.", "SSO session expired. Run: …". `auth-oauth-expired`
    // above only knows the word "token".
    //
    // The lookbehind excludes the CLI's MCP transport chatter ("MCP session
    // expired (server no longer recognizes session ID), triggering
    // reconnection"), which reconnects in-process and is not a login failure.
    name: 'auth-session-expired',
    pattern: /(?<!mcp )\bsession (?:has )?expired\b/i,
  },
  {
    // ": Token refresh failed" / "Design token refresh failed" — a refresh that
    // cannot complete is the same terminal auth condition as an expired session,
    // one step earlier.
    name: 'auth-token-refresh-failed',
    pattern: /token refresh failed|failed to refresh (?:the )?(?:oauth |access |auth )?token/i,
  },
  {
    // The real mid-run Anthropic shape: `API Error: 401
    // {"type":"error","error":{"type":"authentication_error","message":"..."}}`
    // — neither 'authentication failed' nor a bare '401' (no 'unauthorized' word)
    // matches the patterns above.
    name: 'auth-authentication-error-type',
    pattern: /authentication[\s_-]*error/i,
  },
  {
    name: 'auth-invalid-x-api-key',
    pattern: /invalid[\s_-]*x[\s_-]*api[\s_-]*key/i,
  },
  // Transport-level failures below: a dropped/reset/timed-out connection is an
  // environment-level condition exactly like overload or a rate limit — the
  // step itself did nothing wrong, the network under it did. Asymmetric cost
  // here justifies leaning inclusive: a FALSE POSITIVE only costs a recoverable
  // PARK (a human can always resume-or-give-up from the review queue), while a
  // FALSE NEGATIVE costs a hard lane failure that skips the run's closing
  // verification stages entirely (the defect this file exists to prevent).
  {
    // The exact live fixture: "API Error: Connection closed mid-response. The
    // response above may be incomplete."
    name: 'net-connection-closed',
    pattern: /connection closed/i,
  },
  {
    // "connection error" / "connection reset" / "connection refused" /
    // "connection timed out" (also "connection timedout" / "connection
    // timed-out"). Requires the literal word "connection" immediately before
    // the failure word so ordinary prose like "edited connection-pool.ts"
    // never matches.
    name: 'net-connection-failure',
    pattern: /connection (error|reset|refused|timed?[ -]?out)/i,
  },
  {
    // Node/libuv error codes surfaced verbatim in thrown Error messages:
    // ECONNRESET, ECONNREFUSED, ECONNABORTED, ETIMEDOUT, and the classic
    // "socket hang up" (Node's http client's own connection-drop message).
    name: 'net-econn-codes',
    pattern: /econn(reset|refused|aborted)|etimedout|socket hang ?up/i,
  },
  {
    // undici/fetch's own wrapper message for any underlying transport failure
    // (`TypeError: fetch failed`, cause chain omitted from the surfaced text).
    name: 'net-fetch-failed',
    pattern: /fetch failed/i,
  },
];

/**
 * COARSE STRUCTURAL-SHAPE tier — consulted ONLY after both the systemic and the
 * non-systemic cause buckets miss, to split what would otherwise all collapse
 * into the opaque `'other'` label (the single biggest bucket in production error
 * telemetry — CYBOFLOW-APP-C). Each pattern matches STRUCTURE — an HTTP status
 * class, a JS error constructor, an SDK/API fixed-vocabulary marker — never user
 * content, and (like every tier here) emits a FIXED label, so nothing
 * user-derived ever rides in the tag even on a false match. Ordered so a more
 * actionable shape (a status code) wins over a generic envelope. HTTP patterns
 * anchor on an explicit status context ("API Error:" / "HTTP" / "status code")
 * so a stray 3-digit number in prose never mislabels.
 */
const SHAPE_PATTERNS: SystemicPattern[] = [
  {
    // A recognized JS error constructor prefixing the message — an orchestrator-
    // side programming fault surfacing as the run's failure text.
    name: 'js-error-type',
    pattern: /^\s*(?:Type|Range|Reference|Syntax|Eval|URI)Error\b/,
  },
  {
    // 5xx server-side status not already claimed by the systemic 529 pattern
    // ("API Error: 500", "status code 503", "HTTP 502").
    name: 'http-5xx',
    pattern: /(?:api error|http|status(?:\s*code)?)[:\s]+5\d\d\b/i,
  },
  {
    // 4xx client-side status not already claimed by systemic 429 / 401
    // (e.g. 400 bad request, 403 forbidden, 404 not found).
    name: 'http-4xx',
    pattern: /(?:api error|http|status(?:\s*code)?)[:\s]+4\d\d\b/i,
  },
  {
    // Anthropic/undici API error envelope surfaced verbatim without a status
    // code: `{"type":"invalid_request_error", ...}` — a fixed API vocabulary; the
    // `_error` suffix keeps it off ordinary prose.
    name: 'api-error-type',
    pattern: /"type"\s*:\s*"[a-z]+(?:_[a-z]+)*_error"/i,
  },
  {
    // SDK result subtypes surfaced verbatim (`error_during_execution`, …). The
    // recoverable `error_max_turns` is already claimed by the non-systemic tier.
    name: 'sdk-error-subtype',
    pattern: /\berror_[a-z]+(?:_[a-z]+)*\b/,
  },
  {
    // claudeCodeManager's own fallback literal, used when the SDK's `result`
    // event reports an error but carries no `.result` text. It named no cause,
    // so it fell all the way through to 'other' and made that bucket
    // permanently unactionable (CYBOFLOW-APP-B). Naming it here does not
    // explain the failure — it separates "the SDK told us nothing" from "we
    // failed to classify what the SDK told us", which are different bugs.
    name: 'sdk-result-unspecified',
    pattern: /agent session ended with an error/i,
  },
  {
    // An explicit abort/cancel that reached the failure path.
    name: 'aborted',
    pattern: /\bAbortError\b|\baborted\b/i,
  },
];

/**
 * Whether a step's error text represents a SYSTEMIC (environment-level)
 * condition — one that retrying the step itself cannot fix. Case-insensitive;
 * `undefined`/empty input is never systemic.
 */
export function isSystemicStepError(error: string | undefined): boolean {
  if (!error) return false;
  return SYSTEMIC_PATTERNS.some(({ pattern }) => pattern.test(error));
}

const SYSTEMIC_CLASS_NAMES: ReadonlySet<string> = new Set(SYSTEMIC_PATTERNS.map(({ name }) => name));

/**
 * Whether an `errorClass` label (a {@link classifyErrorPattern} return value)
 * names a SYSTEMIC condition. The label-side twin of
 * {@link isSystemicStepError}, for callers that hold only the bounded tag and
 * never the raw error text — the telemetry chokepoint, which must not see it.
 */
export function isSystemicErrorClass(errorClass: string | undefined): boolean {
  return errorClass !== undefined && SYSTEMIC_CLASS_NAMES.has(errorClass);
}

/**
 * NON-systemic failure buckets — recoverable/local conditions that are NOT
 * environment-level (so they never trigger a systemic park) but are still worth
 * naming for telemetry grouping. Ordered most-specific first. Only consulted by
 * {@link classifyErrorPattern} AFTER the systemic patterns, so a systemic match
 * always wins (e.g. "connection timed out" classifies as net-connection-failure,
 * not the generic 'timed-out' bucket here).
 */
const NONSYSTEMIC_PATTERNS: SystemicPattern[] = [
  {
    // The intermittent SDK control-channel drop (see the Stream-closed gate
    // false-complete bug). Distinct from net 'connection closed'.
    name: 'stream-closed',
    pattern: /stream closed/i,
  },
  {
    // The report-only SDK first-event watchdog message ("SDK produced no events
    // ..."), and the interactive transcript-discovery timeout.
    name: 'first-event-timeout',
    pattern: /no events|first[\s-]?event|transcript discovery/i,
  },
  {
    // The recoverable turn cap and the controller's own execution-bound backstop.
    name: 'max-turns-or-execution-bound',
    pattern: /max[\s_-]?turns|maximum (?:number of )?turns|execution bound/i,
  },
  {
    // Missing/unresolvable CLI binary — claude not on PATH, spawn ENOENT, the
    // interactive "... CLI not available" guard. Deliberately NOT a bare "not
    // available" (that would swallow model-availability 404s) — anchors on the
    // executable/CLI/PATH context.
    name: 'binary-missing',
    pattern: /\benoent\b|executable not found|not found in (?:\$?path)|cli not available|no such file/i,
  },
  {
    // Spawn/process failures that are not ENOENT (covered above).
    name: 'spawn-failed',
    pattern: /failed to spawn|spawn \w+ e[a-z]+|is not recognized/i,
  },
  {
    // A child process exited non-zero (interactive REPL / tool subprocess).
    name: 'nonzero-exit',
    pattern: /exited with code|non-?zero exit|exit code \d/i,
  },
  {
    // Generic timeout LAST — a catch-all for any remaining "timed out" text not
    // already claimed by a systemic net pattern or first-event-timeout above.
    name: 'timed-out',
    pattern: /timed?[\s-]?out|timeout/i,
  },
];

/**
 * Classify an error string into ONE low-cardinality, non-PII label for use as a
 * Sentry `errorClass` tag. Tries the systemic patterns first (usage/rate limit,
 * auth, billing, network — the environment-level causes), then the non-systemic
 * cause buckets, then a coarse structural-shape tier (HTTP status class, JS error
 * constructor, API/SDK marker) to split the otherwise-opaque `'other'` bucket,
 * then falls back to a fixed sentinel. The return value is always one of a small
 * fixed set of names (never free text), so it is safe as a tag.
 *
 * Pure — no I/O, no clock — so it stays importable from anywhere under the
 * standalone-typecheck invariant, including the impure boot seam and services.
 */
export function classifyErrorPattern(error: string | undefined): string {
  if (!error) return 'unknown';
  const systemic = SYSTEMIC_PATTERNS.find(({ pattern }) => pattern.test(error));
  if (systemic) return systemic.name;
  const nonSystemic = NONSYSTEMIC_PATTERNS.find(({ pattern }) => pattern.test(error));
  if (nonSystemic) return nonSystemic.name;
  const shape = SHAPE_PATTERNS.find(({ pattern }) => pattern.test(error));
  if (shape) return shape.name;
  return 'other';
}

/**
 * The classes that name no cause. An event tagged with one of these tells a
 * triager nothing beyond "it failed", which is why the fingerprint tags below
 * exist and why they are attached for exactly these two values.
 */
const UNCLASSIFIED_CLASSES: ReadonlySet<string> = new Set(['other', 'unknown']);

/**
 * Fixed vocabulary for {@link describeErrorShape} — every return value appears
 * here, so the tag stays low-cardinality by construction.
 */
type ErrorShape =
  | 'empty'
  | 'json-envelope'
  | 'stack-trace'
  | 'multiline'
  | 'one-line-short'
  | 'one-line-long';

/**
 * The STRUCTURE of an error string, with none of its content. Cheap to read off
 * a Sentry tag and enough to tell apart the failure modes that currently share
 * the `'other'` bucket: an API envelope surfaced verbatim, a thrown stack, a
 * one-line message.
 */
export function describeErrorShape(error: string | undefined): ErrorShape {
  const text = error?.trim();
  if (!text) return 'empty';
  if (text.startsWith('{') || text.startsWith('[')) return 'json-envelope';
  if (/\n\s+at\s/.test(text)) return 'stack-trace';
  if (text.includes('\n')) return 'multiline';
  return text.length <= 120 ? 'one-line-short' : 'one-line-long';
}

/**
 * Reduce an error string to its SKELETON: the invariant scaffolding of the
 * message with every value-carrying part replaced by a placeholder. Paths,
 * URLs, emails, ids, numbers and quoted spans are exactly the parts that vary
 * between two occurrences of the same failure — and exactly the parts that can
 * carry a user's code, repo name or prompt. Removing them serves grouping and
 * privacy at once.
 *
 * Order matters: URLs and emails are consumed before the generic path rule,
 * which would otherwise eat their insides and leave a different skeleton.
 */
function skeletonize(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, '<url>')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/(?:\/[^\s'"`,;:()\[\]{}]+){2,}/g, '<path>')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '<str>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 400);
}

/**
 * A stable 8-hex digest of {@link skeletonize}'s output (FNV-1a, 32-bit).
 *
 * WHAT IT BUYS. `errorClass: 'other'` cannot say whether 93 events are one bug
 * or twenty — this can, without ever shipping the message itself. Two events
 * that share a digest are the same failure; a bucket that splits into three
 * digests is three bugs. The raw text for a digest is already on the reporting
 * machine, in the local error buffer captureSeamError writes before Sentry is
 * consulted, so a digest is also the join key between an inbox group and a
 * user's own logs or bug report.
 *
 * FNV-1a rather than a crypto hash: this module is pure and dependency-free by
 * contract (it must stay importable from the standalone-typechecked plane), and
 * collision resistance is not a security property here — a collision merges two
 * groups a human then splits by reading the local text.
 */
export function digestErrorSkeleton(error: string | undefined): string {
  const skeleton = skeletonize(error ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < skeleton.length; i++) {
    hash ^= skeleton.charCodeAt(i);
    // FNV prime (16777619) by shift-add, kept in 32-bit unsigned space.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The extra Sentry tags an UNCLASSIFIED failure should carry, and nothing at
 * all for a classified one — `errorClass: 'auth-failure'` already says what
 * happened, so adding a shape and a digest to it would only inflate tag
 * cardinality.
 *
 * Spread into a captureSeamError tag bag at the seams that classify a raw
 * message:
 *
 * ```ts
 * const errorClass = classifyErrorPattern(message);
 * captureSeamError('some-seam', new Error(`… (${errorClass})`), {
 *   errorClass,
 *   ...unclassifiedErrorTags(errorClass, message),
 * });
 * ```
 */
export function unclassifiedErrorTags(
  errorClass: string,
  error: string | undefined,
): Record<string, string> {
  if (!UNCLASSIFIED_CLASSES.has(errorClass)) return {};
  return { errorShape: describeErrorShape(error), errorDigest: digestErrorSkeleton(error) };
}

/** Garbage guard: never trust a computed reset delay beyond this horizon. */
const MAX_RESET_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Extract, as a delay in milliseconds from `nowMs`, WHEN a systemic limit is
 * expected to reset — so an automatic resume can be scheduled rather than
 * parking forever. Tries three shapes, in order:
 *
 *   1. A trailing or embedded `|<unix-epoch>` suffix — 10-digit seconds or
 *      13-digit milliseconds — e.g. "Claude AI usage limit reached|1751234567".
 *   2. `resets (at )?<h>(:<mm>)?(am|pm)` — a LOCAL wall-clock time with no date.
 *      Since this file must stay pure (no `Date.now()` inside), "today" is
 *      derived by constructing a `Date` FROM `nowMs` (which still reads the
 *      local timezone of whatever machine runs the process — that is an
 *      accepted, documented impurity of the caller's clock/tz, not of this
 *      function's control flow). If that wall-clock time has already passed
 *      today (<= nowMs), the reset is assumed to be tomorrow.
 *   3. `resets at <ISO-8601 datetime>` — parsed via `Date.parse`.
 *
 * Returns `null` when no shape matches, when the computed delay is `<= 0`
 * (except form 2's documented tomorrow-rollover), or when it exceeds 7 days
 * (garbage guard against a misparsed date far in the future).
 */
export function parseLimitResetDelayMs(error: string | undefined, nowMs: number): number | null {
  if (!error) return null;

  const epochDelay = parseEpochSuffix(error, nowMs);
  if (epochDelay !== null) return epochDelay;

  const wallClockDelay = parseWallClockResets(error, nowMs);
  if (wallClockDelay !== null) return wallClockDelay;

  const isoDelay = parseIsoResets(error, nowMs);
  if (isoDelay !== null) return isoDelay;

  return null;
}

function clampDelay(deltaMs: number): number | null {
  if (deltaMs <= 0) return null;
  if (deltaMs > MAX_RESET_DELAY_MS) return null;
  return deltaMs;
}

/** Form 1: "...|1751234567" (seconds) or "...|1751234567890" (milliseconds). */
function parseEpochSuffix(error: string, nowMs: number): number | null {
  const match = /\|\s*(\d{10}|\d{13})\b/.exec(error);
  if (!match) return null;
  const raw = match[1];
  const epochMs = raw.length === 13 ? Number(raw) : Number(raw) * 1000;
  if (!Number.isFinite(epochMs)) return null;
  return clampDelay(epochMs - nowMs);
}

/** Form 2: "resets 2:20pm" / "resets at 2pm" / "resets at 11:59 AM". */
function parseWallClockResets(error: string, nowMs: number): number | null {
  const match = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(error);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;

  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  // Local-timezone "today" derived from nowMs (documented impurity — see the
  // function doc comment above). No Date.now() is read here.
  const now = new Date(nowMs);
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  let candidateMs = candidate.getTime();

  if (candidateMs <= nowMs) {
    // Already passed today — the limit resets tomorrow at this wall-clock time.
    candidateMs += 24 * 60 * 60 * 1000;
  }

  return clampDelay(candidateMs - nowMs);
}

/** Form 3: "resets at 2026-07-06T14:20:00Z" (or any Date.parse-able ISO string). */
function parseIsoResets(error: string, nowMs: number): number | null {
  const match = /resets\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(error);
  if (!match) return null;
  const parsed = Date.parse(match[1]);
  if (Number.isNaN(parsed)) return null;
  return clampDelay(parsed - nowMs);
}
