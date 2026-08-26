import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PI_GATE_ENV_KEYS,
  PI_GATE_EXTENSION_SOURCE,
  decideToolCall,
  piGateModeForMode,
} from '../piGateExtension';

/**
 * End-to-end over the GENERATED extension source: the module is written to a
 * temp .mjs and imported for real, so the suite pins the exact bytes pi will
 * load — including the self-containment contract of `decideToolCall.toString()`
 * (a closure reference would ReferenceError right here).
 */
async function loadGateModule(envMode: 'dontAsk' | 'gated') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-gate-'));
  const file = path.join(dir, 'gate.mjs');
  fs.writeFileSync(
    file,
    `${PI_GATE_EXTENSION_SOURCE}\nexport { decideToolCall };\n`,
    'utf8',
  );
  process.env[PI_GATE_ENV_KEYS.mode] = envMode;
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    delete process.env[PI_GATE_ENV_KEYS.mode];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type Handler = (event: { toolName: string }) => Promise<{ block: boolean; reason?: string }>;

async function loadHandler(envMode: 'dontAsk' | 'gated'): Promise<Handler> {
  const mod = await loadGateModule(envMode);
  let handler: Handler | undefined;
  const fakePi = {
    on(_event: string, fn: Handler) {
      handler = fn;
    },
  };
  await mod.default(fakePi);
  if (!handler) throw new Error('gate extension did not register a tool_call handler');
  return handler;
}

describe('pi tool-call gate policy', () => {
  it('pure function: dontAsk allows everything; gated blocks writes, passes reads', () => {
    expect(decideToolCall('dontAsk', 'bash')).toEqual({ block: false });
    expect(decideToolCall('gated', 'read')).toEqual({ block: false });
    expect(decideToolCall('gated', 'grep')).toEqual({ block: false });

    const bash = decideToolCall('gated', 'bash');
    expect(bash.block).toBe(true);
    expect(bash.reason).toMatch(/gated mode/);

    // Unknown tools are write-tier by default (fail closed).
    expect(decideToolCall('gated', 'some-extension-tool').block).toBe(true);
  });

  it('generated module registers tool_call and enforces the same policy', async () => {
    const gated = await loadHandler('gated');
    await expect(gated({ toolName: 'edit' })).resolves.toMatchObject({ block: true });
    await expect(gated({ toolName: 'read' })).resolves.toMatchObject({ block: false });

    const yolo = await loadHandler('dontAsk');
    await expect(yolo({ toolName: 'bash' })).resolves.toMatchObject({ block: false });
  });

  it('mode mapper: only dontAsk unlocks the yolo mode', () => {
    expect(piGateModeForMode('default')).toBe('gated');
    expect(piGateModeForMode('acceptEdits')).toBe('gated');
    expect(piGateModeForMode('auto')).toBe('gated');
    expect(piGateModeForMode('dontAsk')).toBe('dontAsk');
  });

  it('env key matches what the manager spawns with', () => {
    expect(PI_GATE_ENV_KEYS.mode).toBe('CYBOFLOW_GATE_MODE');
    expect(PI_GATE_EXTENSION_SOURCE).toContain(PI_GATE_ENV_KEYS.mode);
    expect(PI_GATE_EXTENSION_SOURCE).toContain('tool_call');
  });
});
