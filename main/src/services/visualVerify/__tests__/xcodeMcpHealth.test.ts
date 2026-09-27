/**
 * xcodeMcpHealth — the `'xcode-mcp'` health row (§B2) and the §B8 "Approve
 * Xcode access" action (docs/proposals/runbook-optional-verification.md).
 *
 * The action runs the REAL bridge client over the schema-validating fake child
 * (so `XcodeOpenWorkspace` / `XcodeCloseWorkspace` are called with the keys the
 * committed tools_list fixture declares) and a scripted probe. No real
 * `xcrun mcpbridge` is spawned and no Xcode prompt is raised.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXcodeMcpBridgeClient } from '../../../orchestrator/verify/xcode/xcodeMcpBridgeClient';
import { FakeBridge, type ToolScript } from '../../../orchestrator/verify/xcode/__tests__/fakeMcpBridge';
import type { XcodeDeviceInteractionProbeResult } from '../xcodeDeviceInteractionProbe';
import {
  createXcodeApprovalAction,
  SCAFFOLD_PBXPROJ,
  XCODE_APPROVAL_DISCLOSURE,
  XCODE_APPROVAL_DIRNAME,
  writeScaffoldNoFollow,
  xcodeProbeRow,
} from '../xcodeMcpHealth';

const AGENT_ID = 'FCC0C7CB-C446-46B8-93A3-D9CB349F4416';

function result(over: Partial<XcodeDeviceInteractionProbeResult>): XcodeDeviceInteractionProbeResult {
  return {
    outcome: 'available',
    detail: 'Xcode 27.0 with iOS 27.0, headless mode on; approved',
    checks: [],
    approval: 'approved',
    grant: null,
    pendingRequestIds: [],
    xcodeVersion: '27.0',
    mcpbridgePath: '/Applications/Xcode.app/Contents/Developer/usr/bin/mcpbridge',
    iosRuntime: 'iOS 27.0',
    checkedAt: 0,
    ...over,
  };
}

describe('xcodeProbeRow (§B2)', () => {
  it('available is ok and names the grant expiry', () => {
    const row = xcodeProbeRow(result({ grant: { source: 'unsigned', agentId: AGENT_ID, expiresAt: Date.parse('2026-09-27T10:00:00Z') } }));
    expect(row).toMatchObject({ id: 'xcode-mcp', state: 'ok', fix: null });
    expect(row.detail).toContain('expires at 2026-09-27T10:00:00.000Z');
  });

  it('approval-required and expiring offer the approve action', () => {
    expect(xcodeProbeRow(result({ outcome: 'approval-required', approval: 'missing' }))).toMatchObject({
      state: 'missing',
      fix: 'approve-xcode-access',
    });
    expect(xcodeProbeRow(result({ outcome: 'expiring', approval: 'expiring' })).fix).toBe('approve-xcode-access');
  });

  it('unavailable is missing with NO action, but the detail carries each failed check’s remedy', () => {
    const row = xcodeProbeRow(
      result({
        outcome: 'unavailable',
        detail: 'no iOS 27+ runtime',
        checks: [
          { id: 'ios-runtime', ok: false, status: 'failed', detail: 'no iOS 27+', remedy: '`xcodebuild -downloadPlatform iOS`' },
          { id: 'headless-enabled', ok: false, status: 'failed', detail: 'off', remedy: '`sudo xcrun mcp-server enable`' },
          { id: 'mcpbridge', ok: true, status: 'ok', detail: '/x', remedy: null },
        ],
      }),
    );
    expect(row).toMatchObject({ state: 'missing', fix: null });
    expect(row.detail).toContain('xcodebuild -downloadPlatform iOS');
    expect(row.detail).toContain('sudo xcrun mcp-server enable');
  });

  it('inconclusive is never missing; the approve action is offered only when the GRANT is what could not be read', () => {
    expect(xcodeProbeRow(result({ outcome: 'inconclusive', approval: 'unknown' }))).toMatchObject({
      state: 'inconclusive',
      fix: 'approve-xcode-access',
    });
    expect(xcodeProbeRow(result({ outcome: 'inconclusive', approval: 'approved' })).fix).toBeNull();
  });
});

function scriptedProbe(after: XcodeDeviceInteractionProbeResult): {
  probe: { probe: () => Promise<XcodeDeviceInteractionProbeResult>; invalidate: () => void };
  invalidations: () => number;
} {
  let invalidated = 0;
  return {
    probe: {
      probe: async () => after,
      invalidate: () => {
        invalidated += 1;
      },
    },
    invalidations: () => invalidated,
  };
}

function actionWith(
  tools: Record<string, ToolScript>,
  after: XcodeDeviceInteractionProbeResult,
  signedBuild = false,
): { run: () => ReturnType<ReturnType<typeof createXcodeApprovalAction>>; bridge: FakeBridge; writes: string[]; invalidations: () => number } {
  const bridge = new FakeBridge({ tools });
  const writes: string[] = [];
  const { probe, invalidations } = scriptedProbe(after);
  const run = createXcodeApprovalAction({
    dataDir: '/data',
    probe,
    signedBuild,
    createClient: (options) => createXcodeMcpBridgeClient({ ...options, spawn: () => bridge, killGraceMs: 40 }),
    writeScaffold: async (projectDir, pbxproj) => {
      writes.push(projectDir);
      expect(pbxproj).toBe(SCAFFOLD_PBXPROJ);
    },
    confirmScaffold: async () => {},
  });
  return { run, bridge, writes, invalidations };
}

const OPEN_OK: ToolScript = () => ({ structured: { workspaceIdentifier: 'workspace1' } });
const CLOSE_OK: ToolScript = () => ({ structured: {} });

describe('createXcodeApprovalAction (§B8)', () => {
  it('opens ONLY the scaffold, closes it, re-reads the status, and SHOWS the 24 h command', async () => {
    const h = actionWith(
      { XcodeOpenWorkspace: OPEN_OK, XcodeCloseWorkspace: CLOSE_OK },
      result({ outcome: 'approval-required', approval: 'expired', grant: { source: 'unsigned', agentId: AGENT_ID, expiresAt: 1 } }),
    );
    const approval = await h.run();
    expect(h.writes).toEqual(['/data/xcode-approval/CyboflowApproval.xcodeproj']);
    expect(h.bridge.calls).toEqual([
      { name: 'XcodeOpenWorkspace', arguments: { path: '/data/xcode-approval/CyboflowApproval.xcodeproj' } },
      { name: 'XcodeCloseWorkspace', arguments: { workspaceIdentifier: 'workspace1' } },
    ]);
    expect(h.invalidations()).toBe(1);
    expect(approval).toMatchObject({
      outcome: 'prompted',
      approveCommand: `sudo xcrun mcp-server approve ${AGENT_ID} --for-24-hours`,
      durableApproveCommand: null,
      disclosure: XCODE_APPROVAL_DISCLOSURE,
    });
    expect(h.bridge.signals).toContain('SIGTERM');
  });

  it('offers --always ONLY on a signed build, and never the unsafe all-agents form', async () => {
    const h = actionWith(
      { XcodeOpenWorkspace: OPEN_OK, XcodeCloseWorkspace: CLOSE_OK },
      result({ outcome: 'approval-required', approval: 'missing', pendingRequestIds: [AGENT_ID] }),
      true,
    );
    const approval = await h.run();
    expect(approval.durableApproveCommand).toBe(`sudo xcrun mcp-server approve ${AGENT_ID} --always`);
    expect(JSON.stringify(approval)).not.toContain('unsafe');
  });

  it('reports approved when the re-read shows a live grant', async () => {
    const h = actionWith({ XcodeOpenWorkspace: OPEN_OK, XcodeCloseWorkspace: CLOSE_OK }, result({}));
    expect((await h.run()).outcome).toBe('approved');
  });

  it('a declined prompt is bridge-refused, with no command when no id is known', async () => {
    const h = actionWith(
      { XcodeOpenWorkspace: () => ({ toolError: 'The user declined the request' }) },
      result({ outcome: 'approval-required', approval: 'missing' }),
    );
    const approval = await h.run();
    expect(approval.outcome).toBe('bridge-refused');
    expect(approval.approveCommand).toBeNull();
    expect(approval.detail).toContain("Xcode's own prompt");
  });

  it('never interpolates an id that is not a plain identifier', async () => {
    const h = actionWith(
      { XcodeOpenWorkspace: OPEN_OK, XcodeCloseWorkspace: CLOSE_OK },
      result({ outcome: 'approval-required', approval: 'missing', pendingRequestIds: ['x; rm -rf /'] }),
    );
    expect((await h.run()).approveCommand).toBeNull();
  });

  it('shares one attempt between concurrent clicks', async () => {
    const h = actionWith({ XcodeOpenWorkspace: OPEN_OK, XcodeCloseWorkspace: CLOSE_OK }, result({}));
    const [a, b] = await Promise.all([h.run(), h.run()]);
    expect(a).toBe(b);
    expect(h.bridge.calls.filter((c) => c.name === 'XcodeOpenWorkspace')).toHaveLength(1);
  });
});

// X-4 — the REAL scaffold writer and containment check, over a real tmp dir.
describe.skipIf(process.platform === 'win32')('createXcodeApprovalAction — the scaffold never follows a symlink (X-4)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  function tmp(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-xapprove-')));
    dirs.push(dir);
    return dir;
  }
  /** A victim project the planted link points at; its pbxproj must survive untouched. */
  function victim(root: string): string {
    const dir = join(root, 'Victim.xcodeproj');
    mkdirSync(dir);
    writeFileSync(join(dir, 'project.pbxproj'), 'VICTIM');
    return dir;
  }
  function realAction(dataDir: string, extra: { writeScaffold?: (projectDir: string, pbxproj: string) => Promise<void> } = {}) {
    const bridge = new FakeBridge({ tools: { XcodeOpenWorkspace: OPEN_OK, XcodeCloseWorkspace: CLOSE_OK } });
    const { probe } = scriptedProbe(result({ outcome: 'approval-required', approval: 'missing' }));
    const run = createXcodeApprovalAction({
      dataDir,
      probe,
      signedBuild: false,
      createClient: (options) => createXcodeMcpBridgeClient({ ...options, spawn: () => bridge, killGraceMs: 40 }),
      ...extra,
    });
    return { run, bridge };
  }

  it('writes a fresh 0700 scaffold and opens exactly it', async () => {
    const dataDir = tmp();
    const { run, bridge } = realAction(dataDir);
    const approval = await run();
    const project = join(dataDir, XCODE_APPROVAL_DIRNAME, 'CyboflowApproval.xcodeproj');
    expect(readFileSync(join(project, 'project.pbxproj'), 'utf8')).toBe(SCAFFOLD_PBXPROJ);
    expect(bridge.calls[0]).toEqual({ name: 'XcodeOpenWorkspace', arguments: { path: project } });
    expect(approval.outcome).toBe('prompted');
    expect(statSync(project).mode & 0o777).toBe(0o700);
    // A second write over the existing scaffold replaces it in place, leaving no temp file.
    await writeScaffoldNoFollow(project, SCAFFOLD_PBXPROJ);
    expect(readdirSync(project)).toEqual(['project.pbxproj']);
  });

  it('refuses a pre-planted .xcodeproj symlink: the target is not written and Xcode is never asked', async () => {
    const dataDir = tmp();
    const target = victim(tmp());
    mkdirSync(join(dataDir, XCODE_APPROVAL_DIRNAME));
    symlinkSync(target, join(dataDir, XCODE_APPROVAL_DIRNAME, 'CyboflowApproval.xcodeproj'));
    const { run, bridge } = realAction(dataDir);
    const approval = await run();
    expect(approval.outcome).toBe('unavailable');
    expect(approval.detail).toContain('symbolic link');
    expect(readFileSync(join(target, 'project.pbxproj'), 'utf8')).toBe('VICTIM');
    expect(bridge.calls).toEqual([]);
  });

  it('refuses a symlinked xcode-approval dir and a symlinked project.pbxproj', async () => {
    const elsewhere = tmp();
    const dataDir = tmp();
    symlinkSync(elsewhere, join(dataDir, XCODE_APPROVAL_DIRNAME));
    expect((await realAction(dataDir).run()).outcome).toBe('unavailable');
    expect(existsSync(join(elsewhere, 'CyboflowApproval.xcodeproj'))).toBe(false);

    const dataDir2 = tmp();
    const target = victim(tmp());
    const project = join(dataDir2, XCODE_APPROVAL_DIRNAME, 'CyboflowApproval.xcodeproj');
    mkdirSync(project, { recursive: true });
    symlinkSync(join(target, 'project.pbxproj'), join(project, 'project.pbxproj'));
    expect((await realAction(dataDir2).run()).outcome).toBe('unavailable');
    expect(readFileSync(join(target, 'project.pbxproj'), 'utf8')).toBe('VICTIM');
  });

  it('a project swapped for a symlink AFTER the write fails the containment check right before the open', async () => {
    const dataDir = tmp();
    const target = victim(tmp());
    const { run, bridge } = realAction(dataDir, {
      writeScaffold: async (projectDir) => {
        mkdirSync(join(dataDir, XCODE_APPROVAL_DIRNAME), { recursive: true });
        symlinkSync(target, projectDir);
      },
    });
    const approval = await run();
    expect(approval.outcome).toBe('unavailable');
    expect(approval.detail).toContain('refused to open the approval scaffold');
    expect(bridge.calls).toEqual([]);
  });
});
