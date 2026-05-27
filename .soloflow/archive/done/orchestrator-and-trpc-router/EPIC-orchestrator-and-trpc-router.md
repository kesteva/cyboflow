---
epic: orchestrator-and-trpc-router
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-006]
---

# Orchestrator and tRPC Router

## Objective

Stand up the orchestration layer — a single `Orchestrator` class in `main/src/orchestrator/` exposed via a typed `tRPC` router using `trpc-electron@0.1.2` (mat-sz fork, the only v11-compatible Electron link) — that the rest of the Cyboflow surface boots through. The orchestrator module is testable in isolation (no Electron imports inside `main/src/orchestrator/` except the dedicated `ipcAdapter.ts`), so the v2 team-tier extraction is a transport-link swap rather than a refactor. The tRPC contract for `cyboflow.*` procedures (runs, approvals, workflows, events) is locked in this epic; the procedure bodies fill in over downstream epics (workflow-runs, approval-router, stream-parser-to-main).

## Scope

- In scope:
  - Install net-new deps: `trpc-electron@0.1.2`, `@trpc/server` pinned to a v11 release that includes PR #6161 (subscription memory-leak fix), `@trpc/client` matching, `superjson`, `p-queue`, `zod`.
  - `Orchestrator` class with `start()` / `stop()` lifecycle and dependency-injected collaborators.
  - `RunQueueRegistry`: `Map<runId, PQueue({ concurrency: 1 })>` with drain-on-delete semantics and a documented no-recursive-enqueue rule.
  - tRPC router skeleton: `cyboflow.runs`, `cyboflow.approvals`, `cyboflow.workflows`, `cyboflow.events` with NOT_IMPLEMENTED placeholder bodies — the shape is the deliverable, not the implementations.
  - tRPC context carrying `{ userId: 'local' }` as the auth-principal placeholder for v2 team-tier readiness.
  - Server-side 60Hz async-iterator throttle for `onStreamEvent` to prevent IPC queue growth under high event rates; `raw_events` storage still receives full fidelity (the throttle is per-subscription, not at the source).
  - IPC adapter wiring (`ipcAdapter.ts`) that bridges the router to the renderer via trpc-electron — the only place inside `main/src/orchestrator/trpc/` permitted to import from `'electron'`.
- Out of scope:
  - Real implementations of `cyboflow.runs.start`, `cyboflow.approvals.approve`, etc. — those land in workflow-runs, approval-router, and stream-parser-to-main epics.
  - Crystal's inherited `ipcMain.handle` surface — left untouched. tRPC is additive for `cyboflow.*` only.
  - PermissionManager rewrite — that's the approval-router-and-permission-fix epic.
  - DB schema migration — that's the cyboflow-schema-migration epic.

## Success Signal

A fresh `pnpm install` + `pnpm electron-dev` boots the app; the renderer's DevTools console can `await trpc.cyboflow.runs.list.query({})` and receive a `NOT_IMPLEMENTED` tRPC error (proving the typed-IPC link is live end-to-end); `pnpm --filter main typecheck` confirms `main/src/orchestrator/` is free of `'electron'` imports except inside `ipcAdapter.ts`; `pnpm --filter main test` shows the RunQueueRegistry, Orchestrator, throttle, and router tests passing; and Crystal's existing IPC surface (session creation via the inherited UI) still works.
