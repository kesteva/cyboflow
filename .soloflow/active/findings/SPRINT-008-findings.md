---
sprint: SPRINT-008
pending_count: 1
last_updated: "2026-05-14T22:48:42.627Z"
---
# Findings Queue

- override: gating-prereqs
  task: TASK-595
  reason: "Prereq probes at sprint-init are checking files that TASK-587/590/591/592/593 will produce within this sprint; TASK-595 depends_on TASK-591 + TASK-594 (DAG enforces ordering), and TASK-595's own plan step 1 re-runs the prereq checks at executor time. Gating now would defeat the sprint's terminal smoke step."
  applied_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)

## FIND-SPRINT-008-1
- **source:** TASK-588 (verifier)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** main package — better-sqlite3 native binding
- **description:** better-sqlite3 prebuilt binary at node_modules/.pnpm/better-sqlite3@11.10.0/.../better_sqlite3.node is built for NODE_MODULE_VERSION 137 but the active Node runtime requires 127. This blocks every vitest case in main/src/orchestrator/__tests__/approvalRouter.test.ts from running (8/8 fail at db construction time). Reproduces identically on `main` pre-commit — pre-existing, not introduced by TASK-588. CLAUDE.md documents the fix (`pnpm electron:rebuild`).
- **suggested_action:** Run `pnpm electron:rebuild` from the repo root. Re-run `cd main && pnpm test -- approvalRouter` to confirm the 8 tests pass with case count preserved.
