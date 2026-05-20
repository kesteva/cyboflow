---
id: IDEA-016
type: FEATURE
status: draft
created: 2026-05-18T19:30:00Z
source: user_braindump
roadmap_epic: "crystal-cuts-and-rebrand"
slices:
  - title: "Remove the Crystal-inherited Discord community popup"
    description: "Delete the 'Join the Cyboflow Community' Discord popup that appears on app launch, plus all of its supporting state (user_preferences row keyed 'hide_discord', app_opens.discord_shown column, IPC handler 'app:update-discord-shown', show-once gating logic in App.tsx). The popup is Crystal-era marketing UI that was string-rebranded but never re-decided for cyboflow — cyboflow has no Discord community and no current plans to run one, so the popup is misleading. Sibling Crystal-cuts task to IDEA-001's WelcomePopup-style removals."
    value_statement: "Removes a misleading Crystal-era marketing surface, eliminates one IPC handler + one DB column + one user_preferences row, and prevents the popup from interrupting the first-run onboarding flow that IDEA-008 (first-run-onboarding-and-self-host-acceptance) is shaping."
open_questions: []
assumptions:
  - "Cyboflow has no Discord server, no plans for one in v1, and no other community-channel substitute that this popup should be repointed to instead of removed."
  - "The hide_discord user_preferences row and app_opens.discord_shown column are referenced only by the popup-display logic and can be removed without cascading effects (verified via grep audit: ~19 references across App.tsx, DiscordPopup.tsx, and database.ts — no third consumer)."
  - "Removing the popup does not require a schema migration for existing users; the unused column can be left in place (orphaned) or dropped via a follow-up reconcile if desired. Plan should decide which approach."
research_recommendation: not_needed
research_rationale: "Pure removal task with concrete, fully-grepped surface area. No external dependencies to research; no architectural questions; no UX redesign needed (the decision is 'gone', not 'reshape')."
---

# Remove the Crystal-inherited Discord community popup

## Context

When cyboflow launches with `app_opens.discord_shown = 0` for the most recent row, a modal appears titled "Join the Cyboflow Community" with a "Join Discord Server" button, "Remind Me Later" link, and "Don't show this again" checkbox. This is Crystal's community-recruitment popup that was string-rebranded ("Crystal" -> "Cyboflow") but never re-decided. Cyboflow does not have a Discord server. The popup is misleading to users and interrupts the launch path.

Belongs in the `crystal-cuts-and-rebrand` epic alongside IDEA-001's other Crystal-cut slices.

## Raw Input

User flagged during manual app testing on 2026-05-18: "Can you add another task to remove this pop-up?" referring to the "Join the Cyboflow Community!" Discord modal that opens on first launch (and re-opens if `app_opens.discord_shown = 0`).

## Grounding

Concrete surface area (verified via grep on 2026-05-18):

**Frontend (deletions)**
- `frontend/src/components/DiscordPopup.tsx` — entire component, delete file.
- `frontend/src/App.tsx:18` — `import { DiscordPopup }` — delete.
- `frontend/src/App.tsx:57` — `const [isDiscordOpen, setIsDiscordOpen] = useState(false)` — delete.
- `frontend/src/App.tsx:197` — `preferences:get` call for `'hide_discord'` and the `hideDiscordResult` handling — delete.
- `frontend/src/App.tsx:244-275` — the two `app:get-last-open` blocks that gate `setIsDiscordOpen(true)` on `!lastOpen.discord_shown`, plus the `app:update-discord-shown` IPC call — delete.
- `frontend/src/App.tsx:455-458` — `<DiscordPopup isOpen={isDiscordOpen} onClose={...} />` JSX — delete.

**Main (deletions / clean-up)**
- `main/src/database/database.ts:805,812` — the `('hide_discord', 'false')` default-preference seeds — delete.
- `main/src/database/database.ts:2694-2712` — the `INSERT INTO app_opens (welcome_hidden, discord_shown, ...)` writer and `getLastAppOpen` returning `discord_shown` — adjust to drop the `discord_shown` field. Keep `welcome_hidden` (separate Welcome popup feature; out of scope).
- IPC handler for `app:update-discord-shown` — locate via grep `app:update-discord-shown` in `main/src/ipc/**` and delete.

**Database (decide in plan)**
- `app_opens.discord_shown BOOLEAN DEFAULT 0` (`database.ts:749`) — orphan the column (cheapest, no migration) OR drop it via a new reconcile-style migration (cleanest; SQLite 3.35+ supports ALTER TABLE DROP COLUMN and better-sqlite3 11.10 ships SQLite 3.49, so this is technically available).
- `user_preferences` row `('hide_discord', 'false')` — delete on next launch via an inline migration; idempotent (already a no-op if absent).

**Tests / fixtures**
- Search for `DiscordPopup` in `__tests__/` and `vitest`/`playwright` configs; remove or adjust.
- Update `frontend/src/components/__tests__/` snapshots if any reference the popup.

## Slices

### Remove the Discord popup
Single slice — pure deletion. See `slices[0]` in frontmatter and "Grounding" section above for the file-level breakdown.

## Open Questions

None — surface area is concrete and the product decision (delete) is clear.

## Assumptions

See `assumptions[]` in frontmatter. Key call: whether to drop the `app_opens.discord_shown` column or leave it orphaned. Plan should pick — recommend **orphan** for simplicity (consistent with leaving `description` and `updated_at` columns on the post-reconcile workflows table; one orphaned column is cheaper than a migration).

## Pre-work / Research needed

None. Surface fully grepped; no external dependencies.

## Sequencing

Independent of other in-flight epics. Can land any sprint. Most natural pairing is alongside IDEA-008 (first-run-onboarding-and-self-host-acceptance) so the post-removal launch flow is shaped coherently, but not a hard dependency — the popup can be removed before the new onboarding lands without any UX gap (the launch path just goes directly to the project picker, which is the same as if the user had already clicked "Don't show this again").
