/**
 * The BundleFs port (spec M2 §5 D1): WorkflowBundleWriter.writeVia / removeVia and
 * workflowBundleInstall.installWorkflowBundleVia place the SAME file set the sync local path does, through
 *  - localBundleFs (node:fs, a tmp dir) and
 *  - hostBundleFs over an in-memory MachineFs (an SSH environment's worktree, POSIX paths),
 * reconcile (write first, then prune stale cyboflow-* files) instead of clear-then-write, never touch user files,
 * and never write a git exclude for a remote worktree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { WorkflowBundle } from '../../../../orchestrator/workflows/workflowBundle';

const state = vi.hoisted(() => ({
  bundle: { commands: [], agents: [], scripts: [] } as WorkflowBundle,
  overlay: [] as Array<{ name: string; content: string }>,
  overlayThrows: false,
}));

vi.mock('../../../../orchestrator/workflows/workflowBundle', () => ({
  resolveWorkflowBundle: () => ({
    commands: [...state.bundle.commands],
    agents: [...state.bundle.agents],
    scripts: [...state.bundle.scripts],
  }),
}));

// The overlay's two faces stay consistent: the sync local writer and the port path read the same list.
vi.mock('../agentOverlayWriter', async () => {
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  return {
    resolveAgentOverlayFiles: () => {
      if (state.overlayThrows) throw new Error('overlay boom');
      return state.overlay;
    },
    installAgentOverlay: (_db: unknown, _runId: string, worktreePath: string) => {
      if (state.overlay.length === 0) return;
      const dir = nodePath.join(worktreePath, '.claude', 'agents');
      nodeFs.mkdirSync(dir, { recursive: true });
      for (const f of state.overlay) nodeFs.writeFileSync(nodePath.join(dir, `cyboflow-${f.name}.md`), f.content, 'utf8');
    },
  };
});

const excludeCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../../utils/gitExcludeWriter', () => ({
  ensureGitExcludeEntries: () => {
    excludeCalls.count += 1;
    return null;
  },
}));

import { WorkflowBundleWriter, localBundleFs } from '../workflowBundleWriter';
import { installWorkflowBundle, installWorkflowBundleVia } from '../workflowBundleInstall';
import { BUNDLE_FILE_MODE, hostBundleFs } from '../bundleFs';
import { createFakeMachineFs, cyboflowFilesUnder } from '../../../hosts/__tests__/fakeMachineFs';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

const REMOTE_WT = '/home/remote/cf-remote/host-1/worktrees/wt-1';
const HOST = 'host-1';

const DB = {
  prepare: () => ({ get: () => ({ workflowPath: '/app/workflows/sprint.md', name: 'sprint', specJson: '{}' }) }),
} as unknown as Database.Database;

function sampleBundle(): WorkflowBundle {
  return {
    commands: [{ name: 'plan', content: '# plan' }, { name: 'build', content: '# build' }],
    agents: [{ name: 'implement', content: 'bundle implement' }, { name: 'review', content: 'bundle review' }],
    scripts: [],
  };
}

/** cyboflow-* files under a LOCAL root as `{ relPosixPath: content }`. */
function localCyboflowFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sub of ['commands', 'agents', 'workflows']) {
    const dir = path.join(root, '.claude', sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('cyboflow-')) out[`.claude/${sub}/${name}`] = fs.readFileSync(path.join(dir, name), 'utf8');
    }
  }
  return out;
}

describe('WorkflowBundleWriter via a BundleFs port', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-bundle-port-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writeVia(localBundleFs) leaves the same tree as the sync write()', async () => {
    const writer = new WorkflowBundleWriter();
    const syncRoot = path.join(tmp, 'sync');
    const portRoot = path.join(tmp, 'port');
    const bundle = { ...sampleBundle(), scripts: [{ name: 'stage', content: 'export {}' }] };
    writer.write(syncRoot, bundle);
    await writer.writeVia(localBundleFs, portRoot, bundle);
    expect(localCyboflowFiles(portRoot)).toEqual(localCyboflowFiles(syncRoot));
    expect(Object.keys(localCyboflowFiles(portRoot))).toHaveLength(5);
  });

  it('writeVia(hostBundleFs) writes the same relative file set on the environment, mode 0644, stamped with the host', async () => {
    const writer = new WorkflowBundleWriter();
    const localRoot = path.join(tmp, 'local');
    writer.write(localRoot, sampleBundle());
    const remote = createFakeMachineFs();
    const result = await writer.writeVia(hostBundleFs(remote, HOST), REMOTE_WT, sampleBundle());

    expect(cyboflowFilesUnder(remote, REMOTE_WT)).toEqual(localCyboflowFiles(localRoot));
    expect(result?.commandPaths).toEqual([
      `${REMOTE_WT}/.claude/commands/cyboflow-plan.md`,
      `${REMOTE_WT}/.claude/commands/cyboflow-build.md`,
    ]);
    for (const f of remote.files.values()) expect(f.mode).toBe(BUNDLE_FILE_MODE);
    expect([...remote.hostIds]).toEqual([HOST]);
  });

  it('reconciles: writes the new set BEFORE pruning stale cyboflow files, and never touches user files', async () => {
    const remote = createFakeMachineFs({
      [`${REMOTE_WT}/.claude/commands/cyboflow-old.md`]: 'stale',
      [`${REMOTE_WT}/.claude/commands/cyboflow-plan.md`]: 'previous plan',
      [`${REMOTE_WT}/.claude/commands/mine.md`]: 'user command',
      [`${REMOTE_WT}/.claude/agents/cyboflow-gone.md`]: 'stale agent',
      [`${REMOTE_WT}/.claude/agents/cyboflow-notes.txt`]: 'not ours by extension',
    });
    await new WorkflowBundleWriter().writeVia(hostBundleFs(remote, HOST), REMOTE_WT, sampleBundle());

    expect(remote.files.get(`${REMOTE_WT}/.claude/commands/cyboflow-plan.md`)?.data).toBe('# plan');
    expect(remote.files.has(`${REMOTE_WT}/.claude/commands/cyboflow-old.md`)).toBe(false);
    expect(remote.files.has(`${REMOTE_WT}/.claude/agents/cyboflow-gone.md`)).toBe(false);
    expect(remote.files.get(`${REMOTE_WT}/.claude/commands/mine.md`)?.data).toBe('user command');
    expect(remote.files.has(`${REMOTE_WT}/.claude/agents/cyboflow-notes.txt`)).toBe(true);
    // Never unlinks a file it just wrote, and every write precedes the first unlink.
    const firstUnlink = remote.ops.findIndex((op) => op.startsWith('unlink:'));
    const lastWrite = remote.ops.map((op) => op.startsWith('writeFile:')).lastIndexOf(true);
    expect(lastWrite).toBeLessThan(firstUnlink);
    expect(remote.ops.filter((op) => op.startsWith('unlink:')).sort()).toEqual([
      `unlink:${REMOTE_WT}/.claude/agents/cyboflow-gone.md`,
      `unlink:${REMOTE_WT}/.claude/commands/cyboflow-old.md`,
    ]);
  });

  it('an empty bundle clears the prior set and returns null; missing dirs are fine', async () => {
    const remote = createFakeMachineFs({ [`${REMOTE_WT}/.claude/agents/cyboflow-x.md`]: 'x' });
    const writer = new WorkflowBundleWriter();
    expect(await writer.writeVia(hostBundleFs(remote, HOST), REMOTE_WT, { commands: [], agents: [], scripts: [] })).toBeNull();
    expect(cyboflowFilesUnder(remote, REMOTE_WT)).toEqual({});
  });

  it('refuses a name that escapes its directory (same containment rule as write())', async () => {
    const remote = createFakeMachineFs();
    const logger = makeSpyLogger();
    const writer = new WorkflowBundleWriter(logger);
    await writer.writeVia(hostBundleFs(remote, HOST), REMOTE_WT, {
      commands: [{ name: 'sub/evil', content: 'x' }, { name: 'ok', content: 'ok' }],
      agents: [],
      scripts: [],
    });
    expect(Object.keys(cyboflowFilesUnder(remote, REMOTE_WT))).toEqual(['.claude/commands/cyboflow-ok.md']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('removeVia strips only cyboflow files, counts them, and survives a failed unlink', async () => {
    const remote = createFakeMachineFs({
      [`${REMOTE_WT}/.claude/commands/cyboflow-a.md`]: 'a',
      [`${REMOTE_WT}/.claude/agents/cyboflow-b.md`]: 'b',
      [`${REMOTE_WT}/.claude/workflows/cyboflow-c.js`]: 'c',
      [`${REMOTE_WT}/.claude/agents/user.md`]: 'user',
    });
    remote.failOn = (verb, p) => (verb === 'unlink' && p.endsWith('cyboflow-b.md') ? new Error('busy') : null);
    const removed = await new WorkflowBundleWriter(makeSpyLogger()).removeVia(hostBundleFs(remote, HOST), REMOTE_WT);
    expect(removed).toBe(2);
    expect(Object.keys(cyboflowFilesUnder(remote, REMOTE_WT))).toEqual(['.claude/agents/cyboflow-b.md']);
    expect(remote.files.has(`${REMOTE_WT}/.claude/agents/user.md`)).toBe(true);
    expect(await new WorkflowBundleWriter().removeVia(hostBundleFs(createFakeMachineFs(), HOST), REMOTE_WT)).toBe(0);
  });
});

describe('installWorkflowBundleVia', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-bundle-install-port-'));
    state.bundle = sampleBundle();
    state.overlay = [
      { name: 'implement', content: 'overlay implement' },
      { name: 'verify', content: 'overlay verify' },
    ];
    state.overlayThrows = false;
    excludeCalls.count = 0;
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('places the same files (bundle + overlay, overlay wins) as the local install, without a git exclude', async () => {
    const writer = new WorkflowBundleWriter();
    installWorkflowBundle(DB, writer, 'run-1', tmp, undefined, 'prose');
    expect(excludeCalls.count).toBe(1);

    const remote = createFakeMachineFs();
    await installWorkflowBundleVia(hostBundleFs(remote, HOST), DB, writer, 'run-1', REMOTE_WT, undefined, 'prose');

    expect(excludeCalls.count).toBe(1); // the remote install wrote no exclude
    const remoteFiles = cyboflowFilesUnder(remote, REMOTE_WT);
    expect(remoteFiles).toEqual(localCyboflowFiles(tmp));
    expect(remoteFiles['.claude/agents/cyboflow-implement.md']).toBe('overlay implement');
    expect(remoteFiles['.claude/agents/cyboflow-review.md']).toBe('bundle review');
    expect(remoteFiles['.claude/agents/cyboflow-verify.md']).toBe('overlay verify');
    expect(remote.ops.some((op) => op.includes('/.git'))).toBe(false);
  });

  it('still installs the flow bundle when the overlay cannot be resolved', async () => {
    state.overlayThrows = true;
    const remote = createFakeMachineFs();
    const logger = makeSpyLogger();
    await installWorkflowBundleVia(hostBundleFs(remote, HOST), DB, new WorkflowBundleWriter(), 'run-1', REMOTE_WT, logger);
    expect(cyboflowFilesUnder(remote, REMOTE_WT)['.claude/agents/cyboflow-implement.md']).toBe('bundle implement');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never rejects when the environment fs fails', async () => {
    const remote = createFakeMachineFs();
    remote.failOn = (verb) => (verb === 'writeFile' ? new Error('ssh dropped') : null);
    const logger = makeSpyLogger();
    await expect(
      installWorkflowBundleVia(hostBundleFs(remote, HOST), DB, new WorkflowBundleWriter(), 'run-1', REMOTE_WT, logger),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
