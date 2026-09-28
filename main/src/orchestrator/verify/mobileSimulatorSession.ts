/**
 * mobileSimulatorSession — the per-request iOS Simulator for the `mobile`
 * verification modality (docs/proposals/mobile-verification-tier.md §8).
 *
 * THE ISOLATION RULE: a mobile verification never runs on a leased developer
 * device. Such a device inherits settings, keychain entries, granted
 * permissions and unrelated apps, and "a verification that inherits state is a
 * verification whose failures are unreproducible". Every request therefore
 * CREATES its own `cyboflow-verify-<requestId>` simulator, boots it, and
 * destroys it in teardown. That also closes the empty-candidate-list deadlock
 * structurally: there is no persisted UDID list that can be empty.
 *
 * PURE-ISH MODULE — no `electron`, no `better-sqlite3`, no `child_process`.
 * Every `xcrun`/`simctl`/`ps` invocation goes through the INJECTED
 * {@link AppleCliExec} seam so the whole lifecycle is unit-testable with a fake
 * exec: no real device is ever created by the suite. `node:fs/promises` is
 * imported only to build the DEFAULT filesystem adapter; tests inject their own.
 *
 * ARGV DISCIPLINE: every command is an ARGV ARRAY — there is no shell string
 * anywhere in this file, so a device name or data dir carrying a space or a
 * quote cannot become a second command. And every argv that names a device
 * names ONLY the udid this session created (the suite pins that invariant).
 *
 * TWO TEARDOWN LAYERS, because one is not enough:
 *  - {@link MobileSimulatorHandle.dispose} is the normal path, driven from the
 *    runner's `finally`. Best-effort and NEVER throwing: a teardown that threw
 *    would mask the verdict it is tearing down.
 *  - {@link MobileSimulatorSessionFactory.sweepStaleSimulators} is the hard-kill
 *    path, run once at boot. A SIGKILLed cyboflow leaves a booted simulator and
 *    1-5 GB of DerivedData behind, and nothing else will ever reclaim them.
 *
 * WHY THE SWEEP IS OWNER-MARKED RATHER THAN NAME-MATCHED: two cyboflow
 * instances (different `CYBOFLOW_DIR`s, e.g. a dev build beside the packaged
 * app) can both be running mobile verifications, and both name their devices
 * `cyboflow-verify-*`. Deleting by name alone would let one instance destroy a
 * live request belonging to the other. Each request therefore drops an
 * `owner.json` marker under ITS OWN data dir naming the owning pid AND that
 * pid's start time; the sweep deletes only what a PROVABLY DEAD owner left, and
 * a `cyboflow-verify-*` device with no marker under this data dir is logged and
 * LEFT ALONE.
 */
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { LoggerLike } from '../types';

/** One completed child-process invocation. */
export interface AppleCliExecResult {
  stdout: string;
  stderr: string;
  /** Exit code, or `null` when the child was killed by a signal. */
  code: number | null;
}

/**
 * The narrow, INJECTED transport over the Apple command-line tools (`xcrun`,
 * `xcodebuild`, `ps`, and — via {@link XcodeToolchainBackend} — `maestro`).
 *
 * CONTRACT, and the whole reason the two callers can tell "absent" from
 * "could not ask" apart:
 *  - a command that RAN resolves, whatever its exit code — a non-zero exit is
 *    DATA (affirmative evidence the tool answered "no"), not an exception;
 *  - a command that could not run at all — spawn error, timeout, killed —
 *    REJECTS.
 *
 * Implementations MUST pass `args` as an argv array (never a shell string) and
 * MUST honour `timeoutMs`. `env`, when given, is the child's COMPLETE
 * environment (callers pass a full env, never a delta); absent, the child
 * inherits the host's.
 */
export type AppleCliExec = (
  command: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<AppleCliExecResult>;

/** The filesystem surface this module drives; the default wraps `node:fs/promises`. */
export interface MobileSimulatorFsLike {
  mkdir(dirPath: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(filePath: string, data: string): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  readdir(
    dirPath: string,
    opts: { withFileTypes: true },
  ): Promise<ReadonlyArray<{ name: string; isDirectory(): boolean }>>;
  rm(targetPath: string, opts: { recursive: true; force: true }): Promise<void>;
}

/** A booted, request-owned simulator. Every field is resolved live — nothing here is hardcoded. */
export interface MobileSimulatorHandle {
  /** The created device's UDID. The ONLY device identifier any generated argv may carry. */
  udid: string;
  /** `cyboflow-verify-<requestId>` — the marker-matched name the sweep looks for. */
  name: string;
  /** Human runtime name, e.g. `iOS 26.2`. */
  runtimeName: string;
  /** Runtime identifier, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-2`. */
  runtimeId: string;
  /** Device-type identifier, e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro`. */
  deviceTypeId: string;
  /** Fresh, EMPTY `-derivedDataPath` for this request. Removed by {@link dispose}. */
  derivedDataDir: string;
  /** `<dataDir>/verify-mobile/<requestId>` — owns `owner.json` and DerivedData. */
  requestDir: string;
  /** Best-effort, idempotent, NEVER throws. Shutdown → delete → remove the request dir. */
  dispose(): Promise<void>;
}

/** Arguments to {@link MobileSimulatorSessionFactory.acquire}. */
export interface AcquireSimulatorArgs {
  /** The verification request id; becomes the device name suffix and the request dir name. */
  requestId: string;
  /** The cyboflow data dir this instance owns. `verify-mobile/` is created under it. */
  dataDir: string;
  /** Optional device-type pin — matched by identifier OR display name. Default: the newest compatible iPhone. */
  deviceType?: string;
  /** Optional runtime pin — matched by identifier OR display name. Default: the newest available iOS runtime. */
  runtime?: string;
  /** Bound on `simctl bootstatus`. A boot that outlives it rolls the whole acquire back. */
  bootTimeoutMs: number;
}

/** What one sweep reclaimed and what it deliberately left alone. */
export interface SweepResult {
  /** UDIDs of devices actually deleted. */
  deleted: string[];
  /**
   * What was left in place, as labels: `marker:<requestId>` for a marker whose
   * owner is still live (or whose marker could not be read), and
   * `device:<name>` for a `cyboflow-verify-*` device no marker under this data
   * dir claims.
   */
  skipped: string[];
}

/** The two entry points: per-request acquisition, and the boot-time reclaim. */
export interface MobileSimulatorSessionFactory {
  acquire(args: AcquireSimulatorArgs): Promise<MobileSimulatorHandle>;
  sweepStaleSimulators(args: { dataDir: string }): Promise<SweepResult>;
}

/** Construction-time deps. Only `exec` is required; the rest default to the real host. */
export interface MobileSimulatorSessionDeps {
  exec: AppleCliExec;
  fs?: MobileSimulatorFsLike;
  platform?: NodeJS.Platform;
  logger?: LoggerLike;
  now?: () => number;
  /** This process's pid, stamped into `owner.json`. Defaults to `process.pid`. */
  pid?: number;
  /** `process.kill(pid, 0)` — THROWS (ESRCH) when the pid is gone. Injected so the sweep is testable. */
  processKill?: (pid: number, signal: 0) => void;
  /** Per-command bound for everything but `bootstatus`. */
  commandTimeoutMs?: number;
}

/** The directory, under a data dir, that holds one marker dir per in-flight mobile request. */
export const VERIFY_MOBILE_DIRNAME = 'verify-mobile';

/** Device-name prefix. The sweep matches on it; nothing else may create a device with this prefix. */
export const VERIFY_SIM_NAME_PREFIX = 'cyboflow-verify-';

/** Fresh, empty `-derivedDataPath` per request, under the request dir so the recursive remove is bounded. */
const DERIVED_DATA_DIRNAME = 'DerivedData';

/** The ownership marker's filename. */
const OWNER_MARKER_FILENAME = 'owner.json';

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * The ownership marker, written BEFORE the device exists and updated with the
 * udid the moment it does.
 *
 * WHY THE PID ALONE IS NOT ENOUGH: pids are recycled. A marker naming pid 4711
 * from a cyboflow that died days ago will happily match some unrelated process
 * that now holds 4711, and the sweep would then skip a genuinely orphaned
 * simulator forever. `pidStartedAt` — the raw `ps -o lstart=` string — pins the
 * identity: same pid AND same start time is the same process, anything else is
 * reuse.
 */
export interface SimulatorOwnerMarker {
  pid: number;
  /** Raw, trimmed `ps -o lstart= -p <pid>` output. Empty when `ps` could not answer. */
  pidStartedAt: string;
  simName: string;
  /** `null` until `simctl create` returns — the window where a crash leaves a dir but no device. */
  simUdid: string | null;
  requestId: string;
  createdAt: string;
}

/** Minimal shape of one `xcrun simctl list -j` device-type entry. */
interface SimDeviceType {
  name?: unknown;
  identifier?: unknown;
  productFamily?: unknown;
}

/** Minimal shape of one `xcrun simctl list -j` runtime entry. */
interface SimRuntime {
  name?: unknown;
  identifier?: unknown;
  version?: unknown;
  platform?: unknown;
  isAvailable?: unknown;
  supportedDeviceTypes?: unknown;
}

/** A resolved (runtime, device type) pair — the INTERSECTION `simctl create` demands. */
export interface ResolvedSimTarget {
  runtimeId: string;
  runtimeName: string;
  deviceTypeId: string;
  deviceTypeName: string;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The real `node:fs/promises`, wrapped explicitly so the structural fit is checked here, not at every call. */
const NODE_FS: MobileSimulatorFsLike = {
  mkdir: (dirPath, opts) => fsPromises.mkdir(dirPath, opts),
  writeFile: (filePath, data) => fsPromises.writeFile(filePath, data, 'utf8'),
  readFile: (filePath, encoding) => fsPromises.readFile(filePath, encoding),
  readdir: (dirPath, opts) => fsPromises.readdir(dirPath, opts),
  rm: (targetPath, opts) => fsPromises.rm(targetPath, opts),
};

/**
 * Compare two dotted version strings numerically, segment by segment.
 * `'26.2'` beats `'9.10'` — a lexicographic compare would not.
 */
export function compareSimVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10));
  const right = b.split('.').map((part) => Number.parseInt(part, 10));
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = Number.isFinite(left[i] ?? NaN) ? (left[i] as number) : 0;
    const r = Number.isFinite(right[i] ?? NaN) ? (right[i] as number) : 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/**
 * Rank one iPhone device type for "newest".
 *
 * NOTHING IS HARDCODED: "iPhone 17 Pro" is not a stable string and will be
 * wrong within a year. The model NUMBER is the only durable signal in the name
 * (`iPhone 17 Pro Max` → 17, `iPhone 16e` → 16), so it is the primary key;
 * entries carrying no number at all (`iPhone SE (3rd generation)`) rank lowest
 * rather than being parsed into a misleading 3. Ties fall back to POSITION in
 * simctl's own list, which is ordered oldest-first.
 */
function iPhoneModelRank(name: string): number {
  const match = /iphone\s*(\d+)/i.exec(name);
  return match ? Number.parseInt(match[1] as string, 10) : -1;
}

function parseDeviceTypes(value: unknown): SimDeviceType[] {
  return Array.isArray(value) ? value.filter((entry): entry is SimDeviceType => asRecord(entry) !== null) : [];
}

/**
 * Pick the newest iPhone from a device-type list, or `null` when it holds none.
 * The caller supplies the list that is already intersected with a runtime.
 */
export function pickNewestIPhone(deviceTypes: readonly SimDeviceType[]): { id: string; name: string } | null {
  let best: { id: string; name: string; rank: number; index: number } | null = null;
  for (let index = 0; index < deviceTypes.length; index += 1) {
    const entry = deviceTypes[index] as SimDeviceType;
    const id = asString(entry.identifier);
    const name = asString(entry.name);
    if (id === null || name === null) continue;
    // `supportedDeviceTypes` entries carry productFamily; when they do, honour
    // it. When they do not, fall back to the name so a runtime that omits the
    // field is still usable.
    const family = asString(entry.productFamily);
    const isPhone = family !== null ? family === 'iPhone' : /^iphone/i.test(name);
    if (!isPhone) continue;
    const rank = iPhoneModelRank(name);
    if (best === null || rank > best.rank || (rank === best.rank && index > best.index)) {
      best = { id, name, rank, index };
    }
  }
  return best === null ? null : { id: best.id, name: best.name };
}

/**
 * Resolve the (runtime, device type) pair `simctl create` will accept, from one
 * `xcrun simctl list -j` payload.
 *
 * THE INTERSECTION IS LOAD-BEARING. Taking the newest entry of the flat
 * `devicetypes` list yields `iPhone-6s-Plus` on a current host (that list is
 * not ordered by recency and carries every device type Xcode has ever known),
 * and `simctl create` rejects it against iOS 26.2 with `Incompatible device`.
 * The runtime's OWN `supportedDeviceTypes` is the compatibility answer; the
 * flat list is only the fallback for an Xcode too old to publish it, and there
 * it is filtered to `productFamily === 'iPhone'`.
 *
 * Throws a human-readable error when no pair resolves — the caller turns that
 * into a rolled-back acquire, and the probe into an `absent` verdict.
 */
export function resolveSimTarget(
  listJson: unknown,
  pins: { runtime?: string; deviceType?: string } = {},
): ResolvedSimTarget {
  const root = asRecord(listJson);
  if (root === null) throw new Error('`xcrun simctl list -j` produced no readable object');

  const runtimes = Array.isArray(root.runtimes)
    ? root.runtimes.filter((entry): entry is SimRuntime => asRecord(entry) !== null)
    : [];
  const iosRuntimes = runtimes.filter((entry) => {
    if (entry.isAvailable !== true) return false;
    const platform = asString(entry.platform);
    const identifier = asString(entry.identifier) ?? '';
    // `platform` is absent on older Xcode payloads; the identifier always
    // carries the family, so it is the fallback rather than an assumption.
    return platform !== null ? platform === 'iOS' : /SimRuntime\.iOS-/i.test(identifier);
  });
  if (iosRuntimes.length === 0) {
    throw new Error('no available iOS simulator runtime is installed');
  }

  let runtime: SimRuntime | undefined;
  if (pins.runtime !== undefined) {
    runtime = iosRuntimes.find(
      (entry) => asString(entry.identifier) === pins.runtime || asString(entry.name) === pins.runtime,
    );
    if (runtime === undefined) {
      throw new Error(`the pinned iOS runtime "${pins.runtime}" is not installed or not available`);
    }
  } else {
    runtime = [...iosRuntimes].sort((a, b) =>
      compareSimVersions(asString(b.version) ?? '0', asString(a.version) ?? '0'),
    )[0];
  }
  if (runtime === undefined) throw new Error('no available iOS simulator runtime is installed');

  const runtimeId = asString(runtime.identifier);
  if (runtimeId === null) throw new Error('the selected iOS runtime carries no identifier');
  const runtimeName = asString(runtime.name) ?? runtimeId;

  const supported = parseDeviceTypes(runtime.supportedDeviceTypes);
  // Fallback for an Xcode that does not publish supportedDeviceTypes (pre-15):
  // the flat list, narrowed to iPhones. Compatibility is then unproven, which
  // is why it is the fallback and not the default.
  const pool = supported.length > 0 ? supported : parseDeviceTypes(root.devicetypes);

  if (pins.deviceType !== undefined) {
    const pinned = pool.find(
      (entry) => asString(entry.identifier) === pins.deviceType || asString(entry.name) === pins.deviceType,
    );
    const id = pinned === undefined ? null : asString(pinned.identifier);
    if (pinned === undefined || id === null) {
      throw new Error(
        `the pinned device type "${pins.deviceType}" is not compatible with ${runtimeName}`,
      );
    }
    return { runtimeId, runtimeName, deviceTypeId: id, deviceTypeName: asString(pinned.name) ?? id };
  }

  const newest = pickNewestIPhone(pool);
  if (newest === null) {
    throw new Error(`no iPhone device type is compatible with ${runtimeName}`);
  }
  return { runtimeId, runtimeName, deviceTypeId: newest.id, deviceTypeName: newest.name };
}

/**
 * Build the per-request simulator session factory.
 *
 * Holds NO cross-request state beyond the injected deps: every handle owns its
 * own device, its own request dir and its own disposal flag, so two concurrent
 * lanes cannot see each other.
 */
export function createMobileSimulatorSessionFactory(
  deps: MobileSimulatorSessionDeps,
): MobileSimulatorSessionFactory {
  const fs = deps.fs ?? NODE_FS;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const selfPid = deps.pid ?? process.pid;
  const processKill = deps.processKill ?? ((pid: number, signal: 0) => process.kill(pid, signal));
  const timeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const logger = deps.logger;

  /** `xcrun <args>` with the standard bound. Resolves on any exit code; rejects only when it could not run. */
  const xcrun = (args: readonly string[], boundMs = timeoutMs): Promise<AppleCliExecResult> =>
    deps.exec('xcrun', args, { timeoutMs: boundMs });

  /** Run and THROW on a non-zero exit — for the steps where a failure must roll the acquire back. */
  const xcrunOrThrow = async (args: readonly string[], boundMs = timeoutMs): Promise<string> => {
    const result = await xcrun(args, boundMs);
    if (result.code !== 0) {
      throw new Error(
        `xcrun ${args.join(' ')} exited ${result.code ?? 'null'}${
          result.stderr.trim() ? `: ${result.stderr.trim()}` : ''
        }`,
      );
    }
    return result.stdout;
  };

  /** Run, log a failure, and swallow it — for the cosmetic steps that must never fail an acquire. */
  const xcrunBestEffort = async (args: readonly string[], what: string): Promise<void> => {
    try {
      const result = await xcrun(args);
      if (result.code !== 0) {
        logger?.info(`[mobileSimulatorSession] ${what} exited non-zero; continuing`, {
          code: result.code,
          stderr: result.stderr.trim().slice(0, 400),
        });
      }
    } catch (err) {
      logger?.info(`[mobileSimulatorSession] ${what} could not run; continuing`, {
        error: errorText(err),
      });
    }
  };

  /**
   * This process's start time as `ps` reports it. Best-effort: an empty string
   * means the pid-reuse check degrades to a plain liveness check, which is the
   * conservative direction (it can only make the sweep skip more, never delete
   * more).
   */
  const readProcessStart = async (pid: number): Promise<string> => {
    try {
      const result = await deps.exec('ps', ['-o', 'lstart=', '-p', String(pid)], { timeoutMs });
      return result.code === 0 ? result.stdout.trim() : '';
    } catch (err) {
      logger?.info('[mobileSimulatorSession] could not read a process start time', {
        pid,
        error: errorText(err),
      });
      return '';
    }
  };

  const writeMarker = async (requestDir: string, marker: SimulatorOwnerMarker): Promise<void> => {
    await fs.writeFile(path.join(requestDir, OWNER_MARKER_FILENAME), JSON.stringify(marker, null, 2));
  };

  /** Shutdown → delete one device by udid. Each step independently swallowed. */
  const destroyDevice = async (udid: string): Promise<void> => {
    await xcrunBestEffort(['simctl', 'shutdown', udid], `simctl shutdown ${udid}`);
    await xcrunBestEffort(['simctl', 'delete', udid], `simctl delete ${udid}`);
  };

  const removeDir = async (dirPath: string, what: string): Promise<void> => {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch (err) {
      logger?.warn(`[mobileSimulatorSession] could not remove ${what}`, {
        path: dirPath,
        error: errorText(err),
      });
    }
  };

  async function acquire(args: AcquireSimulatorArgs): Promise<MobileSimulatorHandle> {
    const requestDir = path.join(args.dataDir, VERIFY_MOBILE_DIRNAME, args.requestId);
    const simName = `${VERIFY_SIM_NAME_PREFIX}${args.requestId}`;
    let udid: string | null = null;
    let step = 'request dir';

    try {
      await fs.mkdir(requestDir, { recursive: true });

      // The marker is written BEFORE the device exists. A crash in the window
      // between here and `simctl create` leaves a dir with `simUdid: null`,
      // which the sweep reclaims by NAME — the one case where a name lookup is
      // safe, because a marker under this data dir proves the device is ours.
      step = 'owner marker';
      const marker: SimulatorOwnerMarker = {
        pid: selfPid,
        pidStartedAt: await readProcessStart(selfPid),
        simName,
        simUdid: null,
        requestId: args.requestId,
        createdAt: new Date(now()).toISOString(),
      };
      await writeMarker(requestDir, marker);

      step = 'simctl list';
      const listRaw = await xcrunOrThrow(['simctl', 'list', '-j']);
      let listJson: unknown;
      try {
        listJson = JSON.parse(listRaw);
      } catch (err) {
        throw new Error(`\`xcrun simctl list -j\` produced unreadable JSON: ${errorText(err)}`);
      }
      const target = resolveSimTarget(listJson, {
        ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
        ...(args.deviceType !== undefined ? { deviceType: args.deviceType } : {}),
      });

      step = 'simctl create';
      const created = (await xcrunOrThrow(['simctl', 'create', simName, target.deviceTypeId, target.runtimeId]))
        .trim();
      if (created.length === 0) throw new Error('`simctl create` returned no udid');
      udid = created;

      step = 'owner marker update';
      await writeMarker(requestDir, { ...marker, simUdid: udid });

      step = 'simctl boot';
      await xcrunOrThrow(['simctl', 'boot', udid]);

      // `bootstatus -b` blocks until the device finishes booting. Its bound is
      // the caller's, not the standard one: a cold first boot legitimately
      // takes minutes where every other command here takes milliseconds.
      step = 'simctl bootstatus';
      await xcrunOrThrow(['simctl', 'bootstatus', udid, '-b'], args.bootTimeoutMs);

      // Cosmetic determinism: a pinned status bar and a pinned appearance keep
      // screenshot baselines from drifting on the clock, the battery or the
      // host's dark-mode schedule. Best-effort by design — neither is worth
      // failing a verification over.
      await xcrunBestEffort(
        [
          'simctl',
          'status_bar',
          udid,
          'override',
          '--time',
          '9:41',
          '--batteryState',
          'charged',
          '--batteryLevel',
          '100',
          '--cellularBars',
          '4',
        ],
        'simctl status_bar override',
      );
      await xcrunBestEffort(['simctl', 'ui', udid, 'appearance', 'light'], 'simctl ui appearance');

      step = 'derived data dir';
      const derivedDataDir = path.join(requestDir, DERIVED_DATA_DIRNAME);
      await fs.mkdir(derivedDataDir, { recursive: true });

      const deviceUdid = udid;
      let disposed = false;
      return {
        udid: deviceUdid,
        name: simName,
        runtimeName: target.runtimeName,
        runtimeId: target.runtimeId,
        deviceTypeId: target.deviceTypeId,
        derivedDataDir,
        requestDir,
        async dispose(): Promise<void> {
          if (disposed) return;
          disposed = true;
          await destroyDevice(deviceUdid);
          await removeDir(requestDir, 'the mobile request dir');
        },
      };
    } catch (err) {
      // ROLLBACK. Past `simctl create` there is a real device to reclaim;
      // before it, only a directory. Either way the ORIGINAL failure is what
      // propagates — the step name is prepended so the preflight evidence row
      // says which rung broke, and `cause` keeps the original for a logger.
      if (udid !== null) await destroyDevice(udid);
      await removeDir(requestDir, 'the mobile request dir (rollback)');
      throw new Error(`mobile simulator acquire failed at ${step}: ${errorText(err)}`, { cause: err });
    }
  }

  /**
   * Reclaim what a hard-killed cyboflow left behind.
   *
   * NEVER THROWS: this runs at boot, and a sweep that threw would take the app
   * down over a leaked simulator. Every unreadable marker, every failed
   * command, is logged and skipped.
   */
  async function sweepStaleSimulators(sweepArgs: { dataDir: string }): Promise<SweepResult> {
    const deleted: string[] = [];
    const skipped: string[] = [];
    // Nothing on a non-darwin host can have created a simulator, so spawn nothing.
    if (platform !== 'darwin') return { deleted, skipped };

    const root = path.join(sweepArgs.dataDir, VERIFY_MOBILE_DIRNAME);
    let entries: ReadonlyArray<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      // An absent verify-mobile dir is the normal first-run case, not an error.
      logger?.debug('[mobileSimulatorSession] no mobile request dirs to sweep', {
        path: root,
        error: errorText(err),
      });
    }

    /** Device names this data dir's markers account for — everything else is another instance's. */
    const claimedNames = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const requestDir = path.join(root, entry.name);
      let marker: SimulatorOwnerMarker | null = null;
      try {
        const raw = await fs.readFile(path.join(requestDir, OWNER_MARKER_FILENAME), 'utf8');
        const parsed = asRecord(JSON.parse(raw));
        if (parsed !== null && typeof parsed.pid === 'number') {
          marker = {
            pid: parsed.pid,
            pidStartedAt: typeof parsed.pidStartedAt === 'string' ? parsed.pidStartedAt : '',
            simName: asString(parsed.simName) ?? `${VERIFY_SIM_NAME_PREFIX}${entry.name}`,
            simUdid: asString(parsed.simUdid),
            requestId: asString(parsed.requestId) ?? entry.name,
            createdAt: asString(parsed.createdAt) ?? '',
          };
        }
      } catch (err) {
        logger?.warn('[mobileSimulatorSession] could not read an owner marker; leaving it alone', {
          path: requestDir,
          error: errorText(err),
        });
      }

      if (marker === null) {
        // An unreadable marker is not evidence the owner is dead. Deleting on
        // it would be a guess with a live request on the other end.
        skipped.push(`marker:${entry.name}`);
        continue;
      }
      claimedNames.add(marker.simName);

      if (await ownerIsAlive(marker)) {
        skipped.push(`marker:${marker.requestId}`);
        logger?.debug('[mobileSimulatorSession] owner still alive; leaving its simulator alone', {
          requestId: marker.requestId,
          pid: marker.pid,
        });
        continue;
      }

      const udid = marker.simUdid ?? (await lookupUdidByName(marker.simName));
      if (udid !== null) {
        await destroyDevice(udid);
        deleted.push(udid);
      }
      await removeDir(requestDir, 'a stale mobile request dir');
      logger?.info('[mobileSimulatorSession] reclaimed a stale mobile verification simulator', {
        requestId: marker.requestId,
        pid: marker.pid,
        udid,
      });
    }

    // Devices this instance's markers do not account for belong to someone
    // else — very likely a second cyboflow on a different data dir. Report
    // them; never touch them.
    for (const name of await listVerifyDeviceNames()) {
      if (claimedNames.has(name)) continue;
      skipped.push(`device:${name}`);
      logger?.info(
        '[mobileSimulatorSession] a cyboflow-verify device has no marker under this data dir; leaving it alone',
        { device: name, dataDir: sweepArgs.dataDir },
      );
    }

    return { deleted, skipped };
  }

  /**
   * Liveness with pid-reuse defeated. Alive iff the pid exists AND — when the
   * marker recorded one — its start time still matches. An unanswerable `ps`
   * counts as ALIVE: the conservative direction, because the cost of skipping
   * a dead owner is a leaked simulator, while the cost of deleting a live
   * one's is a failed verification on another instance.
   */
  async function ownerIsAlive(marker: SimulatorOwnerMarker): Promise<boolean> {
    try {
      processKill(marker.pid, 0);
    } catch {
      return false;
    }
    if (marker.pidStartedAt.length === 0) return true;
    const current = await readProcessStart(marker.pid);
    if (current.length === 0) return true;
    return current === marker.pidStartedAt;
  }

  /** Find a device's udid by name. Used only for a marker whose udid was never stamped. */
  async function lookupUdidByName(name: string): Promise<string | null> {
    for (const device of await listVerifyDevices()) {
      if (device.name === name) return device.udid;
    }
    return null;
  }

  async function listVerifyDeviceNames(): Promise<string[]> {
    return (await listVerifyDevices()).map((device) => device.name);
  }

  /** Every `cyboflow-verify-*` device the host knows about, flattened across runtimes. */
  async function listVerifyDevices(): Promise<Array<{ name: string; udid: string }>> {
    let raw: string;
    try {
      const result = await xcrun(['simctl', 'list', '-j', 'devices']);
      if (result.code !== 0) return [];
      raw = result.stdout;
    } catch (err) {
      logger?.info('[mobileSimulatorSession] could not list simulator devices', {
        error: errorText(err),
      });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const devices = asRecord(asRecord(parsed)?.devices);
    if (devices === null) return [];
    const out: Array<{ name: string; udid: string }> = [];
    for (const perRuntime of Object.values(devices)) {
      if (!Array.isArray(perRuntime)) continue;
      for (const entry of perRuntime) {
        const record = asRecord(entry);
        if (record === null) continue;
        const name = asString(record.name);
        const udid = asString(record.udid);
        if (name === null || udid === null) continue;
        if (!name.startsWith(VERIFY_SIM_NAME_PREFIX)) continue;
        out.push({ name, udid });
      }
    }
    return out;
  }

  return { acquire, sweepStaleSimulators };
}
