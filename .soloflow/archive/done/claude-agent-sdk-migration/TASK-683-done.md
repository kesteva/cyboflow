---
id: TASK-683
sprint: SPRINT-026
epic: claude-agent-sdk-migration
status: done
summary: "SDK-migration epic verification gate: programmatic deletion/survival/isolation/typecheck/lint gates pass; manual UI smokes deferred to human review; synthetic run_started kept (path B); stale 'epic 7+' comment patched."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-683 — Done

Final acceptance gate for the `claude-agent-sdk-migration` epic. The task is verification-driven — only a 3-line stale-comment patch in `runLauncher.ts` and a dated verification report appended to `docs/sdk-migration-smoke-results.md`. No production code logic changed. Per the plan's Hardest Decision, **path B** is selected: the synthetic `run_started` emission in `runLauncher.ts` is preserved as a UI-bootstrap aid, with a `// KEEP:` comment now documenting the rationale.

## AC summary
- **Programmatic ACs (12 PASS / 2 pre-existing FAIL):**
  - PASS — AC#1 SDK dep declared (^0.2.141). AC#2 bridge build script absent. AC#3 four parser files deleted (lineBufferer, jsonParser, streamParser, completionDetector). AC#4 `__fixtures__` corpus absent. AC#5 four survivors present (eventRouter, messageProjection, rawEventsSink, typedEventNarrowing). AC#6 permissionManager isolation (file no longer exists; only docstring refs in mcpConfigWriter and runLauncher). AC#7 `epic 7+` comment gone. AC#8 synthetic-event decision recorded (path B + 'Synthetic run_started decision' subsection in smoke results). AC#9 typecheck. AC#10 lint. AC#19 runLauncher.test.ts 21/21 green. AC#20 dated verification report appended.
  - FAIL (pre-existing, reproduces at base) — AC#11 `pnpm test:unit` (5 cases: 4 in runExecutor.test.ts, 1 in cyboflowSchema.test.ts) and AC#12 `pnpm test` Playwright (cyboflow-day3-gate.spec.ts imports vitest in a Playwright-collected file). Both reproduce identically at HEAD~3 — confirmed orthogonal to TASK-683. Tracked as FIND-SPRINT-026-9, -10.
- **Manual smokes (AC#13-#18):** Deferred to human review. 6 entries appended to `.soloflow/human-review-queue.md` (bucket: testing) and templated checklists added to `docs/sdk-migration-smoke-results.md` §Manual Smokes (lines ~820-928). AC#17 (workflow real-events) is severity HIGH per its goal_backward level.

## Changes
- `main/src/orchestrator/runLauncher.ts` — replaced stale `// Wiring proof: ... epic 7+` comment with a 3-line `// KEEP:` comment explaining the synthetic `run_started` emission rationale (50-500ms UI bootstrap gap; RunExecutor is wired; retained as UX aid). Synthetic publish at line 146 preserved.
- `docs/sdk-migration-smoke-results.md` — appended `## Verification — 2026-05-20 (TASK-683)` section with: metadata, prerequisite checks, deletion/survival/isolation/static/sibling-test results, synthetic-event decision (path B with rationale), stale-comment patch before/after, templated checklists for 6 deferred manual smokes, summary table, outstanding follow-ups.
- `.soloflow/human-review-queue.md` — 6 entries appended by the orchestrator post-verifier (bucket: testing) once the wiring gap (FIND-SPRINT-026-12) was identified.

## Verification
- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0 (0 errors, 208 pre-existing warnings).
- `pnpm --filter main exec vitest run main/src/orchestrator/__tests__/runLauncher.test.ts` — 21/21 pass.
- `pnpm test:unit` — pre-existing failures (FIND-SPRINT-026-10 covers runExecutor.test.ts; cyboflowSchema.test.ts failure also pre-existing, reproduces at base).
- `pnpm test` (Playwright) — pre-existing failure (FIND-SPRINT-026-9: cyboflow-day3-gate.spec.ts imports vitest in a Playwright-collected test).

## Findings
- FIND-SPRINT-026-9 (logged): Playwright/vitest incompatibility in `tests/cyboflow-day3-gate.spec.ts`.
- FIND-SPRINT-026-10 (logged): pre-existing `runExecutor.test.ts` failures (4 cases).
- FIND-SPRINT-026-11 (logged): future improvement — instrument first-real-event latency programmatically so the synthetic event can be removed when p95 < 100ms.
- FIND-SPRINT-026-12 (logged → resolved by orchestrator): 6 human-review-queue entries for the deferred smokes were initially missing; appended via `review-queue.js append`.
- FIND-SPRINT-026-13 (logged): AC#6 grep target file `permissionManager.ts` no longer exists — passes vacuously; AC should be rewritten in a future task to assert against the actual current permission-manager structure.
- FIND-SPRINT-026-14 (logged): docs/queue cross-reference gap (templated checklists in docs not anchored to queue entry IDs). Recommended fix: emit each queue entry's stable ID into the docs checklists.

## Visual
- `visual_mobile: skipped_user_preference` — visual_mobile=false in config.
- `visual_web: not_applicable` — autonomous portion is a 3-line comment patch + docs append; no UI surface to verify autonomously. The end-to-end visual verification IS the 6 deferred manual smokes (AC#13-#18), which require a human reviewer. visual_macos similarly N/A for the autonomous portion.

## Commits
- a18e1c7 — fix(TASK-683): replace stale 'epic 7+' comment with KEEP rationale (path B)
- 01567d5 — fix(TASK-683): compress KEEP comment to fit AC#8 'within 5 lines' constraint
- 5a46f84 — docs(TASK-683): append dated verification report for TASK-683 SDK migration gate

Plus orchestrator-driven post-verifier action: review-queue.js append (6 deferred-smoke entries).
