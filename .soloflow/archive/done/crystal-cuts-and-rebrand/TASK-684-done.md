---
id: TASK-684
sprint: SPRINT-028
epic: crystal-cuts-and-rebrand
status: done
summary: "Deleted DiscordPopup component and removed all frontend call-sites from App.tsx; welcome flow preserved, main-process Discord surfaces left for TASK-685."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: skipped_unable
---

# TASK-684 — done

## Commit
- 45adaa0 feat(TASK-684): delete DiscordPopup component and remove all call-sites from App.tsx

## Changes
- `frontend/src/components/DiscordPopup.tsx` — deleted (git rm)
- `frontend/src/App.tsx` — removed: DiscordPopup import, isDiscordOpen/setIsDiscordOpen state, hide_discord preference reads, the discord-gate if-block (sole frontend caller of app:get-last-open / app:update-discord-shown / app:record-open), welcomeScreenShown variable + assignments, `<DiscordPopup>` JSX, orphan comment. Outer if(hideWelcome)/else collapsed into `if (!hideWelcome) { … }`.

## Verifier
APPROVED_WITH_DEFERRED — AC1..AC8 all MET via grep + typecheck + lint. AC9 (visual modal-absence) deferred to manual pnpm dev smoke; static evidence (import & JSX both gone with typecheck passing) makes mounting structurally impossible. Deferred entry queued.

## Code review
CLEAN — no critical/important/minor findings. Refactor of the surrounding `if/else` into `if (!hideWelcome) { … }` is the natural shape after the unused-vars sweep, not a hidden behavior change. Scope boundary held: no main/src/** files touched.

## Tests
NO_TESTS_NEEDED — test_strategy.needed: false in plan; sibling-test scan confirmed no test files target either owned file.
