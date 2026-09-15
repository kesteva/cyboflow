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
      'READ-ONLY, cross-project review_items inbox listing (kind, blocking, status, title, entity link). Defaults to pending items only; pass include_resolved to see resolved/dismissed ones too. Omit project_id to see every project.',
    input: z.object({
      project_id: z.number().describe('Optional — scope to one project. Omitted = every project.').optional(),
      include_resolved: z.boolean().describe('Include resolved/dismissed items. Defaults to false.').optional(),
    }),
    envelope: 'mcp-queue',
    toEnvelope: (args) => ({ projectId: args.project_id, includeResolved: args.include_resolved }),
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
      'ONE OF TWO write-shaped tools available to the global agent (the other, disjoint one is cyboflow_widget_save — it writes only your own widget library, never this). Records a proposal — a candidate action for a human to review — and returns { proposalId }. Calling this tool NEVER executes anything: no run is launched, no task is reprioritized, no workflow is edited, nothing navigates. A human must explicitly confirm the resulting proposal card before any side effect happens, and confirmation runs through the SAME chokepoints every other write in this app uses (TaskChangeRouter / WorkflowRegistry / RunLauncher), stamped actor:\'user\'. After calling this tool, STOP and describe the proposal in your reply — do NOT claim the action happened, and do NOT poll or retry waiting for it to happen. `payload_json` is a JSON-encoded object (field names camelCase, matching shared/types/agentThread.ts AgentProposalPayload exactly) whose `kind` selects its shape: launch-run {kind,projectId,workflowName,substrate?,taskIds?,ideaIds?,findingIds?,note?}; reprioritize-backlog {kind,projectId,items:[{taskId,priority?,stageId?}]}; edit-workflow {kind,workflowId,definitionJson,summary?} (preconditions — the current spec hash — are captured server-side from a fresh read, never trusted from the caller, even if you include one); open-session {kind,navigation:{target:\'run\',runId}|{target:\'quick-session\',sessionId,runId?}}; create-backlog-items {kind,projectId,items:[{taskType:\'idea\'|\'epic\'|\'task\',title,summary?,body?,priority?,category?,scope?,parentEpicId?,originatingIdeaId?}]} (THE way to add ideas/epics/tasks to a project\'s backlog — up to 20 per proposal, created in the order listed; parentEpicId/originatingIdeaId may reference only entities that ALREADY exist, by opaque id or display ref, and a link that does not resolve rejects the whole proposal at propose time). An unrecognized kind or a payload missing a kind\'s required fields is rejected with \'invalid_payload\'.',
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
      'Validates a custom-widget spec and runs its sources exactly as the page will — NEVER saves anything. `spec_json` is a JSON-encoded WidgetSpec: `{version:1, sources:{name:{type:\'sql\',sql,params?}|{type:\'query\',name,input}}, transforms?:{sourceName:[{op:\'filter\'|\'sort\'|\'limit\'|\'bucketDate\'|\'group\'|\'derive\', ...}]}, render:{type:\'shape\',shape:\'stat\'|\'table\'|\'columns\'|\'bars\'|\'list\',...}|{type:\'html\',html}, actions?:[...], settings?:[...], refreshSec?}`. `settings_json` is an optional JSON-encoded object of `{name: value}` used to resolve any `{setting:name}` references in the spec (falls back to each setting\'s declared default). `project_id` supplies the value `{context:\'projectId\'}` params resolve to. On success returns `{sources:{name:{columns,rows,truncated,tookMs}}, warnings, plan, paused}` with each source\'s rows capped at 50 for the transcript (marked `truncatedForTranscript:true` when more exist — the real page is not capped this way). A malformed spec returns `invalid_spec` with a `detail` array of `path: message` strings; malformed JSON returns `invalid_json` / `invalid_settings`.',
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
