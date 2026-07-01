import { EventEmitter } from 'events';
import {
  GUARDED_MODELS,
  guardedModelByConcreteId,
  type GuardedModelSpec,
  type ModelAvailabilityEntry,
  type ModelAvailabilityMap,
  type ModelAvailabilityStatus,
} from '../../../shared/types/modelAvailability';

/**
 * ModelAvailabilityService — tracks whether the guarded models (currently Fable 5)
 * are usable, so the spawn seam can fall back to Opus and the pickers can grey a
 * pulled model out.
 *
 * A guarded model can lose availability at any time (Fable 5 has been pulled from
 * release before). Two signals feed the state:
 *   1. A best-effort Models-API probe ({@link refresh}) — runs at startup when an
 *      Anthropic credential is discoverable in the environment. Most cyboflow
 *      users authenticate the bundled Agent SDK via Claude Code's own login, so a
 *      probe often has no credential; it then stays OPTIMISTIC (leaves the guarded
 *      models `'unknown'`, i.e. usable) rather than guessing.
 *   2. Reactive marking ({@link markUnavailable}) — the claude spawn path calls
 *      this when an SDK query fails with a model-unavailability error, so the
 *      system self-corrects even with no probe credential: the first Fable run
 *      after it vanishes surfaces the error and marks it unavailable; every later
 *      run falls back to Opus and the picker greys it out.
 *
 * Non-guarded models are never tracked and always report usable — the historical
 * pass-through behavior.
 *
 * Singleton lifecycle mirrors DynamicWorkflowTracker (initialize / getInstance /
 * tryGetInstance / _resetForTesting) — the spawn managers, which may run before
 * initialize in tests, use {@link isModelUsable} (tryGetInstance-backed, defaults
 * to usable) and never throw.
 *
 * Emits `'changed'` with the full {@link ModelAvailabilityMap} whenever a guarded
 * model's status flips (the IPC layer forwards it to the renderer).
 */

interface LoggerLike {
  info?(message: string): void;
  warn?(message: string): void;
  debug?(message: string): void;
}

export interface ModelAvailabilityServiceOptions {
  logger?: LoggerLike;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** How long a single Models-API probe may run before it is abandoned. */
const PROBE_TIMEOUT_MS = 8000;

export class ModelAvailabilityService extends EventEmitter {
  private static instance: ModelAvailabilityService | null = null;

  private readonly entries = new Map<string, ModelAvailabilityEntry>();
  private readonly logger?: LoggerLike;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private constructor(opts?: ModelAvailabilityServiceOptions) {
    super();
    this.logger = opts?.logger;
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
    this.now = opts?.now ?? Date.now;
    for (const g of GUARDED_MODELS) {
      this.entries.set(g.concreteId, {
        concreteId: g.concreteId,
        status: 'unknown',
        reason: null,
        checkedAt: null,
      });
    }
  }

  static initialize(opts?: ModelAvailabilityServiceOptions): ModelAvailabilityService {
    ModelAvailabilityService.instance = new ModelAvailabilityService(opts);
    return ModelAvailabilityService.instance;
  }

  static getInstance(): ModelAvailabilityService {
    if (!ModelAvailabilityService.instance) {
      throw new Error(
        'ModelAvailabilityService has not been initialized. Call ModelAvailabilityService.initialize() from main/src/index.ts.',
      );
    }
    return ModelAvailabilityService.instance;
  }

  /** Null until initialized — callers that must not throw use this. */
  static tryGetInstance(): ModelAvailabilityService | null {
    return ModelAvailabilityService.instance;
  }

  /** Test-only: drop the singleton so the next initialize() starts clean. */
  static _resetForTesting(): void {
    ModelAvailabilityService.instance = null;
  }

  /**
   * Whether a resolved concrete model id is usable. Non-guarded ids are always
   * usable; a guarded id is usable unless explicitly marked `'unavailable'`
   * (`'unknown'` is optimistically usable). Accepts a `[1m]`-suffixed id.
   */
  isUsable(concreteId: string | null | undefined): boolean {
    const guarded = guardedModelByConcreteId(concreteId);
    if (!guarded) return true;
    return this.entries.get(guarded.concreteId)?.status !== 'unavailable';
  }

  /** A copy of every guarded model's current state (the IPC snapshot). */
  snapshot(): ModelAvailabilityMap {
    const out: ModelAvailabilityMap = {};
    for (const [id, entry] of this.entries) out[id] = { ...entry };
    return out;
  }

  /** Mark a guarded model unavailable (reactive spawn-failure path or a 404 probe). */
  markUnavailable(concreteId: string, reason?: string | null): void {
    this.setStatus(concreteId, 'unavailable', reason ?? null);
  }

  /** Mark a guarded model available (a successful probe). */
  markAvailable(concreteId: string): void {
    this.setStatus(concreteId, 'available', null);
  }

  private setStatus(
    concreteId: string,
    status: ModelAvailabilityStatus,
    reason: string | null,
  ): void {
    const guarded = guardedModelByConcreteId(concreteId);
    if (!guarded) return; // only guarded models are tracked
    const prev = this.entries.get(guarded.concreteId);
    const changed = !prev || prev.status !== status;
    this.entries.set(guarded.concreteId, {
      concreteId: guarded.concreteId,
      status,
      reason: status === 'unavailable' ? reason : null,
      checkedAt: this.now(),
    });
    if (changed) {
      if (status === 'unavailable') {
        this.logger?.warn?.(
          `[ModelAvailability] ${guarded.label} (${guarded.concreteId}) marked unavailable${reason ? `: ${reason}` : ''}; spawns will fall back to ${guarded.fallbackAlias}.`,
        );
      } else {
        this.logger?.info?.(`[ModelAvailability] ${guarded.label} (${guarded.concreteId}) marked ${status}.`);
      }
      this.emit('changed', this.snapshot());
    }
  }

  /**
   * Best-effort refresh of every guarded model's availability via the Anthropic
   * Models API. Skips silently (leaving state optimistic) when no credential is
   * discoverable or the network is unreachable — only a definitive 404/403 flips a
   * model to unavailable; transient errors (429/5xx/timeout) never do.
   */
  async refresh(): Promise<void> {
    const cred = resolveAnthropicCredential();
    if (!cred) {
      this.logger?.debug?.('[ModelAvailability] no Anthropic credential in env; skipping probe (optimistic).');
      return;
    }
    await Promise.all(GUARDED_MODELS.map((g) => this.probeOne(g, cred)));
  }

  private async probeOne(guarded: GuardedModelSpec, cred: AnthropicCredential): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${cred.baseUrl}/v1/models/${encodeURIComponent(guarded.concreteId)}`, {
        method: 'GET',
        headers: cred.headers,
        signal: controller.signal,
      });
      if (res.ok) {
        this.markAvailable(guarded.concreteId);
      } else if (res.status === 404) {
        // 404 = the model id doesn't exist at all (the "taken away" case). This is
        // org-independent, so it's safe to flip from the probe credential. A 403
        // (this credential's org lacks access) is deliberately NOT flipped: the
        // probe credential (env ANTHROPIC_API_KEY/AUTH_TOKEN) can differ from the
        // credential the runs actually use (the bundled Claude Code login), so a
        // per-org entitlement gap here could wrongly grey out a model the runtime
        // can use. The reactive spawn-error path — which uses the real runtime
        // credential — is authoritative for permission/403 cases.
        this.markUnavailable(guarded.concreteId, '404');
      } else {
        // 401/403/429/5xx — credential-specific or transient. Don't flip; stay
        // optimistic and let the reactive path decide with the runtime credential.
        this.logger?.debug?.(
          `[ModelAvailability] probe for ${guarded.concreteId} returned ${res.status}; leaving status unchanged.`,
        );
      }
    } catch (err) {
      // Network error / timeout / abort — leave state unchanged (optimistic).
      this.logger?.debug?.(
        `[ModelAvailability] probe for ${guarded.concreteId} failed (${err instanceof Error ? err.message : String(err)}); leaving status unchanged.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether a guarded concrete model id is usable, safe to call before the service
 * is initialized (defaults to usable). The claude spawn managers pass this to
 * `applyModelAvailabilityFallback`.
 */
export function isModelUsable(concreteId: string): boolean {
  return ModelAvailabilityService.tryGetInstance()?.isUsable(concreteId) ?? true;
}

/**
 * Heuristic: does an SDK query error message indicate the pinned MODEL was the
 * problem (not found / not available / no access), as opposed to an unrelated
 * runtime failure? Conservative — requires the word "model" plus an
 * unavailability signal, so an ordinary tool error never trips it.
 */
export function isModelUnavailableError(message: string): boolean {
  const m = message.toLowerCase();
  if (!m.includes('model')) return false;
  // The message already names the MODEL (gate above) AND the reactive caller only
  // invokes this when a guarded model was the one pinned, so the signal list can be
  // fairly permissive — a false positive just degrades gracefully to Opus.
  return (
    /not[\s_-]*found|does not exist|not available|unavailable|invalid[\s_-]*model|model[\s\S]*invalid|not_found_error|unsupported|access|permission|forbidden|deprecated|retired/.test(
      m,
    ) ||
    /\b404\b/.test(m) ||
    /\b403\b/.test(m)
  );
}

interface AnthropicCredential {
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * Resolve an Anthropic API credential from the environment for the Models-API
 * probe, or null when none is set. `ANTHROPIC_API_KEY` → `x-api-key`;
 * `ANTHROPIC_AUTH_TOKEN` (an OAuth access token) → `Authorization: Bearer` plus
 * the OAuth beta header. Most cyboflow users have neither (the bundled CLI holds
 * its own Claude Code login), so this commonly returns null and the probe is
 * skipped — reactive marking then carries the load.
 */
function resolveAnthropicCredential(): AnthropicCredential | null {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/+$/, '');
  const version: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return { baseUrl, headers: { 'x-api-key': apiKey, ...version } };
  }
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (authToken) {
    return {
      baseUrl,
      headers: { Authorization: `Bearer ${authToken}`, 'anthropic-beta': 'oauth-2025-04-20', ...version },
    };
  }
  return null;
}
