---
id: TASK-632
idea: SPRINT-014-COMPOUND
status: pending
created: "2026-05-17T00:00:00Z"
files_owned:
  - frontend/src/components/Settings.tsx
  - frontend/src/components/DiscordPopup.tsx
  - frontend/src/components/AboutDialog.tsx
files_readonly:
  - CONTRIBUTING.md
  - CHANGELOG.md
  - com.stravu.crystal.metainfo.xml
acceptance_criteria:
  - criterion: "DECISION 1: Stravu UTM URL — user has selected option A/B/C and recorded it below"
    verification: "grep -nE '^DECISION 1 RESOLVED:' .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-632-plan.md returns 1 match identifying A | B | C"
  - criterion: "DECISION 2: Discord invite URL — user has selected option A/B/C and recorded it below"
    verification: "grep -nE '^DECISION 2 RESOLVED:' .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-632-plan.md returns 1 match identifying A | B | C"
  - criterion: "Code changes per resolution; grep verifies each URL matches the chosen state (specific verification depends on chosen option)"
    verification: "(parametric — see Implementation Steps for per-option grep)"
  - criterion: "pnpm typecheck and pnpm lint pass"
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "URL/string swap with no logic change. Byte-level grep assertions on the chosen URL string are sufficient verification. No sibling tests exist for the three touched files."
---
# Settle branding decisions: UTM parameters and Discord invite URL

## Objective

TASK-560 deliberately preserved two URLs pending user decision: (1) the Stravu UTM-tagged link in Settings.tsx:643, and (2) the Stravu/Crystal-era Discord invite in DiscordPopup.tsx:78,81 + AboutDialog.tsx:297. Popup copy now says "Join the Cyboflow Community!" while the URL still points at the Crystal/Stravu Discord — internally inconsistent. This task is blocked on user input; both decisions get recorded in the plan body, then code changes follow mechanically.

**STATUS: pending — DO NOT execute until both decisions are recorded below.**

---

## DECISIONS (to be filled in by user before execution)

### Decision 1: Stravu UTM URL (Settings.tsx:643)

Options:
- **A. Keep as-is.** URL stays `https://stravu.com/?utm_source=Crystal&utm_medium=OS&utm_campaign=Crystal&utm_id=1`. Preserves Stravu's existing attribution. Internally inconsistent (we don't ship "Crystal" anymore) but harmless.
- **B. Flip to Cyboflow.** URL becomes `https://stravu.com/?utm_source=Cyboflow&utm_medium=OS&utm_campaign=Cyboflow&utm_id=1`. Stravu's dashboard needs a new source entry; until added, the click is uncategorized.
- **C. Remove UTM params entirely.** URL becomes `https://stravu.com/` (bare).

`DECISION 1 RESOLVED: <fill in A | B | C and rationale here>`

### Decision 2: Discord invite URL (DiscordPopup.tsx:78,81 + AboutDialog.tsx:297)

Options:
- **A. Keep Stravu/Crystal Discord.** URL stays `https://discord.gg/XrVa6q7DPY`. Popup says "Cyboflow Community" but invite goes to Stravu/Crystal Discord — internally inconsistent but functional.
- **B. Use a new Cyboflow Discord.** User must provide the new invite URL.
- **C. Remove Discord popup + AboutDialog Discord button.** Mark DiscordPopup with `@cyboflow-hidden`; remove AboutDialog Discord block entirely.

`DECISION 2 RESOLVED: <fill in A | B | C and rationale here>`

---

## Implementation Steps

**Do not begin until both decisions are recorded and frontmatter `status: pending` is updated to `status: ready`.**

1. **Pre-flight sweep:** `grep -rn 'utm_source=Crystal' frontend/src` and `grep -rn 'discord.gg/XrVa6q7DPY' frontend/src` — confirm match set matches files_owned.

2. **Apply Decision 1** to Settings.tsx:643 per chosen option (no-op + comment / replace UTM / strip UTM).

3. **Apply Decision 2** to DiscordPopup.tsx:78,81 + AboutDialog.tsx:297 per chosen option.

4. **Run per-option AC grep** (encoded once decisions are recorded).

5. **Run `pnpm typecheck && pnpm lint`** — both 0.

6. **Visual smoke (recommended):** open Settings → Stravu link, AboutDialog → Discord button, DiscordPopup → Join button; confirm each destination.

## Hardest Decision

Whether to use `@cyboflow-hidden` annotation for Option A (keep Crystal URLs) — that pattern is for unreachable code, but these URLs are reachable. Resolved by using a sub-comment pattern: `// Decision TASK-632: keep Crystal UTM for Stravu attribution continuity` that documents the rationale without misusing the annotation.

## Lowest Confidence Area

Exact file set per decision. The grep sweep in step 1 is authoritative; if Option B for Decision 2, user must supply the URL before execution.
