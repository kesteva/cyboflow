---
id: TASK-560
sprint: SPRINT-014
epic: crystal-cuts-and-rebrand
status: done
summary: "Swept bare-word 'Crystal' → 'Cyboflow' across 20 frontend user-facing strings; intentional allowlist preserved (AboutDialog attribution, Settings UTM, DiscordPopup URL)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-560 — Done

## Outcome

Replaced all bare-word `Crystal` references in `frontend/src/` with `Cyboflow`, preserving the two intentional exemptions documented in the plan (AboutDialog attribution line, Settings Stravu UTM URL). 20 files touched: App.tsx, UpdateDialog.tsx, Help.tsx, Settings.tsx, NotificationSettings.tsx, DiscordPopup.tsx, ProjectSelector.tsx, ProjectSettings.tsx, DraggableProjectTreeView.tsx, ErrorBoundary.tsx, NimbalystInstallDialog.tsx, panels/SetupTasksPanel.tsx, panels/claude/ClaudePanel.tsx, types/config.ts, utils/performanceUtils.ts, styles/tokens.css, styles/tokens/{colors,effects,spacing,typography}.css.

## Verification

- Sweep grep: 2 matches total, both in allowlist (AboutDialog.tsx:332, Settings.tsx:643). Zero unaccounted.
- Frontend typecheck: exit 0.
- Frontend lint: 0 errors (306 pre-existing warnings).
- Verifier APPROVED on first round.
- Code reviewer CLEAN.

## Escalations for human review

1. **Settings.tsx:643** — Stravu UTM URL `utm_source=Crystal&utm_campaign=Crystal` preserved. User must decide whether to flip to Cyboflow (breaks Stravu attribution dashboard) or leave (Stravu still receives traffic attributed to Crystal).
2. **DiscordPopup.tsx:78** — Discord invite URL `discord.gg/XrVa6q7DPY` still points at the Stravu/Crystal Discord. Copy now says "Cyboflow Community" — internally inconsistent until a Cyboflow Discord URL is supplied.

## Commit

- `a89d714` feat(TASK-560): sweep bare-word Crystal → Cyboflow in frontend user-facing strings
