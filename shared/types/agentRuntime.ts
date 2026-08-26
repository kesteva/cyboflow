/**
 * Provider/runtime selection for Cyboflow agent sessions and workflow runs.
 *
 * This is intentionally separate from the legacy Claude-only CliSubstrate
 * (`'sdk' | 'interactive'`). Provider answers "which agent family?" while
 * runtime answers "which transport for that family?".
 *
 * Everything provider-specific in this module is derived from ONE table
 * ({@link AGENT_PROVIDER_TABLE}): the runtime-id prefix that identifies a
 * provider's transports, and what an absent access-map key means for it. A new
 * provider is an additive entry there plus its member in {@link AGENT_PROVIDERS}
 * — the registry is an exhaustive Record, so the compiler demands the pair.
 */

import type { CliSubstrate } from './substrate';

/**
 * Every provider, in declaration order. Kept as a literal tuple (not derived)
 * because `z.enum` needs a non-empty readonly tuple of string literals; the
 * `AgentProvider` union is derived FROM it so the two cannot drift.
 */
export const AGENT_PROVIDERS = ['claude', 'codex', 'omp', 'pi'] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/**
 * Every member of the `AgentRuntime` union, in declaration order. Unlike
 * SESSION_AGENT_RUNTIMES / WORKFLOW_* this is the FULL set — it exists for
 * validating a runtime read back off a user-editable surface (config.json),
 * where the surface itself is not scoped to one launch kind.
 *
 * `omp-fleet` is the fleet-supervisor runtime (Cyboflow supervises a running
 * OMP fleet through the bridge command adapter); `omp-sdk` and `omp-pty` are
 * OMP-as-a-runtime sessions (SDK and terminal panels). All three belong to the
 * `omp` provider via its `omp-` prefix.
 */
export const ALL_AGENT_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
  'codex-pty',
  'codex-exec',
  'omp-sdk',
  'omp-pty',
  'omp-fleet',
  'pi-sdk',
  'pi-pty',
] as const;

export type AgentRuntime = (typeof ALL_AGENT_RUNTIMES)[number];

/**
 * Every runtime a chat SESSION may run on. Stated as an exclusion because
 * `codex-exec` is the sole runtime with no session manager behind it — every
 * OMP runtime belongs here: `omp-sdk`/`omp-pty` are declared unreachable
 * through {@link AgentProviderDefinition.defaultEnabled} and the picker
 * capability rather than by being kept out of the union, and `omp-fleet` is
 * the fleet-supervisor session runtime (dispatched to the fleet session
 * manager, not a panel).
 */
export type SessionAgentRuntime = Exclude<AgentRuntime, 'codex-exec'>;

/**
 * What a `workflow_runs` row may CARRY — including the `__quick__` sentinel run
 * a quick session mints, whose provider/runtime the dispatch facade reads back
 * to pick a manager (`resolveManager(runId)`).
 *
 * Deliberately distinct from {@link WORKFLOW_LAUNCHABLE_RUNTIMES}: a runtime can
 * be storable (so a quick session keeps its identity on the sentinel row)
 * without yet being offered as a workflow launch target. `omp-sdk` was the one
 * divergence and joined the launchable set once its programmatic per-step
 * support landed; `omp-fleet` is the other — it mints sentinel rows for
 * quick-launch fleet sessions, but a fleet supervisor is never a per-step
 * workflow agent, so it stays out of the launchable set. The two sets answer
 * different questions and must stay separately stated: the next provider
 * declared ahead of its workflow lane lands here first and only here.
 */
export const WORKFLOW_RUN_STORABLE_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
  'omp-sdk',
  'omp-fleet',
  'pi-sdk',
] as const;

export type WorkflowRunStorableRuntime = (typeof WORKFLOW_RUN_STORABLE_RUNTIMES)[number];

/**
 * What the workflow pickers offer and `WorkflowRegistry.createRun` accepts for a
 * real (non-sentinel) run — i.e. the runtimes a workflow agent may deploy on.
 * `codex-pty` and `omp-pty` are excluded because workflows need structured
 * events/usage/MCP, which a TUI driven by keystrokes cannot supply; `omp-fleet`
 * is excluded for the same structural reason — it supervises a fleet as a whole
 * and has no per-step event stream.
 */
export const WORKFLOW_LAUNCHABLE_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
  'omp-sdk',
  // Structured JSON-events lane (pi --mode json): per-step events, usage and
  // tool results reach Cyboflow the same way the SDK lanes of claude/codex/omp
  // do, so workflows may deploy on it. pi-pty stays excluded for the same
  // keystroke-TUI reason as codex-pty/omp-pty.
  //
  // Gating note: an embedded tool_call extension enforces the session's
  // permission mode inside the child (read-only passes under default/
  // acceptEdits/auto; write-tier blocks with an actionable reason). What is
  // NOT built yet is an interactive approval prompt — dontAsk remains the
  // only way to run write-tier steps unattended.
  'pi-sdk',
] as const;

export type WorkflowLaunchableRuntime = (typeof WORKFLOW_LAUNCHABLE_RUNTIMES)[number];

/**
 * @deprecated Names the LAUNCHABLE set. Use {@link WORKFLOW_LAUNCHABLE_RUNTIMES}
 * for pickers/validation and {@link WORKFLOW_RUN_STORABLE_RUNTIMES} for what a
 * run row may carry — the two meanings this constant used to conflate.
 */
export const WORKFLOW_AGENT_RUNTIMES = WORKFLOW_LAUNCHABLE_RUNTIMES;

/**
 * Alias of {@link WorkflowLaunchableRuntime}. Not deprecated: the ~40 remaining
 * annotation sites all genuinely mean the launchable set, so a strikethrough on
 * every one would be noise that trains readers to ignore the marker. New code
 * should still prefer the explicit STORABLE/LAUNCHABLE names.
 */
export type WorkflowAgentRuntime = WorkflowLaunchableRuntime;

export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude';

/**
 * The runtime a PROVIDER-level choice resolves to — the structured (SDK) lane
 * of each provider, which is the one every launch surface can honour (workflow
 * runs included; the CLI runtimes are quick-session-only).
 *
 * Exists for surfaces that ask "which agent?" rather than "which transport?" —
 * today the onboarding Default-agent step, which writes the answer into
 * `AppConfig.defaultAgentRuntime`. `providerForRuntime` is the inverse and is
 * what seeds such a surface back off a persisted runtime.
 */
export const PROVIDER_DEFAULT_RUNTIME: Readonly<Record<AgentProvider, WorkflowLaunchableRuntime>> = {
  claude: 'claude-sdk',
  codex: 'codex-sdk',
  omp: 'omp-sdk',
  pi: 'pi-sdk',
};

export const DEFAULT_SESSION_AGENT_RUNTIME: SessionAgentRuntime = 'claude-sdk';
export const DEFAULT_WORKFLOW_AGENT_RUNTIME: WorkflowLaunchableRuntime = 'claude-sdk';

export const SESSION_AGENT_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
  'codex-pty',
  'omp-sdk',
  'omp-pty',
  'omp-fleet',
  'pi-sdk',
  'pi-pty',
] as const;

/** Human labels for the workflow-scoped runtime picker. Single source shared by
 * the step inspector and the global Agents-pane editor. */
export const WORKFLOW_AGENT_RUNTIME_LABELS: Record<WorkflowLaunchableRuntime, string> = {
  'claude-sdk': 'Claude SDK',
  'claude-interactive': 'Claude Interactive (CLI)',
  'codex-sdk': 'Codex SDK',
  'omp-sdk': 'OMP',
  'pi-sdk': 'Pi',
};

/**
 * Human labels for every SESSION runtime — THE single source every runtime
 * picker renders (`SubstrateSelector`, the Settings runtime list, the variant
 * editor), minus each surface's own scope suffix ("(default)" / "— quick
 * sessions only"). Exhaustive over `SessionAgentRuntime` — unlike
 * {@link WORKFLOW_AGENT_RUNTIME_LABELS}, which is scoped to the
 * workflow-launchable subset and uses shorter labels for the agent-config
 * editors — so the two terminal-driven runtimes (`codex-pty`, `omp-pty`) and
 * the fleet supervisor (`omp-fleet`) are covered too. Any summary echoing a
 * launched runtime (e.g. the wizard's launch-summary Runtime row) should read
 * this instead of hand-rolling a ternary that silently defaults an unhandled
 * runtime to the wrong label.
 *
 * "(CLI)" — never "(PTY)" — is the user-facing word for a terminal-driven
 * runtime. PTY is the transport's implementation name and stays in code
 * identifiers (`omp-pty`, `OmpPtyManager`); it is not vocabulary a user has to
 * learn to pick a runtime.
 */
export const AGENT_RUNTIME_LABELS: Record<SessionAgentRuntime, string> = {
  'claude-sdk': 'Claude SDK',
  'claude-interactive': 'Claude Interactive (CLI)',
  'codex-sdk': 'Codex SDK',
  'codex-pty': 'Codex (CLI)',
  'omp-sdk': 'OMP',
  'omp-pty': 'OMP (CLI)',
  'omp-fleet': 'OMP fleet',
  'pi-sdk': 'Pi',
  'pi-pty': 'Pi (CLI)',
};

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/** The static policy for one provider. */
export interface AgentProviderDefinition {
  /**
   * The runtime-id prefix that identifies this provider's transports. Runtime
   * ids follow `<provider>-<transport>`, and this prefix — not a hand-written
   * `startsWith` at each call site — is what maps a runtime back to its owner.
   */
  readonly runtimePrefix: string;
  /**
   * What an ABSENT {@link AgentProviderAccess} key means for this provider.
   * `claude`/`codex` keep the legacy absent⇒enabled floor so every config.json
   * written before the toggles existed behaves exactly as it did. A provider
   * introduced later must opt in at `false`: shipping it would otherwise switch
   * a brand-new vendor on for every existing install without anyone asking.
   */
  readonly defaultEnabled: boolean;
}

/**
 * The provider table the pure helpers below read. Parameterized over the
 * provider union so a test can exercise the policy (notably an absent⇒disabled
 * provider) against its own table without adding a provider to the shipped one.
 */
export interface AgentProviderTable<P extends string = AgentProvider> {
  readonly providers: readonly P[];
  readonly definitions: Readonly<Record<P, AgentProviderDefinition>>;
  /**
   * The provider forced back on when an access map AND the table's own defaults
   * would together leave nothing enabled — the last rung of the "never disable
   * everything" floor.
   */
  readonly fallbackProvider: P;
}

export const AGENT_PROVIDER_REGISTRY: Readonly<Record<AgentProvider, AgentProviderDefinition>> = {
  claude: { runtimePrefix: 'claude-', defaultEnabled: true },
  codex: { runtimePrefix: 'codex-', defaultEnabled: true },
  // OMP (oh-my-pi) — the first provider introduced AFTER the access toggles, so
  // it takes the absent⇒DISABLED policy this field exists for: every install
  // that has never seen the OMP card in Settings → Integrations keeps OMP off,
  // and nothing about a claude/codex user's app changes because the provider
  // was declared. This covers every omp- runtime, including the fleet
  // supervisor (`omp-fleet`) — the fleet status-bar indicator and the
  // fleet-session launch both respect the same toggle. See
  // `AgentProviderDefinition.defaultEnabled`.
  omp: { runtimePrefix: 'omp-', defaultEnabled: false },
  // Pi — the terminal coding agent OMP forked from, integrated natively
  // (spawned binary, no bridge). Post-toggle provider like omp: an absent
  // access key defaults DISABLED so installs that never touched Settings →
  // Integrations keep every `pi-` runtime off until an explicit opt-in.
  pi: { runtimePrefix: 'pi-', defaultEnabled: false },
};

/**
 * The vendor's own name, for anything a user reads — a panel tab, a run header,
 * a refusal sentence. Exhaustive over {@link AgentProvider}, replacing the
 * `provider === 'codex' ? 'Codex' : 'Claude'` ternaries that were copied across
 * six UI sites and the guard: each of those silently labels a third provider
 * "Claude", and a label is exactly the kind of miss no test notices.
 */
export const AGENT_PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  omp: 'OMP',
  pi: 'Pi',
};

export const AGENT_PROVIDER_TABLE: AgentProviderTable<AgentProvider> = {
  providers: AGENT_PROVIDERS,
  definitions: AGENT_PROVIDER_REGISTRY,
  fallbackProvider: DEFAULT_AGENT_PROVIDER,
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** True for a runtime a `workflow_runs` row (incl. the quick sentinel) may carry. */
export function isWorkflowRunStorableRuntime(value: unknown): value is WorkflowRunStorableRuntime {
  return (
    typeof value === 'string' &&
    (WORKFLOW_RUN_STORABLE_RUNTIMES as readonly string[]).includes(value)
  );
}

/** True for a runtime a workflow picker may offer / `createRun` may accept. */
export function isWorkflowLaunchableRuntime(value: unknown): value is WorkflowLaunchableRuntime {
  return (
    typeof value === 'string' && (WORKFLOW_LAUNCHABLE_RUNTIMES as readonly string[]).includes(value)
  );
}

/** @deprecated Alias of {@link isWorkflowLaunchableRuntime}. */
export function isWorkflowRuntimeSupported(value: unknown): value is WorkflowLaunchableRuntime {
  return isWorkflowLaunchableRuntime(value);
}

/** @deprecated Alias of {@link isWorkflowLaunchableRuntime}. */
export function isWorkflowAgentRuntime(value: unknown): value is WorkflowLaunchableRuntime {
  return isWorkflowLaunchableRuntime(value);
}

/**
 * True for ANY member of the AgentRuntime union (including 'codex-exec', which
 * neither of the launch-kind-scoped guards accepts). Use the scoped guards when
 * validating a value against a specific launch kind.
 */
export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === 'string' && (ALL_AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export function isSessionAgentRuntime(value: unknown): value is SessionAgentRuntime {
  return typeof value === 'string' && (SESSION_AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function claudeRuntimeFromSubstrate(
  substrate: CliSubstrate,
): Extract<WorkflowLaunchableRuntime, 'claude-sdk' | 'claude-interactive'> {
  return substrate === 'interactive' ? 'claude-interactive' : 'claude-sdk';
}

// ---------------------------------------------------------------------------
// Runtime → provider
// ---------------------------------------------------------------------------

/**
 * The provider owning `runtime` per `table`'s prefixes, or null when no prefix
 * matches. The pure core: every resolver below is this plus a failure policy.
 */
export function providerForRuntimeIn<P extends string>(
  table: AgentProviderTable<P>,
  runtime: string,
): P | null {
  for (const provider of table.providers) {
    if (runtime.startsWith(table.definitions[provider].runtimePrefix)) return provider;
  }
  return null;
}

/**
 * The failure policy for an unresolvable lookup anywhere on the agent-routing
 * path: throw where a developer or CI will see it, log and floor where the only
 * alternative is crashing a user's app. Shared so each seam gets the SAME two
 * arms — a runtime string with no registered prefix here, a PanelLane with no
 * registered manager in the dispatch facade — rather than re-deriving them.
 *
 * The discrimination is opt-IN on `development`/`test` rather than a
 * `!== 'production'` default because a packaged Electron app may leave NODE_ENV
 * unset (index.ts pairs it with `app.isPackaged` for exactly this reason), and
 * a bad persisted value must never take a user's app down. The literal
 * `process.env.NODE_ENV` token is what Vite statically replaces in the renderer
 * bundle, so it has to appear verbatim; the main process reads the live value.
 *
 * `fallback` must be a genuinely safe degradation, not a guess that hides the
 * miss — the logged message is the only signal production gets.
 */
export function failUnresolvable<T>(message: string, fallback: T): T {
  const env = process.env.NODE_ENV;
  if (env === 'development' || env === 'test') throw new Error(message);
  console.error(message);
  return fallback;
}

function resolveRuntimeProvider(runtime: string, context: string): AgentProvider {
  const provider = providerForRuntimeIn(AGENT_PROVIDER_TABLE, runtime);
  if (provider !== null) return provider;
  return failUnresolvable(
    `${context}: agent runtime "${runtime}" matches no registered provider prefix ` +
      `(${AGENT_PROVIDERS.map((p) => AGENT_PROVIDER_REGISTRY[p].runtimePrefix).join(', ')}). ` +
      `Register the provider in AGENT_PROVIDER_REGISTRY.`,
    DEFAULT_AGENT_PROVIDER,
  );
}

/** Derive the owning provider for an agent runtime. */
export function providerForRuntime(runtime: AgentRuntime): AgentProvider {
  return resolveRuntimeProvider(runtime, 'providerForRuntime');
}

/**
 * The provider for an UNTYPED runtime string — a DB column, an IPC payload, a
 * persisted config value. An absent/empty value is a row that predates the
 * provider axis, so it floors to the Claude default silently; a non-empty value
 * matching no provider is a genuine routing bug and fails loudly per
 * {@link throwsOnUnresolvableRuntime}.
 */
export function providerForRuntimeValue(
  runtime: string | null | undefined,
  context = 'providerForRuntimeValue',
): AgentProvider {
  if (!runtime) return DEFAULT_AGENT_PROVIDER;
  return resolveRuntimeProvider(runtime, context);
}

/**
 * The inverse of `claudeRuntimeFromSubstrate`: the substrate a runtime implies,
 * or `null` for a non-Claude runtime (Codex and OMP each name their transport in
 * the runtime id itself and carry no sdk/interactive substrate distinction).
 *
 * A caller that resolves runtime and substrate INDEPENDENTLY can otherwise emit
 * a contradictory pair — e.g. `agentRuntime: 'claude-interactive'` alongside a
 * substrate floored to `'sdk'` — which the launch path then has to arbitrate.
 */
export function substrateForRuntime(runtime: AgentRuntime): CliSubstrate | null {
  if (runtime === 'claude-interactive') return 'interactive';
  if (runtime === 'claude-sdk') return 'sdk';
  return null;
}

// ---------------------------------------------------------------------------
// provider × runtime consistency
// ---------------------------------------------------------------------------

/**
 * The mismatch between an explicitly requested provider and an explicitly
 * requested runtime, or null when the pair agrees (or either half is absent).
 *
 * Four launch seams — `WorkflowRegistry.createRun`, the `runs`/`experiments`
 * tRPC routers, and the quick-session IPC handler — each hand-wrote this as a
 * pair of `=== 'codex'` tests. They differ only in how they REPORT the conflict
 * (thrown Error / TRPCError / zod issue / `{success:false}`), so the decision
 * lives here and each site keeps its own reporting.
 */
export function providerRuntimeConflict(
  provider: AgentProvider | undefined,
  runtime: AgentRuntime | undefined,
): { provider: AgentProvider; runtime: AgentRuntime; expected: AgentProvider } | null {
  if (provider === undefined || runtime === undefined) return null;
  const expected = providerForRuntime(runtime);
  if (expected === provider) return null;
  return { provider, runtime, expected };
}

/** The canonical conflict sentence the throwing/rejecting seams report. */
export function formatProviderRuntimeConflict(
  provider: AgentProvider,
  runtime: AgentRuntime,
): string {
  return `agentProvider ${provider} conflicts with agentRuntime ${runtime}`;
}

/**
 * Throwing form of {@link providerRuntimeConflict}. `context` is prefixed to the
 * message so a seam keeps naming itself (e.g. `WorkflowRegistry.createRun`).
 */
export function assertProviderRuntimeConsistent(
  provider: AgentProvider | undefined,
  runtime: AgentRuntime | undefined,
  context?: string,
): void {
  const conflict = providerRuntimeConflict(provider, runtime);
  if (conflict === null) return;
  const sentence = formatProviderRuntimeConflict(conflict.provider, conflict.runtime);
  throw new Error(context ? `${context}: ${sentence}` : sentence);
}

// ---------------------------------------------------------------------------
// Provider access
// ---------------------------------------------------------------------------

/**
 * Per-provider access toggles — the user's answer to "may Cyboflow use this
 * agent account at all?", set in Settings → Integrations and in the onboarding
 * Connect step (both write the SAME `AppConfig.agentProviderAccess` field).
 *
 * An ABSENT member resolves through the provider's own
 * {@link AgentProviderDefinition.defaultEnabled}: `claude`/`codex` floor to
 * ENABLED, so existing config.json files stay byte-identical and every install
 * that never touched the toggles behaves exactly as before, while a provider
 * added later stays OFF until the user turns it on. A disabled provider is
 * removed from every runtime picker (SubstrateSelector / agent + variant
 * editors) and rejected at the launch seams (WorkflowRegistry.createRun, the
 * quick-session IPC handler), so it can never be reached by a stale payload or
 * an MCP-written agent config.
 *
 * At least one provider must stay enabled — the Settings UI refuses to turn off
 * the last one, mirroring onboarding's "enable at least one detected provider"
 * gate. `resolveAgentProviderAccess` re-applies that floor defensively for any
 * value read back off disk.
 */
export type AgentProviderAccess = Partial<Record<AgentProvider, boolean>>;

/** {@link isAgentProviderEnabled} against an arbitrary provider table. */
export function isProviderEnabledIn<P extends string>(
  table: AgentProviderTable<P>,
  access: Partial<Record<P, boolean>> | undefined,
  provider: P,
): boolean {
  return access?.[provider] ?? table.definitions[provider].defaultEnabled;
}

/** {@link enabledAgentProviders} against an arbitrary provider table. */
export function enabledProvidersIn<P extends string>(
  table: AgentProviderTable<P>,
  access: Partial<Record<P, boolean>> | undefined,
): P[] {
  return table.providers.filter((p) => isProviderEnabledIn(table, access, p));
}

/** {@link resolveAgentProviderAccess} against an arbitrary provider table. */
export function resolveProviderAccessIn<P extends string>(
  table: AgentProviderTable<P>,
  access: Partial<Record<P, boolean>> | undefined,
): Partial<Record<P, boolean>> {
  const materialize = (
    from: Partial<Record<P, boolean>> | undefined,
  ): Partial<Record<P, boolean>> => {
    const out: Partial<Record<P, boolean>> = {};
    for (const provider of table.providers) {
      out[provider] = isProviderEnabledIn(table, from, provider);
    }
    return out;
  };

  const resolved = materialize(access);
  if (table.providers.some((p) => resolved[p])) return resolved;
  // All-off would leave the app unable to launch anything: degrade to the
  // table's own defaults, and if those are themselves all-off (only reachable
  // for a table where no provider opts in) force the fallback provider on.
  const defaults = materialize(undefined);
  if (table.providers.some((p) => defaults[p])) return defaults;
  return { ...defaults, [table.fallbackProvider]: true };
}

/** True when `provider` may be used. Absent/unset ⇒ the provider's default. */
export function isAgentProviderEnabled(
  access: AgentProviderAccess | undefined,
  provider: AgentProvider,
): boolean {
  return isProviderEnabledIn(AGENT_PROVIDER_TABLE, access, provider);
}

/** True when `runtime`'s owning provider may be used. */
export function isRuntimeProviderEnabled(
  access: AgentProviderAccess | undefined,
  runtime: AgentRuntime,
): boolean {
  return isAgentProviderEnabled(access, providerForRuntime(runtime));
}

/** The providers currently usable, in AGENT_PROVIDERS order. */
export function enabledAgentProviders(access: AgentProviderAccess | undefined): AgentProvider[] {
  return enabledProvidersIn(AGENT_PROVIDER_TABLE, access);
}

/**
 * Normalize a persisted/IPC value into an access map with the "never disable
 * everything" floor applied. An all-off map would leave the app unable to
 * launch anything, so it degrades to the per-provider defaults rather than
 * bricking every launch seam.
 */
export function resolveAgentProviderAccess(
  access: AgentProviderAccess | undefined,
): AgentProviderAccess {
  return resolveProviderAccessIn(AGENT_PROVIDER_TABLE, access);
}

/**
 * Wire format for "you called a provider you switched off".
 *
 * The guard throws on the MAIN side but every IPC surface flattens an error to
 * a bare `error: string`, so the structured class is lost by the time the
 * renderer sees it. Rather than have the UI sniff prose (which breaks the
 * moment the copy is reworded), the message carries a stable machine prefix
 * that `parseAgentProviderDisabled` strips back off for display. A surface that
 * does not parse still shows a readable sentence, just with the code in front.
 */
export const AGENT_PROVIDER_DISABLED_CODE = 'ERR_AGENT_PROVIDER_DISABLED';

// Provider ids are bare identifiers, so they need no regex escaping.
const DISABLED_PATTERN = new RegExp(
  `^${AGENT_PROVIDER_DISABLED_CODE}\\[(${AGENT_PROVIDERS.join('|')})\\]:\\s*`,
);

/** Build the wire message: `ERR_AGENT_PROVIDER_DISABLED[claude]: <prose>`. */
export function formatAgentProviderDisabled(provider: AgentProvider, message: string): string {
  return `${AGENT_PROVIDER_DISABLED_CODE}[${provider}]: ${message}`;
}

/**
 * Recognize a provider-disabled failure anywhere in an error string (IPC may
 * wrap the thrown message in its own prefix), returning the provider and the
 * human sentence with the code removed. Null when it is an ordinary failure.
 */
export function parseAgentProviderDisabled(
  text: string | undefined | null,
): { provider: AgentProvider; message: string } | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(AGENT_PROVIDER_DISABLED_CODE);
  if (start === -1) return null;
  const tail = text.slice(start);
  const match = DISABLED_PATTERN.exec(tail);
  if (!match) return null;
  // The capture group is built from AGENT_PROVIDERS, so the guard only narrows.
  const provider = match[1];
  return {
    provider: isAgentProvider(provider) ? provider : DEFAULT_AGENT_PROVIDER,
    message: tail.slice(match[0].length).trim(),
  };
}

/** Structural validator for the untyped IPC config patch. */
export function isAgentProviderAccess(value: unknown): value is AgentProviderAccess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, member]) =>
      isAgentProvider(key) && (member === undefined || typeof member === 'boolean'),
  );
}

/**
 * The runtime a picker should fall back to when the current selection belongs
 * to a now-disabled provider. Returns null when `candidates` has no runtime on
 * an enabled provider (the caller then has nothing to offer).
 */
export function firstEnabledRuntime<T extends AgentRuntime>(
  access: AgentProviderAccess | undefined,
  candidates: readonly T[],
): T | null {
  return candidates.find((r) => isRuntimeProviderEnabled(access, r)) ?? null;
}

/**
 * Agent keys that always deploy on the Claude runtime, no matter what a
 * workflow's `agentConfigs` overlay / project override / variant delta says.
 * EMPTY today: `visual-verify` was removed from this set once the
 * verification agent gained a Codex runtime implementation
 * (`codexVerificationAgentQuery` — the runner dispatches on the resolved
 * provider). The machinery stays wired for a future key that genuinely can't
 * run on a non-Claude provider: the workflow editor (`AgentEditorForm.tsx` /
 * `WorkflowStepInspector.tsx`) renders "Always runs on Claude" instead of a
 * runtime select for a key in this set (UI communicates the invariant); the
 * deploy seam (`resolveStepAgent`) enforces it server-side by dropping a
 * non-Claude runtime pin with a logged warning — because `agentConfigs`
 * can also be written via the MCP workflow-config tools, bypassing the editor
 * entirely.
 */
export const CLAUDE_ONLY_AGENT_KEYS: ReadonlySet<string> = new Set<string>();

/** True when `key` must always resolve in the Claude provider namespace. */
export function isClaudeOnlyAgentKey(key: string): boolean {
  return CLAUDE_ONLY_AGENT_KEYS.has(key);
}
