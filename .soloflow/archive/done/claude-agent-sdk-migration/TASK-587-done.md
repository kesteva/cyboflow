---
id: TASK-587
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Add @anthropic-ai/claude-agent-sdk + tsx deps and scripts/sdk-smoke-probe.ts; probe runs live against subscription with exit 0."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-587 — Add @anthropic-ai/claude-agent-sdk + smoke probe

## Outcome

Foundational dependency landed: `@anthropic-ai/claude-agent-sdk@^0.2.141` is a runtime dep in `main/package.json`; `tsx@^4.22.0` is a root devDep; `pnpm smoke:sdk` invokes `scripts/sdk-smoke-probe.ts`. The probe streams SDK events as JSON lines and exits 0 only on `result.subtype === 'success'`. Verifier re-ran the probe end-to-end against the live Claude subscription (twice) — both runs emitted multiple `stream_event` lines and a terminal `result/success`. SDK substrate verified before any cyboflow service code commits to it.

## Files changed

- `package.json` (root) — `tsx ^4.22.0` devDep + `smoke:sdk` script
- `main/package.json` — `@anthropic-ai/claude-agent-sdk ^0.2.141`
- `pnpm-lock.yaml` — lockfile updated
- `scripts/sdk-smoke-probe.ts` — new file, 85 lines

## Verification

- `pnpm smoke:sdk` against live subscription: PASS (verifier independently confirmed)
- `pnpm typecheck`: PASS (3 workspaces clean)
- `pnpm lint`: PASS (0 errors)
- Verifier verdict: APPROVED (10/10 ACs)
- Code-review verdict: CLEAN

## Forward references

- TASK-590 will retype the probe's `as { type?: string }` escape hatch via TASK-589's retargeted union.
- The probe stays minimal and decoupled from `main/src` so future SDK upgrades can be validated against the raw library surface without churn from cyboflow refactors.
