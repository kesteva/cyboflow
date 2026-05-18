---
id: TASK-641
idea: IDEA-018
status: in-flight
created: "2026-05-18T20:30:00Z"
files_owned:
  - main/src/orchestrator/workflowPromptReader.ts
  - main/src/orchestrator/__tests__/workflowPromptReader.test.ts
files_readonly:
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/types.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - shared/types/workflows.ts
  - main/src/__test_fixtures__/tmp.ts
acceptance_criteria:
  - criterion: "`main/src/orchestrator/workflowPromptReader.ts` exists and exports a single named function `readWorkflowPrompt(workflowPath: string): { prompt: string; systemPromptAppend: string }`."
    verification: "grep -nE '^export function readWorkflowPrompt\\(' main/src/orchestrator/workflowPromptReader.ts returns exactly one match."
  - criterion: "`readWorkflowPrompt` reads the file at `workflowPath` synchronously and returns the trimmed body below the frontmatter as `prompt`."
    verification: "Unit test `returns body below frontmatter as prompt` writes a temp .md file with a `---` frontmatter block followed by 'Hello workflow body.' and asserts the returned `prompt` is exactly 'Hello workflow body.'."
  - criterion: "When the frontmatter contains a `system_prompt_append` key, its value is returned as `systemPromptAppend`; when absent, `systemPromptAppend` is the empty string `''`."
    verification: "Two unit tests: (a) frontmatter with `system_prompt_append: \"Be terse.\"` yields `systemPromptAppend === 'Be terse.'`; (b) frontmatter without that key yields `systemPromptAppend === ''`."
  - criterion: Missing file at `workflowPath` throws `WorkflowPromptReadError` with a message that names the path.
    verification: "Unit test passes a non-existent path; expects `expect(...).toThrow(WorkflowPromptReadError)` AND the thrown error's `.message` includes the path string AND `.cause` is the underlying ENOENT error."
  - criterion: "Empty body (whitespace-only after frontmatter) throws `WorkflowPromptReadError` with a message that mentions 'empty'."
    verification: "Unit test writes a temp .md with only frontmatter and no body, expects `expect(...).toThrow(/empty/i)` and the error class is `WorkflowPromptReadError`."
  - criterion: "Files with no `---` frontmatter block return the full file content (trimmed) as `prompt` and `systemPromptAppend === ''`."
    verification: "Unit test writes a temp .md without any `---` line containing 'Just a prompt.', expects `prompt === 'Just a prompt.'` and `systemPromptAppend === ''`."
  - criterion: Module exports the typed error class `WorkflowPromptReadError` (a subclass of `Error`) so RunExecutor (TASK-640) can `instanceof`-check it.
    verification: "grep -nE 'export class WorkflowPromptReadError extends Error' main/src/orchestrator/workflowPromptReader.ts returns one match."
  - criterion: "`pnpm --filter main typecheck` passes with the new module — `workflowPromptReader.ts` has zero `any` usages."
    verification: "Run `pnpm --filter main typecheck` and confirm exit 0; run `grep -nE '\\bany\\b' main/src/orchestrator/workflowPromptReader.ts` and confirm zero matches inside type positions (matches inside identifiers like 'company' don't count — visual review)."
  - criterion: "`pnpm --filter main test -- workflowPromptReader` runs the new test file and all cases pass."
    verification: "Run `pnpm --filter main test -- workflowPromptReader` and confirm all cases under `describe('readWorkflowPrompt')` report green."
depends_on:
  - TASK-640
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "Pure-helper module with branchy parse logic and three throw paths (missing file, empty body, future parse error). Every branch needs a unit test. No existing test file in this directory covers the helper (it is a new module)."
  targets:
    - behavior: Body extraction below a standard `---` frontmatter block returns the trimmed body as `prompt`.
      test_file: main/src/orchestrator/__tests__/workflowPromptReader.test.ts
      type: unit
    - behavior: "`system_prompt_append` frontmatter key flows through to the returned `systemPromptAppend` field; absent key yields empty string."
      test_file: main/src/orchestrator/__tests__/workflowPromptReader.test.ts
      type: unit
    - behavior: Missing file at `workflowPath` throws `WorkflowPromptReadError` whose `.cause` is the ENOENT error and whose message includes the requested path.
      test_file: main/src/orchestrator/__tests__/workflowPromptReader.test.ts
      type: unit
    - behavior: "Empty body (whitespace-only after frontmatter) throws `WorkflowPromptReadError` with an 'empty'-mentioning message."
      test_file: main/src/orchestrator/__tests__/workflowPromptReader.test.ts
      type: unit
    - behavior: "Files without any `---` frontmatter return the trimmed full content as `prompt` and `systemPromptAppend === ''`."
      test_file: main/src/orchestrator/__tests__/workflowPromptReader.test.ts
      type: unit
    - behavior: "CRLF line endings in the frontmatter delimiter are handled (mirrors `workflowRegistry.parseFrontmatter`'s `\\r?\n` regex)."
      test_file: main/src/orchestrator/__tests__/workflowPromptReader.test.ts
      type: unit
---
# Construct Initial Prompt from Workflow `.md` File Body and Frontmatter

## Objective

Add a pure, standalone helper module `workflowPromptReader.ts` that reads a SoloFlow workflow `.md` file at `workflow_path`, extracts its body as the user-facing prompt and its `system_prompt_append` frontmatter key as a system-prompt fragment, and produces the two strings that TASK-640's `RunExecutor` passes to `ClaudeCodeManager.spawnCliProcess()` (`options.prompt` + the `systemPrompt.append` slot of `buildSdkOptions`). The helper commits to the IDEA-018 open-question 2 recommendation — `.md` body is the canonical prompt source; `spec_json` is reserved for v2. The module owns no DB, no IPC, no Electron imports — it is a synchronous file-reader + frontmatter parser with three explicit throw paths so `RunExecutor` can map failures to `workflow_runs.status='failed'`.

## Implementation Steps

1. **Create the new helper module at `main/src/orchestrator/workflowPromptReader.ts`** (this file does not exist; this step creates it). Module skeleton:

   ```ts
   import { readFileSync } from 'fs';

   export class WorkflowPromptReadError extends Error {
     constructor(message: string, options?: { cause?: unknown }) {
       super(message);
       this.name = 'WorkflowPromptReadError';
       if (options?.cause !== undefined) {
         (this as { cause?: unknown }).cause = options.cause;
       }
     }
   }

   export interface WorkflowPrompt {
     prompt: string;
     systemPromptAppend: string;
   }

   export function readWorkflowPrompt(workflowPath: string): WorkflowPrompt {
     let raw: string;
     try {
       raw = readFileSync(workflowPath, 'utf-8');
     } catch (err) {
       throw new WorkflowPromptReadError(
         `readWorkflowPrompt: could not read workflow file at ${workflowPath}`,
         { cause: err },
       );
     }

     const { frontmatter, body } = splitFrontmatter(raw);
     const trimmedBody = body.trim();
     if (trimmedBody.length === 0) {
       throw new WorkflowPromptReadError(
         `readWorkflowPrompt: workflow body is empty at ${workflowPath}`,
       );
     }

     const systemPromptAppend = frontmatter['system_prompt_append'] ?? '';
     return { prompt: trimmedBody, systemPromptAppend };
   }

   function splitFrontmatter(md: string): { frontmatter: Record<string, string>; body: string } {
     const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
     if (!match) {
       return { frontmatter: {}, body: md };
     }
     const fmBlock = match[1];
     const body = md.slice(match[0].length);
     const out: Record<string, string> = {};
     for (const line of fmBlock.split(/\r?\n/)) {
       const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
       if (!m) continue;
       let val = m[2];
       if (
         (val.startsWith('"') && val.endsWith('"')) ||
         (val.startsWith("'") && val.endsWith("'"))
       ) {
         val = val.slice(1, -1);
       }
       out[m[1]] = val;
     }
     return { frontmatter: out, body };
   }
   ```

   Mirror the regex shape used by `WorkflowRegistry.parseFrontmatter` (`main/src/orchestrator/workflowRegistry.ts:174-192`) so CRLF behavior and quote-stripping behave identically across the two parsers. Do NOT extract a shared parser — that's a separate refactor outside this slice's scope.

2. **Create the test file at `main/src/orchestrator/__tests__/workflowPromptReader.test.ts`**. Use the `withTempDir` helper from `main/src/__test_fixtures__/tmp.ts` (see `main/src/orchestrator/__tests__/runLauncher.test.ts` for the established pattern). Seven cases in one `describe('readWorkflowPrompt')` block:
   1. returns trimmed body below frontmatter
   2. extracts system_prompt_append when present
   3. returns empty systemPromptAppend when absent
   4. throws WorkflowPromptReadError on missing file (with .cause ENOENT)
   5. throws WorkflowPromptReadError on empty body (matches /empty/i)
   6. handles file without any frontmatter
   7. handles CRLF line endings in frontmatter delimiter

3. **Document the integration contract for TASK-640 inside the new module's JSDoc**: add a `@see` reference at the top of `workflowPromptReader.ts` pointing readers to where `RunExecutor` calls it (`getPrompt()` hook → passes `prompt` and `systemPromptAppend` through `ClaudeCodeManager.composeSystemPromptAppend` semantics in `main/src/services/panels/claude/claudeCodeManager.ts:413-416`).

4. **Run `pnpm --filter main typecheck`** and confirm exit 0. The only `any` risk is the `cause` assignment, handled via `(this as { cause?: unknown })`.

5. **Run `pnpm --filter main test -- workflowPromptReader`** and confirm all 7 cases pass.

## Acceptance Criteria

All criteria listed in frontmatter must be objectively true after the executor reports COMPLETED. The two grep-based criteria — for `export function readWorkflowPrompt` and `export class WorkflowPromptReadError extends Error` — are structural and must match in the new module. The unit-test criteria all run inside the new test file via vitest and must report green.

## Test Strategy

Seven unit tests in a single new file `main/src/orchestrator/__tests__/workflowPromptReader.test.ts`, all using vitest + `withTempDir` for filesystem isolation. Three positive paths, two negative paths (throws), one "absent key" path, one CRLF-handling path. No mocking required — the spec runs the helper end-to-end against real temp files.

## Hardest Decision

Whether to extract a shared frontmatter parser between `WorkflowRegistry` and this new helper. **Rejected**: parsers are tiny (~15 LOC each), the IDEA scopes this task as "DOES NOT modify WorkflowRegistry's schema or seed logic", and a shared parser would force a cross-cutting refactor outside this slice. The two parsers are intentionally parallel; if a third caller appears, that's the moment to extract.

## Rejected Alternatives

- **`spec_json` as the canonical prompt source.** Rejected per IDEA-018 open-question 2 — recommended is `.md` body. `spec_json` exists in the schema and is reserved for v2.
- **Async `readFile` instead of sync `readFileSync`.** Every adjacent reader is sync; `RunExecutor.getPrompt()` is a one-shot launch-time call. Async would force the extension point to await an instantly-resolving promise.
- **Returning `null` / `undefined` for missing-file or empty-body.** The IDEA maps these to `workflow_runs.status='failed'` with an `error_message`. A typed error class with a `.cause` chain gives `RunExecutor` the cleanest mapping path.
- **Reading `spec_json` first and falling back to `.md`.** v1 never writes `spec_json` (always `'{}'` per migration 006); the fallback would always fire and the dual path would be dead code.

## Lowest Confidence Area

Whether the `system_prompt_append` frontmatter convention is the right key name and shape. No existing SoloFlow workflow `.md` file actually sets this key; the contract ships as a forward-looking placeholder. When no workflow file sets the key, every `RunExecutor` invocation passes through an empty `systemPromptAppend` and the SDK's `append` slot stays `undefined` (matches `claudeCodeManager.ts:383` — `... ?? undefined`). If future workflows pick a different name, this helper will silently return `''`. Mitigation: the integration JSDoc in step 3 surfaces the parser to anyone wiring a new key.
