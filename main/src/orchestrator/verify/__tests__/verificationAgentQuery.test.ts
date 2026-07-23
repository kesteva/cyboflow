/**
 * Unit tests for createTranscriptAccumulator (verifier-transcript capture) — the
 * markdown-transcript builder verificationAgentQuery.ts's drain loop feeds every
 * raw SDK message through. Uses the REAL typed fakeSdk builders (sdkAssistantText,
 * sdkAssistantToolUse, sdkUserToolResult) so a message-shape drift is caught by
 * fakeSdk's own `satisfies` checks against the SDK's exported types, not just here.
 */
import { describe, it, expect } from 'vitest';
import { sdkAssistantText, sdkAssistantToolUse, sdkUserToolResult } from '../../../test/fakes/fakeSdk';
import { createTranscriptAccumulator } from '../verificationAgentQuery';

describe('createTranscriptAccumulator', () => {
  it('returns null when nothing was fed', () => {
    const acc = createTranscriptAccumulator();
    expect(acc.text()).toBeNull();
  });

  it('appends assistant text verbatim', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantText('building the widget'));
    expect(acc.text()).toBe('building the widget');
  });

  it('concatenates multiple text blocks in one assistant turn, then a later turn', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantText(['first', 'second']));
    acc.onMessage(sdkAssistantText('third'));
    expect(acc.text()).toBe('firstsecondthird');
  });

  it('renders a tool_use block as a fenced JSON excerpt of the tool name + input', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantToolUse('Bash', { command: 'npm run build' }));
    const text = acc.text() ?? '';
    expect(text).toContain('**Tool: Bash**');
    expect(text).toContain('```json');
    expect(text).toContain('"command":"npm run build"');
  });

  it('truncates a tool_use input JSON excerpt to 600 chars', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkAssistantToolUse('Bash', { command: 'x'.repeat(1000) }));
    const text = acc.text() ?? '';
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';
    // 600 chars kept + the single truncation ellipsis char appended.
    expect(body.length).toBe(601);
    expect(body.endsWith('…')).toBe(true);
  });

  it('renders a tool_result block as a fenced text excerpt, labeled as an error when is_error', () => {
    const okAcc = createTranscriptAccumulator();
    okAcc.onMessage(sdkUserToolResult('toolu_1', 'build succeeded'));
    const okText = okAcc.text() ?? '';
    expect(okText).toContain('Tool result:');
    expect(okText).toContain('build succeeded');
    expect(okText).not.toContain('Tool error result:');

    const errAcc = createTranscriptAccumulator();
    errAcc.onMessage(sdkUserToolResult('toolu_2', 'build failed: TS1005', { isError: true }));
    const errText = errAcc.text() ?? '';
    expect(errText).toContain('Tool error result:');
    expect(errText).toContain('build failed: TS1005');
  });

  it('truncates a tool_result excerpt to 1_500 chars', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage(sdkUserToolResult('toolu_1', 'y'.repeat(3000)));
    const text = acc.text() ?? '';
    const match = /```\n([\s\S]*?)\n```/.exec(text);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body.length).toBe(1501);
    expect(body.endsWith('…')).toBe(true);
  });

  it('caps the total transcript at 400_000 chars and appends the truncation marker exactly once', () => {
    const acc = createTranscriptAccumulator();
    // Each text block is far under the tool-excerpt caps, so many small pushes
    // drive the TOTAL cap rather than any per-message cap.
    for (let i = 0; i < 5000; i++) {
      acc.onMessage(sdkAssistantText('x'.repeat(100)));
    }
    const text = acc.text() ?? '';
    const marker = '[transcript truncated at 400000 chars]';
    const occurrences = text.split(marker).length - 1;
    expect(occurrences).toBe(1);
    // Further messages after truncation are silent no-ops (never re-append).
    acc.onMessage(sdkAssistantText('after truncation'));
    expect(acc.text()).toBe(text);
  });

  it('ignores message types it does not recognize, without throwing', () => {
    const acc = createTranscriptAccumulator();
    acc.onMessage({ type: 'system', subtype: 'init' });
    acc.onMessage(null);
    acc.onMessage('not a message');
    acc.onMessage(42);
    expect(acc.text()).toBeNull();
  });
});
