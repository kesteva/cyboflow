# Cyboflow Research Package

Research and design work for Cyboflow v1 architecture. Read in order if starting fresh; jump to `03-system-design.md` for the conclusions.

## Contents

| File | What it is | When to read |
|---|---|---|
| `01-stack-decision.md` | Foundational stack research: Electron vs Tauri vs Warp/Ghostty/tmux forks. Comparison matrix, recommended primary path. | When making cross-cutting tech choices (PTY libs, packaging, native modules). The *why* behind the system design's stack picks. |
| `02a-architecture-comparison.md` | Architecture deep dive part 1: TL;DR, findings, summary table, Day-1 task lists, recommendations, caveats. | When reasoning about Path A vs B trade-offs or planning Day-1 execution. |
| `02b-primitives-detail.md` | Architecture deep dive part 2: per-primitive detail across all 8 primitives — ASCII diagrams, TypeScript schemas, SQL DDL, state machines, failure modes. | When implementing any specific primitive. |
| `03-system-design.md` | **Canonical input.** Nine sections: thesis, stack, fork rationale, principles, primitives, Day-1 discipline, risks, out-of-scope, repo posture. | Read first. Drives epic decomposition. |
| `architecture-explorer.html` | Interactive diagram. Open in browser, click any of 8 modules to drill into Path A vs B, inheritance decisions, risks, ASCII diagrams. | Visual reference. |

## Reading order for the planner

1. `03-system-design.md` end-to-end. Canonical spec.
2. `02b-primitives-detail.md` sections matching epics being decomposed. Focus on Path A details — what Cyboflow actually builds.
3. `02a-architecture-comparison.md` for effort estimates, Day-1 sequencing, path-switch criteria.
4. `01-stack-decision.md` only for stack-level decisions the system design doesn't resolve.
5. `architecture-explorer.html` for visual reference.

## Cross-references

- System design section 3 "what gets ripped out" rule connects to `02b` per-primitive details.
- The 8 primitives in system design section 5 = the 8 primitives in `02b`. `03` has principles, `02b` has implementation.
- **Load-bearing** callouts (primitives #2 stream extraction, #7 review queue) are the differentiator's spine. Priority order when in doubt.
