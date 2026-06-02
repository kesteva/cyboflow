/**
 * Unit tests for transcriptNormalizer.
 *
 * Golden fixtures mirror the canonical Probe-E inventory recorded in
 * docs/probes/IDEA-013-probe-findings.md (bare-REPL session `efde13c6`, captured
 * 2026-06-01 under `~/.claude/projects/-private-tmp-idea013-probe/`). They are
 * REAL line shapes (noise top-level types, every interactive system subtype,
 * panel-critical assistant text/thinking/tool_use, user array-content tool_result,
 * STRING-content user lines, and the stop_hook_summary / turn_duration turn-end
 * markers) — not invented shapes.
 *
 * Importing TypedEventNarrowing here is allowed (only the production seam files
 * must stay narrowing-free) — it proves the post-normalize panel subset narrows
 * to a typed variant, NOT `{ kind: '__unknown__' }`.
 */
import { describe, it, expect } from 'vitest';
import { normalizeTranscriptLine } from '../transcriptNormalizer';
import { TypedEventNarrowing } from '../../../../streamParser/typedEventNarrowing';
import type { ILogger } from '../../../../streamParser/types';

// ---------------------------------------------------------------------------
// Real Probe-E fixture lines (efde13c6, 2026-06-01)
// ---------------------------------------------------------------------------

const NOISE_TOP_LEVEL: Array<[string, unknown]> = [
  ['last-prompt', { type: 'last-prompt', leafUuid: 'e3982c16', sessionId: 'efde13c6' }],
  ['mode', { type: 'mode', mode: 'normal', sessionId: 'efde13c6' }],
  ['permission-mode', { type: 'permission-mode', permissionMode: 'auto', sessionId: 'efde13c6' }],
  ['bridge-session', { type: 'bridge-session', sessionId: 'efde13c6', bridgeSessionId: 'cse_01', lastSequenceNum: 0 }],
  [
    'attachment',
    {
      type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'SessionStart:startup', exitCode: 0 },
      uuid: 'a69cffde',
      cwd: '/private/tmp/idea013-probe',
      sessionId: 'efde13c6',
    },
  ],
  ['ai-title', { type: 'ai-title', aiTitle: 'Launch subagent', sessionId: 'efde13c6' }],
  [
    'file-history-snapshot',
    { type: 'file-history-snapshot', messageId: '01bc38e2', snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false },
  ],
  ['queue-operation', { type: 'queue-operation', op: 'enqueue', sessionId: 'efde13c6' }],
];

const NOISE_SYSTEM_SUBTYPES: Array<[string, unknown]> = [
  [
    'bridge_status',
    {
      type: 'system',
      subtype: 'bridge_status',
      content: '/remote-control is active',
      cwd: '/private/tmp/idea013-probe',
      sessionId: 'efde13c6',
    },
  ],
  ['local_command', { type: 'system', subtype: 'local_command', command: '/clear', sessionId: 'efde13c6' }],
];

const STOP_HOOK_SUMMARY_LINE: unknown = {
  type: 'system',
  subtype: 'stop_hook_summary',
  hookCount: 2,
  hookInfos: [{ command: 'node probe-hook.mjs', durationMs: 37 }],
  hookErrors: [],
  preventedContinuation: false,
  cwd: '/private/tmp/idea013-probe',
  sessionId: 'efde13c6',
};

const TURN_DURATION_LINE: unknown = {
  type: 'system',
  subtype: 'turn_duration',
  durationMs: 13399,
  messageCount: 14,
  cwd: '/private/tmp/idea013-probe',
  sessionId: 'efde13c6',
};

const ASSISTANT_TEXT_LINE: unknown = {
  type: 'assistant',
  message: {
    model: 'claude-opus-4-8',
    id: 'msg_01Qp3JN6orW2Lvgm5HKwMF2N',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Launching a subagent now.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3555, output_tokens: 172 },
  },
  cwd: '/private/tmp/idea013-probe',
  sessionId: 'efde13c6',
  uuid: 'ae153392',
};

const ASSISTANT_THINKING_LINE: unknown = {
  type: 'assistant',
  message: {
    model: 'claude-opus-4-8',
    id: 'msg_01Qp3JN6orW2Lvgm5HKwMF2N',
    type: 'message',
    role: 'assistant',
    // Real thinking block carries an extra `signature` field (stripped by Zod).
    content: [{ type: 'thinking', thinking: '', signature: 'ErgCCmMIDhgC' }],
    stop_reason: 'tool_use',
    stop_sequence: null,
  },
  cwd: '/private/tmp/idea013-probe',
  sessionId: 'efde13c6',
};

const ASSISTANT_TOOL_USE_LINE: unknown = {
  type: 'assistant',
  message: {
    model: 'claude-opus-4-8',
    id: 'msg_01ToolUse',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_01', name: 'Task', input: { subagent_type: 'general', prompt: 'echo' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
  },
  cwd: '/private/tmp/idea013-probe',
  sessionId: 'efde13c6',
};

const USER_TOOL_RESULT_LINE: unknown = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'from-subagent' }] },
    ],
  },
  uuid: '01bc38e2',
  cwd: '/private/tmp/idea013-probe',
  sessionId: 'efde13c6',
};

const USER_STRING_CONTENT_LINE: unknown = {
  type: 'user',
  message: {
    role: 'user',
    content: 'Use the Task tool to launch a subagent that runs the bash command: echo from-subagent',
  },
  uuid: '01bc38e2',
  cwd: '/private/tmp/idea013-probe',
  sessionId: 'efde13c6',
};

function makeSpyLogger(): Pick<ILogger, 'verbose'> {
  return { verbose: () => undefined };
}

describe('transcriptNormalizer', () => {
  describe('noise drop set', () => {
    it.each(NOISE_TOP_LEVEL)('drops noise top-level type %s', (_label, line) => {
      expect(normalizeTranscriptLine(line)).toEqual({ kind: 'drop' });
    });

    it.each(NOISE_SYSTEM_SUBTYPES)('drops unmodeled system subtype %s', (_label, line) => {
      expect(normalizeTranscriptLine(line)).toEqual({ kind: 'drop' });
    });

    it('drops a non-record / non-object line', () => {
      expect(normalizeTranscriptLine(42)).toEqual({ kind: 'drop' });
      expect(normalizeTranscriptLine(null)).toEqual({ kind: 'drop' });
      expect(normalizeTranscriptLine('a string')).toEqual({ kind: 'drop' });
    });
  });

  describe('turn-end side channel', () => {
    it('surfaces stop_hook_summary as a turn-end discriminant (not a panel envelope)', () => {
      const r = normalizeTranscriptLine(STOP_HOOK_SUMMARY_LINE);
      expect(r).toEqual({ kind: 'turn-end', marker: 'stop_hook_summary' });
    });

    it('surfaces turn_duration as a turn-end discriminant', () => {
      const r = normalizeTranscriptLine(TURN_DURATION_LINE);
      expect(r).toEqual({ kind: 'turn-end', marker: 'turn_duration' });
    });
  });

  describe('panel-critical mapping narrows to a typed variant (post-normalize __unknown__ rate = 0)', () => {
    const narrower = new TypedEventNarrowing(makeSpyLogger());

    const panelLines: Array<[string, unknown]> = [
      ['assistant/text', ASSISTANT_TEXT_LINE],
      ['assistant/thinking', ASSISTANT_THINKING_LINE],
      ['assistant/tool_use', ASSISTANT_TOOL_USE_LINE],
      ['user/array-content', USER_TOOL_RESULT_LINE],
      ['user/string-content', USER_STRING_CONTENT_LINE],
    ];

    it.each(panelLines)('%s normalizes to a schema-accepted variant', (_label, line) => {
      const r = normalizeTranscriptLine(line);
      expect(r.kind).toBe('panel');
      if (r.kind !== 'panel') throw new Error('expected panel');
      const event = narrower.narrow(r.event);
      expect('kind' in event && event.kind === '__unknown__').toBe(false);
    });

    it('records the post-normalize __unknown__ rate for panel-critical lines is 0', () => {
      let unknownCount = 0;
      for (const [, line] of panelLines) {
        const r = normalizeTranscriptLine(line);
        if (r.kind !== 'panel') {
          unknownCount += 1;
          continue;
        }
        const event = narrower.narrow(r.event);
        if ('kind' in event && event.kind === '__unknown__') unknownCount += 1;
      }
      expect(unknownCount).toBe(0);
    });
  });

  describe('STRING-content user lines are preserved, not dropped', () => {
    const narrower = new TypedEventNarrowing(makeSpyLogger());

    it('wraps a string-content user line without dropping it', () => {
      const r = normalizeTranscriptLine(USER_STRING_CONTENT_LINE);
      expect(r.kind).toBe('panel');
      if (r.kind !== 'panel') throw new Error('expected panel');
      // Survives narrow() (NOT __unknown__).
      const event = narrower.narrow(r.event);
      expect('kind' in event && event.kind === '__unknown__').toBe(false);
    });

    it('preserves the original string content verbatim in the normalized output', () => {
      const r = normalizeTranscriptLine(USER_STRING_CONTENT_LINE);
      if (r.kind !== 'panel') throw new Error('expected panel');
      const event = r.event as { message: { content: Array<{ content: unknown }> } };
      expect(event.message.content[0].content).toBe(
        'Use the Task tool to launch a subagent that runs the bash command: echo from-subagent',
      );
    });
  });
});
