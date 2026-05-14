---
id: TASK-578
idea: SPRINT-006-compound
status: ready
created: 2026-05-14T00:00:00Z
files_owned:
  - frontend/src/components/AboutDialog.tsx
files_readonly:
  - main/src/ipc/updater.ts
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-562-plan.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/EPIC-crystal-cuts-and-rebrand.md
acceptance_criteria:
  - criterion: "VersionInfo interface in AboutDialog.tsx declares `cyboflowDirectory?: string` and no longer declares `crystalDirectory`"
    verification: "grep -n 'cyboflowDirectory\\?: string' frontend/src/components/AboutDialog.tsx returns 1 match AND grep -n 'crystalDirectory' frontend/src/components/AboutDialog.tsx returns 0 matches"
  - criterion: "loadCurrentVersion() reads the renamed field from the IPC response"
    verification: "grep -nE 'cyboflowDirectory:\\s*result\\.data\\.cyboflowDirectory' frontend/src/components/AboutDialog.tsx returns 1 match"
  - criterion: "JSX render block uses versionInfo.cyboflowDirectory (gated + tooltip + display)"
    verification: "grep -nE 'versionInfo\\?\\.cyboflowDirectory' frontend/src/components/AboutDialog.tsx returns at least 1 match AND grep -nE 'versionInfo\\.cyboflowDirectory' frontend/src/components/AboutDialog.tsx returns at least 2 matches"
  - criterion: "Frontend typecheck passes (proves the IPC field rename in TASK-562 is consistent with the consumer)"
    verification: "pnpm --filter frontend typecheck exits with status 0"
  - criterion: "Frontend lint passes"
    verification: "pnpm --filter frontend lint exits with status 0"
depends_on: [TASK-562]
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "5-site identifier rename inside a single React component with no logic change. The `VersionInfo` interface is local to AboutDialog.tsx, so the rename is fully contained. Frontend typecheck catches any missed site by failing on unknown-property access against the (now-renamed) IPC response shape. No existing test imports AboutDialog (`find frontend/src -name '*AboutDialog*.test.*'` returns zero matches), so there is no sibling test surface. The rendered output is purely a display string; a snapshot or component test would not add coverage beyond typecheck + lint."
prerequisites:
  - check: "grep -q 'cyboflowDirectory:' main/src/ipc/updater.ts"
    fix: "TASK-562 must have landed first — it renames the IPC response field `crystalDirectory:` → `cyboflowDirectory:` in main/src/ipc/updater.ts:98. If this check fails, TASK-562 has not yet shipped and this task is premature. Stop and resume TASK-562 first."
    description: "Confirms TASK-562 has shipped on the producer side, so the consumer-side rename in AboutDialog will line up with the actual IPC response shape."
    blocking: true
---

# Update AboutDialog.tsx to consume the renamed cyboflowDirectory IPC field

## Objective

TASK-562 renames the IPC response field `crystalDirectory:` → `cyboflowDirectory:` in `main/src/ipc/updater.ts:98` (producer side) but does not list `frontend/src/components/AboutDialog.tsx` in its `files_owned`. AboutDialog is the *only* consumer of that field (it renders the "Data Directory" row in the About modal). After TASK-562 lands, AboutDialog reads `result.data.crystalDirectory` (undefined) instead of `result.data.cyboflowDirectory`, and the Data Directory row silently disappears from the modal.

This task is the consumer-side counterpart to TASK-562. It is small (5 sites in one file) but must ship *with or after* TASK-562 to avoid the visual regression.

## Implementation Steps

1. **Confirm TASK-562 has landed** by running the prerequisite check from the frontmatter:
   ```
   grep -q 'cyboflowDirectory:' main/src/ipc/updater.ts
   ```
   If this returns nonzero, stop — TASK-562 must ship first.

2. **Edit `frontend/src/components/AboutDialog.tsx`** at 5 sites (use line numbers as of HEAD at task creation; if drift has occurred since, find them by content):

   - **L13** (interface field declaration): `crystalDirectory?: string;` → `cyboflowDirectory?: string;`
   - **L47** (object literal in `setVersionInfo`): `crystalDirectory: result.data.crystalDirectory,` → `cyboflowDirectory: result.data.cyboflowDirectory,`
   - **L165** (conditional render gate): `{versionInfo?.crystalDirectory && (` → `{versionInfo?.cyboflowDirectory && (`
   - **L170** (`title` attribute on the span): `title={versionInfo.crystalDirectory}` → `title={versionInfo.cyboflowDirectory}`
   - **L171** (display value with home-dir replacement): `{versionInfo.crystalDirectory.replace(/^\/Users\/[^/]+/, '~')}` → `{versionInfo.cyboflowDirectory.replace(/^\/Users\/[^/]+/, '~')}`

   All five are pure identifier renames. No logic changes.

3. **Run `pnpm --filter frontend typecheck`.** Expected: exit 0. The IPC response type (defined on the main side and surfaced via `window.electronAPI.getVersionInfo()`) now exposes `cyboflowDirectory` instead of `crystalDirectory` after TASK-562; the frontend typecheck verifies that this consumer aligns with that producer shape.

4. **Run `pnpm --filter frontend lint`.** Expected: exit 0.

5. **Manual smoke (recommended, not gated on):** start `pnpm dev`, open the About modal, confirm the "Data Directory" row still renders and shows a `~/.cyboflow` path (collapsed by the `/^\/Users\/[^/]+/` regex). Not in the AC because it requires the dev environment.

## Acceptance Criteria

See frontmatter. Compound rule: zero `crystalDirectory` references remain in AboutDialog.tsx, all five sites are renamed, frontend typecheck + lint exit 0.

## Test Strategy

No new tests. The behavior surface is a single React component that renders a string from an IPC response. Frontend typecheck is the structural gate (if the IPC shape and the consumer disagree, TS errors). No sibling tests under `frontend/src/components/__tests__/` exist for this file. A component snapshot test for AboutDialog would be useful long-term but is out of scope for a one-file identifier rename.

## Hardest Decision

Whether to make this task a hard dependency of TASK-562 (so TASK-562 cannot ship until this is also written) or a follow-up task with TASK-562 as the prereq. **Decision: follow-up with prereq.** Reasons:

1. TASK-562 is already written, validated, and `status: ready`. Restructuring it now to swallow AboutDialog would require editing its `files_owned`, re-justifying the test strategy (component test surface added), and rewriting the AC. Not worth it for a 5-site rename.
2. The dependency is unidirectional and easy to enforce: TASK-578's `prerequisites` check ensures TASK-562's producer-side change is in place before TASK-578 starts. If TASK-562 ships first and this follow-up doesn't ship for a sprint, the AboutDialog briefly shows no Data Directory row — a visual blemish, not a crash. Acceptable degradation during the window.
3. The reverse dependency (this task before TASK-562) is impossible: writing the consumer-side rename without the producer change would immediately fail typecheck because `result.data.cyboflowDirectory` does not yet exist on the IPC response type.

A weaker alternative would be to merge this task's diff into TASK-562 before TASK-562 starts. Rejected as scope-creep on a task that is already detailed and prerequisite-checked.

## Rejected Alternatives

- **Add a temporary fallback in AboutDialog: `result.data.cyboflowDirectory ?? result.data.crystalDirectory`.** Rejected: would require keeping the legacy field on the producer side too, which contradicts TASK-562's `crystalDirectory:` 0-matches AC. The clean cutover via this dedicated follow-up task is simpler.
- **Rename only the interface field but leave the JSX sites referencing `crystalDirectory` for one release.** Rejected: TypeScript would immediately flag the JSX sites as unknown properties — partial renames don't compile.
- **Move the `VersionInfo` interface to a shared type file** (`shared/types/version.ts`) so producer and consumer share a single source of truth. Rejected: a useful refactor in principle but out of scope for an identifier rename. The current duplication (interface in main `ipc/updater.ts` and in `AboutDialog.tsx`) is a known minor smell — file a separate codebase-pruner task if desired.

## Lowest Confidence Area

**Line numbers may drift if TASK-560 (frontend bare-word sweep) ships between TASK-562 and this task.** TASK-560 lists `frontend/src/components/AboutDialog.tsx` in its `files_readonly` (not `files_owned`), so it should not edit the file — but if anything reorders lines in this file before this task starts, the line-number-anchored edits at step 2 must be re-located by content. The acceptance grep is content-anchored (`cyboflowDirectory?: string`, etc.), not line-anchored, so the AC is robust to drift. If the executor finds the content does not match the listed line numbers, it should grep for `crystalDirectory` and rewrite each matching site — there are exactly 5 of them as of task creation, all in the patterns shown above.

Secondary concern: the `VersionInfo` interface in `AboutDialog.tsx` is a *local* type, declared inline in the component file rather than imported from a shared module. The IPC response (`window.electronAPI.getVersionInfo()`) is typed elsewhere (likely via `frontend/src/types/electron.ts` or a similar bridge file). After this rename, the local `VersionInfo` and the actual IPC return type must agree on `cyboflowDirectory`. Frontend typecheck will catch any mismatch — if it errors with "Property 'cyboflowDirectory' does not exist on type '...'", the executor must find the IPC return type declaration and confirm it has been updated by TASK-562 (or by a related preload-types file that TASK-562 did not own). If a preload-types declaration was missed by TASK-562, escalate as a TASK-562 follow-up rather than fixing it here — this task's `files_owned` is intentionally one file.
