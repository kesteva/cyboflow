---
id: TASK-637
idea: SPRINT-015-compound
status: in-flight
created: "2026-05-18T00:00:00Z"
files_owned:
  - frontend/src/components/panels/ai/MessagesView.tsx
  - frontend/src/components/panels/ai/RichOutputView.tsx
  - frontend/src/components/panels/ai/parseJsonMessage.ts
files_readonly:
  - frontend/src/types/session.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/utils/api.ts
acceptance_criteria:
  - criterion: "MessagesView.tsx no longer uses the `as unknown as JSONMessage[]` double-cast"
    verification: "grep -n 'as unknown as JSONMessage\\[\\]' frontend/src/components/panels/ai/MessagesView.tsx returns 0 matches"
  - criterion: "RichOutputView.tsx no longer uses the `as unknown as UserPromptMessage[]` double-cast"
    verification: "grep -n 'as unknown as UserPromptMessage\\[\\]' frontend/src/components/panels/ai/RichOutputView.tsx returns 0 matches"
  - criterion: Both files import and use the parseJsonMessage adapter (or its array variant)
    verification: "grep -l 'parseJsonMessage\\|parseJsonMessages' frontend/src/components/panels/ai/MessagesView.tsx frontend/src/components/panels/ai/RichOutputView.tsx | wc -l returns 2"
  - criterion: The two FIXME(SPRINT-015) breadcrumbs added by A5 are removed
    verification: "grep -n 'FIXME(SPRINT-015).*FIND-SPRINT-015-12' frontend/src/components/panels/ai/MessagesView.tsx frontend/src/components/panels/ai/RichOutputView.tsx returns 0 matches"
  - criterion: parseJsonMessage adapter exists and exports both single + array variants
    verification: "grep -nE 'export function parseJsonMessage|export function parseJsonMessages' frontend/src/components/panels/ai/parseJsonMessage.ts returns at least 2 matches"
  - criterion: Typecheck and frontend tests pass
    verification: "pnpm --filter frontend typecheck && pnpm --filter frontend test exit 0"
depends_on: []
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "New adapter module with non-trivial branching logic (a `ClaudeJsonMessage` may legitimately be missing `timestamp`, may have stringified `data`, may carry a `session_info` discriminator). Unit-testing the adapter in isolation is far cheaper than reproducing the consumer flows. The two view files themselves are exercised by Playwright E2E and dev-mode visual review — no unit-test coverage today, leaving as-is."
  targets:
    - behavior: parseJsonMessage returns a normalized JSONMessage shape for a ClaudeJsonMessage with a top-level type=user and stringified data
      test_file: frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts
      type: unit
    - behavior: "parseJsonMessage returns a normalized UserPromptMessage shape for a ClaudeJsonMessage with a nested message.content of type='text'"
      test_file: frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts
      type: unit
    - behavior: parseJsonMessage discriminates session_info messages from regular JSON messages
      test_file: frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts
      type: unit
    - behavior: "parseJsonMessage gracefully handles a malformed message (missing timestamp, non-JSON string data) without throwing"
      test_file: frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts
      type: unit
    - behavior: parseJsonMessages array variant returns an empty array for empty input and never throws
      test_file: frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts
      type: unit
---
# Replace double-casts with a parseJsonMessage adapter (MessagesView + RichOutputView)

## Objective

`MessagesView.tsx:56` uses `(response.data as unknown as JSONMessage[]).forEach(...)` and `RichOutputView.tsx:220` uses `outputResponse.data as unknown as UserPromptMessage[]`. Both bypass the type system because the local `JSONMessage` / `UserPromptMessage` types diverge from the canonical `ClaudeJsonMessage` returned by `getJsonMessages()` (electron.d.ts:317). The double-cast forces every field access to be checked at runtime inside forEach loops that already perform shape sniffing (e.g. `msgData && typeof msgData === 'object' && 'type' in msgData && (msgData as any).type === 'session_info'`).

**Approach (option B from the compounder's proposal).** Introduce a `parseJsonMessage(msg: ClaudeJsonMessage): JSONMessage | UserPromptMessage | SessionInfo | null` adapter at the boundary. Each consumer calls it instead of casting; the adapter encapsulates the runtime type-sniffing that today is duplicated inside two forEach loops. Unifying the local types with `ClaudeJsonMessage` (option A) was rejected because the local types are intentionally view-shaped — they encode "this is what the renderer expects after normalisation," and pushing that knowledge into the canonical type would muddy session.ts.

## Implementation Steps

1. **Pre-flight read of the canonical type.** Confirm the contract:
   ```
   grep -n 'interface ClaudeJsonMessage' frontend/src/types/session.ts
   ```
   ClaudeJsonMessage has optional `type`, `role`, `message`, `content`, `text`, `data` (no — `data` is not on ClaudeJsonMessage), `timestamp`, and arbitrary `[key: string]: unknown`. The renderer-side `JSONMessage` adds `data: string` (stringified payload) and requires `timestamp: string`. The renderer-side `UserPromptMessage` requires `message.content` as an array of text segments and a required `timestamp`.

2. **Create `frontend/src/components/panels/ai/parseJsonMessage.ts` (new file).**

   Module contract:
   ```ts
   import type { ClaudeJsonMessage } from '../../../types/session';

   /**
    * Renderer-side shape for raw JSON messages displayed in MessagesView.
    * Mirrors the local type previously declared inline in MessagesView.tsx.
    */
   export interface JSONMessage {
     type: 'json';
     data: string;
     timestamp: string;
   }

   /**
    * Renderer-side shape for user-prompt messages displayed in RichOutputView.
    * Mirrors the local type previously declared inline in RichOutputView.tsx.
    */
   export interface UserPromptMessage {
     type: 'user';
     message: {
       role: 'user';
       content: Array<{ type: 'text'; text: string }>;
     };
     timestamp: string;
   }

   /**
    * Renderer-side shape for session_info messages.
    */
   export interface SessionInfo {
     type: 'session_info';
     initial_prompt?: string;
     claude_command?: string;
     worktree_path?: string;
     model?: string;
     permission_mode?: string;
     approval_policy?: string;
     timestamp: string;
   }

   /**
    * Adapter converting a raw ClaudeJsonMessage from the IPC boundary into the
    * renderer-side discriminated union. Returns null for messages that cannot
    * be classified (caller decides to drop or log).
    *
    * The runtime sniffing here previously lived as inline `if (msgData && ...)`
    * blocks inside MessagesView.tsx and RichOutputView.tsx. Centralising it here
    * removes the `as unknown as` double-casts at the consumer sites.
    */
   export function parseJsonMessage(
     raw: ClaudeJsonMessage,
   ): JSONMessage | UserPromptMessage | SessionInfo | null {
     // Try to extract the structured payload. ClaudeJsonMessage may carry a
     // stringified payload via the IPC bridge (legacy code path) or a parsed
     // object (newer path); accept both.
     let payload: unknown = raw;
     const rawAny = raw as unknown as { data?: unknown };
     if (typeof rawAny.data === 'string') {
       try { payload = JSON.parse(rawAny.data); } catch { payload = rawAny.data; }
     } else if (rawAny.data !== undefined) {
       payload = rawAny.data;
     }

     // session_info discriminator
     if (
       payload && typeof payload === 'object' && 'type' in (payload as Record<string, unknown>)
       && (payload as { type: unknown }).type === 'session_info'
     ) {
       return payload as SessionInfo;
     }

     // user prompt discriminator (nested message.content array of text segments)
     if (
       raw.type === 'user'
       && raw.message
       && typeof raw.message === 'object'
       && Array.isArray((raw.message as { content?: unknown }).content)
     ) {
       return raw as unknown as UserPromptMessage; // shape-validated above
     }

     // Default: treat as a JSON-stringifiable line for MessagesView
     const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : '';
     const data = typeof rawAny.data === 'string'
       ? rawAny.data
       : JSON.stringify(payload);
     if (!timestamp && typeof rawAny.data !== 'string') {
       // Drop messages with no usable timestamp AND no usable data — caller may
       // choose to log; we return null to signal "skip".
       return null;
     }
     return { type: 'json', data, timestamp };
   }

   /**
    * Array variant: maps over a list, dropping nulls. Pure convenience.
    */
   export function parseJsonMessages(
     raws: ClaudeJsonMessage[],
   ): Array<JSONMessage | UserPromptMessage | SessionInfo> {
     const out: Array<JSONMessage | UserPromptMessage | SessionInfo> = [];
     for (const raw of raws) {
       const parsed = parseJsonMessage(raw);
       if (parsed !== null) out.push(parsed);
     }
     return out;
   }
   ```
   **Note on the one remaining `as unknown as UserPromptMessage` cast inside the adapter:** it's safe because the conditional above validates `raw.type === 'user'` and `Array.isArray(raw.message.content)` — exactly the runtime shape this branch returns. The cast is local, justified by an explicit guard, and inside the boundary module instead of duplicated at consumer sites.

3. **Edit `frontend/src/components/panels/ai/MessagesView.tsx`.**
   - Delete the local `interface JSONMessage` (lines 12–16) and `interface SessionInfo` (lines 18–27).
   - Add: `import { parseJsonMessage, type JSONMessage, type SessionInfo } from './parseJsonMessage';`
   - Replace the forEach body (lines 56–99) so it loops over `response.data` (typed as `ClaudeJsonMessage[]` thanks to the IPC contract — drop the `as unknown as JSONMessage[]` cast):
     ```ts
     response.data.forEach((rawMsg) => {
       const parsed = parseJsonMessage(rawMsg);
       if (parsed === null) return;
       if (parsed.type === 'session_info') {
         foundSessionInfo = parsed;
       } else if (parsed.type === 'json') {
         regularMessages.push(parsed);
       }
       // parsed.type === 'user' is irrelevant for MessagesView; ignore.
     });
     ```
   - Remove the inner try/catch + JSON.parse blocks that previously handled the malformed-message path — that logic now lives in `parseJsonMessage`.
   - Remove the `FIXME(SPRINT-015): local JSONMessage diverges from ClaudeJsonMessage` comment on line 55.

4. **Edit `frontend/src/components/panels/ai/RichOutputView.tsx`.**
   - Delete the local `interface UserPromptMessage` (lines 14–21).
   - Add: `import { parseJsonMessage, type UserPromptMessage } from './parseJsonMessage';`
   - Replace the `allMessages.push(...(outputResponse.data as unknown as UserPromptMessage[]));` line (220) with:
     ```ts
     if (outputResponse.success && outputResponse.data && Array.isArray(outputResponse.data)) {
       for (const rawMsg of outputResponse.data) {
         const parsed = parseJsonMessage(rawMsg);
         if (parsed !== null && parsed.type === 'user') {
           allMessages.push(parsed);
         }
       }
     }
     ```
   - Remove the `FIXME(SPRINT-015): local UserPromptMessage diverges from ClaudeJsonMessage` comment on line 219.

5. **Create `frontend/src/components/panels/ai/__tests__/parseJsonMessage.test.ts`.**
   Use vitest. Cover the five behaviors enumerated in test_strategy:
   ```ts
   import { describe, it, expect } from 'vitest';
   import { parseJsonMessage, parseJsonMessages } from '../parseJsonMessage';
   import type { ClaudeJsonMessage } from '../../../../types/session';

   describe('parseJsonMessage', () => {
     it('returns a normalized JSONMessage for a raw message with stringified data', () => {
       const raw = { type: 'assistant', timestamp: '2026-05-18T10:00:00Z', data: '{"hello":"world"}' } as unknown as ClaudeJsonMessage;
       const parsed = parseJsonMessage(raw);
       expect(parsed).toEqual({ type: 'json', data: '{"hello":"world"}', timestamp: '2026-05-18T10:00:00Z' });
     });

     it('returns a UserPromptMessage when raw.type=user and message.content is a text array', () => {
       const raw = {
         type: 'user',
         message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
         timestamp: '2026-05-18T10:00:00Z',
       } as ClaudeJsonMessage;
       const parsed = parseJsonMessage(raw);
       expect(parsed?.type).toBe('user');
     });

     it('discriminates session_info', () => {
       const raw = { data: '{"type":"session_info","timestamp":"x"}' } as unknown as ClaudeJsonMessage;
       const parsed = parseJsonMessage(raw);
       expect(parsed?.type).toBe('session_info');
     });

     it('returns null for a message with no timestamp and no parseable data', () => {
       const raw = { type: 'assistant' } as ClaudeJsonMessage;
       const parsed = parseJsonMessage(raw);
       expect(parsed).toBeNull();
     });

     it('parseJsonMessages drops nulls and returns an array', () => {
       const out = parseJsonMessages([
         { type: 'assistant', timestamp: 't', data: '{"a":1}' } as unknown as ClaudeJsonMessage,
         { type: 'assistant' } as ClaudeJsonMessage, // null-producing
       ]);
       expect(out).toHaveLength(1);
     });
   });
   ```

6. **Run the AC grep:**
   ```
   grep -n 'as unknown as JSONMessage\[\]\|as unknown as UserPromptMessage\[\]' frontend/src
   ```
   Expected: 0 matches.

7. **Run `pnpm --filter frontend typecheck`** — expect exit 0. The casts being removed means any remaining type-shape mismatch surfaces here.

8. **Run `pnpm --filter frontend test`** — expect exit 0. The new parseJsonMessage tests run; no existing tests must break.

9. **Manual smoke (recommended, not a hard AC):** `pnpm dev`, open an AI panel, confirm MessagesView still renders JSON messages and RichOutputView still threads user prompts with output. The adapter's branching is exercised in fixture tests but the runtime payloads can have surprising shapes; a 30-second human inspection is cheap insurance.

## Acceptance Criteria

- Zero `as unknown as JSONMessage[]` or `as unknown as UserPromptMessage[]` casts in the two view files.
- Both files import from `parseJsonMessage.ts`.
- `parseJsonMessage` and `parseJsonMessages` exported with passing unit tests.
- Two FIXME(SPRINT-015) breadcrumbs removed.
- `pnpm --filter frontend typecheck && pnpm --filter frontend test` exit 0.

## Hardest Decision

Option A (unify the local types with `ClaudeJsonMessage`) vs. Option B (introduce an adapter). The compounder preferred B and I concur. Rationale:
- The local types encode renderer-side post-normalization shape (e.g. `JSONMessage.data: string` is the stringified form ready for display; `UserPromptMessage.message.content` is the array-of-text form, never a string). Pushing these into `ClaudeJsonMessage` would either (a) make them all optional (gutting the type's value) or (b) split `ClaudeJsonMessage` into many sub-types (a much bigger refactor with cross-component blast radius).
- Option B isolates the boundary conversion in one tested module, which is exactly the shape the IPC layer asks for elsewhere in this codebase.

## Rejected Alternatives

- **Option A: unify the local types with ClaudeJsonMessage.** Rejected — would either widen `ClaudeJsonMessage` to encode renderer concerns or fragment it into a sub-type family. Would change my mind only if a future task demanded a single canonical type across IPC boundary AND renderer state (e.g. for prop-drilling), which would justify the larger refactor.
- **Add an `as ClaudeJsonMessage[]` single-cast (without the `unknown` step).** Rejected — `IPCResponse.data` is typed as `ClaudeJsonMessage[]` already (per `electron.d.ts:317`), so the cast would be redundant. The current double-cast exists because the local types are NOT compatible with `ClaudeJsonMessage`; replacing the cast with an adapter call is the real fix.
- **Use zod / runtime schema validation.** Rejected for this task — overshoots the immediate problem. The adapter's hand-written guards are sufficient for the four message shapes the views actually consume; zod would add a runtime dep and slow down the message hot path.

## Lowest Confidence Area

The shape of the actual IPC payload at runtime. The local types in the views were authored against real production payloads, but I cannot verify byte-by-byte that `parseJsonMessage` correctly classifies every variant seen in the wild without `pnpm dev` time. The unit tests cover the four documented shapes; the manual smoke in step 9 is the defense against a missed variant. If a future runtime crash points at parseJsonMessage, the fallback path (return `{ type: 'json', data: JSON.stringify(payload), timestamp }`) is intentionally permissive — it preserves the legacy view's "always show something" behavior.
