---
id: TASK-638
idea: SPRINT-015-compound
status: ready
created: "2026-05-18T00:00:00Z"
files_owned:
  - frontend/src/App.tsx
  - frontend/src/components/DiscordPopup.tsx
  - frontend/src/components/OnboardingCard.tsx
  - frontend/src/components/ReviewQueueView.tsx
files_readonly:
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
acceptance_criteria:
  - criterion: "Zero local interface IPCResponse declarations remain in frontend/src outside the canonical sites"
    verification: "grep -rln 'interface IPCResponse' frontend/src | sort returns exactly these 2 paths: frontend/src/types/electron.d.ts, frontend/src/utils/api.ts"
  - criterion: "All four touched files import IPCResponse from utils/api (or its global declaration in electron.d.ts) instead of declaring it locally"
    verification: "grep -nE \"import type \\{[^}]*IPCResponse\" frontend/src/App.tsx frontend/src/components/DiscordPopup.tsx frontend/src/components/OnboardingCard.tsx frontend/src/components/ReviewQueueView.tsx returns at least 4 matches"
  - criterion: "Frontend typecheck and tests pass"
    verification: "pnpm --filter frontend typecheck && pnpm --filter frontend test exit 0"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "Type-import cleanup. The canonical IPCResponse type in utils/api.ts has additional optional fields (`details?`, `command?`) versus the 4 local duplicates which only have `success/data?/error?`. The canonical is a strict superset for all consumer uses — every cast site already passes `<T>` explicitly, so consumer code is unaffected by the swap. No behavior change. Sibling-test scan: no test files exist alongside App.tsx, DiscordPopup.tsx, OnboardingCard.tsx, or ReviewQueueView.tsx that test these IPCResponse usages directly (verified via grep for `*.test.*` / `__tests__/` in the parent dirs of all four files — none found). `pnpm --filter frontend typecheck` is the regression guard."
---

# Eliminate 4 local duplicate IPCResponse interface declarations

## Objective

`frontend/src/utils/api.ts:10` declares the canonical `IPCResponse<T = unknown>` with fields `{success, data?, error?, details?, command?}`. Four components carry their own narrow `IPCResponse<T = unknown>` declarations duplicating just `{success, data?, error?}`:
- `frontend/src/App.tsx:34`
- `frontend/src/components/DiscordPopup.tsx:5`
- `frontend/src/components/OnboardingCard.tsx:4`
- `frontend/src/components/ReviewQueueView.tsx:9`

Replace each local declaration with `import type { IPCResponse } from '../utils/api';` (adjusting relative depth per file). The canonical is a superset of all four locals, so consumer code is unaffected. The cast sites already pass `<T>` explicitly per the project's `IPCResponse[^<A-Za-z]` rule.

## Implementation Steps

1. **Pre-flight grep — confirm the 4 duplicate sites + the 2 canonical declarations:**
   ```
   grep -rln 'interface IPCResponse' frontend/src | sort
   ```
   Expected exactly 6 paths: 4 duplicates + electron.d.ts (global) + utils/api.ts (canonical re-export).

2. **Edit `frontend/src/App.tsx`.**
   - Delete lines 33–38 (the `// Type for IPC response` comment + the `interface IPCResponse<T = unknown> { ... }` block).
   - Add to the existing imports near the top (after the `import { API } from './utils/api';` on line 23): `import type { IPCResponse } from './utils/api';`
   - Verify the file uses `IPCResponse<...>` somewhere — `grep -n 'IPCResponse' frontend/src/App.tsx`. If 0 matches after deletion (very unlikely — the type is declared because it's used), the import becomes unused; `pnpm --filter frontend typecheck` will flag it.

3. **Edit `frontend/src/components/DiscordPopup.tsx`.**
   - Delete lines 4–9 (the `// Type for preferences IPC response` comment + `interface IPCResponse<T = unknown> { ... }`).
   - Add: `import type { IPCResponse } from '../utils/api';` (after the existing `Modal` import).

4. **Edit `frontend/src/components/OnboardingCard.tsx`.**
   - Delete lines 3–8 (the `// Type for IPC response` comment + interface).
   - Add: `import type { IPCResponse } from '../utils/api';` (after the existing `React` import).

5. **Edit `frontend/src/components/ReviewQueueView.tsx`.**
   - Delete lines 8–13 (the comment + interface).
   - Add: `import type { IPCResponse } from '../utils/api';` (after the existing `OnboardingCard` import on line 6).

6. **Run the AC completeness gate:**
   ```
   grep -rln 'interface IPCResponse' frontend/src | sort
   ```
   Expected exactly: `frontend/src/types/electron.d.ts`, `frontend/src/utils/api.ts`. Anything else is a missed duplicate or a regression.

7. **Verify the typed import is in place in all four files:**
   ```
   grep -nE "import type \{[^}]*IPCResponse" frontend/src/App.tsx frontend/src/components/DiscordPopup.tsx frontend/src/components/OnboardingCard.tsx frontend/src/components/ReviewQueueView.tsx
   ```
   Expected 4 matches.

8. **Run `pnpm --filter frontend typecheck`** — expect exit 0. The canonical type has two additional optional fields (`details?`, `command?`); since they're optional, no existing assignment breaks. If any consumer expected a stricter shape (e.g. `Exact<IPCResponse>`), typecheck will surface it.

9. **Run `pnpm --filter frontend test`** — expect exit 0.

## Acceptance Criteria

- Repo-wide `interface IPCResponse` matches exactly the canonical sites (utils/api.ts + electron.d.ts).
- All four touched files import `IPCResponse` from `utils/api`.
- Typecheck + tests pass.

## Hardest Decision

Whether to also remove the `interface IPCResponse` declaration in `frontend/src/types/electron.d.ts` (line 26) since it duplicates the one in `utils/api.ts`. Decided to leave it — the electron.d.ts declaration is a **global** ambient type that the `window.electron.invoke` typings depend on (line 86, 317); collapsing it requires re-pointing the global at the canonical export and risks cascading typing breaks. That cleanup is a separate concern (and likely a sub-issue inside the `claude-agent-sdk-migration` epic when the IPC types get a major overhaul). For this task: 4 component-local duplicates removed; 2 canonical sites preserved.

## Rejected Alternatives

- **Add the canonical `details?` / `command?` fields to the four local interfaces and leave them in place.** Rejected — that fixes the symptom (drift) without addressing the cause (duplication). Future field additions to the canonical would re-create drift.
- **Convert the canonical to a `type IPCResponse<T> = ...` alias.** Rejected — `interface` declarations are augmentable (e.g. via `declare module` merging) and the renderer-vs-main split sometimes needs that. Preserve the current `interface` shape.

## Lowest Confidence Area

Whether any of the four files relies on the precise field set `{success, data?, error?}` (e.g. uses `keyof IPCResponse`-derived types or exhaustive narrowing). I read each call site and saw only `result.success`, `result.data`, `result.error` reads — all present in the canonical. `pnpm typecheck` is the regression guard if a stricter narrowing exists.
