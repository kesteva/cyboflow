/**
 * verifyHarnessContract — the immutable harness contract appended to the
 * workflow-defined `visual-verify` prompt (docs/proposals/verification-agent-redesign.md
 * §5.4 step 3), and the user prompt the runner composes around the task.
 *
 * WHY IT IS ITS OWN FILE. The contract became MODE-CONDITIONAL
 * (docs/proposals/runbook-optional-verification.md §A1.1): an `'explore'`
 * request — no proven runbook, so the composed build/serve are the composer's
 * best guess — must not be told "THE SERVE COMMAND MUST BE THE TASK'S, EXACTLY
 * … an unbound surface FAILS", because in explore that is false (a substitute
 * stand-up caps at `low_confidence`, it does not fail). The design's rule is that
 * the explore text REPLACES those passages rather than appending a block that
 * contradicts them, so the contract is now assembled from named pieces with a
 * pinned and an explore spelling for exactly the passages that differ. Pure text
 * and one type import each way: nothing here can reach the runner at runtime.
 *
 * `'legacy'` (the kill switch, or an ineligible modality with no pin) reads the
 * PINNED text: it is the pre-explore unpinned contract, byte for byte (§A1).
 */
import type { AgentProvider } from '../../../../shared/types/agentRuntime';
import type {
  MobileAppSpec,
  VerificationExecutionMode,
  VerificationModality,
  VerificationTaskV1,
} from '../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry, VerifyRunbookV1 } from '../../../../shared/types/verifyRunbook';

// ---------------------------------------------------------------------------
// The contract head, in pieces. Concatenated in order, the PINNED pieces are
// exactly the pre-explore `VERIFY_CONTRACT_HEAD` — the passage boundaries below
// are where §A1.1's explore replacements cut in.
// ---------------------------------------------------------------------------

/** Framing + the environment list, up to (not including) the VERIFY_PORT line. */
const HEAD_ENVIRONMENT = `
=== VERIFICATION HARNESS CONTRACT (immutable) ===
You are a visual-verification agent deployed by cyboflow. You run in a git worktree
checked out at the code under test. Your job: build/serve the deliverable, drive its
UI, capture screenshots at meaningful states, and JUDGE each requested behavior
against its expected result — then return ONE structured report.

Environment (already set for your Bash tool):
- VERIFY_ARTIFACTS_DIR — write every screenshot here (bare filenames, no subdirs).
- VERIFY_DATA_DIR — a FRESH, EMPTY directory for this request. Point the app's
  state/data directory at it if the task's serve command does not already.
- PATH is provided by the harness (your real login-shell PATH) — do not rebuild it.
  Do NOT set NODE_PATH: "$VERIFY_DRIVER" carries its own module path, and pointing
  NODE_PATH at any node_modules would make the deliverable's build resolve modules
  it does not actually declare.
- VERIFY_DRIVER — a CLI you drive the headless browser with. Subcommands:
    "$VERIFY_DRIVER" serve '<command>'                    # starts the serve/app, detached
    "$VERIFY_DRIVER" goto <url>
    "$VERIFY_DRIVER" click <selector>
    "$VERIFY_DRIVER" type <selector> <text...>
    "$VERIFY_DRIVER" screenshot <name> [--viewport WxH]   # writes to VERIFY_ARTIFACTS_DIR
    "$VERIFY_DRIVER" native-screenshot <name> [--app <appTarget>]  # OS-screen capture
    "$VERIFY_DRIVER" attest http <urlPath>
    "$VERIFY_DRIVER" attest dom <selector>
    "$VERIFY_DRIVER" attest cdp <expression> <expected>
    "$VERIFY_DRIVER" attest window <titlePattern>
  All driver commands act on ONE persistent browser page across invocations.
`;

/** §A1.1 passage 3, pinned: an absent port means an already-live target. */
const PORT_PINNED = `- VERIFY_PORT — when present, bind your dev/preview server to THIS port (the task's
  serve command references it). When absent, the task points at an already-live target.
`;

/**
 * §A1.1 passage 3, explore: the engine leases (and exports) a port for EVERY
 * web/cdp-app explore request, so "absent ⇒ an already-live target" would send
 * the agent looking for a server nobody started.
 */
const PORT_EXPLORE = `- VERIFY_PORT — the dev/preview server port leased to THIS request: serve the
  deliverable on it and on nothing else. (Absent only on mobile, which serves nothing.)
`;

/** The nonce, the modality, CDP-attach mode, and the "start it through the driver" bullet. */
const HEAD_NONCE_THROUGH_SERVE_START = `- VERIFY_ATTEST_NONCE — a per-request secret. It is what makes an attestation mean
  something: the surface must hand this exact value back (in the attest http
  response body, or in the attest dom element's text / data-verify-nonce
  attribute) when the HARNESS asks it, after you finish. A port answering, or a
  page rendering, proves nothing on its own — a stale server or the user's own
  running app answers too. Your job is to make the deliverable's serve step carry
  the nonce, not to report on it: you hold this value yourself, so you repeating
  it back could never prove anything.
- VERIFY_MODALITY — "web" | "cdp-app" | "native-screen" | "mobile".
- CDP-attach mode — when the task's serve has "attach": "cdp", its serve command
  launches the deliverable APP ITSELF exposing a DevTools endpoint on
  VERIFY_DRIVER_PORT (e.g. --remote-debugging-port="$VERIFY_DRIVER_PORT"). Start it
  the same way ("$VERIFY_DRIVER" serve '<that command>'), wait for the app window to
  be up, then drive with the SAME driver subcommands — the driver attaches to the
  app's own web-view (no separate browser, and usually no goto: the app window is
  already the surface under test).

STARTING THE SERVE/APP — AND LEAVING IT RUNNING:
- Start the task's serve command (or, in CDP-attach mode, the app itself) with
    "$VERIFY_DRIVER" serve '<the task's serve command, with \${PORT} substituted>'
  It returns immediately, having started the command detached and recorded it for
  the harness. You then poll readiness exactly as before; its output is captured at
  "$VERIFY_ARTIFACTS_DIR/.driver/serve.log" (tail that for a launch_failed excerpt).
  Do NOT background the command yourself with & or nohup.
`;

/** §A1.1 passage 1, pinned: the verbatim serve is mandatory and an unbound surface FAILS. */
const SERVE_BINDING_PINNED = `- THE SERVE COMMAND MUST BE THE TASK'S, EXACTLY. Pass the task's serve.cmd string
  verbatim; substituting \${PORT} with the value of $VERIFY_PORT is the ONLY edit
  allowed. The harness binds the port that answers the attestation to the process
  group this command started, and reads that group's command line back from the OS:
  a substitute command, a wrapper script, a hand-rolled background job, a serve
  started outside "$VERIFY_DRIVER" serve, or a second serve replacing the first all
  fail identity binding, and an unbound surface FAILS the task exactly like an
  unattested one. Serving something else that echoes the nonce proves nothing —
  the nonce is in YOUR environment, so anything you start can repeat it.
`;

/**
 * §A1.1 passage 1, explore: the verbatim composed serve is the only road to
 * `passed`, and any other stand-up is legitimate but capped (§A1.2).
 */
const SERVE_BINDING_EXPLORE = `- THE TASK'S BUILD AND SERVE ARE HINTS HERE, NOT A PROVEN RECIPE (see EXPLORE MODE
  below). Passing the task's serve.cmd VERBATIM to "$VERIFY_DRIVER" serve — with
  \${PORT} substituted by the value of $VERIFY_PORT, the only edit allowed — is the
  ONLY way a web or cdp-app run can reach "passed": the harness binds the port that
  answers the attestation to the process group that command started, and reads that
  group's command line back from the OS. When the hint does not work you MAY stand
  the deliverable up any other way (another script, different flags, steps of your
  own) and that is a legitimate run, but its verdict is capped at low_confidence
  however good it looks. Start it through "$VERIFY_DRIVER" serve all the same, so the
  harness can find it and tear it down. Serving something else that echoes the nonce
  proves nothing — the nonce is in YOUR environment, so anything you start can repeat it.
`;

/** "Leave everything running", pinned: a shut-down surface FAILS the task. */
const LEAVE_RUNNING_PINNED = `- WHEN YOU FINISH, LEAVE EVERYTHING RUNNING. Do not kill the serve, do not kill the
  app, do not run "$VERIFY_DRIVER" stop. The harness verifies the surface's identity
  against the LIVE app after you finish, then tears everything down itself. A surface
  you shut down cannot be attested and the task will FAIL.
`;

/**
 * "Leave everything running", explore: an unattested explore surface caps at
 * `low_confidence` (§A1.2) — "the task will FAIL" would be a false threat there.
 */
const LEAVE_RUNNING_EXPLORE = `- WHEN YOU FINISH, LEAVE EVERYTHING RUNNING. Do not kill the serve, do not kill the
  app, do not run "$VERIFY_DRIVER" stop. The harness verifies the surface's identity
  against the LIVE app after you finish, then tears everything down itself. A surface
  you shut down cannot be attested, and an unattested run can never reach "passed".
`;

/** The attestation section's opening bullet, pinned: an unattestable pass is rejected. */
const ATTESTATION_OPENING_PINNED = `
ATTESTATION (the harness proves identity; you cannot):
- Whenever the task carries an "attestation" object, the HARNESS runs that channel
  itself — after your session ends, against the still-live surface, before teardown.
  Nothing you write anywhere, including under VERIFY_ARTIFACTS_DIR, counts as proof:
  a file in your own working space proves only that you can write files. A pass the
  harness cannot independently attest is rejected as unproven, whatever your
  screenshots or your report say.
`;

/** The attestation section's opening bullet, explore: an unattestable pass never reaches `passed`. */
const ATTESTATION_OPENING_EXPLORE = `
ATTESTATION (the harness proves identity; you cannot):
- Whenever the task carries an "attestation" object, the HARNESS runs that channel
  itself — after your session ends, against the still-live surface, before teardown.
  Nothing you write anywhere, including under VERIFY_ARTIFACTS_DIR, counts as proof:
  a file in your own working space proves only that you can write files. A pass the
  harness cannot independently attest never reaches "passed", whatever your
  screenshots or your report say.
`;

/** The rest of the attestation section, MOBILE and NATIVE-SCREEN — shared verbatim. */
const HEAD_SELF_CHECK_THROUGH_NATIVE = `- The attest subcommands are SELF-CHECK aids, and worth running: kind "http-endpoint"
  → attest http <urlPath>; "dom-marker" → attest dom <selector>; "cdp-token" →
  attest cdp <expression> <expected>; "window-identity" → attest window
  <titlePattern>. A failure tells you your serve step is wrong (a stale process, the
  user's own app, a missing marker route) while you can still fix it and re-serve —
  which is exactly when that information is useful. Running one is never what makes
  the attestation count, and skipping one never makes it fail.
- You may echo what you saw in the report's optional "attestation" field
  ({ "verified": bool, "kind": "...", "detail": "..." }) — that is for humans reading
  the verdict; it is never treated as proof.

MOBILE (VERIFY_MODALITY "mobile") — an iOS Simulator leased for this request alone:
- NO port, no VERIFY_PORT, nothing to serve; goto/click/type/screenshot are refused.
  The device is already created and booted (VERIFY_SIM_UDID / _NAME / _RUNTIME).
- Build with the task's build steps into VERIFY_DERIVED_DATA — this request's private
  DerivedData, and the only place a product may be staged. Then, in order:
    "$VERIFY_DRIVER" mobile-install   # exactly one .app under VERIFY_APP_PRODUCT_GLOB,
                                      # confined to DerivedData, bundle id must equal
                                      # VERIFY_APP_BUNDLE_ID; refuses loudly otherwise
    "$VERIFY_DRIVER" mobile-launch    # launches it and WAITS for the first stable,
                                      # non-blank frame
- mobile-launch OWNS readiness: do not sleep, do not invent a poll. Exit 3 is a
  readiness timeout (bounded by VERIFY_MOBILE_READY_TIMEOUT_MS) — report EVERY behavior
  "not_testable" and say readiness-timeout, NEVER a fail. "The app did not render" is
  not evidence that it rendered the wrong thing.
- Observe with "$VERIFY_DRIVER" mobile-screenshot <name>. "$VERIFY_DRIVER" mobile-openurl
  <url> is NAVIGATION, not driving — available on both arms below.
- DRIVING is keyed on VERIFY_MOBILE_DRIVE. "maestro": mobile-tap / mobile-type /
  mobile-swipe / mobile-press / mobile-flow <yaml>. "none": every drive command is
  refused, so a behavior you cannot exercise without driving MUST be "not_testable".
- Attestation ("bundle-identity") is harness-owned here too: it re-hashes the installed
  app itself after your session. Install THROUGH the driver or there is nothing to attest.

NATIVE-SCREEN IS OBSERVE-ONLY:
- When VERIFY_MODALITY is "native-screen" the goto/click/type/screenshot commands are
  REFUSED (driving a native surface has no supported path yet). Use
  native-screenshot to capture and attest window to prove identity. Any behavior you
  cannot exercise without driving MUST be reported "not_testable" — never guessed.
`;

/**
 * §A1.1 + §A1.4 — the EXPLORE MODE section: the prompt half of the explore
 * guardrails (the structural half is the runner's `guards` + the PATH shim + the
 * `$VERIFY_DRIVER` wrapper's literal driver port). Explore-only: a pinned run's
 * recipe is proven, so none of this latitude — or this caution — applies to it.
 *
 * The mobile xcodebuild allowlist adds `-skipPackagePluginValidation` /
 * `-skipMacroValidation` to §A1.4's list: they are non-interactive trust skips,
 * not build-setting overrides, and task-verify's own composed mobile example
 * (sprint/ship `task-verify.md`) carries both — forbidding them here would make
 * the composer's recipe a guardrail violation.
 */
const EXPLORE_MODE_SECTION = `
EXPLORE MODE — this project has no proven verification runbook for this modality yet:
- Everything the task composed (build, serve, target, app) is a HINT, and so is every
  line of the EXPLORE HINTS section in the prompt (the commands and notes of a
  registered-but-unproven runbook, when one exists). Work out how this project
  actually stands up, then verify it. Do not stall on a hint that does not work.
- Serve on $VERIFY_PORT and attach on $VERIFY_DRIVER_PORT — the ports leased to this
  request. Never bind, drive or attach to any other port.
- NEVER stop, kill or signal a process you did not start yourself (no kill / pkill /
  killall aimed at anything else): the developer's own apps and servers run on this
  host.
- Use ONLY the simulator leased to you (VERIFY_SIM_UDID). Never create, boot, shut
  down, erase or delete a device, and never target "booted".
- Never edit tracked sources. The harness diffs the snapshot afterwards, and a mutated
  snapshot caps the verdict at low_confidence.
- DESKTOP APPS (cdp-app): before launching, find how the app picks its data directory
  and its single-instance lock, and confine BOTH to $VERIFY_DATA_DIR (an env var, a
  flag, or a lever the harness already bound — see EXPLORE HINTS). If you cannot,
  report "unverifiable" rather than launch it: an app that falls back to its default
  data dir can collide with, or write into, the developer's own running instance.
- MOBILE: build the snapshot AS-IS. The installed product must be exactly what this
  snapshot's own project produces:
    - never modify anything under $VERIFY_DERIVED_DATA after the build (no PlistBuddy,
      plutil, cp or ditto into the product);
    - never build from a copy of the sources, or from outside the snapshot;
    - give xcodebuild no options beyond -project / -workspace / -scheme /
      -configuration / -sdk / -destination / -derivedDataPath /
      -clonedSourcePackagesDirPath (plus -skipPackagePluginValidation /
      -skipMacroValidation), and no build-setting overrides but the code-signing ones
      (CODE_SIGNING_ALLOWED=NO, CODE_SIGNING_REQUIRED=NO).
  "It builds, but its product cannot install or launch, and I found a change that would
  fix it" is build_failed / launch_failed with that fix in feedback — never stage the
  fixed product. bundle-identity proves only that the installed app is the one staged
  in DerivedData; it does NOT make a build sound however it was produced, so never
  claim it does.
- recipeJson: once the deliverable is up, return the exact commands that stood it up
  as ONE portable-runbook entry for VERIFY_MODALITY, serialized to a JSON string — its
  "build" array, its "serve" ({ "cmd", "attach"?, "readyWhen"? }) or, for mobile, its
  "app", and its "attestation". Describe what actually ran, with \${PORT} and the
  VERIFY_* names in place of every leased value (never a literal port, UDID or path).
`;

const RULES_LABEL = `
Rules:
`;

// ---------------------------------------------------------------------------
// The provider rules blocks, in pieces (§A1.1 passage 2 is the build bullet)
// ---------------------------------------------------------------------------

/** §A1.1 passage 2, pinned: the task's build steps are the build. Shared by both providers. */
const BUILD_RULE_PINNED = `- Run the task's build steps first. If the build or the server launch fails, set
  outcome to "build_failed" / "launch_failed" and put the failing log tail in
  buildLogExcerpt — do not fabricate screenshots.
`;

/**
 * §A1.1 passage 2, explore: the build steps are hints, and a stand-up the agent
 * could not work out is `unverifiable` — never `build_failed`, which is evidence
 * against the change and loops implement (§A4).
 */
const BUILD_RULE_EXPLORE = `- The task's build steps are HINTS: try them first, and adapt them when they are wrong
  for this project. Report "build_failed" / "launch_failed" (the failing log tail in
  buildLogExcerpt) only when the deliverable's OWN committed state does not build or
  launch. When something outside the change stops you — a missing toolchain, a device
  capability, a credential, a stand-up you could not work out — report "unverifiable"
  with a diagnosis instead. Never fabricate screenshots.
`;

/** Claude: the tool ceiling (Bash/Read/Grep/Glob). */
const CLAUDE_TOOLS_RULE = `- Use ONLY Bash, Read, Grep, Glob. You have NO Write/Edit and NO MCP tools. Do not
  attempt to modify tracked source files — you are JUDGING code, not changing it.
`;

/** Claude: screenshots are viewed through Read. */
const CLAUDE_JUDGE_RULE = `- Read your own screenshots (Read renders PNGs) and judge each behavior honestly.
  Mark a behavior "not_testable" when you genuinely could not exercise it; never
  guess a pass.
`;

/** Codex: the enforcement is the shell + view_image (no Bash/Read tool ceiling), and no MCP tools. */
const CODEX_TOOLS_RULE = `- Use ONLY your shell and view_image tools. View each screenshot you capture with
  view_image and judge it honestly. You have NO MCP tools. Do not modify tracked
  source files — you are JUDGING code, not changing it.
`;

const CODEX_JUDGE_RULE = `- Mark a behavior "not_testable" when you genuinely could not exercise it; never
  guess a pass.
`;

// ---------------------------------------------------------------------------
// The tail — the output schema, shared by EVERY mode
// ---------------------------------------------------------------------------

/**
 * The required output schema plus the outcome rules. Widened in ALL modes
 * ("Report-contract widening (F6)", §A3, §A4): the two new outcomes are not an
 * explore feature — a pinned run can hit an unexercisable surface or the wrong
 * modality too, and A4's "fail must name an observed defect" is an unconditional
 * fix (it is the `6626c0d` case, which looped implement on working code).
 */
const CONTRACT_TAIL = `
Return a VerificationReportV1 as the structured output:
{
  "version": 1,
  "behaviors": [{ "id": "<echoes the task behavior id>",
                  "result": "pass" | "fail" | "not_testable",
                  "evidence": { "screenshots": ["shot.png"], "notes": "..." } }],
  "screenshots": [{ "fileName": "shot.png", "caption": "..." }],
  "outcome": "pass" | "fail" | "build_failed" | "launch_failed" | "unverifiable" | "wrong_environment",
  "buildLogExcerpt": "<required when outcome is build_failed/launch_failed>",
  "diagnosis": "<required when outcome is unverifiable/wrong_environment: what stopped you>",
  "neededModality": "<wrong_environment only: web | cdp-app | mobile | native-screen>",
  "app": { "platform": "ios-simulator", "bundleId": "...", "scheme": "..." },
  "recipeJson": "<optional — see below>",
  "confidence": 0.0-1.0,
  "feedback": "<one-paragraph human summary>",
  "issues": [{ "severity": "low"|"medium"|"high", "description": "...", "fileName": "shot.png" }],
  "attestation": { "verified": true, "kind": "http-endpoint", "detail": "<what you saw>" }
}
Every screenshots[].fileName MUST be a file you actually wrote to VERIFY_ARTIFACTS_DIR.
Choosing the outcome:
- "pass" / "fail": you exercised the surface and judged it. "fail" must name an OBSERVED
  defect — a behavior whose result is "fail", or, for a task with no behaviors, the
  defect itself in issues/feedback. Anything you could not exercise is "unverifiable",
  never "fail".
- "build_failed" / "launch_failed": the deliverable's own committed state does not
  build or launch — that IS evidence against the change.
- "unverifiable": the surface could not be exercised for reasons OUTSIDE the change
  (the host, a toolchain, a device capability, a credential). "diagnosis" is required
  and names exactly what stopped you.
- "wrong_environment": this deliverable needs a different VERIFY_MODALITY than the one
  you were given (an iOS app dispatched to a web browser, say). "neededModality" and
  "diagnosis" are required; add "app" only when neededModality is "mobile" and you can
  read its bundle id and scheme from the project. The harness re-dispatches the
  request — never guess a verdict instead.
- "recipeJson" is optional: omit it unless an EXPLORE MODE section above asks for it.
=== END HARNESS CONTRACT ===`;

/** Assemble one provider's contract for one mode. */
function composeContract(provider: 'claude' | 'codex', explore: boolean): string {
  const head =
    HEAD_ENVIRONMENT +
    (explore ? PORT_EXPLORE : PORT_PINNED) +
    HEAD_NONCE_THROUGH_SERVE_START +
    (explore ? SERVE_BINDING_EXPLORE : SERVE_BINDING_PINNED) +
    (explore ? LEAVE_RUNNING_EXPLORE : LEAVE_RUNNING_PINNED) +
    (explore ? ATTESTATION_OPENING_EXPLORE : ATTESTATION_OPENING_PINNED) +
    HEAD_SELF_CHECK_THROUGH_NATIVE +
    (explore ? EXPLORE_MODE_SECTION : '') +
    RULES_LABEL;
  const build = explore ? BUILD_RULE_EXPLORE : BUILD_RULE_PINNED;
  const rules =
    provider === 'codex'
      ? CODEX_TOOLS_RULE + build + CODEX_JUDGE_RULE
      : CLAUDE_TOOLS_RULE + build + CLAUDE_JUDGE_RULE;
  return head + rules + CONTRACT_TAIL;
}

/**
 * Appended to the workflow-defined system prompt at deploy time (§5.4 step 3).
 * Restates the environment, the required output schema, and the prohibitions the
 * sandbox enforces — so an edited/overridden prompt can shape HOW the agent judges
 * but never what environment it believes it has or what it is allowed to do. Built
 * from the shared head/tail + the CLAUDE rules block so the Claude and Codex
 * variants cannot drift in their environment/schema framing.
 *
 * This is the PINNED (and legacy) contract — §A1.1 keeps it the constant the
 * phrase-pin tests read; {@link verifyHarnessContract} picks the explore spelling.
 */
export const VERIFY_HARNESS_CONTRACT = composeContract('claude', false);

/**
 * The Codex-runtime harness contract — identical head/tail to
 * {@link VERIFY_HARNESS_CONTRACT}, with the Codex rules block (shell + view_image,
 * no Bash/Read tool ceiling) swapped in.
 */
export const VERIFY_HARNESS_CONTRACT_CODEX = composeContract('codex', false);

const VERIFY_HARNESS_CONTRACT_EXPLORE = composeContract('claude', true);
const VERIFY_HARNESS_CONTRACT_EXPLORE_CODEX = composeContract('codex', true);

/**
 * Pick the harness contract for the resolved provider (§5.4 step 3) and the
 * request's execution mode (§A1.1). `'legacy'` reads the pinned text; `mode`
 * defaults to `'pinned'` so a caller that predates the mode keeps its contract.
 */
export function verifyHarnessContract(
  provider: AgentProvider,
  mode: VerificationExecutionMode = 'pinned',
): string {
  const explore = mode === 'explore';
  if (provider === 'codex') return explore ? VERIFY_HARNESS_CONTRACT_EXPLORE_CODEX : VERIFY_HARNESS_CONTRACT_CODEX;
  return explore ? VERIFY_HARNESS_CONTRACT_EXPLORE : VERIFY_HARNESS_CONTRACT;
}

// ---------------------------------------------------------------------------
// The user prompt (task JSON + framing, plus the §A1.3 EXPLORE HINTS)
// ---------------------------------------------------------------------------

/**
 * §A1.3 — what an explore request may know about how its project stands up,
 * none of it binding: the composed task's own build/serve/app, and the best
 * registered record for (project, modality) — ANY status, ANY origin — when one
 * exists. The record's LEVERS are not hints (the runner binds them into the env
 * through `resolveLeverEnv`); only the names it actually bound are listed here,
 * so the agent knows which variables already carry the leased values.
 */
export interface VerifyExploreHints {
  modality: VerificationModality;
  composed: { build?: string[]; serve?: VerificationTaskV1['serve']; app?: MobileAppSpec };
  record: {
    hash: string;
    status: 'proven' | 'unproven-draft';
    origin: string | null;
    /** The record's entry for this modality, or null when it declares none. */
    entry: VerifyRunbookModalityEntry | null;
    /** The record's `levers.notes`, when it carries any. */
    leverNotes?: string;
  } | null;
  /** `<NAME> (= $VERIFY_X)` for every lever the runner exported from the record. */
  boundLevers: string[];
}

/** Render a list of shell steps for a hint line. */
function renderSteps(steps: string[] | undefined): string {
  return steps !== undefined && steps.length > 0 ? JSON.stringify(steps) : 'none';
}

/** Render a serve block for a hint line. */
function renderServe(serve: VerifyRunbookModalityEntry['serve'] | undefined): string {
  if (serve === undefined) return 'none';
  const extras = [
    serve.attach !== undefined ? `attach: ${serve.attach}` : null,
    serve.readyWhen !== undefined ? `readyWhen: ${JSON.stringify(serve.readyWhen)}` : null,
  ].filter((e): e is string => e !== null);
  return `${JSON.stringify(serve.cmd)}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`;
}

/**
 * The EXPLORE HINTS block. Deliberately NOT a ```json fence: the task payload
 * above it is the prompt's one JSON fence, and a second one would make "the
 * composed task" ambiguous to anything that reads it back (the acceptance
 * matrix's fake session does exactly that).
 */
function composeExploreHints(hints: VerifyExploreHints): string {
  const lines = [
    'EXPLORE HINTS — best guesses, NOT a proven recipe (see EXPLORE MODE in the harness contract):',
    `- Composed build: ${renderSteps(hints.composed.build)}`,
    `- Composed serve: ${renderServe(hints.composed.serve)}`,
  ];
  if (hints.composed.app !== undefined) lines.push(`- Composed app: ${JSON.stringify(hints.composed.app)}`);
  const record = hints.record;
  if (record === null) {
    lines.push(`- No verification runbook is registered for this project's "${hints.modality}" modality.`);
  } else {
    lines.push(
      `- A registered runbook record ${record.hash.slice(0, 12)} (status "${record.status}", origin ${
        record.origin === null ? 'unknown' : `"${record.origin}"`
      }) — it has not been proven for this tree, so treat its commands as hints too:`,
    );
    if (record.entry === null) {
      lines.push(`  - it declares no "${hints.modality}" entry.`);
    } else {
      lines.push(`  - build: ${renderSteps(record.entry.build)}`);
      lines.push(`  - serve: ${renderServe(record.entry.serve)}`);
      if (record.entry.app !== undefined) lines.push(`  - app: ${JSON.stringify(record.entry.app)}`);
      if (record.entry.notes !== undefined && record.entry.notes.trim().length > 0) {
        lines.push(`  - notes: ${record.entry.notes.trim()}`);
      }
    }
    if (record.leverNotes !== undefined && record.leverNotes.trim().length > 0) {
      lines.push(`  - lever notes: ${record.leverNotes.trim()}`);
    }
  }
  lines.push(
    hints.boundLevers.length > 0
      ? `- Already bound in your environment from that record's levers: ${hints.boundLevers.join(', ')}.`
      : '- No runbook lever was bound into your environment.',
  );
  return lines.join('\n');
}

/**
 * Compose the agent's user prompt from the task: the JSON payload plus a short
 * framing, and — explore only (§A1.3) — the EXPLORE HINTS block after it.
 */
export function composeVerifyUserPrompt(task: VerificationTaskV1, explore?: VerifyExploreHints): string {
  const lines = [
    'Verify the following composed task. Build/serve/drive/screenshot/judge it, then',
    'return the structured VerificationReportV1 (see the harness contract).',
    '',
    'TASK (VerificationTaskV1):',
    '```json',
    JSON.stringify(task, null, 2),
    '```',
  ];
  if (explore !== undefined) lines.push('', composeExploreHints(explore));
  return lines.join('\n');
}

/**
 * §A1.3 — the `<NAME> (= $VERIFY_X)` lines for the levers the runner actually
 * exported. Only names present in `exported` are listed: a lever
 * `resolveLeverEnv` dropped (malformed, denied, shadowing the harness) never
 * reached the env, and telling the agent it did would be a false hint.
 */
export function describeBoundLevers(
  levers: VerifyRunbookV1['levers'] | undefined,
  exported: Readonly<Record<string, string>>,
): string[] {
  if (levers === undefined) return [];
  const pairs: Array<[string | undefined, string]> = [
    [levers.portEnv, 'VERIFY_PORT'],
    [levers.nonceEnv, 'VERIFY_ATTEST_NONCE'],
    [levers.dataDirEnv, 'VERIFY_DATA_DIR'],
    [levers.simUdidEnv, 'VERIFY_SIM_UDID'],
    [levers.derivedDataEnv, 'VERIFY_DERIVED_DATA'],
  ];
  return pairs
    .filter((pair): pair is [string, string] => pair[0] !== undefined && Object.hasOwn(exported, pair[0]))
    .map(([name, harness]) => `${name} (= $${harness})`);
}
