/**
 * Regression tests for TASK-655: ToolResultBlock.content union safety.
 *
 * `ToolResultBlock.content` is `string | Array<{type: string; text: string}>` on the wire.
 * These tests guard against the 10+ string-only operations that were silently broken when
 * array-form content arrived (JSON.parse throws, .includes returns false, template renders
 * [object Object]).
 */

import { describe, it, expect } from 'vitest';
import { extractToolResultText } from '../../../shared/utils/extractToolResultText';
import { formatToolInteraction } from './toolFormatter';
import type { ToolResultBlock } from '../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Helper type for tool calls — matches the internal ToolCall interface
// ---------------------------------------------------------------------------
type ToolCall = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

function makeBashCall(command: string): ToolCall {
  return { type: 'tool_use', id: 'id-bash', name: 'Bash', input: { command } };
}

function makeReadCall(filePath: string): ToolCall {
  return { type: 'tool_use', id: 'id-read', name: 'Read', input: { file_path: filePath } };
}

function makeStringResult(text: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: 'id-bash', content: text };
}

function makeArrayResult(texts: string[]): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'id-bash',
    content: texts.map((t) => ({ type: 'text', text: t })),
  };
}

// ---------------------------------------------------------------------------
// 1. extractToolResultText handles string, array-of-text-blocks, and empty array
// ---------------------------------------------------------------------------
describe('extractToolResultText', () => {
  it('returns string content unchanged', () => {
    expect(extractToolResultText('hello world')).toBe('hello world');
  });

  it('concatenates array-of-text-blocks into a single string', () => {
    const result = extractToolResultText([
      { type: 'text', text: 'foo' },
      { type: 'text', text: 'bar' },
    ]);
    expect(result).toBe('foobar');
  });

  it('handles array blocks with missing text field', () => {
    const result = extractToolResultText([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '' },
    ]);
    expect(result).toBe('hello');
  });

  it('returns empty string for an empty array', () => {
    expect(extractToolResultText([])).toBe('');
  });

  it('does not render [object Object] for array content', () => {
    const result = extractToolResultText([{ type: 'text', text: 'readable' }]);
    expect(result).not.toContain('[object Object]');
    expect(result).toBe('readable');
  });
});

// ---------------------------------------------------------------------------
// 2. Bash array-form error-tinting: output contains error text and ✗ Failed
// ---------------------------------------------------------------------------
describe('formatToolInteraction — Bash array-form error-tinting', () => {
  it('tints output as ✗ Failed when array content contains fatal:', () => {
    const toolCall = makeBashCall('git push');
    const toolResult = makeArrayResult(['fatal: bad refspec']);
    const output = formatToolInteraction(toolCall, toolResult, new Date().toISOString());

    expect(output).toContain('fatal');
    expect(output).toContain('✗ Failed');
  });

  it('tints output as ✗ Failed when array content contains error:', () => {
    const toolCall = makeBashCall('npm run build');
    const toolResult = makeArrayResult(['error: module not found']);
    const output = formatToolInteraction(toolCall, toolResult, new Date().toISOString());

    expect(output).toContain('error');
    expect(output).toContain('✗ Failed');
  });

  it('shows ✓ Complete when array content has no errors', () => {
    const toolCall = makeBashCall('echo hello');
    const toolResult = makeArrayResult(['hello']);
    const output = formatToolInteraction(toolCall, toolResult, new Date().toISOString());

    expect(output).toContain('✓ Complete');
    expect(output).not.toContain('✗ Failed');
  });
});

// ---------------------------------------------------------------------------
// 3. Read array-form content: JSON.parse robustness (no throw)
// ---------------------------------------------------------------------------
describe('formatToolInteraction — Read array-form JSON.parse robustness', () => {
  it('does not throw when Read tool result content is array-form text', () => {
    const toolCall = makeReadCall('/some/file.ts');
    const toolResult = makeArrayResult(['const x = 1;', '\nconst y = 2;']);

    expect(() => {
      formatToolInteraction(toolCall, toolResult, new Date().toISOString());
    }).not.toThrow();
  });

  it('includes extracted text in output for array-form Read result', () => {
    const toolCall = makeReadCall('/some/file.ts');
    const toolResult = makeArrayResult(['const answer = 42;']);
    const output = formatToolInteraction(toolCall, toolResult, new Date().toISOString());

    expect(output).toContain('const answer = 42;');
  });
});

// ---------------------------------------------------------------------------
// 4. Plain-string content: regression baseline (pre-task behaviour unchanged)
// ---------------------------------------------------------------------------
describe('formatToolInteraction — plain-string content regression baseline', () => {
  it('renders string content in output', () => {
    const toolCall = makeBashCall('ls -la');
    const toolResult = makeStringResult('total 42\ndrwxr-xr-x  file.ts');
    const output = formatToolInteraction(toolCall, toolResult, new Date().toISOString());

    expect(output).toContain('total 42');
    expect(output).toContain('file.ts');
  });

  it('marks ✗ Failed for string content containing Command failed', () => {
    const toolCall = makeBashCall('pnpm build');
    const toolResult = makeStringResult('Command failed with exit code 1');
    const output = formatToolInteraction(toolCall, toolResult, new Date().toISOString());

    expect(output).toContain('✗ Failed');
  });

  it('marks ✓ Complete for clean string content', () => {
    const toolCall = makeBashCall('echo done');
    const toolResult = makeStringResult('done');
    const output = formatToolInteraction(toolCall, toolResult, new Date().toISOString());

    expect(output).toContain('✓ Complete');
  });
});

// ---------------------------------------------------------------------------
// 5. Orphaned array-form tool_result renders as readable text, not [object Object]
// ---------------------------------------------------------------------------
describe('formatToolInteraction — orphaned array-form renders readable text', () => {
  it('extracted text is readable and does not contain [object Object]', () => {
    // Simulate the extraction that the orphaned branch now uses
    const arrayContent: ToolResultBlock['content'] = [
      { type: 'text', text: 'some tool output' },
    ];
    const extracted = extractToolResultText(arrayContent);

    expect(extracted).toBe('some tool output');
    expect(extracted).not.toContain('[object Object]');
  });

  it('handles multi-block array content in orphaned branch', () => {
    const arrayContent: ToolResultBlock['content'] = [
      { type: 'text', text: 'line 1\n' },
      { type: 'text', text: 'line 2' },
    ];
    const extracted = extractToolResultText(arrayContent);

    expect(extracted).toContain('line 1');
    expect(extracted).toContain('line 2');
  });
});
