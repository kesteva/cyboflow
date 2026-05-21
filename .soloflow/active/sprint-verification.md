---
sprint: SPRINT-027
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_unable
visual_mobile_note: "verification.visual_mobile=false in resolved config"
visual_web_note: "Playwright MCP cannot reach Electron renderer at localhost:4521 (preload-injected electronTRPC; not running); known queued gap visual_web_electron_unreachable"
visual_macos_note: "Peekaboo MCP available with Screen Recording grant but Accessibility permission not granted (blocks click/type/menu/hotkey); Electron app not running"
regressions_count: 0
flows_tested: 0
flows_deferred: 2
---

# Sprint Verification — SPRINT-027

- **Sprint:** SPRINT-027
- **Base SHA:** 8a5c4130b9878c6893bf28bf89a1201ca2339ccc
- **Run branch:** soloflow/run-20260520-172941-SPRINT-027
- **HEAD:** 83f465c chore(TASK-680): done
- **Completed tasks (9):** TASK-671, TASK-673, TASK-674 (dup of -671), TASK-675, TASK-676, TASK-677, TASK-678, TASK-679, TASK-680

## Pass 1 — Visual Verification

### Settings Gate
- `verification.visual_mobile` = `false` → `skipped_user_preference`
- `verification.visual_web` = `true` → proceed to tooling probe
- `verification.visual_macos` = `true` → proceed to tooling probe
- `verification.visual_prefer_playwright` = `false` → standard platform routing

### Tooling Probes
- **Playwright MCP (web):** Bound. Target `kind=electron` per `sprint.json`. `curl http://localhost:4521` → connection refused; `mcp__playwright__browser_navigate` → `net::ERR_CONNECTION_REFUSED`. Electron renderer cannot bootstrap standalone (depends on preload-injected `electronTRPC`); requires either (a) full `pnpm dev` already running or (b) CDP-attach launcher (neither present in this verifier context).
- **Peekaboo MCP (macOS):** Bound. `mcp__peekaboo__list(server_status)` reports CLI 2.0.3 present, Screen Recording grant **✅**, Accessibility **❌ not granted**. Image capture would succeed but `click`/`type`/`menu`/`hotkey` actions are blocked by missing Accessibility. Electron app is not running.
- **Maestro (mobile):** N/A — `visual_mobile=false`.

### Candidate Flows (had tooling been available)
Inferred from sprint changeset surfaces:
1. **Terminal-panel add flow** (TASK-680): SessionView/ProjectView → invoke `useAddTerminalPanel` hook (shortcut/menu) → new terminal panel mounts. Regression risk: hook extracted from inline implementations in both views; verify single-source behaviour parity.
2. **Terminal-panel cwd rendering** (TASK-677): Open terminal panel with cwd-aware initialization (`TerminalPanel.tsx`); confirm unsafe cast replacement preserves type-narrowed cwd flow.

Both flows deferred (counted in `flows_deferred: 2`). They are blocked by the same structural gap already catalogued in the human-review-queue (`visual_web_electron_unreachable`, last reaffirmed SPRINT-015). No new queue entries emitted (existing dedup keys cover this).

### Visual Verdict
- visual_mobile: `skipped_user_preference`
- visual_web: `skipped_unable`
- visual_macos: `skipped_unable`

## Pass 2 — Integration Tests (full suite, run inline)

Delegated integration-tester not available as a sub-agent in this environment; equivalent automated checks executed inline.

### `pnpm test:unit` — full vitest + schema + build tests
- **main vitest:** 54 files / 564 tests → **53 pass / 1 FAIL** (1 pre-existing failure, see below)
- **frontend vitest:** 19 files / 259 tests → **ALL PASS**
- **`pnpm run verify:schema`:** PASS (schema parity)
- **`node scripts/__tests__/verify-schema-parity.test.js`:** PASS (3/3 drift detection cases)
- **`pnpm run test:build`:** PASS (Case A unsigned + Case B signed postures)

### `pnpm run typecheck` (full workspace)
- frontend: PASS
- shared: PASS (no TypeScript files)
- main: PASS

### `pnpm run lint` (full workspace)
- PASS — 307 warnings, **0 errors** (all warnings are pre-existing react-hooks/no-console/no-unused-vars patterns; none introduced by sprint tasks).

### `pnpm test` (Playwright Electron E2E)
- **Skipped** by tooling availability: same `visual_web_electron_unreachable` gate. The `tests/*.spec.ts` suite requires a running Electron renderer at `localhost:4521`.

### Pre-existing failure (NOT a sprint regression)
- **Test:** `main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts > ClaudeCodeManager.killProcess > killProcess mid-stream clears pipelines, sdkRuns, and processes maps`
- **Symptom:** times out at 5000ms.
- **Regression check:** Reproduced at base SHA `8a5c4130b9878c6893bf28bf89a1201ca2339ccc` (with sprint changes reverted on `main/`). Identical timeout, identical signature — **predates SPRINT-027**.
- **Sprint touchpoint:** TASK-673 modified `main/src/services/cliManagerFactory.ts` (the only sprint commit landing in `main/src/services/panels/claude/` was TASK-673's *test-file additions to `claudeCodeManagerWiring.test.ts`*, not the killProcess test). The killProcess test instantiates `ClaudeCodeManager` directly and never routes through `CliManagerFactory.createManager`, so the duck-type guard cannot affect it.
- **Already documented:** `.soloflow/active/findings/SPRINT-027-findings.md` FIND-SPRINT-027-2 (TASK-673 verifier) and FIND-SPRINT-027-3 (TASK-676 verifier, noting duplicate of -2). No new queue entry created — duplicate suppressed.

### Security hardening — confirmed effective
- **TASK-678 (gitDiffManager shell injection):** Adversarial filename injection tests pass; `/tmp/cyboflow-gitdiff-pwned` marker NOT created post-run.
- **TASK-679 (runGit shell-free wrapper):** Adversarial injection tests pass; `/tmp/cyboflow-rungit-pwned` marker NOT created post-run. (One log line `fatal: ambiguous argument '$(touch /tmp/cyboflow-rungit-pwned)'` is the expected stderr from `git`'s arg-parser confirming the literal string was passed as a positional arg, never expanded by a shell.)

## Cross-Task Interaction Check (manual review)

Verified each touched code path for cross-task collisions:
- **TASK-677 ↔ TASK-680:** `hasCwdString` shared guard (TASK-677) is consumed by `TerminalPanel.tsx`; `useAddTerminalPanel` (TASK-680) instantiates terminal-panel state via the same shared types — frontend test `useAddTerminalPanel.test.tsx` (11 tests) PASS, confirms compatibility.
- **TASK-679 (runGit helper) ↔ TASK-678 (gitDiffManager):** Both touch git invocation surfaces. TASK-679 migrated 4 sites in `ipc/file.ts` + `commitManager.ts` and intentionally left TODO(TASK-680) trail across 6 other files (`ipc/git.ts`, `ipc/dashboard.ts`, `services/gitDiffManager.ts`, `services/executionTracker.ts`, `services/gitStatusManager.ts`). Those TODOs are documented future debt (not in sprint scope per the plan). Reviewed: 15 TODO(TASK-680) comments present; `runGit.test.ts` (12 tests) PASS.
- **TASK-676 (rawEvents fixture move) ↔ rawEventsSink consumers:** `rawEventsSink.test.ts` (8 tests) PASS via canonical `__test_fixtures__/` path; no stale `__fixtures__/` reference found in git-tracked sources.
- **TASK-673 (CliManagerFactory guard) ↔ ClaudeCodeManager wiring:** `claudeCodeManagerWiring.test.ts` (10 tests) PASS including 4 new duck-type guard cases (empty options, undefined options, wrong-shape db object, primitive-string db).
- **TASK-671/-675 (test-only assertion flips):** No production-code interaction surface.

## Regressions Requiring Attention
**None introduced by SPRINT-027.** The single failing vitest (`killProcess mid-stream`) is reproducible at base SHA and is already captured in `.soloflow/active/findings/SPRINT-027-findings.md`.

## Deferred Visual Flows (counted in `flows_deferred`)
Both flows are blocked by structural Electron renderer unreachability already queued. Human action would require either (a) launching `pnpm dev` in a separate process so the renderer is reachable, then re-running the verifier, or (b) accepting visual verification gap per the existing visual_web_electron_unreachable entry.

1. Terminal-panel add flow via `useAddTerminalPanel` (TASK-680) — `ProjectView` & `SessionView` keyboard shortcut & menu invocation.
2. Terminal-panel cwd-aware open (TASK-677) — confirms unsafe cast replacement preserves rendering.

## Outcome
**PASS** — Sprint clean of cross-task regressions. All unit tests, schema-parity tests, build tests, typecheck, and lint pass on HEAD. The lone failing test is a pre-existing condition reproducible at base SHA, unrelated to any sprint task, and already documented by the per-task verifiers in this sprint's findings.
