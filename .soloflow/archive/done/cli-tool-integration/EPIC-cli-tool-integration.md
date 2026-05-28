---
epic: cli-tool-integration
created: 2026-05-21T00:00:00.000Z
status: complete
originating_ideas: [SPRINT-029-compound]
---

# CLI Tool Integration

## Objective

Stabilize and extend the cyboflow CLI tool integration surface — primarily `AbstractCliManager` and its `ClaudeCodeManager` concrete subclass — so that the in-process SDK path, kill/abort lifecycle, and pipeline/approval cleanup invariants are robust enough to safely host additional CLI tool integrations in future sprints. This epic exists per `docs/cyboflow_system_design.md:64`, which designates `AbstractCliManager` as an intentional extension surface.

## Scope

- In scope:
  - Test infrastructure that pins the `AbstractCliManager` / `ClaudeCodeManager` lifecycle contracts.
  - Single-sourced disposal invariants: pipeline cleanup, `clearPendingForRun`, processes/sdkRuns/pipelines map hygiene.
  - Tests that exercise the AbortController signal path under the SDK query mock.
- Out of scope:
  - Collapsing `AbstractCliManager` into `ClaudeCodeManager` (explicitly forbidden per `CLAUDE.md` "Preserved Extension Points").
  - Adding new concrete CLI integrations (separate future epic).
  - Production-code changes to `spawnCliProcess`'s `await iteratorDone` contract (intentional per `claudeCodeManager.ts:305-313`).

## Success Signal

`pnpm --filter main test` runs all CLI-manager unit tests green with no timeouts and no `TypeError` cascades in teardown. The kill/abort path's single-sourced disposal invariant (clearPendingForRun fires exactly once, from `runSdkQuery`'s finally) is asserted by passing tests on every commit. Future agents adding a second concrete `AbstractCliManager` subclass have a working test pattern to copy from.
