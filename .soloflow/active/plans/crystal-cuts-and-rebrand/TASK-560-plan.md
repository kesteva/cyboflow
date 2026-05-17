---
id: TASK-560
idea: SPRINT-002-compound
status: in-flight
created: "2026-05-12T00:00:00Z"
files_owned:
  - frontend/src/App.tsx
  - frontend/src/components/UpdateDialog.tsx
  - frontend/src/components/Help.tsx
  - frontend/src/components/Settings.tsx
  - frontend/src/components/NotificationSettings.tsx
  - frontend/src/components/DiscordPopup.tsx
  - frontend/src/components/ProjectSelector.tsx
  - frontend/src/components/ProjectSettings.tsx
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/ErrorBoundary.tsx
  - frontend/src/components/NimbalystInstallDialog.tsx
  - frontend/src/components/panels/SetupTasksPanel.tsx
  - frontend/src/components/panels/claude/ClaudePanel.tsx
  - frontend/src/types/config.ts
  - frontend/src/utils/performanceUtils.ts
  - frontend/src/styles/tokens.css
  - frontend/src/styles/tokens/colors.css
  - frontend/src/styles/tokens/effects.css
  - frontend/src/styles/tokens/spacing.css
  - frontend/src/styles/tokens/typography.css
files_readonly:
  - frontend/src/components/AboutDialog.tsx
  - .soloflow/active/findings/SPRINT-002-findings.md
acceptance_criteria:
  - criterion: "Auto-update notification title and body no longer say 'Crystal'"
    verification: "grep -n 'Crystal v\\${' frontend/src/App.tsx returns zero matches AND grep -n 'A new version of Crystal' frontend/src/App.tsx returns zero matches AND grep -n 'Cyboflow v\\${' frontend/src/App.tsx returns 1 match"
  - criterion: "No bare-word 'Crystal' remains in frontend/src/ except the AboutDialog attribution line"
    verification: "grep -rn --include='*.ts' --include='*.tsx' --include='*.css' -E '\\bCrystal\\b' frontend/src/ | grep -v 'AboutDialog.tsx:332' returns zero lines"
  - criterion: AboutDialog attribution line is preserved verbatim
    verification: "grep -n 'forked from Crystal (by Stravu)' frontend/src/components/AboutDialog.tsx returns exactly 1 match on line 332"
  - criterion: Settings.tsx Stravu utm_source parameters are flagged in the plan body as ESCALATE TO HUMAN (no code change required this task)
    verification: "grep -n 'utm_source=Crystal' frontend/src/components/Settings.tsx returns 1 match on line 643 (intentionally preserved pending human decision; see plan body)"
  - criterion: Frontend typecheck passes
    verification: pnpm --filter frontend typecheck exits with status 0
  - criterion: Frontend lint passes
    verification: pnpm --filter frontend lint exits with status 0
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Pure user-facing string sweep. The visible-behavior surface is asserted by the AC grep (zero residual 'Crystal' bare words outside the AboutDialog allowlist). No new sibling tests exist under frontend/src/components/ to keep green: `find frontend/src/components -name '*.test.*' -o -name '*.spec.*'` returns zero matches as of 2026-05-12. The migrateLocalStorageKey vitest spec (B4) is unrelated. Typecheck and lint are sufficient runtime gates."
---
# Bare-word "Crystal" copy sweep across frontend user-facing strings

## Objective

TASK-558 renamed Crystal→Cyboflow at the identity layer (kebab/dot/underscore tokens). It did not touch the bare capitalized word `Crystal` in user-visible strings. ~50 such matches remain across 21 files — most critically the auto-update notification (`frontend/src/App.tsx:292-293`) that fires on every version check. This task sweeps all bare-word `Crystal` references in `frontend/src/` and replaces them with `Cyboflow`, preserving exactly two intentional exemptions: the AboutDialog attribution line and the Stravu URL `utm_source` parameter (flagged for human decision).

## Implementation Steps

1. **Sweep gate (run as step 1 every time the executor returns).** Run:
   ```
   grep -rn --include='*.ts' --include='*.tsx' --include='*.css' -E '\bCrystal\b' frontend/src/
   ```
   At task start this prints every match to rewrite; at task end every line must either be in the allowlist (AboutDialog.tsx:332, Settings.tsx:643) or have been rewritten to `Cyboflow`.

2. **Rewrite App.tsx:292-293** (auto-update notification — highest priority): change `'🚀 Update Available - Crystal v${versionInfo.latest}'` → `'🚀 Update Available - Cyboflow v${versionInfo.latest}'` and `'A new version of Crystal is available!'` → `'A new version of Cyboflow is available!'`.

3. **Rewrite UpdateDialog.tsx** (lines 185, 265, 316, 318, 319, 348): every bare `Crystal` in the dialog copy becomes `Cyboflow`. Specifically: `"A new version of Crystal is available"` → `"A new version of Cyboflow is available"`; `"Crystal will restart"` → `"Cyboflow will restart"`; `"Close Crystal"` → `"Close Cyboflow"`; `"Drag Crystal to your Applications folder"` → `"Drag Cyboflow to your Applications folder"`; `"Launch the new version of Crystal"` → `"Launch the new version of Cyboflow"`; `"You're running the latest version of Crystal!"` → `"You're running the latest version of Cyboflow!"`.

4. **Rewrite Help.tsx** (lines 12, 27, 36, 255): `"Crystal Help"` → `"Cyboflow Help"`; `"Crystal runs Claude Code with"` → `"Cyboflow runs Claude Code with"`; `"Crystal will create it and initialize git"` → `"Cyboflow will create it and initialize git"`; `"Crystal - Manage multiple Claude Code instances with git worktrees"` → `"Cyboflow - Manage multiple Claude Code instances with git worktrees"`.

5. **Rewrite Settings.tsx** (lines 172, 227, 346, 347, 351, 356 ×3, 364, 392, 456, 523, 530, 572, 587, 619, 654): every bare `Crystal` becomes `Cyboflow`. Specific sites:
   - L172 modal title `"Crystal Settings"` → `"Cyboflow Settings"`
   - L227 `"Customize how Crystal looks and feels"` → `"Customize how Cyboflow looks and feels"`
   - L346 `"Crystal Attribution"` → `"Cyboflow Attribution"`
   - L347 `"Add Crystal branding to commit messages"` → `"Add Cyboflow branding to commit messages"`
   - L351 `"Include Crystal footer in commits"` → `"Include Cyboflow footer in commits"`
   - L356 `"commits made through Crystal will include a footer crediting Crystal. This helps others know you're using Crystal for AI-powered development."` → all three `Crystal` → `Cyboflow`
   - L364 `"Keep Crystal up to date"` → `"Keep Cyboflow up to date"`
   - L392 alert text `"You are running the latest version of Crystal!"` → `"You are running the latest version of Cyboflow!"`
   - L456 `"Note: Changes require restarting Crystal"` → `"Note: Changes require restarting Cyboflow"`
   - L523 `"Help improve Crystal by sharing anonymous usage data"` → `"Help improve Cyboflow by sharing anonymous usage data"`
   - L530 `"Crystal collects anonymous usage analytics..."` → `"Cyboflow collects anonymous usage analytics..."`
   - L572 `"Allow Crystal to collect anonymous usage data"` → `"Allow Cyboflow to collect anonymous usage data"`
   - L587 `"Thank you for helping improve Crystal!"` → `"Thank you for helping improve Cyboflow!"`
   - L619 `"Connect Crystal to your Stravu workspace"` → `"Connect Cyboflow to your Stravu workspace"`
   - L654 `"Made by the Crystal team"` → `"Made by the Cyboflow team"`
   - **Intentionally preserved:** L643 `utm_source=Crystal&utm_medium=OS&utm_campaign=Crystal&utm_id=1` in the Stravu URL. See Lowest Confidence Area.

6. **Rewrite NotificationSettings.tsx** (lines 42, 74, 80, 117): notification body `new Notification('Crystal', ...)` → `new Notification('Cyboflow', ...)`; `"Allow Crystal to show desktop notifications"` → `"Allow Cyboflow..."`; `"Crystal needs browser permission"` → `"Cyboflow needs browser permission"`; `"refresh Crystal"` → `"refresh Cyboflow"`.

7. **Rewrite DiscordPopup.tsx** (lines 106, 107, 115): `"Join the Crystal Community!"` → `"Join the Cyboflow Community!"`; `"Connect with other Crystal users"` → `"Connect with other Cyboflow users"`; `"Get help with Crystal and Claude Code"` → `"Get help with Cyboflow and Claude Code"`. **Note:** the Discord invite URL `https://discord.gg/XrVa6q7DPY` (line 78) currently points at the Crystal/Stravu Discord. Do NOT change the URL — see Lowest Confidence Area for ESCALATE TO HUMAN flag.

8. **Rewrite ProjectSelector.tsx** (lines 276, 326): both tooltips `"This is where Crystal will create worktrees..."` and `"Crystal will automatically detect this..."` → replace `Crystal` with `Cyboflow`.

9. **Rewrite ProjectSettings.tsx** (lines 142, 156, 388): tooltips `"Display name for this project in Crystal's interface."` → `"...in Cyboflow's interface."`; `"path...where Crystal will manage worktrees"` → `"...where Cyboflow will manage worktrees"`; delete-confirmation body `"will remove all project data from Crystal"` → `"...from Cyboflow"`.

10. **Rewrite DraggableProjectTreeView.tsx** (lines 2549, 2599): same tooltips as ProjectSelector (`Crystal will create worktrees` / `Crystal will automatically detect`) — replace both with `Cyboflow`.

11. **Rewrite ErrorBoundary.tsx** (line 57): `"Crystal encountered an unexpected error"` → `"Cyboflow encountered an unexpected error"`.

12. **Rewrite NimbalystInstallDialog.tsx** (line 87): `"the team that brought you Crystal"` → `"the team that brought you Cyboflow"`. **Note:** this string also references "Nimbalyst" as a product — if Nimbalyst marketing copy is intentionally legacy-Crystal-attributed, flag for human review. Default: rewrite to Cyboflow since Cyboflow is the current product.

13. **Rewrite SetupTasksPanel.tsx** (lines 108, 142, 200, 201, 204, 291, 338): every bare `Crystal` → `Cyboflow`. This includes the `.gitignore` comment template `'\n# Git worktrees (Crystal)'` → `'\n# Git worktrees (Cyboflow)'` and the commit message `'Add Crystal worktree patterns to .gitignore'` → `'Add Cyboflow worktree patterns to .gitignore'`.

14. **Rewrite ClaudePanel.tsx** (lines 55, 61, 63): debug console.log strings `'[slash-debug] Found init message...for Crystal session:'` → `'...for Cyboflow session:'` (3 occurrences). Pure debug logs — no UI surface, but inside `frontend/src/` so swept for consistency.

15. **Rewrite frontend/src/types/config.ts** (line 39 comment): `// Crystal commit footer setting (enabled by default)` → `// Cyboflow commit footer setting (enabled by default)`. **Coordinate with B2 (TASK-561) which renames the field name itself.** Touch only the comment line here; B2 owns the field rename.

16. **Rewrite frontend/src/utils/performanceUtils.ts** (line 1): `// Performance utilities for Crystal` → `// Performance utilities for Cyboflow`.

17. **Rewrite frontend/src/styles/tokens.css and frontend/src/styles/tokens/*.css** (5 files, header comments on line 1-2 of each): `/* … Design Tokens for Crystal */` → `/* … Design Tokens for Cyboflow */` in each of `tokens.css`, `colors.css`, `effects.css`, `spacing.css`, `typography.css`.

18. **Re-run sweep grep from step 1.** Expected output: exactly two matches: `frontend/src/components/AboutDialog.tsx:332` and `frontend/src/components/Settings.tsx:643`. Any other match is a sweep miss.

19. **Run `pnpm --filter frontend typecheck` and `pnpm --filter frontend lint`.** Both must exit 0.

## Acceptance Criteria

See frontmatter. The compound rule: the sweep grep in step 1 ends with exactly two intentional matches (AboutDialog attribution + Settings Stravu URL) and zero others.

## Test Strategy

No new tests. This is a pure user-facing string sweep with the executable surface fully captured by the AC grep + typecheck + lint. `find frontend/src/components -name '*.test.*'` returns zero matches; there are no sibling tests to keep green. The migrateLocalStorageKey vitest spec is in `frontend/src/utils/` and is unrelated to any file this task touches.

## Hardest Decision

Whether to flip the Stravu UTM source (`utm_source=Crystal`) and the Discord invite URL to Cyboflow values. **Decision: no, both are escalated to human.** The UTM parameter is an analytics attribution string — flipping it without Stravu's coordination breaks their referral attribution and silently mis-attributes Cyboflow traffic as Crystal traffic in their dashboard. The Discord invite URL `discord.gg/XrVa6q7DPY` points at the Stravu/Crystal Discord; if a separate Cyboflow Discord exists, the user must provide that URL. Both are flagged in Lowest Confidence Area as ESCALATE TO HUMAN.

## Rejected Alternatives

- **Bundle this sweep into B2 (enableCyboflowFooter rename).** Rejected: B2 is a code-symbol rename with a JSON config migration; this is a copy/string sweep with no migration. Mixing them produces a sprawling commit that's hard to review. They share only one file (Settings.tsx) and that's fine — atomic-commit policy lets us land them in sequence.
- **Use a regex find-replace across the whole tree.** Rejected: too risky for an unfocused `\bCrystal\b` replacement — would clobber the AboutDialog attribution line that must remain. The file-by-file approach scoped above is auditable.
- **Wait until after B2/B3 to avoid touching Settings.tsx twice.** Rejected: this task's edits to Settings.tsx are isolated to copy strings (label/title/description text), while B2 touches the same file at the symbol/handler level. They do not overlap line-for-line and can be committed in sequence with no rebase conflict if B2 follows B1.

## Lowest Confidence Area

**ESCALATE TO HUMAN — two items require explicit user direction before final commit:**

1. **Stravu UTM source parameter (`frontend/src/components/Settings.tsx:643`).** The URL `https://stravu.com/?utm_source=Crystal&utm_medium=OS&utm_campaign=Crystal&utm_id=1` uses `utm_source=Crystal` and `utm_campaign=Crystal`. The compounder direction says "check Settings.tsx for Stravu utm_source parameters." Without Stravu coordination, the safe default is to leave it. The user must decide: (a) keep as-is (Stravu still gets attribution under "Crystal" — current behavior), (b) flip to `utm_source=Cyboflow` (breaks Stravu's existing attribution dashboard until Stravu adds the new source), or (c) remove the UTM parameters entirely (no attribution at all).

2. **Discord invite URL (`frontend/src/components/DiscordPopup.tsx:78`).** The URL `https://discord.gg/XrVa6q7DPY` is the Stravu/Crystal Discord. The compounder direction says "verify DiscordPopup.tsx invite link points to the Cyboflow server." Either: (a) provide a new Cyboflow Discord URL to swap in, or (b) decide whether to keep linking to the Crystal Discord (with copy reframed as "Crystal community" — incompatible with the bare-word sweep this task does), or (c) hide/disable the popup entirely until a Cyboflow Discord exists. **This task as written rewrites the copy to "Cyboflow" but leaves the URL pointing at Crystal Discord — which is internally inconsistent. The executor MUST surface this for human decision before merging.**

Secondary concern: NimbalystInstallDialog.tsx line 87 ("the team that brought you Crystal") is product-marketing copy referencing the upstream Crystal team. If Cyboflow's Nimbalyst integration is meant to maintain Crystal lineage attribution, the rewrite is wrong. The default-rewrite-to-Cyboflow assumption may need user confirmation depending on marketing intent.
