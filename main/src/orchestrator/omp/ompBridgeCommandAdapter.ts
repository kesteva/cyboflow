/**
 * Real `OmpCommandAdapter` — shells Cyboflow's privileged command surface to
 * the OMP Prime bridge's `fleet_*` MCP tools.
 *
 * Mapping (Cyboflow request → producer tool):
 * - spawn       → fleet_spawn
 * - kill        → fleet_kill
 * - apply       → fleet_proposal_apply
 * - discard     → fleet_proposal_discard
 * - verifyRun   → fleet_verification_run
 *
 * The producer's argument schema is snake_case (`proposal_id`, `execution_mode`,
 * `timeout` in seconds); Cyboflow's contract is camelCase (`proposalId`,
 * `executionMode`, `timeoutMs`). This adapter is the translation layer and owns
 * that fidelity — callers never do.
 *
 * Standalone-typecheck invariant: no imports from electron, better-sqlite3, or
 * services/*. The client is injected (`OmpBridgeClientLike`) so this module is
 * testable without a live bridge.
 */
import type {
  OmpApplyRequest,
  OmpCommandAdapter,
  OmpCommandResult,
  OmpDiscardRequest,
  OmpKillRequest,
  OmpReadRequest,
  OmpSendRequest,
  OmpSpawnRequest,
  OmpStateRequest,
  OmpVerifyRequest,
} from "../../../../shared/types/ompCommand";
import type { OmpBridgeClientLike } from "./ompBridgeClient";

/** Verification status the producer reports on apply/discard, verbatim. */
type ProducerVerificationStatus = "off" | "pass" | "shadow_warning" | "denied";

interface ProducerApplyDetails {
  success?: boolean;
  reason?: string;
  verification?: { status?: ProducerVerificationStatus; reason?: string };
}

/** A `tools/call` result that is an MCP error (isError) or a transport failure. */
function toFailureResult(operationId: string, detail: string): OmpCommandResult {
  return { ok: false, operationId, error: "unavailable", detail };
}

/** Map the producer's apply/discard structured detail onto Cyboflow's error taxonomy. */
function failureFromApplyDetails(operationId: string, fallbackDetail: string, details: unknown): OmpCommandResult {
  const status = (details as ProducerApplyDetails | undefined)?.verification?.status;
  if (status === "denied") {
    return {
      ok: false,
      operationId,
      error: "blocked",
      detail: fallbackDetail || "apply denied by verification policy",
    };
  }
  if (status === "shadow_warning") {
    return { ok: false, operationId, error: "shadow", detail: fallbackDetail || "apply allowed only in shadow mode" };
  }
  return toFailureResult(operationId, fallbackDetail);
}

/** Project Cyboflow's WorkerScope onto the producer's spawn `scope` (repo only). */
function toProducerScope(scope: OmpSpawnRequest["scope"]): Record<string, unknown> | undefined {
  if (scope?.repo === undefined) return undefined;
  const repo: Record<string, unknown> = {
    path: scope.repo.path,
    access: scope.repo.access,
  };
  if (scope.repo.include !== undefined) repo.include = scope.repo.include;
  if (scope.repo.exclude !== undefined) repo.exclude = scope.repo.exclude;
  return { repo };
}

export class OmpBridgeCommandAdapter implements OmpCommandAdapter {
  readonly authority = "supervise" as const;

  constructor(private readonly client: OmpBridgeClientLike) {}

  async spawn(req: OmpSpawnRequest): Promise<OmpCommandResult> {
    const args: Record<string, unknown> = { model: req.model, task: req.task };
    if (req.label !== undefined) args.label = req.label;
    if (req.target !== undefined) args.target = req.target;
    if (req.workspace !== undefined) args.workspace = req.workspace;
    if (req.cwd !== undefined) args.cwd = req.cwd;
    // Producer `timeout` is integer seconds; Cyboflow carries milliseconds.
    if (req.timeoutMs !== undefined) args.timeout = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    if (req.executionMode !== undefined) args.execution_mode = req.executionMode;
    if (req.intent !== undefined) args.intent = req.intent;
    const scope = toProducerScope(req.scope);
    if (scope !== undefined) args.scope = scope;

    return this.invoke("fleet_spawn", args, req.operationId);
  }

  async kill(req: OmpKillRequest): Promise<OmpCommandResult> {
    return this.invoke("fleet_kill", { id: req.workerId }, req.operationId);
  }

  async apply(req: OmpApplyRequest): Promise<OmpCommandResult> {
    const result = await this.client.callTool({
      name: "fleet_proposal_apply",
      arguments: { proposal_id: req.proposalId, reason: req.reason },
    });
    if (result.ok) return { ok: true, operationId: req.operationId, detail: result.text };
    return failureFromApplyDetails(req.operationId, result.text, result.structuredContent);
  }

  async discard(req: OmpDiscardRequest): Promise<OmpCommandResult> {
    const result = await this.client.callTool({
      name: "fleet_proposal_discard",
      arguments: { proposal_id: req.proposalId, reason: req.reason },
    });
    if (result.ok) return { ok: true, operationId: req.operationId, detail: result.text };
    return failureFromApplyDetails(req.operationId, result.text, result.structuredContent);
  }

  async verifyRun(req: OmpVerifyRequest): Promise<OmpCommandResult> {
    return this.invoke("fleet_verification_run", { proposal_id: req.proposalId }, req.operationId);
  }

  async send(req: OmpSendRequest): Promise<OmpCommandResult> {
    const args: Record<string, unknown> = { id: req.workerId, text: req.text };
    if (req.keys !== undefined) args.keys = req.keys;
    return this.invoke("fleet_send", args, req.operationId);
  }

  async read(req: OmpReadRequest): Promise<OmpCommandResult> {
    const args: Record<string, unknown> = { id: req.workerId };
    if (req.lines !== undefined) args.lines = req.lines;
    if (req.source !== undefined) args.source = req.source;
    return this.invoke("fleet_read", args, req.operationId);
  }

  async state(req: OmpStateRequest): Promise<OmpCommandResult> {
    return this.invoke("fleet_state", { id: req.workerId }, req.operationId);
  }

  private async invoke(
    toolName: string,
    args: Record<string, unknown>,
    operationId: string,
  ): Promise<OmpCommandResult> {
    const result = await this.client.callTool({ name: toolName, arguments: args });
    if (result.ok) return { ok: true, operationId, detail: result.text };
    return toFailureResult(operationId, result.text || `fleet tool failed: ${toolName}`);
  }
}
