/**
 * ompGateConfigBuilder — composes the `CYBOFLOW_OMP_GATE_CONFIG` payload the
 * spawned `omp` process's gating extension reads (proposal §5.3).
 *
 * The gate extension is the SOLE policy engine for an OMP session
 * (`gate/ompGateExtension.ts`); this module is the host half that tells it what
 * cyboflow's policy actually is for one spawn. Three translations happen here
 * and nowhere else:
 *
 *  1. TOOL NAMES. cyboflow's policy is written against Claude's names (`Bash`,
 *     `Edit`, `mcp__cyboflow__cyboflow_report_finding`); OMP's canonical names
 *     are lowercase (`tools/builtin-names.ts:1-31`) and its MCP names use a
 *     single underscore with the redundant server prefix stripped
 *     (`mcp/tool-bridge.ts:345-358`). {@link toOmpToolName} does the mapping.
 *  2. THE READ-SAFE SET. Mirrors the INTENT of cyboflow's
 *     `ACCEPT_EDITS_SAFE_READONLY_TOOLS` (`main/src/orchestrator/safeCommandClassifier.ts:47-54`)
 *     onto OMP's read-tier builtins — see {@link OMP_AUTO_ALLOW_TOOLS}.
 *  3. THE EDIT SET. Mirrors `ACCEPT_EDITS_AUTO_APPROVE_TOOLS`
 *     (`main/src/orchestrator/permissionModeMapper.ts:39`) onto OMP's
 *     write-tier file tools — see {@link OMP_EDIT_TOOLS}.
 *
 * Both sets are cyboflow's own, deliberately NOT OMP's tiering: OMP's `write`
 * approval tier includes every MCP tool, which is far wider than cyboflow's
 * acceptEdits allowance (proposal §5.3, "OMP's tool-tier classification is never
 * cyboflow's trust boundary").
 */
import type { PermissionMode } from '../../../../../shared/types/workflows';
import type { OmpGateConfig } from './gate/ompGateTypes';

/**
 * OMP built-ins cyboflow pre-clears as read-safe, auto-allowed in every gated
 * mode. Each is read-tier in OMP AND has a counterpart in cyboflow's own
 * read-safe set (`safeCommandClassifier.ts:47-54` — Read / Glob / Grep / LS /
 * NotebookRead / TodoWrite):
 *
 *   read      ↔ Read           (`tools/read.ts:401`)
 *   glob      ↔ Glob + LS      (`tools/glob.ts:107`)
 *   grep      ↔ Grep           (`tools/grep.ts:906`)
 *   ast_grep  ↔ Grep-class     (`tools/ast-grep.ts:151`)
 *   todo      ↔ TodoWrite      (`tools/todo.ts:797`)
 *
 * Plus two of OMP's HIDDEN tools (`HIDDEN_TOOL_NAMES = ['yield','goal','think']`,
 * `tools/builtin-names.ts`), which have no Claude counterpart because Claude has
 * no equivalent concept. Neither reaches outside the model's own turn:
 *
 *   yield     the agent's RETURN VALUE — "submit data or error", how a task
 *             reports success or failure (`tools/yield.ts`). Pure control flow.
 *   think     "private scratchpad; not shown to user" (`tools/think.ts`).
 *
 * `goal` is the third hidden tool and is deliberately NOT here: it sets a
 * persistent autonomous objective for the session, which is precisely the kind
 * of self-direction a human gate exists to show someone.
 *
 * WHAT IS NOT HERE, AND WHY — these two were proposed for this list and both
 * would have been holes:
 *
 *   eval  executes Python/JavaScript/Ruby/Julia in a persistent backend
 *         (`tools/eval.ts`). Arbitrary code execution, not coordination. It is
 *         already named in the gate's own `AUTO_MODE_HAZARD_TOOLS`.
 *   hub   is coordination AND process control behind one name: `op:'start'`
 *         runs an arbitrary `application`, and `op:'send'` with `name` types
 *         into a live process's stdin. It is classified BY ARGUMENT in the
 *         gate (`isCoordinationHubCall`), which a name list cannot express.
 *
 * Everything else OMP happens to tier `read` is deliberately absent, because
 * cyboflow's set is about "touches nothing outside this repo", not about OMP's
 * tier: `web_search` reaches the network; `memory_edit`/`retain` mutate OMP's
 * memory store; `checkpoint`/`rewind` mutate git state; `inspect_image` hands
 * bytes to a vision provider. Each of those falls through to the human instead.
 *
 * THE REMOTE-TARGET NARROWING LIVES IN THE GATE, NOT HERE. OMP's `read`/`grep`
 * escalate themselves to `exec` tier when the path targets `ssh://`
 * (read.ts:401-402, grep.ts:906-909) — a remote operation over the user's own
 * SSH credentials. This list cannot express that, because it is a list of names.
 * The gate refuses every name-based shortcut whose ARGUMENTS carry a URI scheme
 * (`hasUriSchemeTarget` in `gate/ompGateExtension.ts`), so an `ssh://` read
 * reaches the human even though `read` is named here. Do not "fix" that by
 * splitting this list — the argument is what decides, and only the gate sees it.
 */
export const OMP_AUTO_ALLOW_TOOLS: readonly string[] = [
  'read',
  'glob',
  'grep',
  'ast_grep',
  'todo',
  'yield',
  'think',
];

/**
 * OMP's file-mutating built-ins — the `acceptEdits`/`auto` allowance, mirroring
 * `ACCEPT_EDITS_AUTO_APPROVE_TOOLS` (Edit / Write / MultiEdit):
 *
 *   write     (`tools/write.ts:502-503`, write tier)
 *   edit      (`edit/index.ts:385-390`, write tier for a real path)
 *   ast_edit  (`tools/ast-edit.ts:181-186`, write tier for a real path)
 *
 * `bash` is NOT here even though cyboflow's acceptEdits widens to provably
 * read-only shell: that widening is argument-dependent
 * (`isSafeReadOnlyBashCommand`) and the gate's `editTools` is a name list. A
 * bash call under acceptEdits therefore reaches the human, which is the
 * conservative direction.
 */
export const OMP_EDIT_TOOLS: readonly string[] = ['write', 'edit', 'ast_edit'];

/** The MCP server name cyboflow registers in `.omp/mcp.json`. */
export const CYBOFLOW_MCP_SERVER_NAME = 'cyboflow';

/**
 * Every tool `cyboflowMcpServer.ts` declares, across its three scopes (the run
 * tool set, `GLOBAL_AGENT_TOOLS`, `DESIGN_TOOLS`).
 *
 * Hardcoded rather than imported: the MCP server is a standalone script that
 * connects to the orchestrator socket at import time, so pulling it into the
 * main process to read its tool list would start a second client. The list is
 * pinned instead by `__tests__/ompGateConfigBuilder.test.ts`, which re-derives
 * it from that file's source and fails on any drift.
 */
export const CYBOFLOW_MCP_TOOL_NAMES: readonly string[] = [
  'cyboflow_add_task_dependency',
  'cyboflow_await_verification',
  'cyboflow_backlog',
  'cyboflow_commit_artifact',
  'cyboflow_create_sprint_batch',
  'cyboflow_create_task',
  'cyboflow_create_variant',
  'cyboflow_create_workflow',
  'cyboflow_db_query',
  'cyboflow_db_schema',
  'cyboflow_delete_variant',
  'cyboflow_delete_workflow',
  'cyboflow_design_ack_feedback',
  'cyboflow_design_get_idea',
  'cyboflow_design_update_draft',
  'cyboflow_entity',
  'cyboflow_fs_grep',
  'cyboflow_fs_list',
  'cyboflow_fs_read',
  'cyboflow_get_eval',
  'cyboflow_get_run',
  'cyboflow_get_selected_findings',
  'cyboflow_get_task',
  'cyboflow_get_verifications',
  'cyboflow_get_workflow',
  'cyboflow_history',
  'cyboflow_list_pending_approvals',
  'cyboflow_list_run_findings',
  'cyboflow_list_tasks',
  'cyboflow_list_variants',
  'cyboflow_list_workflows',
  'cyboflow_overview',
  'cyboflow_propose_action',
  'cyboflow_queue',
  'cyboflow_reference',
  'cyboflow_register_verify_runbook',
  'cyboflow_report_artifact',
  'cyboflow_report_finding',
  'cyboflow_report_step',
  'cyboflow_request_user_input',
  'cyboflow_request_verification',
  'cyboflow_reset_workflow',
  'cyboflow_resolve_finding',
  'cyboflow_run_eval',
  'cyboflow_set_baseline_rotation',
  'cyboflow_set_idea_component',
  'cyboflow_set_task_stage',
  'cyboflow_set_variant_status',
  'cyboflow_submit_checkpoint',
  'cyboflow_update_sprint_task',
  'cyboflow_update_task',
  'cyboflow_update_variant',
  'cyboflow_update_workflow',
  'cyboflow_widget_preview',
  'cyboflow_widget_save',
  'cyboflow_workflow',
  'cyboflow_workflows',
];

/**
 * Claude tool names whose OMP counterpart is not just the lowercase form.
 * Anything absent falls through to a plain lowercase, which is OMP's own
 * canonicalization (`normalizeToolName`, `tools/builtin-names.ts:44-47`).
 *
 * A Claude tool with no OMP counterpart (MultiEdit, NotebookRead/Edit) is
 * deliberately unmapped: the lowercased name simply never matches a real OMP
 * call, which for a DENY list is the harmless direction.
 */
const CLAUDE_TO_OMP_TOOL_NAMES: Readonly<Record<string, string>> = {
  todowrite: 'todo',
  websearch: 'web_search',
  webfetch: 'fetch',
  ls: 'glob',
};

/** Port of OMP's `sanitizeMCPToolNamePart` (`mcp/tool-bridge.ts:335-343`). */
function sanitizeMcpNamePart(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * Port of OMP's `createMCPToolName` (`mcp/tool-bridge.ts:345-358`) — the name an
 * MCP tool is presented to the `tool_call` hook under. Both parts are sanitized,
 * then a redundant `<server>_` prefix on the tool name is stripped, so
 * `('cyboflow', 'cyboflow_report_finding')` yields `mcp__cyboflow_report_finding`
 * rather than `mcp__cyboflow_cyboflow_report_finding`.
 */
export function composeOmpMcpToolName(serverName: string, toolName: string): string {
  const server = sanitizeMcpNamePart(serverName, 'server');
  const tool = sanitizeMcpNamePart(toolName, 'tool');
  const redundant = `${server}_`;
  const normalized = tool.startsWith(redundant) ? tool.slice(redundant.length) : tool;
  return `mcp__${server}_${normalized}`;
}

/** The exact names cyboflow's own MCP tools reach the OMP gate under. */
export function cyboflowOmpMcpToolNames(): string[] {
  return CYBOFLOW_MCP_TOOL_NAMES.map((tool) =>
    composeOmpMcpToolName(CYBOFLOW_MCP_SERVER_NAME, tool),
  );
}

/**
 * Translate ONE cyboflow tool name into the name OMP's gate will see.
 *
 * Claude's MCP form is `mcp__<server>__<tool>` (double underscore between the
 * two parts); OMP's is single-underscore with the redundant prefix stripped. So
 * `mcp__cyboflow__cyboflow_request_verification` — the one name the programmatic
 * step runner actually denies (`spawnStepRunner.ts:63`) — becomes
 * `mcp__cyboflow_request_verification`.
 */
export function toOmpToolName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return trimmed;

  if (trimmed.startsWith('mcp__')) {
    const rest = trimmed.slice('mcp__'.length);
    const separator = rest.indexOf('__');
    // A bare `mcp__<server>` (Claude's whole-server deny form) has no tool half;
    // sanitize it as a server name so at least the prefix stays comparable.
    if (separator === -1) return `mcp__${sanitizeMcpNamePart(rest, 'server')}`;
    return composeOmpMcpToolName(rest.slice(0, separator), rest.slice(separator + 2));
  }

  const lowered = trimmed.toLowerCase();
  return CLAUDE_TO_OMP_TOOL_NAMES[lowered] ?? lowered;
}

export interface OmpGateConfigInput {
  /** The session's resolved 4-mode agent permission mode. */
  permissionMode: PermissionMode;
  /** Per-spawn tool deny list, in cyboflow's own naming (`ClaudeSpawnerOptions.disallowedTools`). */
  disallowedTools?: readonly string[];
  /** The merged permission-rule ALLOW list (`loadMergedPermissionRules(...).allow`). */
  allowRules?: readonly string[];
  /**
   * Whether cyboflow's MCP server is wired for this spawn. False for an in-place
   * session, which gets no `.omp/mcp.json` (proposal §5.4) — so the emitted
   * `cyboflowMcpToolNames` is empty and the gate auto-allows NO MCP tool at all.
   *
   * That empty list is the point, not an omission. A LEGITIMATE cyboflow MCP
   * tool cannot occur in an in-place session, but a SPOOFED one can: OMP
   * auto-imports the user's own MCP configs, and a server named `cyboflow-extra`
   * produces `mcp__cyboflow_extra_*` tool names. Exact-empty means those are
   * undecidable and reach the human, which is exactly the desired outcome.
   */
  cyboflowMcpAvailable: boolean;
  /**
   * The human-decision budget to hand the gate, in ms. Pass this ONLY when the
   * spawn also carries the matching `PI_CONFIG_FILES` overlay that raises OMP's
   * own extension-handler cap — the two are halves of one change, and a budget
   * without the overlay makes the gate outlive the runtime that hosts it.
   * Omitted for an OMP older than
   * `OMP_CONFIGURABLE_HANDLER_TIMEOUT_VERSION`, which ignores the setting.
   */
  humanDecisionBudgetMs?: number;
}

/**
 * Build the gate config for one spawn.
 *
 * `denyTaskTool` is FALSE, and the premise that once made it true has been
 * measured rather than assumed.
 *
 * IT WAS TRUE ON AN ASSUMPTION, NOT A CITATION — and the distinction is the
 * whole reason this changed. The original comment read "OMP's docs say subagents
 * run forced-yolo". That sentence has no source, which stands out in a file
 * where every other external claim cites a line (`runner.ts:1235-1270`,
 * `wrapper.ts:201-235`, `read.ts:401`). The proposal it derives from says
 * something weaker and different: §2 fact 5 records that OMP's GLOBAL
 * `tools.approvalMode` defaults to `yolo` — a session-wide setting cyboflow
 * already overrides with `--approval-mode always-ask` — and the risk table
 * records hook scope inside subagents as "unknown", not as documented-yolo.
 * omp v17.3.5's own surfaces tie `yolo` only to that global setting, whose
 * description reads "'Yolo' auto-approves all tiers; user policy may still
 * prompt or block". Two true facts got welded into a third that nobody checked.
 *
 * Being empirical, it was testable. Probed live against omp v17.3.5 on
 * 2026-08-23, in an `auto` session, with `task` allowed:
 *
 *   23:00:48.748  allowed `task` (auto-tool)     <- parent dispatches
 *   23:00:54.039  allowed `bash` (allow-rule)    <- THE SUBAGENT's call, GATED
 *   23:00:59.922  parent's next tool call (`hub`)
 *
 * The parent's own transcript shows NO tool call between its `task` at
 * 23:00:48.752 and its `hub` at 23:00:59.922, so the gated `bash` at 23:00:54
 * was the subagent's; the file it wrote landed carrying the expected marker. The
 * handler fires inside a `task` subagent. The premise does not hold.
 *
 * TASK ISOLATION, decided in the same change as the old note required. §6 item 8
 * planned a `task.isolation.mode: none` overlay because OMP's subagent
 * overlay/rcopy isolation was untested inside a cyboflow git worktree. The same
 * probe answered it: a subagent told to write a RELATIVE path put the file in
 * the session's own worktree, visible to the parent — OMP's default already
 * behaves as `none` here. No overlay is configured, because configuring one
 * would pin a behaviour we are not otherwise exercising.
 *
 * THE RESIDUAL RISK, stated without the embellishment the old note carried: this
 * relies on gating and isolation behaviour of an external binary that nothing
 * here pins or asserts, and OMP ships fast. It is NOT "the docs say otherwise" —
 * no such doc has been found. A version tripwire is the obvious follow-up, and
 * pinning isolation explicitly needs OMP's real config key.
 *
 * THE FAIL-CLOSED DEFAULTS ARE UNCHANGED. `MOST_RESTRICTIVE_GATE_CONFIG` and
 * `parseGateConfig` both still default `denyTaskTool` to TRUE, so a missing or
 * malformed config still denies subagent dispatch. Only this builder — which
 * runs when the config IS well-formed — now allows it.
 *
 * The merged rules' DENY half is intentionally not forwarded: the gate has no
 * deny-rule grammar, and a denied call that is merely absent from `allowRules`
 * falls through to the human rather than being auto-allowed — the safe
 * degradation. Only `auto` mode consults `allowRules` at all.
 */
export function buildOmpGateConfig(input: OmpGateConfigInput): OmpGateConfig {
  return {
    permissionMode: input.permissionMode,
    disallowedTools: [...new Set((input.disallowedTools ?? []).map(toOmpToolName))].filter(
      (name) => name.length > 0,
    ),
    autoAllowTools: [...OMP_AUTO_ALLOW_TOOLS],
    editTools: [...OMP_EDIT_TOOLS],
    allowRules: [...(input.allowRules ?? [])],
    denyTaskTool: false,
    cyboflowMcpToolNames: input.cyboflowMcpAvailable ? cyboflowOmpMcpToolNames() : [],
    // Omitted rather than defaulted: absence is what tells the gate to keep its
    // own ~25s budget, and an explicit number here is a claim that OMP was
    // configured to allow it.
    ...(input.humanDecisionBudgetMs !== undefined
      ? { humanDecisionBudgetMs: input.humanDecisionBudgetMs }
      : {}),
  };
}
