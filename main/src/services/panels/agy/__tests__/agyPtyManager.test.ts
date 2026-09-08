import { describe, expect, it } from 'vitest';
import { AgyPtyManager } from '../agyPtyManager';
import { evaluateAgyVersionPolicy } from '../agyVersions';

class ExposedAgyPtyManager extends AgyPtyManager {
  exposeBuildCommandArgs(o: {
    prompt: string;
    model?: string;
    reasoningEffort?: string | null;
    agentPermissionMode?: 'default' | 'dontAsk' | 'acceptEdits';
    isContinue?: boolean;
  }): string[] {
    return this.buildCommandArgs({
      panelId: 'p',
      sessionId: 's',
      worktreePath: '/tmp',
      prompt: o.prompt,
      model: o.model,
      reasoningEffort: o.reasoningEffort,
      agentPermissionMode: o.agentPermissionMode,
      isContinue: o.isContinue,
    });
  }
}

function makeExposed(): ExposedAgyPtyManager {
  return new ExposedAgyPtyManager(
    { getDbSession: () => null } as never,
    undefined,
    { getDefaultAgentPermissionMode: () => 'default' } as never,
  );
}

describe('Agy PTY spawn args', () => {
  it('buildCommandArgs includes model, effort, continue, and interactive prompt', () => {
    const args = makeExposed().exposeBuildCommandArgs({
      prompt: 'do a thing',
      model: 'gemini-3.8-flash-high',
      reasoningEffort: 'high',
      isContinue: true,
    });
    expect(args).toContain('--model');
    expect(args).toContain('gemini-3.8-flash-high');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(args).toContain('--continue');
    expect(args).toContain('-i=do a thing');
  });

  it('adds --dangerously-skip-permissions when agentPermissionMode is dontAsk', () => {
    const args = makeExposed().exposeBuildCommandArgs({
      prompt: 'hello',
      agentPermissionMode: 'dontAsk',
    });
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('adds --mode accept-edits when agentPermissionMode is acceptEdits', () => {
    const args = makeExposed().exposeBuildCommandArgs({
      prompt: 'hello',
      agentPermissionMode: 'acceptEdits',
    });
    expect(args).toContain('--mode');
    expect(args).toContain('accept-edits');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('omits --dangerously-skip-permissions in default mode', () => {
    const args = makeExposed().exposeBuildCommandArgs({
      prompt: 'hello',
      agentPermissionMode: 'default',
    });
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--mode');
  });
});

describe('evaluateAgyVersionPolicy', () => {
  it('floors below 1.0.0 with a reason and accepts the tested version', () => {
    expect(evaluateAgyVersionPolicy('0.9.5')).toEqual({
      ok: false,
      aboveTested: false,
      reason: 'below-floor',
    });
    expect(evaluateAgyVersionPolicy('1.1.25')).toEqual({
      ok: true,
      aboveTested: false,
      reason: undefined,
    });
    expect(evaluateAgyVersionPolicy('1.2.0').aboveTested).toBe(true);
  });

  it('fails closed on unparseable version output', () => {
    expect(evaluateAgyVersionPolicy('agy-unknown')).toMatchObject({ ok: false, reason: 'unparseable' });
  });
});
