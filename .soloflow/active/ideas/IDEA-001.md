---
id: IDEA-001
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "crystal-cuts-and-rebrand"
slices:
  - title: "Delete Codex/OpenAI backend"
    description: "Remove codexPanel, codexManager, codexPanelManager, codex IPC handlers, frontend codex panel components. Multi-provider, if ever wanted, should be deliberate not inherited."
    value_statement: "Removes ~3000 lines of misleading code; eliminates the wrong-product-story risk during sprints"
  - title: "Delete Bull import and dependency"
    description: "Remove Bull import in taskQueue.ts; remove bull dependency from package.json. Crystal's docs say to use SimpleQueue but the import is still live."
    value_statement: "Eliminates Redis transitive dependency and ECONNREFUSED noise"
  - title: "Delete WorktreeNameGenerator API hop"
    description: "Replace AI-driven naming with deterministic cyboflow/<workflow>/<runId8>. Removes offline-breaking API call at session start."
    value_statement: "Deterministic, sortable, greppable; no API dependency at session start"
  - title: "Delete Linux/Windows-conditional paths"
    description: "Remove cross-platform code in PTY, filesystem, and packaging. macOS-only v1."
    value_statement: "Reduces cognitive overhead for Claude Code agents reviewing the codebase"
  - title: "Hide (do not delete) rebase/squash UI entry points"
    description: "Mark hidden methods in worktreeManager.ts with @cyboflow-hidden comment. Keep code intact but remove UI buttons."
    value_statement: "Preserves v2 optionality without burning code value"
  - title: "Delete multi-panel-per-session UI surfaces"
    description: "Remove panel creation menus and panel bar add-panel control. Underlying panel data model preserved temporarily."
    value_statement: "Aligns UI with 1:1 run-agent-worktree model"
  - title: "Rebrand to Cyboflow identity"
    description: "appId com.cyboflow.app, data dir ~/.cyboflow, ~/.cyboflow/sockets/, app icon placeholder, product name, README pin to Crystal HEAD commit hash."
    value_statement: "Enables signing/notarization setup against the real appId"
open_questions: []
assumptions: []
research_recommendation: not_needed
research_rationale: "Research already performed at roadmap level (see ROADMAP-001 research reports). Ecosystem and risks research grounded all specific cut decisions in the actual codebase state."
---

# Crystal Cuts and Rebrand

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "crystal-cuts-and-rebrand".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

System design context: `docs/cyboflow_system_design.md` §3 ("Foundation: Fork Crystal") names the explicit cut rule: "delete things whose presence would mislead; hide things whose presence is harmless but adds noise."

## Slices

See the `slices` field in frontmatter. The seven slices reflect the seven categories of work in this epic (Codex delete, Bull delete, AI naming delete, Linux/Windows delete, rebase/squash hide, multi-panel UI delete, rebrand).

## Open Questions

None — design doc §3 spells out the exact cuts with rationale; research confirmed all are still live in the codebase.

## Assumptions

None — validated during roadmap research.
