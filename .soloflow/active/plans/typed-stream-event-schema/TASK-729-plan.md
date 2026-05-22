---
id: TASK-729
idea: BATCH-2026-05-22-streamparser-thinking-deltas
status: in-flight
created: "2026-05-22T00:00:00Z"
files_owned:
  - main/src/services/streamParser/schemas.ts
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/__tests__/schemas.test.ts
  - main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
  - main/src/services/streamParser/__tests__/sdkMockFactories.ts
files_readonly:
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/derivers.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - .soloflow/active/plans/typed-stream-event-schema/TASK-656-plan.md
acceptance_criteria:
  - criterion: "streamEventSchema's inner delta.type union accepts the four literal values text_delta, input_json_delta, signature_delta, thinking_delta."
    verification: "grep -nE \"z\\.literal\\('(text_delta|input_json_delta|signature_delta|thinking_delta)'\\)\" main/src/services/streamParser/schemas.ts returns exactly 4 matches inside the delta object literal (lines ~286-295)."
  - criterion: "streamEventSchema's inner delta object declares optional signature: z.string() and thinking: z.string() fields alongside the existing text and partial_json fields."
    verification: "grep -nE 'signature: z\\.string\\(\\)\\.optional\\(\\)' main/src/services/streamParser/schemas.ts returns ≥ 1 match AND grep -nE 'thinking: z\\.string\\(\\)\\.optional\\(\\)' main/src/services/streamParser/schemas.ts returns ≥ 1 match, both inside the streamEventSchema delta object (between the `delta: z.object({` opening at ~line 286 and its closing `}).passthrough().optional()`)."
  - criterion: shared/types/claudeStream.ts StreamEvent.event.delta.type union mirrors the schema with all four literals.
    verification: "grep -nE \"'text_delta' \\| 'input_json_delta' \\| 'signature_delta' \\| 'thinking_delta'\" shared/types/claudeStream.ts returns exactly 1 match (the StreamEvent interface delta.type field)."
  - criterion: "shared/types/claudeStream.ts StreamEvent.event.delta declares optional signature?: string and thinking?: string fields."
    verification: "grep -nE 'signature\\?: string' shared/types/claudeStream.ts returns ≥ 1 match AND grep -nE 'thinking\\?: string' shared/types/claudeStream.ts returns ≥ 1 match in the StreamEvent block."
  - criterion: "Schema tests cover the new delta types by round-tripping signature_delta and thinking_delta payloads through TypedEventNarrowing and asserting they narrow to type === 'stream_event' (not kind === '__unknown__')."
    verification: "grep -nE \"'signature_delta'\" main/src/services/streamParser/__tests__/schemas.test.ts returns ≥ 1 match AND grep -nE \"'thinking_delta'\" main/src/services/streamParser/__tests__/schemas.test.ts returns ≥ 1 match. The matching describe/it blocks assert event.type === 'stream_event' on the narrowed event."
  - criterion: TypedEventNarrowing test asserts signature_delta and thinking_delta payloads do NOT fall through to the __unknown__ branch.
    verification: "grep -nE \"'(signature_delta|thinking_delta)'\" main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts returns ≥ 2 matches across at least one new it() block that runs narrower.narrow(...) and asserts 'kind' in result is false."
  - criterion: "Compile-time bridge in schemas.ts (_typeCheck) still passes — the TS StreamEvent interface and the schema's z.infer agree on the extended delta.type union."
    verification: pnpm typecheck exits 0.
  - criterion: Stream-parser unit tests are green.
    verification: pnpm --filter main exec vitest run src/services/streamParser exits 0.
depends_on: []
estimated_complexity: low
epic: typed-stream-event-schema
test_strategy:
  needed: true
  justification: "Direct schema-coverage extension. The fix lives in two assertions (round-trip in schemas.test.ts; narrowing in typedEventNarrowing.test.ts) plus two factory variants (signature_delta, thinking_delta) so the existing assertion style can express them. Sibling-test scan of main/src/services/streamParser/__tests__/ surfaced 5 sibling test files; schemas.test.ts and typedEventNarrowing.test.ts both directly exercise this code path and are both modified. eventRouter.test.ts / messageProjection.test.ts / rawEventsSink.test.ts consume the narrowed event but do not exercise the delta-type union, so they are not modified."
  targets:
    - behavior: "signature_delta payload narrows to a typed stream_event (not __unknown__), preserves the signature field via .passthrough(), and reports event.event.delta.type === 'signature_delta'."
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: "thinking_delta payload narrows to a typed stream_event (not __unknown__), preserves the thinking field, and reports event.event.delta.type === 'thinking_delta'."
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
    - behavior: "Direct narrower.narrow() call on signature_delta and thinking_delta inputs returns the typed variant ('kind' in result is false), proving the live production code path matches the schema."
      test_file: main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
      type: unit
    - behavior: New factory functions streamEventSignatureDelta() and streamEventThinkingDelta() produce StreamEvent values that conform to the extended TS interface (compile-time check) and parse cleanly through the schema (round-trip check).
      test_file: main/src/services/streamParser/__tests__/sdkMockFactories.ts
      type: unit
---
# Extend streamEventSchema.delta.type to accept Claude SDK signature_delta + thinking_delta

## Objective

Fix a P0 wire-format coverage gap discovered during live testing on 2026-05-22. Claude Opus emits `signature_delta` and `thinking_delta` events on extended-thinking content blocks; the current `streamEventSchema` rejects them, causing the renderer to display an orange "Unrecognized event unknown" card (run id `b0f26c005183400898559a3d78b790bc`, raw_events.id=1125). Extend both the Zod schema and the matching TypeScript interface to accept these two literals and their carrier fields (`signature` and `thinking`), and add round-trip + narrowing test coverage that locks the wire format in. Boundary is strictly schema + types + tests — do NOT touch the `runEventBridge` cast site, the `claudeCodeManager` raw-cast path, or the `RunView` UnknownEventRow renderer (those belong to the structural finding called out below).

## Implementation Steps

1. **Extend the Zod inner delta union in `main/src/services/streamParser/schemas.ts`** (currently lines 286-290 inside `streamEventSchema`). Replace the 2-literal union with a 4-literal union and add the two new optional carrier fields. The block becomes:

   ```ts
   delta: z.object({
     type: z.union([
       z.literal('text_delta'),
       z.literal('input_json_delta'),
       z.literal('signature_delta'),
       z.literal('thinking_delta'),
     ]).optional(),
     text: z.string().optional(),
     partial_json: z.string().optional(),
     signature: z.string().optional(),
     thinking: z.string().optional(),
   }).passthrough().optional(),
   ```

   Add a one-line JSDoc above the union: `/** Four content_block_delta delta types. text/input_json appear on text+tool_use blocks; signature/thinking appear on thinking blocks (extended-thinking mode). */`. Do NOT alter anything else in `streamEventSchema` — the outer `event.type` 6-literal union (message_start/content_block_start/etc.) is unrelated and stays as-is. Do NOT touch the `.passthrough()` call on the delta object — TASK-656 (in-flight, owns `schemas.ts` for the .passthrough() decision) is dropping passthroughs in *outer* union-member schemas only; the inner delta passthrough is preserved either way and is the mechanism that lets the verification tests assert `signature`/`thinking` fields survive parsing.

2. **Mirror the change in `shared/types/claudeStream.ts`** (currently `StreamEvent.event.delta` at lines 247-251). Update the `type` union to `'text_delta' | 'input_json_delta' | 'signature_delta' | 'thinking_delta'` and add `signature?: string;` and `thinking?: string;` fields alongside `text?: string;` and `partial_json?: string;`. The `_typeCheck` compile-time bridge in `schemas.ts:377` enforces structural parity between the schema's `z.infer` output and this interface — both edits must land together or `pnpm typecheck` fails.

3. **Add factory functions in `main/src/services/streamParser/__tests__/sdkMockFactories.ts`** alongside the existing `streamEvent()` factory (line 360). Append:

   ```ts
   export function streamEventSignatureDelta(overrides: Partial<StreamEvent> = {}): StreamEvent {
     return {
       type: 'stream_event',
       event: {
         type: 'content_block_delta',
         index: 0,
         delta: {
           type: 'signature_delta',
           // Synthetic base64-shaped signature. Matches the wire-observed shape from raw_events.id=1125
           // (run b0f26c005183400898559a3d78b790bc) without persisting the real signature.
           signature: 'EvcDCmMIDRgCEXAMPLE_SIGNATURE_SHAPE_BASE64_PADDING==',
         },
       },
       session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
       ...overrides,
     };
   }

   export function streamEventThinkingDelta(overrides: Partial<StreamEvent> = {}): StreamEvent {
     return {
       type: 'stream_event',
       event: {
         type: 'content_block_delta',
         index: 0,
         delta: {
           type: 'thinking_delta',
           thinking: 'Let me think about this step by step.',
         },
       },
       session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
       ...overrides,
     };
   }
   ```

   The factory pattern is the project convention (see `__tests__/sdkMockFactories.ts:1-14` header) — do NOT create on-disk JSON fixtures. The signature value is synthetic by design; using the real captured signature from `~/.cyboflow/sessions.db` would persist a wire artifact into git unnecessarily. The "matches the wire-observed shape" comment in the factory is the audit trail.

4. **Add round-trip tests in `main/src/services/streamParser/__tests__/schemas.test.ts`** by extending the existing `StreamEvent` describe block (currently lines 251-267). Update the import block at line 18-35 to also import `streamEventSignatureDelta, streamEventThinkingDelta`. Add two new `it()` blocks after the existing `it('parses stream_event.json ...')`:

   ```ts
   it('narrows signature_delta to stream_event with delta.type === signature_delta and signature field preserved', () => {
     const raw = streamEventSignatureDelta();
     const event = narrower.narrow(raw);
     if ('kind' in event) throw new Error('Expected typed variant, got UnknownStreamEvent');
     if (event.type !== 'stream_event') throw new Error('Expected StreamEvent');
     expect(event.event.type).toBe('content_block_delta');
     expect(event.event.delta?.type).toBe('signature_delta');
     expect(event.event.delta?.signature).toBe('EvcDCmMIDRgCEXAMPLE_SIGNATURE_SHAPE_BASE64_PADDING==');
   });

   it('narrows thinking_delta to stream_event with delta.type === thinking_delta and thinking field preserved', () => {
     const raw = streamEventThinkingDelta();
     const event = narrower.narrow(raw);
     if ('kind' in event) throw new Error('Expected typed variant, got UnknownStreamEvent');
     if (event.type !== 'stream_event') throw new Error('Expected StreamEvent');
     expect(event.event.type).toBe('content_block_delta');
     expect(event.event.delta?.type).toBe('thinking_delta');
     expect(event.event.delta?.thinking).toBe('Let me think about this step by step.');
   });
   ```

   Do NOT add these factories to the `exhaustive union coverage` test fixtures array (currently lines 499-516) — that array covers top-level variants of `ClaudeStreamEvent`, and both new fixtures narrow to the existing `stream_event` arm. Adding them would be redundant and may shadow the existing `streamEvent()` entry's positional assertion.

5. **Add a direct narrowing test in `main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts`.** Extend the imports at line 12-16 to add `streamEventSignatureDelta, streamEventThinkingDelta`. Inside the existing `describe('TypedEventNarrowing', () => { ... })` block, append a new `it()` block:

   ```ts
   it('narrows content_block_delta with delta.type signature_delta or thinking_delta to stream_event (not __unknown__) — regression test for live-testing finding 2026-05-22', () => {
     const signatureEvent = narrower.narrow(streamEventSignatureDelta());
     expect('kind' in signatureEvent).toBe(false);
     if ('kind' in signatureEvent) throw new Error('signature_delta narrowed to __unknown__');
     expect(signatureEvent.type).toBe('stream_event');

     const thinkingEvent = narrower.narrow(streamEventThinkingDelta());
     expect('kind' in thinkingEvent).toBe(false);
     if ('kind' in thinkingEvent) throw new Error('thinking_delta narrowed to __unknown__');
     expect(thinkingEvent.type).toBe('stream_event');
   });
   ```

   This is the production-path regression test — `TypedEventNarrowing.narrow()` is the exact function `runEventBridge.ts:209` calls. If a future schema refactor drops one of the literals, this test fails before the renderer regresses.

6. **Verify locally before reporting COMPLETED:**
   - `pnpm typecheck` exits 0 (enforces the `_typeCheck` bridge between the schema and the TS interface).
   - `pnpm --filter main exec vitest run src/services/streamParser` exits 0 (runs all 5 stream-parser test files; previously-passing tests must remain green and the new tests must pass).
   - Re-run the verification greps from the AC list against the modified files and confirm each grep returns the expected match count.

7. **Do NOT modify** `main/src/orchestrator/runEventBridge.ts`, `main/src/services/panels/claude/claudeCodeManager.ts`, `main/src/services/streamParser/typedEventNarrowing.ts`, `main/src/services/streamParser/derivers.ts`, `frontend/src/components/cyboflow/RunView.tsx`, or any docs file. The structural split between the `claudeCodeManager.ts:343` raw-cast path and the `runEventBridge.ts:209` narrowed path is a real defect (see Hardest Decision) but lives in a separate, larger-scope finding the compounder should file. Conflating it with this bug fix loses the surgical reproducibility of "extend the union, ship."

## Acceptance Criteria

Restated from frontmatter:
1. Schema's inner delta.type accepts all 4 literals.
2. Schema's inner delta declares optional `signature` and `thinking` fields.
3. TS StreamEvent.event.delta.type union mirrors all 4 literals.
4. TS StreamEvent.event.delta declares optional `signature?: string` and `thinking?: string`.
5. schemas.test.ts asserts narrowing of both new delta types to `type === 'stream_event'`.
6. typedEventNarrowing.test.ts asserts both new delta types do NOT route to `__unknown__`.
7. `pnpm typecheck` exits 0 (compile-time bridge holds).
8. `pnpm --filter main exec vitest run src/services/streamParser` exits 0.

Each AC is independently verifiable via the grep/exit-code commands in `verification:`.

## Test Strategy

See `test_strategy` in frontmatter. Two new factories in `sdkMockFactories.ts` (one per new delta type), two new `it()` blocks in `schemas.test.ts` exercising the round-trip through `narrower.narrow()`, and one new `it()` block in `typedEventNarrowing.test.ts` exercising the production-path narrow on the same inputs. The narrowing test is intentionally separate from the schema round-trip test because the narrower has its own fallback path (`{ kind: '__unknown__', raw }`) that the round-trip via `claudeStreamEventSchema.safeParse` does not — testing both confirms the production wiring, not just the schema.

The `exhaustive union coverage` test (schemas.test.ts:469-528) does NOT need a new entry: its `summarize()` switch dispatches on top-level `event.type`, and both new delta literals live two levels deep inside the existing `stream_event` arm. Adding the new factories to its fixtures array would be a no-op assertion (`'stream_event'`) that doesn't increase coverage. Leave the array as-is.

Mocking / fixture setup: none. Inline synthetic values per project convention. The synthetic signature value's only requirement is that it be a non-empty string; no base64-validity assertion exists or is needed.

## Hardest Decision

**Scope discipline: ship the schema fix WITHOUT touching the structural split that made the bug visible.**

The brief flagged a real architectural defect at `claudeCodeManager.ts:343`: the raw SDK event is cast directly to `ClaudeStreamEvent` and emitted to `EventRouter.emitForRun(...)`, bypassing `TypedEventNarrowing.narrow()` entirely. The narrower IS called on the same event via the `'output'` EventEmitter path at `runEventBridge.ts:209`. The two paths diverge on validation behavior: `RawEventsSink` (router consumer) inserts the raw shape into the DB and derives `event_type` from it via `deriveEventType` regardless of schema conformance; the renderer envelope built at `runEventBridge.ts:240-244` uses the narrowed event, so a malformed event reaches the renderer as `{ type: 'unknown', payload: { kind: '__unknown__', raw } }` while the DB row is the same malformed shape mislabeled as a typed event. This bug only became visible in the renderer because of that split — the DB silently stored the malformed signature_delta as `event_type='stream_event'`.

The temptation is to fix the split now ("while we're in the area"). Resisted because:
- The split is a multi-file refactor with its own design choices (do we narrow at the emit boundary in `claudeCodeManager`? Or move both consumers behind one narrower? Or push narrowing all the way into `EventRouter.emitForRun`?). Each choice has different blast radius.
- The schema extension is a 3-line union change + 2-line carrier-field addition that fully closes the user-visible defect. Bundling the structural fix delays the user-visible fix and turns a "low" complexity task into a "high" one.
- TASK-656 is already in-flight in the same file (`schemas.ts`) making a passthrough decision. A second concurrent structural change risks merge conflicts and obscured intent.

**Action for the compounder:** raise the `claudeCodeManager.ts:343` raw-cast path as a separate finding under `.soloflow/active/findings/SPRINT-XXX-findings.md` (bucket: structural, severity medium). The finding should reference this task's run-time evidence (raw_events.id=1125 in `~/.cyboflow/sessions.db`) and the two divergence points (`runEventBridge.ts:209` narrowed vs `claudeCodeManager.ts:343` raw). The executor of THIS task does NOT file or edit that finding — the compounder owns it.

## Rejected Alternatives

- **Use the captured DB signature as a literal fixture.** Rejected. Persisting a real `EvcDCmMI...` signature into a checked-in test file leaks a wire artifact for no benefit; synthetic base64-shaped strings exercise the schema identically (`z.string().optional()` doesn't validate base64). The factory comment documents wire-shape parity. Would reconsider only if the schema later constrained signature to a regex.

- **Loosen delta.type to `z.string().optional()` instead of extending the literal union.** Rejected. The literal union is the schema's primary drift-detection mechanism — collapsing it to `z.string()` means any future SDK delta type silently parses as valid and the renderer would never display the "Unrecognized event" card even when something IS genuinely unrecognized. The literal union is intentionally exhaustive; extending it preserves both forward-coverage and drift-visibility. Would reconsider only if Anthropic published a documented extensibility contract for delta types.

- **File the structural cast-site bug as a finding from THIS plan.** Rejected per repository convention — refiner plans don't create finding files. The executor's "Lowest Confidence Area" or this Hardest Decision section is the in-plan signal; the compounder reads plans during sprint close-out and files findings then.

- **Add the optional doc note in `docs/CODE-PATTERNS.md`.** Rejected (the brief marks it optional). The doc currently has no "Claude Stream Block Types" section to extend (`grep -n 'stream.?event' docs/CODE-PATTERNS.md` returns one tangential line about concurrent events). Creating a new section is greenfield doc work outside the bug-fix scope. The schema's JSDoc above the new union (added in step 1) is the canonical reference for the four delta types — that's where contributors actually look. Would reconsider if a future docs-cleanup task batched this with related content.

## Lowest Confidence Area

**Whether the SDK emits additional fields on `signature_delta` / `thinking_delta` events beyond `signature` / `thinking`.** The captured evidence (raw_events.id=1125) shows only `type` + `signature`. Anthropic's stream-events spec does not document `signature_delta` at all (the brief confirms it is "observable on the wire" but undocumented). If the SDK starts emitting an additional field — e.g. a `block_id` or `format` discriminator — the `.passthrough()` on the delta object will carry it through unparsed (good), but downstream consumers won't know to read it. The schema can be extended additively later without breaking this plan's tests.

A secondary unknown: does TASK-656's in-flight decision to drop `.passthrough()` in outer schemas extend to the **inner** `delta` object's `.passthrough()`? If it does (unlikely per the plan's "outer union-member schemas" wording), the new `signature` / `thinking` field assertions in the schema tests would tighten from "preserves the field" to "requires the field be declared". The schema additions in step 1 declare both fields explicitly, so the tests pass either way — but a future merge with TASK-656 should re-verify the inner-passthrough assumption.
