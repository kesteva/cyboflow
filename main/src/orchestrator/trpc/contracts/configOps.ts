/**
 * Narrow structural contract for the `config` tRPC router's business logic.
 *
 * This is the seam the pilot slice of the IPC→tRPC migration follows
 * (docs/CODE-PATTERNS.md): the router (routers/config.ts) does zod input
 * validation and delegates to this interface; the concrete implementation
 * (main/src/ipc/configOps.ts) wraps ConfigManager/ClaudeCodeManager and may
 * freely import from main/src/services/*. Declaring the interface here —
 * rather than importing the concrete factory — keeps the tRPC subtree's
 * standalone-typecheck invariant intact (no 'electron' or
 * 'main/src/services/**' imports; only main/src/types/* and shared/types/*
 * are allowed).
 *
 * Every method returns the SAME `{ success: true, data? } | { success:
 * false, error }` envelope the legacy `config:*` ipcMain.handle channels
 * returned, so frontend call sites keep their existing shape.
 */
import type { AppConfig, UpdateConfigRequest } from '../../../types/config';
import type { RunTypeDefaults, RunTypeDefaultsOp } from '../../../../../shared/types/sessionDefaults';

export type ConfigOpsResult<T = undefined> = T extends undefined
  ? { success: true } | { success: false; error: string }
  : { success: true; data: T } | { success: false; error: string };

export interface ConfigOpsLike {
  /** Mirrors legacy `config:get`. */
  getConfig(): Promise<ConfigOpsResult<AppConfig>>;
  /** Mirrors legacy `config:update`. */
  updateConfig(updates: UpdateConfigRequest): Promise<ConfigOpsResult>;
  /**
   * Mirrors legacy `config:apply-run-type-default`. The router validates
   * `key`/`op` with zod before calling this — this method assumes both are
   * already well-formed.
   */
  applyRunTypeDefault(
    key: string,
    op: RunTypeDefaultsOp,
  ): Promise<ConfigOpsResult<{ previous: RunTypeDefaults | undefined; config: AppConfig }>>;
}
