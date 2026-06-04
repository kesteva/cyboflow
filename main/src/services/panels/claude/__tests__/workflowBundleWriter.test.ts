/**
 * Unit tests for WorkflowBundleWriter (IDEA-013 rung-(ii)).
 *
 * Covers:
 *   (a) write installs each command/agent as `.claude/commands|agents/cyboflow-<name>.md`;
 *   (b) write is merge-safe — pre-existing USER files in those dirs are preserved;
 *   (c) write clears the PRIOR cyboflow set first (a removed asset does not linger);
 *   (d) remove strips ONLY cyboflow-*.md and leaves user files intact;
 *   (e) an empty bundle writes nothing and returns null (no dirs created).
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowBundleWriter } from '../workflowBundleWriter';
import type { WorkflowBundle } from '../../../../orchestrator/workflows/workflowBundle';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

function tmpWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-bundle-'));
}

const commandsDir = (wt: string) => path.join(wt, '.claude', 'commands');
const agentsDir = (wt: string) => path.join(wt, '.claude', 'agents');

const BUNDLE: WorkflowBundle = {
  commands: [
    { name: 'context', content: '---\ndescription: ctx\n---\nContext phase.' },
    { name: 'tasks', content: '---\ndescription: tasks\n---\nTasks phase.' },
  ],
  agents: [{ name: 'researcher', content: '---\nname: researcher\ndescription: r\n---\nResearch.' }],
};

describe('WorkflowBundleWriter', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = tmpWorktree();
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('(a) installs commands and agents as cyboflow-<name>.md with verbatim content', () => {
    const result = new WorkflowBundleWriter(makeSpyLogger()).write(worktree, BUNDLE);

    expect(result).not.toBeNull();
    expect(result?.commandPaths).toHaveLength(2);
    expect(result?.agentPaths).toHaveLength(1);

    expect(fs.readFileSync(path.join(commandsDir(worktree), 'cyboflow-context.md'), 'utf8')).toBe(
      '---\ndescription: ctx\n---\nContext phase.',
    );
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-tasks.md'))).toBe(true);
    expect(fs.readFileSync(path.join(agentsDir(worktree), 'cyboflow-researcher.md'), 'utf8')).toContain(
      'Research.',
    );
  });

  it('(b) preserves a pre-existing USER command file', () => {
    fs.mkdirSync(commandsDir(worktree), { recursive: true });
    const userFile = path.join(commandsDir(worktree), 'deploy.md');
    fs.writeFileSync(userFile, 'user deploy command', 'utf8');

    new WorkflowBundleWriter().write(worktree, BUNDLE);

    expect(fs.readFileSync(userFile, 'utf8')).toBe('user deploy command');
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-context.md'))).toBe(true);
  });

  it('(c) clears the prior cyboflow set so a removed asset does not linger', () => {
    const writer = new WorkflowBundleWriter();
    writer.write(worktree, BUNDLE);
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-tasks.md'))).toBe(true);

    // Re-write a SMALLER bundle (tasks dropped).
    writer.write(worktree, { commands: [BUNDLE.commands[0]], agents: [] });

    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-context.md'))).toBe(true);
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-tasks.md'))).toBe(false);
    // The agent from the first write is also cleared.
    expect(fs.existsSync(path.join(agentsDir(worktree), 'cyboflow-researcher.md'))).toBe(false);
  });

  it('(d) remove strips only cyboflow-*.md and preserves user files', () => {
    const writer = new WorkflowBundleWriter();
    writer.write(worktree, BUNDLE);
    const userFile = path.join(commandsDir(worktree), 'deploy.md');
    fs.writeFileSync(userFile, 'user deploy', 'utf8');

    writer.remove(worktree);

    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-context.md'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir(worktree), 'cyboflow-researcher.md'))).toBe(false);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('user deploy');
  });

  it('(e) an empty bundle writes nothing and returns null', () => {
    const result = new WorkflowBundleWriter().write(worktree, { commands: [], agents: [] });
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
  });

  it('remove is a no-op when the worktree has no .claude dir', () => {
    expect(() => new WorkflowBundleWriter().remove(worktree)).not.toThrow();
  });
});
