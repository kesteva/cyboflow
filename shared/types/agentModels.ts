import { AGENT_PROVIDERS, type AgentProvider } from './agentRuntime';

export const CLAUDE_MODEL_ALIASES = [
  'fable',
  'opus',
  'opus-250k',
  'sonnet',
  'sonnet-250k',
  'haiku',
] as const;

export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/** Renderer-safe projection of one entry returned by Codex `model/list`. */
export interface CodexModelOption {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
}

export interface CodexModelCatalog {
  models: CodexModelOption[];
  defaultModel: string | null;
}

/**
 * Renderer-safe projection of one Agent-SDK `ModelInfo` row — the DYNAMIC Claude
 * catalog fetched via the bundled SDK's `supportedModels()` control request
 * (authenticated by the user's own Claude Code login, no API key). These populate
 * the "Other models" section BELOW the four curated/pinned families in the picker.
 */
export interface ClaudeModelOption {
  /** Model id to persist/spawn (`ModelInfo.value`). */
  id: string;
  /** Canonical wire id this row resolves to (`ModelInfo.resolvedModel`) — used to
   * de-dupe a dynamic row against the pinned families (e.g. `claude-opus-5`). */
  resolvedModel?: string;
  /** Human-readable label (`ModelInfo.displayName`). */
  label: string;
  /** Capability tagline (`ModelInfo.description`). */
  description: string;
}

export interface ClaudeModelCatalog {
  models: ClaudeModelOption[];
  defaultModel: string | null;
}

/**
 * Renderer-safe projection of one entry returned by OMP's RPC
 * `get_available_models`.
 *
 * The wire row keeps the two halves APART — `{ id: 'claude-3-5-sonnet-20240620',
 * name: 'Claude Sonnet 3.5', provider: 'anthropic', … }` (verified against omp
 * v17.3.2) — so its `id` alone is bare and indistinguishable from a first-party
 * Claude or Codex id. The projection therefore COMPOSES the canonical
 * `<provider>/<id>` form that OMP's own `--model` / `set_model` accepts, and
 * that composed value is the only one Cyboflow ever persists. Everything
 * downstream (the family predicate, the launch seams) rests on that invariant.
 *
 * `ompProvider` is kept alongside rather than re-split from the id, because the
 * picker groups by vendor and the wire already answers that question.
 */
export interface OmpModelOption {
  /** Canonical `<ompProvider>/<wire id>` — what gets persisted and spawned. */
  id: string;
  /** The row's own display name. */
  label: string;
  /** The row's `provider` field (e.g. 'anthropic'), for grouping. */
  ompProvider: string;
}

/**
 * No `defaultModel`: OMP's RPC advertises no default among the models it lists,
 * and inventing one here would put a value in the picker that nothing on the
 * spawn side honors.
 */
export interface OmpModelCatalog {
  models: OmpModelOption[];
}

/**
 * Pi fronts many vendors the same way OMP does (`pi --model provider/id`),
 * so a Pi selection is the same slashed `provider/model` pair with the same
 * bare-wire-id caveat. The catalog shape is therefore OMP's: rows compose the
 * canonical selection from separate `provider` and `id` fields.
 */
export interface PiModelCatalog {
  models: OmpModelOption[];
}

/**
 * Which catalog shape each provider advertises.
 *
 * The three are deliberately NOT flattened into one type: a Codex row carries
 * the runtime's own `isDefault` flag (there is no pinned alias list to compare
 * it against), a Claude row carries `resolvedModel` so a dynamic entry can be
 * de-duped against the four pinned families, and an OMP row carries the vendor
 * prefix its picker groups by. Keying them instead of merging them keeps each
 * provider's discovery honest while giving the catalog IPC + store ONE
 * provider-parameterized surface.
 */
export interface ProviderModelCatalogs {
  claude: ClaudeModelCatalog;
  codex: CodexModelCatalog;
  omp: OmpModelCatalog;
  pi: PiModelCatalog;
}

/**
 * Compile-time exhaustiveness: a provider added without a catalog shape leaves
 * a non-`never` residue and fails the build here.
 */
type AssertEveryProviderHasCatalog<T extends never> = T;
export type ProviderModelCatalogCoverage = AssertEveryProviderHasCatalog<
  Exclude<AgentProvider, keyof ProviderModelCatalogs>
>;

/** The catalog `provider` advertises; unparameterized it is the union. */
export type ProviderModelCatalog<P extends AgentProvider = AgentProvider> =
  ProviderModelCatalogs[P];

const CLAUDE_MODEL_ALIAS_SET = new Set<string>(CLAUDE_MODEL_ALIASES);

export function isClaudeModelFamily(model: string): boolean {
  const key = model.toLowerCase().trim();
  return CLAUDE_MODEL_ALIAS_SET.has(key) || key.startsWith('claude-');
}

export function isCodexModelFamily(model: string): boolean {
  const key = model.toLowerCase().trim();
  return key.startsWith('gpt-') || key.startsWith('codex-') || /^o[1-9](?:-|$)/.test(key);
}

/**
 * OMP fronts many vendors, so an OMP selection is a `provider/model` pair
 * (`anthropic/claude-3-5-sonnet-20240620`, `openai/gpt-5.4`). The SLASH is the
 * whole discriminator: no Claude id or alias contains one (`CLAUDE_MODEL_ALIASES`
 * are bare words, wire ids are `claude-*`), and no Codex id does either (`gpt-*`,
 * `codex-*`, `o1`..`o9`).
 *
 * THE INVARIANT THIS RESTS ON: Cyboflow persists OMP selections only in that
 * canonical slashed form — `OmpModelOption` composes it from the catalog row's
 * separate `provider` and `id` fields, because the wire `id` is BARE. A bare id
 * off the wire is therefore never an OMP selection as far as this predicate is
 * concerned, which is what it must mean: OMP's `anthropic/claude-3-5-sonnet-…`
 * and Claude's own `claude-3-5-sonnet-…` would otherwise be the same string,
 * and `normalizeAgentModelSelection` could not tell a stale cross-provider
 * carry-over from a legitimate one. A projection that ever wrote the bare id
 * would break both providers' normalization, not just OMP's.
 *
 * A bare `provider/` or `/model` names nothing, so both halves must be non-empty.
 */
export function isOmpModelFamily(model: string): boolean {
  const key = model.toLowerCase().trim();
  const slash = key.indexOf('/');
  return slash > 0 && slash < key.length - 1;
}


export function isCodexModelSelection(model: string): boolean {
  const key = model.toLowerCase().trim();
  return key === 'auto' || key === 'default' || isCodexModelFamily(key);
}

/**
 * The Codex-family model to fall back to when a Claude-family value would
 * otherwise be paired with a Codex runtime. `'auto'` lets Codex pick, so it is
 * safe wherever a concrete model is not required.
 *
 * Declared here rather than in the renderer's ModelSelector (which re-exports
 * it) so the non-UI launch seams can reach it without a hook importing from a
 * component.
 */
export const DEFAULT_CODEX_MODEL = 'auto';

/**
 * Which provider owns a model id, one predicate per provider. Adding a provider
 * is one entry here (the Record is exhaustive over `AgentProvider`, so the
 * compiler demands it) rather than another arm in a cross-provider if/else.
 *
 * Predicates take the already-lowercased, already-trimmed id; each is
 * independently idempotent under lowercasing so they stay callable directly.
 */
export const AGENT_MODEL_FAMILY_PREDICATES: Readonly<
  Record<AgentProvider, (key: string) => boolean>
> = {
  claude: isClaudeModelFamily,
  codex: isCodexModelFamily,
  omp: isOmpModelFamily,
  // Pi model ids are `<vendor>/<model>` — pi's own discriminator in `--model`
  // patterns — which is exactly OMP's slash rule, so the predicate is shared.
  // If pi ever admits bare ids this becomes its own function.
  pi: isOmpModelFamily,
};
/**
 * Families that SHARE a shape are non-competing: omp and pi both use
 * `<vendor>/<model>`, so a slashed id claimed by one must not be dropped
 * because the other also claims it. Without this pair, adding pi made
 * `normalizeAgentModelSelection('omp', 'anthropic/x')` return undefined.
 */
const COMPATIBLE_FAMILIES: ReadonlyArray<readonly [AgentProvider, AgentProvider]> = [
  ['omp', 'pi'],
];

function familiesCompatible(a: AgentProvider, b: AgentProvider): boolean {
  return COMPATIBLE_FAMILIES.some(
    ([x, y]) => (a === x && b === y) || (a === y && b === x),
  );
}


/**
 * Normalize a persisted picker value against the provider that owns it.
 *
 * This preserves valid user-facing aliases such as `opus`, `sonnet`, and `gpt-*`
 * while dropping stale cross-provider values that can remain after changing a
 * session/workflow runtime. `default` is treated as no explicit selection; `auto`
 * is preserved because existing UI/read-model paths may display it even though
 * spawn seams omit the model flag for it.
 *
 * The rule is "drop a value another provider's family claims", not "keep only
 * what this provider's family claims" — an id no predicate recognizes (a raw
 * catalogue id, `auto`) belongs to whoever is asking and is preserved.
 */
export function normalizeAgentModelSelection(
  provider: AgentProvider,
  model?: string | null,
): string | undefined {
  const value = model?.trim();
  if (!value) return undefined;

  const key = value.toLowerCase();
  if (key === 'default') return undefined;

  for (const other of AGENT_PROVIDERS) {
    if (other === provider) continue;
    if (familiesCompatible(provider, other)) continue;
    if (AGENT_MODEL_FAMILY_PREDICATES[other](key)) return undefined;
  }
  return value;
}
