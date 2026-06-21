/**
 * Tests for the synthetic event builders used to inject monitor conversation turns
 * into a programmatic run's unified transcript.
 *
 * Coverage:
 *   1. buildUserTextEvent produces a well-formed UserEvent with a text block
 *   2. buildAssistantTextEvent produces a well-formed AssistantEvent with a text block
 *   3. buildAssistantTextEvent honours the optional model override (defaults to 'monitor')
 *   4. buildAssistantTextEvent yields unique message ids across calls (no coalescing)
 *   5. MessageProjection renders the built user event to a user-role message
 *   6. MessageProjection renders the built assistant event to an assistant-role message
 */

import { describe, it, expect } from 'vitest';
import { buildUserTextEvent, buildAssistantTextEvent } from '../syntheticEvents';
import { MessageProjection } from '../../../services/streamParser/messageProjection';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';

describe('syntheticEvents', () => {
  // -------------------------------------------------------------------------
  // buildUserTextEvent
  // -------------------------------------------------------------------------

  it('buildUserTextEvent produces a well-formed UserEvent carrying a text block', () => {
    const event = buildUserTextEvent('Why did the step fail?');

    expect(event.type).toBe('user');
    expect(event.message.role).toBe('user');
    expect(event.parent_tool_use_id).toBeNull();
    expect(event.message.content).toEqual([{ type: 'text', text: 'Why did the step fail?' }]);
  });

  // -------------------------------------------------------------------------
  // buildAssistantTextEvent
  // -------------------------------------------------------------------------

  it('buildAssistantTextEvent produces a well-formed AssistantEvent carrying a text block', () => {
    const event = buildAssistantTextEvent('Triage — build: retry. Transient flake.');

    expect(event.type).toBe('assistant');
    expect(event.message.role).toBe('assistant');
    expect(event.parent_tool_use_id).toBeNull();
    expect(event.message.content).toEqual([
      { type: 'text', text: 'Triage — build: retry. Transient flake.' },
    ]);
    // Default model when no override is supplied.
    expect(event.message.model).toBe('monitor');
    expect(event.message.id).toMatch(/^monitor_/);
  });

  it('buildAssistantTextEvent honours the optional model override', () => {
    const event = buildAssistantTextEvent('hi', { model: 'claude-opus-4-5' });
    expect(event.message.model).toBe('claude-opus-4-5');
  });

  it('buildAssistantTextEvent yields a unique message id on each call', () => {
    const a = buildAssistantTextEvent('one');
    const b = buildAssistantTextEvent('two');
    expect(a.message.id).not.toBe(b.message.id);
  });

  // -------------------------------------------------------------------------
  // MessageProjection rendering
  // -------------------------------------------------------------------------

  it('MessageProjection renders a built user event to a user-role text message', () => {
    const projection = new MessageProjection('run-synthetic-test');
    const result = projection.project(buildUserTextEvent('What is happening?'));

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('user');
    expect(msg.segments).toHaveLength(1);
    expect(msg.segments[0].type).toBe('text');
    if (msg.segments[0].type === 'text') {
      expect(msg.segments[0].content).toBe('What is happening?');
    }
  });

  it('MessageProjection renders a built assistant event to an assistant-role text message', () => {
    const projection = new MessageProjection('run-synthetic-test');
    const result = projection.project(buildAssistantTextEvent('Escalating to a human.'));

    expect(result).not.toBeNull();
    const msg = result as UnifiedMessage;
    expect(msg.role).toBe('assistant');
    expect(msg.segments).toHaveLength(1);
    expect(msg.segments[0].type).toBe('text');
    if (msg.segments[0].type === 'text') {
      expect(msg.segments[0].content).toBe('Escalating to a human.');
    }
  });
});
