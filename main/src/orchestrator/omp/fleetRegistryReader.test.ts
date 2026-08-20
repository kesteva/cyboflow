/**
 * Unit tests for the OMP read adapter: the versioned parser and the file reader.
 *
 * Inline sanitized fixtures only — no test reads the live mutable
 * `~/.omp/agent/fleet-registry.json`. The parser is tested against in-memory
 * objects; the reader is tested against temp-dir files.
 */

import { describe, test, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistryParseResult } from "./registryContract";
import {
  parseRegistrySnapshot,
  SUPPORTED_REGISTRY_VERSION,
} from "./registryContract";
import {
  FleetRegistryReader,
  resolveDefaultFleetRegistryPath,
} from "./fleetRegistryReader";

/** Narrow a parser result to the `malformed` variant and return its errors. */
function malformedErrors(result: RegistryParseResult): string[] {
  if (result.ok) throw new Error("expected malformed result, got ok");
  if (result.reason !== "malformed") {
    throw new Error(`expected malformed result, got ${result.reason}`);
  }
  return result.errors;
}

/** Narrow a parser result to the `unsupported-version` variant and return its version. */
function unsupportedVersion(result: RegistryParseResult): number {
  if (result.ok) throw new Error("expected unsupported-version result, got ok");
  if (result.reason !== "unsupported-version") {
    throw new Error(`expected unsupported-version result, got ${result.reason}`);
  }
  return result.version;
}

function minimalWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wkr-test-1",
    paneId: "w1:p1",
    workspaceId: "ws-1",
    backend: "subprocess",
    model: "zai/glm-5.2:high",
    task: "edit files",
    label: "test",
    status: "working",
    spawnedAt: "2026-08-13T00:00:00.000Z",
    lastSeenAt: "2026-08-13T00:01:00.000Z",
    leaseExpiresAt: "2026-08-13T00:10:00.000Z",
    lastOutput: "working",
    ...overrides,
  };
}

function snapshot(workers: unknown[]): unknown {
  return {
    version: SUPPORTED_REGISTRY_VERSION,
    savedAt: "2026-08-13T00:02:00.000Z",
    workers,
  };
}

/** Create a temp dir, register it for cleanup, and return its path. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-reader-"));
  tempDirs.push(dir);
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseRegistrySnapshot", () => {
  test("accepts a valid snapshot", () => {
    const result = parseRegistrySnapshot(snapshot([minimalWorker()]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.version).toBe(SUPPORTED_REGISTRY_VERSION);
      expect(result.snapshot.workers).toHaveLength(1);
      expect(result.snapshot.workers[0].id).toBe("wkr-test-1");
    }
  });

  test("accepts unknown extra keys (forward-compatible)", () => {
    const worker = minimalWorker({ futureField: { nested: true } });
    expect(parseRegistrySnapshot(snapshot([worker])).ok).toBe(true);
  });

  test("refuses unsupported version before shape validation", () => {
    const result = parseRegistrySnapshot({
      version: 999,
      savedAt: "x",
      workers: [{ totally: "different" }],
    });
    expect(result.ok).toBe(false);
    expect(unsupportedVersion(result)).toBe(999);
  });

  test("refuses malformed top level", () => {
    expect(parseRegistrySnapshot(null)).toMatchObject({ ok: false, reason: "malformed" });
    expect(parseRegistrySnapshot({ version: "1", savedAt: "x", workers: [] }))
      .toMatchObject({ ok: false, reason: "malformed" });
    expect(parseRegistrySnapshot({ version: 1, workers: [] }))
      .toMatchObject({ ok: false, reason: "malformed" });
  });

  test("refuses a worker missing a required field, with path-qualified error", () => {
    const worker = minimalWorker();
    delete worker.id;
    const result = parseRegistrySnapshot(snapshot([worker]));
    expect(result.ok).toBe(false);
    expect(malformedErrors(result).some((e) => e.includes("workers[0].id"))).toBe(true);
  });

  test("refuses legacy backend missing-or-null (documented drift)", () => {
    const missing = minimalWorker();
    delete missing.backend;
    const missingResult = parseRegistrySnapshot(snapshot([missing]));
    expect(missingResult.ok).toBe(false);

    const nullBackend = minimalWorker({ backend: null });
    const nullResult = parseRegistrySnapshot(snapshot([nullBackend]));
    expect(nullResult.ok).toBe(false);
    expect(malformedErrors(nullResult).some((e) => e.includes("workers[0].backend"))).toBe(true);
  });

  test("one bad worker fails the whole snapshot (all-or-nothing)", () => {
    const result = parseRegistrySnapshot(snapshot([minimalWorker(), { bad: true }]));
    expect(result.ok).toBe(false);
  });
});

describe("resolveDefaultFleetRegistryPath", () => {
  const original = process.env.OMP_FLEET_REGISTRY_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.OMP_FLEET_REGISTRY_PATH;
    else process.env.OMP_FLEET_REGISTRY_PATH = original;
  });

  test("defaults to ~/.omp/agent/fleet-registry.json", () => {
    delete process.env.OMP_FLEET_REGISTRY_PATH;
    const path = resolveDefaultFleetRegistryPath();
    expect(path.endsWith(join(".omp", "agent", "fleet-registry.json"))).toBe(true);
  });

  test("honors an absolute override", () => {
    process.env.OMP_FLEET_REGISTRY_PATH = "/tmp/custom-fleet-registry.json";
    expect(resolveDefaultFleetRegistryPath()).toBe("/tmp/custom-fleet-registry.json");
  });

  test("rejects a relative override (fail closed)", () => {
    process.env.OMP_FLEET_REGISTRY_PATH = "relative/path.json";
    expect(() => resolveDefaultFleetRegistryPath()).toThrow(/absolute/);
  });

  test("rejects an empty override (fail closed)", () => {
    process.env.OMP_FLEET_REGISTRY_PATH = "";
    expect(() => resolveDefaultFleetRegistryPath()).toThrow(/absolute/);
  });
});

describe("FleetRegistryReader", () => {
  test("reads and validates a good registry file", async () => {
    const dir = tempDir();
    const path = join(dir, "fleet-registry.json");
    writeFileSync(path, JSON.stringify(snapshot([minimalWorker()])));

    const reader = new FleetRegistryReader(path);
    expect(reader.authority).toBe("read");
    const result = await reader.getFleetSnapshot();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.workers).toHaveLength(1);
    }
  });

  test("returns missing (ENOENT) for a missing file", async () => {
    const reader = new FleetRegistryReader(join(tempDir(), "missing.json"));
    const result = await reader.getFleetSnapshot();
    expect(result).toMatchObject({ ok: false, error: "missing" });
  });

  test("returns malformed for invalid JSON", async () => {
    const dir = tempDir();
    const path = join(dir, "fleet-registry.json");
    writeFileSync(path, "not json");

    const reader = new FleetRegistryReader(path);
    const result = await reader.getFleetSnapshot();
    expect(result).toMatchObject({ ok: false, error: "malformed" });
  });

  test("returns unsupported-version for a v999 file", async () => {
    const dir = tempDir();
    const path = join(dir, "fleet-registry.json");
    writeFileSync(path, JSON.stringify({ version: 999, savedAt: "x", workers: [] }));

    const reader = new FleetRegistryReader(path);
    const result = await reader.getFleetSnapshot();
    expect(result).toMatchObject({ ok: false, error: "unsupported-version" });
  });

  test("rejects a relative constructor path", () => {
    expect(() => new FleetRegistryReader("relative/path.json")).toThrow(/absolute/);
  });
});
