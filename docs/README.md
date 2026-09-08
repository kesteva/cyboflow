# docs/

Index of the documentation tree.

**Agent entry points:** shared guidance for all agents lives in
[`AGENT-GUIDE.md`](AGENT-GUIDE.md). Root-level `CLAUDE.md` (Claude runtimes) imports it;
root-level `AGENTS.md` (Codex, OMP, pi, other runtimes) points to it. Each of those two files
carries only runtime-specific notes. If a directory-scoped instruction file is ever needed,
put the shared guidance in that directory's `AGENTS.md` and make its `CLAUDE.md` a pointer —
no nested agent-guide files.

## Current reference docs

| Doc | What it covers |
| --- | --- |
| [`AGENT-GUIDE.md`](AGENT-GUIDE.md) | Shared agent guidance: two-layers rule, gotchas, commands, test tiers |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Components, data model, IPC contract, dual-substrate seam, build/test mechanics |
| [`CODE-PATTERNS.md`](CODE-PATTERNS.md) | Canonical code patterns: write chokepoints, type parity, test conventions |
| [`RELEASE-RUNBOOK.md`](RELEASE-RUNBOOK.md) | The release procedure: gate → 4 signed per-arch DMGs → R2 feeds → GitHub |
| [`UPDATES.md`](UPDATES.md) | R2 update channel, feed mechanics, per-variant data-dir resolution |
| [`WINDOWS-BUILD.md`](WINDOWS-BUILD.md) | Building for Windows, and the platform decisions behind the port |
| [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md) | sessions.db snapshots, raw_events shard archive, restore procedure |
| [`VISUAL-VERIFICATION-SETUP.md`](VISUAL-VERIFICATION-SETUP.md) | Seeing/driving the UI: CDP on :9223, Peekaboo fallback |
| [`SHELL-LAYOUT.md`](SHELL-LAYOUT.md) | Renderer shell geometry and navigation state |
| [`PERFORMANCE.md`](PERFORMANCE.md) | CPU/memory harness, baselines, measurement traps |
| [`PROVENANCE.md`](PROVENANCE.md) | Fork lineage (Crystal 0.3.5); never merge from Nimbalyst |
| [`eval-rubric.md`](eval-rubric.md) | The code-review eval rubric — spec of record for `main/src/orchestrator/eval/rubric.ts` |
| [`cyboflow_system_design.md`](cyboflow_system_design.md) | Historical MVP-era product spec (banner inside); ARCHITECTURE.md is current truth |
| `signing/`, `packaging/` | Apple signing setup + Gatekeeper checklist; root-deps policy |

## Design-time docs

`proposals/`, `plans/`, `design/`, `ideas/` hold point-in-time design documents. Shipped
and superseded ones move to `archive/` — except those still cited by section number from
source-code comments, which stay put with an updated status banner. Every file here carries
a current Status line (swept 2026-08); when in doubt, `git log` and the code outrank a
banner.

## Historical

- `archive/` — shipped/superseded docs (including the pre-fork `initial_research/`), moved
  here per the policy in `archive/README.md`.
- `crystal-legacy/` — Crystal-era guides; historical reference, not current truth.
- `workflows-future/`, `probes/`, `prototypes/`, `screenshots/`, `protoflow-design/` —
  flow-prose ideas, finished probe records, design mockups and capture assets.
  `protoflow-design/` is the source of the live design tokens.
