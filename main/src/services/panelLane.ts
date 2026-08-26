/**
 * panelLane — the SINGLE answer to "which agent process owns THIS chat panel".
 *
 * A chat panel sits on two independent axes:
 *
 *   provider  — claude | codex | omp. Session-wide (`sessions.agent_runtime`); a
 *               panel cannot disagree with its session about which vendor runs it.
 *   substrate — sdk | interactive. PER-PANEL: the Add-chat picker and
 *               claude-panels:set-substrate stamp `panels.substrate`, which wins
 *               over the session's.
 *
 * The dispatch seams used to collapse both axes into one test against
 * `agent_runtime` — `=== 'codex-pty'` meant "Codex", `=== 'codex-sdk'` meant
 * "SDK". That reads the SESSION's substrate as if it were the PANEL's, so a
 * per-panel override could not be honored on the Codex side at all:
 *
 *   - in a codex-sdk session an interactive override fell to the CLAUDE PTY
 *     manager (the provider silently flipped mid-session), and
 *   - in a codex-pty session the `=== 'codex-pty'` test ran ahead of any
 *     substrate test, so an sdk override was ignored outright.
 *
 * Resolving the two axes separately and combining them at the END gives all four
 * lanes, so the picker means what it says in every session type. Callers switch
 * on the lane instead of re-deriving it — a new dispatch seam that forgets one
 * axis is the bug this module exists to prevent.
 */
import {
  AGENT_PROVIDERS,
  providerForRuntimeValue,
  substrateForRuntime,
  type AgentProvider,
} from '../../../shared/types/agentRuntime';
import { type CliSubstrate } from '../../../shared/types/substrate';
import { resolveSubstrate } from '../orchestrator/substrateResolver';

/**
 * The (provider × substrate) combinations, one manager each.
 *
 * The two `omp-*` lanes are DECLARED ahead of their managers so every dispatch
 * seam is taught about them in one place rather than discovered one at a time
 * later. They are unreachable today — no session can be created on an OMP
 * runtime (the provider defaults to disabled and both runtimes are unselectable
 * in every picker) — and nothing registers a manager for them, so a lane lookup
 * would hit `resolveLaneManager`'s loud miss rather than silently fall to Claude.
 * `OmpSdkManager` / `OmpPtyManager` register in Phase 1 (§5.1, §5.2).
 *
 * Kept as a literal tuple with the union derived FROM it (the shape
 * `AGENT_PROVIDERS` uses) so a caller that has to enumerate every lane — the
 * boot wiring, a test registering one manager per lane — reads the list rather
 * than rebuilding it and quietly omitting one.
 */
export const ALL_PANEL_LANES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
  'codex-pty',
  'omp-sdk',
  'omp-pty',
  'pi-sdk',
  'pi-pty',
] as const;

export type PanelLane = (typeof ALL_PANEL_LANES)[number];

/**
 * Each provider's two lanes, indexed by the panel's resolved substrate. A
 * Record so a provider added to the union cannot ship without someone naming
 * its lanes — the alternative (an if/else chain ending in a Claude return) is
 * exactly how an unregistered provider used to become a Claude panel.
 */
const PROVIDER_LANES: Readonly<
  Record<AgentProvider, Readonly<{ sdk: PanelLane; interactive: PanelLane }>>
> = {
  claude: { sdk: 'claude-sdk', interactive: 'claude-interactive' },
  codex: { sdk: 'codex-sdk', interactive: 'codex-pty' },
  omp: { sdk: 'omp-sdk', interactive: 'omp-pty' },
  pi: { sdk: 'pi-sdk', interactive: 'pi-pty' },
};

/** The lanes served by a PTY manager — each provider's interactive lane. */
const PTY_LANES: ReadonlySet<PanelLane> = new Set(
  AGENT_PROVIDERS.map((provider) => PROVIDER_LANES[provider].interactive),
);

/**
 * Runtimes that are interactive BY CONSTRUCTION: a PTY lane whose provider
 * carries no sdk/interactive substrate axis of its own (`substrateForRuntime`
 * returns null for them). Quick-session creation stamps `sessions.substrate` for
 * such a session, but an older row that never got the stamp would hit the
 * resolver's 'sdk' floor and resolve its own panels into an SDK lane, losing its
 * terminal — so the runtime supplies the value instead.
 *
 * `claude-interactive` is deliberately absent: it DOES carry a substrate of its
 * own, and treating it as implicitly interactive would flip every Claude session
 * whose substrate column is unset out of the SDK lane it resolves to today.
 */
const IMPLICITLY_INTERACTIVE_RUNTIMES: ReadonlySet<string> = new Set<string>(
  [...PTY_LANES].filter((lane) => substrateForRuntime(lane) === null),
);

/** Session columns the lane depends on (a DB session row satisfies this). */
export interface PanelLaneSession {
  agent_runtime?: string | null;
  substrate?: string | null;
}

/** Panel columns the lane depends on (a ToolPanel satisfies this). */
export interface PanelLanePanel {
  substrate?: CliSubstrate | null;
}

/**
 * Provider is session-wide, derived from the runtime-id prefix registry rather
 * than a local prefix test — a runtime this build does not know must not
 * silently resolve into the Claude lane. An absent column is a row that predates
 * the provider axis and keeps the Claude floor.
 */
export function providerForSession(session: PanelLaneSession | undefined): AgentProvider {
  return providerForRuntimeValue(session?.agent_runtime, 'providerForSession');
}

/**
 * The panel's EFFECTIVE substrate: a per-panel override beats the session's.
 *
 * `env: {}` — panel routing inherits only the session value, never the process
 * environment, so CYBOFLOW_SUBSTRATE cannot retroactively re-point existing
 * panels.
 *
 * A PTY-runtime session (codex-pty, omp-pty) is interactive BY CONSTRUCTION —
 * see {@link IMPLICITLY_INTERACTIVE_RUNTIMES} for why an absent
 * `sessions.substrate` must not fall to the resolver's 'sdk' floor there. Supply
 * 'interactive' as the session-level value in that case; a genuine per-panel
 * override still outranks it.
 */
export function substrateForPanel(
  session: PanelLaneSession | undefined,
  panel: PanelLanePanel | undefined,
): CliSubstrate {
  const implicitlyInteractive =
    session?.agent_runtime != null && IMPLICITLY_INTERACTIVE_RUNTIMES.has(session.agent_runtime);
  const sessionSubstrate = session?.substrate ?? (implicitlyInteractive ? 'interactive' : undefined);
  return resolveSubstrate({
    panelOverrideSubstrate: panel?.substrate ?? undefined,
    requestedSubstrate: sessionSubstrate,
    env: {},
  });
}

/** Combine the two axes into the lane that owns this panel. */
export function resolvePanelLane(
  session: PanelLaneSession | undefined,
  panel: PanelLanePanel | undefined,
): PanelLane {
  const lanes = PROVIDER_LANES[providerForSession(session)];
  return substrateForPanel(session, panel) === 'interactive' ? lanes.interactive : lanes.sdk;
}

/** True when the lane is served by a PTY manager rather than a structured one. */
export function isPtyLane(lane: PanelLane): boolean {
  return PTY_LANES.has(lane);
}

/** The six lanes owned by a dedicated per-provider manager (not Claude's two). */
export type NonClaudeLane = Exclude<PanelLane, 'claude-sdk' | 'claude-interactive'>;

/**
 * The manager owning a non-Claude lane's live process, from a bag of per-lane
 * owners; undefined for the two Claude lanes, whose close-out paths are
 * caller-specific (the interactive lane degrades to `killLiveSession` when its
 * manager is absent, and `claudeCodeManager.stopPanel` is the session-level
 * Stop that predates the interactive split).
 *
 * The `Record<NonClaudeLane, …>` argument is the point: each call site names
 * every non-Claude lane's owner explicitly, so a provider added to
 * `ALL_PANEL_LANES` fails to compile at every dispatch seam instead of quietly
 * falling into a switch's `default`.
 */
export function nonClaudeLaneOwner<M>(
  lane: PanelLane,
  owners: Readonly<Record<NonClaudeLane, M | undefined>>,
): M | undefined {
  switch (lane) {
    case 'codex-sdk':
    case 'codex-pty':
    case 'omp-sdk':
    case 'omp-pty':
    case 'pi-sdk':
    case 'pi-pty':
      return owners[lane];
    default:
      return undefined;
  }
}
