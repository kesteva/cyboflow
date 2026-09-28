/**
 * dependencyCommandGuard — the DIAGNOSTICS half of the §7.2 "a verification may
 * not mutate dependencies" rule (docs/proposals/verification-setup-flow.md §7.2
 * "Snapshot dep isolation — a specified preparer, runner-enforced", plus §5.3's
 * "Dependency mutation is runner-enforced, not linted").
 *
 * WHAT ENFORCES THE RULE — NOT THIS FILE. `snapshotProvisioner` CLONES each
 * dependency dir into the snapshot rather than symlinking the live sprint
 * worktree's into it, so a `pnpm install` inside a verification writes into that
 * snapshot's own disposable copy and is thrown away with it. That is the
 * enforcement point, and it is structural: it covers writes no pattern can see —
 * an install spelled through an env var or a script file, a package.json edited
 * and installed, a file written straight into `node_modules`. This module was
 * the only control before that landed (the Codex §7.2 review's finding 5 is
 * precisely that a regex over shell strings is bypassable by indirection); it is
 * now the cheap layer on top, and per the project's belt-and-suspenders posture
 * it is the ONLY layer on top.
 *
 * SO WHY KEEP IT. Because "the write was contained" and "the agent understands
 * what it did wrong" are different goods. A composed task carrying
 * `pnpm install` is still a task that will burn minutes of a bounded deadline
 * reinstalling a tree it was handed, and — for an Electron project — will leave
 * the snapshot's better-sqlite3 on the host-Node ABI (NMV 127) under an Electron
 * that needs NMV 149 (§1 root cause (c)), producing a confusing launch failure
 * the agent has no reason to attribute to its own build step. Rejecting it at
 * ENQUEUE turns that into a structured error naming the offending command, while
 * the composer still has the context to recompose. The rule it enforces is a
 * fast, legible NO, not a containment boundary.
 *
 * WHY A REGEX AND NOT A LINT. §5.3's v2 correction still holds: build steps
 * reach the runner from TWO sources — a committed runbook's
 * `VerifyRunbookModalityEntry.build` and an AGENT-composed
 * `VerificationTaskV1.build` (task-verify's own exemplar recommended
 * `pnpm install` until this phase changed it). A validator on the runbook file
 * cannot reach the second source at all, so the check has to sit on the COMPOSED
 * TASK, where both converge — which is what {@link findForbiddenTaskCommands}
 * takes as its argument. Two callers consume this module, and they want
 * different halves of it:
 *
 *   - ENQUEUE (verify/enqueueFromTask.ts) calls
 *     {@link findForbiddenTaskCommands} and REJECTS the task before a row is
 *     written — the structured "you wrote this, recompose it" error above.
 *   - EXECUTION (verificationAgentQuery's `canUseTool`) tests
 *     {@link FORBIDDEN_DEP_COMMAND_PATTERN} against a `Bash` command the agent
 *     improvised at runtime, which no enqueue-time check can have seen.
 *
 * Both consume the SAME pattern, which is the whole reason this module exists
 * rather than each seam carrying its own copy: a pattern widened in one place
 * and not the other is a check that silently stops covering the case someone
 * just discovered.
 *
 * CONSERVATIVE BY DESIGN, IN THE CHEAP DIRECTION. A false positive costs the
 * composer one recomposition with an explicit reason; a false negative now costs
 * a slow, confusing verification rather than a poisoned sprint, because the
 * clone caught what the pattern missed. So the pattern still matches ANYWHERE in
 * a shell string — after `&&`, after `;`, inside a `sh -c "..."` — and is
 * case-insensitive, but this is deliberately NOT a place to keep bolting on
 * cleverness chasing the next indirection: that arms race was the finding, and
 * the clone is the answer to it. What it deliberately does NOT do is guess: it
 * matches package-manager DEPENDENCY VERBS, never a script invocation
 * (`pnpm run build`, `pnpm dev`, `pnpm test:unit` are all fine — running a
 * project's own scripts is the entire job of a build step).
 *
 * ALSO HOLDS THE A1.4 EXPLORE STRUCTURAL GUARDS (docs/proposals/
 * runbook-optional-verification.md "A1.4 Explore guardrails" → "Structural
 * guards (RS-8)" and "Codex live dependency guard (F8)"), colocated here for
 * the same single-source-of-truth reason: {@link PROCESS_KILL_COMMAND_PATTERN}
 * and {@link SIMCTL_LIFECYCLE_DENY_PATTERN} are each consumed by BOTH the
 * Claude `canUseTool` handler (verificationAgentQuery.ts, gated per call by
 * `VerificationAgentQueryArgs.guards`) and — FORBIDDEN_DEP_COMMAND_PATTERN only
 * — the Codex-runtime PATH shim (dependencyGuardShim.ts), which has no
 * `canUseTool` hook to sit on and instead intercepts the dependency-manager
 * binaries themselves.
 *
 * Standalone-typecheck invariant (mirrors capabilityStore.ts / runbookHash.ts):
 * imports shared TYPES only and nothing else — no node, no electron, no
 * better-sqlite3, no services/*.
 */
import type { VerificationExecutionMode, VerificationTaskV1 } from '../../../../shared/types/visualVerification';

/**
 * The §7.2 forbidden-command pattern — the SINGLE SOURCE OF TRUTH for both the
 * enqueue-time rejection and the execution-time guard. Widen it HERE and both
 * seams widen together.
 *
 * Four families, each anchored on word boundaries so a substring can never
 * trigger it:
 *
 *  1. `(pnpm|npm|yarn|bun) <dependency verb>` — install / i / ci / add /
 *     rebuild / up / update / upgrade. Intervening FLAG tokens are tolerated
 *     (`pnpm -r install`, `npm --prefix x ci`) but non-flag tokens are NOT, and
 *     that asymmetry is deliberate: allowing arbitrary tokens between the
 *     manager and the verb would make `pnpm run install` — a project script
 *     that happens to be named "install" — indistinguishable from a real
 *     install, and scripts are exactly what a build step is supposed to run.
 *  2. `playwright install` — the browser-binary download. Matched
 *     runner-agnostically (`npx playwright install`, `pnpm exec playwright
 *     install`, a bare `playwright install`) because the hazard is the download
 *     writing into the shared dependency tree, not which launcher spelled it.
 *  3. `electron-rebuild` — the native-module ABI flip in its most direct form.
 *  4. `electron-builder install-app-deps` — the same flip wearing the packaging
 *     tool's name. Both belong to the §7.2 dependency PREPARER (keyed by
 *     lockfile hash / platform / arch / node major / electron ABI / browser
 *     build, built outside any snapshot), never to a task's build step.
 *  5. `pod install` / `pod update` / `pod repo update` — CocoaPods' dependency
 *     mutation verbs, the mobile tier's equivalent of family (1).
 *  6. `swift package resolve` / `swift package update` — SwiftPM's own
 *     dependency-resolution SUBCOMMAND, invoked directly rather than as a
 *     side effect of building.
 *  7. `xcodebuild … -resolvePackageDependencies` — the explicit "fetch my
 *     SwiftPM graph now" flag on an xcodebuild invocation.
 *
 * WHY AN ORDINARY `xcodebuild build …` IS NOT AMONG THEM. A build step that
 * needs SwiftPM resolves it IMPLICITLY, into that build's own
 * `-clonedSourcePackagesDirPath` (a directory scoped to the request's own
 * DerivedData, never a shared checkout or `~/Library/Caches/org.swift.swiftpm`
 * the host's Xcode reuses). It therefore has the identical property that
 * keeps a plain `pnpm build` off the (1) list despite `pnpm build` also
 * touching a build cache: the mutation is real but PRIVATE to the request.
 * Forbidding it here would reject the ordinary mobile build step task-verify
 * composes, for a hazard the private directory has already closed off — the
 * three families above are specifically the ones that reach OUTSIDE that
 * private scope (a system-wide Pods checkout, the shared SwiftPM cache, or an
 * explicit re-resolve into it) or bypass it (families 5-6 run standalone,
 * with no clonedSourcePackagesDirPath to scope them at all).
 */
export const FORBIDDEN_DEP_COMMAND_PATTERN = new RegExp(
  [
    // (1) package-manager dependency mutation, with optional intervening flags.
    String.raw`\b(?:pnpm|npm|yarn|bun)(?:\s+-{1,2}[^\s]+)*\s+(?:install|i|ci|add|rebuild|up|update|upgrade)\b`,
    // (2) browser-binary download, whatever the launcher.
    String.raw`\bplaywright\s+install\b`,
    // (3) + (4) electron native-ABI rebuilds.
    String.raw`\belectron-rebuild\b`,
    String.raw`\belectron-builder\s+install-app-deps\b`,
    // (5) CocoaPods dependency mutation.
    String.raw`\bpod\s+(?:install|update|repo\s+update)\b`,
    // (6) SwiftPM's own resolve/update subcommand, run standalone.
    String.raw`\bswift\s+package\s+(?:resolve|update)\b`,
    // (7) xcodebuild's explicit SwiftPM re-resolve flag.
    String.raw`-resolvePackageDependencies\b`,
  ].join('|'),
  'i',
);

/**
 * Every command in a composed task that mutates dependencies, returned VERBATIM
 * (the full offending shell string, not the matched fragment) so the caller's
 * error names exactly what the composer wrote and the composer can find it
 * without re-deriving anything.
 *
 * Covers both command channels a task carries: every `build[]` entry, in order,
 * then `serve.cmd`. Order is the task's own, so a multi-offender task reads
 * top-to-bottom the way it was composed. Duplicates are preserved for the same
 * reason — "you wrote it twice" is information.
 *
 * Note that this checks the COMPOSED task, which by the time the enqueue seam
 * calls it may already carry a proven runbook's merged build/serve (§5.2 seam
 * 3). That is intended: §7.2's rule is "rejected in EVERY composed task's
 * build/serve steps — runbook-sourced and agent-composed alike", and a runbook
 * that smuggles an install through the merge is exactly as dangerous as an
 * agent that guessed one.
 */
export function findForbiddenTaskCommands(task: VerificationTaskV1): string[] {
  const offenders: string[] = [];
  for (const step of task.build ?? []) {
    if (typeof step === 'string' && FORBIDDEN_DEP_COMMAND_PATTERN.test(step)) offenders.push(step);
  }
  const serveCmd = task.serve?.cmd;
  if (typeof serveCmd === 'string' && FORBIDDEN_DEP_COMMAND_PATTERN.test(serveCmd)) {
    offenders.push(serveCmd);
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// EXECUTION-TIME deny messages (verificationAgentQuery's `canUseTool`, and the
// A1.4 PATH-shim guard script below). Colocated with the patterns they name so
// a widened pattern and its message can never drift apart, and so
// dependencyGuardShim.ts (which serializes {@link forbiddenDepCommandDenyMessage}
// itself into a generated file — see its module doc) has ONE place to import
// both from, without pulling in verificationAgentQuery's SDK-boundary imports.
// ---------------------------------------------------------------------------

/**
 * The deny message for a blocked dependency-mutating Bash command. MOVED here
 * (was defined in verificationAgentQuery.ts) so {@link
 * findForbiddenTaskCommands}'s sibling execution-time consumers — the Claude
 * `canUseTool` handler AND the Codex PATH-shim's guard script — share the exact
 * same wording from the exact same module as {@link
 * FORBIDDEN_DEP_COMMAND_PATTERN}. Still re-exported from verificationAgentQuery.ts
 * for API stability.
 *
 * It is written FOR THE AGENT, and every clause is load-bearing. It names the
 * exact command back (the agent composed it, possibly several turns ago, and
 * "denied" without a subject invites a shotgun retry). It states the rule and
 * WHY the rule exists — a snapshot's `node_modules` is a SYMLINK into a shared
 * dependency tree (the live sprint worktree, or the §7.2 prepared-set mirror),
 * so the write is never local to this verification. It closes off the
 * workarounds an agent reliably reaches for next (a different package manager,
 * a `cd` elsewhere, writing into `node_modules` by hand). And it names
 * the sanctioned exit, which depends on the request's `mode`:
 *
 *   - pinned / legacy (and `mode` absent): report `build_failed` carrying this
 *     message — a proven runbook's build is supposed to stand up WITHOUT the
 *     install, so needing one is a DELIVERABLE-honest outcome a human can act
 *     on, rather than a green verdict obtained by corrupting three sibling
 *     lanes.
 *   - explore: report `unverifiable` with a diagnosis naming the missing
 *     dependency step (docs/proposals/runbook-optional-verification.md A2: "a
 *     build that needs a forbidden dependency step is `unverifiable`, never
 *     `build_failed`"). An explore snapshot lacking installed deps or Pods is an
 *     environment gap outside the change — BUILD_RULE_EXPLORE's own routing —
 *     and a `build_failed` there would charge the lane a failed verdict for it.
 *     This is the most recent, most specific instruction the agent sees at the
 *     moment of action, so it must never contradict the explore contract.
 *
 * STANDALONE ON PURPOSE (no closure over anything outside its own parameters):
 * dependencyGuardShim.ts's guard-script generator embeds this function's own
 * `.toString()` verbatim into the generated guard.js, so it must remain fully
 * self-contained — reaching for a module-scope const here would silently break
 * that embedding. (`mode`'s type annotation is erased at compile time, so the
 * type import above is not a closure.)
 */
export function forbiddenDepCommandDenyMessage(command: string, mode?: VerificationExecutionMode): string {
  const exit =
    mode === 'explore'
      ? 'if the deliverable cannot be built without it, report outcome "unverifiable" with a diagnosis naming the missing dependency step (quote this message) — never "build_failed".'
      : 'if the deliverable cannot be built without it, report outcome "build_failed" with this message instead.';
  return [
    `Blocked: \`${command}\` mutates dependencies.`,
    'Dependency install/rebuild is forbidden inside verification snapshots — deps are prepared and',
    'ABI-rebuilt OUTSIDE the snapshot, so an install here would silently redo that work against the wrong ABI and burn your deadline.',
    'Do not work around it (no alternate package manager, no cd elsewhere, no hand-editing node_modules):',
    exit,
  ].join(' ');
}

/**
 * A1.4 explore guard #1 (docs/proposals/runbook-optional-verification.md
 * "A1.4 Explore guardrails" → "Structural guards (RS-8)": "Claude `canUseTool`
 * denies `kill`/`pkill`/`killall`"). Matches a `kill`/`pkill`/`killall`
 * invocation IN COMMAND POSITION — the very thing that would actually end a
 * process, not merely a Bash string that happens to contain those letters.
 *
 * "Command position" means: the first token of the whole command, the first
 * token after a shell separator or grouping character (`;` `&` `|` `` ` ``
 * `(` `{` `!` or a newline — a single member of the class is enough for an
 * `&&`/`||` pair too, since the adjacent duplicate character still anchors the
 * match at that position), or the first token after a reserved word that
 * introduces a command (`then` `do` `else` `elif` `if` `while` `until` — the
 * `for pid in $(lsof -ti :3000); do kill -9 $pid; done` loop is the single most
 * common way an agent clears a port, adversarial-review fix). From there it
 * tolerates, in order: leading `KEY=VALUE` assignments (`FOO=1 kill …`); one
 * or more of the wrapper commands an agent reaches for when it wants to route
 * a kill around something (`sudo`, `doas`, `env`, `xargs`, `nohup`, `time`,
 * `timeout`, `nice`, `command`, `builtin`, `exec`, `setsid` — each may be
 * named by path (`/usr/bin/env kill`) and may carry its own flags, one
 * non-numeric operand per flag (`sudo -u me`, `xargs -I %`), `KEY=VALUE`
 * pairs, numeric/duration operands (`timeout 5`, `xargs -P 4`) or xargs' `{}`
 * placeholder); and a directory prefix on the binary itself (`/bin/kill`).
 * `\x60` is the backtick's char code, used so the source text itself never has
 * to carry a literal backtick.
 *
 * A flag's operand deliberately cannot start with `-`, a digit or `{`, so it
 * never overlaps the flag / numeric / `{}` alternatives beside it — overlap
 * there is what makes a long miss backtrack exponentially (see the flag note
 * inline). The one operand that MUST NOT be read as the binary is a signal
 * NAME: `timeout -s KILL 60 pnpm build` / `timeout --signal KILL …` bound a
 * build, they kill nothing themselves, so a `kill` token directly after
 * `timeout … -s|--signal` is excluded by a lookbehind (a real kill later in
 * the same segment still matches).
 *
 * UNLIKE {@link FORBIDDEN_DEP_COMMAND_PATTERN}, this is deliberately
 * POSITION-SENSITIVE rather than "matches anywhere in the string": "kill" is
 * ordinary English and a substring of common flags (`--kill-others`), other
 * command names (`skill`), inflected forms (`killed`), and quoted text (`echo
 * "kill the server first"`) that a position-blind pattern would false-positive
 * on constantly. A live-executed kill only does harm as the thing actually
 * run, so anchoring on command position is both necessary and sufficient here.
 *
 * Denies e.g. `lsof -ti :3000 | xargs kill -9` (kill in command position after
 * the `xargs` wrapper) and a bare `kill -9 1234`. Does NOT deny `--kill-others`,
 * `skill`, `killed`, a quoted "kill" inside `echo`, or `$VERIFY_DRIVER stop`
 * (no kill/pkill/killall token at all) — see dependencyCommandGuard.test.ts for
 * the full false-positive table.
 *
 * QUOTING IS NOT MODELLED HERE — callers go through {@link isProcessKillCommand},
 * which masks quoted DATA (`grep -E "error|kill" log`: the `|` inside the
 * quotes is not a pipe) and unwraps quoted CODE (`sh -c "kill -9 1"`: the
 * `-c` body IS a command line) before testing this pattern.
 */
export const PROCESS_KILL_COMMAND_PATTERN = new RegExp(
  [
    // Command position: start, a separator/grouping char, or a command-introducing reserved word.
    String.raw`(?:^|[;&|({!\x60\n]|\b(?:then|do|else|elif|if|while|until)\b)`,
    String.raw`\s*`,
    // Leading assignments (`FOO=1 kill …`).
    String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`,
    // Wrapper commands, each with its own flags / assignments / numeric operands / `{}`.
    // Flags are `-\S+`, never `-{1,2}\S+`: that spelling can split `--x` two ways,
    // so a run of n flags backtracks 2^n times on a miss (a 22-flag `xargs` took
    // 0.4 s, doubling per flag — adversarial-review fix).
    // A wrapper may be named by path (`/usr/bin/env`), and a flag may take ONE operand
    // that starts with none of `-`, a digit or `{` (`sudo -u me`, `xargs -I %`) — so it
    // can never overlap the numeric / `{}` alternatives and reintroduce that blow-up.
    String.raw`(?:(?:[^\s=]*/)?(?:sudo|doas|env|xargs|nohup|time|timeout|nice|command|builtin|exec|setsid)\b`,
    String.raw`(?:\s+(?:-\S+(?:\s+[^-\s;&|\d{]\S*)?|[A-Za-z_][A-Za-z0-9_]*=\S*|\d+(?:\.\d+)?[smhd]?|\{\}))*\s+)*`,
    // Not a signal NAME handed to `timeout -s|--signal` (`timeout -s KILL 60 pnpm build`).
    String.raw`(?<!\btimeout\b[^;&|\n]*\s-(?:s|-signal)\s+)`,
    // An optional directory prefix on the binary (`/bin/kill`) — never spanning an `=`,
    // so a bare `OUT=tmp/kill.log` assignment is not read as a kill.
    String.raw`(?:[^\s=]*/)?`,
    String.raw`(?:kill|pkill|killall)\b`,
  ].join(''),
  'i',
);

/**
 * Mask the quoted spans of a shell string that the shell treats as DATA, and
 * unwrap the ones it treats as CODE, so {@link PROCESS_KILL_COMMAND_PATTERN}'s
 * command-position anchors only ever land on something a shell would run.
 *
 *  - A quoted span right after a SHELL's `-c` flag (`sh -c "…"`, `bash -lc
 *    '…'` — only a shell's: `grep -c "kill" log` is a count) is a command
 *    line in its own right: its body is spliced back in between `;`
 *    separators (recursively masked in turn), so `sh -c "kill -9 1"` reads as
 *    `sh -c ; kill -9 1 ;`.
 *  - A double-quoted span carrying a command substitution (`$(` or a
 *    backtick) is kept as-is — `"$(kill 1)"` runs the kill.
 *  - Every other quoted span is replaced by an empty pair of the same quotes,
 *    so the `|` in `grep -E "error|kill" serve.log` is no longer a separator.
 *
 * Deliberately simple (no escape handling outside double quotes, no heredocs):
 * it exists to stop the obvious false positives and the obvious `sh -c`
 * bypass, not to parse Bash — see the module doc on the arms race.
 */
function maskQuotedShellData(command: string): string {
  return command.replace(
    /(\b(?:sh|bash|zsh|dash|ksh)(?:\s+-[A-Za-z]+)*?\s+-[A-Za-z]*c\s+)?('[^']*'|"(?:[^"\\]|\\.)*")/g,
    (_span: string, shellDashC: string | undefined, quoted: string): string => {
      const body = quoted.slice(1, -1);
      if (shellDashC) return `${shellDashC}; ${maskQuotedShellData(body)} ;`;
      if (quoted.startsWith('"') && (body.includes('$(') || body.includes('\x60'))) return quoted;
      return quoted[0] + quoted[0];
    },
  );
}

/**
 * THE check the Claude `canUseTool` handler runs for the A1.4 kill guard:
 * {@link PROCESS_KILL_COMMAND_PATTERN} over the command with its quoted data
 * masked and its `-c` bodies unwrapped ({@link maskQuotedShellData}).
 */
export function isProcessKillCommand(command: string): boolean {
  return PROCESS_KILL_COMMAND_PATTERN.test(maskQuotedShellData(command));
}

/**
 * The deny message for a blocked process-kill Bash command ({@link isProcessKillCommand}).
 *
 * Aligned with the explore contract's LEAVE_RUNNING_EXPLORE
 * (verifyHarnessContract.ts: "do not run "$VERIFY_DRIVER" stop … an unattested
 * run can never reach passed") — this guard only runs in explore mode, and the
 * deny text is the instruction the agent sees at the moment of action, so it
 * must never steer a routine end-of-session cleanup onto a stop that tears the
 * leased surface down before the harness attests it. `"$VERIFY_DRIVER" stop`
 * appears ONLY as the first half of a restart.
 */
export function forbiddenProcessKillDenyMessage(command: string): string {
  return [
    `Blocked: \`${command}\` stops a process directly (kill/pkill/killall).`,
    'Process lifecycle is harness-owned in explore mode: the scheduler leased the port, the simulator and the data dir',
    'for this request alone, and killing a process you did not start can take down the user\'s own running app or a',
    'sibling verification lane sharing the same host.',
    'Do not work around it (no sudo, no xargs, no alternate signal tool), and do not stop the serve or the app at all:',
    'the harness attests the LIVE surface after you finish and then tears it down itself, so leave it running when you',
    'finish. To replace a broken serve you started, run "$VERIFY_DRIVER" stop immediately followed by "$VERIFY_DRIVER"',
    'serve again — never a stop on its own. If something you did not start is in your way, report outcome',
    '"unverifiable" naming it in your diagnosis instead.',
  ].join(' ');
}

/**
 * `[xcrun] simctl`, simctl's own flags, and the whitespace up to the SUBCOMMAND
 * — so every {@link SIMCTL_LIFECYCLE_DENY_PATTERN} alternative anchors on the
 * same token. `--set` takes a path, and is the ONLY spelling the generic flag
 * arm refuses (`-(?!-set\b)`): were `--set` also a bare flag, its path could
 * be read as the subcommand and `simctl --set d list devices booted` would
 * dodge the `list` exemption's anchor. The trailing lookahead pins the match to
 * the start of the subcommand token, not a later offset inside the whitespace.
 */
const SIMCTL_PREFIX = String.raw`\b(?:xcrun\s+)?simctl(?:\s+--set\s+\S+|\s+-(?!-set\b)\S+)*\s+(?![\s-])`;

/**
 * A1.4 explore guard #2, mobile modality only
 * (docs/proposals/runbook-optional-verification.md "A1.4 Explore guardrails" →
 * "Structural guards (RS-8)": "On mobile, Claude `canUseTool` denies `xcrun
 * simctl` install / launch / boot / create / delete / shutdown / erase /
 * uninstall"). Denies `xcrun simctl <verb>` or a bare `simctl <verb>` for the
 * lifecycle verbs install/launch/boot/create/delete/shutdown/erase/uninstall/
 * terminate. The leased simulator's lifecycle is harness-owned (the driver's
 * own mobile-install / mobile-launch), so a verification step never touches it
 * directly.
 *
 * `terminate` is included even though `runbookStore.ts`'s REGISTRATION-time,
 * unexported `SIMCTL_LIFECYCLE_PATTERN` omits it: that check exists to keep a
 * COMMITTED runbook build step from hardcoding simulator management, while
 * this one runs live against whatever the agent just typed — and `simctl
 * terminate` kills the very app instance the harness just leased and may be
 * mid-attestation on, so it belongs in the live guard even though it never
 * belonged in a build step in the first place.
 *
 * TARGETING `booted` OR `all` IS DENIED TOO, whatever the subcommand (design
 * A1.4: "SIMCTL_LIFECYCLE_PATTERN plus erase|uninstall|all|booted"; the
 * explore contract: "never target \"booted\""). `booted` is not a verb — it
 * is simctl's "whichever simulator happens to be booted" device alias, and
 * with a sibling lane's (or the developer's own) simulator booted it resolves
 * to a device this request never leased, so `xcrun simctl io booted
 * screenshot x.png` or `openurl booted myapp://…` observes or drives the wrong
 * device, and that evidence could back a pass on a surface the harness never
 * leased. Denied anywhere after `simctl` except under `list` (where `booted`
 * is a read-only search term). `all` is denied only in the DEVICE position —
 * the first operand after the subcommand (`shutdown all`, `erase all`) —
 * because elsewhere it is an ordinary operand (`privacy $VERIFY_SIM_UDID grant
 * all com.x` is a permission grant on the leased device).
 *
 * Flags between `simctl` and its subcommand are tolerated (`xcrun simctl
 * --set <dir> boot X` — `--set` is simctl's device-set option and takes a
 * path), so a flag can no longer carry a lifecycle verb past the guard.
 *
 * Unlike {@link PROCESS_KILL_COMMAND_PATTERN} this matches ANYWHERE in the
 * command (mirroring {@link FORBIDDEN_DEP_COMMAND_PATTERN}'s style): "xcrun
 * simctl" is not ordinary English or a common flag fragment, so there is no
 * false-positive pressure that would justify command-position anchoring.
 */
export const SIMCTL_LIFECYCLE_DENY_PATTERN = new RegExp(
  [
    // (a) a lifecycle subcommand, after simctl's own flags if any.
    String.raw`${SIMCTL_PREFIX}(?:install|launch|boot|create|delete|shutdown|erase|uninstall|terminate)\b`,
    // (b) `booted` / `all` as the device operand of any subcommand but `list`.
    String.raw`${SIMCTL_PREFIX}(?!list\b)[\w-]+(?:\s+-\S+)*\s+(?:booted|all)(?![\w-])`,
    // (c) `booted` anywhere later in the same command segment, except under `list`.
    String.raw`${SIMCTL_PREFIX}(?!list\b)[^;&|\n]*\sbooted(?![\w-])`,
  ].join('|'),
  'i',
);

/** The deny message for a blocked simctl-lifecycle Bash command ({@link SIMCTL_LIFECYCLE_DENY_PATTERN}). */
export function forbiddenSimctlLifecycleDenyMessage(command: string): string {
  return [
    `Blocked: \`${command}\` manages the simulator or app lifecycle directly, or targets a device other than the leased one.`,
    'Install/launch/boot/create/delete/shutdown/erase/uninstall/terminate on the leased simulator are harness-owned —',
    'the driver\'s own mobile-install / mobile-launch commands — never a verification step\'s job, and running one',
    'yourself can tear down a sibling lane\'s simulator or the very app the harness just attested.',
    'Target only the leased device by its UDID ($VERIFY_SIM_UDID) — never "booted" or "all", which can resolve to a',
    'sibling lane\'s or the user\'s own simulator.',
    'Do not work around it: use only the driver\'s verbs, or report outcome "unverifiable" if the leased simulator',
    'will not cooperate.',
  ].join(' ');
}
