/**
 * remoteClaudeSpawn's Phase D helpers (spec M2 §5 D1-D2):
 *  - loadRemoteSpawnPermissionRules reads the REMOTE worktree's `.claude/settings{,.local}.json` through the host fs
 *    (stat + bounded read), merges this Mac's user settings, freezes the snapshot and fails closed;
 *  - installRemoteWorkflowBundle / removeRemoteWorkflowBundle place / strip the bundle on the environment, in call
 *    order per worktree (a fire-and-forget teardown can never strip a later install), and never reject.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { WorkflowBundle } from '../../../orchestrator/workflows/workflowBundle';

const state = vi.hoisted(() => ({ bundle: { commands: [], agents: [], scripts: [] } as WorkflowBundle }));
vi.mock('../../../orchestrator/workflows/workflowBundle', () => ({
  resolveWorkflowBundle: () => state.bundle,
}));
vi.mock('../../panels/claude/agentOverlayWriter', () => ({
  resolveAgentOverlayFiles: () => [{ name: 'overlay', content: 'overlay agent' }],
  installAgentOverlay: () => undefined,
}));

import {
  _resetRemoteClaudeSpawnForTesting,
  installRemoteWorkflowBundle,
  loadRemoteSpawnPermissionRules,
  remoteBundleTarget,
  REMOTE_SETTINGS_MAX_BYTES,
  removeRemoteWorkflowBundle,
} from '../remoteClaudeSpawn';
import { WorkflowBundleWriter } from '../../panels/claude/workflowBundleWriter';
import { setProjectPermissionTrustResolver } from '../../../orchestrator/permissionRules';
import { createFakeMachineFs, cyboflowFilesUnder } from './fakeMachineFs';
import { makeSpyLogger } from '../../../orchestrator/__test_fixtures__/loggerLikeSpy';

const HOST = 'host-1';
const WT = '/Users/remote/cf-remote/host-1/worktrees/wt-a';
const settings = (permissions: Record<string, unknown>): string => JSON.stringify({ permissions });
const DB = {
  prepare: () => ({ get: () => ({ workflowPath: '/app/workflows/sprint.md' }) }),
} as unknown as Database.Database;

describe('loadRemoteSpawnPermissionRules', () => {
  let home: string;
  const prevTrust = process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-remote-perm-home-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settings({ allow: ['Read'], deny: ['Bash(rm:*)'] }));
    process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = '1';
    setProjectPermissionTrustResolver(() => false);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevTrust === undefined) delete process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES;
    else process.env.CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES = prevTrust;
  });

  it('merges the remote project files with this Mac\'s user file and freezes the snapshot', async () => {
    const remote = createFakeMachineFs({
      [`${WT}/.claude/settings.json`]: settings({ allow: ['Bash(npm test)'], deny: ['Bash(curl:*)'] }),
      [`${WT}/.claude/settings.local.json`]: settings({ ask: ['WebFetch'] }),
    });
    const rules = await loadRemoteSpawnPermissionRules({ hostId: HOST, fs: remote }, WT, undefined, home);
    expect(rules).toEqual({ allow: ['Read', 'Bash(npm test)'], deny: ['Bash(rm:*)', 'Bash(curl:*)'], ask: ['WebFetch'] });
    expect(Object.isFrozen(rules)).toBe(true);
    expect(Object.isFrozen(rules.allow)).toBe(true);
    expect([...remote.hostIds]).toEqual([HOST]);
    // Bounded: every read asks for at most the cap + 1 byte.
    expect(remote.ops.filter((op) => op.startsWith('readFile:'))).toHaveLength(2);
  });

  it('missing project files → this Mac\'s user rules only', async () => {
    const rules = await loadRemoteSpawnPermissionRules({ hostId: HOST, fs: createFakeMachineFs() }, WT, undefined, home);
    expect(rules).toEqual({ allow: ['Read'], deny: ['Bash(rm:*)'], ask: [] });
  });

  it.each([
    ['an oversized file', (): ReturnType<typeof createFakeMachineFs> => createFakeMachineFs({
      [`${WT}/.claude/settings.json`]: settings({ deny: ['Write'] }) + ' '.repeat(REMOTE_SETTINGS_MAX_BYTES),
    })],
    ['a directory in place of the file', (): ReturnType<typeof createFakeMachineFs> => createFakeMachineFs({
      [`${WT}/.claude/settings.json/inner`]: 'x',
    })],
    ['an unreachable environment', (): ReturnType<typeof createFakeMachineFs> => {
      const f = createFakeMachineFs();
      f.failOn = (verb) => (verb === 'stat' ? new Error('ssh: connect refused token=sk-ant-secret') : null);
      return f;
    }],
  ])('fails closed (no allow rules, never rejects) on %s', async (_label, make) => {
    const logger = makeSpyLogger();
    const rules = await loadRemoteSpawnPermissionRules({ hostId: HOST, fs: make() }, WT, logger, home);
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toContain('Bash(rm:*)');
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('sk-ant-secret');
  });
});

describe('remote workflow bundle install / teardown', () => {
  beforeEach(() => {
    _resetRemoteClaudeSpawnForTesting();
    state.bundle = {
      commands: [{ name: 'plan', content: '# plan' }],
      agents: [{ name: 'implement', content: 'impl' }],
      scripts: [],
    };
  });

  it('installs the bundle + overlay on the environment and teardown strips only cyboflow files', async () => {
    const remote = createFakeMachineFs({ [`${WT}/.claude/agents/mine.md`]: 'user agent' });
    const target = remoteBundleTarget({ hostId: HOST, fs: remote }, WT);
    const writer = new WorkflowBundleWriter();

    await installRemoteWorkflowBundle(DB, writer, 'run-1', target);
    expect(Object.keys(cyboflowFilesUnder(remote, WT)).sort()).toEqual([
      '.claude/agents/cyboflow-implement.md',
      '.claude/agents/cyboflow-overlay.md',
      '.claude/commands/cyboflow-plan.md',
    ]);

    await removeRemoteWorkflowBundle(writer, target);
    expect(cyboflowFilesUnder(remote, WT)).toEqual({});
    expect(remote.files.get(`${WT}/.claude/agents/mine.md`)?.data).toBe('user agent');
  });

  it('runs install / remove / install in call order even when not awaited (the next spawn keeps its bundle)', async () => {
    const remote = createFakeMachineFs();
    const slowWrite = remote.writeFile;
    remote.writeFile = async (p, data, mode) => {
      await new Promise((r) => setTimeout(r, 2));
      return slowWrite(p, data, mode);
    };
    const target = remoteBundleTarget({ hostId: HOST, fs: remote }, WT);
    const writer = new WorkflowBundleWriter();

    const first = installRemoteWorkflowBundle(DB, writer, 'run-1', target);
    const teardown = removeRemoteWorkflowBundle(writer, target);
    const second = installRemoteWorkflowBundle(DB, writer, 'run-2', target);
    await Promise.all([first, teardown, second]);

    expect(Object.keys(cyboflowFilesUnder(remote, WT))).toHaveLength(3);
    const unlinks = remote.ops.map((op, i) => (op.startsWith('unlink:') ? i : -1)).filter((i) => i >= 0);
    const writes = remote.ops.map((op, i) => (op.startsWith('writeFile:') ? i : -1)).filter((i) => i >= 0);
    expect(unlinks).toHaveLength(3);
    // first install's writes < teardown's unlinks < second install's writes
    expect(writes.slice(0, 3).every((w) => w < Math.min(...unlinks))).toBe(true);
    expect(writes.slice(3).every((w) => w > Math.max(...unlinks))).toBe(true);
  });

  it('never rejects when the environment is unreachable', async () => {
    const remote = createFakeMachineFs();
    remote.failOn = () => new Error('ssh dropped');
    const target = remoteBundleTarget({ hostId: HOST, fs: remote }, WT);
    const writer = new WorkflowBundleWriter(makeSpyLogger());
    await expect(installRemoteWorkflowBundle(DB, writer, 'run-1', target, makeSpyLogger())).resolves.toBeUndefined();
    await expect(removeRemoteWorkflowBundle(writer, target, makeSpyLogger())).resolves.toBeUndefined();
  });
});
