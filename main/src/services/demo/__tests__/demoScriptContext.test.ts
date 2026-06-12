import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import type { EventRouter } from '../../streamParser';
import { DemoScriptContext, DemoScriptAborted } from '../demoScriptContext';
import type { DemoScriptArgs } from '../demoScriptContext';

interface OutputPayload {
  panelId: string;
  sessionId: string;
  type: string;
  data: Record<string, unknown>;
}

function makeCtx(overrides: Partial<DemoScriptArgs> = {}) {
  const emitter = new EventEmitter();
  const outputs: OutputPayload[] = [];
  emitter.on('output', (p) => outputs.push(p as OutputPayload));
  const abort = new AbortController();
  const ctx = new DemoScriptContext({
    panelId: 'run-1',
    sessionId: 'run-1',
    runId: 'run-1',
    worktreePath: '/tmp/none',
    prompt: '',
    signal: abort.signal,
    db: { prepare: () => ({ get: () => undefined }) } as unknown as Database.Database,
    emitter,
    eventRouter: null,
    ...overrides,
  });
  return { ctx, outputs, abort };
}

describe('DemoScriptContext transcript emission', () => {
  it('say() emits a schema-shaped assistant text event', () => {
    const { ctx, outputs } = makeCtx();
    ctx.say('hello there');

    expect(outputs).toHaveLength(1);
    expect(outputs[0].panelId).toBe('run-1');
    expect(outputs[0].type).toBe('json');
    const data = outputs[0].data as {
      type: string;
      message: { role: string; model: string; id: string; content: Array<{ type: string; text?: string }> };
    };
    expect(data.type).toBe('assistant');
    expect(data.message.role).toBe('assistant');
    expect(typeof data.message.id).toBe('string');
    expect(data.message.content).toEqual([{ type: 'text', text: 'hello there' }]);
  });

  it('tool() emits a tool_use + tool_result pair sharing the tool_use_id', () => {
    const { ctx, outputs } = makeCtx();
    const id = ctx.tool('Read', { file_path: 'a.ts' }, 'contents');

    expect(outputs).toHaveLength(2);
    const use = outputs[0].data as { message: { content: Array<{ type: string; id: string; name: string }> } };
    const result = outputs[1].data as { type: string; message: { content: Array<{ type: string; tool_use_id: string }> } };
    expect(use.message.content[0].type).toBe('tool_use');
    expect(use.message.content[0].id).toBe(id);
    expect(use.message.content[0].name).toBe('Read');
    expect(result.type).toBe('user');
    expect(result.message.content[0].tool_use_id).toBe(id);
  });

  it('persists through the eventRouter when one is wired', () => {
    const emitForRun = vi.fn();
    const { ctx } = makeCtx({ eventRouter: { emitForRun } as unknown as EventRouter });
    ctx.say('persisted');
    expect(emitForRun).toHaveBeenCalledTimes(1);
    expect(emitForRun.mock.calls[0][0]).toBe('run-1');
  });
});

describe('DemoScriptContext abort behavior', () => {
  it('sleep() rejects with DemoScriptAborted when the signal fires', async () => {
    const { ctx, abort } = makeCtx();
    const pending = ctx.sleep(10_000);
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(DemoScriptAborted);
  });

  it('emission throws DemoScriptAborted after abort', () => {
    const { ctx, abort } = makeCtx();
    abort.abort();
    expect(() => ctx.say('too late')).toThrow(DemoScriptAborted);
  });

  it('waitUntilRunning resolves once the run is back to running', async () => {
    const statuses = ['awaiting_review', 'awaiting_review', 'running'];
    const db = {
      prepare: () => ({ get: () => ({ status: statuses.shift() ?? 'running' }) }),
    } as unknown as Database.Database;
    const { ctx } = makeCtx({ db });
    await expect(ctx.waitUntilRunning(1)).resolves.toBeUndefined();
  });

  it('waitUntilRunning throws DemoScriptAborted when the run goes terminal', async () => {
    const db = {
      prepare: () => ({ get: () => ({ status: 'canceled' }) }),
    } as unknown as Database.Database;
    const { ctx } = makeCtx({ db });
    await expect(ctx.waitUntilRunning(1)).rejects.toBeInstanceOf(DemoScriptAborted);
  });
});
