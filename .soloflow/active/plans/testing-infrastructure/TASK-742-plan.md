---
id: TASK-742
idea: SPRINT-035-compound
status: in-flight
created: "2026-05-23T12:00:00Z"
files_owned:
  - package.json
  - CLAUDE.md
  - docs/ARCHITECTURE.md
  - AGENTS.md
  - CONTRIBUTING.md
files_readonly:
  - playwright.config.ts
  - playwright.ci.config.ts
  - playwright.ci.minimal.config.ts
  - tests/smoke.spec.ts
  - tests/health-check.spec.ts
  - tests/cyboflow-picker.spec.ts
  - tests/cyboflow-stream-publisher.spec.ts
  - tests/standalone-terminal-panels.spec.ts
  - tests/permissions-ui-fixed.spec.ts
  - tests/git-status.spec.ts
  - docs/VISUAL-VERIFICATION-SETUP.md
  - .github/workflows/quality.yml
acceptance_criteria:
  - criterion: "`package.json` no longer has a `\"test\": \"playwright test\"` script. The root `test` script either no longer exists OR maps to a clear vitest entry point."
    verification: "node -e \"const pkg = require('./package.json'); if (pkg.scripts.test === 'playwright test') process.exit(1); else process.exit(0)\" exits 0 (i.e. scripts.test is NOT the literal string 'playwright test')"
  - criterion: "A `test:e2e` script exists that invokes Playwright directly."
    verification: "node -e \"const pkg = require('./package.json'); if (!pkg.scripts['test:e2e'] || !pkg.scripts['test:e2e'].includes('playwright test')) process.exit(1)\" exits 0"
  - criterion: "`pnpm test:unit` (the existing multi-tier script) still exists and is unchanged in semantics."
    verification: "grep -n '\"test:unit\":' package.json shows the existing pnpm --filter main test && pnpm --filter frontend test chain"
  - criterion: "Every prose mention of `pnpm test` (referring to the root script) in the four owned docs files is replaced with `pnpm test:e2e` (when meaning Playwright) or `pnpm test:unit` (when meaning unit tests) — whichever matches the original intent."
    verification: "grep -nE \"pnpm test(\\s|$|\\.)\" CLAUDE.md docs/ARCHITECTURE.md AGENTS.md CONTRIBUTING.md returns 0 hits (each match must have been disambiguated to test:e2e or test:unit; this grep matches `pnpm test` followed by whitespace, end-of-line, or period, which excludes `pnpm test:unit` / `pnpm test:e2e` / `pnpm test:gate`)"
  - criterion: "`pnpm test:e2e -- tests/smoke.spec.ts --list` exits 0 (Playwright runner is reachable through the new name — `--list` flag does NOT execute tests, just lists them, so it works even when the renderer can't bootstrap)."
    verification: "pnpm test:e2e -- tests/smoke.spec.ts --list exits 0 (verifier: this is a smoke check that the script wiring works — actual e2e bootstrap remains broken pending option (b) of the proposal, which is explicitly out of scope here)"
  - criterion: "`pnpm test:unit` still exits 0 (no regression in the unit-test multi-tier chain)."
    verification: "pnpm test:unit exits with code 0"
  - criterion: "No CI config under `.github/workflows/` is broken (the existing workflow uses `pnpm test:ci:minimal`, not `pnpm test`)."
    verification: "grep -nE \"pnpm test(\\s|$|\\.)\" .github/workflows/quality.yml returns 0 hits (the workflow already uses `pnpm test:ci:minimal`, which is unaffected by this change)"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This is a script-rename + docs-disambiguation task. No production code changes; no test file changes. The success signal is that (a) `pnpm test:e2e -- --list` can reach Playwright through the new name, (b) `pnpm test:unit` still works, (c) prose references no longer say `pnpm test` ambiguously. Sibling-test scan: the owned files are package.json + 4 docs files; none of them have sibling test files in their directories (package.json has no neighbor *.test.ts, docs/ contains only Markdown). The reachable Playwright suite under tests/ is in files_readonly — this task does not edit specs, only the script name pointing at them."
---
# Fix `pnpm test` / Playwright bootstrap ambiguity in root script

## Objective

`pnpm test` currently runs `playwright test`, which (per `playwright.config.ts:42-47`) launches `pnpm electron-dev` and points `baseURL` at `http://localhost:4521`. The Vite renderer at that URL **cannot bootstrap standalone** — it depends on Electron's `preload`-injected `electronTRPC` (CLAUDE.md, "Visual verification" section). Specs that hit the URL therefore fail consistently; verifiers either rubber-stamp the failures as "pre-existing" or compare against the parent commit. The compound proposal lays out three options. **This task takes option (a) — rename the root `test` script to disambiguate intent — because it is the smallest mechanical change that eliminates the ambiguity, and because the underlying e2e-bootstrap fix (option b: use `_electron.launch()` per `docs/VISUAL-VERIFICATION-SETUP.md`) is a separate, larger task that the testing-infrastructure epic can pick up next.**

After this task:
- `pnpm test` is **not a defined script** (or, optionally, an alias to `pnpm test:unit` for muscle-memory ergonomics — see Hardest Decision).
- `pnpm test:e2e` invokes Playwright directly.
- `pnpm test:unit` continues to invoke the existing multi-tier unit-test chain.
- All prose references in `CLAUDE.md`, `docs/ARCHITECTURE.md`, `AGENTS.md`, and `CONTRIBUTING.md` are disambiguated.

The actual Playwright bootstrap remains broken — that is option (b)'s scope, deferred.

## Implementation Steps

1. **Pre-flight grep — catalog all prose references.** Run the sweep that will be the executor's completeness gate:
   ```
   grep -rnE "pnpm test(\s|$|\.)" CLAUDE.md docs/ARCHITECTURE.md AGENTS.md CONTRIBUTING.md
   ```
   This is the authoritative list of references to fix. Each match must be classified before editing as `unit-test intent` or `e2e-test intent`; the classification table below covers the known sites at refinement time.

2. **Edit `package.json` scripts.** Two-line change:
   - Remove `"test": "playwright test",` (line 52).
   - Add `"test:e2e": "playwright test",` adjacent to the other `test:*` scripts (after `test:headed` and before `test:build`).
   - **Do NOT** add a `test` alias yet — see Hardest Decision; absence-of-`test` is the desired state because muscle-memory of "pnpm test = Playwright" is the bug we're eliminating.
   - The existing `test:ci`, `test:ci:minimal`, `test:ui`, `test:headed`, `test:build`, `test:unit`, `test:gate` scripts are all unchanged.

3. **Edit `CLAUDE.md`:**
   - Line 31: `pnpm test              # Playwright E2E` → `pnpm test:e2e          # Playwright E2E` (column-align the comment).
   - Line 38: the long sentence references `"pnpm run test:unit"` already — verify it stays correct after the script rename. It does (no edit needed).
   - Any other `pnpm test` hit in CLAUDE.md from the pre-flight grep — disambiguate to `pnpm test:e2e` or `pnpm test:unit` based on context.

4. **Edit `docs/ARCHITECTURE.md`:**
   - Line 242 (matched by pre-flight grep): `pnpm test                 # Playwright E2E (requires a built app)` → `pnpm test:e2e             # Playwright E2E (requires a built app)`. Preserve the comment-column alignment.

5. **Edit `AGENTS.md`:**
   - Line 13: `Tests (E2E): \`pnpm test\`, \`pnpm test:ui\`, CI configs in \`playwright.ci*.config.ts\`.` → `Tests (E2E): \`pnpm test:e2e\`, \`pnpm test:ui\`, CI configs in \`playwright.ci*.config.ts\`.`
   - Line 23: `Example: \`pnpm test -- tests/smoke.spec.ts\`.` → `Example: \`pnpm test:e2e -- tests/smoke.spec.ts\`.`

6. **Edit `CONTRIBUTING.md`:**
   - Line 33: `pnpm test` → `pnpm test:e2e` (or `pnpm test:unit` if context shows the example is meant to demonstrate the unit-test workflow; inspect surrounding prose to classify). Pre-flight indicated the context says "run the tests" in a generic getting-started block — reading the file is required; if the section heading is "Running tests" the safest disambiguation is to split into two examples (`pnpm test:unit` for the local dev loop AND `pnpm test:e2e` for the smoke check) rather than guess.

7. **Skip files explicitly out of scope:**
   - `docs/sdk-migration-smoke-results.md` — historical smoke-test record (not active guidance). Leave as-is.
   - `docs/crystal-legacy/RELEASE_INSTRUCTIONS.md` — Crystal-era preserved doc per `docs/crystal-legacy/` convention (CLAUDE.md). Do not edit.
   - `docs/CODE-PATTERNS.md:388` — only mentions `pnpm run test:unit` (specific, not the ambiguous `pnpm test`); no edit needed.
   - `tests/cyboflow-stream-publisher.spec.ts:32` — inside a spec file (files_readonly); the comment is internal to a spec and does not appear in user-facing guidance.
   - `docs/VISUAL-VERIFICATION-SETUP.md:68` — also files_readonly; this is option (b)'s contract, where the e2e harness will land. Leave it referencing `pnpm test` so that option (b) (when scheduled) updates it in its own scope.

8. **Verify completeness:** re-run `grep -rnE "pnpm test(\s|$|\.)" CLAUDE.md docs/ARCHITECTURE.md AGENTS.md CONTRIBUTING.md` — must return 0 hits. Then run `pnpm test:e2e -- tests/smoke.spec.ts --list` (Playwright's list mode does NOT execute tests or attempt to start the dev server — it just enumerates them; this validates the script wiring without depending on the broken e2e bootstrap). Then run `pnpm test:unit` to confirm the unit-test multi-tier chain still passes.

## Acceptance Criteria

- `package.json` has no `"test": "playwright test"` script.
- `package.json` has `"test:e2e": "playwright test"`.
- `package.json` retains `"test:unit"`, `"test:ci"`, `"test:ci:minimal"`, `"test:ui"`, `"test:headed"`, `"test:build"`, `"test:gate"` unchanged.
- 0 `pnpm test` (with trailing whitespace, end-of-line, or period) prose references in the 4 owned docs files.
- `pnpm test:e2e -- tests/smoke.spec.ts --list` exits 0 (validates the new script's wiring).
- `pnpm test:unit` exits 0 (regression check).
- `.github/workflows/quality.yml` is unchanged (it already uses `pnpm test:ci:minimal`, not `pnpm test`).

## Test Strategy

This is a script-rename + docs sweep. The two regression-guarding probes are: (a) `pnpm test:e2e -- --list` validates the new script wires up to Playwright correctly; (b) `pnpm test:unit` validates the unit-test multi-tier chain that humans actually rely on. No new test cases authored; no behavior added; no specs edited.

## Hardest Decision

**Keep `pnpm test` as an alias for `pnpm test:unit`, OR leave it undefined entirely.** Keeping the alias preserves muscle memory and prevents the dreaded "I typed `pnpm test` and got `Unknown command`" speed bump. Leaving it undefined forces every contributor to make the explicit unit-vs-e2e decision once. Chose **undefined** because the explicit-decision-once cost is small (one error message per contributor), and the alternative — `pnpm test` quietly running unit tests instead of e2e — is itself a behavior change with its own discoverability cost (existing muscle memory says `pnpm test = Playwright`, the alias would silently flip it). Option (b) (the eventual e2e-bootstrap fix) may want to claim `pnpm test` back as the canonical full-suite entry point; leaving it undefined makes that choice cleanly available later.

## Rejected Alternatives

- **Option (b) — fix Playwright config to use `_electron.launch()`.** Rejected for this task. It is the right long-term fix but it is a larger task with real design decisions (which spec files survive, do we add a fixtured Electron app harness, what visual-verification matrix do we run). Belongs in a separate task with its own plan. Would reconsider doing it now if a hard external deadline forced consolidation.
- **Option (c) — add `testIgnore` for Vite-only specs and leave `pnpm test` pointing at Playwright.** Rejected because the proposal's diagnosis is that ALL `tests/*.spec.ts` fail (they all need Electron's preload). `testIgnore` would empty the entire `tests/` directory; that is functionally the same as not running e2e at all but more confusing.
- **Alias `pnpm test` to `pnpm test:unit`.** Rejected per Hardest Decision.

## Lowest Confidence Area

The `CONTRIBUTING.md` edit (step 6). Without re-reading the surrounding prose, classifying whether the example is unit-vs-e2e intent is a judgment call. The executor MUST read the file's "Running tests" section heading and surrounding paragraph and pick the disambiguation that matches the documented intent — when in doubt, split into two examples (`pnpm test:unit` for fast local feedback, `pnpm test:e2e` for the full smoke check). The risk if mis-classified is low: a contributor following the doc gets a Playwright failure instead of unit-test success (or vice-versa) and re-reads — recoverable from a misinformed run.
