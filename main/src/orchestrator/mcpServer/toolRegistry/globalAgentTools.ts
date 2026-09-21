/**
 * Global-agent tool family — the 16 `cyboflow_*` tools advertised when
 * CYBOFLOW_MCP_SCOPE=global-agent (the cross-project assistant thread, not a
 * workflow run). Read-only cross-project surfaces, plus TWO write-shaped
 * tools with disjoint targets: `cyboflow_propose_action` (records a
 * human-reviewable proposal — no project state changes until a human
 * confirms it) and `cyboflow_widget_save` (writes only the user's OWN
 * custom-widget library — a `custom_widgets` row — never a view, never a
 * backlog entity, never a proposal; no human gate, since saving to your own
 * draft library changes nothing about project state). `cyboflow_db_schema`
 * and `cyboflow_widget_preview` (read-only) round out the custom-widget
 * authoring trio (docs/proposals/CUSTOM-VIEWS.md §7.2).
 *
 * Every entry is a straight port of the hand-written `case` arm it replaced
 * in `handleGlobalAgentCallTool` (cyboflowMcpServer.ts) — same checks, same
 * `expected` prose, same envelope, same camelCase params. Where an arm only
 * checked `typeof`, the schema stays `z.string()` / `z.number()` rather than
 * tightening; where an arm also rejected an empty string
 * (`typeof x !== 'string' || x.length === 0`), the field carries `.min(1)` —
 * every such check here is on the RAW (untrimmed) length, so `.min(1)` alone
 * reproduces it without a refine.
 *
 * `cyboflow_reference` is the one exception: its arm serves static content
 * (ASSISTANT_REFERENCE) directly inside the MCP subprocess rather than
 * round-tripping through the orch socket. It carries `envelope: null` — the
 * dispatcher routes a null envelope to a local handler instead of
 * `executeMcpQuery` — and its `toEnvelope` only passes `topic` through for
 * that handler to read. ASSISTANT_REFERENCE itself stays in
 * cyboflowMcpServer.ts's local-tool table; it must not be pulled into this
 * registry module (this module is bundled into the standalone MCP
 * subprocess, same reasoning as the McpQueryMessage type-only import in
 * defineTool.ts).
 */
import { z } from 'zod';
import { defineTool, type RegisteredTool } from './defineTool';

/**
 * ORDER IS OBSERVABLE: this array is the ListTools reply order agents read.
 * Append rather than reshuffle.
 */
export const GLOBAL_AGENT_SCOPE_TOOLS: readonly RegisteredTool[] = [

  defineTool({
    name: 'cyboflow_overview',
    description:
      'READ-ONLY, cross-project digest: for every project, its active/recent sessions (each with its live run — workflow name, status, current step — when one exists), plus a pending blocking-gate count and a pending-question count. Compact JSON. No arguments.',
    input: z.object({}),
    envelope: 'mcp-overview',
    toEnvelope: () => ({}),
  }),

  defineTool({
    name: 'cyboflow_backlog',
    description:
      'READ-ONLY, cross-project backlog listing (ideas/epics/tasks) with priority/stage/version. Omit project_id to see every project merged into one list; pass it to scope to one project. include_archived / include_done mirror cyboflow_list_tasks\' semantics (both default false).',
    input: z.object({
      project_id: z.number().describe('Optional — scope to one project. Omitted = every project.').optional(),
      task_type: z.enum(['idea', 'epic', 'task']).describe('Optional filter to one entity type.').optional(),
      include_archived: z.boolean().describe('Include archived items. Defaults to false.').optional(),
      include_done: z.boolean().describe('Include done/retired items. Defaults to false.').optional(),
    }),
    envelope: 'mcp-backlog',
    toEnvelope: (args) => ({
      projectId: args.project_id,
      taskType: args.task_type,
      includeArchived: args.include_archived,
      includeDone: args.include_done,
    }),
  }),

  defineTool({
    name: 'cyboflow_entity',
    description:
      'READ-ONLY: fetch one backlog entity\'s full body by opaque id or display ref (e.g. \'TASK-014\'). A ref is unique only WITHIN a project — pass project_id to disambiguate a ref across projects (an opaque id needs no project_id, it is already globally unique).',
    input: z.object({
      task_id: z.string().min(1).describe('Opaque backlog id OR display ref (e.g. \'TASK-014\') (required)'),
      project_id: z.number().describe('Optional — disambiguates a ref across projects.').optional(),
    }),
    envelope: 'mcp-entity',
    toEnvelope: (args) => ({ taskId: args.task_id, projectId: args.project_id }),
  }),

  defineTool({
    name: 'cyboflow_queue',
    description:
      'READ-ONLY, cross-project review_items inbox. Defaults to pending items only; pass include_resolved to see resolved/dismissed ones too. Omit project_id to see every project. Rows are COMPACT by default — {id, project_id, run_id, kind, status, blocking, severity, source, title, entity_type, entity_id, staged_at, selected, created_at}, no body — pass include_body:true for the full shape. START WITH summary_only:true: it returns just the per-{kind,status,severity,source} tallies plus `total`, which is what you need before listing anything on a large inbox. Then page: limit (default 100, clamped to 250) + offset, with `total`, `truncated` and `nextOffset` in the reply (pass nextOffset back as offset to continue). Filters: kind, severity (a list), source_prefix (e.g. \'build-break-group\', \'visual-verify\', \'agent:eval\'), created_after / created_before (ISO timestamps). Rows are capped by count, not bytes — a page of 250 compact rows stays under ~100KB.',
    input: z.object({
      project_id: z.number().describe('Optional — scope to one project. Omitted = every project.').optional(),
      include_resolved: z.boolean().describe('Include resolved/dismissed items. Defaults to false.').optional(),
      include_body: z.boolean().describe('Return the full row (body + payload) instead of the compact shape. Defaults to false.').optional(),
      summary_only: z.boolean().describe('Return only {kind,status,severity,source} → count tallies (no rows). Defaults to false. Call this first on a large inbox.').optional(),
      kind: z.enum(['finding', 'permission', 'decision', 'human_task', 'notification']).describe('Optional — only items of this kind.').optional(),
      severity: z
        .array(z.enum(['info', 'warning', 'error']))
        .min(1)
        .describe('Optional — only findings whose severity is in this list (e.g. ["error"] or ["error","warning"]).')
        .optional(),
      source_prefix: z.string().min(1).describe('Optional — only items whose source starts with this prefix (e.g. \'agent:eval\').').optional(),
      created_after: z.string().min(1).describe('Optional ISO timestamp — only items created at or after it.').optional(),
      created_before: z.string().min(1).describe('Optional ISO timestamp — only items created before it.').optional(),
      limit: z.number().describe('Optional page size; default 100, clamped to <= 250.').optional(),
      offset: z.number().describe('Optional paging offset (0-based); pass a previous reply\'s nextOffset to continue.').optional(),
    }),
    envelope: 'mcp-queue',
    toEnvelope: (args) => ({
      projectId: args.project_id,
      includeResolved: args.include_resolved,
      includeBody: args.include_body,
      summaryOnly: args.summary_only,
      kind: args.kind,
      severity: args.severity,
      sourcePrefix: args.source_prefix,
      createdAfter: args.created_after,
      createdBefore: args.created_before,
      limit: args.limit,
      offset: args.offset,
    }),
  }),

  defineTool({
    name: 'cyboflow_workflows',
    description:
      'READ-ONLY, cross-project workflow listing (id, name, scope global|project, is_built_in, has_custom_spec). Omit project_id to see every workflow row across every project; pass it to also include that project\'s own scoped rows.',
    input: z.object({
      project_id: z.number().describe('Optional — also include this project\'s own scoped rows.').optional(),
    }),
    envelope: 'mcp-workflows',
    toEnvelope: (args) => ({ projectId: args.project_id }),
  }),

  defineTool({
    name: 'cyboflow_workflow',
    description:
      'READ-ONLY: one workflow\'s EFFECTIVE definition (spec_json wins, else the built-in fallback) plus a server-computed `spec_hash` — pin THIS hash in a cyboflow_propose_action{kind:\'edit-workflow\'} call\'s payload as the precondition your edit was drafted against (the server re-verifies it at confirm time; propose_action itself also re-computes it server-side, ignoring anything a caller might pass). Unknown id -> \'not_found\'.',
    input: z.object({
      workflow_id: z.string().min(1).describe('The workflow id (from cyboflow_workflows) (required)'),
    }),
    envelope: 'mcp-workflow',
    toEnvelope: (args) => ({ workflowId: args.workflow_id }),
  }),

  defineTool({
    name: 'cyboflow_agents',
    description:
      'READ-ONLY: the agents a workflow definition may bind for ONE project — every builtin agent key merged with the project\'s Agents-pane overrides, plus the project\'s custom agents, each with its description, tools, MCP grants, and pinned model. Also returns `human_gate_agent` (the `human` value a gate step binds) and `tool_vocabulary` (the CLI tool names a new custom agent may enable). Call this BEFORE composing a cyboflow_propose_action{kind:\'create-workflow\'} payload: a step\'s `agent` must be one of these keys, the human gate, or an agent the same proposal mints. Unknown project -> \'project_not_found\'.',
    input: z.object({
      project_id: z.number().describe('The project whose agent vocabulary to list (required)'),
    }),
    envelope: 'mcp-agents',
    toEnvelope: (args) => ({ projectId: args.project_id }),
  }),

  defineTool({
    name: 'cyboflow_db_query',
    description:
      'READ-ONLY, cross-project ad-hoc SQL diagnostic query — for questions the other curated tools can\'t answer (e.g. \'why did session X get stuck\', an event timeline, token usage). Runs on a DEDICATED readonly database connection: read-only is enforced by that connection itself, not merely by validation, so a write attempt is refused regardless. A single SELECT, WITH, or EXPLAIN statement only — no ATTACH, no PRAGMA, no multiple statements (\';\' followed by more SQL is rejected). Explore the schema first with `SELECT name, sql FROM sqlite_master WHERE type=\'table\'`. Results are capped (200 rows, ~100KB). Prefer the curated tools (cyboflow_overview / _backlog / _entity / _queue / _workflows / _workflow) when they already answer the question — reach for this only when they don\'t.',
    input: z.object({
      sql: z.string().min(1).describe('A single read-only SQL statement (SELECT/WITH/EXPLAIN) (required)'),
    }),
    envelope: 'mcp-db-query',
    // The arm's literal is bespoke — richer than the derived `sql: string`.
    expected: { sql: 'sql: string (a single read-only SELECT/WITH/EXPLAIN statement)' },
    toEnvelope: (args) => ({ sql: args.sql }),
  }),

  defineTool({
    name: 'cyboflow_reference',
    description:
      'READ-ONLY deeper product reference on cyboflow\'s features (the five built-in flows, sessions/worktrees, the backlog & board, the review queue, experiments & variants). Call with NO topic (or an empty one) to get the table of contents — every topic key plus a one-line summary — then call again with a `topic` key for that section\'s full markdown. Serves static, curated content: use it when the user asks how a cyboflow feature works or what a flow does. An unknown topic is rejected with the list of valid keys.',
    input: z.object({
      topic: z.string().describe('Optional kebab-case topic key (from the no-topic table of contents). Omit to get the table of contents.').optional(),
    }),
    // Not round-tripped through executeMcpQuery — served locally inside the MCP
    // subprocess from the compiled-in ASSISTANT_REFERENCE content module (which
    // stays in cyboflowMcpServer.ts, not here). The dispatcher routes a null
    // envelope to that local handler.
    envelope: null,
    // The arm's literal is bespoke — richer than the derived `topic: string (optional)`.
    expected: { topic: 'topic: string (optional kebab-case topic key)' },
    toEnvelope: (args) => ({ topic: args.topic }),
  }),

  defineTool({
    name: 'cyboflow_fs_read',
    description:
      'READ-ONLY file read, scoped to the registered project folders (plus any folders the user configured as extra assistant access). Use it to read source, config, or docs to answer code-level questions about a project. Returns { path, content, truncated, totalBytes }. The path must resolve inside an allowed folder (a scope_denied error names the allowed roots so you can retry within them); secret files (.env, private keys, credential stores) are refused; binary files are refused; content is capped (~256KB) — pass offset_line + limit_lines to page through a large file.',
    input: z.object({
      path: z.string().min(1).describe('Absolute path to a file inside an allowed project/extra folder (required)'),
      offset_line: z.number().describe('Optional 1-based line to start from (with limit_lines) for large-file paging.').optional(),
      limit_lines: z.number().describe('Optional number of lines to return from offset_line.').optional(),
    }),
    envelope: 'mcp-fs-read',
    toEnvelope: (args) => ({ path: args.path, offsetLine: args.offset_line, limitLines: args.limit_lines }),
  }),

  defineTool({
    name: 'cyboflow_fs_list',
    description:
      'READ-ONLY directory listing, scoped to the registered project folders (plus configured extras). Returns { path, entries:[{name, type:\'file\'|\'dir\'|\'symlink\', size}], truncated } (capped at 500 entries). The path must resolve inside an allowed folder (scope_denied otherwise, naming the roots). Secret file NAMES are shown (metadata), but their content stays unreadable via read/grep. Use it to discover a project\'s layout before reading or grepping.',
    input: z.object({
      path: z.string().min(1).describe('Absolute path to a directory inside an allowed project/extra folder (required)'),
    }),
    envelope: 'mcp-fs-list',
    toEnvelope: (args) => ({ path: args.path }),
  }),

  defineTool({
    name: 'cyboflow_fs_grep',
    description:
      'READ-ONLY recursive regex search, scoped to the registered project folders (plus configured extras). Returns { matches:[{file, line, text}], truncated, filesScanned }. Case-insensitive by default (set case_sensitive:true to change). The walk never follows symlinks and skips .git/node_modules/dist/build/.venv/__pycache__; secret and binary files are skipped. Optional `glob` filters by basename (e.g. *.ts). Caps: 200 matches, 20000 files scanned, per-line text truncated to 500 chars. An invalid regex returns invalid_regex; an out-of-scope path returns scope_denied naming the allowed roots. Use it for code-level questions; prefer cyboflow_db_query for app-state/database questions.',
    input: z.object({
      pattern: z.string().min(1).describe('Regular-expression pattern to search for (required)'),
      path: z.string().min(1).describe('Absolute path to a file or directory inside an allowed folder (required)'),
      glob: z.string().describe('Optional basename glob to filter files, e.g. *.ts').optional(),
      case_sensitive: z.boolean().describe('Optional; match case-sensitively. Defaults to false (case-insensitive).').optional(),
      max_results: z.number().describe('Optional cap on matches, clamped to <= 200.').optional(),
    }),
    envelope: 'mcp-fs-grep',
    toEnvelope: (args) => ({
      pattern: args.pattern,
      path: args.path,
      glob: args.glob,
      caseSensitive: args.case_sensitive,
      maxResults: args.max_results,
    }),
  }),

  defineTool({
    name: 'cyboflow_history',
    description:
      'READ-ONLY search over YOUR OWN past conversation transcripts with this user — your long-term memory. Your live context resets daily, but every past turn is durably kept; this tool reaches all of it. Without query: pages back through past turns newest-first (before_id continues a listing). With query (case-insensitive PLAIN-TEXT substring, not a regex): returns past turns whose text contains it, newest first, each as an excerpt around the first occurrence. role filters to \'user\' or \'assistant\' turns; days_back restricts to the last N days. Results are capped (limit clamps to 50, default 20, ~100KB payload) — truncated:true plus a numeric nextBeforeId mean there is more; pass nextBeforeId as before_id to continue. Use it when the user references a past conversation (\'as we discussed\', \'that thing from last week\'), asks what was talked about before, or when earlier context would clearly help — never claim you don\'t remember without searching first.',
    input: z.object({
      query: z.string().describe('Optional case-insensitive plain-text substring (not a regex). Omit to browse past turns newest-first.').optional(),
      role: z.enum(['user', 'assistant']).describe('Optional — return only your turns (\'assistant\') or only the user\'s (\'user\').').optional(),
      days_back: z.number().describe('Optional — restrict to turns from the last N days.').optional(),
      before_id: z.number().describe('Optional paging cursor — pass a previous call\'s nextBeforeId to continue that listing.').optional(),
      limit: z.number().describe('Optional turn count; clamped to <= 50 (default 20).').optional(),
    }),
    envelope: 'mcp-history',
    // The arm's literal is bespoke — richer than the derived `query: string (optional)`.
    expected: { query: 'query: string (optional case-insensitive plain-text substring)' },
    toEnvelope: (args) => ({
      query: args.query,
      role: args.role,
      daysBack: args.days_back,
      beforeId: args.before_id,
      limit: args.limit,
    }),
  }),

  defineTool({
    name: 'cyboflow_propose_action',
    description:
      'ONE OF TWO write-shaped tools available to the global agent (the other, disjoint one is cyboflow_widget_save — it writes only your own widget library, never this). Records a proposal — a candidate action for a human to review — and returns { proposalId }. Calling this tool NEVER executes anything: no run is launched, no task is reprioritized, no workflow is edited, nothing navigates. A human must explicitly confirm the resulting proposal card before any side effect happens, and confirmation runs through the SAME chokepoints every other write in this app uses (TaskChangeRouter / WorkflowRegistry / RunLauncher), stamped actor:\'user\'. After calling this tool, STOP and describe the proposal in your reply — do NOT claim the action happened, and do NOT poll or retry waiting for it to happen. `payload_json` is a JSON-encoded object (field names camelCase, matching shared/types/agentThread.ts AgentProposalPayload exactly) whose `kind` selects its shape: launch-run {kind,projectId,workflowName?|workflowId?,substrate?,taskIds?,ideaIds?,findingIds?,note?} (name the flow with EXACTLY ONE of workflowName — a built-in name (launch/planner/sprint/ship/compound) or a custom flow\'s exact name — or workflowId from cyboflow_workflows, preferred for custom flows; workflowId wins when both are given; an unresolvable one is rejected as unknown_workflow:<name>; seeds are mapped by the flow\'s SHAPE, so a custom flow cloned from sprint takes taskIds like sprint does, and a seed the shape does not take is dropped and reported on the card); reprioritize-backlog {kind,projectId,items:[{taskId,priority?,stageId?}]}; edit-workflow {kind,workflowId,definitionJson,summary?} (preconditions — the current spec hash — are captured server-side from a fresh read, never trusted from the caller, even if you include one); open-session {kind,navigation:{target:\'run\',runId}|{target:\'quick-session\',sessionId,runId?}}; create-backlog-items {kind,projectId,items:[{taskType:\'idea\'|\'epic\'|\'task\',title,summary?,body?,priority?,category?,scope?,parentEpicId?,originatingIdeaId?}]} (THE way to add ideas/epics/tasks to a project\'s backlog — up to 20 per proposal, created in the order listed; parentEpicId/originatingIdeaId may reference only entities that ALREADY exist, by opaque id or display ref, and a link that does not resolve rejects the whole proposal at propose time); create-workflow {kind,projectId,name,definitionJson,scope?:\'project\'|\'global\',permissionMode?,agents?:[{name,description,systemPrompt,tools,enabledMcps?,role?,model?}],summary?} (THE way to mint a NEW custom flow, optionally with the custom agents its steps bind to — up to 8 agents, created BEFORE the flow so its bindings resolve; `definitionJson` may be a JSON string or the definition object itself; it is validated with the strict workflow schema at propose time, every step\'s `agent` must be a builtin key from cyboflow_agents, the human gate, an existing custom agent of that project, or one of `agents` (whose key is the kebab-case of its name), and a global-scoped flow may mint no agents since agents are project-scoped; a rejection names the failing field so you can fix it in the same turn); triage-findings {kind,projectId,items:[{reviewItemId,op:\'dismiss\'|\'resolve\'|\'approve\'|\'set-selected\',resolution?,selected?}],summary?} (THE way to act on the review queue in bulk — up to 200 PENDING finding ids from cyboflow_queue, each with one op: dismiss/resolve close it (resolution = the note recorded on the row), approve stages it as READY for Compound, set-selected{selected:true} stages AND ticks it as a Compound seed (selected:false unticks a staged one); ids are validated at propose time — a missing, foreign-project, non-finding, non-pending or duplicate id rejects the whole proposal with a named error (review_item_not_found:<id> etc.); an item someone else triages between propose and confirm is skipped and reported, never a batch failure; put your per-group reasoning in your reply, since the card shows counts + titles only); start-quick-session {kind,projectId,brief,name?,substrate?:\'sdk\'|\'interactive\',inPlace?,note?} (THE way to START a new quick session — open-session only navigates to an existing one; on confirm the session is created exactly as the launch wizard creates one, on the project\'s default substrate unless `substrate` is given, in its own worktree unless inPlace:true, and `brief` (required, ≤8KB) is delivered as its FIRST prompt; the brief MUST be self-contained — the session agent cannot see this conversation, so spell out concrete ids and file paths (finding ids like rvw_…, task refs, paths), never "the ones we discussed"; `name` becomes the worktree/branch slug (optional — one is minted otherwise); an unknown project, an over-long brief or an unusable name is rejected with a named error (project_not_found / brief_too_long / invalid_name)). An unrecognized kind or a payload missing a kind\'s required fields is rejected with \'invalid_payload\'.',
    input: z.object({
      payload_json: z.string().min(1).describe('JSON-encoded AgentProposalPayload (required) — see the tool description for the per-kind shape.'),
    }),
    envelope: 'mcp-propose-action',
    // The arm's literal is bespoke — richer than the derived `payload_json: string`.
    expected: { payload_json: 'payload_json: string (JSON-encoded AgentProposalPayload)' },
    toEnvelope: (args) => ({ payloadJson: args.payload_json }),
  }),

  defineTool({
    name: 'cyboflow_db_schema',
    description:
      'READ-ONLY schema introspection of the app database: every table\'s columns (name, type, pk, notnull) plus an approximate row count (COUNT(*); null for the huge raw_events table, where that would be expensive). Prefer this over cyboflow_db_query\'s `SELECT name, sql FROM sqlite_master` for discovering a table\'s shape before building a custom-widget SQL source — it is cheaper and gives you columns directly. Omit `table` to list every table; pass it to scope to one.',
    input: z.object({
      table: z.string().min(1).describe('Optional — scope to one table name. Omit to list every table.').optional(),
    }),
    envelope: 'mcp-db-schema',
    toEnvelope: (args) => ({ table: args.table }),
  }),

  defineTool({
    name: 'cyboflow_widget_preview',
    description:
      'Validates a custom-widget spec and runs its sources exactly as the page will — NEVER saves anything. `spec_json` is a JSON-encoded WidgetSpec: `{version:1, sources:{name:{type:\'sql\',sql,params?}|{type:\'query\',name,input}}, transforms?:{sourceName:[{op:\'filter\'|\'sort\'|\'limit\'|\'bucketDate\'|\'group\'|\'derive\', ...}]}, render:{type:\'shape\',shape:\'stat\'|\'table\'|\'columns\'|\'bars\'|\'list\',...}|{type:\'html\',html}, actions?:[...], settings?:[...], refreshSec?}`. `settings_json` is an optional JSON-encoded object of `{name: value}` used to resolve any `{setting:name}` references in the spec (falls back to each setting\'s declared default). `project_id` supplies the value `{context:\'projectId\'}` params resolve to. On success returns `{sources:{name:{columns,rows,truncated,tookMs}}, warnings, plan, paused}` — that `sources` object is exactly what a tier-3 html widget\'s `cyboflow.onData(cb)` callback receives as `payload.sources` (read `payload.sources.<name>.rows`) — with each source\'s rows capped at 50 for the transcript (marked `truncatedForTranscript:true` when more exist — the real page is not capped this way). A malformed spec returns `invalid_spec` with a `detail` array of `path: message` strings; malformed JSON returns `invalid_json` / `invalid_settings`.',
    input: z.object({
      spec_json: z.string().min(1).describe('JSON-encoded WidgetSpec (required) — see the tool description for the contract.'),
      settings_json: z
        .string()
        .describe('Optional JSON-encoded object of setting values ({name: value}) resolving this spec\'s {setting:name} references.')
        .optional(),
      project_id: z.number().describe('Optional — the projectId {context:"projectId"} source params resolve to.').optional(),
    }),
    envelope: 'mcp-widget-preview',
    expected: { spec_json: 'spec_json: string (JSON-encoded WidgetSpec)' },
    toEnvelope: (args) => ({ specJson: args.spec_json, settingsJson: args.settings_json, projectId: args.project_id }),
  }),

  defineTool({
    name: 'cyboflow_widget_save',
    description:
      'THE SECOND write-shaped tool available to the global agent (disjoint from cyboflow_propose_action) — writes ONLY the user\'s custom-widget library (a custom_widgets row). It NEVER writes a view, a backlog entity, or a proposal, and needs no human confirmation: saving to your own draft library is not a project-state change. `session_id` comes from the page\'s `[custom-widget-session]` envelope when the user started from Customize -> Create a custom widget / Edit with assistant — never invent one. If you see no such envelope, OMIT it and save with `publish:true`: the widget lands in the user\'s library (Customize -> Add widget -> Mine) with no live preview, so say where to find it. A draft-only save (`publish:false`) without a session is refused with draft_needs_session. `widget_id` omitted creates a new widget; passed, it updates that widget (a draft owned by a DIFFERENT live session is refused with session_mismatch). `spec_json` is the same WidgetSpec shape cyboflow_widget_preview validates — preview it first. `publish:false` saves a draft only, visible live in the authoring slot; `publish:true` saves AND promotes the draft to the published spec every other surface renders. Returns `{ widgetId, revision }`.',
    input: z.object({
      session_id: z
        .string()
        .min(1)
        .describe('The authoring session id from the page\'s [custom-widget-session] envelope — never invent one. Omit when there is no envelope (the save then publishes straight into the library and publish must be true).')
        .optional(),
      widget_id: z.string().min(1).describe('Optional — the widget id to update. Omit to create a new widget.').optional(),
      name: z.string().min(1).describe('Widget name shown in the library (required)'),
      description: z.string().describe('Optional short description shown in the library.').optional(),
      spec_json: z.string().min(1).describe('JSON-encoded WidgetSpec (required) — the same shape cyboflow_widget_preview validates.'),
      publish: z
        .boolean()
        .describe('true saves AND promotes to the published spec every other surface renders; false saves a draft only (required)'),
    }),
    envelope: 'mcp-widget-save',
    expected: { spec_json: 'spec_json: string (JSON-encoded WidgetSpec)' },
    toEnvelope: (args) => ({
      sessionId: args.session_id,
      widgetId: args.widget_id,
      name: args.name,
      description: args.description,
      specJson: args.spec_json,
      publish: args.publish,
    }),
  }),
];
