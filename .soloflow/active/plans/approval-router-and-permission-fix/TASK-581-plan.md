---
id: TASK-581
idea: SPRINT-006-compound
status: ready
source_sprint: SPRINT-006
created: 2026-05-14T00:00:00Z
files_owned:
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
files_readonly:
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/package.json
  - .soloflow/active/findings/SPRINT-006-findings.md
  - .soloflow/active/compound/SPRINT-006-proposal.md
  - .soloflow/active/plans/approval-router-and-permission-fix/EPIC-approval-router-and-permission-fix.md
acceptance_criteria:
  - criterion: "cyboflowPermissionIpcServer.ts defines a zod envelope schema for inbound `permission-request` messages: `{ type: 'permission-request', requestId: string (non-empty), sessionId: string (non-empty), toolName: string (non-empty), input: record }`"
    verification: "grep -nE 'z\\.object|z\\.literal|z\\.string|z\\.record' main/src/services/cyboflowPermissionIpcServer.ts returns at least 4 matches AND grep -n \"z\\.literal\\('permission-request'\\)\" main/src/services/cyboflowPermissionIpcServer.ts returns 1 match"
  - criterion: "The schema is applied via `.safeParse(...)` (not `.parse(...)`) on every incoming parsed line, before the message is passed to ApprovalRouter"
    verification: "grep -nE '\\.safeParse\\(' main/src/services/cyboflowPermissionIpcServer.ts returns at least 1 match AND grep -nE '\\.parse\\(' main/src/services/cyboflowPermissionIpcServer.ts returns 0 matches"
  - criterion: "On schema failure, the handler logs the validation error and, if the raw payload happens to contain a recoverable `requestId` string, writes a deny response with `behavior: 'deny'` back on the socket. Otherwise (no recoverable requestId) the line is logged and dropped — the connection stays open."
    verification: "grep -nE \"behavior:\\s*['\\\"]deny['\\\"]\" main/src/services/cyboflowPermissionIpcServer.ts returns at least 2 matches (one for ApprovalRouter error catch, one for new validation-fail path); grep -nE 'safeParse|success.*===.*false|\\.success' main/src/services/cyboflowPermissionIpcServer.ts returns matches in the validation-fail branch"
  - criterion: "Raw payload size gate: before `JSON.parse`, each accumulated line is rejected if it exceeds 1 MB. The buffer is reset on oversize line so a stuck megabyte-long unterminated line cannot grow unbounded."
    verification: "grep -nE '1024\\s*\\*\\s*1024|1_048_576|MAX_LINE_BYTES' main/src/services/cyboflowPermissionIpcServer.ts returns at least 1 match AND the buffer-loop in cyboflowPermissionIpcServer.ts checks line.length (or buffer.length) before JSON.parse"
  - criterion: "Unit tests cover: (a) valid permission-request passes through to ApprovalRouter, (b) message with missing requestId returns a logged validation failure (and no ApprovalRouter call), (c) message with non-record `input` field is rejected, (d) message exceeding 1 MB is dropped and the buffer is reset"
    verification: "grep -cE 'zod|safeParse|invalid|missing requestId|oversize|1 ?MB' main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts returns at least 4 AND pnpm --filter main test cyboflowPermissionIpcServer exits 0 and shows at least 4 new cases (in addition to the framing cases from TASK-580)"
  - criterion: "Main process typecheck passes"
    verification: "pnpm --filter main typecheck exits 0"
  - criterion: "Main process lint passes"
    verification: "pnpm --filter main lint exits 0"
  - criterion: "No new runtime dependency is added — zod is already declared in main/package.json"
    verification: "grep -nE '\"zod\":' main/package.json returns 1 match (the existing entry); diff of main/package.json shows zero new dependency lines added in this task"
depends_on:
  - TASK-580
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "Input validation is a security boundary — the boundary must be exercised by tests, not just typed. Four cases. Shares the test file with TASK-580's framing cases (same file lives in main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts)."
  targets:
    - behavior: "Valid `permission-request` envelope passes zod parse and reaches ApprovalRouter.requestApproval"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
    - behavior: "Envelope missing `requestId` is rejected by zod, ApprovalRouter is NOT called, and (if a recoverable raw-payload `requestId` exists) a deny reply is written"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
    - behavior: "Envelope with non-record `input` (e.g. string, null) is rejected by zod"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
    - behavior: "Oversize line (>1 MB) is dropped without calling JSON.parse; the buffer is reset to empty so subsequent valid messages on the same connection still process"
      test_file: main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts
      type: unit
---

# Add zod input validation to cyboflowPermissionIpcServer

## Objective

`cyboflowPermissionIpcServer.ts:58` destructures `{ requestId, sessionId, toolName, input }` from the parsed JSON with zero validation. `input` flows directly into `JSON.stringify(input)` which is written to the SQLite `approvals.tool_input_json` column (`approvalRouter.ts:218`). A malicious or buggy bridge process could submit `{ type: 'permission-request', input: <megabyte payload> }` or `{ ...input: null }`, breaking either the DB write or the downstream renderer that expects a record-shaped `input`. zod is already a runtime dependency (`main/package.json:34`).

This task layers a strict envelope schema over every parsed line, with a size gate on the raw bytes (1 MB) as a separate defensive layer. Paired with B2 (TASK-580) — same files_owned (`cyboflowPermissionIpcServer.ts` + the shared test file), so this MUST land after B2 to avoid merge conflicts on the buffer-loop body.

## Implementation Steps

1. **Add the import and schema definition near the top of `main/src/services/cyboflowPermissionIpcServer.ts`** (after the existing imports):
   ```ts
   import { z } from 'zod';

   const PermissionRequestEnvelope = z.object({
     type: z.literal('permission-request'),
     requestId: z.string().min(1),
     sessionId: z.string().min(1),
     toolName: z.string().min(1),
     input: z.record(z.string(), z.unknown()),
   });

   const MAX_LINE_BYTES = 1024 * 1024; // 1 MB raw-payload cap
   ```

2. **Apply the size gate inside the buffer-loop** (added in TASK-580). After `const line = buffer.slice(0, newlineIdx); buffer = buffer.slice(newlineIdx + 1);` and before `JSON.parse(line)`:
   ```ts
   if (line.length > MAX_LINE_BYTES) {
     console.error(`[Permission IPC] Dropping oversize line (${line.length} bytes)`);
     continue;
   }
   ```

   Also add a buffer-level guard above the inner loop so an unterminated multi-megabyte stream cannot grow without bound:
   ```ts
   if (buffer.length > MAX_LINE_BYTES) {
     console.error(`[Permission IPC] Buffer overflow (${buffer.length} bytes) — discarding and resetting`);
     buffer = '';
     return;
   }
   ```

3. **Apply the zod schema after `JSON.parse`**:
   ```ts
   let raw: unknown;
   try {
     raw = JSON.parse(line);
   } catch (error) {
     console.error('[Permission IPC] JSON parse error:', error);
     continue;
   }

   const parsed = PermissionRequestEnvelope.safeParse(raw);
   if (!parsed.success) {
     console.error('[Permission IPC] Envelope validation failed:', parsed.error.flatten());
     // Recoverable-requestId fallback: if the raw payload exposes a string requestId,
     // send a deny on the socket so the bridge does not hang.
     if (
       raw && typeof raw === 'object' &&
       'requestId' in raw && typeof (raw as { requestId: unknown }).requestId === 'string'
     ) {
       client.write(JSON.stringify({
         type: 'permission-response',
         requestId: (raw as { requestId: string }).requestId,
         response: { behavior: 'deny', message: 'Invalid permission-request envelope' },
       }) + '\n');
     }
     continue;
   }

   const { requestId, sessionId, toolName, input } = parsed.data;
   // ... existing ApprovalRouter.requestApproval(...) call ...
   ```

   Remove the prior `if (message.type === 'permission-request') { const { requestId, sessionId, toolName, input } = message; ... }` block — zod has already taken responsibility for both the type-check and the destructure.

4. **Extend the test file `main/src/services/__tests__/cyboflowPermissionIpcServer.test.ts`** (created in TASK-580) with four new cases:
   - **valid envelope** — write a well-formed `JSON.stringify({ type: 'permission-request', requestId: 'r1', sessionId: 's1', toolName: 'Bash', input: { cmd: 'ls' } }) + '\n'`; assert `requestApproval` was called once.
   - **missing requestId** — write `JSON.stringify({ type: 'permission-request', sessionId: 's1', toolName: 'Bash', input: {} }) + '\n'`; assert `requestApproval` was NOT called and `console.error` was called with a validation message; assert NO socket deny was written (no recoverable requestId).
   - **non-record input** — write `JSON.stringify({ type: 'permission-request', requestId: 'r1', sessionId: 's1', toolName: 'Bash', input: null }) + '\n'`; assert validation failure, no `requestApproval` call, AND a socket deny was written (recoverable requestId).
   - **oversize line** — write a line > 1 MB (e.g. `'{"type":"permission-request","input":"' + 'x'.repeat(1024*1024 + 100) + '"}\n'`); assert `requestApproval` was NOT called, `console.error` mentions oversize, and a subsequent valid message on the same socket still reaches `requestApproval`.

5. **Run the verification chain**:
   ```
   pnpm --filter main typecheck
   pnpm --filter main lint
   pnpm --filter main test cyboflowPermissionIpcServer
   pnpm --filter main test
   ```

## Acceptance Criteria

See frontmatter. Eight criteria covering the schema, safeParse usage, deny-on-failure path, size gate, four new test cases, build verification, and the no-new-dependency assertion.

## Test Strategy

See frontmatter `test_strategy`. Four new cases stacked on top of the TASK-580 framing cases (same test file). Stub `ApprovalRouter.getInstance().requestApproval` to a `vi.fn()` so the validation gate can be observed independently of router behavior.

## Hardest Decision

**Behavior on validation failure: send a deny on the socket, or just drop?** Chosen: send a deny **only** if a recoverable `requestId` string is present in the raw payload. Otherwise drop. The reasoning: if we always drop, a malformed-but-claude-bound message wedges the bridge promise (`pendingRequests.get(requestId)` never resolves). If we always send deny with a synthetic requestId, we may write a response the bridge does not have a pending entry for (no-op on the bridge side, fine). The hybrid path is safest — recover where we can, drop where we can't, log either way.

## Rejected Alternatives

- **Throw on validation failure and let the existing catch block log+continue.** Rejected: the existing catch logs but does not send a deny, so a buggy bridge would hang. Explicit deny-where-recoverable is better defense.
- **Use TypeScript narrowing alone (no zod).** Rejected: TS narrowing is compile-time; the network boundary is runtime. zod is already a dep — using `safeParse` is the canonical pattern in this codebase (already used in tRPC routers per `main/src/orchestrator/trpc/routers/*.ts`).
- **Validate at the ApprovalRouter boundary instead of the IPC server.** Rejected: defense-in-depth says validate at the trust boundary, which is the socket — not the in-process function call inside ApprovalRouter. ApprovalRouter still gets typed inputs because the IPC server now hands it `parsed.data`.

## Lowest Confidence Area

The "recoverable requestId fallback" path is conditional on attacker-controlled data being well-formed enough to extract a string `requestId`. If the attacker sends `{}` (no requestId at all), we drop without notifying the bridge. The bridge's outstanding promise stays pending. This is the bridge's problem to solve via its own timeout (not in scope for this task) — call it out in the done report so the next finding-sweep can decide whether to add a bridge-side timeout.
