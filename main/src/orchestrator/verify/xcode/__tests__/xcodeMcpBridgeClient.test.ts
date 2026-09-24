/**
 * xcodeMcpBridgeClient unit tests.
 *
 * NO real Xcode runs. A FAKE bridge child speaks newline-delimited JSON-RPC
 * over injected stdio and VALIDATES every `tools/call` against the input
 * schemas committed in `fixtures/mcpbridge-tools-list.json` (the live
 * `tools/list` dump from the B0 host, trimmed): an unknown tool, a missing
 * required key, an extra key or a mistyped value is refused the way a real
 * tool refusal arrives (`isError` + JSON error text). So if a wrapper ever
 * sends `interactionSessionKey` to Synthesize (which spells it
 * `interactSessionKey`), the suite fails.
 *
 * One test at the end drives the REAL {@link nodeBridgeSpawn} adapter against
 * a tiny node child, to pin the argv-only spawn and the drain-before-exit
 * ordering the fake cannot prove.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createXcodeMcpBridgeClient,
  isDeviceMismatchMessage,
  isNotApprovedMessage,
  isSessionMissingMessage,
  mintSessionIdentifier,
  nodeBridgeSpawn,
  sessionKeyFingerprint,
  XCODE_MCP_PROTOCOL_VERSION,
  type BridgeChild,
  type BridgeSpawn,
  type XcodeMcpBridgeClientOptions,
} from '../xcodeMcpBridgeClient';
import type { LoggerLike } from '../../../types';

interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

interface ToolsFixture {
  toolNames: string[];
  tools: Array<{ name: string; inputSchema: JsonSchema; outputSchema: JsonSchema | null }>;
}

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mcpbridge-tools-list.json'), 'utf8'),
) as ToolsFixture;

const SCHEMAS = new Map(FIXTURE.tools.map((tool) => [tool.name, tool.inputSchema]));

/** Validate arguments strictly against a committed input schema; `null` means valid. */
function schemaViolation(tool: string, args: unknown): string | null {
  const schema = SCHEMAS.get(tool);
  if (schema === undefined) {
    return FIXTURE.toolNames.includes(tool) ? `no schema committed for ${tool}` : `unknown tool ${tool}`;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object';
  const record = args as Record<string, unknown>;
  const properties = schema.properties ?? {};
  for (const key of Object.keys(record)) {
    const property = properties[key];
    if (property === undefined) return `unknown argument "${key}"`;
    if (property.type !== undefined && typeof record[key] !== property.type) {
      return `argument "${key}" must be ${property.type}`;
    }
  }
  for (const key of schema.required ?? []) {
    if (!(key in record)) return `missing required argument "${key}"`;
  }
  return null;
}

type ToolReply =
  | { structured: Record<string, unknown> }
  | { toolError: string; plain?: boolean }
  | { rpcError: string }
  | { contentOnly: string }
  | { raw: Record<string, unknown> }
  | 'hang'
  | 'die';

type ToolScript = (args: Record<string, unknown>) => ToolReply;

interface FakeBridgeOptions {
  tools?: Record<string, ToolScript>;
  /** Split every outbound line into two chunks, to exercise reassembly. */
  splitChunks?: boolean;
  /** Emit a notification and a server `ping` request before each response. */
  chatter?: boolean;
  ignoreSigterm?: boolean;
  ignoreSigkill?: boolean;
  /** Never answer `initialize`. */
  hangInitialize?: boolean;
  spawnError?: Error;
}

const START_OK: ToolScript = (args) => ({
  structured: {
    interactionSessionKey: args.sessionIdentifier,
    deviceUUID: 'D473B910-328C-443D-93D8-B241052F57CD',
    deviceIsSimulator: true,
    skillToTrigger: 'device-interaction',
    summary: 'To interact with the session, you MUST spawn a SUBAGENT …',
  },
});

const SYNTH_OK: ToolScript = () => ({
  structured: {
    applicationState: 'Running',
    hierarchyPath: '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-hierarchy.txt',
    logsPath: '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-logs.txt',
    screenshotPath: '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-screenshot.png',
    thumbnailScreenshotPath:
      '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-thumbnailScreenshot.png',
  },
});

const END_OK: ToolScript = () => ({ structured: { userMessage: 'Session stopped' } });

class FakeBridge implements BridgeChild {
  readonly pid = 4242;
  readonly received: Array<Record<string, unknown>> = [];
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  readonly signals: string[] = [];
  inputEnded = false;
  private stdoutListeners: Array<(chunk: string) => void> = [];
  private stderrListeners: Array<(chunk: string) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private spawnErrorListeners: Array<(err: Error) => void> = [];
  private exited = false;
  private inbound = '';

  constructor(private readonly opts: FakeBridgeOptions) {
    if (opts.spawnError !== undefined) {
      const err = opts.spawnError;
      setImmediate(() => {
        for (const listener of this.spawnErrorListeners) listener(err);
        this.exit(null, null);
      });
    }
  }

  write(chunk: string): void {
    if (this.exited) return;
    this.inbound += chunk;
    let newline = this.inbound.indexOf('\n');
    while (newline >= 0) {
      const line = this.inbound.slice(0, newline);
      this.inbound = this.inbound.slice(newline + 1);
      this.handle(JSON.parse(line) as Record<string, unknown>);
      newline = this.inbound.indexOf('\n');
    }
  }

  endInput(): void {
    this.inputEnded = true;
  }
  onStdout(listener: (chunk: string) => void): void {
    this.stdoutListeners.push(listener);
  }
  onStderr(listener: (chunk: string) => void): void {
    this.stderrListeners.push(listener);
  }
  onStdinError(): void {}
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }
  onSpawnError(listener: (err: Error) => void): void {
    this.spawnErrorListeners.push(listener);
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.opts.ignoreSigterm === true) return;
    if (signal === 'SIGKILL' && this.opts.ignoreSigkill === true) return;
    setImmediate(() => this.exit(null, signal));
  }

  /** Test hook: write to stderr and die, as a crashing bridge would. */
  die(stderr: string, code = 1): void {
    for (const listener of this.stderrListeners) listener(stderr);
    setImmediate(() => this.exit(code, null));
  }

  /** Test hook: push a raw line to the client. */
  emitLine(line: string): void {
    for (const listener of this.stdoutListeners) listener(line);
  }

  private exit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code, signal);
  }

  private reply(message: Record<string, unknown>): void {
    const text = `${JSON.stringify(message)}\n`;
    setImmediate(() => {
      if (this.exited) return;
      if (this.opts.chatter === true) {
        this.emitLine(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}\n`);
        this.emitLine(`${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' })}\n`);
      }
      if (this.opts.splitChunks === true) {
        const mid = Math.floor(text.length / 2);
        this.emitLine(text.slice(0, mid));
        this.emitLine(text.slice(mid));
      } else {
        this.emitLine(text);
      }
    });
  }

  private handle(message: Record<string, unknown>): void {
    this.received.push(message);
    const id = message.id;
    const method = message.method;
    if (method === undefined) return; // our own reply to a server request
    if (method === 'initialize') {
      if (this.opts.hangInitialize === true) return;
      this.reply({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: XCODE_MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'xcode-tools', version: '25317' },
        },
      });
      return;
    }
    if (method !== 'tools/call') return; // notifications/initialized
    const params = message.params as { name: string; arguments: Record<string, unknown> };
    this.calls.push({ name: params.name, arguments: params.arguments });
    const violation = schemaViolation(params.name, params.arguments);
    if (violation !== null) {
      this.reply({ jsonrpc: '2.0', id, result: toolErrorResult(`Invalid arguments: ${violation}`) });
      return;
    }
    const script = this.opts.tools?.[params.name];
    if (script === undefined) {
      this.reply({ jsonrpc: '2.0', id, result: toolErrorResult(`no script for ${params.name}`) });
      return;
    }
    const outcome = script(params.arguments);
    if (outcome === 'hang') return;
    if (outcome === 'die') {
      this.die('mcpbridge: lost connection to Xcode\n', 3);
      return;
    }
    if ('structured' in outcome) {
      this.reply({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(outcome.structured) }], structuredContent: outcome.structured },
      });
    } else if ('toolError' in outcome) {
      this.reply({
        jsonrpc: '2.0',
        id,
        result:
          outcome.plain === true
            ? { content: [{ type: 'text', text: outcome.toolError }], isError: true }
            : toolErrorResult(outcome.toolError),
      });
    } else if ('rpcError' in outcome) {
      this.reply({ jsonrpc: '2.0', id, error: { code: -32000, message: outcome.rpcError } });
    } else if ('contentOnly' in outcome) {
      this.reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: outcome.contentOnly }] } });
    } else {
      this.reply({ jsonrpc: '2.0', id, result: outcome.raw });
    }
  }
}

/** The bridge's measured error envelope: `content[0].text` is JSON `{type, data}`. */
function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ type: 'error', data: message }) }], isError: true };
}

interface Harness {
  bridge: FakeBridge;
  spawnCalls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
  logLines: string[];
  client: ReturnType<typeof createXcodeMcpBridgeClient>;
}

function recordingLogger(lines: string[]): LoggerLike {
  const record =
    (level: string) =>
    (message: string, context?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${JSON.stringify(context ?? {})}`);
    };
  return { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
}

function harness(
  fake: FakeBridgeOptions = {},
  options: Partial<XcodeMcpBridgeClientOptions> = {},
): Harness {
  const bridge = new FakeBridge({
    tools: {
      DeviceInteractionStartSession: START_OK,
      DeviceInteractionSynthesize: SYNTH_OK,
      DeviceInteractionEndSession: END_OK,
    },
    ...fake,
  });
  const spawnCalls: Harness['spawnCalls'] = [];
  const spawn: BridgeSpawn = (command, args, opts) => {
    spawnCalls.push({ command, args, env: opts.env });
    return bridge;
  };
  const logLines: string[] = [];
  const client = createXcodeMcpBridgeClient({
    spawn,
    env: { PATH: '/usr/bin' },
    logger: recordingLogger(logLines),
    killGraceMs: 40,
    ...options,
  });
  return { bridge, spawnCalls, logLines, client };
}

async function connected(fake: FakeBridgeOptions = {}, options: Partial<XcodeMcpBridgeClientOptions> = {}) {
  const h = harness(fake, options);
  const handshake = await h.client.connect();
  expect(handshake.ok).toBe(true);
  return h;
}

describe('the committed tools fixture', () => {
  it('lists all 53 tools and carries the three DeviceInteraction schemas', () => {
    expect(FIXTURE.toolNames).toHaveLength(53);
    expect(SCHEMAS.get('DeviceInteractionSynthesize')?.required).toEqual(['interactSessionKey']);
    expect(SCHEMAS.get('DeviceInteractionEndSession')?.required).toEqual(['interactionSessionKey']);
    expect(SCHEMAS.get('DeviceInteractionStartSession')?.required).toEqual([
      'deviceIdentifier',
      'sessionIdentifier',
    ]);
  });
});

describe('connect', () => {
  it('spawns the absolute xcrun with argv [mcpbridge] and completes the handshake', async () => {
    const h = harness();
    const handshake = await h.client.connect();
    expect(handshake).toEqual({
      ok: true,
      structured: { protocolVersion: '2025-06-18', serverName: 'xcode-tools', serverVersion: '25317' },
    });
    expect(h.spawnCalls).toEqual([{ command: '/usr/bin/xcrun', args: ['mcpbridge'], env: { PATH: '/usr/bin' } }]);
    const [init, initialized] = h.bridge.received;
    expect(init).toMatchObject({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cyboflow' } },
    });
    expect(initialized).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(h.client.pid).toBe(4242);
    expect(h.client.isAlive()).toBe(true);
  });

  it('is idempotent: concurrent callers share one spawn', async () => {
    const h = harness();
    const [a, b] = await Promise.all([h.client.connect(), h.client.connect()]);
    expect(a).toBe(b);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('refuses a relative xcrun path at construction', () => {
    expect(() => createXcodeMcpBridgeClient({ xcrunPath: 'xcrun' })).toThrow(/absolute/);
  });

  it('reports a handshake that never answers as a timeout, and reaps the child', async () => {
    const h = harness({ hangInitialize: true }, { initTimeoutMs: 30 });
    const handshake = await h.client.connect();
    expect(handshake).toMatchObject({ ok: false, kind: 'timeout' });
    // Single-use: the failed connect already terminated the bridge.
    expect(h.bridge.signals).toEqual(['SIGTERM']);
    expect(h.client.isAlive()).toBe(false);
    await expect(h.client.endSession({ interactionSessionKey: 'k' })).resolves.toMatchObject({
      ok: false,
      kind: 'bridge-exited',
    });
  });

  it('reports a bridge that cannot start as bridge-exited', async () => {
    const h = harness({ spawnError: Object.assign(new Error('spawn /usr/bin/xcrun ENOENT'), { code: 'ENOENT' }) });
    const handshake = await h.client.connect();
    expect(handshake).toMatchObject({ ok: false, kind: 'bridge-exited' });
    if (!handshake.ok) expect(handshake.message).toMatch(/ENOENT/);
    expect(h.client.isAlive()).toBe(false);
  });

  it('reports a spawn seam that throws as bridge-exited, never a throw', async () => {
    const client = createXcodeMcpBridgeClient({
      spawn: () => {
        throw new Error('EACCES');
      },
    });
    await expect(client.connect()).resolves.toMatchObject({ ok: false, kind: 'bridge-exited' });
    await expect(client.call('DeviceInteractionEndSession', { interactionSessionKey: 'k' })).resolves.toMatchObject({
      ok: false,
      kind: 'bridge-exited',
    });
  });

  it('refuses a call before connect as a protocol failure', async () => {
    const h = harness();
    await expect(h.client.endSession({ interactionSessionKey: 'k' })).resolves.toMatchObject({
      ok: false,
      kind: 'protocol',
    });
    expect(h.spawnCalls).toHaveLength(0);
  });
});

describe('typed wrappers send the exact argument keys the schemas name', () => {
  it('startSession sends deviceIdentifier + sessionIdentifier and returns the typed session', async () => {
    const h = await connected();
    const result = await h.client.startSession({
      deviceIdentifier: 'D473B910-328C-443D-93D8-B241052F57CD',
      sessionIdentifier: 'Cyboflow Verify abc',
    });
    expect(h.bridge.calls).toEqual([
      {
        name: 'DeviceInteractionStartSession',
        arguments: { deviceIdentifier: 'D473B910-328C-443D-93D8-B241052F57CD', sessionIdentifier: 'Cyboflow Verify abc' },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      structured: {
        interactionSessionKey: 'Cyboflow Verify abc',
        deviceUUID: 'D473B910-328C-443D-93D8-B241052F57CD',
        deviceIsSimulator: true,
        summary: 'To interact with the session, you MUST spawn a SUBAGENT …',
        skillToTrigger: 'device-interaction',
      },
    });
  });

  it('synthesize with no command sends ONLY interactSessionKey (a pure capture, no activation)', async () => {
    const h = await connected();
    const result = await h.client.synthesize({ interactSessionKey: 'Cyboflow Verify abc' });
    expect(h.bridge.calls[0]?.arguments).toEqual({ interactSessionKey: 'Cyboflow Verify abc' });
    expect(result).toMatchObject({
      ok: true,
      structured: { applicationState: 'Running', screenshotPath: expect.stringMatching(/screenshot\.png$/) },
    });
  });

  it('synthesize forwards a command and an activation under their schema names', async () => {
    const h = await connected();
    await h.client.synthesize({
      interactSessionKey: 'k',
      interactionCommand: 't 201 437',
      activationBundleId: 'com.example.fixtureapp',
    });
    expect(h.bridge.calls[0]?.arguments).toEqual({
      interactSessionKey: 'k',
      interactionCommand: 't 201 437',
      activationBundleId: 'com.example.fixtureapp',
    });
  });

  it('endSession sends interactionSessionKey', async () => {
    const h = await connected();
    const result = await h.client.endSession({ interactionSessionKey: 'k' });
    expect(h.bridge.calls[0]).toEqual({ name: 'DeviceInteractionEndSession', arguments: { interactionSessionKey: 'k' } });
    expect(result).toEqual({ ok: true, structured: { userMessage: 'Session stopped' } });
  });

  it('the fake really validates: the wrong spelling for Synthesize is refused', async () => {
    const h = await connected();
    const wrong = await h.client.call('DeviceInteractionSynthesize', { interactionSessionKey: 'k' });
    expect(wrong).toMatchObject({ ok: false, kind: 'tool-error' });
    if (!wrong.ok) expect(wrong.message).toMatch(/unknown argument "interactionSessionKey"/);
  });

  it('maps a missing hierarchyPath to null rather than failing the capture', async () => {
    const h = await connected({
      tools: {
        DeviceInteractionSynthesize: () => ({
          structured: { applicationState: 'Running', screenshotPath: '/tmp/s.png' },
        }),
      },
    });
    const result = await h.client.synthesize({ interactSessionKey: 'k' });
    expect(result).toEqual({
      ok: true,
      structured: {
        screenshotPath: '/tmp/s.png',
        applicationState: 'Running',
        thumbnailScreenshotPath: null,
        hierarchyPath: null,
        logsPath: null,
      },
    });
  });

  it('rejects a typed result missing a required field as protocol', async () => {
    const h = await connected({
      tools: {
        DeviceInteractionStartSession: () => ({ structured: { interactionSessionKey: 'k', deviceIsSimulator: true } }),
      },
    });
    const result = await h.client.startSession({ deviceIdentifier: 'u', sessionIdentifier: 's' });
    expect(result).toMatchObject({ ok: false, kind: 'protocol' });
    if (!result.ok) expect(result.message).toMatch(/deviceUUID/);
  });

  it('reads the typed payload from content text when structuredContent is absent', async () => {
    const h = await connected({
      tools: { DeviceInteractionEndSession: () => ({ contentOnly: JSON.stringify({ userMessage: 'Session stopped' }) }) },
    });
    await expect(h.client.endSession({ interactionSessionKey: 'k' })).resolves.toEqual({
      ok: true,
      structured: { userMessage: 'Session stopped' },
    });
  });

  it('treats a result with neither structured nor JSON content as protocol', async () => {
    const h = await connected({ tools: { DeviceInteractionEndSession: () => ({ contentOnly: 'done' }) } });
    await expect(h.client.endSession({ interactionSessionKey: 'k' })).resolves.toMatchObject({
      ok: false,
      kind: 'protocol',
    });
  });
});

describe('failure classification', () => {
  const APPROVAL = "This agent isn't approved to use Xcode's tools yet";

  it('classifies the approval refusal as not-approved (tool error envelope)', async () => {
    const h = await connected({ tools: { DeviceInteractionStartSession: () => ({ toolError: APPROVAL }) } });
    const result = await h.client.startSession({ deviceIdentifier: 'u', sessionIdentifier: 's' });
    expect(result).toEqual({ ok: false, kind: 'not-approved', message: APPROVAL });
  });

  it('classifies the approval refusal as not-approved on a JSON-RPC error and with a curly apostrophe', async () => {
    const h = await connected({
      tools: {
        DeviceInteractionStartSession: () => ({ rpcError: APPROVAL }),
        DeviceInteractionSynthesize: () => ({ toolError: 'This agent isn’t approved to use Xcode’s tools yet' }),
      },
    });
    await expect(h.client.startSession({ deviceIdentifier: 'u', sessionIdentifier: 's' })).resolves.toMatchObject({
      kind: 'not-approved',
    });
    await expect(h.client.synthesize({ interactSessionKey: 'k' })).resolves.toMatchObject({ kind: 'not-approved' });
  });

  it('maps isError to tool-error with the envelope data as the message', async () => {
    const message = 'Session not found. It may have already been closed, or the identifier is wrong';
    const h = await connected({ tools: { DeviceInteractionSynthesize: () => ({ toolError: message }) } });
    const result = await h.client.synthesize({ interactSessionKey: 'k' });
    expect(result).toEqual({ ok: false, kind: 'tool-error', message });
    expect(isSessionMissingMessage(message)).toBe(true);
  });

  it('keeps a plain-text isError body as the message', async () => {
    const h = await connected({
      tools: { DeviceInteractionSynthesize: () => ({ toolError: 'The task timed out. Please try again.', plain: true }) },
    });
    await expect(h.client.synthesize({ interactSessionKey: 'k' })).resolves.toEqual({
      ok: false,
      kind: 'tool-error',
      message: 'The task timed out. Please try again.',
    });
  });

  it('maps a non-approval JSON-RPC error to protocol', async () => {
    const h = await connected({ tools: { DeviceInteractionSynthesize: () => ({ rpcError: 'Invalid params' }) } });
    await expect(h.client.synthesize({ interactSessionKey: 'k' })).resolves.toEqual({
      ok: false,
      kind: 'protocol',
      message: 'Invalid params',
    });
  });

  it('message helpers recognise the measured B0 spellings', () => {
    expect(isNotApprovedMessage(APPROVAL)).toBe(true);
    expect(isNotApprovedMessage('Session stopped')).toBe(false);
    expect(
      isSessionMissingMessage(
        "Session with that key doesn't exist. To recover, start a new session by calling DeviceInteractionStartWorkspaceSession",
      ),
    ).toBe(true);
    // EndSession's SUCCESS text for an already-gone session.
    expect(isSessionMissingMessage("Session doesn't exist anymore")).toBe(true);
    expect(
      isDeviceMismatchMessage(
        "Target device doesn't match the requested session, likely modified by a concurrent agent.",
      ),
    ).toBe(true);
    expect(isDeviceMismatchMessage('Session stopped')).toBe(false);
  });
});

describe('timeouts, bridge death and framing', () => {
  it('times out a call that never answers, ignores the late reply, and keeps working', async () => {
    let first = true;
    const h = await connected({
      tools: {
        DeviceInteractionSynthesize: () => {
          if (first) {
            first = false;
            return 'hang';
          }
          return SYNTH_OK({});
        },
      },
    });
    const started = Date.now();
    const timedOut = await h.client.synthesize({ interactSessionKey: 'k' }, 30);
    expect(timedOut).toMatchObject({ ok: false, kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(h.client.synthesize({ interactSessionKey: 'k' }, 1_000)).resolves.toMatchObject({ ok: true });
  });

  it('fails an in-flight call as bridge-exited with the stderr tail when the bridge dies', async () => {
    const h = await connected({ tools: { DeviceInteractionSynthesize: () => 'die' } });
    const result = await h.client.synthesize({ interactSessionKey: 'k' });
    expect(result).toMatchObject({ ok: false, kind: 'bridge-exited' });
    if (!result.ok) expect(result.message).toMatch(/code 3.*lost connection to Xcode/);
    expect(h.client.isAlive()).toBe(false);
    // Every later call fails fast, without writing to a dead child.
    await expect(h.client.endSession({ interactionSessionKey: 'k' })).resolves.toMatchObject({
      ok: false,
      kind: 'bridge-exited',
    });
  });

  it('classifies a bridge that dies saying it is not approved as not-approved', async () => {
    const h = await connected({ tools: { DeviceInteractionStartSession: () => 'hang' } });
    const pendingCall = h.client.startSession({ deviceIdentifier: 'u', sessionIdentifier: 's' });
    h.bridge.die("error: This agent isn't approved to use Xcode's tools yet\n");
    await expect(pendingCall).resolves.toMatchObject({ ok: false, kind: 'not-approved' });
  });

  it('reassembles split chunks, skips notifications, and answers a server ping', async () => {
    const h = await connected({ splitChunks: true, chatter: true });
    await expect(h.client.endSession({ interactionSessionKey: 'k' })).resolves.toEqual({
      ok: true,
      structured: { userMessage: 'Session stopped' },
    });
    expect(h.bridge.received).toContainEqual({ jsonrpc: '2.0', id: 'srv-1', result: {} });
  });

  it('routes concurrent calls by id, whatever order the replies arrive in', async () => {
    const h = await connected();
    const [a, b] = await Promise.all([
      h.client.startSession({ deviceIdentifier: 'u', sessionIdentifier: 'one' }),
      h.client.startSession({ deviceIdentifier: 'u', sessionIdentifier: 'two' }),
    ]);
    expect(a.ok && a.structured.interactionSessionKey).toBe('one');
    expect(b.ok && b.structured.interactionSessionKey).toBe('two');
  });

  it('abandons the bridge on a line over the byte bound', async () => {
    const h = await connected({ tools: { DeviceInteractionSynthesize: () => 'hang' } }, { maxLineBytes: 64 });
    const pendingCall = h.client.synthesize({ interactSessionKey: 'k' });
    h.bridge.emitLine('x'.repeat(200));
    await expect(pendingCall).resolves.toMatchObject({ ok: false, kind: 'protocol' });
    expect(h.bridge.signals).toContain('SIGKILL');
  });

  it('drops a non-JSON line without failing the pending call', async () => {
    const h = await connected();
    h.bridge.emitLine('warning: not json\n');
    await expect(h.client.endSession({ interactionSessionKey: 'k' })).resolves.toMatchObject({ ok: true });
  });
});

describe('close', () => {
  it('ends stdin and SIGTERMs; no SIGKILL when the bridge exits', async () => {
    const h = await connected();
    await h.client.close();
    expect(h.bridge.inputEnded).toBe(true);
    expect(h.bridge.signals).toEqual(['SIGTERM']);
    expect(h.client.isAlive()).toBe(false);
  });

  it('escalates to SIGKILL after the grace when SIGTERM is ignored', async () => {
    const h = await connected({ ignoreSigterm: true });
    await h.client.close();
    expect(h.bridge.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('is bounded even when the bridge ignores both signals', async () => {
    const h = await connected({ ignoreSigterm: true, ignoreSigkill: true });
    const started = Date.now();
    await h.client.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(h.client.isAlive()).toBe(false);
  });

  it('fails in-flight calls, is idempotent, and works before connect', async () => {
    const h = await connected({ tools: { DeviceInteractionSynthesize: () => 'hang' } });
    const pendingCall = h.client.synthesize({ interactSessionKey: 'k' });
    const [first, second] = [h.client.close(), h.client.close()];
    expect(first).toBe(second);
    await first;
    await expect(pendingCall).resolves.toMatchObject({ ok: false, kind: 'bridge-exited' });
    expect(h.bridge.signals).toEqual(['SIGTERM']);

    const never = harness();
    await never.client.close();
    await expect(never.client.connect()).resolves.toMatchObject({ ok: false, kind: 'bridge-exited' });
    expect(never.spawnCalls).toHaveLength(0);
  });
});

describe('session identifiers and logging hygiene', () => {
  it('mints a 128-bit Title Case identifier, unique per call', () => {
    const a = mintSessionIdentifier();
    const b = mintSessionIdentifier();
    expect(a).toMatch(/^Cyboflow Verify [0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('fingerprints a key one-way and deterministically', () => {
    const key = 'Cyboflow Verify 0123456789abcdef0123456789abcdef';
    expect(sessionKeyFingerprint(key)).toMatch(/^[0-9a-f]{12}$/);
    expect(sessionKeyFingerprint(key)).toBe(sessionKeyFingerprint(key));
    expect(key).not.toContain(sessionKeyFingerprint(key));
  });

  it('never logs the session key', async () => {
    const key = 'Cyboflow Verify ffffffffffffffffffffffffffffffff';
    const h = await connected({
      tools: {
        DeviceInteractionStartSession: START_OK,
        DeviceInteractionSynthesize: () => ({ toolError: 'Session not found' }),
        DeviceInteractionEndSession: END_OK,
      },
    });
    await h.client.startSession({ deviceIdentifier: 'u', sessionIdentifier: key });
    await h.client.synthesize({ interactSessionKey: key, interactionCommand: 't 1 2' });
    await h.client.endSession({ interactionSessionKey: key });
    await h.client.close();
    expect(h.logLines.length).toBeGreaterThan(0);
    expect(h.logLines.join('\n')).not.toContain('ffffffff');
  });
});

describe('nodeBridgeSpawn against a real child', () => {
  it('speaks argv-only stdio and delivers a reply written just before exit', async () => {
    // A two-message fake server: answers initialize, then answers the first
    // tools/call and exits immediately — the reply must still arrive.
    const script = [
      "const rl = require('readline').createInterface({ input: process.stdin });",
      "rl.on('line', (line) => {",
      '  const m = JSON.parse(line);',
      "  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, serverInfo: { name: 'fake', version: process.argv[1] } } }) + '\\n');",
      "  if (m.method === 'tools/call') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { structuredContent: { userMessage: 'bye' } } }) + '\\n', () => process.exit(0)); }",
      '});',
    ].join('\n');
    const spawn: BridgeSpawn = (_command, args, opts) =>
      // The client always passes ['mcpbridge']; forward it as the script's argv[1]
      // so the test proves the argv reached the child untouched.
      nodeBridgeSpawn(process.execPath, ['-e', script, ...args], opts);
    const client = createXcodeMcpBridgeClient({ spawn, killGraceMs: 500 });
    const handshake = await client.connect();
    expect(handshake).toMatchObject({ ok: true, structured: { serverName: 'fake', serverVersion: 'mcpbridge' } });
    await expect(client.endSession({ interactionSessionKey: 'k' })).resolves.toEqual({
      ok: true,
      structured: { userMessage: 'bye' },
    });
    await client.close();
    expect(client.isAlive()).toBe(false);
  }, 15_000);

  it('reports a binary that cannot be spawned as bridge-exited, and close() after it is a no-op', async () => {
    const client = createXcodeMcpBridgeClient({
      xcrunPath: '/nonexistent/cyboflow-test/xcrun',
      spawn: nodeBridgeSpawn,
      initTimeoutMs: 5_000,
      killGraceMs: 200,
    });
    const handshake = await client.connect();
    expect(handshake).toMatchObject({ ok: false, kind: 'bridge-exited' });
    if (!handshake.ok) expect(handshake.message).toMatch(/ENOENT/);
    expect(client.isAlive()).toBe(false);
    await expect(client.close()).resolves.toBeUndefined();
  }, 15_000);
});
