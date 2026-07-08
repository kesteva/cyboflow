/**
 * Unit tests for AskUserQuestionFailureDetector — detects an AskUserQuestion
 * gate that failed at the SDK control-channel layer ("Stream closed") by pairing
 * an `assistant` tool_use with its error `user` tool_result over synthetic typed
 * ClaudeStreamEvents.
 */
import { describe, it, expect, vi } from 'vitest';
import { AskUserQuestionFailureDetector } from '../askUserQuestionFailureDetector';
import type {
  AssistantEvent,
  ClaudeStreamEvent,
  ToolResultBlock,
  UserEvent,
} from '../../../../shared/types/claudeStream';
import type { QuestionPayload } from '../../../../shared/types/questions';

const QUESTIONS: QuestionPayload[] = [
  {
    question: 'Pick A or B?',
    header: 'Choose',
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }],
  },
];

function askToolUse(id: string, questions: unknown = QUESTIONS): AssistantEvent {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      model: 'claude-test',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Asking the human.' },
        { type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } },
      ],
    },
  };
}

function toolResult(
  toolUseId: string,
  content: ToolResultBlock['content'],
  is_error?: boolean,
): UserEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(is_error ? { is_error } : {}) }],
    },
  };
}

describe('AskUserQuestionFailureDetector', () => {
  it('fires onFailure with the questions when the gate tool_result is a Stream closed error', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    d.handleEvent(askToolUse('tu_1'));
    d.handleEvent(toolResult('tu_1', 'Tool permission request failed: Error: Stream closed', true));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(QUESTIONS);
  });

  it('matches the generic permission-request-failure text too', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    d.handleEvent(askToolUse('tu_1'));
    d.handleEvent(toolResult('tu_1', 'Tool permission request failed: Error: something else', true));
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when the gate succeeded (non-error tool_result)', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    d.handleEvent(askToolUse('tu_1'));
    d.handleEvent(toolResult('tu_1', 'user answered A'));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('does NOT fire for an error tool_result that is not a gate-channel drop', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    d.handleEvent(askToolUse('tu_1'));
    d.handleEvent(toolResult('tu_1', 'ValidationError: options must be 2-4', true));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('ignores tool_results for non-AskUserQuestion / unknown tool_use ids', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    d.handleEvent(toolResult('tu_other', 'Error: Stream closed', true));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('fires AT MOST ONCE per detector even across repeated failed retries', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    for (let i = 0; i < 6; i++) {
      d.handleEvent(askToolUse(`tu_${i}`));
      d.handleEvent(toolResult(`tu_${i}`, 'Error: Stream closed', true));
    }
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('matches error content given as an array of text parts', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    d.handleEvent(askToolUse('tu_1'));
    d.handleEvent(
      toolResult('tu_1', [{ type: 'text', text: 'Tool permission request failed: Error: Stream closed' }], true),
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('fires with [] when the questions payload is malformed but still recovers the gate', () => {
    const onFailure = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure });
    d.handleEvent(askToolUse('tu_1', 'not-an-array'));
    d.handleEvent(toolResult('tu_1', 'Error: Stream closed', true));
    expect(onFailure).toHaveBeenCalledWith([]);
  });

  it('never throws on a malformed/unknown event', () => {
    const onFailure = vi.fn();
    const warn = vi.fn();
    const d = new AskUserQuestionFailureDetector({ onFailure, logger: { warn } });
    expect(() => d.handleEvent({ kind: '__unknown__', raw: { junk: true } } as unknown as ClaudeStreamEvent)).not.toThrow();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
