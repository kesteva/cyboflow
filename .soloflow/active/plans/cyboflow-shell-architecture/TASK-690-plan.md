---
id: TASK-690
idea: IDEA-017
status: ready
created: "2026-05-20T00:00:00Z"
files_owned:
  - frontend/src/App.tsx
files_readonly:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/SessionView.tsx
  - frontend/src/stores/navigationStore.ts
acceptance_criteria:
  - criterion: The string `useLegacyCrystalView` appears zero times anywhere under `frontend/src/`.
    verification: "git grep -n 'useLegacyCrystalView' frontend/src/ exits 1 with no matches"
  - criterion: The string `setUseLegacyCrystalView` appears zero times anywhere under `frontend/src/`.
    verification: "git grep -n 'setUseLegacyCrystalView' frontend/src/ exits 1 with no matches"
  - criterion: App.tsx no longer imports `SessionView`.
    verification: "grep -n \"from './components/SessionView'\" frontend/src/App.tsx exits 1 with no matches"
  - criterion: App.tsx no longer references the identifier `SessionView`.
    verification: "grep -n 'SessionView' frontend/src/App.tsx exits 1 with no matches"
  - criterion: App.tsx no longer renders any `Legacy view` or `Cyboflow view` toggle button text.
    verification: "grep -nE 'Legacy view|Cyboflow view' frontend/src/App.tsx exits 1 with no matches"
  - criterion: "App.tsx renders `<CyboflowRoot projectId={activeProjectId} />` as the sole primary content (no SessionView fallback branch)."
    verification: "grep -n '<CyboflowRoot' frontend/src/App.tsx returns exactly one match; grep -nE '<SessionView' frontend/src/App.tsx returns zero matches"
  - criterion: "`pnpm typecheck` passes."
    verification: pnpm typecheck exits 0
  - criterion: "`pnpm lint` passes."
    verification: pnpm lint exits 0
  - criterion: "Manual visual check: launching `pnpm dev` shows no `Legacy view` or `Cyboflow view` toggle button; every project view shows CyboflowRoot content."
    verification: "Run pnpm dev, click each project, inspect header. Confirm no toggle button, CyboflowRoot renders everywhere, no path leads to SessionView."
depends_on:
  - TASK-688
  - TASK-689
estimated_complexity: medium
epic: cyboflow-shell-architecture
test_strategy:
  needed: false
  justification: "No sibling test exists for App.tsx. Pure deletion of a transitional UI toggle with no business logic, no testID surfaces, no exported behavior. Equivalent confidence is provided by pnpm typecheck (catches dangling references), pnpm lint (catches unused symbols), and the manual visual check in ACs. The integration surface — that CyboflowRoot now mounts for every project — is already covered by RunView.test.tsx and cyboflowStore.test.ts."
---
# Retire useLegacyCrystalView toggle and the SessionView render branch in App.tsx

## Objective

Delete the `useLegacyCrystalView` state, both `Legacy view` / `Cyboflow view` toggle buttons, and the entire `SessionView` render branch from `frontend/src/App.tsx`. After this task, the primary content area unconditionally renders `<CyboflowRoot projectId={activeProjectId} />` and the legacy `SessionView` surface is unreachable. `SessionView.tsx` itself stays on disk (TASK-691 owns its deletion). This is the irreversible cut of the legacy escape hatch; assumes TASK-688 has already broadened `CyboflowRoot`'s prop signature to accept `activeProjectId: number | null`.

## Implementation Steps

1. **Pre-flight grep (completeness gate).** Run `git grep -n 'useLegacyCrystalView' frontend/src/` and `git grep -n 'setUseLegacyCrystalView' frontend/src/`. Confirm only `frontend/src/App.tsx` matches. If any OTHER file matches, STOP — TASK-687/TASK-689 left residue.

2. **Edit `frontend/src/App.tsx` — remove the SessionView import** (line 7).

3. **Remove the state declaration and its leading comment** (lines 58-60).

4. **Collapse the primary-content render branch.** Replace lines 392-431 (the ternary + both toggle buttons + SessionView mount) with:
   ```tsx
   {/* Primary content area: CyboflowRoot is the only mount point for the
       active-project surface. The legacy SessionView render branch was retired
       in TASK-690 (IDEA-017 slice 3). */}
   <div className="flex flex-col flex-1 overflow-hidden">
     <CyboflowRoot projectId={activeProjectId} />
   </div>
   ```

5. **Final in-file grep** for `useLegacyCrystalView`, `setUseLegacyCrystalView`, `SessionView`, `Legacy view`, `Cyboflow view`. Each must return zero matches.

6. **Type / lint sweep.** Run `pnpm typecheck`. Expected: `activeProjectId` is typed `number | null`; CyboflowRoot's prop must accept that (TASK-688 broadens). If TASK-688 didn't broaden, STOP and surface as `scope_deviation` — do NOT widen CyboflowRoot here.

7. **Lint sweep.** `pnpm lint`. Fix any new warning originating from App.tsx.

8. **Repo-wide completeness re-grep** (all return zero matches).

9. **Manual visual verification.** Launch `pnpm dev`. Confirm no toggle, CyboflowRoot renders everywhere, no path to SessionView.

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests. Pure deletion; `pnpm typecheck` is the strict completeness gate; `pnpm lint` catches unused-import residue; manual visual check confirms behavior.

## Hardest Decision

Whether to keep the `activeProjectId !== null` guard at App.tsx or push null-handling into CyboflowRoot. Chose the latter (unconditional `<CyboflowRoot projectId={activeProjectId} />`) because (1) IDEA-017 slice 3 spec says "replace ... unconditionally", (2) TASK-688 is a declared dependency that owns CyboflowRoot's final shape, (3) keeping a null-guard at App.tsx would force a SessionView-shaped hole that needs its own placeholder, re-introducing a forked render path.

## Rejected Alternatives

- **Keep `activeProjectId !== null` ternary, render `null` or `<EmptyState />` in else.** Rejected — preserves forked render path; contradicts TASK-688's ownership of CyboflowRoot's surface.
- **Add one-shot `localStorage.removeItem('useLegacyCrystalView')`.** Rejected — toggle was never persisted to localStorage (no `setItem` call exists).
- **Inline `<CyboflowRoot />` without surrounding wrapper div.** Rejected — wrapper carries the flex-layout contract.

## Lowest Confidence Area

The `CyboflowRoot` prop-signature change owned by TASK-688. At plan time `CyboflowRootProps.projectId` is `number`, while `activeProjectId` is `number | null`. TASK-688 must broaden the prop. If TASK-688 ships without broadening, the executor hits a strict-TS error at step 6 and correctly surfaces a scope_deviation rather than papering over it.
