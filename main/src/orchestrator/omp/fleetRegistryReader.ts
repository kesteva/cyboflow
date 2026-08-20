/**
 * File-backed implementation of `OmpControlPlaneAdapter`.
 *
 * Reads the durable fleet registry (default `~/.omp/agent/fleet-registry.json`,
 * overridable via `OMP_FLEET_REGISTRY_PATH` or an explicit constructor path),
 * parses it through the versioned contract (`registryContract.ts`), and maps
 * the result onto the adapter surface (`shared/types/omp.ts`).
 *
 * Read-only by construction: this module only ever reads the registry file. It
 * exposes no mutators and cannot grow any without also widening the adapter
 * contract — which is deliberately separate and privileged.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  OmpControlPlaneAdapter,
  OmpSnapshotResult,
} from "../../../../shared/types/omp";
import { parseRegistrySnapshot, SUPPORTED_REGISTRY_VERSION } from "./registryContract";

const DEFAULT_REGISTRY_PATH = join(homedir(), ".omp", "agent", "fleet-registry.json");

/**
 * Resolve the default registry path, honoring the `OMP_FLEET_REGISTRY_PATH`
 * environment override. An empty or relative override is rejected (fail
 * closed: an ambiguous path must never silently read the wrong file). Matches
 * the producer's `resolveDefaultFleetRegistryPath`: `override !== undefined`
 * means even `""` is treated as an override and rejected for not being absolute.
 */
export function resolveDefaultFleetRegistryPath(): string {
  const override = process.env.OMP_FLEET_REGISTRY_PATH;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error(
        "OMP_FLEET_REGISTRY_PATH must be an absolute path (rejecting relative override)",
      );
    }
    return override;
  }
  return DEFAULT_REGISTRY_PATH;
}

/**
 * Read-only fleet-registry adapter. The constructor path (when supplied) must
 * be absolute; the default honors `OMP_FLEET_REGISTRY_PATH`.
 */
export class FleetRegistryReader implements OmpControlPlaneAdapter {
  readonly version = SUPPORTED_REGISTRY_VERSION;
  readonly authority = "read" as const;

  private readonly registryPath: string;

  constructor(registryPath?: string) {
    if (registryPath !== undefined) {
      if (!isAbsolute(registryPath)) {
        throw new Error(
          "FleetRegistryReader registryPath must be an absolute path (rejecting relative override)",
        );
      }
      this.registryPath = registryPath;
    } else {
      this.registryPath = resolveDefaultFleetRegistryPath();
    }
  }

  async getFleetSnapshot(): Promise<OmpSnapshotResult> {
    let text: string;
    try {
      text = readFileSync(this.registryPath, "utf8");
    } catch (error) {
      // Distinguish "never ran here" (ENOENT) from "can't read" (permission
      // denied, I/O error) — the two mean very different things to the UI.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ok: false,
          error: "missing",
          detail: `fleet registry not found: ${this.registryPath}`,
        };
      }
      return {
        ok: false,
        error: "unavailable",
        detail: `fleet registry not readable: ${this.registryPath}`,
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: "malformed",
        detail: `fleet registry is not valid JSON: ${this.registryPath}`,
      };
    }

    const parsed = parseRegistrySnapshot(data);
    if (parsed.ok) {
      return { ok: true, snapshot: parsed.snapshot };
    }
    if (parsed.reason === "unsupported-version") {
      return {
        ok: false,
        error: "unsupported-version",
        detail: `fleet registry version ${parsed.version} is not supported`,
      };
    }
    return {
      ok: false,
      error: "malformed",
      detail: `fleet registry is malformed: ${parsed.errors.join("; ")}`,
    };
  }
}
