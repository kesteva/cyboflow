# Code-Review Eval — Full Evaluation Checklist (rubric v1.0)

> Draft for review. This is the concrete per-dimension checklist an **independent, out-of-loop judge** runs against the frozen pre-human diff snapshot a workflow produced. It measures how workflow variants perform. Output = overall /100 + per-dimension sub-scores.

## How scoring works

- **Each dimension score** = fraction of its named sub-checks marked **PASS** (of PASS + FAIL). **UNKNOWN** is excluded from the denominator and logged — the judge marks UNKNOWN instead of guessing when the snapshot can't settle a check.
- **Bands** (uniform across dimensions):

  | Band | Pass-fraction | Score |
  |---|---|---|
  | Excellent | ≥ 0.90 | 90–100 |
  | Good | 0.70–0.89 | 70–89 |
  | Fair | 0.40–0.69 | 40–69 |
  | Poor | < 0.40 | 0–39 |
  | **GATED** | reserved sentinel | build/test/typecheck/lint failed |

- **Overall /100** = weighted **geometric** mean over **active** dimensions (weights renormalized across the activated set). Geometric so a neglected dimension drags the score and can't be masked by maxing cheap ones.
- **Deterministic gate** (build · test · typecheck · lint) is the only hard stop — a failure maps to the GATED sentinel and is excluded from quality means. Security high/critical is an **advisory soft-cap** at the Fair ceiling + a blocking human review item, *not* a hard zero (no SAST exists to trust).
- **Grader (v1):** a pluggable jury that **defaults to Claude-only** (K=3–5 samples, temp 0, mean-aggregated). A non-Claude juror is optional/future config and is **not** required to ship. Claude self-preference is an accepted, documented v1 limitation — scores are advisory-only.
- The judge has the **full frozen repo snapshot** (not just the diff) and must grep/open it before marking UNKNOWN for a 'not visible' reason.

## Dimensions & weights (sum 100)

| # | Dimension | Weight | # sub-checks |
|---|---|---|---|
| 1 | Correctness & Logic Soundness | 26 | 9 |
| 2 | Security & Safety | 18 | 9 |
| 3 | Robustness & Contract Safety | 14 | 8 |
| 4 | Design & Architecture Fit | 14 | 7 |
| 5 | Maintainability & Simplicity | 12 | 8 |
| 6 | Test Meaningfulness | 8 | 9 |
| 7 | Scope Fidelity | 8 | 8 |

---

## 1. Correctness & Logic Soundness — weight 26

**Activation.** EVIDENCE RULE (applies to every sub-check): the judge has the FULL FROZEN REPO SNAPSHOT, not just the diff — before marking any sub-check UNKNOWN for a 'symbol/caller/counterpart-file/migration-list/pre-existing-test not visible' reason, the judge MUST open/grep the snapshot; UNKNOWN is reserved for genuinely external deps or runtime state not derivable from the repo. Active on every diff that changes runtime behavior (TS/JS logic, SQL migrations, prompt bodies that drive agent control flow, IPC/tRPC handlers, chokepoint routers). Dropped ONLY when the diff is exclusively non-behavioral: pure docs/markdown prose, formatting/whitespace, asset/config renames with no logic, or test-only files (test meaningfulness is owned by the Test dimension). If even one behavioral hunk exists, the dimension is active and grades that hunk.

**Ownership (de-dup).** Owns whether the changed code COMPUTES THE RIGHT ANSWER for intended, edge, and error inputs per the task/entity body as reference spec; whether an in-repo caller now reads a dropped/renamed field and produces a WRONG RESULT; hallucinated/non-existent API detection (advisory); and gross algorithmic-cost regressions (COR-9). Does NOT own: declared-T-vs-runtime-shape drift or one-sided IPC interface edits as a CONTRACT defect (ROB-1 is sole owner — charge here only the resulting wrong output at a specific caller); migration destructiveness/idempotency/collision (ROB-3/ROB-4 — here only code↔schema column consistency, COR-7); whether tests are meaningful (Test) or whether build/typecheck/lint/vitest pass (deterministic gate); off-chokepoint direct-entity-UPDATE (Robustness ROB-5); wrong abstraction level (Design); verbose-but-correct expression (Maintainability); unrequested features (Scope). When a defect is both 'wrong result' and 'wrong design', charge here only if the OUTPUT is wrong.

**Gate / cap behavior.** Sets the Correctness CONFIDENCE FLAG (advisory) whenever a risky changed path is corroborated ONLY by self-authored-green tests or is judge-UNKNOWN. SOFT CAP: if the primary behavioral change is corroborated solely by tests added in this same diff with no independent signal (pre-existing test, explicit reference-spec statement in the body, or judge line-by-line verification that the logic is demonstrably STRAIGHT-LINE), this dimension cannot exceed the Good ceiling (0.89) — the Excellent band requires at least one independent corroboration on the primary path, and judge self-verification counts as independent ONLY for demonstrably straight-line logic. DENOMINATOR FLOOR: if fewer than 2 sub-checks resolve non-UNKNOWN, cap at 0.89 and flag low-confidence. No hard gate on overall score; UNKNOWN sub-checks leave the denominator and are logged.

**Sub-checks:**

#### COR-1 · The primary changed logic (the riskiest behavioral hunk, judge-selected — not author-chosen) produces the behavior the task/entity body specifies for the stated happy-path inputs.
- **Pass** — Judge traces the changed code and confirms its output matches an explicit intended-behavior statement in the task/entity body or a pre-existing reference (test/spec).
- **Fail** — Traced output contradicts the spec's stated intended behavior, or inverts/misorders a documented step.
- **Unknown** — The body gives no concrete behavioral expectation for this path AND no pre-existing reference in the snapshot can be found to check against.
- **Evidence** — Cite the changed line(s) and the spec/body sentence (or pre-existing test) they are checked against; name which hunk was selected as primary and why.
- **Applies** — always

#### COR-2 · Independent corroboration exists for the primary changed path — a pre-existing test, an explicit reference-spec statement, or judge line-by-line verification of demonstrably STRAIGHT-LINE logic — not only tests added in this same diff.
- **Pass** — A pre-existing test exercises the path, OR the body specifies the exact expected result, OR the path is straight-line enough that the judge verifies it end-to-end from the diff with no hidden state.
- **Fail** — The only correctness evidence is tests added in this same diff AND the path has non-trivial branching/state the judge cannot fully verify by reading (trips the confidence flag and the 0.89 soft cap).
- **Unknown** — Judge cannot determine from the snapshot whether cited tests are pre-existing or newly added.
- **Evidence** — Name the corroboration source (test file path + pre-existing vs newly-added, body line, or the traced straight-line reasoning). Judge-only verification is NOT sufficient for a branch-heavy path.
- **Applies** — always

#### COR-3 · Edge and boundary inputs are handled correctly (empty/null/undefined, empty collections, zero/negative/overflow, duplicate/absent keys, first/last iteration).
- **Pass** — The changed code visibly guards or correctly handles the relevant edge inputs, or the judge confirms from the snapshot no such edge is reachable.
- **Fail** — A reachable edge input yields a wrong result, throw, NaN, off-by-one, or silent no-op (e.g., empty-array-truthy guard, missing null check before deref).
- **Unknown** — Reachability of the edge input depends on caller state not derivable even after grepping the snapshot.
- **Evidence** — Cite the line and the specific edge input; state the wrong output it produces.
- **Applies** — always

#### COR-4 · Error and failure inputs are handled per spec — invalid arguments, rejected promises, thrown exceptions, and failed lookups do not corrupt state or get silently swallowed.
- **Pass** — Error paths propagate, surface, or recover as the body/pattern requires; no bare catch drops a needed error; async rejections are awaited/handled.
- **Fail** — An error path is swallowed, mis-typed, left unawaited, or leaves partial/corrupt state that later code reads.
- **Unknown** — The diff does not touch error handling and no error path is introduced by the change.
- **Evidence** — Cite the try/catch, await, or rejection site and the swallowed/mishandled condition.
- **Applies** — only when the diff introduces or modifies error handling, async/promise flow, or external calls that can fail

#### COR-5 · No wrong-RESULT regression at an in-repo caller of a changed signature/return shape/enum: an existing call site now reads a dropped/renamed field, wrong arity/type, or old return semantics and therefore COMPUTES A WRONG OUTPUT.
- **Pass** — After grepping the snapshot for callers, every in-repo call site of the changed symbol either is updated consistently or is backward-compatible, so no caller produces a wrong result.
- **Fail** — A caller not updated in the diff now reads a renamed/removed field or relies on old semantics and yields a wrong runtime output.
- **Unknown** — Callers provably live outside the repo (external consumers) and cannot be enumerated from the snapshot.
- **Evidence** — Cite the changed signature line and at least one snapshot caller showing the wrong-output consequence. NOTE: pure declared-T-vs-runtime-shape drift or a one-sided IPC interface edit is charged to ROB-1, NOT here — charge here only when a concrete caller's OUTPUT is wrong.
- **Applies** — only when the diff changes a function/method signature, return shape, or exported enum/const consumed by in-repo callers

#### COR-6 · No hallucinated or non-existent API: called methods, imported symbols, config keys, MCP tool names, and DB columns referenced by the changed code actually exist (LLM-judged; the judge MUST grep the snapshot before verdict, advisory).
- **Pass** — Each referenced symbol/column/tool is found in the snapshot (or a dependency's types) via grep/open, or is unambiguously defined in the surrounding diff.
- **Fail** — The judge greps the snapshot and finds a call/import/column/tool that does not exist (typo'd method, invented option field, wrong package export, column not created by any migration).
- **Unknown** — Resolution depends on a third-party dependency whose types are not vendored in the snapshot and cannot be inferred.
- **Evidence** — Cite the referenced symbol/column, the grep that failed to resolve it, and label advisory (no symbol-resolver tool). Do NOT PASS on mere plausibility — resolution must be attempted against the snapshot.
- **Applies** — always

#### COR-7 · Code↔schema column consistency: every column/table the diff's added or changed queries READ or WRITE is actually created by a migration present in the snapshot.
- **Pass** — Each column referenced by a changed query is created by a migration file in the snapshot (existing or added in this diff).
- **Fail** — A changed query references a column/table that no migration creates.
- **Unknown** — The query targets a table whose migration definition is not in the snapshot and cannot be located by grep.
- **Evidence** — Cite the reading/writing query line and the creating (or missing) migration line. NOTE: migration destructiveness/idempotency/collision/schema-parity are charged to ROB-3/ROB-4, NOT here.
- **Applies** — only when the diff adds/edits a DB read/write or a query string

#### COR-8 · Control-flow and state invariants hold: no unconditionally shadowed branch, no inverted boolean/guard, no unreachable-after-early-return, no mutation that violates a documented immutability invariant (e.g., a field the body marks write-once is re-UPDATEd).
- **Pass** — Branch conditions, guards, and return points collectively realize the intended state machine; documented-immutable values are written exactly once.
- **Fail** — A condition is inverted, a branch is dead/shadowed, an early return skips required work, or code mutates a value the spec marks write-once/immutable.
- **Unknown** — The intended invariant is not stated in the body and cannot be inferred from surrounding snapshot code.
- **Evidence** — Cite the branch/guard/mutation line and the invariant it violates (quote the body if stated).
- **Applies** — always

#### COR-9 · No gross algorithmic-cost regression in the changed code: no obvious super-linear DB/loop cost (N+1 query in a loop, O(n^2) scan) on a hot path, no synchronous blocking call on the Electron main thread, and no unbounded in-memory accumulation on a per-event/per-stream path (LLM-judged, advisory).
- **Pass** — The changed hot-path code is at most linear in its input, does not issue per-iteration DB round-trips where a batch/join exists, does not block the main thread synchronously, and bounds any accumulator.
- **Fail** — The judge identifies an N+1 loop, an O(n^2)+ scan on a frequently-run path, a synchronous fs/exec/deep-compute call on the Electron main thread, or an unbounded buffer that grows per event.
- **Unknown** — The call frequency / input size cannot be judged from the snapshot (path may be cold), so cost impact is indeterminate.
- **Evidence** — Cite the loop/query/blocking-call line and the cost class; label advisory (no profiler/complexity tool).
- **Applies** — only when the diff adds/changes loops over collections, DB access, main-thread synchronous work, or per-event accumulation

---

## 2. Security & Safety — weight 18

**Activation.** EVIDENCE RULE: the judge has the full frozen snapshot and must trace tainted-value origins and sink definitions through it before falling to UNKNOWN. ALWAYS active. When the diff is provably inert on all attack surfaces (pure docs/markdown, comment-only, or test-fixture edits with zero runtime code, no new deps, no IPC/SQL/shell/DOM/fs/secret touch), the dimension collapses to the supply-chain (SEC-8) + secret (SEC-5) sub-checks; all attack-surface sub-checks go UNKNOWN and drop from the denominator rather than auto-passing. If literally nothing is checkable, report the dimension inactive so the geometric mean skips it (do not score zero sub-checks). DENOMINATOR FLOOR: with fewer than 2 non-UNKNOWN sub-checks, cap at 0.89 and flag low-confidence.

**Ownership (de-dup).** Owns ISO 25010 Security + Safety of CHANGED runtime code: injection/XSS sinks, unsafe deserialization/eval, path traversal, secret handling, trust-boundary/authz at IPC & spawn seams, least-privilege of granted capabilities (MCP allow/deny, tool allowlists, permission modes, spawn args), and unjustified NEW runtime dependencies. Owns the SECURITY facet of IPC typing — an `any`/`unknown`-passthrough payload that lets attacker-controlled fields REACH A SINK. Does NOT own: declared-T-vs-runtime parity with no security impact (ROB-1); off-chokepoint direct UPDATE (ROB-5); migration idempotency/collision (ROB-3/4) EXCEPT SQL-injection interpolation, charged here; @cyboflow-hidden/AbstractCliManager (Design DES-2); speculative over-generality (Design). Evidence is the judge's line-cited reasoning ONLY — there is NO SAST/secret-scanner/dependency-auditor.

**Gate / cap behavior.** Any CONFIRMED high/critical finding (command/SQL injection reachable from user/agent input, hardcoded live secret, auth-boundary bypass, eval/deserialization of untrusted data, path traversal to arbitrary fs write) is an ADVISORY SOFT-CAP capping the OVERALL score at Fair (<=0.69) and MUST emit a BLOCKING review_item — it is NOT a hard zero for this dimension (still scores by PASS fraction). A finding the judge cannot fully confirm (reachability uncertain) is a PLAUSIBLE confidence-flag: no soft-cap, FAILs its sub-check only if the insecure pattern is present, else UNKNOWN. Juror is Claude-only (K=3-5, temp 0); disagreement across samples on a soft-cap trigger must be surfaced, not mean-averaged away.

**Sub-checks:**

#### SEC-1 · No command/shell injection: child_process/PTY/CLI spawns built from static args or a safe argv array, never string-concatenated with user- or agent-controlled input.
- **Pass** — Every new/changed spawn, exec, execSync, shell:true, or PTY command uses a fixed argv array or values traced through the snapshot to be non-attacker-influenced; interpolated fragments are validated/escaped or a trusted constant.
- **Fail** — The diff introduces exec/execSync/shell:true/template-string command built with a session name, branch, path, prompt, model id, or other user/agent value reaching the shell without escaping.
- **Unknown** — The diff touches no process-spawn/shell surface, OR the origin of an interpolated value cannot be traced through the snapshot to confirm/deny attacker control.
- **Evidence** — Cite the spawn/exec line and the tainted variable + traced source, or state no spawn/shell sink is present.
- **Applies** — only when the diff touches child_process, node-pty, spawn/exec helpers, or command-string construction

#### SEC-2 · No SQL injection: all new/changed better-sqlite3 queries and migration DML use parameterized bindings, not string-interpolated runtime values.
- **Pass** — Every changed query interpolates only static SQL identifiers and passes runtime values via ?/named bindings; any dynamic identifier comes from a fixed allowlist visible in the snapshot.
- **Fail** — A changed query or migration concatenates/template-interpolates a runtime value (id, ref, body, filter) directly into the SQL string.
- **Unknown** — The diff contains no SQL/migration DML changes, OR an interpolated identifier's allowlist-safety can't be judged from the snapshot.
- **Evidence** — Cite the query/migration line showing parameterization vs interpolation, or state no SQL surface changed.
- **Applies** — only when the diff touches SQL query strings, prepared statements, or migration DML

#### SEC-3 · No XSS / unsafe DOM injection in changed renderer code: no new dangerouslySetInnerHTML/innerHTML/equivalent fed by non-constant/agent/user content.
- **Pass** — The diff adds no raw-HTML sink, OR any such sink is fed only sanitized or provably-constant content; agent/session-derived strings render as text.
- **Fail** — The diff introduces dangerouslySetInnerHTML/innerHTML/outerHTML/insertAdjacentHTML (or markdown-to-HTML without sanitization) fed by message/body/agent/user data.
- **Unknown** — No renderer/DOM code changed, OR the sink's input provenance/sanitization cannot be determined from the snapshot.
- **Evidence** — Cite the JSX/DOM sink line and its data source, or state no raw-HTML sink was added.
- **Applies** — only when the diff touches frontend renderer/React/DOM code or a markdown/HTML rendering path

#### SEC-4 · No unsafe deserialization/dynamic execution: no eval/new Function/vm on dynamic input, and JSON.parse of untrusted input is guarded (try/catch + shape validation).
- **Pass** — The diff adds no eval/new Function/vm on dynamic input; every new parse of external/agent/IPC data is error-wrapped and validated (e.g. zod) before fields are used.
- **Fail** — The diff adds eval/new Function/dynamic require of non-constant input, or parses attacker/agent-reachable JSON and consumes fields without validation.
- **Unknown** — No deserialization/dynamic-exec surface changed, OR the parsed data's trust level can't be inferred from the snapshot.
- **Evidence** — Cite the eval/parse line, its guard (or absence), and data source, or state no such surface changed.
- **Applies** — only when the diff adds eval/Function/vm or parses external/IPC/agent-supplied serialized data

#### SEC-5 · Secret handling is clean: no hardcoded credentials/tokens/keys committed, and secrets/env values are not written to logs, debug files, or error payloads.
- **Pass** — The diff introduces no literal API key/token/password/private-key, and any handled secret/env var is not passed into logger/console/debug-log/telemetry/error strings.
- **Fail** — The diff commits a real-looking secret literal, OR logs/serializes an env-derived credential (incl. into cyboflow-*-debug.log, telemetry scrub-bypass, or IPC error text).
- **Unknown** — The diff touches no credential/env/secret-adjacent code, OR a suspicious literal cannot be confirmed as a live secret vs placeholder/fixture.
- **Evidence** — Cite the literal or the log/serialize line handling the secret, or state no secret-handling surface changed.
- **Applies** — always (a committed secret can appear in any file), with attention to env access, logging, telemetry, config

#### SEC-6 · Least-privilege preserved: changes to capability grants (MCP allow/deny lists, tool allowlists, permission modes, sandbox/spawn flags) do not silently widen what an agent/run can do beyond the task's requirement.
- **Pass** — Any changed grant is equal-or-narrower, or a widening is explicitly required by the task spec; MCP deny/allow, disallowedTools, strictMcpConfig, permission-mode, and env-flag semantics are not weakened.
- **Fail** — The diff broadens agent/run privilege without task justification — removes a deny/disallowedTools entry, flips permission-mode to auto/bypass by default, disables strictMcpConfig, adds a dangerous auto-approve, or leaks a force-persistence/bypass env flag.
- **Unknown** — No capability/permission/MCP/spawn-flag surface changed, OR whether the widening is task-required can't be judged from the spec.
- **Evidence** — Cite the grant/flag line and its before→after privilege delta plus the task requirement, or state no capability surface changed.
- **Applies** — only when the diff touches MCP config, tool allow/deny lists, permission modes, sandbox flags, or spawn env/argv privilege

#### SEC-7 · Trust-boundary typing: new/changed IPC/tRPC payloads carrying attacker- or agent-controlled data are typed end-to-end (no `any`, no `unknown`-passthrough) so untrusted fields cannot REACH A SINK unvalidated.
- **Pass** — Changed handlers and their request/response interfaces are concretely typed and validated at the boundary; no `any`, and any `unknown` is narrowed via guard/zod before use at a security-relevant sink.
- **Fail** — A changed cross-boundary payload uses `any`, or forwards `unknown`/loosely-typed attacker-controlled fields straight into a query/spawn/DOM/fs sink without validation.
- **Unknown** — The diff touches no boundary payload, OR the field provably does NOT reach any security-relevant sink (then it is Correctness/Robustness parity, not here).
- **Evidence** — Cite the handler/interface line showing the type + the sink the field reaches, or state no security-relevant boundary payload changed. Do NOT re-charge a pure shape-drift already owned by ROB-1.
- **Applies** — only when the diff touches an IPC/tRPC handler, its request/response interface, or a boundary DTO carrying untrusted data that reaches a sink

#### SEC-8 · New runtime dependency is justified and minimal (supply-chain): any added production dependency is necessary, reputable, and not replaceable by existing utilities.
- **Pass** — The diff adds no new runtime dependency, OR each added dependency is directly required by the task, has no trivial in-repo/std-lib equivalent, and is mainstream/well-maintained.
- **Fail** — The diff adds a runtime dependency that is unnecessary (duplicates existing util), obscure/unmaintained/typosquat-risk, or pulls a broad transitive surface for a trivial need.
- **Unknown** — No package.json/lockfile runtime-dependency change is present, OR the package's provenance can't be assessed from the snapshot.
- **Evidence** — Cite the package.json/lockfile addition and the justification or the existing equivalent it duplicates, or state no runtime dep was added.
- **Applies** — only when the diff adds/changes a production (non-dev) dependency in package.json or the lockfile

#### SEC-9 · No path traversal / arbitrary file access: fs read/write/delete (or worktree/debug-log/artifact path construction) built from agent/session/user-controlled input (worktree path, session name, branch, log filename) is normalized and contained to an allowed root.
- **Pass** — Every new/changed fs.readFile/writeFile/unlink/mkdir/rename (or path.join into a filesystem op) either uses a trusted constant/derived-safe path or normalizes and validates the input path stays within an allowed base directory (no `..` escape).
- **Fail** — The diff builds a filesystem path from agent/session/user input and passes it to an fs op without normalization/containment, allowing `../` traversal or writing outside the intended worktree/root.
- **Unknown** — The diff touches no fs path construction, OR the path variable's origin cannot be traced through the snapshot to confirm attacker control.
- **Evidence** — Cite the fs op line and the tainted path variable + its traced source, or state no fs-path sink was added.
- **Applies** — only when the diff touches fs read/write/delete or constructs a filesystem path from dynamic input

---

## 3. Robustness & Contract Safety — weight 14

**Activation.** EVIDENCE RULE: the judge has the full frozen snapshot and MUST resolve counterpart interfaces, caller sets, the migrations directory listing, and helper bodies from it before marking UNKNOWN — 'not visible in the diff' is NOT grounds for UNKNOWN when the file exists in the snapshot. ACTIVE whenever the diff touches runtime code that crosses a contract or persistence boundary: an IPC/tRPC channel or its request/response interface, a shared/exported signature with downstream callers, a SQL migration or schema, an entity/review/artifact write path, async/concurrent code, an error/logging path, a localStorage key rename, or a resource that must be released. DROPPED (whole dimension excluded, activation vector logged) only when the diff is exclusively non-runtime surface — pure docs/markdown prose, comments, static asset/style tweaks, or test-only files with no boundary/migration/concurrency touch. Each sub-check self-activates by its own scope. DENOMINATOR FLOOR: fewer than 2 non-UNKNOWN sub-checks caps at 0.89 and flags low-confidence.

**Ownership (de-dup).** Owns CONTRACT INTEGRITY and RUNTIME SAFETY: declared-T-vs-runtime-shape parity and one-sided IPC interface drift (ROB-1 is the SOLE owner of the silent-drop CONTRACT defect), backward-compat of changed shared signatures on untouched callers, migration idempotency/destructiveness/collision/schema-parity, off-chokepoint direct entity UPDATE (ROB-5 owns the chokepoint-bypass defect, NOT Design), observability/error-swallowing incl. dropped optional logger (ROB-6 is the SOLE owner of logger-omission), resource cleanup, and hand-rolled localStorage key renames (ROB-8). Does NOT own: wrong abstraction level / speculative generality (Design); verbose expression (Maintainability); unrequested functionality (Scope); whether the happy-path logic is CORRECT (Correctness); @cyboflow-hidden/AbstractCliManager preservation (Design DES-2); test meaningfulness (Test) or gate pass/fail. The `any`-type ban is charged here ONLY as an IPC/tRPC parity smell masking a boundary shape; a stray `any` elsewhere is Maintainability.

**Gate / cap behavior.** (1) A CONFIRMED destructive/irreversible migration op on an existing table (dropped/renamed column, non-idempotent bare CREATE, NOT NULL without default/backfill) SOFT-CAPS this dimension at Poor (<0.40) and raises a confidence flag. (2) A CONFIRMED off-chokepoint direct UPDATE to ideas/epics/tasks/review_items/artifacts (raw SQL bypassing the routers) likewise soft-caps at Poor. (3) A CONFIRMED migration number collision with an existing/main migration soft-caps at Poor (MEMORY documents live 035-039 collisions across sibling branches). (4) A CONFIRMED IPC/tRPC silent-drop is a confidence-flag finding even if isolated. When boundary-dense and the judge cannot resolve a shape even from the snapshot, prefer UNKNOWN and log low-confidence rather than guess PASS.

**Sub-checks:**

#### ROB-1 · IPC/tRPC type-parity (SOLE OWNER of the silent-drop contract defect): every changed channel/handler's declared response T matches what it returns at runtime, request/response interfaces are edited SYMMETRICALLY on both frontend and main (confirmed by opening both files in the snapshot), no local IPCResponse/{success,data?,error?} is re-declared instead of importing from frontend/src/utils/api.ts, and tRPC onData types are AppRouter-inferred, not hand-mirrored.
- **Pass** — Every touched channel's declared T agrees with the runtime return/emit shape, the counterpart-side interface (opened from the snapshot) matches, and no local IPCResponse redeclaration or (evt: unknown)+guard onData mirror appears.
- **Fail** — A handler returns/emits a field not in its declared T (or declares a field it never returns), OR a request/response interface is changed on one side only (the counterpart in the snapshot still has the old shape), OR a local IPCResponse is redeclared, OR an onData type is a hand-written mirror.
- **Unknown** — The counterpart file genuinely does not exist in the snapshot (e.g. a brand-new channel with no consumer yet) so symmetry has no reference.
- **Evidence** — Cite the channel/interface name, the declared-T file:line, and the counterpart-side file:line opened from the snapshot (or note the runtime return mismatch).
- **Applies** — only when the diff touches an IPC handler, a tRPC router/subscription, or a request/response interface crossing main↔frontend

#### ROB-2 · Backward-compat on untouched downstream callers: when the diff changes a shared/exported signature (params, return type, enum/union members, DB row shape, or a threaded positional-arg contract), all EXISTING callers found by grepping the snapshot remain type-valid and semantically correct.
- **Pass** — The change is additive/optional (new optional param, widened union, nullable column), OR every affected caller found in the snapshot is updated in the diff.
- **Fail** — A required param is added/removed/reordered, a return shape narrows, or a union/enum member is removed while a snapshot caller not in the diff still relies on the old contract and would break or silently mis-behave.
- **Unknown** — The full caller set provably extends outside the repo (external consumers) and no positive evidence of breakage is derivable from the snapshot.
- **Evidence** — Cite the changed signature file:line and at least one grepped caller site (or the positional-arg chain, e.g. runs.start zod → launch arg N → createRun) showing mismatch or compatibility.
- **Applies** — only when the diff modifies an exported/shared function signature, shared type, threaded positional-arg contract, or persisted row shape consumed beyond the diff

#### ROB-3 · Migration safety (SOLE OWNER of destructiveness/idempotency/parity): any new migration is forward-only, uses idempotent CREATE (IF NOT EXISTS/guarded), performs no destructive/irreversible ALTER on existing tables (no column drop/rename, no NOT NULL without default/backfill), and carries the accompanying schema-parity update.
- **Pass** — The migration only adds tables/columns/indexes idempotently, any new NOT NULL column has a default or backfill, no existing column is dropped/renamed, and the schema-parity artifact expected by test:unit is updated in the same diff.
- **Fail** — The migration drops/renames a column on an existing table, adds NOT NULL without default/backfill, uses a bare non-idempotent CREATE that would throw on re-run, or omits the required schema-parity update.
- **Unknown** — The parity artifact's location cannot be located in the snapshot even by grep — exclude only the parity clause; still judge destructive/idempotent clauses from the SQL present.
- **Evidence** — Cite the migration file:line for each SQL op and the schema-parity file (or its absence).
- **Applies** — only when the diff adds/edits a file under the migrations directory or the schema/parity snapshot

#### ROB-4 · Migration chain/collision integrity: BEFORE verdict the judge MUST enumerate the migrations directory in the snapshot; the new migration number must be strictly greater than the current max, collide with no existing/sibling migration, and be contiguous with the chain.
- **Pass** — After listing the migrations directory, the new index is unique and monotonically after the highest existing migration with no chain-breaking gap, and no other file (in the diff or snapshot) claims the same number.
- **Fail** — The migration number duplicates an existing/snapshot migration (e.g. another 036), is out of order, or the diff introduces two migrations with the same index.
- **Unknown** — The migrations directory is genuinely absent from the snapshot so no existing numbers can be enumerated (should be rare).
- **Evidence** — Cite the new migration filename/number and the enumerated directory listing showing the collision or the clear max.
- **Applies** — only when the diff adds a new migration file

#### ROB-5 · Chokepoint & concurrency safety (SOLE OWNER of off-chokepoint bypass): all writes to ideas/epics/tasks/review_items/artifacts go through TaskChangeRouter.applyChange / ReviewItemRouter / ArtifactRouter (no raw UPDATE/INSERT bypassing them, incl. raw-UPDATE-with-no-emit), and async write/read paths have no missing await, TOCTOU race, or re-entrant double-write.
- **Pass** — Every entity mutation routes through the correct router chokepoint (confirmed by opening the helper body in the snapshot if needed), awaited promises are actually awaited, and read-then-write sequences are atomic or guarded.
- **Fail** — The diff issues a direct SQL UPDATE/INSERT to a canonical entity/review/artifact table (or a raw UPDATE with no session-updated emit, the chatSentinel class of bug), drops an await on a write, has a check-then-act interleaving window, or double-writes on re-entry.
- **Unknown** — A called helper's routing cannot be confirmed because its body is genuinely absent from the snapshot — exclude that call; still FAIL on any raw SQL visible in the diff.
- **Evidence** — Cite the write/await/race file:line and name the chokepoint bypassed (or confirmed).
- **Applies** — only when the diff touches an entity/review/artifact write path or introduces/edits async or concurrent control flow

#### ROB-6 · Observability & error handling (SOLE OWNER of dropped-logger): errors are not silently swallowed, the optional logger contract is honored (a logger?/observability sink is passed where the surrounding code threads one, since omitting it no-ops diagnostics — TypedEventNarrowing/RawEventsSink/MessageProjection and peers), and fail-soft debug-log paths degrade without throwing.
- **Pass** — New catch blocks log or propagate (no empty/comment-only catch), an available logger/sink is threaded into observability-consuming classes rather than omitted, and debug-log writes are best-effort/guarded.
- **Fail** — A catch swallows an error with no log/rethrow, a logger/optional sink the call site has access to is dropped (silently no-oping diagnostics), or an error path can crash a fail-soft debug-log write.
- **Unknown** — Whether a logger is available to thread at the call site cannot be determined even after opening the constructor signature in the snapshot.
- **Evidence** — Cite the catch block or constructor/call file:line and the omitted logger arg or swallowed error.
- **Applies** — only when the diff adds/edits try/catch, error propagation, an observability/logger-consuming class, or a debug-log write path

#### ROB-7 · Resource cleanup & unhandled rejections: PTY/child processes, subscriptions, timers, file handles, sockets, and event listeners opened in the diff are released on all exit paths (incl. error/cancel), and no newly-introduced async work is left as a floating unhandled promise.
- **Pass** — Every acquired resource has matching teardown on success AND failure/cancel paths (finally/dispose/kill/unsubscribe), and every spawned async task is awaited, returned, or explicitly fire-and-forget with a caught rejection.
- **Fail** — A resource (listener, subscription, timer, PTY/process, handle) is created without release on some reachable path, OR a promise is launched with no await/catch so a rejection would be unhandled.
- **Unknown** — Cleanup provably occurs in an out-of-diff owner whose body is absent from the snapshot and no evidence either way is derivable.
- **Evidence** — Cite the acquisition file:line and the missing/present teardown site (or the floating promise).
- **Applies** — only when the diff acquires a process/subscription/timer/handle/listener or introduces new async fire-and-forget work

#### ROB-8 · localStorage key renames use the sanctioned utility: any localStorage key rename in the diff goes through frontend/src/utils/migrateLocalStorageKey.ts with the mount-only call contract, not hand-rolled getItem/setItem rename logic.
- **Pass** — The diff introduces no localStorage key rename, OR every rename delegates to migrateLocalStorageKey at a mount-only call site per the contract.
- **Fail** — The diff hand-rolls a getItem(old)+setItem(new)+removeItem rename (or reads old-then-new inline) instead of using migrateLocalStorageKey, risking lost/duplicated user state.
- **Unknown** — The diff touches localStorage reads/writes but it cannot be determined from the snapshot whether a KEY RENAME (vs a normal new key) is occurring.
- **Evidence** — Cite the localStorage rename file:line and the presence/absence of the migrateLocalStorageKey call.
- **Applies** — only when the diff renames or migrates a localStorage key

---

## 4. Design & Architecture Fit — weight 14

**Activation.** EVIDENCE RULE: the judge has the full snapshot and must inspect the surrounding class structure / call graph / seam definitions before marking UNKNOWN. ACTIVE whenever the diff adds or changes production code that participates in the architecture — new modules, services, routers, IPC/tRPC handlers, spawn/facade seams, data-flow wiring, or edits to entity/review/artifact write paths, CLI-manager classes, or @cyboflow-hidden regions. DROPPED (whole dimension excluded) only when the diff is exclusively docs/markdown, comments, test-only files, pure copy/string changes, config/version bumps, or asset changes with zero production-logic wiring. DENOMINATOR FLOOR: fewer than 2 non-UNKNOWN sub-checks caps at 0.89 and flags low-confidence.

**Ownership (de-dup).** Owns whether the change fits the EXISTING architecture at the RIGHT abstraction level: module-boundary placement, reuse of the sanctioned seam vs a parallel bespoke path, honoring preserved extension points (DES-2 is the SOLE OWNER of AbstractCliManager-collapse and @cyboflow-hidden deletion/mislabel across all dimensions), WRONG-ABSTRACTION over-engineering (speculative generality, needless indirection, single-caller factories/interfaces), and IPC boundary PLACEMENT (DES-5, distinct from ROB-1's shape-drift). Does NOT own: verbose-but-correct expression (Maintainability); UNREQUESTED features/scope creep (Scope); off-chokepoint direct entity UPDATE (Robustness ROB-5); correctness/logic bugs (Correctness); test meaningfulness (Test); declared-T-vs-runtime shape-drift as a runtime defect (ROB-1) — DES-5 judges only boundary type PLACEMENT and must not re-charge a drift ROB-1 already failed.

**Gate / cap behavior.** No hard gate on overall score. SOFT-CAP: if DES-2 (collapses/prunes a preserved extension point like AbstractCliManager or its live PTY methods, or deletes/marks @cyboflow-hidden on live code) is FAIL, cap this dimension at Fair (<=0.69) and set a confidence flag noting an architectural-invariant breach. CONFIDENCE-FLAG (not a cap): if 3+ sub-checks are UNKNOWN after snapshot inspection, flag the dimension low-confidence. No deterministic tool backs this dimension — all verdicts are line-cited judgment.

**Sub-checks:**

#### DES-1 · No NEW parallel write ABSTRACTION: a write to ideas/epics/tasks/entity_events/review_items/artifacts is routed through the sanctioned chokepoint rather than a newly-introduced hand-rolled service/helper that duplicates the router's role.
- **Pass** — Every added/modified entity or review/artifact write flows through the existing router chokepoint, OR the diff adds no such writes.
- **Fail** — The diff introduces a NEW service/helper/abstraction that mutates those tables/domain alongside the sanctioned chokepoint (a competing write pathway).
- **Unknown** — The write target is ambiguous (helper whose table cannot be resolved even after opening it in the snapshot).
- **Evidence** — Cite the file:line of the new write abstraction and the chokepoint it parallels. NOTE: a direct raw SQL UPDATE bypassing the chokepoint is charged to ROB-5, not here — here only judge whether a NEW parallel write ABSTRACTION was introduced.
- **Applies** — only when the diff adds a new code path that mutates entity, review_item, or artifact state

#### DES-2 · SOLE OWNER of preserved-seam/hidden-code integrity: AbstractCliManager is not collapsed into ClaudeCodeManager; the LIVE dual-substrate PTY methods (spawnPtyProcess/setupProcessHandlers/killProcessTree) are not pruned or relabeled @cyboflow-hidden; @cyboflow-hidden code is neither deleted nor added to actively-called code.
- **Pass** — AbstractCliManager stays a standalone extension surface, the interactive-substrate PTY methods remain intact and un-relabeled, and every @cyboflow-hidden touch matches the annotation contract (not deleting future-reachable code, not marking live code).
- **Fail** — The diff inlines/removes AbstractCliManager (or its live PTY methods), marks the load-bearing PTY methods @cyboflow-hidden, deletes an @cyboflow-hidden block, or stamps @cyboflow-hidden onto code that is actually reached (confirmed live by grepping call sites in the snapshot).
- **Unknown** — Whether the annotated code is truly live/dead cannot be determined even after grepping call sites in the snapshot.
- **Evidence** — Cite the touched file:line in main/src/services/panels/cli/ or the removed/annotated block and the invariant implicated. This is the SOLE dimension charging this defect; a FAIL here triggers the Fair soft-cap.
- **Applies** — only when the diff touches AbstractCliManager, ClaudeCodeManager, interactiveClaudeManager, the substrate facade/seam, or any @cyboflow-hidden-annotated region

#### DES-3 · No wrong-abstraction over-engineering: added interfaces, factories, generic type params, base classes, or indirection layers are justified by an actual current second caller/variant (found by grepping the snapshot) — not speculative generality.
- **Pass** — Every new abstraction has >=2 concrete uses now (confirmed via snapshot grep) OR is an explicitly preserved extension point; simple in-scope logic is expressed directly.
- **Fail** — The diff adds an interface/factory/generic/indirection with exactly one caller and no preserved-extension-point mandate, or wraps a trivial operation in needless layers for anticipated future flexibility.
- **Unknown** — A second consumer would provably live outside the repo and the task spec is silent on multi-variant intent.
- **Evidence** — Cite the abstraction file:line and the grepped count of concrete call sites; name the speculative-generality symptom (single-impl interface, one-branch factory, unused generic param).
- **Applies** — only when the diff introduces new interfaces, factories, abstract/base classes, generics, or indirection wrappers

#### DES-4 · Code is placed at the correct module boundary per the layer stack (shared/ types, main/orchestrator vs services vs db, frontend/): domain/orchestration logic is not embedded in a renderer component, and shared cross-boundary types live in shared/ rather than being redeclared per side.
- **Pass** — New logic sits in the layer owning that concern (spawn/registry logic in main orchestrator/services, board/entity rules behind the router, UI-only concerns in frontend) and cross-boundary types are defined once in shared/.
- **Fail** — The diff puts backend/orchestration/business logic inside a frontend component, reaches across a layer boundary directly, or duplicates a cross-boundary type on both sides instead of importing from shared/.
- **Unknown** — The file's architectural layer or the intended home of the logic cannot be determined from the path and snapshot.
- **Evidence** — Cite the file path (its layer) and the misplaced logic's line, or the two divergent type declarations.
- **Applies** — always (whenever the dimension is active)

#### DES-5 · IPC/tRPC boundary is wired the sanctioned way (PLACEMENT only): no local re-declaration of IPCResponse/{success,data,error}; IPCResponse<T> callers pass an explicit T; request/response interfaces are shared (promoted to shared/types/ipc.ts) not mirrored divergently; tRPC onData types come from AppRouter inference.
- **Pass** — New/edited IPC or tRPC surface imports the canonical wrapper/types, threads an explicit T, and single-sources request/response shapes.
- **Fail** — The diff introduces a local IPCResponse shape, an IPCResponse without explicit T, a hand-mirrored request/response interface, or an onData payload typed via a local mirror / (evt: unknown)+guard.
- **Unknown** — The counterpart declaration is genuinely absent from the snapshot so placement cannot be assessed.
- **Evidence** — Cite the handler/interface file:line and the wrapper/type import (or the local redeclaration). Judge only PLACEMENT — a resulting runtime shape-drift bug is charged to ROB-1 and must NOT be re-charged here.
- **Applies** — only when the diff adds or changes an IPC handler, tRPC procedure/subscription, or a request/response interface crossing main↔frontend

#### DES-6 · Change extends an existing seam instead of forking a parallel mechanism: it reuses the established single-source pattern (e.g. substrate resolves ONCE at the CliManagerFactory/SubstrateDispatchFacade seam and threads via run.substrate; the workflow model pin threads through the existing createRun→spawner chain) rather than adding a second competing pathway for the same concern.
- **Pass** — The diff plugs into the existing single-source seam for the concern it touches, with no duplicate/competing mechanism introduced.
- **Fail** — The diff adds a second resolution point for an already-once-resolved concern (e.g. re-deriving substrate downstream) or threads state via an ad-hoc side channel instead of the established chain.
- **Unknown** — Whether an existing canonical seam covers this concern cannot be established even after inspecting the referenced seam in the snapshot.
- **Evidence** — Cite the diff's new pathway file:line and the existing seam it should have used (or did use). NOTE: localStorage-rename seam reuse is charged to ROB-8, not here.
- **Applies** — only when the diff touches a concern with an established single-source seam (substrate resolution, run-config threading, spawn/facade wiring)

#### DES-7 · New logger/collaborator-accepting classes are WIRED so they can structurally receive the sink: the diff does not construct such a class via a bespoke path that structurally cannot accept the injected observability collaborator.
- **Pass** — New instances of logger/dependency-accepting classes are constructed via a path that can and does supply the collaborator per convention, OR the diff constructs no such classes.
- **Fail** — The diff introduces a NEW construction path for one of these classes that structurally cannot receive the logger/collaborator (a wiring/placement defect that guarantees no-op diagnostics).
- **Unknown** — Whether the constructed class accepts the collaborator cannot be determined even after opening its signature in the snapshot.
- **Evidence** — Cite the construction site file:line and the structural wiring defect. NOTE: a simple omission where the call site COULD pass the logger is charged to ROB-6, not re-charged here.
- **Applies** — only when the diff introduces a new construction/wiring path for a class that accepts an optional logger or injected observability collaborator

---

## 5. Maintainability & Simplicity — weight 12

**Activation.** EVIDENCE RULE: the judge may open the full file in the snapshot to gauge true function/file size and whether a cleaner shared util exists before marking UNKNOWN. ACTIVE whenever the diff adds or modifies human-authored source (TS/TSX, SQL migrations, markdown workflow prompts, config). DROPPED only when the diff is pure generated/lockfile/vendored output, a pure binary/asset change, or a pure revert with no net new authored lines. If the diff is trivially small (<=5 net authored lines) the dimension still runs but sub-checks that find no touchpoint resolve UNKNOWN rather than PASS.

**Ownership (de-dup).** Owns VERBOSE EXPRESSION of in-scope code (needless length, over-commenting, redundant local abstraction, dead-weight wrappers), naming clarity, and comment intent. Does NOT own: WRONG ABSTRACTION LEVEL / speculative generality reaching beyond the task (Design); UNREQUESTED functionality (Scope); off-chokepoint UPDATE or dropped-logger as a correctness/robustness fault (Robustness — the same code may still be judged here purely for readability); lint/formatting conformance (deterministic lint gate — never rewarded/penalized here); test meaningfulness (Test) or gate pass/fail. When a construct is both over-abstracted-beyond-scope AND verbose, charge the beyond-scope aspect to Design and only the in-scope verbosity here.

**Gate / cap behavior.** No hard gate (advisory, weighted below Security). SOFT-CAP: if MTN-2 (naming) AND MTN-4 (function/file size) both FAIL, cap this dimension at Fair (<=0.69). CONFIDENCE-FLAG (not a score change) raised when >40% of sub-checks resolve UNKNOWN. The `any`-type observation (MTN-6) is a readability signal here only; its authoritative penalty lives in the lint gate, so a FAIL here must NOT also be double-charged as a gate failure. DENOMINATOR FLOOR: fewer than 2 non-UNKNOWN sub-checks caps at 0.89.

**Sub-checks:**

#### MTN-1 · Comments justify WHY (non-derivable intent/rationale/gotcha) rather than restating WHAT the next line already says.
- **Pass** — Every added comment encodes non-derivable intent (a why, constraint, invariant, cross-file contract, workaround rationale) OR there are no added comments; restated-code comments are absent or negligible (<=1 incidental).
- **Fail** — Two or more added comments merely paraphrase the adjacent statement or narrate obvious control flow, adding no intent a competent reader couldn't derive.
- **Unknown** — Hunks lack enough context to tell whether a comment restates its referent and the full file was not read.
- **Evidence** — Cite comment lines with file:line and classify each as why-intent vs what-restatement.
- **Applies** — only when the diff adds or edits comments

#### MTN-2 · Identifiers (functions, vars, types, columns, props) are descriptive and self-explanatory at their scope, without cryptic abbreviations or misleading names.
- **Pass** — New/renamed identifiers convey role at a glance; no single-letter/opaque abbreviations outside idiomatic loop indices; names match the value's actual runtime meaning.
- **Fail** — Multiple new identifiers are cryptic (e.g. d2, tmp3, handleThing), misleadingly named vs their value, or semantically collide with existing well-known names in the file.
- **Unknown** — The diff introduces 0-1 identifiers so a clarity judgment is not meaningful, or names reference domain terms not evaluable even with snapshot context.
- **Evidence** — Cite the identifier names with file:line and state why each is clear or cryptic/misleading.
- **Applies** — always (any authored code touch)

#### MTN-3 · No comment-stuffing / banner noise: no redundant docblock padding, decorative separators, commented-out code, or TODO litter that inflate size without adding intent.
- **Pass** — Added comments are proportionate; no commented-out code blocks left behind, no decorative ASCII banners, no vacuous JSDoc repeating the signature.
- **Fail** — Diff contains commented-out dead code, decorative banner comments, or boilerplate docblocks restating the signature/params with no added meaning.
- **Unknown** — Cannot determine from the hunk whether a commented block is intentional documentation vs abandoned code, and the full file was not read.
- **Evidence** — Cite the offending comment/dead-code lines with file:line.
- **Applies** — only when the diff adds comments or removes/leaves commented-out code

#### MTN-4 · New/changed functions and files stay within reasonable size and single-responsibility; no sprawling mega-function or god-file introduced for in-scope work.
- **Pass** — Added functions are cohesive and readable end-to-end without excessive nesting; no single new function balloons far beyond the complexity its task warrants; no new file mixes many unrelated responsibilities.
- **Fail** — A new/changed function is excessively long or deeply nested for what it does, or a new file dumps unrelated concerns together, making local reasoning hard.
- **Unknown** — The function/file body is only partially shown and the judge did not open the full file in the snapshot to gauge true size.
- **Evidence** — Cite the function/file with approximate added line count and nesting depth, file:line.
- **Applies** — only when the diff adds or substantially rewrites a function or file

#### MTN-5 · In-scope logic is expressed concisely — no redundant intermediate variables, duplicated blocks, or verbose restatement where an existing shared util/pattern reads cleaner.
- **Pass** — Changed code avoids obvious local duplication and needless verbosity; repeated in-scope logic is factored or uses an existing helper where that improves readability.
- **Fail** — The diff repeats a near-identical block multiple times, threads pointless pass-through locals, or hand-rolls verbose logic that an obvious existing in-file/shared utility would express more clearly.
- **Unknown** — Whether a cleaner shared util exists cannot be confirmed even after a snapshot grep the judge attempted.
- **Evidence** — Cite the duplicated/verbose spans (file:line x2+) or redundant locals; name the cleaner form if asserting one exists.
- **Applies** — always (any authored code touch)

#### MTN-6 · Type annotations aid readability without `any`: added TS uses `unknown`+guards or precise types, keeping call sites self-documenting (readability lens only; lint gate owns the hard penalty).
- **Pass** — No new `any` (explicit or via `as any`) is introduced in authored TS; added types make boundary shapes legible.
- **Fail** — The diff introduces `any`/`as any` or an untyped catch-all that obscures the real shape and hurts a reader's ability to know what flows through.
- **Unknown** — The change touches no TypeScript, or the annotation is generated/inferred and not visible in the hunk.
- **Evidence** — Cite the `any` occurrence or opaque annotation with file:line.
- **Applies** — only when the diff adds or edits TypeScript type annotations

#### MTN-7 · Migration SQL and workflow-prompt markdown, when touched, are readable: migration has a clear intent (comment/name) and is not a wall of unexplained ALTERs; prompt edits stay coherent, not bloated with contradictory instructions.
- **Pass** — A touched migration is self-describing (clear filename/leading comment) and each statement's purpose is evident; touched prompt markdown reads cleanly without redundant/conflicting stanzas.
- **Fail** — A migration is an opaque batch of ALTERs with no intent comment/name, or prompt markdown is padded with duplicated/contradictory instruction blocks that would confuse a future editor.
- **Unknown** — The diff touches no migration or workflow-prompt markdown.
- **Evidence** — Cite the migration/prompt file with file:line and describe the clarity defect or its absence.
- **Applies** — only when the diff touches a SQL migration or a workflow-prompt .md file

#### MTN-8 · No over-abstraction of in-scope code: the change does not wrap simple in-scope logic in gratuitous layers (single-use factories, one-line wrapper indirections, config objects for a fixed value) that add reading cost without payoff.
- **Pass** — In-scope logic is implemented at the flattest level that works; any new indirection earns its keep by removing real duplication or clarifying intent.
- **Fail** — The diff introduces a wrapper/indirection/config-object used exactly once for in-scope work that a direct call would express more clearly, with no dedup or clarity payoff.
- **Unknown** — Whether the abstraction has other call sites (justifying it) cannot be confirmed even after a snapshot grep; if it plausibly reaches beyond the task it belongs to Design — mark UNKNOWN here.
- **Evidence** — Cite the wrapper/indirection with file:line and note its single in-scope use.
- **Applies** — only when the diff introduces a new local abstraction/wrapper for in-scope logic

---

## 6. Test Meaningfulness — weight 8

**Activation.** EVIDENCE RULE: the judge may open referenced test files in the snapshot to read assertion bodies before marking UNKNOWN; UNKNOWN 'body not visible' is reserved for truly absent files. ACTIVE whenever the diff changes runtime behavior in any workspace (main/frontend/shared): new/modified functions, branches, schemas, migrations, IPC handlers, routers, or bug fixes. DROPPED (whole dimension excluded, not scored 0) ONLY when the diff is purely non-behavioral: docs/markdown-only, comments, pure formatting/whitespace, string/asset renames with no logic, or config that cannot alter code paths. If ANY behavioral change is present, the dimension is active even with zero test files shipped (triggers the gate).

**Ownership (de-dup).** Owns ONLY the MEANINGFULNESS of tests: whether assertions pin intended behavior, cover edge/error paths, would fail on regression, and whether an existing assertion was silently weakened. Does NOT own whether tests/build/typecheck/lint pass (deterministic gate + Correctness corroboration signal), whether production code is correct (Correctness) or well-designed (Design), or migration correctness itself (Robustness) — only whether a migration/schema-parity change carries a MEANINGFUL test. A missing test for a behavior change is charged HERE (poor coverage); the resulting untested-correctness risk is flagged to Correctness via the confidence flag, not double-scored.

**Gate / cap behavior.** GATE-DODGE: if the diff is behavior-changing and ships ZERO runnable tests reaching the changed path, force this dimension to Poor (score 0), raise the Correctness confidence flag, and mark the run low-confidence. SOFT-CAP: if tests exist but are all always-green/tautological/pure implementation snapshots (no behavioral assertion that could fail on regression), cap at Fair (<=0.69). No gate when the dimension is legitimately DROPPED (non-behavioral diff).

**Sub-checks:**

#### TST-1 · Behavior-changing diff ships at least one runnable test exercising the changed code path.
- **Pass** — At least one new/modified test file (*.test.ts/*.spec.ts or vitest suite) directly imports/invokes the changed function, handler, router, or schema and asserts on its result.
- **Fail** — The diff changes runtime behavior but adds/modifies no test reaching the changed path (gate-dodge).
- **Unknown** — Never for a behavioral change with no test file present — that is FAIL. UNKNOWN only when the judge confirms via the snapshot that an existing untouched test already fully covers the path.
- **Evidence** — Cite the test file path + the import/call of the changed symbol, or state no test reaches the changed module.
- **Applies** — always (when dimension active)

#### TST-2 · Assertions pin INTENDED behavior, not implementation trivia or tautology.
- **Pass** — Assertions check observable outputs/return values/state transitions tied to task intent (expected entity stage, mapped field value, thrown error) and would fail if the logic regressed.
- **Fail** — Assertions are tautological (expect(x).toBe(x)), assert only a mock was called with test-hard-coded args, only check truthiness/typeof, or snapshot the exact implementation shape so any refactor breaks them without catching behavior regressions.
- **Unknown** — The test body is truly absent from the snapshot (referenced but file not present).
- **Evidence** — Cite specific assertion lines and what real behavior each pins (or why trivial/tautological).
- **Applies** — always (when dimension active)

#### TST-3 · Edge and error cases for the changed logic are covered.
- **Pass** — Tests include at least one non-happy-path case relevant to the change: null/undefined/empty input, boundary value, invalid state, error/throw path, or the specific failure the fix addresses.
- **Fail** — Only a single happy-path case is asserted while the changed code contains visible branches, guards, error throws, or nullable inputs that go unexercised.
- **Unknown** — The changed logic has no branches/error paths (straight-line pure mapping) so edge cases are not applicable — exclude from denominator.
- **Evidence** — Cite the branch/guard/throw in the production diff and the corresponding test case, or note the missing edge case.
- **Applies** — only when the changed production code contains conditionals, guards, error handling, or nullable/optional inputs

#### TST-4 · Defect-correcting diffs include a regression test that fails without the fix (keyed on whether the CODE corrects a defect, not the author's commit-type label).
- **Pass** — For a change the judge reads as correcting a defect (a guard added, a condition inverted-back, an off-by-one fixed, a null-deref closed), a test reproduces the failing input/state and asserts the corrected output such that reverting the production change flips it red.
- **Fail** — A defect-correcting change ships with no test reproducing the defect, or with a test that would pass even against the pre-fix code.
- **Unknown** — The diff introduces genuinely new behavior with no identifiable pre-existing defect being corrected (pure feature) — exclude from denominator.
- **Evidence** — Cite the fix hunk (the specific corrected logic) and the regression test's input→expected assertion, reasoning whether it fails pre-fix. Do NOT rely on the commit-message type string.
- **Applies** — only when the diff's code changes correct a defect (judged from the code, not the label)

#### TST-5 · Migration / schema-parity changes carry the expected cyboflow-tier test.
- **Pass** — A migration/DB-schema change is accompanied by a migration test (applies migration + asserts resulting shape/data) and, where a shared type mirrors the schema, the schema-parity test row is updated so drift fails the build.
- **Fail** — A migration or schema-mirroring type changes but no migration test asserts the new shape and/or the schema-parity test is left stale.
- **Unknown** — The diff touches no migration and no schema-parity-guarded type — exclude from denominator.
- **Evidence** — Cite the migration file + the migration/parity test (or its absence), naming the schema-parity suite if present.
- **Applies** — only when the diff adds/edits a migration or a type that a schema-parity test guards

#### TST-6 · IPC/tRPC contract changes are covered by a test asserting the full runtime payload shape.
- **Pass** — A changed IPC/tRPC handler or request/response interface has a test asserting the handler returns the declared T's fields at runtime (or a parity test comparing frontend↔main shapes), catching silent-drop drift.
- **Fail** — An IPC/tRPC handler or its request/response interface changes with no test pinning the returned payload shape.
- **Unknown** — The diff touches no IPC/tRPC boundary or handler contract — exclude from denominator.
- **Evidence** — Cite the handler/interface change and the test asserting its payload fields, or note the absence.
- **Applies** — only when the diff modifies an IPC/tRPC handler, channel, or a request/response interface crossing that boundary

#### TST-7 · Chokepoint/router writes are verified through the router, not bypassed in the test.
- **Pass** — Tests for entity/review/artifact behavior drive writes through the real TaskChangeRouter/ReviewItemRouter/ArtifactRouter path (or assert the router was the write path) rather than seeding rows via direct UPDATE that masks a bypass.
- **Fail** — The test sets up expected state via direct table UPDATE/INSERT that sidesteps the chokepoint, unable to catch a production bypass or router regression.
- **Unknown** — The changed behavior does not involve entity/review/artifact writes — exclude from denominator.
- **Evidence** — Cite the test's setup path (router call vs raw SQL) relative to the changed chokepoint.
- **Applies** — only when the diff changes entity/review/artifact write logic routed through a chokepoint

#### TST-8 · Tests are deterministic and genuinely capable of failing (no always-green scaffolding).
- **Pass** — Tests avoid unconditional passes: no it.skip/xit/it.todo on the core new behavior, no empty bodies, no assertions behind never-true guards, no bare expect(true).toBe(true); async paths are awaited so rejections surface.
- **Fail** — The added tests for the changed behavior are skipped/todo/empty, or contain un-awaited async assertions or dead-code guards making them structurally incapable of failing.
- **Unknown** — Test bodies are truly absent from the snapshot — exclude from denominator.
- **Evidence** — Cite the skip/todo/empty/un-awaited construct, or confirm the added tests execute assertions.
- **Applies** — only when the diff adds or modifies test files

#### TST-9 · No pre-existing real assertion was silently weakened or deleted to make the suite pass.
- **Pass** — Modified existing test files retain (or strengthen) their prior behavioral assertions; any removed assertion is justified by a corresponding intended behavior change in the diff.
- **Fail** — The diff loosens a prior assertion (tightened expected value → looser matcher, exact check → truthiness), deletes a meaningful assertion, or comments-out/skip's a previously-running test, so a regression the old test would have caught now passes silently.
- **Unknown** — The diff modifies no pre-existing test file — exclude from denominator.
- **Evidence** — Cite the before→after of the weakened/removed assertion (existing test file:line) and the absence of a matching intended-behavior change.
- **Applies** — only when the diff modifies or deletes existing (pre-existing) test files or their assertions

---

## 7. Scope Fidelity — weight 8

**Activation.** EVIDENCE RULE: the judge has the full snapshot to distinguish net-new surfaces from moved/pre-existing code. ALWAYS ACTIVE whenever a task spec / requirement statement is available alongside a non-empty diff. DROP (mark whole dimension UNKNOWN, excluded from the weighted mean) only when: (a) no task spec / requirement text is recoverable, or (b) the diff is empty/whitespace-only. When the spec is prose (cyboflow entity bodies are usually a single markdown body), the judge MUST derive the implied discrete requirements from the prose and judge against them — do NOT auto-DROP SCP-1 merely because criteria are not bullet-listed.

**Ownership (de-dup).** Owns the MATCH between requirement set and delivered change in BOTH directions: (1) UNREQUESTED functionality/features/files/flags (excess), and (2) MISSING required behavior/dropped acceptance criteria (under-coverage — anti-gaming so shrinking blast radius by omission does not score well). Also owns silent assumptions and out-of-scope refactors that inflate blast radius. Does NOT own: WRONG ABSTRACTION LEVEL / speculative generality (Design owns 'over-engineering' even when out of scope — charge excess to Design if the defect is fundamentally 'too abstract', to Scope if 'unasked-for capability'); VERBOSE EXPRESSION (Maintainability); off-chokepoint UPDATE (Robustness); test meaningfulness (Test) or gate pass/fail; migration renumber/collision correctness (Robustness). Scope only flags a migration whose EXISTENCE is unrequested creep. The @cyboflow-hidden/AbstractCliManager INVARIANT itself is owned by DES-2; SCP-7 charges only the UNREQUESTED-ness of such a change.

**Gate / cap behavior.** No hard gate of its own. SOFT-CAP: if any required acceptance criterion (derived from spec prose if needed) is provably UNIMPLEMENTED (SCP-1 FAIL), cap this dimension at Fair (<=0.69) regardless of pass fraction — under-scoping must not net a high score by being 'clean'. CONFIDENCE-FLAG (advisory): raise when >40% of sub-checks resolve UNKNOWN due to an ambiguous/missing spec. Excess-only violations (SCP-2/3/4 FAIL with full coverage) do NOT trigger the soft-cap but lower the pass fraction. DENOMINATOR FLOOR: fewer than 2 non-UNKNOWN sub-checks caps at 0.89.

**Sub-checks:**

#### SCP-1 · Every explicit OR clearly-implied acceptance criterion in the task spec (derived from prose where the body is not bullet-listed) is implemented by some hunk in the diff.
- **Pass** — Each named or reasonably-derived requirement traces to a concrete code/config/migration hunk that fulfills it.
- **Fail** — One or more required behaviors (explicit or clearly implied by the prose goal) have no implementing hunk, OR a requirement is only stubbed/TODO'd without functioning code.
- **Unknown** — The spec is so vague that no discrete requirement can be responsibly derived even from the prose — reserve UNKNOWN for genuinely contentless goals, not merely un-bulleted ones.
- **Evidence** — Cite each derived spec requirement and the file:line hunk satisfying it (or note the absent one). Anti-under-scoping check; a FAIL triggers the Fair soft-cap.
- **Applies** — always

#### SCP-2 · No user-facing feature, command, flag, endpoint, or UI surface is added that the task did not request.
- **Pass** — All net-new capabilities map to an explicit or clearly-implied spec requirement.
- **Fail** — The diff ships an unrequested capability (extra IPC channel, extra config toggle, new panel/pill, new CLI flag) with no basis in the spec.
- **Unknown** — Whether a surface is new vs pre-existing/moved cannot be determined even after grepping the snapshot.
- **Evidence** — Cite the added surface (file:line) and state the spec contains no corresponding ask. Charge here only for unasked-for CAPABILITY, not an over-abstract implementation of an in-scope one (that is Design).
- **Applies** — always

#### SCP-3 · No out-of-scope refactor, rename, reformat, or drive-by cleanup inflates blast radius beyond what the task needs.
- **Pass** — Files/lines touched are those a minimal correct implementation would touch; any broad mechanical change traces to a requirement.
- **Fail** — The diff bundles unrelated refactors, mass reformatting, or renames across files the task never mentioned, expanding review surface without requirement backing.
- **Unknown** — Whether a touched file is load-bearing for the task cannot be established from the diff + spec + snapshot.
- **Evidence** — Cite the out-of-scope hunks (file:line) and note the absent requirement; exonerate large-but-mechanical hunks by tracing to a requirement. Diff size alone is NOT sufficient evidence.
- **Applies** — always

#### SCP-4 · No silent design assumption substitutes for, contradicts, or narrows an explicit spec instruction.
- **Pass** — Where the spec is prescriptive, the implementation follows it; any judgment call fills a genuine spec GAP rather than overriding a stated requirement.
- **Fail** — The diff silently makes a choice conflicting with or quietly reinterpreting an explicit instruction (wrong default, changed scope of a value, opted a behavior on/off against the ask).
- **Unknown** — The spec is silent on the point, so the choice is a legitimate gap-fill.
- **Evidence** — Quote the spec instruction and the contradicting hunk (file:line). A defensible gap-fill on a silent point is PASS.
- **Applies** — always

#### SCP-5 · A newly-added DB migration exists only because the task's data-model change requires it (no speculative/unrequested schema).
- **Pass** — Each added migration column/table/view directly backs a required behavior in the spec.
- **Fail** — A migration adds columns/tables/entities the task never asked for (schema scope creep), e.g. speculative future-use fields.
- **Unknown** — The diff touches no migration files, OR the spec explicitly delegates schema shape to implementer discretion.
- **Evidence** — Cite the migration file:line and map (or fail to map) each schema element to a requirement. Numbering/idempotency/collision is Robustness's concern.
- **Applies** — only when the diff adds or edits files under a migrations directory

#### SCP-6 · Added tests / fixtures / scripts are scoped to the task and do not smuggle in unrequested product behavior.
- **Pass** — New test/tooling files exercise only the requested change; any helper added is used by those tests.
- **Fail** — Test/tooling additions introduce or depend on product features outside the task, or add large unused scaffolding presented as 'test support'.
- **Unknown** — The diff adds no test/script/fixture files.
- **Evidence** — Cite the added test/tooling hunk and the out-of-scope behavior it introduces. Meaningfulness is Test's concern; this flags scope leakage.
- **Applies** — only when the diff adds or edits test, fixture, or build/script files

#### SCP-7 · Preserved/guarded assets are not touched WITHOUT a task mandate: no unrequested deletion/mislabel of @cyboflow-hidden code and no unrequested collapse of AbstractCliManager.
- **Pass** — Either these preserved surfaces are untouched, OR any change to them is explicitly mandated by the spec.
- **Fail** — The diff deletes/guts @cyboflow-hidden code, stamps the marker onto live code, or collapses the preserved extension point AND the spec did not request it.
- **Unknown** — The diff touches none of these preserved surfaces.
- **Evidence** — Cite the touched hunk (file:line) and the absence of a spec instruction authorizing it. Charge HERE only the UNREQUESTED-ness; the invariant violation itself is owned by DES-2 (mutually exclusive: if the spec mandated the change, SCP-7 PASSes and DES-2 judges the invariant).
- **Applies** — only when the diff touches @cyboflow-hidden-annotated code or AbstractCliManager/ClaudeCodeManager AND the change is not spec-mandated

#### SCP-8 · The change does not silently widen an IPC/tRPC contract with fields/channels nobody requested.
- **Pass** — Any added request/response field or new IPC channel corresponds to a spec requirement and is threaded for a requested reason.
- **Fail** — The diff enlarges an IPC/tRPC payload interface or adds channels beyond the task's need (unrequested boundary surface growth).
- **Unknown** — The diff touches no IPC/tRPC/shared-types boundary.
- **Evidence** — Cite the widened interface (file:line) and note no requirement backs the added field/channel. Type-PARITY correctness is ROB-1's; this judges only whether the ADDITION was in scope.
- **Applies** — only when the diff edits IPC/tRPC handlers, shared/types/ipc.ts, or request/response interfaces

---

## Appendix — how this checklist was refined

The draft (7 dimensions generated independently) was run through a coherence critic, then revised. Changes applied:

- De-duplicated IPC/tRPC silent-drop (was triple-owned COR-5/ROB-1/DES-5): ROB-1 is now the SOLE owner of the declared-T-vs-runtime-shape + one-sided-interface CONTRACT defect; COR-5 rewritten to own only a concrete in-repo caller computing a WRONG OUTPUT from a dropped/renamed field; DES-5 narrowed to PLACEMENT only (local IPCResponse redecl / missing explicit T / hand-mirrored onData) with explicit 'do not re-charge ROB-1' text.
- Trimmed COR-7 to its unique code-schema-consistency concern (a changed query reads a column no migration creates); removed all destructive/idempotent/collision/schema-parity language, leaving those solely in ROB-3 (destructive/idempotent/parity) and ROB-4 (collision).
- Collapsed the @cyboflow-hidden / AbstractCliManager triple-charge: DES-2 is now the SOLE owner (carries the Fair soft-cap); deleted the old ROB-8 preserved-seam check entirely; narrowed SCP-7 to fire only when the change is UNREQUESTED and made it mutually exclusive with DES-2 by spec-mandate presence.
- Assigned optional-logger dropping to ONE owner: ROB-6 owns simple logger omission; DES-7 rewritten to own only a NEW bespoke construction/wiring path that STRUCTURALLY cannot receive the collaborator, with 'do not re-charge ROB-6' text.
- Partitioned the boundary-`any` triple-touch: SEC-7 owns `any`/unknown reaching a SINK (added 'do not re-charge ROB-1 shape-drift'); ROB-1 owns the parity/shape smell; MTN-6 stays a readability-only signal with an explicit no-double-charge-as-gate note.
- Added a global EVIDENCE RULE to every dimension header: the judge has the FULL FROZEN SNAPSHOT and MUST open/grep it (callers, counterpart interfaces, migration directory, symbol existence, test bodies, pre-existing coverage) before ever marking UNKNOWN; UNKNOWN reserved for genuinely external deps/runtime state. Rewrote the systemic 'not visible in the diff' unknownWhen clauses across COR-5/6, ROB-1/2/4/5/6/7, DES-3, MTN-4, TST-1/2/8, SCP-2/3 accordingly.
- Made ROB-4 REQUIRE enumerating the migrations directory in the snapshot before verdict (closes the MEMORY-documented 035-039 collision gap that previously always resolved UNKNOWN); promoted a confirmed collision to a Poor soft-cap in ROB gateBehavior.
- Fixed the COR-2 self-authored-test loophole: judge self-verification now counts as independent corroboration ONLY for demonstrably straight-line logic; branch-heavy paths with only same-diff tests FAIL and bind the 0.89 ceiling. Also defined 'primary path' in COR-1/COR-2 as the judge-selected riskiest behavioral hunk (not author-chosen) to close the multi-hunk mis-selection gap.
- Added COR-9 (performance): flags N+1 DB loops, O(n^2)+ hot-path scans, synchronous blocking on the Electron main thread, and unbounded per-event accumulation — previously uncharged.
- Added SEC-9 (path traversal / arbitrary fs access): fs read/write/delete built from agent/session/user-controlled worktree/branch/log paths without normalization/containment.
- Added ROB-8 (migrateLocalStorageKey): hand-rolled getItem/setItem key renames now FAIL instead of slipping through as an incidental DES-6 example; removed the localStorage example from DES-6.
- Decoupled TST-4 from author commit-type labels: appliesWhen now keys on whether the CODE corrects a defect (guard added, condition inverted-back, off-by-one/null-deref fixed), closing the 'mislabel a fix as feat' regression-test dodge.
- Added TST-9: charges silent weakening/deletion of a pre-existing real assertion to make the suite pass (previously only newly-added tests were graded for always-green-ness).
- Fixed SCP-1 prose-spec self-disabling: the judge must DERIVE discrete requirements from cyboflow's prose entity bodies and judge against them; UNKNOWN reserved for genuinely contentless goals, restoring the anti-under-scoping Fair soft-cap where cyboflow specs actually live.
- Added a DENOMINATOR FLOOR to every dimension's gateBehavior: a dimension with fewer than 2 non-UNKNOWN sub-checks is capped at Good (0.89) and flagged low-confidence, so thin-evidence dimensions cannot enter the geometric mean at a full 1.0.
- Rewrote COR-6 to require grepping the snapshot for symbol/column/tool existence before PASS/UNKNOWN, replacing the gameable 'plausibly resolvable' passWhen that let plausible-but-nonexistent APIs earn PASS.
- Tightened TST-1 unknownWhen so a behavioral change with no test present is FAIL (never UNKNOWN), and TST-2/TST-8 UNKNOWN now requires the test body to be genuinely absent from the snapshot, closing the truncated-diff stub-dodge.
