---
id: TASK-652
idea: IDEA-018
status: in-flight
created: "2026-05-18T17:45:00Z"
files_owned:
  - main/src/orchestrator/markdownFrontmatter.ts
  - main/src/orchestrator/__tests__/markdownFrontmatter.test.ts
  - main/src/orchestrator/workflowPromptReader.ts
  - main/src/orchestrator/workflowRegistry.ts
files_readonly:
  - main/src/orchestrator/__tests__/workflowPromptReader.test.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - shared/types/workflows.ts
  - main/src/__test_fixtures__/tmp.ts
acceptance_criteria:
  - criterion: "New file main/src/orchestrator/markdownFrontmatter.ts exports `parseMarkdownFrontmatter(md: string): { frontmatter: Record<string, string>; body: string }`."
    verification: "grep -nE '^export function parseMarkdownFrontmatter' main/src/orchestrator/markdownFrontmatter.ts returns one match; signature matches the documented contract."
  - criterion: workflowPromptReader.splitFrontmatter is replaced by a call to parseMarkdownFrontmatter (function is deleted from workflowPromptReader.ts).
    verification: "grep -n 'function splitFrontmatter' main/src/orchestrator/workflowPromptReader.ts returns zero matches; grep -n 'parseMarkdownFrontmatter' main/src/orchestrator/workflowPromptReader.ts returns at least one match."
  - criterion: WorkflowRegistry.parseFrontmatter is replaced by a call to parseMarkdownFrontmatter; the local quote-stripping logic is removed since the helper owns it.
    verification: "grep -n 'parseFrontmatter' main/src/orchestrator/workflowRegistry.ts shows only call-site references (no local definition); grep -n 'parseMarkdownFrontmatter' main/src/orchestrator/workflowRegistry.ts returns at least one match."
  - criterion: "All existing tests pass: workflowPromptReader.test.ts (9 cases) and workflowRegistry.test.ts (existing N cases) stay green without modification."
    verification: pnpm --filter cyboflow-main test -- workflowPromptReader workflowRegistry exit 0.
  - criterion: "New test file main/src/orchestrator/__tests__/markdownFrontmatter.test.ts covers 6 cases: (a) standard LF frontmatter, (b) CRLF frontmatter, (c) single-quoted value strip, (d) double-quoted value strip, (e) `---` sequence inside body not treated as second delimiter, (f) missing frontmatter returns full body + empty record."
    verification: "test -f main/src/orchestrator/__tests__/markdownFrontmatter.test.ts; pnpm --filter cyboflow-main test -- markdownFrontmatter reports >= 6 passing cases."
  - criterion: Typecheck and lint stay clean.
    verification: "pnpm typecheck && pnpm lint exit 0."
depends_on:
  - TASK-640
  - TASK-641
estimated_complexity: low
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: Pure-extraction refactor with two callers and known boundary-condition divergence (the body-slice trailing-newline handling differs today). Each parse boundary needs a unit test on the new helper; the two existing test suites become regression coverage for the wiring.
  targets:
    - behavior: "Standard LF frontmatter — `---\nkey: value\n---\nbody.` returns frontmatter={key:'value'} and body='body.' (no trim — caller decides)."
      test_file: main/src/orchestrator/__tests__/markdownFrontmatter.test.ts
      type: unit
    - behavior: "CRLF frontmatter — `---\\r\nkey: value\\r\n---\\r\nbody.` returns the same shape as the LF case."
      test_file: main/src/orchestrator/__tests__/markdownFrontmatter.test.ts
      type: unit
    - behavior: Quote stripping — both single-quoted and double-quoted values have their wrapping quotes removed.
      test_file: main/src/orchestrator/__tests__/markdownFrontmatter.test.ts
      type: unit
    - behavior: "`---` inside body — the frontmatter regex is anchored to start-of-file; a `---` horizontal rule inside the body is preserved in the returned body string."
      test_file: main/src/orchestrator/__tests__/markdownFrontmatter.test.ts
      type: unit
    - behavior: Missing frontmatter — file without any `---` delimiter returns the full content as body and empty frontmatter record.
      test_file: main/src/orchestrator/__tests__/markdownFrontmatter.test.ts
      type: unit
    - behavior: "Multi-key frontmatter — three key:value lines all extract into the record; ordering is preserved (insertion order)."
      test_file: main/src/orchestrator/__tests__/markdownFrontmatter.test.ts
      type: unit
---
# Extract shared `parseMarkdownFrontmatter` helper

## Objective

End the duplication between `workflowPromptReader.splitFrontmatter` and `WorkflowRegistry.parseFrontmatter` by extracting a single canonical helper into `main/src/orchestrator/markdownFrontmatter.ts`. Both callers delegate to the new helper. This closes FIND-SPRINT-018-11 and the explicit deferral note in the TASK-641 plan ("Hardest Decision").

## Implementation Steps

1. **Create `main/src/orchestrator/markdownFrontmatter.ts`**:
   ```ts
   /**
    * markdownFrontmatter — single canonical flat-key:value frontmatter parser
    * for SoloFlow workflow files and ad-hoc markdown inputs.
    *
    * Shared by workflowPromptReader.readWorkflowPrompt and
    * WorkflowRegistry.parseFrontmatter. Do NOT inline a copy of this regex
    * anywhere else under main/src/orchestrator/.
    */
   export function parseMarkdownFrontmatter(md: string): {
     frontmatter: Record<string, string>;
     body: string;
   } {
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

2. **Update `workflowPromptReader.ts`**:
   - Delete the local `splitFrontmatter` function.
   - `import { parseMarkdownFrontmatter } from './markdownFrontmatter';`
   - Replace `splitFrontmatter(raw)` call with `parseMarkdownFrontmatter(raw)`.
   - The caller still trims the body and applies the empty-body throw — that logic stays in `readWorkflowPrompt` (helper is allocation-free of trimming policy).

3. **Update `workflowRegistry.ts`**:
   - Delete the local `parseFrontmatter` method.
   - `import { parseMarkdownFrontmatter } from './markdownFrontmatter';`
   - Wherever `parseFrontmatter` was called inside the registry, switch to the helper. If `extractPermissionMode` was a sibling that also parsed frontmatter, refactor it to consume the helper's output.

4. **Add `main/src/orchestrator/__tests__/markdownFrontmatter.test.ts`** with the 6 cases from `test_strategy.targets`. Use plain string inputs — no temp-file fixtures needed (the helper takes a string, not a path).

5. **Verify the existing test suites stay green without modification**:
   ```bash
   pnpm --filter cyboflow-main test -- workflowPromptReader workflowRegistry markdownFrontmatter
   ```

6. **Run typecheck + lint**:
   ```bash
   pnpm typecheck && pnpm lint
   ```

## Acceptance Criteria

See frontmatter. The two negative greps (no local `splitFrontmatter` in workflowPromptReader.ts, no local `parseFrontmatter` definition in workflowRegistry.ts) are the structural tripwire — re-inlining the helper in either site would fail the AC.

## Test Strategy

6 unit tests on the new helper covering LF/CRLF, single/double quote stripping, body-containing-`---`, and missing-frontmatter cases. The two existing test suites (workflowPromptReader.test.ts at 9 cases, workflowRegistry.test.ts at existing count) become regression coverage for the delegation wiring — they must stay green unchanged.

## Hardest Decision

Whether to share the body-trimming policy in the helper or leave it to the caller. Chose **caller-owns-trimming**: `workflowPromptReader` needs to detect empty-after-trim and throw; `WorkflowRegistry` may not need a trim at all. A helper that returns the raw body slice gives both callers the most flexibility with the smallest API surface.

## Rejected Alternatives

- **Add a `trim?: boolean` parameter to the helper.** Rejected — caller-side trimming is a one-line `.trim()` and parameterizing a no-op default makes the helper harder to read.
- **Use `js-yaml` for frontmatter parsing.** Rejected — adds a dependency for a 15-line regex; the existing flat-key:value semantics don't need YAML's full power.
- **Put the helper in `shared/utils/` instead of `main/src/orchestrator/`.** Rejected — `shared/` is currently types-only; introducing runtime code there would require a build-script change and the helper has no consumer outside `main/`.

## Lowest Confidence Area

`WorkflowRegistry.parseFrontmatter`'s exact body-extraction behavior. The TASK-641 plan flagged that the registry parser doesn't capture the body (it only returns the key:value map), while the reader parser does. The new helper returns both. The registry refactor must verify that consuming `{ frontmatter, body }` and discarding `body` produces the same key set as the current implementation — particularly around the trailing `\r?\n?` boundary which the registry currently doesn't consume. If a divergence surfaces, add a 7th test case that pins down the registry's current behavior (a `---\nkey: v\n---\nbody` input where the registry's caller expects `key: 'v'` regardless of trailing-newline state).
