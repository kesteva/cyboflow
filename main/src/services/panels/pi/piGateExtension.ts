/**
 * The cyboflow tool-call gate for pi — shipped as SOURCE and loaded inside
 * the spawned `pi` process via `-e <path>` (pi keeps explicitly-passed
 * extensions working even under `--no-extensions`, which is what makes the
 * lockdown pair and this gate coexist).
 *
 * WHY A POLICY GATE, NOT A HUMAN ROUND-TRIP (v1): a human verdict channel
 * needs the orchestrator-socket protocol OMP's 2.2k-line gate implements.
 * v1 ships the part that closes the actual hole — headless `pi-sdk`
 * workflow steps executing write-tier tools with nobody watching — by
 * enforcing cyboflow's permission mode INSIDE the child process, where it
 * cannot be skipped by CLI flags:
 *
 *   - `dontAsk`        → allow everything (the user explicitly chose yolo)
 *   - every other mode → read-only tools pass; anything else is BLOCKED
 *                        with an actionable reason
 *
 * Unknown tools are treated as write-tier (fail closed). The policy lives in
 * ONE place (`decideToolCall`) so tests pin it and the future human-in-the-
 * loop bridge replaces only that function's backend.
 *
 * SELF-CONTAINMENT CONTRACT: `decideToolCall.toString()` is embedded into
 * the generated extension, so the function must reference NOTHING outside
 * its own body (its lookup table lives inside). Tests import the generated
 * module end-to-end to pin that contract.
 */

import type { PermissionMode } from '../../../../../shared/types/workflows';

/** Env keys the gate reads. Kept in sync with what the manager spawns with. */
export const PI_GATE_ENV_KEYS = {
  mode: 'CYBOFLOW_GATE_MODE',
} as const;

export type PiGateMode = 'dontAsk' | 'gated';

export interface PiGateDecision {
  block: boolean;
  reason?: string;
}

/**
 * The whole policy, as one pure, SELF-CONTAINED function: `.toString()` of
 * this exact body is what ships inside the generated extension, so it must
 * not close over anything above.
 */
export function decideToolCall(mode: 'dontAsk' | 'gated', toolName: string): PiGateDecision {
  if (mode === 'dontAsk') {
    return { block: false };
  }
  // Tools that only ever READ are safe under any mode; everything else —
  // including unknown/extension tools — is treated as write-tier (fail closed).
  const READ_ONLY = new Set(['read', 'grep', 'glob', 'ls']);
  if (READ_ONLY.has(toolName)) {
    return { block: false };
  }
  return {
    block: true,
    reason:
      `Blocked by cyboflow: tool "${toolName}" can modify this worktree, and ` +
      'this session runs in gated mode. Switch the session permission mode to ' +
      '"dontAsk" (the session owner explicitly accepts unattended writes) or ' +
      'use the pi-pty runtime, where approvals happen inside the TUI.',
  };
}

/** Map a cyboflow PermissionMode onto the gate's two modes. */
export function piGateModeForMode(mode: PermissionMode): PiGateMode {
  return mode === 'dontAsk' ? 'dontAsk' : 'gated';
}

/**
 * The extension source spawntime writes to disk and loads via `-e`.
 * `decideToolCall.toString()` embeds the full policy body (self-contained by
 * contract above); `mode` arrives via the env key so the SAME written file
 * serves every session regardless of its permission mode.
 */
export const PI_GATE_EXTENSION_SOURCE = `
const decideToolCall = ${decideToolCall.toString()};

const MODE = process.env.${PI_GATE_ENV_KEYS.mode} === 'dontAsk' ? 'dontAsk' : 'gated';

export default function activate(pi) {
  pi.on("tool_call", async (event) => {
    const toolName = String(event.toolName ?? "");
    return decideToolCall(MODE, toolName);
  });
}
`;
