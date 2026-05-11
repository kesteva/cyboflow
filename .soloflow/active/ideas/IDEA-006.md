---
id: IDEA-006
type: FEATURE
status: draft
created: 2026-05-11T00:00:00Z
roadmap: ROADMAP-001
roadmap_phase: "Phase 1 — Orchestrator Foundation"
roadmap_epic: "orchestrator-and-trpc-router"
slices:
  - title: "Install tRPC v11 + trpc-electron + p-queue + superjson"
    description: "Add trpc-electron@0.1.2 (mat-sz fork, NOT jsonnull/electron-trpc which has no v11 support), @trpc/server@^11 (pinned to version containing PR #6161 subscription-leak fix), @trpc/client@^11, superjson, p-queue. Verify @trpc/server changelog confirms PR #6161 is included before pinning."
    value_statement: "Net-new deps installed correctly the first time; locks the typed-IPC and per-run-queue libraries"
  - title: "Orchestrator class with start()/stop() and no Electron imports"
    description: "Create main/src/orchestrator/Orchestrator.ts as the single entry point. Module is testable in isolation; team-tier extraction is a swap of the IPC link, not a refactor."
    value_statement: "Preserves backend-extraction optionality; testable orchestrator unit"
  - title: "tRPC router skeleton for cyboflow.* procedures"
    description: "Define cyboflow.runs (list, start, cancel, get), cyboflow.approvals (listPending, approve, reject), cyboflow.workflows (list, get), cyboflow.events (onStreamEvent, onApprovalCreated). Crystal's existing ipcMain.handle stays for inherited surface; tRPC is for cyboflow.* only."
    value_statement: "Typed renderer↔orchestrator contract for the new surface"
  - title: "tRPC context with auth principal placeholder"
    description: "Context carries { userId: 'local' } as a forward-compat placeholder. Real auth in v2 team-tier becomes a swap."
    value_statement: "Auth-readiness from day 1 without paying any v1 cost"
  - title: "Server-side 60Hz throttle on onStreamEvent broadcast"
    description: "Throttle the tRPC subscription broadcast at 60Hz; full event fidelity still lands in raw_events. IPC has no built-in backpressure, so throttle must be server-side."
    value_statement: "Prevents IPC queue growth under high event rates (e.g., long Bash output)"
  - title: "Per-run p-queue({concurrency: 1}) registry keyed by runId"
    description: "Map<runId, PQueue> with documented no-recursive-enqueue rule. All state mutations for a run go through its queue. Status-change events flow via EventEmitter, NOT by re-entering the queue."
    value_statement: "Serializes inevitable races between Claude events and user actions"
open_questions:
  - "Does @trpc/server's published changelog explicitly call out PR #6161 inclusion, or do we verify by version-bisect?"
assumptions:
  - "trpc-electron@0.1.2 is sufficiently maintained for v1; the limited scope (cyboflow.* only) keeps blast radius small if the lib is buggy."
research_recommendation: not_needed
research_rationale: "Ecosystem research confirmed trpc-electron vs jsonnull/electron-trpc decision. Architecture research §3 detailed the subscription pattern and backpressure mitigation. Risks research §9 specified the memory-leak fix to pin."
---

# Orchestrator and tRPC Router

## Raw Input

Generated from ROADMAP-001, Phase "Phase 1 — Orchestrator Foundation", Epic "orchestrator-and-trpc-router".

## Grounding

See roadmap research reports:
- .soloflow/active/research/ROADMAP-001-research-ecosystem.md
- .soloflow/active/research/ROADMAP-001-research-user-needs.md
- .soloflow/active/research/ROADMAP-001-research-architecture.md
- .soloflow/active/research/ROADMAP-001-research-risks.md

Design doc §4 (architectural principles) and §6.3 (day-1 discipline: "build orchestrator as if separate process") drive this epic.

## Slices

See frontmatter `slices` field. Six slices: dep install, orchestrator class, tRPC router, auth context, throttle, p-queue registry.

## Open Questions

- @trpc/server version pin verification — needs changelog inspection or empirical test for memory-leak fix.

## Assumptions

- trpc-electron@0.1.2 is maintained enough for v1 scoped to cyboflow.* procedures.
