---
id: IDEA-012
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 2 — Review Queue and Self-Host"
roadmap_epic: "first-run-onboarding-and-self-host-acceptance"
slices:
  - title: "First-run onboarding card explaining the review queue"
    description: "One-time card: 'Cyboflow pauses Claude when it needs to take an action. Approve or reject in this queue. Keyboard: j/k navigate, y/n decide.' Dismissed on first interaction; never shown again."
    value_statement: "Prevents 'why is Claude stopped?' confusion for first-time users; 0-cost addition"
  - title: "Auto-write .cyboflow/worktrees/ entry to project .gitignore"
    description: "On project add, append .cyboflow/worktrees/ to the project's .gitignore if not already present. Otherwise worktrees show as untracked changes in main checkout."
    value_statement: "Project-friendly default; no manual setup step"
  - title: "MCP server health surfaced in app status bar"
    description: "Green/yellow/red dot in status bar reflecting CyboflowMcpServer subprocess health. Click for diagnostics."
    value_statement: "First-run diagnostic visibility (paired with epic 10's app-boot health check)"
  - title: "1-day self-host acceptance run"
    description: "Full working day using Cyboflow for soloflow/planner/sprint/prune/compound runs on real repos. Log every fallback to Crystal/CLI as either fix-same-day or defer-to-ROADMAP-002. Target: zero fallbacks."
    value_statement: "THE MVP-done gate. Validates the entire product thesis end-to-end."
  - title: "Produce, sign, notarize the v1.0.0 DMG"
    description: "Final signed + notarized universal DMG via the pipeline set up in epic 2. Verify it opens on a clean macOS user account from the GitHub release page."
    value_statement: "Shippable artifact; the ship event"
  - title: "Tag Crystal commit in README; document license posture"
    description: "Pin the exact Crystal HEAD commit hash in the README. Document the pure-MIT posture and the explicit 'do not merge from Nimbalyst' rule."
    value_statement: "Provenance and license clarity for future maintainers"
open_questions: []
assumptions:
  - "The 1-day self-host date can be scheduled within the 2-week window. If signing rejections in week 2 delay the DMG, the self-host shifts but the gate is the same."
research_recommendation: not_needed
research_rationale: "The acceptance gate procedure is defined by the brief. Risks research §10 named the bugs only a long run will expose."
---

# First-Run Onboarding and Self-Host Acceptance

## Raw Input

Generated from ROADMAP-001, Phase "Phase 2 — Review Queue and Self-Host", Epic "first-run-onboarding-and-self-host-acceptance".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

This is the explicit MVP-done gate per the brief. Risks research §10 enumerated the failure surfaces that only a long sustained run will expose: tRPC subscription leaks, WAL checkpoint stalls, zombie PTYs, dock badge desync, p-queue recursive self-deadlock.

## Slices

See frontmatter `slices` field. Six slices: onboarding card, .gitignore auto-write, MCP health indicator, the self-host run itself, signed DMG production, license documentation.

## Open Questions

None.

## Assumptions

- The self-host day can be scheduled in the 2-week window.
