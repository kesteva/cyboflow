---
id: TASK-587
idea: IDEA-014
status: approved
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/package.json
  - package.json
  - scripts/sdk-smoke-probe.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - pnpm-workspace.yaml
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
acceptance_criteria:
  - criterion: "@anthropic-ai/claude-agent-sdk is declared as a runtime dependency in main/package.json at version ^0.2.141 or compatible."
    verification: "grep -nE '\"@anthropic-ai/claude-agent-sdk\"\\s*:\\s*\"\\^?0\\.2\\.' main/package.json exits 0 with a match inside the dependencies block; the package resolves at node_modules/@anthropic-ai/claude-agent-sdk/package.json (test -f node_modules/@anthropic-ai/claude-agent-sdk/package.json exits 0 after pnpm install)."
  - criterion: tsx is declared as a devDependency at the repo root so scripts/sdk-smoke-probe.ts can be executed without a pre-compile step.
    verification: "node -e \"const p=require('./package.json');process.exit(p.devDependencies&&p.devDependencies.tsx?0:1)\" exits 0."
  - criterion: "A pnpm script named smoke:sdk is registered at the repo root and invokes scripts/sdk-smoke-probe.ts via tsx."
    verification: "node -e \"const p=require('./package.json');process.exit(p.scripts&&/tsx\\s+scripts\\/sdk-smoke-probe\\.ts/.test(p.scripts['smoke:sdk'])?0:1)\" exits 0."
  - criterion: "scripts/sdk-smoke-probe.ts exists, is TypeScript, imports { query } from '@anthropic-ai/claude-agent-sdk', and passes systemPrompt.type === 'preset', systemPrompt.preset === 'claude_code', and includePartialMessages: true to query()."
    verification: "test -f scripts/sdk-smoke-probe.ts && grep -q \"from '@anthropic-ai/claude-agent-sdk'\" scripts/sdk-smoke-probe.ts && grep -q \"preset: 'claude_code'\" scripts/sdk-smoke-probe.ts && grep -q 'includePartialMessages:\\s*true' scripts/sdk-smoke-probe.ts && grep -q \"type:\\s*'preset'\" scripts/sdk-smoke-probe.ts each exit 0."
  - criterion: The probe script sets options.cwd to a valid absolute path (defaulting to process.cwd()).
    verification: "grep -q 'cwd:' scripts/sdk-smoke-probe.ts exits 0; the cwd value is process.cwd() or a literal absolute path beginning with '/'."
  - criterion: "The probe script exits 0 on receipt of a result event with subtype === 'success' and exits non-zero on any other terminal state (result with subtype !== 'success', no result event before the async iterator completes, or thrown exception)."
    verification: "grep -q \"subtype === 'success'\" scripts/sdk-smoke-probe.ts && grep -qE 'process\\.exit\\(\\s*0\\s*\\)' scripts/sdk-smoke-probe.ts && grep -qE 'process\\.exit\\(\\s*[1-9]' scripts/sdk-smoke-probe.ts each exit 0."
  - criterion: The probe script prints each event as a JSON-stringified line to stdout (one line per event).
    verification: "grep -qE 'console\\.log\\(JSON\\.stringify\\(' scripts/sdk-smoke-probe.ts exits 0; running pnpm smoke:sdk emits at least one line whose parsed JSON has type === 'stream_event' and at least one line with type === 'result' (manual verification — script run is the AC, not a grep)."
  - criterion: "Running pnpm smoke:sdk against the user's logged-in Claude subscription completes successfully: at least one stream_event event is printed, the terminal result event is printed with subtype === 'success', and the process exits with code 0."
    verification: "pnpm smoke:sdk 2>&1 | tee /tmp/sdk-smoke.log; echo \"exit=$?\"; grep -q '\"type\":\"stream_event\"' /tmp/sdk-smoke.log && grep -q '\"type\":\"result\"' /tmp/sdk-smoke.log && grep -q '\"subtype\":\"success\"' /tmp/sdk-smoke.log; echo $?"
  - criterion: pnpm typecheck remains green after the dependency and script additions.
    verification: pnpm typecheck exits 0.
  - criterion: pnpm lint remains green after the dependency and script additions.
    verification: pnpm lint exits 0.
depends_on: []
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "This task is itself a smoke probe — scripts/sdk-smoke-probe.ts IS the integration test for the SDK at runtime, executed via pnpm smoke:sdk and gated by the result-subtype-success acceptance criterion. Directory-level sibling-test scan results: scripts/configure-build.test.js exists in scripts/ but covers electron-builder configuration logic and has no overlap with sdk-smoke-probe (different domain, no shared exports, different test runner — it's a plain Node assertion file). No __tests__/ or tests/ subdirectory under scripts/. Adding a unit test that mocks query() would only verify the mock plumbing, not that the real SDK works against the real subscription, which is the entire point of the probe. Downstream tasks (TASK-590, TASK-594) will introduce SDK-mock fixtures; this task deliberately does not, to keep the probe as a pure ground-truth integration check."
---
# Add @anthropic-ai/claude-agent-sdk dependency and write smoke-probe script

## Objective

De-risk the entire claude-agent-sdk-migration epic before any cyboflow service code is touched: install `@anthropic-ai/claude-agent-sdk` as a real runtime dependency in the `main` workspace, add the `tsx` runner the EPIC body wrongly assumes already exists, and ship `scripts/sdk-smoke-probe.ts` — a standalone, ~60-line TypeScript program that invokes `query()` with the exact option shape downstream tasks will adopt (`systemPrompt: { type: "preset", preset: "claude_code", append: ... }` and `includePartialMessages: true`), streams its events as JSON lines, and exits 0 only on receipt of `result.subtype === "success"`. The probe proves the SDK works against the user's Claude subscription on this machine, with this Node version, before TASK-588/589/590 commit cyboflow to it. No cyboflow service code is touched.

## Prerequisites Note (for executor)

The IDEA-014 body and the prompt context claimed `tsx` is already in devDependencies — that is FALSE as of this plan. The refiner verified via `grep '"tsx"' package.json` (no match), `node_modules/.bin/tsx` (absent), and a workspace-wide scan (only string mentions are inside `frontend/package-lock.json`, not as a declared dep). Adding `tsx` to root devDependencies is part of step 2 of this task — do not skip it expecting it to already be present.

## Implementation Steps

1. **Verify ground truth before mutating.** Run the following pre-flight greps and confirm each result matches the precondition this plan assumes. Abort and escalate if any disagree:
   - `grep -n '"@anthropic-ai/claude-agent-sdk"' main/package.json` → expect **no match** (we are adding it).
   - `grep -n '"@anthropic-ai/claude-agent-sdk"' package.json` → expect **no match**.
   - `grep -n '"tsx"' package.json main/package.json frontend/package.json shared/package.json 2>/dev/null` → expect **no match** in any `devDependencies`/`dependencies` block (the workspace lacks tsx today).
   - `test -f scripts/sdk-smoke-probe.ts && echo EXISTS || echo MISSING` → expect `MISSING` (we are creating it).
   - `cat pnpm-workspace.yaml` → confirm the three workspaces are `frontend`, `main`, `shared`.

2. **Install `tsx` at the repo root as a devDependency.** From the repo root:
   ```
   pnpm add -D -w tsx@^4.19.0
   ```
   The `-w` flag scopes the install to the root `package.json` (not a child workspace), which is the right home for a developer-tools script runner used by repo-root `scripts/`. Verify after install: `node -e "console.log(require('./package.json').devDependencies.tsx)"` prints a `^4.x.x` string.

3. **Install `@anthropic-ai/claude-agent-sdk` in the `main` workspace.** From the repo root:
   ```
   pnpm --filter main add @anthropic-ai/claude-agent-sdk@^0.2.141
   ```
   This lands the dep in `main/package.json` (not the root), matching the EPIC's stated home for the SDK. Verify: `grep -n '"@anthropic-ai/claude-agent-sdk"' main/package.json` returns one match inside the `dependencies` block; `test -f node_modules/@anthropic-ai/claude-agent-sdk/package.json` exits 0.

4. **Register the `smoke:sdk` script in the root `package.json`.** Edit the root `package.json` `scripts` block. Insert one entry, keeping the existing entries untouched:
   ```json
   "smoke:sdk": "tsx scripts/sdk-smoke-probe.ts"
   ```
   Place it adjacent to the existing `test`, `test:ci` group for visibility. Do not modify any other scripts entry.

5. **Create `scripts/sdk-smoke-probe.ts` as a new file.** This file does not exist today and must be created. Contents (use exactly this structure — the SDK option shape must match downstream task expectations verbatim):

   ```ts
   #!/usr/bin/env tsx
   /**
    * SDK smoke probe — TASK-587 (claude-agent-sdk-migration epic).
    *
    * Standalone integration check that proves @anthropic-ai/claude-agent-sdk works
    * against the user's logged-in Claude subscription on this machine, before any
    * cyboflow service code commits to the SDK. Exits 0 on result.subtype === 'success';
    * exits non-zero on any other terminal state (different subtype, no result event,
    * or thrown exception).
    *
    * Usage: pnpm smoke:sdk
    *
    * Intentionally NOT importing from main/src — this probe must stay decoupled
    * from cyboflow internals so future SDK upgrades can be validated against the
    * raw library surface without churn from cyboflow refactors.
    */
   import { query } from '@anthropic-ai/claude-agent-sdk';

   const PROMPT = "Reply with exactly one word: 'pong'.";
   const SYSTEM_PROMPT_APPEND =
     'You are running in cyboflow SDK smoke-probe mode. Respond concisely.';

   async function main(): Promise<number> {
     let sawStreamEvent = false;
     let sawResultSuccess = false;

     try {
       const stream = query({
         prompt: PROMPT,
         options: {
           cwd: process.cwd(),
           systemPrompt: {
             type: 'preset',
             preset: 'claude_code',
             append: SYSTEM_PROMPT_APPEND,
           },
           includePartialMessages: true,
         },
       });

       for await (const event of stream) {
         // Print every event as a JSON line for observability.
         console.log(JSON.stringify(event));

         if ((event as { type?: string }).type === 'stream_event') {
           sawStreamEvent = true;
         }
         if ((event as { type?: string }).type === 'result') {
           const subtype = (event as { subtype?: string }).subtype;
           if (subtype === 'success') {
             sawResultSuccess = true;
           } else {
             console.error(
               `[sdk-smoke-probe] result event had non-success subtype: ${String(subtype)}`,
             );
           }
         }
       }
     } catch (err) {
       console.error('[sdk-smoke-probe] query() threw:', err);
       return 2;
     }

     if (!sawStreamEvent) {
       console.error(
         '[sdk-smoke-probe] FAIL: no stream_event events observed (includePartialMessages may not be honored).',
       );
       return 3;
     }
     if (!sawResultSuccess) {
       console.error(
         '[sdk-smoke-probe] FAIL: stream ended without a result event of subtype "success".',
       );
       return 4;
     }

     console.error('[sdk-smoke-probe] OK: result.subtype === "success".');
     return 0;
   }

   main().then(
     (code) => process.exit(code),
     (err) => {
       console.error('[sdk-smoke-probe] unhandled rejection:', err);
       process.exit(5);
     },
   );
   ```

   Notes on the `as { type?: string }` casts: cyboflow's `no-explicit-any` rule forbids `any` (see project CLAUDE.md). The narrow inline shape assertion is the project's standard pattern for poking at SDK event types without bringing in (potentially `any`-resolving — see SDK issue #181) `SDKMessage`. Downstream tasks (TASK-589) will replace this with the proper retargeted discriminated union; the probe deliberately stays minimal.

6. **Run the probe end-to-end against the live subscription.** From the repo root:
   ```
   pnpm install   # ensure both new deps are materialized
   pnpm smoke:sdk
   ```
   Expected: stdout contains JSON lines including at least one `"type":"stream_event"` and one terminal `"type":"result"` with `"subtype":"success"`. Process exit code is 0. If the probe exits 2/3/4/5, do NOT proceed — capture the stderr line and escalate; the entire downstream epic depends on this probe passing.

7. **Repo-wide post-checks.** Run the three gates the CI pipeline will run, all from the repo root:
   - `pnpm install` — must complete cleanly (lockfile updated for both new deps).
   - `pnpm typecheck` — must exit 0. The new probe TS file is not under any workspace `tsconfig.include` glob (workspaces include only their own `src/`), so it will only be type-checked when invoked via tsx, which is by design. Still verify the workspace typechecks remain green.
   - `pnpm lint` — must exit 0. The probe file is outside the main `eslint src` glob (which targets `main/src` per `main/package.json:13`), so it should not be linted as part of `pnpm lint`. Confirm the lint output does not report scripts/sdk-smoke-probe.ts.

8. **Commit per project policy.** One atomic commit for this task: `feat: add claude-agent-sdk dep and SDK smoke probe (TASK-587)`. Stage only `package.json`, `main/package.json`, `pnpm-lock.yaml`, and `scripts/sdk-smoke-probe.ts`.

## Acceptance Criteria

Restated for clarity (each maps 1:1 to a frontmatter entry):

1. `@anthropic-ai/claude-agent-sdk` ^0.2.141 is in `main/package.json` dependencies and resolved in `node_modules/`.
2. `tsx` is in root `package.json` devDependencies.
3. Root `package.json` has a `smoke:sdk` script invoking `tsx scripts/sdk-smoke-probe.ts`.
4. `scripts/sdk-smoke-probe.ts` exists, imports `query` from `@anthropic-ai/claude-agent-sdk`, and passes `systemPrompt.type === 'preset'`, `systemPrompt.preset === 'claude_code'`, and `includePartialMessages: true` to it.
5. The probe sets `options.cwd` to a valid absolute path (default: `process.cwd()`).
6. The probe exits 0 ONLY on `result.subtype === 'success'`; non-zero (2/3/4/5) on any other terminal state.
7. The probe prints each event as a JSON-stringified line.
8. `pnpm smoke:sdk` against the user's logged-in Claude subscription emits at least one `stream_event`, the terminal `result` event with `subtype: "success"`, and exits 0.
9. `pnpm typecheck` is green.
10. `pnpm lint` is green.

## Test Strategy

No new unit/integration test files are added. The probe script itself is the integration test for this task, and AC #8 (running `pnpm smoke:sdk` end-to-end and asserting the exit code + event presence) is the verification. See `test_strategy.justification` in the frontmatter for the directory-level sibling-test scan results.

## Hardest Decision

**Where does `tsx` live, and how do we run a TypeScript script from a CommonJS-configured `main` workspace + a Vite-React `frontend` workspace + a `shared` types workspace, without dragging a new TS-runtime config into any of those?**

Three options were considered:

- **(a) Pre-compile via `main`'s existing `tsc`.** Add `scripts/sdk-smoke-probe.ts` to a new tsconfig include, run `pnpm --filter main build`, then `node main/dist/scripts/sdk-smoke-probe.js`. Rejected: the probe sits at the repo root (per the EPIC's "developer tool, keep at root" directive in the task context), not under `main/src/`, so it would require either moving the probe into `main/` (contradicts EPIC) or creating a one-off tsconfig that includes one file (over-engineered for a 60-line script). Also: the executor would have to remember to rebuild before re-running.
- **(b) Use Node's experimental `--experimental-strip-types` flag.** Avoids adding any tooling. Rejected: the workspace targets Node 22.14+ per root `package.json:engines.node`, where strip-types is still flagged behind `--experimental-*`; the flag's behavior and default-on status varies across Node 22.x patch versions. Cyboflow's CI and dev machines may be on any 22.x patch level — too fragile for a probe whose job is to be reliable.
- **(c) Add `tsx` to root devDependencies and use `tsx scripts/...`.** Chosen. `tsx` is the de-facto standard for "I want to run a TS file like a script" in 2025+, ~7MB on disk, has zero runtime config, handles ESM/CJS transparently, and uses the same SWC pipeline most of the JS ecosystem already vendors. The EPIC body wrongly claimed it was already a devDep — adding it now is a one-line correction.

This decision also unblocks the future use of `scripts/` as a Node-TypeScript site for developer tools (currently the `scripts/` directory is plain `.js`, which forces stringly-typed access to anything from `main/`). Low blast radius — tsx never ships in the Electron bundle.

## Rejected Alternatives

- **Putting the SDK in root `dependencies` instead of `main/package.json`.** Rejected because the EPIC explicitly says "Add `@anthropic-ai/claude-agent-sdk` (≥ 0.2.x) as a direct dependency in `main/package.json`" — the SDK is consumed by `main/src/services/panels/claude/claudeCodeManager.ts`, not by the renderer or the shared types. What would change my mind: if `shared/` were ever to consume SDK types directly (it likely won't — `shared/types/claudeStream.ts` will retain its own discriminated union per the EPIC), then `shared/package.json` would be a defensible home.
- **Writing the probe in `.mjs` instead of `.ts`.** Would avoid the tsx dependency. Rejected because losing TypeScript loses the very thing this migration is *for* — typed events. Future probe maintenance (when SDK 0.3+ ships with breaking event shapes) is easier with types on. The 60-line probe would re-acquire `any`-laden access patterns that we deliberately stamp out elsewhere via `no-explicit-any`.
- **Putting the probe under `main/scripts/` (workspace-local) and running it via `pnpm --filter main exec node ...` after compile.** Considered briefly. Rejected: the EPIC's task-context note explicitly directs "keep it at the repo root since it's a developer tool", and `main/`'s `tsc` build pipeline is for the production Electron main bundle, not for scratch probes. Keeping probes at root is the cyboflow norm (cf. `scripts/configure-build.js`, `scripts/inject-build-info.js`).
- **Using the SDK's `canUseTool` predicate to exercise the permission path in the probe.** Rejected: the parity spike explicitly chose `PreToolUse` hooks for richer audit semantics, and the probe is about proving the dependency chain works, not exercising every parity feature. TASK-590 will wire `PreToolUse` against `ApprovalRouter` — that's the right place for the permissions-path proof. Including it here would couple this task to TASK-588 (ApprovalRouter) and break the no-dependency model.

## Lowest Confidence Area

**Authentication mode the SDK picks up on this machine, and whether `result.subtype === 'success'` is the right success oracle.**

The SDK reads credentials from the same `~/.config/claude/` (or equivalent) store the `claude` CLI uses, but cyboflow's user runs through `claude -p` today, and the SDK path has never been exercised on this machine. Two failure modes the probe might surface that the plan can't pre-empt:

1. **Credential discovery diverges between the CLI and the SDK.** The user has a working `claude` CLI install, but the SDK initialization might prompt for a fresh login or fail to find credentials. The probe will emit a `result` event with `subtype` other than `success` (or throw, caught by the try/catch returning exit 2). The plan's exit-code spread (2/3/4/5) is designed to distinguish these failure classes, but the *remediation* for credential-discovery divergence is out of scope for this task — it would block TASK-590 too.

2. **SDK `result.subtype` values that aren't `'success'`.** Per the parity spike and the npm/docs surface, the SDK emits `SDKResultSuccess` and `SDKResultError` types with `subtype: 'success'` and `subtype: 'error_*'`. But the SDK changelog notes the `result` event shape has churned across 0.2.x patches. If 0.2.141 (or whatever resolves on install day) introduces a new subtype like `'partial'` or `'rate_limited'` that should count as success-for-probing-purposes, the probe will over-reject. The probe's JSON-line emission to stdout is the recovery path: the user can inspect the actual emitted `result` event, decide whether the subtype should be treated as success, and update the success oracle in a follow-up commit. The plan deliberately does not pin a specific SDK patch version (uses `^0.2.141`) to absorb this churn — pinning would be a separate decision for TASK-590 when the SDK is on the cyboflow main process critical path.
