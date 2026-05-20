---
id: TASK-685
idea: IDEA-016
status: ready
created: 2026-05-20T00:00:00Z
files_owned:
  - main/src/ipc/app.ts
  - main/src/database/database.ts
  - main/src/index.ts
files_readonly:
  - frontend/src/App.tsx
  - main/src/preload.ts
acceptance_criteria:
  - criterion: "The IPC handler for 'app:update-discord-shown' is deleted from main/src/ipc/app.ts"
    verification: "grep -rn 'app:update-discord-shown' main/src/ frontend/src/ returns 0 matches"
  - criterion: "The 'discord_shown' field is removed from the public surface of getLastAppOpen() and from the writer/reader SQL projections in main/src/database/database.ts"
    verification: "grep -n 'discord_shown' main/src/database/database.ts returns exactly ONE match — the table-creation line at the CREATE TABLE app_opens block, preserved as the orphaned column with a one-line comment noting the orphan disposition"
  - criterion: "The recordAppOpen() signature no longer accepts a discordShown parameter, and updateLastAppOpenDiscordShown() is deleted"
    verification: "grep -n 'discordShown\\|updateLastAppOpenDiscordShown' main/src/database/database.ts returns 0 matches; grep -n 'discordShown' main/src/ipc/app.ts returns 0 matches"
  - criterion: "The app:record-open IPC handler signature drops the discordShown parameter"
    verification: "grep -n 'discordShown' main/src/ipc/app.ts returns 0 matches and the handler signature in main/src/ipc/app.ts at the 'app:record-open' line reads `(_event, welcomeHidden: boolean)`"
  - criterion: "The internal call site in main/src/index.ts no longer passes a discordShown argument"
    verification: "grep -n 'recordAppOpen' main/src/index.ts shows the call as `databaseService.recordAppOpen(false, currentVersion)` (two args, not three)"
  - criterion: "Both ('hide_discord', 'false') default-preference seed lines are removed"
    verification: "grep -n \"hide_discord\" main/src/database/database.ts returns ONLY the new idempotent DELETE statement (one match); the two INSERT seed lines at the user_preferences init/repair blocks are gone"
  - criterion: "An idempotent inline DELETE for the legacy 'hide_discord' user_preferences row exists in the database init path, runs unconditionally on every launch, and is a no-op when the row is absent"
    verification: "grep -n \"DELETE FROM user_preferences WHERE key = 'hide_discord'\" main/src/database/database.ts returns exactly 1 match, located inside the user_preferences init/migration block"
  - criterion: "The app_opens.discord_shown column declaration at the CREATE TABLE site is preserved with a one-line code comment documenting the orphan choice (IDEA-016 assumption #3)"
    verification: "grep -B1 -n 'discord_shown BOOLEAN DEFAULT 0' main/src/database/database.ts shows a comment on the immediately preceding line explaining the orphan disposition (text mentions 'orphan' or 'IDEA-016')"
  - criterion: "pnpm typecheck passes with no new errors"
    verification: "pnpm typecheck exits 0"
  - criterion: "pnpm lint passes with no new errors"
    verification: "pnpm lint exits 0"
  - criterion: "Manual launch verification: `pnpm dev` launches the Electron app on macOS, no Discord modal appears, and cyboflow-backend-debug.log contains no errors mentioning 'app:update-discord-shown', 'updateLastAppOpenDiscordShown', or 'discord_shown'"
    verification: "Launch with `pnpm dev`, wait for renderer to bootstrap, confirm no DiscordPopup-shaped modal renders; then `grep -iE 'app:update-discord-shown|updateLastAppOpenDiscordShown|discord_shown' cyboflow-backend-debug.log` returns 0 matches"
depends_on: [TASK-684]
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Pure code-deletion + signature-narrowing task touching main/src/ipc/app.ts, main/src/database/database.ts, and main/src/index.ts. Sibling-test directory scan: main/src/ipc/__tests__/ contains sessionJsonMessages.test.ts, cyboflow-stream-publisher.test.ts, cyboflow.test.ts, fileGitExecuteProject.test.ts, panelsInitialize.test.ts — grep confirms none reference the deleted handlers or methods. main/src/database/__tests__/ contains fileMigrationRunner.test.ts and cyboflowSchema.test.ts — neither references the affected symbols. The grep-zero ACs and the manual launch AC are sufficient coverage."
---

# Remove discord IPC handler and strip discord_shown from database layer

## Objective

Delete the `app:update-discord-shown` IPC handler and remove all `discord_shown`/`discordShown` plumbing from the main-process database layer and the `app:record-open` IPC signature, including the now-unused `recordAppOpen` discordShown parameter and its in-tree caller at `main/src/index.ts:741`. Strip the `('hide_discord', 'false')` default-preference seed inserts and add an idempotent inline DELETE in the user_preferences init path. Orphan the `app_opens.discord_shown` SQLite column (no migration) with a one-line comment, per IDEA-016 assumption #3.

## Implementation Steps

1. **Completeness gate (sweep grep).** Run `grep -rn 'discord' main/src/` and `grep -rn 'discord' frontend/src/`. The main/src/ matches MUST shrink to exactly two after this task: (a) the `discord_shown` column declaration in CREATE TABLE, and (b) the new idempotent `DELETE FROM user_preferences WHERE key = 'hide_discord'`. The frontend/src/ matches MUST be 0 after TASK-684.

2. **Delete the `app:update-discord-shown` IPC handler.** In `main/src/ipc/app.ts`, delete lines 56–64 (the entire `ipcMain.handle('app:update-discord-shown', () => { ... })` block).

3. **Strip `discordShown` from the `app:record-open` handler.** Change the handler signature from `(_event, welcomeHidden: boolean, discordShown: boolean = false)` to `(_event, welcomeHidden: boolean)`. Change `services.databaseService.recordAppOpen(welcomeHidden, discordShown)` to `services.databaseService.recordAppOpen(welcomeHidden)`.

4. **Strip `discord_shown` from `recordAppOpen` database method.** Change signature to `recordAppOpen(welcomeHidden: boolean, appVersion?: string): void`. Change SQL to `INSERT INTO app_opens (welcome_hidden, app_version) VALUES (?, ?)`. Drop the middle `discordShown ? 1 : 0` argument.

5. **Strip `discord_shown` from `getLastAppOpen` database method.** Remove `discord_shown` from the SELECT projection, the return type, and the returned object literal.

6. **Delete the `updateLastAppOpenDiscordShown` database method** entirely.

7. **Update the internal call site in `main/src/index.ts:741`.** Change `databaseService.recordAppOpen(false, false, currentVersion);` to `databaseService.recordAppOpen(false, currentVersion);`.

8. **Annotate the orphaned `discord_shown` column.** Immediately before the `discord_shown BOOLEAN DEFAULT 0,` line inside `CREATE TABLE app_opens`, add: `-- Orphaned column (IDEA-016): no migration written; cheaper to leave than alter`. If better-sqlite3 rejects the SQL comment inside the template literal, fall back to a TypeScript comment on the line preceding the template-string literal.

9. **Delete both `('hide_discord', 'false')` default-preference seeds** (lines 805 and 812 in `database.ts`).

10. **Add the idempotent legacy-preference cleanup.** Inside the user_preferences init block, AFTER the create/repair branches but BEFORE the closing brace, insert:
    ```ts
    // Clean up the legacy 'hide_discord' preference row (IDEA-016). Idempotent: no-op if absent.
    this.db.prepare("DELETE FROM user_preferences WHERE key = 'hide_discord'").run();
    ```
    Place outside the if/else branching so it runs unconditionally on every launch.

11. **Final completeness gate.** Re-run greps from step 1; all must return expected counts.

12. **Build verification.** Run `pnpm typecheck` and `pnpm lint`. Both must exit 0.

13. **Manual launch verification.** Run `pnpm build:main && pnpm dev`. Confirm no Discord modal renders. Tail `cyboflow-backend-debug.log` for any errors mentioning the deleted symbols.

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests. Sibling-test scan confirmed no existing test exercises the deleted handlers or methods. Grep-zero ACs plus manual launch AC together cover both static and runtime invariants.

## Hardest Decision

**Where to place the idempotent DELETE and whether to gate it with an existence check.** Chose to place inline in the user_preferences init block, OUTSIDE the branching, so it runs unconditionally on every launch, and chose NOT to gate it with a SELECT existence check. SQLite's `DELETE ... WHERE key = ?` against a missing row is a sub-microsecond no-op. Running every launch (vs. once-then-tombstoning) correctly handles edge cases like a user who downgrades and re-runs an older version that re-creates the row.

## Rejected Alternatives

- **Writing a real numbered migration that ALTER TABLE DROPs the `discord_shown` column.** Rejected by IDEA-016 assumption #3 ("one orphaned column is cheaper than a migration").
- **Deleting the `app:get-last-open` handler entirely.** Rejected — IDEA-016 doesn't authorize it; plausibly useful for future "last open at" diagnostics.
- **Deleting the `welcome_shown` / `hide_welcome` default-preference seeds in the same pass.** Rejected — IDEA hard-fences this task at `discord_shown` / `hide_discord`.
- **Adding a runtime warning log when the legacy DELETE removes a row.** Rejected as unnecessary noise.

## Lowest Confidence Area

**The orphan-comment placement inside the SQL template literal.** Most SQLite drivers tolerate SQL comments on CREATE TABLE, but better-sqlite3's prepare path has not been exhaustively verified. If a "syntax error" surfaces at first launch, fall back to a TypeScript line comment on the line preceding the template-string literal itself.
