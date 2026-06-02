/**
 * MessageProjection cardinality test for the INTERACTIVE substrate transcript
 * shape (IDEA-013 / TASK-812).
 *
 * Context (the correctness risk this locks):
 *   - SDK substrate streams PARTIAL deltas: `--include-partial-messages` emits
 *     one `assistant` event per completed content block, all sharing one
 *     `message.id`. The coalescing at messageProjection.ts:255-290
 *     (`emittedAssistantMessages` keyed by message.id) folds the N events into a
 *     single UnifiedMessage. That path is already covered in messageProjection.test.ts.
 *   - INTERACTIVE substrate (transcriptNormalizer) emits the FULL content per
 *     transcript line — but a single logical assistant turn can still arrive as
 *     TWO normalized `assistant` lines (e.g. a tool-use line followed by the
 *     text line) that share the SAME `message.id`. This is a DIFFERENT input
 *     cardinality (full content, not deltas) hitting the SAME coalescing branch.
 *
 * This test feeds TWO full-content `assistant` events sharing one `message.id`
 * (the transcript shape) and asserts project() yields EXACTLY ONE UnifiedMessage
 * with the merged segments — no duplicate, no drop. The contrasting SDK
 * partial-delta case (same branch, different cardinality) is documented inline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MessageProjection } from '../messageProjection';
import type { AssistantEvent } from '../../../../../shared/types/claudeStream';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';

// ---------------------------------------------------------------------------
// Fixtures — two full-content transcript `assistant` lines sharing one message.id
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess-substrate-001';
const MSG_ID = 'msg_01TRANSCRIPTSHAREDID00000';
const TOOL_USE_ID = 'toolu_01transcriptcardinality0';

/**
 * Transcript line 1 of the logical turn: a tool_use block carrying FULL content
 * (interactive transcripts never stream deltas). Normalized to the SDK wire
 * `assistant` shape by transcriptNormalizer.
 */
const transcriptAssistantToolUse: AssistantEvent = {
  type: 'assistant',
  message: {
    id: MSG_ID,
    model: 'claude-opus-4-5',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: TOOL_USE_ID, name: 'Bash', input: { command: 'pnpm test' } },
    ],
    usage: { input_tokens: 2048, output_tokens: 64 },
  },
  session_id: SESSION_ID,
};

/**
 * Transcript line 2 of the SAME logical turn (same message.id): the assistant's
 * text, again FULL content. Under the coalescing contract this must append onto
 * the message emitted for line 1, not produce a second message.
 */
const transcriptAssistantText: AssistantEvent = {
  type: 'assistant',
  message: {
    id: MSG_ID,
    model: 'claude-opus-4-5',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running the test suite to confirm the change.' },
    ],
    usage: { input_tokens: 2048, output_tokens: 96 },
  },
  session_id: SESSION_ID,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageProjection — interactive transcript cardinality (full-content shared message.id)', () => {
  let projection: MessageProjection;

  beforeEach(() => {
    projection = new MessageProjection('run-substrate-test');
  });

  it('coalesces two full-content assistant lines sharing one message.id into EXACTLY ONE UnifiedMessage (no duplicate, no drop)', () => {
    const first = projection.project(transcriptAssistantToolUse);
    const second = projection.project(transcriptAssistantText);

    // First full-content line emits the message; the second is folded in (null).
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const msg = first as UnifiedMessage;
    expect(msg.id).toBe(MSG_ID);
    expect(msg.role).toBe('assistant');

    // Both lines' segments landed on the ONE message: the tool_call (from line 1)
    // and the text (from line 2, appended in place by the coalescing branch).
    const toolSegs = msg.segments.filter((s) => s.type === 'tool_call');
    const textSegs = msg.segments.filter((s) => s.type === 'text');
    expect(toolSegs).toHaveLength(1);
    expect(textSegs).toHaveLength(1);
    if (textSegs[0].type === 'text') {
      expect(textSegs[0].content).toBe('Running the test suite to confirm the change.');
    }
  });

  it('the appended segment mutates the already-emitted message in place (the consumer pushes by reference)', () => {
    // CONTRACT (messageProjection.ts:255-290): both consumers push the returned
    // object via `{ ...projected }`, a shallow copy sharing the `segments` array.
    // Mutating segments in place on the repeat message.id IS visible in the
    // pushed copy — so a single rendered message reflects the full turn.
    const emitted = projection.project(transcriptAssistantToolUse) as UnifiedMessage;
    expect(emitted.segments).toHaveLength(1);

    // Second line returns null but appends onto `emitted.segments` in place.
    const folded = projection.project(transcriptAssistantText);
    expect(folded).toBeNull();
    expect(emitted.segments).toHaveLength(2);
  });

  it('a fresh full-content line with a DISTINCT message.id is a NEW message (cardinality not over-coalesced)', () => {
    projection.project(transcriptAssistantToolUse);
    projection.project(transcriptAssistantText);

    const distinct: AssistantEvent = {
      type: 'assistant',
      message: {
        id: 'msg_01ADISTINCTTRANSCRIPTID000',
        model: 'claude-opus-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'A second turn.' }],
      },
      session_id: SESSION_ID,
    };
    const result = projection.project(distinct);

    expect(result).not.toBeNull();
    expect((result as UnifiedMessage).id).toBe('msg_01ADISTINCTTRANSCRIPTID000');
  });
});
