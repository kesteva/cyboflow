/**
 * First-run onboarding — shared contracts between main and renderer.
 *
 * The onboarding "Connect Claude Code" step is a LOGIN/CREDENTIAL probe, not a
 * binary-availability gate: the default SDK substrate bundles its own claude
 * binary (see docs/ARCHITECTURE.md — no external CLI is spawned), so the one
 * thing a fresh install genuinely needs is the user's Claude Code login. The
 * binary probe still matters for the opt-in interactive PTY substrate and for
 * the "installed · not logged in" variant.
 *
 * Plan/billing tier is intentionally ABSENT from this contract — nothing in
 * main/ can introspect it, and the onboarding UI must not claim it.
 */

/** Where the credential probe found evidence of a Claude Code login. */
export type ClaudeCredentialSource = 'keychain' | 'credentialsFile' | 'claudeConfig' | 'env';

export interface ClaudeCredentialDetection {
  found: boolean;
  /** Highest-priority signal that matched; null when not found. */
  source: ClaudeCredentialSource | null;
  /** Account label (e.g. email) when the source exposes one; never a secret. */
  account: string | null;
}

export interface ClaudeBinaryDetection {
  found: boolean;
  path: string | null;
  version: string | null;
}

/**
 * Overall step-1 state, computed main-side so every consumer agrees:
 * - 'detected'  — credentials found (SDK substrate is fully usable; binary
 *                 presence only annotates interactive-substrate readiness).
 * - 'loggedOut' — binary found but no credentials: installed, not logged in.
 * - 'missing'   — neither credentials nor binary found on this machine.
 */
export type ClaudeDetectionState = 'detected' | 'loggedOut' | 'missing';

export interface ClaudeDetectionResult {
  credentials: ClaudeCredentialDetection;
  binary: ClaudeBinaryDetection;
  state: ClaudeDetectionState;
}

/**
 * IPC channel for the on-demand probe. Idempotent and side-effect free — the
 * onboarding "Check again" button re-invokes the same channel. Response is
 * IPCResponse<ClaudeDetectionResult> (callers MUST pass the explicit T per the
 * IPC type-parity rules in docs/CODE-PATTERNS.md).
 */
export const CLAUDE_DETECT_CHANNEL = 'claude:detect';
