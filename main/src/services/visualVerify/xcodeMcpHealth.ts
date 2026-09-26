/**
 * xcodeMcpHealth — the host-facing half of the Xcode 27 DeviceInteraction
 * rung (docs/proposals/runbook-optional-verification.md §B2, §B8):
 *
 *  - {@link xcodeProbeRow}: the §B2 probe folded into the health panel's
 *    `'xcode-mcp'` row, with a remedy per failing check (download the iOS
 *    platform, enable headless mode, approve access) and the grant's expiry;
 *  - {@link toXcodeProbeSummary}: the same probe narrowed to the two fields the
 *    runner's engine selection reads;
 *  - {@link createXcodeApprovalAction}: the §B8 "Approve Xcode access" action.
 *
 * THE APPROVAL ACTION, and what it deliberately does NOT do. Xcode keys a
 * grant on the binary that spawns the bridge, and only `XcodeOpenWorkspace` /
 * `XcodeNewProject` raise its interactive prompt (B0). So the action spawns the
 * bridge FROM THE MAIN PROCESS — the binary the runner will later spawn it
 * from — and asks Xcode to open a scaffold project cyboflow owns under
 * `<dataDir>/xcode-approval/`, while the user is looking at the panel that
 * asked. Then it re-reads `xcrun mcp-server status --format json` and SHOWS the
 * exact `sudo xcrun mcp-server approve <id> --for-24-hours` command (and, for a
 * signed build only, the `--always` opt-in) — it never runs either: both need
 * sudo, and approving is the user's decision. It never uses
 * `--unsafe-always-allow-all-agents`, and the scaffold is the only folder it
 * ever causes to be approved.
 *
 * Main-process only (it spawns the bridge); no electron import — the caller
 * passes `signedBuild` in.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { LoggerLike } from '../../orchestrator/types';
import type { XcodeProbeSummary } from '../../orchestrator/verify/xcode/driveEngineSelection';
import {
  createXcodeMcpBridgeClient,
  type XcodeMcpBridgeClient,
  type XcodeMcpBridgeClientOptions,
} from '../../orchestrator/verify/xcode/xcodeMcpBridgeClient';
import type { VerifyProbeRow, XcodeAccessApproval } from '../../../../shared/types/visualVerification';
import { XCODE_MCP_PROBE_ID, type XcodeDeviceInteractionProbeResult } from './xcodeDeviceInteractionProbe';

/** Where the approval scaffold lives under the data dir. */
export const XCODE_APPROVAL_DIRNAME = 'xcode-approval';
const SCAFFOLD_PROJECT = 'CyboflowApproval.xcodeproj';

/** Xcode's prompt BLOCKS the triggering call while the user decides (B0) — give them time. */
const DEFAULT_OPEN_TIMEOUT_MS = 10 * 60_000;
const CLOSE_WORKSPACE_TIMEOUT_MS = 30_000;

/** Shown with every approve command, and on the panel. */
export const XCODE_APPROVAL_DISCLOSURE =
  'Approving Cyboflow approves every agent it hosts — Claude and Codex alike — for as long as the grant lasts, ' +
  "and it covers all of Xcode's tools on every folder you have permitted. Cyboflow itself only ever asks Xcode " +
  'to open its own scaffold project, so that scaffold is the only folder it causes to be approved.';

/** A grant / request id we are willing to interpolate into a shown command. */
const APPROVAL_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** The §B2 probe summary the runner's engine selection reads. */
export function toXcodeProbeSummary(result: XcodeDeviceInteractionProbeResult): XcodeProbeSummary {
  return { outcome: result.outcome, approval: result.approval, detail: result.detail };
}

/**
 * Fold the probe into the `'xcode-mcp'` health row.
 *
 *  - `available` → `ok`, the detail naming the grant's expiry (or that it has none);
 *  - `approval-required` / `expiring` → `missing` with the approve action;
 *  - `unavailable` → `missing` with NO action (installing Xcode or a platform is
 *    the user's job) — the detail carries each failed check's remedy;
 *  - `inconclusive` → `inconclusive`, never `missing`; the approve action is
 *    still offered when the grant is what could not be read.
 */
export function xcodeProbeRow(result: XcodeDeviceInteractionProbeResult): VerifyProbeRow {
  const remedies = result.checks
    .filter((check) => check.status !== 'ok' && check.remedy !== null)
    .map((check) => `${check.id}: ${check.remedy}`);
  const withRemedies = (detail: string): string =>
    remedies.length > 0 ? `${detail} — to fix: ${remedies.join('; ')}` : detail;
  switch (result.outcome) {
    case 'available': {
      const expiry =
        result.grant === null
          ? ''
          : result.grant.expiresAt === null
            ? '; the grant does not expire'
            : `; the grant expires at ${new Date(result.grant.expiresAt).toISOString()}`;
      return { id: XCODE_MCP_PROBE_ID, state: 'ok', detail: `${result.detail}${expiry}`, fix: null };
    }
    case 'approval-required':
    case 'expiring':
      return { id: XCODE_MCP_PROBE_ID, state: 'missing', detail: withRemedies(result.detail), fix: 'approve-xcode-access' };
    case 'unavailable':
      return { id: XCODE_MCP_PROBE_ID, state: 'missing', detail: withRemedies(result.detail), fix: null };
    case 'inconclusive':
      return {
        id: XCODE_MCP_PROBE_ID,
        state: 'inconclusive',
        detail: withRemedies(result.detail),
        fix: result.approval === 'unknown' ? 'approve-xcode-access' : null,
      };
  }
}

/** The minimal Xcode project Xcode is asked to open — no targets, nothing to build. */
export const SCAFFOLD_PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {
		C7F0A1000000000000000001 /* Project object */ = {
			isa = PBXProject;
			buildConfigurationList = C7F0A1000000000000000002;
			compatibilityVersion = "Xcode 14.0";
			mainGroup = C7F0A1000000000000000003;
			projectDirPath = "";
			projectRoot = "";
			targets = (
			);
		};
		C7F0A1000000000000000002 = {
			isa = XCConfigurationList;
			buildConfigurations = (
				C7F0A1000000000000000004,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		C7F0A1000000000000000003 = {
			isa = PBXGroup;
			children = (
			);
			sourceTree = "<group>";
		};
		C7F0A1000000000000000004 = {
			isa = XCBuildConfiguration;
			buildSettings = {
			};
			name = Release;
		};
	};
	rootObject = C7F0A1000000000000000001;
}
`;

/** The probe surface the action needs: a re-read after the prompt. */
export interface XcodeApprovalProbe {
  probe(): Promise<XcodeDeviceInteractionProbeResult>;
  invalidate(): void;
}

export interface XcodeApprovalActionDeps {
  /** The cyboflow data dir; the scaffold lives in `xcode-approval/` under it. */
  dataDir: string;
  probe: XcodeApprovalProbe;
  /** Whether this build is Developer-ID signed (packaged). Only then is `--always` offered. */
  signedBuild: boolean;
  xcrunPath?: string;
  /** Test seam over {@link createXcodeMcpBridgeClient}. */
  createClient?: (options: XcodeMcpBridgeClientOptions) => XcodeMcpBridgeClient;
  /** Test seam: write the scaffold. Defaults to the real filesystem. */
  writeScaffold?: (projectDir: string, pbxproj: string) => Promise<void>;
  openTimeoutMs?: number;
  logger?: LoggerLike;
}

async function defaultWriteScaffold(projectDir: string, pbxproj: string): Promise<void> {
  await fsp.mkdir(projectDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(projectDir, 'project.pbxproj'), pbxproj, 'utf8');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the §B8 action. Concurrent calls share one attempt (a double click
 * must not raise two prompts). Never throws: every failure is an outcome.
 */
export function createXcodeApprovalAction(deps: XcodeApprovalActionDeps): () => Promise<XcodeAccessApproval> {
  const scaffoldDir = path.join(deps.dataDir, XCODE_APPROVAL_DIRNAME);
  const projectPath = path.join(scaffoldDir, SCAFFOLD_PROJECT);
  let inFlight: Promise<XcodeAccessApproval> | null = null;

  const attempt = async (): Promise<XcodeAccessApproval> => {
    const base = { disclosure: XCODE_APPROVAL_DISCLOSURE, scaffoldPath: projectPath };
    try {
      await (deps.writeScaffold ?? defaultWriteScaffold)(projectPath, SCAFFOLD_PBXPROJ);
    } catch (err) {
      return {
        ...base,
        outcome: 'unavailable',
        detail: `could not write the approval scaffold: ${errorText(err)}`,
        approveCommand: null,
        durableApproveCommand: null,
      };
    }

    let opened: { ok: boolean; message: string } = { ok: false, message: 'the bridge was not reached' };
    let reached = false;
    const client = (deps.createClient ?? createXcodeMcpBridgeClient)({
      ...(deps.xcrunPath !== undefined ? { xcrunPath: deps.xcrunPath } : {}),
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    });
    try {
      const connected = await client.connect();
      if (connected.ok) {
        reached = true;
        const result = await client.call(
          'XcodeOpenWorkspace',
          { path: projectPath },
          deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
        );
        if (result.ok) {
          opened = { ok: true, message: 'Xcode opened the scaffold project' };
          const workspace = result.structured.workspaceIdentifier;
          if (typeof workspace === 'string' && workspace.length > 0) {
            // Best-effort tidy-up: the scaffold has nothing to keep open.
            await client.call('XcodeCloseWorkspace', { workspaceIdentifier: workspace }, CLOSE_WORKSPACE_TIMEOUT_MS);
          }
        } else {
          opened = { ok: false, message: result.message };
        }
      } else {
        opened = { ok: false, message: connected.message };
      }
    } finally {
      await client.close();
    }

    deps.probe.invalidate();
    const after = await deps.probe.probe();
    const candidate = after.pendingRequestIds[0] ?? after.grant?.agentId ?? null;
    const id = candidate !== null && APPROVAL_ID.test(candidate) ? candidate : null;
    const approveCommand = id === null ? null : `sudo xcrun mcp-server approve ${id} --for-24-hours`;
    const durableApproveCommand = id !== null && deps.signedBuild ? `sudo xcrun mcp-server approve ${id} --always` : null;
    const outcome: XcodeAccessApproval['outcome'] =
      after.approval === 'approved' ? 'approved' : opened.ok ? 'prompted' : reached ? 'bridge-refused' : 'unavailable';
    deps.logger?.info('[xcodeMcpHealth] approve-xcode-access finished', { outcome, approval: after.approval });
    return {
      ...base,
      outcome,
      detail:
        outcome === 'approved'
          ? `Xcode access is approved: ${after.detail}`
          : `${opened.message}. ${after.detail}${
              approveCommand === null ? " — answer Xcode's own prompt, or approve from Terminal once Xcode lists the request" : ''
            }`,
      approveCommand,
      durableApproveCommand,
    };
  };

  return () => {
    if (inFlight === null) {
      inFlight = attempt().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}
