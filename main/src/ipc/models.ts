import { IpcMain } from 'electron';
import type { AppServices } from './types';
import { ModelAvailabilityService } from '../services/modelAvailabilityService';
import { getSharedOmpModelCatalogProbe } from '../services/panels/omp/ompModelCatalog';
import { detectPiAvailability } from '../services/panels/pi/piAvailability';
import { fetchPiModelCatalog } from '../services/panels/pi/piModelCatalog';
import type { ModelAvailabilityMap } from '../../../shared/types/modelAvailability';
import {
  AGENT_PROVIDERS,
  isAgentProvider,
  type AgentProvider,
} from '../../../shared/types/agentRuntime';
import type {
  CodexModelCatalog,
  ClaudeModelCatalog,
  ProviderModelCatalog,
  ProviderModelCatalogs,
} from '../../../shared/types/agentModels';

type CatalogResponse<C> = { success: true; data: C } | { success: false; error: string };

/** Fetches one provider's model catalog. Main-owned so renderer reloads and
 *  multiple picker mounts do not spawn redundant probes. */
type ProviderCatalogFetcher<P extends AgentProvider> = (
  services: AppServices,
) => Promise<ProviderModelCatalogs[P]>;

/**
 * The provider→catalog registry behind `models:get-catalog`. An exhaustive
 * `Record<AgentProvider, …>`, so a provider added to the union cannot ship
 * without a discovery path — the failure mode the two provider-named channels
 * below invited, where each picker had to learn a new channel by hand.
 */
const PROVIDER_CATALOG_FETCHERS: { [P in AgentProvider]: ProviderCatalogFetcher<P> } = {
  // Dynamic Claude catalog — the "Other models" section below the pinned four.
  claude: (services) => services.claudeModelCatalogService.getCatalog(),
  codex: (services) => services.codexSdkManager.getCodexModelCatalog(),
  // OMP's catalog comes from a short-lived `omp --mode rpc` child answering
  // `get_available_models`, projected to the canonical `${provider}/${id}` form
  // the model-family predicate rests on (see OmpModelOption). It hangs off the
  // shared probe rather than a service field because the catalog is a property of
  // the machine's `omp` install, not of any session: the picker can be opened in
  // Settings before an OMP session has ever been started. `OmpSdkManager` holds
  // the same instance so a mid-flight probe is reaped at shutdown.
  omp: () => getSharedOmpModelCatalogProbe().getCatalog(),
  // Pi's catalog comes from a short-lived `pi --list-models` child parsed
  // into canonical `${provider}/${id}` rows (see PiModelCatalog). It goes
  // through detectPiAvailability first so an absent/under-floor binary fails
  // with the same "why" copy the Integrations card shows, instead of a raw
  // spawn error.
  pi: async () => {
    const detection = await detectPiAvailability();
    if (detection.state !== 'detected' || !detection.binaryPath) {
      throw new Error(
        detection.version
          ? `pi ${detection.version} found but below the supported floor`
          : 'pi binary not found on PATH',
      );
    }
    return fetchPiModelCatalog(detection.binaryPath);
  },
};

async function fetchCatalog<P extends AgentProvider>(
  services: AppServices,
  provider: P,
): Promise<CatalogResponse<ProviderModelCatalogs[P]>> {
  try {
    return { success: true, data: await PROVIDER_CATALOG_FETCHERS[provider](services) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Model IPC exposes Claude guarded-model availability plus the per-provider
 * model catalogs.
 *
 * The availability map returns empty when the service isn't initialized (early
 * boot / tests) — every alias then reads as usable, the optimistic default.
 */
export function registerModelHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle(
    'models:get-availability',
    (): { success: true; data: ModelAvailabilityMap } => ({
      success: true,
      data: ModelAvailabilityService.tryGetInstance()?.snapshot() ?? {},
    }),
  );
  ipcMain.handle(
    'models:get-catalog',
    async (_event, provider: unknown): Promise<CatalogResponse<ProviderModelCatalog>> => {
      if (!isAgentProvider(provider)) {
        return {
          success: false,
          error: `Unknown agent provider "${String(provider)}" (expected one of ${AGENT_PROVIDERS.join(', ')}).`,
        };
      }
      return fetchCatalog(services, provider);
    },
  );
  // Provider-named delegates of the generic channel above, kept until every
  // caller flips. They share the registry, so they cannot drift from it.
  ipcMain.handle(
    'models:get-codex-catalog',
    (): Promise<CatalogResponse<CodexModelCatalog>> => fetchCatalog(services, 'codex'),
  );
  // getCatalog() never throws (a failed probe resolves to an empty list), but
  // the envelope is kept for parity with the Codex handler and belt-and-braces.
  ipcMain.handle(
    'models:get-claude-catalog',
    (): Promise<CatalogResponse<ClaudeModelCatalog>> => fetchCatalog(services, 'claude'),
  );
}
