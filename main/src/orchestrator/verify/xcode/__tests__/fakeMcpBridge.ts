/**
 * The fake `xcrun mcpbridge` child shared by the Stage 3 unit suites
 * (xcodeMcpBridgeClient.test.ts, xcodeDriveSession.test.ts).
 *
 * It speaks newline-delimited JSON-RPC over injected stdio and VALIDATES every
 * `tools/call` against the input schemas committed in
 * `fixtures/mcpbridge-tools-list.json` (the live `tools/list` dump from the B0
 * host, trimmed): an unknown tool, a missing required key, an extra key or a
 * mistyped value is refused the way a real tool refusal arrives (`isError` +
 * JSON error text). So a wrapper that sends `interactionSessionKey` to
 * Synthesize (which spells it `interactSessionKey`) fails whichever suite
 * drives it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XCODE_MCP_PROTOCOL_VERSION, type BridgeChild } from '../xcodeMcpBridgeClient';
import type { LoggerLike } from '../../../types';

interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string }>;
  required?: string[];
}

export interface ToolsFixture {
  toolNames: string[];
  tools: Array<{ name: string; inputSchema: JsonSchema; outputSchema: JsonSchema | null }>;
}

export const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mcpbridge-tools-list.json'), 'utf8'),
) as ToolsFixture;

export const SCHEMAS = new Map(FIXTURE.tools.map((tool) => [tool.name, tool.inputSchema]));

/** Validate arguments strictly against a committed input schema; `null` means valid. */
export function schemaViolation(tool: string, args: unknown): string | null {
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

export type ToolReply =
  | { structured: Record<string, unknown> }
  | { toolError: string; plain?: boolean }
  | { rpcError: string }
  | { contentOnly: string }
  | { raw: Record<string, unknown> }
  | 'hang'
  | 'die';

export type ToolScript = (args: Record<string, unknown>) => ToolReply;

export interface FakeBridgeOptions {
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

export const START_OK: ToolScript = (args) => ({
  structured: {
    interactionSessionKey: args.sessionIdentifier,
    deviceUUID: 'D473B910-328C-443D-93D8-B241052F57CD',
    deviceIsSimulator: true,
    skillToTrigger: 'device-interaction',
    summary: 'To interact with the session, you MUST spawn a SUBAGENT …',
  },
});

export const SYNTH_OK: ToolScript = () => ({
  structured: {
    applicationState: 'Running',
    hierarchyPath: '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-hierarchy.txt',
    logsPath: '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-logs.txt',
    screenshotPath: '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-screenshot.png',
    thumbnailScreenshotPath:
      '/var/folders/x/T/ActionArtifacts/default/DeviceInteractionSynthesize/k-thumbnailScreenshot.png',
  },
});

export const END_OK: ToolScript = () => ({ structured: { userMessage: 'Session stopped' } });

export class FakeBridge implements BridgeChild {
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
export function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ type: 'error', data: message }) }], isError: true };
}

export function recordingLogger(lines: string[]): LoggerLike {
  const record =
    (level: string) =>
    (message: string, context?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${JSON.stringify(context ?? {})}`);
    };
  return { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') };
}

