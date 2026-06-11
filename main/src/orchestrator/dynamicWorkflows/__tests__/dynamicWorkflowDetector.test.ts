/**
 * Unit tests for DynamicWorkflowDetector — Workflow-tool launch detection
 * (tool_use/tool_result pairing) and `<task-notification>` extraction over
 * synthetic typed ClaudeStreamEvents.
 */
import { describe, it, expect, vi } from 'vitest';
import { DynamicWorkflowDetector } from '../dynamicWorkflowDetector';
import type {
  AssistantEvent,
  ClaudeStreamEvent,
  ToolResultBlock,
  UserEvent,
} from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Synthetic event builders
// ---------------------------------------------------------------------------

function assistantToolUse(id: string, name: string): AssistantEvent {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
      model: 'claude-test',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Launching a workflow.' },
        { type: 'tool_use', id, name, input: {} },
      ],
    },
  };
}

function userToolResult(toolUseId: string, content: ToolResultBlock['content']): UserEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  };
}

/** Realistic Workflow tool_result text (shape per the launch contract). */
const LAUNCH_TEXT = [
  'Workflow launched in background. Task ID: wabc123',
  'Summary: x',
  'Transcript dir: /tmp/proj/sess/subagents/workflows/wf_aa11-2b',
  'Script file: /tmp/proj/sess/workflows/scripts/foo-wf_aa11-2b.js',
  'Use the journal to monitor progress. Run ID: wf_aa11-2b',
].join('\n');

const EXPECTED_LAUNCH = {
  taskId: 'wabc123',
  wfRunId: 'wf_aa11-2b',
  transcriptDir: '/tmp/proj/sess/subagents/workflows/wf_aa11-2b',
  scriptPath: '/tmp/proj/sess/workflows/scripts/foo-wf_aa11-2b.js',
};

function buildDetector() {
  const onLaunch = vi.fn();
  const onNotification = vi.fn();
  const warn = vi.fn();
  const detector = new DynamicWorkflowDetector({ onLaunch, onNotification, logger: { warn } });
  return { detector, onLaunch, onNotification, warn };
}

describe('DynamicWorkflowDetector', () => {
  // ---------------------------------------------------------------------------
  // launch detection
  // ---------------------------------------------------------------------------

  it('parses a launch from a pending Workflow tool_result (string content)', () => {
    const { detector, onLaunch } = buildDetector();
    detector.handleEvent(assistantToolUse('tu1', 'Workflow'));
    detector.handleEvent(userToolResult('tu1', LAUNCH_TEXT));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith(EXPECTED_LAUNCH);
  });

  it('parses a launch when the tool_result content is an array of text parts', () => {
    const { detector, onLaunch } = buildDetector();
    detector.handleEvent(assistantToolUse('tu1', 'Workflow'));
    detector.handleEvent(userToolResult('tu1', [{ type: 'text', text: LAUNCH_TEXT }]));
    expect(onLaunch).toHaveBeenCalledWith(EXPECTED_LAUNCH);
  });

  it('derives wfRunId from the transcript-dir basename when the Run ID line is absent', () => {
    const { detector, onLaunch } = buildDetector();
    const textWithoutRunId = LAUNCH_TEXT.split('\n')
      .filter((line) => !line.includes('Run ID:'))
      .join('\n');
    detector.handleEvent(assistantToolUse('tu1', 'Workflow'));
    detector.handleEvent(userToolResult('tu1', textWithoutRunId));
    expect(onLaunch).toHaveBeenCalledWith(EXPECTED_LAUNCH);
  });

  it('ignores tool_results for non-Workflow tools', () => {
    const { detector, onLaunch } = buildDetector();
    detector.handleEvent(assistantToolUse('tu1', 'Bash'));
    detector.handleEvent(userToolResult('tu1', LAUNCH_TEXT));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('ignores a tool_result whose tool_use_id was never seen', () => {
    const { detector, onLaunch } = buildDetector();
    detector.handleEvent(userToolResult('tu-unknown', LAUNCH_TEXT));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('a pending tool_result without the launch banner (e.g. an error) does not launch', () => {
    const { detector, onLaunch } = buildDetector();
    detector.handleEvent(assistantToolUse('tu1', 'Workflow'));
    detector.handleEvent(userToolResult('tu1', 'Error: workflow could not start'));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('warns (and does not launch) when the banner is present but fields are unparseable', () => {
    const { detector, onLaunch, warn } = buildDetector();
    detector.handleEvent(assistantToolUse('tu1', 'Workflow'));
    detector.handleEvent(userToolResult('tu1', 'Workflow launched in background. No fields here.'));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // task-notification extraction
  // ---------------------------------------------------------------------------

  it('extracts a notification from user-event block text', () => {
    const { detector, onNotification } = buildDetector();
    detector.handleEvent(
      userToolResult(
        'tu-any',
        '<task-notification>\n<task-id>wabc123</task-id>\n<status>completed</status>\n</task-notification>',
      ),
    );
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith({ taskId: 'wabc123', status: 'completed' });
  });

  it('extracts notifications from the UnknownStreamEvent catch-all (JSON-stringified raw)', () => {
    const { detector, onNotification } = buildDetector();
    const event: ClaudeStreamEvent = {
      kind: '__unknown__',
      raw: {
        some_field:
          '<task-notification><task-id>w9</task-id><status>killed</status></task-notification>',
      },
    };
    detector.handleEvent(event);
    expect(onNotification).toHaveBeenCalledWith({ taskId: 'w9', status: 'killed' });
  });

  it('extracts multiple notifications from one text', () => {
    const { detector, onNotification } = buildDetector();
    const text =
      '<task-notification><task-id>w1</task-id><status>completed</status></task-notification>' +
      '<task-notification><task-id>w2</task-id><status>failed</status></task-notification>';
    detector.handleEvent(userToolResult('tu-any', text));
    expect(onNotification).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenNthCalledWith(1, { taskId: 'w1', status: 'completed' });
    expect(onNotification).toHaveBeenNthCalledWith(2, { taskId: 'w2', status: 'failed' });
  });

  it('ignores a notification block missing task-id or status', () => {
    const { detector, onNotification } = buildDetector();
    detector.handleEvent(userToolResult('tu-any', '<task-notification><task-id>w1</task-id></task-notification>'));
    expect(onNotification).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // fail-soft
  // ---------------------------------------------------------------------------

  it('never throws on a malformed event (warns instead)', () => {
    const { detector, warn } = buildDetector();
    const malformed = { type: 'assistant' } as unknown as ClaudeStreamEvent;
    expect(() => detector.handleEvent(malformed)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated event types', () => {
    const { detector, onLaunch, onNotification } = buildDetector();
    detector.handleEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      num_turns: 1,
    });
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onNotification).not.toHaveBeenCalled();
  });
});
