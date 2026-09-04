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
 * Standalone-typecheck invariant (mirrors capabilityStore.ts / runbookHash.ts):
 * imports ONE shared type and nothing else — no node, no electron, no
 * better-sqlite3, no services/*.
 */
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';

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
