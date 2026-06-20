# Compound flow (preserved prose — original SoloFlow source)

> **Superseded — compound shipped natively.** This prose was preserved during the
> SoloFlow rip-out (P0), when `compound` was temporarily dropped. It has since been
> **rebuilt as a cyboflow-native flow** — see the live `main/src/orchestrator/workflows/compound.md`
> (launched from the Insights view), which writes the DB-canonical entity model via the
> `cyboflow_*` MCP tools. This file is kept only as the historical source the rebuild was
> grounded in; `compound.md` is authoritative.

## Intent

Pull durable learnings out of the most recent sprint(s) and fold them back into
the project's shared context (CLAUDE.md / CODE-PATTERNS.md) and the backlog,
so future runs start from a higher baseline. In the native rebuild, "learnings"
and proposed clean-ups should land as review-queue items / tasks via the
chokepoint, never as ad-hoc files.

## Original phase / step shape

Phase **Compound** (`#8b5cf6`):

1. `load-sprint` — agent `compounder` — Reads the sprint diff, verifier reports,
   and stuck-task notes.
2. `extract` — agent `compounder` — Drafts solution files for future sessions.
3. `approve-learnings` — agent `human` (human gate) — You decide which learnings
   get merged into shared docs.
4. `write-back` — agent `compounder` — Persists approved learnings into
   CLAUDE.md / CODE-PATTERNS.md / backlog.

## Native rebuild notes

- Replace "solution files" / "backlog" file writes with `cyboflow_create_task`
  (clean-up tasks) and review-queue `decision` items for CLAUDE.md edits.
- Source artifacts (sprint diff, verifier reports) come from the run's
  `raw_events` / checkpoints, not from `.soloflow/` archives.
