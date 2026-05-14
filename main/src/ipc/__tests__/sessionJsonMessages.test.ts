/**
 * Integration tests for projectStoredOutputs — the projection pipeline used by
 * the `panels:get-json-messages` IPC handler.
 *
 * Verifies that raw stored SessionOutput rows are correctly projected into
 * UnifiedMessage[] with `.segments` populated, that null-projecting events are
 * filtered out, and that persisted timestamps are preserved.
 */

import { describe, it, expect, vi } from 'vitest';

// Electron is imported transitively via session.ts → panelManager etc.
// Stub the minimum surface needed so the module can load in a Node.js test env.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// panelManager uses IPC at module load time — stub it.
vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
  },
}));

import { projectStoredOutputs } from '../session';
import type { SessionOutput } from '../../types/session';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a SessionOutput whose data is an already-parsed object (matches how
 *  sessionManager.getPanelOutputs() returns JSON rows after JSON.parse). */
function makeOutput(
  data: unknown,
  timestamp = new Date('2024-01-15T10:00:00.000Z'),
): SessionOutput {
  return {
    sessionId: 'sess-1',
    type: 'json',
    data,
    timestamp,
  };
}

const SYSTEM_INIT_RAW = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  cwd: '/tmp/project',
  model: 'claude-opus-4-5',
  tools: ['Bash', 'Read'],
  mcp_servers: [],
  permissionMode: 'default',
};

const ASSISTANT_RAW = {
  type: 'assistant',
  message: {
    id: 'msg-001',
    model: 'claude-opus-4-5',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Hello! I can help you with that.' },
    ],
    usage: { input_tokens: 100, output_tokens: 20 },
  },
};

/** A user event carrying only tool_result blocks — projects to null. */
const USER_TOOL_RESULT_RAW = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-xyz',
        content: 'command output',
        is_error: false,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('projectStoredOutputs', () => {
  it('projects system/init and assistant events into UnifiedMessages with populated segments', () => {
    const ts1 = new Date('2024-01-15T10:00:00.000Z');
    const ts2 = new Date('2024-01-15T10:00:01.000Z');

    const outputs: SessionOutput[] = [
      makeOutput(SYSTEM_INIT_RAW, ts1),
      makeOutput(ASSISTANT_RAW, ts2),
    ];

    const result = projectStoredOutputs(outputs, 'panel-1');

    expect(result.length).toBeGreaterThanOrEqual(1);

    // All results must have at least one segment.
    for (const msg of result) {
      expect(msg.segments).toBeDefined();
      expect(Array.isArray(msg.segments)).toBe(true);
      expect(msg.segments.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('filters out user/tool_result events (they project to null)', () => {
    const outputs: SessionOutput[] = [
      makeOutput(SYSTEM_INIT_RAW, new Date('2024-01-15T10:00:00.000Z')),
      makeOutput(USER_TOOL_RESULT_RAW, new Date('2024-01-15T10:00:00.500Z')),
      makeOutput(ASSISTANT_RAW, new Date('2024-01-15T10:00:01.000Z')),
    ];

    const result = projectStoredOutputs(outputs, 'panel-2');

    // user/tool_result → null — only system/init + assistant remain.
    expect(result.length).toBe(2);

    // None should have role 'user' (the projected user message is null-filtered).
    const roles = result.map(m => m.role);
    expect(roles).not.toContain('user');
  });

  it('preserves the persisted output timestamp on each UnifiedMessage', () => {
    const persistedTs = new Date('2024-03-20T15:30:45.123Z');
    const outputs: SessionOutput[] = [
      makeOutput(ASSISTANT_RAW, persistedTs),
    ];

    const result = projectStoredOutputs(outputs, 'panel-3');

    expect(result.length).toBe(1);
    expect(result[0].timestamp).toBe(persistedTs.toISOString());
  });

  it('returns an empty array when there are no json-typed outputs', () => {
    const outputs: SessionOutput[] = [
      {
        sessionId: 'sess-1',
        type: 'stdout',
        data: 'some stdout line\n',
        timestamp: new Date(),
      },
    ];

    const result = projectStoredOutputs(outputs, 'panel-4');
    expect(result).toEqual([]);
  });

  it('skips outputs with unparseable string data without throwing', () => {
    const outputs: SessionOutput[] = [
      {
        sessionId: 'sess-1',
        type: 'json',
        data: 'NOT_VALID_JSON{{',
        timestamp: new Date(),
      },
      makeOutput(ASSISTANT_RAW, new Date('2024-01-15T10:00:01.000Z')),
    ];

    // Should not throw, and should still project the valid assistant event.
    expect(() => projectStoredOutputs(outputs, 'panel-5')).not.toThrow();
    const result = projectStoredOutputs(outputs, 'panel-5');
    expect(result.length).toBe(1);
    expect(result[0].role).toBe('assistant');
  });
});
