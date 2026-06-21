import { describe, it, expect } from 'vitest';
import {
  DefaultSupervisorChatSession,
  SupervisorChatRegistry,
  buildSupervisorChatSystemPrompt,
  renderEventNote,
  type StreamingChatBackend,
  type StreamingChatHandle,
  type SupervisorChatSession,
} from '../supervisorChat';

const ctx = { runId: 'r', projectId: 1, workflowName: 'planner', worktreePath: '/wt' };

/** A fake streaming backend whose handle records sends/notes and can emit assistant text. */
function makeFakeBackend(): {
  backend: StreamingChatBackend;
  sends: string[];
  notes: string[];
  emit: (text: string) => void;
  closed: () => boolean;
  systemPrompt: () => string;
} {
  const sends: string[] = [];
  const notes: string[] = [];
  let cb: ((t: string) => void) | null = null;
  let closed = false;
  let systemPrompt = '';
  const handle: StreamingChatHandle = {
    send: (t) => sends.push(t),
    note: (t) => notes.push(t),
    onAssistantText: (fn) => {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    backend: {
      open: (args) => {
        systemPrompt = args.systemPrompt;
        return handle;
      },
    },
    sends,
    notes,
    emit: (t) => cb?.(t),
    closed: () => closed,
    systemPrompt: () => systemPrompt,
  };
}

describe('buildSupervisorChatSystemPrompt / renderEventNote', () => {
  it('frames the supervisor as monitor + human seam, not a sequencer', () => {
    const p = buildSupervisorChatSystemPrompt(ctx);
    expect(p).toContain('SUPERVISOR');
    expect(p).toContain('HOST CODE');
    expect(p).toMatch(/do NOT try to run/i);
  });
  it('renders concise event notes', () => {
    expect(renderEventNote({ kind: 'step-failed', runId: 'r', stepId: 'epics', error: 'boom' })).toContain('FAILED');
    expect(renderEventNote({ kind: 'gate-opened', runId: 'r', stepId: 'g' })).toContain('gate');
    expect(renderEventNote({ kind: 'run-finished', runId: 'r', outcome: 'completed' })).toContain('completed');
  });
});

describe('DefaultSupervisorChatSession', () => {
  it('opens the backend with the system prompt + cwd on start', async () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    await s.start(ctx);
    expect(f.systemPrompt()).toContain('planner');
  });

  it('relays a user message as a turn and records it in the transcript', async () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    await s.start(ctx);
    s.sendUserMessage('  what is happening?  ');
    expect(f.sends).toEqual(['what is happening?']); // trimmed, sent as a turn
    expect(s.getTranscript().filter((m) => m.role === 'user')[0].text).toBe('what is happening?');
  });

  it('ignores an empty user message', async () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    await s.start(ctx);
    s.sendUserMessage('   ');
    expect(f.sends).toEqual([]);
  });

  it('feeds a monitor event as a context NOTE (not a turn) + a system transcript line', async () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    await s.start(ctx);
    s.observe({ kind: 'step-failed', runId: 'r', stepId: 'epics', error: 'boom' });
    expect(f.sends).toEqual([]); // NOT a turn
    expect(f.notes[0]).toContain('FAILED');
    expect(s.getTranscript().some((m) => m.role === 'system' && m.text.includes('FAILED'))).toBe(true);
  });

  it('appends + coalesces streamed assistant text and notifies subscribers', async () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    const seen: string[] = [];
    s.onMessage((m) => {
      if (m.role === 'assistant') seen.push(m.text);
    });
    await s.start(ctx);
    f.emit('Hel');
    f.emit('lo');
    // Coalesced into ONE growing assistant message.
    const assistant = s.getTranscript().filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe('Hello');
    expect(seen[seen.length - 1]).toBe('Hello');
  });

  it('starts a NEW assistant message after a user turn (flush boundary)', async () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    await s.start(ctx);
    f.emit('first');
    s.sendUserMessage('next question'); // flush boundary
    f.emit('second');
    const assistant = s.getTranscript().filter((m) => m.role === 'assistant');
    expect(assistant.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('closes the handle and clears subscribers on stop', async () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    await s.start(ctx);
    await s.stop();
    expect(f.closed()).toBe(true);
  });

  it('drops a user message (no throw) when not started', () => {
    const f = makeFakeBackend();
    const s = new DefaultSupervisorChatSession(f.backend);
    expect(() => s.sendUserMessage('hi')).not.toThrow();
    expect(f.sends).toEqual([]);
  });
});

describe('SupervisorChatRegistry', () => {
  it('registers, gets, and unregisters a session by runId', () => {
    SupervisorChatRegistry._resetForTesting();
    const reg = SupervisorChatRegistry.getInstance();
    const fake = {} as SupervisorChatSession;
    reg.register('run-1', fake);
    expect(reg.get('run-1')).toBe(fake);
    reg.unregister('run-1');
    expect(reg.get('run-1')).toBeUndefined();
  });

  it('is a singleton', () => {
    expect(SupervisorChatRegistry.getInstance()).toBe(SupervisorChatRegistry.getInstance());
  });
});
