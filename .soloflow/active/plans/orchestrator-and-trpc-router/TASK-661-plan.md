---
id: TASK-661
idea: IDEA-018
status: ready
created: "2026-05-19T00:00:00Z"
files_owned:
  - main/src/orchestrator/runExecutor.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/index.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
files_readonly:
  - main/src/orchestrator/workflowPromptReader.ts
  - main/src/orchestrator/workflowRegistry.ts
  - shared/types/workflows.ts
  - .soloflow/active/plans/orchestrator-and-trpc-router/TASK-650-plan.md
  - .soloflow/archive/done/orchestrator-and-trpc-router/TASK-641-done.md
acceptance_criteria:
  - criterion: RunExecutor.getPrompt() default implementation is no longer NOT_IMPLEMENTED — it reads the workflow `.md` file at `workflow.workflow_path` via the injected `WorkflowPromptReaderLike.read(path)` collaborator and returns the body string. The narrow interface lets tests inject a stub without touching disk.
    verification: "grep -nE 'NOT_IMPLEMENTED: getPrompt' main/src/orchestrator/runExecutor.ts returns zero matches; grep -nE 'WorkflowPromptReaderLike|interface WorkflowPromptReaderLike' main/src/orchestrator/runExecutor.ts returns at least 2 matches (interface + constructor type); grep -nE 'this\\.promptReader\\.read' main/src/orchestrator/runExecutor.ts shows the call inside getPrompt."
  - criterion: "RunExecutor's constructor accepts the new `promptReader: WorkflowPromptReaderLike` argument and stores it on a private field. The interface declares one method: `read(workflowPath: string): { prompt: string; systemPromptAppend: string }`. (Synchronous — matches the existing `readWorkflowPrompt` API; no Promise wrapper to keep the standalone-typecheck contract simple.)"
    verification: "grep -nE 'private readonly promptReader: WorkflowPromptReaderLike' main/src/orchestrator/runExecutor.ts shows the field; grep -nE 'read\\(workflowPath: string\\): \\{ prompt: string; systemPromptAppend: string \\}' main/src/orchestrator/runExecutor.ts shows the interface; constructor arity increases by 1 and existing test setup updates accordingly."
  - criterion: "RunExecutor stores systemPromptAppend on a `pendingSystemPromptAppend: Map<string, string>` field at the same time as `getPrompt()` reads the file, then `buildOptionsOverrides(runId, run, workflow)` merges `{ systemPromptAppend: this.pendingSystemPromptAppend.get(runId) ?? undefined }` into the returned overrides. The `Map` is cleared by `teardownRun(runId)` to prevent leaks across runs."
    verification: "grep -nE 'pendingSystemPromptAppend' main/src/orchestrator/runExecutor.ts returns at least 4 matches (declaration, set, get-in-overrides, delete-in-teardown); a new unit test asserts buildOptionsOverrides returns `systemPromptAppend: '<value>'` when frontmatter contains it and `undefined` when absent."
  - criterion: "ClaudeSpawnerOptions adds an optional `systemPromptAppend?: string` field, and ClaudeCodeManager's `composeSystemPromptAppend` reads it. Precedence: the per-spawn `options.systemPromptAppend` (from workflow frontmatter) is appended AFTER the existing dbSession-derived append, separated by a single blank line. When the per-spawn append is empty/undefined, behavior is unchanged."
    verification: "grep -nE 'systemPromptAppend\\?: string' main/src/orchestrator/runExecutor.ts AND main/src/services/panels/claude/claudeCodeManager.ts each return at least 1 match; grep -nE 'options\\.systemPromptAppend' main/src/services/panels/claude/claudeCodeManager.ts returns at least 1 match inside composeSystemPromptAppend (or buildSdkOptions); a new unit test in claudeCodeManager tests asserts the per-spawn append is concatenated to the dbSession append when both are present."
  - criterion: "main/src/orchestrator/__tests__/runExecutor.test.ts adds three new cases: (i) 'getPrompt reads workflow file via injected reader', (ii) 'getPrompt throws WorkflowPromptReadError when file is missing — error bubbles up from execute()', (iii) 'buildOptionsOverrides includes systemPromptAppend from frontmatter'. The stub reader uses an in-memory map keyed by path."
    verification: "grep -nE 'getPrompt reads workflow file|getPrompt throws WorkflowPromptReadError|buildOptionsOverrides includes systemPromptAppend' main/src/orchestrator/__tests__/runExecutor.test.ts returns at least 3 matches; pnpm --filter cyboflow-main test -- runExecutor exits 0 with the new cases visible."
  - criterion: main/src/index.ts (or wherever TASK-650 step 10 constructs RunExecutor) passes a concrete `WorkflowPromptReader` instance whose `.read()` delegates to the existing `readWorkflowPrompt` helper in workflowPromptReader.ts. The adapter is a 5-line shim in main/src/index.ts (or a dedicated file if cleaner) — no new module unless the integration layer is messy.
    verification: "grep -nE 'readWorkflowPrompt' main/src/index.ts OR grep -rnE 'readWorkflowPrompt' main/src/orchestrator/*.ts shows the adapter wiring; constructor call to `new RunExecutor(...)` in main/src/index.ts (or its registry file) includes the prompt reader argument."
  - criterion: "RunExecutor remains standalone-typecheckable per the invariant at runExecutor.ts:5-9. Direct imports of `electron`, `better-sqlite3`, `main/src/services/*`, or concrete `WorkflowPromptReader` are forbidden — the reader is consumed only via `WorkflowPromptReaderLike`."
    verification: "grep -nE \"from 'electron'|from 'better-sqlite3'|from '\\.\\./services/|from '\\.\\./\\.\\./services/\" main/src/orchestrator/runExecutor.ts returns zero matches; grep -nE 'import .* from .*workflowPromptReader' main/src/orchestrator/runExecutor.ts returns zero matches (no concrete import — only the Like interface)."
  - criterion: Project-wide typecheck and lint pass; all existing runExecutor.test.ts cases stay green.
    verification: "pnpm typecheck && pnpm lint exit 0; pnpm --filter cyboflow-main test -- runExecutor reports all existing + new cases passing."
depends_on:
  - TASK-650
  - TASK-660
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Two contract surfaces meet here: RunExecutor's hook override and ClaudeCodeManager's spawn-option ingest. Both are silent integration points — wrong wiring (e.g. systemPromptAppend never threaded, or stored but never read) compiles cleanly and runs without obvious errors but leaves frontmatter directives unenforced. Three pin-point unit tests on the new flow + one on the per-spawn precedence in claudeCodeManager."
  targets:
    - behavior: getPrompt reads workflow_path via injected reader and returns the prompt string
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: getPrompt propagates WorkflowPromptReadError when file is missing — execute() does NOT swallow it
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: buildOptionsOverrides includes systemPromptAppend when workflow frontmatter has system_prompt_append
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: unit
    - behavior: claudeCodeManager.composeSystemPromptAppend concatenates per-spawn systemPromptAppend to dbSession append when both present
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
      type: unit
---
# Wire RunExecutor.getPrompt() and systemPromptAppend so workflows have real prompts

## Objective

RunExecutor today throws `NOT_IMPLEMENTED: getPrompt — TASK-641 must override` on every `execute()` call (`main/src/orchestrator/runExecutor.ts:148-150`). TASK-641 produced the `readWorkflowPrompt` helper (`main/src/orchestrator/workflowPromptReader.ts:59`) but never wired an override that calls it. Result: even after TASK-650 lands the RunExecutor construction and cancel/dispose surface, `execute()` still throws on the FIRST line that needs the prompt — well before Claude is reached.

This task closes that gap two ways:

1. **getPrompt becomes a default in the base RunExecutor** that delegates to an injected `WorkflowPromptReaderLike` collaborator. The reader is the existing `readWorkflowPrompt` function adapted as a 1-method object — `read(workflowPath): { prompt, systemPromptAppend }`. The "Like" suffix preserves the standalone-typecheck invariant: RunExecutor never imports the concrete helper.

2. **systemPromptAppend is plumbed through** from frontmatter → RunExecutor → ClaudeSpawnerOptions → ClaudeCodeManager.composeSystemPromptAppend. Today the `system_prompt_append` frontmatter field is read by `readWorkflowPrompt` but has nowhere to go. ClaudeSpawnOptions gains an optional `systemPromptAppend?: string`; composeSystemPromptAppend concatenates the per-spawn value AFTER the dbSession-derived append (single blank line separator). Falsy values are no-ops.

Per the standalone-typecheck invariant at `runExecutor.ts:5-9`, the prompt reader stays behind the `Like` interface. The concrete adapter lives in `main/src/index.ts` (or wherever TASK-650 step 10 constructs RunExecutor).

## Implementation Steps

1. **Define `WorkflowPromptReaderLike` in runExecutor.ts.** A narrow interface with one method: `read(workflowPath: string): { prompt: string; systemPromptAppend: string }`. Synchronous (matches `readWorkflowPrompt`). Throws `WorkflowPromptReadError` on missing files — RunExecutor lets it propagate (the catch arm in execute() converts it to a failed transition per TASK-662).

2. **Extend RunExecutor's constructor.** Add a 4th argument `promptReader: WorkflowPromptReaderLike` after `logger`. Store on `this.promptReader`. Update every test-file constructor call to pass a stub reader (the existing tests use `vi.fn()` shims; a `{ read: (path) => ({ prompt: 'test', systemPromptAppend: '' }) }` literal suffices).

3. **Override getPrompt().** Replace the `throw new Error('NOT_IMPLEMENTED ...')` body with:
   ```ts
   protected getPrompt(workflow: WorkflowRow): Promise<string> {
     const { prompt, systemPromptAppend } = this.promptReader.read(workflow.workflow_path);
     // Stash systemPromptAppend keyed by runId so buildOptionsOverrides can pick it up.
     // execute() resolves runId before calling getPrompt; we need to stash from the
     // execute() body instead of here. See step 4.
     return Promise.resolve(prompt);
   }
   ```
   The `Promise.resolve` keeps the existing async signature.

4. **Stash systemPromptAppend.** Add a private field `private pendingSystemPromptAppend = new Map<string, string>();`. Modify `execute()` (around runExecutor.ts:111): instead of calling `getPrompt(workflow)` directly, call a small helper that reads via the reader, stashes `systemPromptAppend` in the map keyed by runId, and returns the prompt. Or refactor: have `getPrompt` take `(runId, workflow)` and do the stash there — preserves the override surface but breaks the existing signature. Pick whichever fits TASK-650's step 7 (`buildOptionsOverrides`) cleanly.

5. **Wire buildOptionsOverrides.** TASK-650 AC6 has this returning `{ preToolUseHook: ... }`. Merge in `systemPromptAppend`: `return { preToolUseHook: ..., systemPromptAppend: this.pendingSystemPromptAppend.get(runId) || undefined }`. Empty string becomes undefined (so ClaudeCodeManager can short-circuit cleanly).

6. **Clear the map on teardown.** In `teardownRun(runId)` (added by TASK-650 step 4), add `this.pendingSystemPromptAppend.delete(runId)`.

7. **Plumb `systemPromptAppend` into ClaudeSpawnOptions.** In `main/src/services/panels/claude/claudeCodeManager.ts:21-39`, add `systemPromptAppend?: string` after `permissionMode`.

8. **Concatenate in composeSystemPromptAppend.** At `claudeCodeManager.ts:413-416`:
   ```ts
   private composeSystemPromptAppend(options: ClaudeSpawnOptions): string | undefined {
     const dbSession = this.sessionManager.getDbSession(options.sessionId);
     const sessionAppend = this.buildSystemPromptAppend(dbSession ? { ...dbSession } : { id: options.sessionId });
     const perSpawn = options.systemPromptAppend?.trim();
     if (!perSpawn) return sessionAppend;
     if (!sessionAppend) return perSpawn;
     return `${sessionAppend}\n\n${perSpawn}`;
   }
   ```

9. **Wire the concrete reader in main/src/index.ts.** Where TASK-650 step 10 constructs RunExecutor, also instantiate the adapter:
   ```ts
   import { readWorkflowPrompt } from './orchestrator/workflowPromptReader';
   const promptReader = { read: (path: string) => readWorkflowPrompt(path) };
   ```
   Pass `promptReader` to the RunExecutor constructor.

10. **Add the new unit tests** per `test_strategy.targets`. The runExecutor tests use the existing stub-spawner pattern; add a stub reader. The claudeCodeManager test exercises the per-spawn concatenation precedence with a real ClaudeCodeManager constructor (the existing test fixtures already cover this surface — extend a `describe` block).

11. **Verify locally**: `pnpm typecheck && pnpm lint && pnpm --filter cyboflow-main test`.

## Acceptance Criteria

See `acceptance_criteria` in frontmatter. Each is grep-checkable or test-runnable.

## Test Strategy

See `test_strategy.targets`. Three new vitest cases in `runExecutor.test.ts` cover the read + propagation + override threading; one in `claudeCodeManagerWiring.test.ts` covers the per-spawn precedence. Existing tests stay green by passing the stub reader through their setup helper.

## Hardest Decision

Where to stash `systemPromptAppend` between `getPrompt()` (which has the workflow row but no runId) and `buildOptionsOverrides(runId, run, workflow)` (which has runId but doesn't call the reader). Three options:

- **(A) Add runId to getPrompt's signature.** Breaks the protected hook contract; descendant overrides have to update. Low cost since RunExecutor has no production subclasses yet.
- **(B) Use a per-instance Map keyed by runId.** What this plan picks. Costs one field + teardown wiring. Keeps the existing hook surface stable.
- **(C) Move the file read into buildOptionsOverrides and have getPrompt re-read.** Two file reads per launch. Wasteful but stateless.

Recommendation: **B**. The Map cost is small (`Map<string, string>`, cleared on teardown), and the override contract stays clean for any future subclass. TASK-650's `teardownRun` already exists, so the clear is a one-liner.

## Rejected Alternatives

- **Build a concrete RunExecutor subclass in main/src/index.ts** that overrides `getPrompt`. Rejected — default-in-base matches the precedent set by TASK-650 step 8 (default `bridgeEvents` in the base), reduces the override surface for future callers, and keeps the standalone-typecheck contract intact via `WorkflowPromptReaderLike`.
- **Make `readWorkflowPrompt` async (Promise-returning) at the helper level.** Rejected — the existing API is synchronous; the .md file is small and the I/O is on the orchestrator's startup-adjacent path, not the spawn hot path. Don't async-ify needlessly.
- **Skip systemPromptAppend in v1; come back to it later.** Rejected — frontmatter is the one place where workflow authors express system-prompt intent. Shipping a `getPrompt` that silently drops `system_prompt_append` is the textbook "compiles but wrong" failure mode the project's TypeScript Rules (CLAUDE.md) explicitly call out.

## Lowest Confidence Area

The placement of step 4 (where to stash systemPromptAppend). If TASK-650 step 7 (`buildOptionsOverrides` defaulting) takes a different shape than the AC6 text suggests (e.g. it doesn't get `workflow` as an arg), step 5's merge call may need a different field-reading path. Mitigation: read the most recent TASK-650 done report (when it lands) before starting this task; if buildOptionsOverrides has been refactored, adjust step 5's merge accordingly.

## Dependencies

This task depends on **TASK-650** because it modifies `runExecutor.ts` after TASK-650's wholesale rewrite of cancel + dispose + ExecutionPhase. Trying to land in parallel would produce a guaranteed merge conflict. TASK-660 is a prerequisite because without GAP 1's fix, the launch sequence still throws before reaching RunExecutor.execute() — testing this task end-to-end is impossible until GAP 1 is in.
