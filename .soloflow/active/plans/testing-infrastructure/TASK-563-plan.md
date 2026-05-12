---
id: TASK-563
idea: SPRINT-002-compound
status: ready
created: 2026-05-12T00:00:00Z
files_owned:
  - frontend/package.json
  - frontend/vitest.config.ts
files_readonly:
  - frontend/src/utils/migrateLocalStorageKey.test.ts
  - frontend/src/utils/migrateLocalStorageKey.ts
  - main/package.json
  - main/vitest.config.ts
  - package.json
acceptance_criteria:
  - criterion: "frontend/package.json has vitest, @vitest/ui, and jsdom in devDependencies"
    verification: "node -e 'const p = require(\"./frontend/package.json\"); if (!p.devDependencies.vitest) process.exit(1); if (!p.devDependencies[\"@vitest/ui\"]) process.exit(2); if (!p.devDependencies.jsdom) process.exit(3);' exits with status 0"
  - criterion: "frontend/package.json has a `test` script that runs `vitest run`"
    verification: "node -e 'const p = require(\"./frontend/package.json\"); if (p.scripts.test !== \"vitest run\") process.exit(1);' exits with status 0"
  - criterion: "frontend/vitest.config.ts exists and configures the jsdom environment"
    verification: "test -f frontend/vitest.config.ts && grep -nE \"environment:\\s*['\\\"]jsdom['\\\"]\" frontend/vitest.config.ts returns at least 1 match"
  - criterion: "pnpm --filter frontend test runs the 4 existing migrateLocalStorageKey cases and exits 0"
    verification: "pnpm --filter frontend test 2>&1 | grep -E '(4 passed|Tests\\s+4\\s+passed)' returns at least 1 match"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "Pure infrastructure wiring (package.json devDeps + a single config file). The verification surface is the 4 existing migrateLocalStorageKey.test.ts cases now actually running. No new test code is added by this task. Sibling-test scan: `find frontend/src -name '*.test.*' -o -name '*.spec.*'` returns only the migrateLocalStorageKey spec; no other frontend tests exist to potentially break."
prerequisites:
  - check: "test -f frontend/src/utils/migrateLocalStorageKey.test.ts"
    fix: "The test file must exist before wiring vitest. It was created in TASK-558 and lives at frontend/src/utils/migrateLocalStorageKey.test.ts; if missing, restore from git history."
    description: "Confirms the orphaned test file this task is meant to wire is present."
    blocking: true
---

# Wire frontend vitest workspace so migrateLocalStorageKey.test.ts actually runs

## Objective

`frontend/src/utils/migrateLocalStorageKey.test.ts` was created in TASK-558 to cover the localStorage migration helper used by 4 production call sites (`App.tsx`, `FileEditor.tsx`, `RichOutputWithSidebar.tsx`, `console.ts`). The spec imports from `vitest`, but `frontend/package.json` has no vitest devDep, no `test` script, and no vitest config — so it never runs. This task adds the missing wiring: vitest + jsdom devDeps, a `frontend/vitest.config.ts` configured for `jsdom` (the helper reads `localStorage`), and a `test` script. The 4 existing test cases must pass when `pnpm --filter frontend test` is invoked.

## Implementation Steps

1. **Update `frontend/package.json`:** add three entries to `devDependencies` (alphabetically positioned). Versions chosen to match the main workspace's existing `vitest@^2.1.8`:
   ```json
   "@vitest/ui": "^2.1.8",
   "jsdom": "^25.0.0",
   "vitest": "^2.1.8"
   ```
   Add a `test` script to the `scripts` block:
   ```json
   "test": "vitest run"
   ```
   Place the `test` entry between the existing `preview` and `lint` entries. Pin `jsdom@^25` (the current vitest 2.x baseline; `jsdom@^26` requires Node 20+ which the repo already mandates via `engines.node >=22.14.0`, so 25 is conservative and adequate).

2. **Create `frontend/vitest.config.ts`** (new file):
   ```typescript
   import { defineConfig } from 'vitest/config';
   import react from '@vitejs/plugin-react';

   export default defineConfig({
     plugins: [react()],
     test: {
       environment: 'jsdom',
       globals: false,
       include: ['src/**/*.{test,spec}.{ts,tsx}'],
     },
   });
   ```
   Rationale for each option:
   - `environment: 'jsdom'` — required because `migrateLocalStorageKey` reads `globalThis.localStorage`, which only exists in a browser environment (jsdom provides it).
   - `globals: false` — the existing spec imports `describe`, `it`, `expect`, `vi`, `beforeEach` from `'vitest'` explicitly (see `migrateLocalStorageKey.test.ts:1`); no need to inject globals.
   - `include` pattern matches `.test.ts` and `.test.tsx` (also `.spec.*`) anywhere under `frontend/src/`, future-proofing for additional specs.
   - `plugins: [react()]` — picked up automatically once the file extension is `.tsx` (or any future component spec). Costs nothing for non-React specs.

3. **Run `pnpm install`** at repo root so the new devDeps are linked into the frontend workspace.

4. **Run `pnpm --filter frontend test`.** Expected: vitest reports `4 passed` (the four cases in `migrateLocalStorageKey.test.ts`). If any fails, the failure is a pre-existing bug in the helper, not a wiring issue (the wiring is verified by vitest discovering and executing the spec at all).

5. **Optional sanity check (do not block on failure):** `pnpm --filter frontend test -- --reporter=verbose` should print 4 case titles matching the `Test 1: …` / `Test 2: …` / `Test 3: …` / `Test 4: …` headings in the spec.

## Acceptance Criteria

See frontmatter. Compound rule: `pnpm --filter frontend test` exits 0 with 4 passing cases.

## Test Strategy

No new tests. This task wires the runtime so existing tests can execute. Sibling-test scan: `find frontend/src -type f \\( -name '*.test.*' -o -name '*.spec.*' \\)` returns only `frontend/src/utils/migrateLocalStorageKey.test.ts`, the file this task is wiring up. There are no `__tests__/` dirs and no other spec files. Coverage gain is incidental — TASK-558 already wrote the test cases.

## Hardest Decision

Whether to require `jsdom` or fall back to `happy-dom`. **Decision: jsdom.** `jsdom@^25` is the mature default for vitest with full `localStorage` semantics matching Safari/Chrome, including the throwing-getItem branch the spec exercises in "Test 4". `happy-dom` is faster but its `localStorage` implementation has known quirks around `SecurityError` propagation. Given the spec specifically asserts the throwing-getItem path, jsdom is the correct choice. Cost: ~150ms slower test startup, irrelevant at this scale.

## Rejected Alternatives

- **Use the `node` environment with a manual `globalThis.localStorage` polyfill in `setupFiles`.** Rejected: the spec already injects its own fake via `vi.stubGlobal('localStorage', fakeStorage)`. A separate jsdom-provided baseline is not strictly necessary, but jsdom adds zero friction and future component specs will require it anyway. Saving 1 devDep at the cost of a one-off ad-hoc polyfill is bad ROI.
- **Add the vitest devDeps to the repo root instead of `frontend/`.** Rejected: this is a pnpm monorepo; each workspace owns its own devDeps. Hoisting vitest to the root would obscure ownership and prevent independent version pinning per workspace.
- **Drop the `migrateLocalStorageKey.test.ts` file and rely on integration tests.** Rejected: the helper has 4 distinct branches (newKey set, legacy-only set, neither, throwing-getItem), each material. No integration test exercises the throwing-getItem path. The unit test is the right granularity.

## Lowest Confidence Area

The jsdom major version pinning (`^25`). vitest 2.x is documented compatible with jsdom 22-26, but the conservative pick is whatever the upstream vitest team is testing against most heavily. As of vitest 2.1.x release notes, jsdom 25 is the standard. If `pnpm install` resolves to a version that fails to load (rare but happens with native deps under Node 22 + Electron-rebuild contexts), a fallback to `jsdom@^24` or `happy-dom` is acceptable — the spec doesn't exercise enough DOM surface to be sensitive to specific jsdom semantics beyond `localStorage`. Second uncertainty: whether `@vitejs/plugin-react` is needed in `vitest.config.ts` for a spec that imports no React. It is not strictly needed for `migrateLocalStorageKey.test.ts` (which never renders a component), but including it future-proofs the config for the inevitable next component spec at near-zero cost. If pnpm install fails because `@vitejs/plugin-react` is already a frontend devDep at a conflicting version (it's currently `^4.3.4`), drop the `plugins: [react()]` line — the existing react plugin in the Vite dev config is unrelated to vitest's resolver.
