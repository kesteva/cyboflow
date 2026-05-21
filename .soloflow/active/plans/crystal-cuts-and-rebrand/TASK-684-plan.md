---
id: TASK-684
idea: IDEA-016
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - frontend/src/components/DiscordPopup.tsx
  - frontend/src/App.tsx
  - main/src/ipc/app.ts
  - main/src/database/database.ts
files_readonly:
  - frontend/src/types/electron.d.ts
  - frontend/src/utils/api.ts
  - main/src/index.ts
  - frontend/src/styles/tokens/colors.css
  - frontend/tailwind.config.js
  - frontend/src/components/AboutDialog.tsx
acceptance_criteria:
  - criterion: The file frontend/src/components/DiscordPopup.tsx no longer exists on disk.
    verification: "test ! -e frontend/src/components/DiscordPopup.tsx (exit 0 = pass)"
  - criterion: "No source file in frontend/src/ references the DiscordPopup component (import, JSX usage, or symbol)."
    verification: "grep -rn 'DiscordPopup' frontend/src/ returns zero matches"
  - criterion: No source file in frontend/src/ references the isDiscordOpen / setIsDiscordOpen state hook.
    verification: "grep -rnE 'isDiscordOpen|setIsDiscordOpen' frontend/src/ returns zero matches"
  - criterion: "No source file in frontend/src/ invokes any Discord-specific IPC call (preferences:get/set for 'hide_discord', app:update-discord-shown) or reads lastOpen.discord_shown."
    verification: "grep -rnE \"hide_discord|app:update-discord-shown|discord_shown\" frontend/src/ returns zero matches"
  - criterion: "No source file in frontend/src/ invokes app:get-last-open or app:record-open (their only frontend callers lived inside the deleted Discord gate; main/src/index.ts already records app opens independently)."
    verification: "grep -rnE 'app:get-last-open|app:record-open' frontend/src/ returns zero matches"
  - criterion: "frontend/src/App.tsx typechecks cleanly with the deletions applied (no unused vars, no missing references)."
    verification: pnpm typecheck exits 0
  - criterion: Lint passes for App.tsx.
    verification: pnpm lint exits 0
  - criterion: "Main-process Discord surfaces (IPC handler app:update-discord-shown, database column discord_shown, user_preferences seed hide_discord) remain untouched in this task — they are TASK-685's scope."
    verification: "grep -c 'app:update-discord-shown' main/src/ipc/app.ts equals 1 AND grep -c 'discord_shown' main/src/database/database.ts is greater than 0"
  - criterion: App launches without showing the Discord modal on dev start.
    verification: "Visual: run pnpm dev, observe app shell renders without the 'Join the Cyboflow Community!' modal. Read cyboflow-frontend-debug.log; grep for 'Discord' returns zero matches in renderer-side log lines."
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Sibling-test scan confirmed no test files exist for either owned file: frontend/src/components/__tests__/ does not contain DiscordPopup tests (verified via `find frontend/src/components/__tests__ -name 'Discord*'`), and frontend/src/__tests__/App* does not exist (verified via `find frontend/src -name 'App.test.*' -o -name 'App.spec.*'`). This is a pure deletion task — no new behavior to test; the visual + grep ACs in the frontmatter fully verify correctness. The post-removal launch path is observable via `pnpm dev` and is captured in the visual AC."
---
# Delete DiscordPopup component and remove all call-sites from App.tsx

## Objective

Remove the Crystal-inherited "Join the Cyboflow Community" Discord modal from the cyboflow frontend. This task is the first of a two-task atomic sequence (TASK-684 frontend, TASK-685 main-process) within the `crystal-cuts-and-rebrand` epic. After this task lands, the Discord popup is gone from the launch flow; the main-process IPC handler `app:update-discord-shown` will still exist but be unreachable, and TASK-685 will then garbage-collect it along with the `app_opens.discord_shown` column and the `hide_discord` user-preferences seed. This task does NOT touch any file under `main/src/**`.

## Implementation Steps

1. **Pre-flight completeness grep.** Run the following greps and capture the file list; every match must be addressed by this task (the only matches outside `main/src/`, `.claude/worktrees/`, `.soloflow/`, and the now-deleted DiscordPopup file should be in `frontend/src/App.tsx`):
   ```bash
   grep -rnE "DiscordPopup|isDiscordOpen|setIsDiscordOpen" frontend/src/
   grep -rnE "hide_discord|app:update-discord-shown|discord_shown" frontend/src/
   ```
   These same greps appear as ACs; they will be re-run before reporting COMPLETED as a closure gate.

2. **Delete the component file.**
   ```bash
   git rm frontend/src/components/DiscordPopup.tsx
   ```
   (Or `rm` + stage the deletion; the file is referenced only by App.tsx, which step 3 cleans up in the same commit.)

3. **Surgically edit `frontend/src/App.tsx`** with these exact removals (line numbers reference the file at the time of plan emission; the executor must locate by content, not by line, since edits shift subsequent positions):

   - **Line 18:** delete the import: `import { DiscordPopup } from './components/DiscordPopup';`
   - **Line 54:** delete the state hook: `const [isDiscordOpen, setIsDiscordOpen] = useState(false);`
   - **Line 187 comment:** rewrite to mention only the welcome screen: `// Show welcome screen intelligently based on user state`
   - **Lines 202, 206:** delete the two `hide_discord` preference read lines (the `preferences:get` call and the `hideDiscordResult` unpack).
   - **Lines 244-283:** delete the entire `if (!welcomeScreenShown && !hideDiscord) { … }` block. This block is the sole frontend caller of `app:get-last-open`, `app:update-discord-shown`, and `app:record-open`. The main-process startup path at `main/src/index.ts:741` already calls `databaseService.recordAppOpen(false, false, currentVersion)` on every launch, so removing the frontend `app:record-open` call does not lose welcome-tracking semantics. After deletion, verify the welcome flow is still complete.
   - **Line 291:** delete the orphan comment `// Discord popup logic is now combined with welcome screen logic above`.
   - **Lines 460-463:** delete the `<DiscordPopup ...>` JSX.
   - **Unused-vars sweep:** after deletions, `welcomeScreenShown` has assignment sites but no readers. Remove the `let welcomeScreenShown = false;` declaration and its three assignment statements. If any reader of `welcomeScreenShown` survives outside the deleted block (re-grep `grep -n 'welcomeScreenShown' frontend/src/App.tsx` after edits), STOP and reconsider — don't blanket-delete.

4. **Verify no other Discord-styling consumers exist** (read-only). CSS tokens (`--discord-primary`/`--discord-hover`/`--discord-secondary`) in `frontend/src/styles/tokens/colors.css` and the `discord` Tailwind color family in `frontend/tailwind.config.js` were referenced only by `DiscordPopup.tsx`. These tokens are now orphaned but cost zero at runtime; leaving them follows the IDEA's orphan-strategy precedent. **Do not delete them in this task.** Same for the `<a href="https://discord.gg/XrVa6q7DPY">` block in `frontend/src/components/AboutDialog.tsx:294-305` — tracked separately under TASK-632.

5. **Closure gates** — re-run the step-1 greps and confirm zero matches. Run `pnpm typecheck` and `pnpm lint`; both must exit 0.

6. **Visual verification.** Run `pnpm dev`, confirm the "Join the Cyboflow Community!" modal does NOT appear on launch. Read `cyboflow-frontend-debug.log` and grep for `Discord` — zero matches.

## Acceptance Criteria

See frontmatter `acceptance_criteria`.

## Test Strategy

No new tests required. Pure deletion task; correctness established by grep ACs that prove the dead code is gone and a visual smoke test that proves the launch flow is unbroken.

## Hardest Decision

**Keep or remove the `app:record-open` frontend invocation at App.tsx:275?** This call is currently nested inside the discord gate, but its semantics are not Discord-specific — it logs `recordAppOpen(welcomeHidden, false)`. Chose to **delete** because `main/src/index.ts:741` already calls `databaseService.recordAppOpen(false, false, currentVersion)` unconditionally on every app startup — the frontend invocation is a redundant double-write. Removing it also keeps the task atomic: TASK-685 can simplify `recordAppOpen`'s signature to drop the `discordShown` parameter without worrying about a frontend caller still passing it.

## Rejected Alternatives

- **Keep the discord block but flip its gate to `false`.** Rejected — leaves dead, misleading code in the launch path.
- **Mark `DiscordPopup.tsx` with `@cyboflow-hidden` instead of deleting.** Rejected — cyboflow has no plans for a Discord community; preservation provides no future value.
- **Also delete the orphan CSS tokens and Tailwind `discord` color family.** Rejected — no runtime cost; widens blast radius.
- **Lift `app:record-open` out of the discord block instead of deleting it.** Rejected — main-process call already records the open unconditionally; the asymmetry is dead.

## Lowest Confidence Area

**The `welcomeScreenShown` variable cleanup.** After deleting the discord block, `welcomeScreenShown` has assignment sites but no readers. ESLint will warn and the variable must be removed. The risk is misreading the control flow and a reader surviving — e.g. the variable referenced in a JSX expression or return value I overlooked. The executor's mitigation is the explicit re-grep instruction (`grep -n 'welcomeScreenShown' frontend/src/App.tsx` after edits) and the requirement to stop if any reader survives.
