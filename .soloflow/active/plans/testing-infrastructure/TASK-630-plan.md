---
id: TASK-630
idea: SPRINT-014-COMPOUND
status: in-flight
created: "2026-05-17T00:00:00Z"
files_owned:
  - frontend/src/types/electron.d.ts
  - frontend/src/utils/api.ts
  - frontend/src/App.tsx
  - frontend/src/components/DiscordPopup.tsx
  - frontend/src/components/OnboardingCard.tsx
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/components/OnboardingCard.test.tsx
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
files_readonly:
  - main/src/ipc/file.ts
  - main/src/ipc/git.ts
  - shared/types/panels.ts
  - main/src/services/configManager.ts
acceptance_criteria:
  - criterion: "IPCResponse interface no longer defaults T to `any` in electron.d.ts (use `<T = unknown>` or no default)"
    verification: "grep -nE 'interface IPCResponse<T(\\s*=\\s*any)?>' frontend/src/types/electron.d.ts | grep -vE '<T = unknown>|<T>' returns 0 matches"
  - criterion: Same in api.ts
    verification: "grep -nE 'interface IPCResponse<T(\\s*=\\s*any)?>' frontend/src/utils/api.ts | grep -vE '<T = unknown>|<T>' returns 0 matches"
  - criterion: "Eslint-disable comments for IPCResponse's T=any default are removed"
    verification: "grep -nE 'eslint-disable.*no-explicit-any.*IPCResponse|Generic type parameter default for flexible API responses' frontend/src --include='*.ts' --include='*.tsx' -r returns 0 matches"
  - criterion: "No bare `Promise<IPCResponse>` (without type arg) remains in electron.d.ts"
    verification: "grep -nE 'Promise<IPCResponse>' frontend/src/types/electron.d.ts returns 0 matches"
  - criterion: No bare `as IPCResponse` cast remains in frontend/src
    verification: "grep -rnE 'as IPCResponse(?!<)' frontend/src --include='*.ts' --include='*.tsx' returns 0 matches"
  - criterion: "GitErrorResponse extends IPCResponse with explicit type arg (or `<unknown>` with rationale comment)"
    verification: "grep -nE 'extends IPCResponse(<|;|\\s+\\{)' frontend/src/utils/api.ts matches a form with an explicit type arg or `<unknown>`"
  - criterion: pnpm typecheck passes
    verification: "pnpm typecheck && pnpm lint exit 0"
  - criterion: Existing component tests for ReviewQueueView and OnboardingCard still pass
    verification: "cd frontend && pnpm vitest run src/components/__tests__/ReviewQueueView.test.tsx src/components/OnboardingCard.test.tsx exits 0"
depends_on: []
estimated_complexity: high
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: Mechanical type-only changes across ~120 declaration sites + ~13 cast sites. No new tests; the existing component tests guard the IPC mock surface that the rename touches.
  targets:
    - behavior: ReviewQueueView IPC-mock surface continues to deserialize correctly after IPCResponse narrowing
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
    - behavior: OnboardingCard preference-fetch IPC mock continues to deserialize correctly after IPCResponse narrowing
      test_file: frontend/src/components/OnboardingCard.test.tsx
      type: component
---
# Remove IPCResponse<T = any> default to restore type-contract enforcement

## Objective

`IPCResponse<T = any>` in `frontend/src/types/electron.d.ts:22` and `frontend/src/utils/api.ts:8` defaults T to `any`, which silently bypassed typecheck on TASK-562's `crystalDirectory → cyboflowDirectory` IPC rename and let the AboutDialog regression ship. The codebase already has the right pattern locally in `App.tsx` (`IPCResponse<T = unknown>`); promote that to the two canonical declarations and audit every `Promise<IPCResponse>` and `as IPCResponse` usage to add explicit type arguments.

## Implementation Steps

1. **Sweep pre-flight** (also re-run as step 7):
   - `grep -rnE 'interface IPCResponse<T\s*=\s*any>' frontend/src --include='*.ts' --include='*.tsx'`
   - `grep -rnE 'Promise<IPCResponse>' frontend/src --include='*.ts' --include='*.tsx'`
   - `grep -rnE 'as IPCResponse(?!<)' frontend/src --include='*.ts' --include='*.tsx'`

2. **Update the two declaration sites:**
   - `interface IPCResponse<T = any>` → `interface IPCResponse<T = unknown>` (keep default; `unknown` forces narrowing)
   - Remove `eslint-disable-next-line` comments above each
   - Update trailing comment to explain the `unknown` default rationale

3. **Audit every `Promise<IPCResponse>` in electron.d.ts** (~120 sites). For each, decide the concrete type:
   - **Known shape** (~70%): replace with concrete type from types/session.ts, types/project.ts, etc.
   - **Never consumed** (~20%): `Promise<IPCResponse<unknown>>` + comment `// Caller does not consume .data`
   - **Genuinely dynamic** (~10%): `Promise<IPCResponse<unknown>>` + same comment

   Work in batches by IPC namespace (sessions, projects, folders, config, mcp). Each batch must typecheck before moving on.

4. **Audit every `as IPCResponse` cast in source files** (13 sites total). Only DiscordPopup.tsx has bare casts — all others already supply an explicit arg. Add `<unknown>` or specific type per call context.

5. **Update `GitErrorResponse`** in api.ts to `extends IPCResponse<unknown>` with rationale comment.

6. **Run `pnpm typecheck`** — fix every implicit-any / type-mismatch error. Most are `result.data.foo` accesses where `result.data` is now `unknown`. Pick the correct concrete type, narrow with type guards, or last-resort cast (no new `any`).

7. **Re-run the three sweep greps** — all must return 0.

8. **Run `pnpm typecheck && pnpm lint && cd frontend && pnpm vitest run`** on the two component tests.

## Hardest Decision

`<T = unknown>` vs removing the default entirely. Choosing `unknown` default preserves source-compat for genuine-dynamic cases (still requires narrowing) while catching the silent-rename bug class. Revisit if regressions still slip through.

## Lowest Confidence Area

Step 3's IPC-handler-aware type selection for ~120 sites in electron.d.ts. Many need a quick read of the corresponding handler in main/src/ipc/*.ts to identify the actual return shape. Expect 5-10 sites where the typed payload requires inventing a new type in frontend/src/types/. Scope-reduce by tagging awkward channels with `// FIXME(TASK-630)` + `IPCResponse<unknown>` if the typecheck surfaces too many.
