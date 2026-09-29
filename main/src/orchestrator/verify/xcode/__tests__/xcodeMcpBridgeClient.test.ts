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
import { describe, expect, it } from 'vitest';
import {
  createXcodeMcpBridgeClient,
  isDeviceMismatchMessage,
  isNotApprovedMessage,
  isSessionMissingMessage,
  mintSessionIdentifier,
  nodeBridgeSpawn,
  sessionKeyFingerprint,
  type BridgeSpawn,
  type XcodeMcpBridgeClientOptions,
} from '../xcodeMcpBridgeClient';
import {
  END_OK,
  FakeBridge,
  FIXTURE,
  recordingLogger,
  SCHEMAS,
  START_OK,
  SYNTH_OK,
  type FakeBridgeOptions,
} from './fakeMcpBridge';

interface Harness {
  bridge: FakeBridge;
  spawnCalls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>;
  logLines: string[];
  client: ReturnType<typeof createXcodeMcpBridgeClient>;
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
