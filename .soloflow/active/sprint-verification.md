---
sprint: SPRINT-021
visual_mobile: not_applicable
visual_web:    not_applicable
visual_macos:  not_applicable
regressions_count: 0
flows_tested: 0
flows_deferred: 0
---

# Sprint Verification — SPRINT-021

**Sprint:** SPRINT-021 (orchestrator-and-trpc-router — IDEA-018 wiring gaps)
**Base SHA:** ab751d4f98bee772435c4bc82fd5e8df45c04271
**Branch:** soloflow/run-20260519-123731-SPRINT-021
**Completed tasks:** TASK-650, TASK-651, TASK-652, TASK-660, TASK-661, TASK-662

## Visual Verification (Pass 1)

All three platforms are `not_applicable`. Rationale: this sprint is pure backend wiring inside `main/src/orchestrator/**` and `main/src/services/panels/claude/claudeCodeManager.ts` plus the `main/src/index.ts` composition root. The full set of changed source files is confined to `main/src/`:

- `main/src/index.ts`
- `main/src/orchestrator/markdownFrontmatter.ts` (new)
- `main/src/orchestrator/preToolUseHookHelper.ts` (new)
- `main/src/orchestrator/permissionModeMapper.ts`
- `main/src/orchestrator/runEventBridge.ts`
- `main/src/orchestrator/runExecutor.ts`
- `main/src/orchestrator/runLauncher.ts`
- `main/src/orchestrator/workflowPromptReader.ts`
- `main/src/orchestrator/workflowRegistry.ts`
- `main/src/services/panels/claude/claudeCodeManager.ts`
- main/src/orchestrator/__tests__/*.ts (new + extended unit tests)
- main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts (new)

No `frontend/` files, no renderer code, no IPC contract widened toward the renderer, no UI surface area touched. The RunExecutor changes (TASK-650/661/662) and approval-router helper (TASK-651) are entirely main-process internal. The markdown frontmatter helper (TASK-652) and RunLauncher SDK guard (TASK-660) are pure refactor + invariant additions that produce no user-visible behaviour change.

- **visual_mobile** = not_applicable (no UI changes; also disabled in config)
- **visual_web** = not_applicable (no UI changes)
- **visual_macos** = not_applicable (no UI changes; no Peekaboo flow would be informative since the Electron app's visual surface is unchanged)
- **Flows tested:** 0
- **Flows deferred:** 0

## Integration Tests (Pass 2)

Ran the full automated suite. All gates pass at the sprint tip.

### typecheck (root, all workspaces)
- `pnpm typecheck` — PASS (frontend, shared, main; no errors)

### lint (root, all workspaces)
- `pnpm lint` — PASS
  - main: 212 warnings, 0 errors (pre-existing baseline)
  - frontend: 306 warnings, 0 errors (pre-existing baseline)
  - No new lint errors introduced by sprint changes

### Unit tests
- `pnpm --filter main test` — PASS — 466/466 tests across 47 files, 1.98s
  - New/extended files green:
    - `orchestrator/__tests__/runExecutor.test.ts` — 25 tests
    - `orchestrator/__tests__/runLauncher.test.ts` — 21 tests
    - `orchestrator/__tests__/runEventBridge.test.ts` — 14 tests
    - `orchestrator/__tests__/markdownFrontmatter.test.ts` — 7 tests (new)
    - `orchestrator/__tests__/preToolUseHookHelper.test.ts` — 6 tests (new)
    - `services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts` — 4 tests (new)
- `pnpm --filter frontend test` — PASS — 209/209 tests across 17 files, 3.30s
  - No frontend regressions; this sprint did not touch frontend code, so this is a no-change baseline confirmation.

### Build gates
- `pnpm test:build` — PASS (afterSign + configure-build, both unsigned and signed posture cases)
- `pnpm test:gate` — PASS (Day-3 gate: two runs in different workflows can be approved out of order, 11.8s)
  - This is the canonical cross-workflow approval-router integration test. It exercises RunLauncher + ApprovalRouter + WorktreeManager end-to-end, which directly stresses the wiring TASK-660 changed.
- `pnpm build:main` — PASS (tsc + asset copy)

### E2E (Playwright)
Not run. CLAUDE.md does not mandate an E2E gate for backend-only orchestrator wiring changes, and `playwright_target.kind = electron` with no UI-touching files makes the Playwright smoke suite non-additive over the unit + gate suites already passing.

## Cross-task wiring spot-check

Reviewed the `main/src/index.ts` composition root (lines 595–651) for the six-task integration surface:

- TASK-650 (RunExecutor cancel/teardownRun/bridge handle map/preToolUseHook) — Wired via the new `defaultCliManager` source argument (RunExecutor constructor arg 8) so `bridgeEvents()` can call `.on('output')` on the spawner.
- TASK-651 (routePreToolUseThroughApprovalRouter shared helper) — Both call sites (`claudeCodeManager.makePreToolUseHook` and `permissionModeMapper.deferToApprovalRouter`) delegate via `makeLoggerLike()` adapter. No call-site duplication remains.
- TASK-652 (parseMarkdownFrontmatter shared helper) — Both `workflowPromptReader.readWorkflowPrompt` and `WorkflowRegistry.extractPermissionMode` consume the helper. Index.ts:603 wires `readWorkflowPrompt` as the concrete `WorkflowPromptReaderLike`.
- TASK-660 (RunLauncher SDK-guard + placeholder RunExecutor) — `RunLauncher` constructor now receives the concrete `runExecutor` at index.ts:650; the `!runExecutor` branch (legacy permission-bridge) is correctly gated and unreachable in production from this commit forward.
- TASK-661 (WorkflowPromptReaderLike injection + system_prompt_append threading) — `spawnerAdapter` at index.ts:610 wraps `defaultCliManager.spawnCliProcess` so `system_prompt_append` flows through `ClaudeSpawnOptions`. `promptReader` is the real `readWorkflowPrompt` adapter.
- TASK-662 (onFirstMessage callback + LifecycleTransitionsLike injection) — `lifecycleTransitions` at index.ts:618–624 maps the four transitions (running/completed/failed/canceled) to `services/cyboflow/transitions` helpers; the executor fires them inside its try/catch/finally per FIND-SPRINT-021-1 resolution. The `source` EventEmitter constructor arg (index.ts:637) supplies `defaultCliManager` for `runEventBridge` wiring.

The six tasks compose into a coherent dependency graph: spawner → executor → launcher, with reader / lifecycle / publisher / source as orthogonal injected dependencies. No circular or contradictory wiring. No data shape that one task produces is consumed in an incompatible way by another task.

## Regressions

**None.**

The three existing findings in `.soloflow/active/findings/SPRINT-021-findings.md` are:
- FIND-SPRINT-021-1 — resolved by TASK-662 itself (the try/catch/finally fix is in `runExecutor.ts:198-219` with a pinning test at `runExecutor.test.ts:662`).
- FIND-SPRINT-021-2 — open, severity low, docstring drift in `markdownFrontmatter.ts:6` and `workflowRegistry.ts:10-12`. Cosmetic only; behavior and tests are correct. Not a sprint-level regression.
- FIND-SPRINT-021-3 — open, severity low, `promptReader` constructor parameter is optional (`?`) instead of required as the TASK-661 plan AC2 literally specified. Spirit-of-the-AC is met (concrete reader wired at production site index.ts:603; sentinel error pins the contract via a new test). Not a sprint-level regression — this is a deviation in the test surface, not in production behavior.

None of these block sprint closure. They are per-task findings already queued for follow-up in the existing findings file.

## Verdict

PASS. No new entries appended to `.soloflow/human-review-queue.md`. The sprint is ready for the closer.
