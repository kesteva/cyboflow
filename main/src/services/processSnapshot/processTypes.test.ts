import { describe, it, expect } from 'vitest';
import { classifyProcessType, type OwnedHandles } from './processTypes';
import { buildWorktreeTruthFixture } from './worktreeTruth';

const BROKER_CMD = 'node /x/app-server-broker.mjs serve --cwd /wt/one --endpoint unix:/tmp/s';

function handles(over: Partial<OwnedHandles> = {}): OwnedHandles {
  return { cli: [], shells: [], ...over };
}

const cliHandle = (pid: number, provider: 'claude' | 'codex' | 'pi' | 'omp') => ({
  pid,
  provider,
  panelId: `p${pid}`,
  sessionId: `s${pid}`,
  worktreePath: '/wt/one',
});

describe('classifyProcessType', () => {
  it('claude-cli: a pid owned by a Claude CLI manager', () => {
    const owned = handles({ cli: [cliHandle(10, 'claude')] });
    expect(classifyProcessType({ pid: 10, command: 'claude' }, owned)).toBe('claude-cli');
  });

  it('codex-cli: a pid owned by a Codex CLI manager', () => {
    const owned = handles({ cli: [cliHandle(11, 'codex')] });
    expect(classifyProcessType({ pid: 11, command: 'codex' }, owned)).toBe('codex-cli');
  });

  it('shell-pty: a pid owned by the run shell manager', () => {
    const owned = handles({
      shells: [{ pid: 12, runId: 'r', terminalId: 't', worktreePath: '/wt/one' }],
    });
    expect(classifyProcessType({ pid: 12, command: '-zsh' }, owned)).toBe('shell-pty');
  });

  it('codex-broker: an unowned row matching the broker predicate', () => {
    expect(classifyProcessType({ pid: 13, command: BROKER_CMD }, handles())).toBe('codex-broker');
  });

  it('unknown: matches nothing', () => {
    expect(classifyProcessType({ pid: 14, command: 'vim notes.txt' }, handles())).toBe('unknown');
  });

  it('pi/omp providers keep their own identity', () => {
    const owned = handles({ cli: [cliHandle(15, 'pi'), cliHandle(16, 'omp')] });
    expect(classifyProcessType({ pid: 15, command: 'pi' }, owned)).toBe('pi-cli');
    expect(classifyProcessType({ pid: 16, command: 'omp' }, owned)).toBe('omp-cli');
  });

  it('a manager handle wins over the broker predicate and a shell handle', () => {
    const owned = handles({
      cli: [cliHandle(20, 'codex')],
      shells: [{ pid: 20, runId: 'r', terminalId: 't', worktreePath: '/wt/one' }],
    });
    expect(classifyProcessType({ pid: 20, command: BROKER_CMD }, owned)).toBe('codex-cli');
    const shellOnly = handles({
      shells: [{ pid: 21, runId: 'r', terminalId: 't', worktreePath: '/wt/one' }],
    });
    expect(classifyProcessType({ pid: 21, command: BROKER_CMD }, shellOnly)).toBe('shell-pty');
  });

  it('negative control: without the handle the same pid is not classified as owned', () => {
    const owned = handles({ cli: [cliHandle(10, 'claude')] });
    expect(classifyProcessType({ pid: 99, command: 'claude' }, owned)).toBe('unknown');
  });
});

describe('buildWorktreeTruthFixture', () => {
  it('exposes the given paths as knownWorktreePaths', () => {
    const truth = buildWorktreeTruthFixture(['/wt/a', '/wt/b']);
    expect(truth.knownWorktreePaths.has('/wt/a')).toBe(true);
    expect(truth.knownWorktreePaths.has('/wt/c')).toBe(false);
    expect(buildWorktreeTruthFixture().knownWorktreePaths.size).toBe(0);
  });
});
