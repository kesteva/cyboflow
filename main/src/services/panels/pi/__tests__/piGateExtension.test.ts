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
  // realpathSync.native: a Windows temp dir spelled with an 8.3 short name
  // (C:\Users\RUNNER~1\…) gets its '~' percent-encoded by vite's import
  // resolution and the module fails to load; the expanded long name is safe.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'pi-gate-'));
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

  /**
   * The policy is only as good as the NAMES it matches on, and the previous
   * allow-list matched none of pi's glob tool: it listed 'glob' (Claude Code's
   * name) where pi registers 'find'. Nothing caught it, because every other
   * case in this file feeds the policy names the policy itself assumes.
   *
   * So enumerate pi's ACTUAL registry and classify all of it. Source of truth:
   * the `name:` fields of dist/core/tools/*.js in @earendil-works/pi-coding-agent
   * (verified at 0.84.3). If pi adds a tool, this list goes stale in the safe
   * direction — an unlisted tool is write-tier by fail-closed default — but a
   * RENAME of a read-only tool silently costs the agent that capability, which
   * is what this case exists to surface.
   */
  it("classifies pi's whole registered tool set, not just the names we assumed", () => {
    const PI_READ_ONLY_TOOLS = ['read', 'grep', 'ls', 'find'] as const;
    const PI_WRITE_TIER_TOOLS = ['edit', 'write', 'bash', 'powershell'] as const;

    for (const tool of PI_READ_ONLY_TOOLS) {
      expect(decideToolCall('gated', tool), `${tool} must pass under gated`).toEqual({
        block: false,
      });
    }
    for (const tool of PI_WRITE_TIER_TOOLS) {
      expect(decideToolCall('gated', tool).block, `${tool} must block under gated`).toBe(true);
    }
    // dontAsk is unconditional across the whole registry.
    for (const tool of [...PI_READ_ONLY_TOOLS, ...PI_WRITE_TIER_TOOLS]) {
      expect(decideToolCall('dontAsk', tool)).toEqual({ block: false });
    }
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
