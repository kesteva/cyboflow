# Stream Parser Fixtures

Wire-format JSON fixtures for `claude --output-format stream-json` events.
Each file contains a single JSON object representing one event from the stream.

## Capture Command

To capture real fixtures from a live Claude session, run:

```bash
claude -p "Print 'hello world' then exit" --output-format stream-json --verbose --include-partial-messages > raw_stream.jsonl
```

Then extract individual variant lines using `jq`:

```bash
# system/init
jq -c 'select(.type == "system" and .subtype == "init")' raw_stream.jsonl | head -1

# assistant with tool_use + text mixed content
jq -c 'select(.type == "assistant")' raw_stream.jsonl | head -1

# user with string content tool_result
jq -c 'select(.type == "user")' raw_stream.jsonl | head -1

# result/success
jq -c 'select(.type == "result" and .subtype == "success")' raw_stream.jsonl | head -1

# stream_event
jq -c 'select(.type == "stream_event")' raw_stream.jsonl | head -1
```

## Claude CLI Version Used

**All fixtures in this directory are synthetic** — no `claude` CLI capture was performed.
The executor did not have a usable `ANTHROPIC_API_KEY` or `claude` CLI available at task
execution time (2026-05-13). Synthetic fixtures were authored per the fallback documented
in TASK-103 plan §"Hardest Decision" and §step 3.

To record the CLI version on future re-captures:
```bash
claude --version
```

## Fixture Inventory

| Filename | Source | Wire `type` | Wire `subtype` | Notes |
|----------|--------|-------------|----------------|-------|
| `system_init.json` | **synthetic** | `system` | `init` | Based on research §1 schema; `permissionMode` is camelCase per SamSaffron spec |
| `system_api_retry.json` | **synthetic** | `system` | `api_retry` | Requires rate-limit injection to capture; synth based on research §1 schema |
| `system_compact.json` | **synthetic** | `system` | `compact` | Only fires on long sessions with large context; synth based on research §1 schema |
| `assistant.json` | **synthetic** | `assistant` | — | Mixed content: text block + tool_use block; research §1 §3 mixed-content case |
| `user_string_content.json` | **synthetic** | `user` | — | `tool_result.content` is a plain string; research §1 §4 string form |
| `user_array_content.json` | **synthetic** | `user` | — | `tool_result.content` is array of `{type, text}`; research §1 §4 array form |
| `result_success.json` | **synthetic** | `result` | `success` | Normal session completion; research §1 result schema |
| `result_error_max_turns.json` | **synthetic** | `result` | `error_max_turns` | Requires `--max-turns` exhaustion; synth based on research §1 schema |
| `result_error_max_budget_usd.json` | **synthetic** | `result` | `error_max_budget_usd` | Requires `--max-budget` exhaustion; synth based on research §1 schema |
| `result_error_during_execution.json` | **synthetic** | `result` | `error_during_execution` | Requires Claude to crash mid-run; synth based on research §1 schema |
| `stream_event.json` | **synthetic** | `stream_event` | — | Streaming delta event; research §1 §5 stream_event schema |

## Schema Source

All synthetic fixtures are authored from the documented schema in:
- **Architecture research §1**: `.soloflow/active/research/ROADMAP-001-research-architecture.md`
  (lines 20-48: "Typed Event Schema — ClaudeStreamEvent 7-Variant Union")
- **SamSaffron CLI spec gist**: https://gist.github.com/SamSaffron/603648958a8c18ceae34939a8951d417

## Re-Capture Schedule

Fixtures should be re-captured **quarterly** to detect wire-format drift. When re-capturing:

1. Run the capture command above with the current `claude` CLI version.
2. Compare new captures against committed fixtures: `diff <(jq -S . old.json) <(jq -S . new.json)`
3. If fields changed or were added, update `shared/types/claudeStream.ts` (TASK-101),
   `main/src/services/streamParser/schemas.ts` (TASK-102), and the fixture files in lockstep.
4. Record the new `claude --version` output in this README.

## `system/compact` Wire Literal Note

The wire discriminant for context-compaction events is `compact` (this fixture's `subtype`).
Crystal's `ClaudeMessageTransformer.ts` uses the string `context_compacted` for its
renderer-side state tracking — that is an internal Crystal convention, not the wire value.
The `SystemCompactEvent` TypeScript type (TASK-101) and the `systemCompactSchema` Zod schema
(TASK-102) both use the wire literal `compact`. Tests pin this wire literal.

## `permissionMode` Casing Note

`system/init` events carry `permissionMode` in camelCase — this is a documented exception to
the otherwise universal snake_case wire format. See the SamSaffron CLI spec gist and research
§1 §7 for confirmation. The Zod schema and TypeScript type both preserve this camelCase key.
