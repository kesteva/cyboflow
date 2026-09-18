# cyboflow — Claude entry point

All shared engineering guidance (project orientation, the two-layers rule, gotchas, commands,
test tiers, reference-doc index) lives in the agent guide imported below. It is canonical for
every runtime; this file adds only what is Claude-specific. Non-Claude agents (Codex, OMP,
pi) start at `AGENTS.md` instead, which points at the same guide.

@docs/AGENT-GUIDE.md

## Claude-specific

- `.claude/agents/*.md` are generated, gitignored spawn-time artifacts — the workflow bundle
  writer regenerates them from `main/src/orchestrator/workflows/*/agents/*.md` at every
  session/lane spawn. Edit the flow agent prompts there, never in `.claude/agents/` (a hand
  edit there is invisible to git and vanishes on the next spawn).
