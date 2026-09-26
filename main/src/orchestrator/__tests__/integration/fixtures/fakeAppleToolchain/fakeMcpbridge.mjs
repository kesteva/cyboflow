// Fake `xcrun mcpbridge` for mobileVerificationXcode.itest.ts
// (docs/proposals/runbook-optional-verification.md §B7).
//
// The `xcrun` shim's `mcpbridge)` arm execs this with node. It speaks the
// measured wire shape — newline-delimited JSON-RPC over stdio, tool results in
// `structuredContent`, tool failures as `isError` + `{"type":"error","data":…}`
// text — for the three DeviceInteraction tools the runner uses, and nothing
// else. Every tools/call is appended to $FAKE_APPLE_STATE/mcpbridge-calls as one
// JSON line so the suite can assert order and argument keys.
//
// MODE comes from $FAKE_APPLE_STATE/mcpbridge-mode (default `ok`):
//   ok               — a healthy session;
//   approval-refused — StartSession answers "This agent isn't approved…";
//   device-mismatch  — StartSession binds a different device;
//   pid-change       — the app's block reports a pid the launch never pinned;
//   block-missing    — the hierarchy carries no block for the app under test;
//   bridge-killed    — the bridge dies on its first Synthesize.
//
// A Synthesize writes a real screenshot (a copy of $FAKE_APPLE_STATE/frame.png)
// and a real hierarchy file into $FAKE_APPLE_STATE/mcpbridge-out/.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const STATE = process.env.FAKE_APPLE_STATE;
if (!STATE) {
  process.stderr.write('fake mcpbridge: FAKE_APPLE_STATE is not set\n');
  process.exit(64);
}
const read = (name, fallback) => {
  const file = join(STATE, name);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : fallback;
};
const MODE = read('mcpbridge-mode', 'ok');
const BUNDLE = read('bundle-id', 'com.cyboflow.fakeapp');
const OUT = join(STATE, 'mcpbridge-out');
mkdirSync(OUT, { recursive: true });

let udid = null;
let seq = 0;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, structured) =>
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } });
const toolError = (id, message) =>
  send({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: JSON.stringify({ type: 'error', data: message }) }], isError: true },
  });

/** The pid `simctl launch` recorded for the leased device, when there is one. */
function launchedPid() {
  const raw = udid === null ? '' : read(join('pids', udid), '');
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function hierarchy() {
  const lines = ['Device orientation: Unknown', '------------------------'];
  const pid = launchedPid();
  if (MODE === 'block-missing' || pid === null) {
    lines.push(
      'Application bundle identifier: com.apple.springboard',
      'Application UI orientation: Portrait',
      "Application, pid: 55, label: ' '",
      ' Window, {{0.0, 0.0}, {402.0, 874.0}}, hitPoint: {201.0, 437.0}',
    );
  } else {
    const shown = MODE === 'pid-change' ? pid + 100000 : pid;
    lines.push(
      `Application bundle identifier: ${BUNDLE}`,
      'Application UI orientation: Portrait',
      `Application, pid: ${shown}, label: 'FakeApp'`,
      ' Window, {{0.0, 0.0}, {402.0, 874.0}}, hitPoint: {201.0, 437.0}',
      "  Button, {{16.0, 380.3}, {370.0, 52.0}}, identifier: 'settings', label: 'Settings', hitPoint: {201.0, 406.3}",
    );
  }
  return `${lines.join('\n')}\n`;
}

function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'xcode-tools', version: 'fake' } },
    });
    return;
  }
  if (method !== 'tools/call') return;
  const { name, arguments: args } = params;
  appendFileSync(join(STATE, 'mcpbridge-calls'), `${JSON.stringify({ name, args })}\n`);
  switch (name) {
    case 'DeviceInteractionStartSession':
      if (MODE === 'approval-refused') {
        toolError(id, "This agent isn't approved to use Xcode's tools yet");
        return;
      }
      udid = args.deviceIdentifier;
      result(id, {
        interactionSessionKey: args.sessionIdentifier,
        deviceUUID: MODE === 'device-mismatch' ? 'FFFFFFFF-0000-4000-8000-000000000000' : args.deviceIdentifier,
        deviceIsSimulator: true,
        skillToTrigger: 'device-interaction',
        summary: 'fake session',
      });
      return;
    case 'DeviceInteractionSynthesize': {
      if (MODE === 'bridge-killed') {
        process.stderr.write('mcpbridge: lost connection to Xcode\n');
        process.exit(3);
      }
      seq += 1;
      const shot = join(OUT, `${seq}-screenshot.png`);
      const hier = join(OUT, `${seq}-hierarchy.txt`);
      const logs = join(OUT, `${seq}-logs.txt`);
      copyFileSync(join(STATE, 'frame.png'), shot);
      writeFileSync(hier, hierarchy());
      writeFileSync(logs, 'FakeApp: console\n');
      result(id, {
        applicationState: 'NotRun',
        screenshotPath: shot,
        thumbnailScreenshotPath: shot,
        hierarchyPath: hier,
        logsPath: logs,
      });
      return;
    }
    case 'DeviceInteractionEndSession':
      result(id, { userMessage: 'Session stopped' });
      return;
    default:
      toolError(id, `fake mcpbridge: unsupported tool ${name}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
