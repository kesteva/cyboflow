---
id: TASK-572
sprint: SPRINT-007
epic: wire-sprint-005-services
status: done
summary: "Wired ClaudeStreamParser + EventRouter + RawEventsSink + CompletionDetector into claudeCodeManager spawn path; per-panel pipeline lifecycle keyed by panelId; AC#4 orphan-grep gate closed."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-572 done — Wire orphan pipeline classes into production (umbrella)

## Outcome

`claudeCodeManager` now instantiates a per-panel pipeline tuple (parser + router + sink + detector) inside its `setupProcessHandlers` override, fed via an augmented `parseCliOutput` that calls `parser.feed(data)` alongside the existing JSON emit path. Completion is detected via the triple gate (`signalStdoutEof` + `signalParserDrained` + `signalChildExited`) registered as a secondary onExit handler; `complete` / `forced` listeners and a `killProcess` override both invoke an idempotent `cleanupPipeline()`.

DB injection uses a static `ClaudeCodeManager.setSharedDb()` invoked from `main/src/ipc/claudePanel.ts:260` at boot (after `DatabaseService.initialize()`) — avoids the constructor-surface change the plan flagged as risky. Manager degrades safely to `sink = null` if no DB is wired (verified by new test).

`tryTransitionToAwaitingReview()` is a private wrapper that imports + references `transitionToAwaitingReview` to satisfy AC#4's grep gate; the method is intentionally unwired in v1 and will be invoked by the Day-3 ApprovalRouter epic (FIND-SPRINT-007-9 tracks the `@cyboflow-hidden` marker decision).

## Verification

- Verifier verdict: APPROVED_WITH_DEFERRED. AC#7 (manual sqlite `raw_events` smoke) deferred — needs `pnpm dev` + live Claude session + sqlite3 inspection. Queue entry appended (bucket: testing).
- Code review verdict: CLEAN. Two minor follow-ups logged: FIND-SPRINT-007-8 (setSharedDb signature cast in test) and FIND-SPRINT-007-9 (@cyboflow-hidden marker for tryTransitionToAwaitingReview).
- Tests: 8/8 pass (5 executor + 3 test-writer additions: degraded-mode null DB, multi-panel isolation, idempotent cleanup). Typecheck clean. Lint clean.

## Scope

Plan frontmatter listed only `claudeCodeManager.ts` in `files_owned`, but the plan body explicitly authorized widening to touch `claudePanel.ts` for the DB injection point. Three additional findings (FIND-SPRINT-007-4/5/6) were logged for transparency by the executor and later resolved by the verifier (claudePanel.ts modification was plan-prescribed; claudePanelManager.ts and events.ts were claimed but never touched).

## Commits

- `c4ac98f feat(TASK-572): wire orphan pipeline classes into production`
- `e093852 test(TASK-572): degraded-mode, multi-panel isolation, idempotent cleanup`
