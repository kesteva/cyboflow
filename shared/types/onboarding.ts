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
 *
 * The probe is PROVIDER-KEYED, not provider-named: one
 * {@link PROVIDERS_DETECT_CHANNEL} channel takes the provider as an argument
 * and returns that provider's {@link ProviderDetectionResult}. What each
 * provider reports differs in kind — Claude's evidence is a credential store
 * plus an optional binary, Codex's is a bundled runtime plus a ChatGPT account —
 * so the payload is a per-provider lookup rather than one flattened shape, and
 * the state union is narrowed per provider too (Claude can be 'missing', Codex
 * 'unavailable'; neither can be the other's).
 */

import type { AgentProvider } from './agentRuntime';

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

/** Bundled Codex runtime metadata. No auth material is exposed to the renderer. */
export interface CodexRuntimeDetection {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** ChatGPT account metadata returned by account/read when authenticated. */
export interface CodexAccountDetection {
  found: boolean;
  email: string | null;
  planType: string | null;
}

/**
 * OMP's probe evidence. Deliberately thinner than the other two: OMP owns its
 * own provider credentials (`~/.omp`, env vars, its `/login` flow), so Cyboflow
 * has no account to introspect and must not claim one. What it CAN observe is
 * whether the user's `omp` binary is on this machine and what version it is —
 * both null when the discovery ladder finds nothing.
 */
export interface OmpBinaryDetection {
  binaryPath: string | null;
  version: string | null;
}

/**
 * Every state ANY provider's probe may report. The per-provider narrowing lives
 * in {@link ProviderDetectionStates}; this union exists so a surface that treats
 * the states uniformly (a status dot, a telemetry field) has one type to name.
 * - 'detected'    — usable: credentials/account found.
 * - 'loggedOut'   — installed/available but not signed in.
 * - 'missing'     — nothing found on this machine (Claude).
 * - 'unavailable' — not usable on this machine (Codex could not be verified; OMP
 *                   has no binary, or one whose version probe failed).
 */
export type ProviderDetectionState = 'detected' | 'loggedOut' | 'missing' | 'unavailable';

/**
 * The states each provider's probe can actually return.
 *
 * Claude's mapping is computed main-side so every consumer agrees:
 *   credentials.found            → 'detected'  (SDK substrate fully usable;
 *                                              binary presence only annotates
 *                                              interactive-substrate readiness)
 *   !credentials.found && binary → 'loggedOut' (installed, not logged in)
 *   neither                      → 'missing'
 *
 * OMP's is binary: there is no login for Cyboflow to observe (OMP holds its own
 * credentials), so the probe can only answer "is a usable binary here?" —
 * 'detected' when the ladder found one and its version probe succeeded,
 * 'unavailable' otherwise. No 'loggedOut': claiming it would assert something
 * about the user's OMP credentials that nothing in main/ can see.
 */
export interface ProviderDetectionStates {
  claude: 'detected' | 'loggedOut' | 'missing';
  codex: 'detected' | 'loggedOut' | 'unavailable';
  omp: 'detected' | 'unavailable';
  // Pi mirrors OMP exactly: pi holds its own credentials (`~/.pi`, `/login`),
  // so the only observable is binary presence + a successful `--version` at
  // or above the floor. No 'loggedOut': nothing in main/ can see pi's auth.
  pi: 'detected' | 'unavailable';
}

/** The evidence each provider's probe returns alongside its state. */
export interface ProviderDetectionPayloads {
  claude: {
    credentials: ClaudeCredentialDetection;
    binary: ClaudeBinaryDetection;
  };
  codex: {
    runtime: CodexRuntimeDetection;
    account: CodexAccountDetection;
  };
  omp: OmpBinaryDetection;
  // Structurally identical evidence (binaryPath + version), so pi reuses
  // OMP's shape rather than declaring a byte-for-byte twin interface. If the
  // two ever diverge (e.g. pi gains an observable login), split it then.
  pi: OmpBinaryDetection;
}

/**
 * Compile-time exhaustiveness: a provider added to {@link AgentProvider} without
 * an entry in BOTH maps above leaves a non-`never` residue, which violates the
 * `extends never` constraint and fails the build here rather than silently
 * shipping a provider whose probe result has no type.
 */
type AssertEveryProviderDescribed<T extends never> = T;
export type ProviderDetectionCoverage = AssertEveryProviderDescribed<
  Exclude<AgentProvider, keyof ProviderDetectionPayloads & keyof ProviderDetectionStates>
>;

/**
 * One provider's probe result: its own evidence plus its own narrowed state.
 * Left unparameterized it is the union across every provider.
 */
export type ProviderDetectionResult<P extends AgentProvider = AgentProvider> = {
  [K in P]: ProviderDetectionPayloads[K] & { state: ProviderDetectionStates[K] };
}[P];

/**
 * IPC channel for the on-demand probe, taking the provider as its one argument.
 * Idempotent and side-effect free — the onboarding "Check again" button and the
 * Settings recheck both re-invoke it. Response is
 * IPCResponse<ProviderDetectionResult<P>> (callers MUST pass the explicit T per
 * the IPC type-parity rules in docs/CODE-PATTERNS.md).
 */
export const PROVIDERS_DETECT_CHANNEL = 'providers:detect';

/** @deprecated Use {@link ProviderDetectionStates}['claude']. */
export type ClaudeDetectionState = ProviderDetectionStates['claude'];
/** @deprecated Use {@link ProviderDetectionResult}<'claude'>. */
export type ClaudeDetectionResult = ProviderDetectionResult<'claude'>;
/** @deprecated Use {@link ProviderDetectionStates}['codex']. */
export type CodexDetectionState = ProviderDetectionStates['codex'];
/** @deprecated Use {@link ProviderDetectionResult}<'codex'>. */
export type CodexDetectionResult = ProviderDetectionResult<'codex'>;

/**
 * @deprecated Provider-named delegate of {@link PROVIDERS_DETECT_CHANNEL}, kept
 * so a caller invoking the channel directly (rather than through the preload
 * bridge) keeps working. Registered as a thin forward to the generic handler.
 */
export const CLAUDE_DETECT_CHANNEL = 'claude:detect';

/** @deprecated Provider-named delegate — see {@link CLAUDE_DETECT_CHANNEL}. */
export const CODEX_DETECT_CHANNEL = 'codex:detect';
