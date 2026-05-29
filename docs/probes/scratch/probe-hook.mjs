// @ts-nocheck
/**
 * IDEA-013 PROBE hook (TASK-805) — Probes A, A2, C. THROWAWAY, not wired into the build.
 *
 * Wired by docs/probes/scratch/settings.json for BOTH PreToolUse and Stop. It:
 *   1. Logs every invocation (event, tool, session_id, transcript_path, cwd, inherited
 *      CYBOFLOW_ORCH_SOCKET, CLAUDE_PROJECT_DIR, CLAUDECODE, pid/ppid) to $PROBE_LOG.
 *   2. For PreToolUse, blocks/allows per $PROBE_MODE after sleeping $PROBE_BLOCK_SECONDS,
 *      exercising the exact contract S5's preToolUseShellHook.ts will rely on.
 *   3. For Stop (turn end), logs and exits 0 (does NOT force-continue) so Probe C can
 *      observe the PRIMARY turn-end signal + the transcript_path at end of turn.
 *
 * Env knobs (set before launching `claude`):
 *   PROBE_LOG             default /tmp/idea013-probe-hook.log
 *   PROBE_MODE            deny-json (default) | allow-json | ask-json | exit2 | precedence
 *   PROBE_BLOCK_SECONDS   default 0; set 180 to test the multi-minute synchronous block
 *
 * Contract (Claude Code hooks docs, confirmed 2026-05-29):
 *   - exit 2 BLOCKS and stderr is fed to the model; exit 2 TAKES PRECEDENCE over stdout JSON.
 *   - exit 0 + {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}} blocks.
 *   - stdin carries session_id, transcript_path, cwd, hook_event_name, permission_mode, tool_name, tool_input.
 */
import fs from 'node:fs';

const LOG = process.env.PROBE_LOG || '/tmp/idea013-probe-hook.log';
const MODE = process.env.PROBE_MODE || 'deny-json';
const BLOCK_SECONDS = Number.parseInt(process.env.PROBE_BLOCK_SECONDS || '0', 10) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function logLine(obj) {
  try {
    fs.appendFileSync(LOG, JSON.stringify(obj) + '\n');
  } catch {
    // best-effort; never throw out of the hook
  }
}

const main = async () => {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    input = { _parse_error: true, _raw: raw.slice(0, 500) };
  }

  const event = input.hook_event_name || 'unknown';
  const record = {
    ts: new Date().toISOString(),
    event,
    tool_name: input.tool_name ?? null,
    tool_input_keys: input.tool_input && typeof input.tool_input === 'object' ? Object.keys(input.tool_input) : null,
    session_id: input.session_id ?? null,
    transcript_path: input.transcript_path ?? null,
    cwd: input.cwd ?? null,
    permission_mode: input.permission_mode ?? null,
    parent_tool_use_id: input.parent_tool_use_id ?? null, // non-null often indicates a SUBAGENT tool call (Probe A2)
    // --- env-inheritance probes ---
    env_orch_socket: process.env.CYBOFLOW_ORCH_SOCKET ?? null, // Probe A(d): inherited from PTY env?
    claude_project_dir: process.env.CLAUDE_PROJECT_DIR ?? null,
    claudecode: process.env.CLAUDECODE ?? null,
    probe_mode: MODE,
    block_seconds: BLOCK_SECONDS,
    pid: process.pid,
    ppid: process.ppid,
  };

  // Stop (turn-end) — log only, do not force continue. Probe C PRIMARY signal.
  if (event !== 'PreToolUse') {
    logLine(record);
    process.exit(0);
  }

  // PreToolUse. Optionally hold to test the multi-minute synchronous block (Probe A(c)).
  if (BLOCK_SECONDS > 0) {
    logLine({ ...record, phase: 'block-start' });
    await sleep(BLOCK_SECONDS * 1000);
    logLine({ ...record, phase: 'block-end' });
  } else {
    logLine(record);
  }

  const deny = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'IDEA-013 probe deny',
    },
  };
  const allow = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'IDEA-013 probe allow',
    },
  };
  const ask = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: 'IDEA-013 probe ask',
    },
  };

  switch (MODE) {
    case 'allow-json':
      process.stdout.write(JSON.stringify(allow));
      process.exit(0);
      break;
    case 'ask-json':
      process.stdout.write(JSON.stringify(ask));
      process.exit(0);
      break;
    case 'exit2':
      process.stderr.write('IDEA-013 probe deny via exit 2\n');
      process.exit(2);
      break;
    case 'precedence':
      // Emit an ALLOW JSON AND exit 2. Per docs exit 2 should WIN (tool blocked).
      // If the tool RUNS, stdout JSON won — record whichever happens.
      process.stdout.write(JSON.stringify(allow));
      process.stderr.write('IDEA-013 probe precedence: allow-JSON + exit 2\n');
      process.exit(2);
      break;
    case 'deny-json':
    default:
      process.stdout.write(JSON.stringify(deny));
      process.exit(0);
      break;
  }
};

main().catch((err) => {
  logLine({ ts: new Date().toISOString(), event: 'hook-error', message: String(err) });
  // Fail CLOSED on internal error (deny), mirroring the production shell hook's posture.
  process.stderr.write('IDEA-013 probe hook internal error\n');
  process.exit(2);
});
