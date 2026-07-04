/**
 * ClaudePanelManager fast-mode threading — regression for the quick-session
 * fast-mode drop found in the SDK-0.3.201 live smoke (2026-07-04): the legacy
 * string-signature startPanel/continuePanel overloads (the panels:continue IPC
 * path) silently dropped fastMode because AIPanelConfig had no field for it and
 * extractAgentConfig only extracted [permissionMode, model]. Both turns of a
 * quick session then spawned at standard speed despite the persisted toggle.
 *
 * These tests pin the manager-layer threading end to end: legacy positional
 * args → unified config → extractAgentConfig → the cliManager's positional
 * (permissionMode, model, fastMode) tail, for startPanel AND continuePanel, in
 * both call styles. The IPC side (panels:continue reading the persisted
 * tool_panels.settings value) mirrors sessions:input and is covered by the live
 * smoke; this layer is where the value was being lost.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { ClaudePanelManager } from '../claudePanelManager';
import type { AbstractCliManager } from '../../cli/AbstractCliManager';
import type { SessionManager } from '../../../sessionManager';

function makeManager() {
  // The base class only needs an EventEmitter surface at construction
  // (setupEventHandlers) plus the two spawn methods asserted here.
  const cli = Object.assign(new EventEmitter(), {
    startPanel: vi.fn(async () => {}),
    continuePanel: vi.fn(async () => {}),
  });
  const manager = new ClaudePanelManager(
    cli as unknown as AbstractCliManager,
    {} as SessionManager,
  );
  manager.registerPanel('panel-1', 'sess-1');
  return { cli, manager };
}

describe('ClaudePanelManager fast-mode threading', () => {
  it('legacy startPanel signature threads fastMode through to the cli manager', async () => {
    const { cli, manager } = makeManager();
    await manager.startPanel('panel-1', '/wt', 'hi', 'ignore', 'opus', true);
    expect(cli.startPanel).toHaveBeenCalledWith(
      'panel-1', 'sess-1', '/wt', 'hi', 'ignore', 'opus', true,
    );
  });

  it('legacy continuePanel signature threads fastMode through to the cli manager', async () => {
    const { cli, manager } = makeManager();
    await manager.continuePanel('panel-1', '/wt', 'hi', [], 'opus', true);
    expect(cli.continuePanel).toHaveBeenCalledWith(
      'panel-1', 'sess-1', '/wt', 'hi', [], undefined, 'opus', true,
    );
  });

  it('config-object calls carry fastMode too', async () => {
    const { cli, manager } = makeManager();
    await manager.startPanel({
      panelId: 'panel-1',
      worktreePath: '/wt',
      prompt: 'hi',
      model: 'opus',
      fastMode: true,
    });
    expect(cli.startPanel).toHaveBeenCalledWith(
      'panel-1', 'sess-1', '/wt', 'hi', undefined, 'opus', true,
    );
  });

  it('omitted fastMode stays undefined (never defaults on)', async () => {
    const { cli, manager } = makeManager();
    await manager.startPanel('panel-1', '/wt', 'hi', 'ignore', 'opus');
    expect(cli.startPanel).toHaveBeenCalledWith(
      'panel-1', 'sess-1', '/wt', 'hi', 'ignore', 'opus', undefined,
    );
    await manager.continuePanel('panel-1', '/wt', 'hi', [], 'opus');
    expect(cli.continuePanel).toHaveBeenCalledWith(
      'panel-1', 'sess-1', '/wt', 'hi', [], undefined, 'opus', undefined,
    );
  });
});
