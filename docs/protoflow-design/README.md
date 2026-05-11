# Handoff: Protoflow — Agent management dashboard

## Overview

Protoflow is a desktop-style dashboard for managing long-running coding agents that operate over a structured workflow (idea → plan → execute → verify → review → compound). The screens are designed for a single-window IDE-like surface: an agent list on the left, the active workflow + its terminal in the middle, and a contextual right rail (workflow progress, files, and diff). The design also covers a Human Review queue and a modal Workflow Editor for editing the agent pipeline before running.

The aesthetic is a **warm, paper-toned, "professional terminal"** look — JetBrains Mono throughout, a paper-cream background, hairline borders, and a single warm rust accent. Think Warp + a printed engineering notebook.

## About the design files

The files in this bundle are **design references created in HTML/React (Babel-transpiled inline JSX)**. They are prototypes showing intended look, layout, and behavior — **not production code to copy directly**.

Your job is to **recreate these designs in the target codebase's existing environment** (React, Next.js, Tauri, Electron, SwiftUI, etc.) using its established patterns, component library, and conventions. If no environment exists yet, choose the framework most appropriate for a desktop-class app and implement the designs there. Lift the visual tokens (colors, type, spacing, sizing) and the layout/interaction structure faithfully — but do not lift the inline `<style>` blocks, the `D-`/`A-` class-prefix scheme, or the prototype's data shims (`window.SESSIONS`, `window.WORKFLOW_DEFS`, etc.). Those are scaffolding for the mockup, not API contracts.

## Fidelity

**High-fidelity.** Colors, type, spacing, and component states are intended as-is. The developer should match the visual specifics — exact hex values, monospace type ramp, hairline 1px borders — and the structural layout (3-pane shell, fixed-pixel rail widths). Animation/microinteraction detail is intentional: the running token pulse, the dashed loop-back arrows, the "frosted glass + green check" overlay on completed workflow steps.

What's *not* prescriptive: the specific copy strings, the toy data, and the exact React component tree. Recreate using the host codebase's component primitives (Button, Tabs, Modal, etc.).

## Screens / views

### 1. Title bar (top, full-width)

- Height **38px**. Background a subtle vertical gradient `#ebe4d2 → #e1d8c0`. Bottom border `#d8cfb8`.
- Left: macOS traffic-light dots (close/min/max), 11px circles, 7px gap.
- Center: search affordance — `#f5f1e8` fill, `#d8cfb8` border, 22px tall, 4px radius, placeholder color `#9c8e6c`, 11px text.
- Right: icon buttons (settings, history) at `#6a5e44`, 24×22, hover bg `#f5f1e8`.

### 2. Left rail — Agent list (208px wide)

- Background `#ebe4d2`, right border `#d8cfb8`.
- **Top:** search input + small `+` button (new agent), 22px tall, 11px text.
- **Primary item:** "Human review" pinned card — `#f5f1e8` background, 22px barber-pole avatar (repeating diagonal stripes `#d99a3d`/`#c98a2d`), label + sub-label, **rust badge** showing count (background `#c96442`, white text, 9px radius pill).
- **Sections:** "Active agents · N" and "Idle · N" — small caps eyebrow at 9px, letter-spacing `.18em`, color `#9c8e6c`.
- **Tabs (agents):** vertical list, 8/10px padding, 5px radius. Each shows:
  - A **status dot** (7px circle) — `running` (rust `#c96442`, pulsing ring), `waiting` (gold `#d4a72c`), `idle` (warm gray `#9c8e6c`), `done` (green `#2d8a5b`).
  - Status text (11.5px, weight 600).
  - Sub-line: branch (with `⌥` glyph) and session title, 10px, `#6a5e44`.
  - Active state: white bg, 2px left rust accent border.
- **Foot:** user avatar circle (rust fill `#c96442`, white initials, 22px), name, settings cog.

### 3. Center column

Two stacked panes: **Active workflow** (top, ~46% height, read-only) and **Terminal** (bottom, fills rest). Each pane has its own **34px header bar** with an uppercase title in `#1a1815`, sub-text in `#6a5e44`, right-aligned action buttons.

#### 3a. Active workflow pane (read-only)

- Background `#f5f1e8` with a **graph-paper grid** (24px squares, lines at `rgba(106,94,68,.06)`).
- **Meta row** at top: `SPRINT-014 · <title>` · `rev 0014` · `elapsed 4m12s` · `tokens 184k` · `est $0.42` · running pill (rust border + pulsing rust dot). 10px text, color `#6a5e44`, **bold values** `#1a1815`. Dashed bottom border.
- **Workflow canvas:** phases laid out **horizontally as columns**; steps stack **vertically inside each column**.
  - Column width **138px**, 14px gap, row height 86px, top offset 28px.
  - Each column has a small uppercase **band label** at the top in its phase color: `PLAN / 01`, `REFINE / 02`, `EXECUTE / 03`, `VERIFY / 04`.
  - **Step nodes** are 138px wide cards with a **1.4px black border** (`#1a1815`):
    - Head bar (uppercase 9px, white text, `.14em` tracking) in **phase color**: PLA, REF, EXE, VER, etc. Right side shows two-digit step index `01`, `02`…
    - Body: step name (10.5px, weight 600, max 2 lines, ellipsized). Sub-meta row: agent short-name + retry count `×3`.
    - Foot: dashed top border, small status dot + uppercase state (`PENDING`/`RUNNING`/`DONE`).
  - **Step states:**
    - **Pending**: muted — `#efeadc` fill, `#d8cfb8` border, grayscale + 55% opacity on head bar, text `#9c8e6c`/`#b3a685`.
    - **Running**: 2px rust outline (`#c96442`, `outline-offset: 2px`), foot dot rust.
    - **Done**: a frosted-glass overlay (`rgba(245,241,232,.62)` + `backdrop-filter: blur(2px)`) sits over the whole card, and a 30px green check circle (`#2d8a5b`, white check, soft shadow) is centered on it.
    - **Human**: special — amber border (`#a86b1d`), barber-pole striped head bar, and a 22px circular badge with a person glyph clipped to the top-right corner (`top:-9px; right:-9px`).
    - **Optional**: small `OPTIONAL` chip in the head bar.
  - **Edges** drawn via SVG (`position:absolute; inset:0; pointer-events:none`):
    - **Vertical (within phase)**: solid 1.4px black, drops from bottom of card to top of next, arrow marker.
    - **Horizontal (between phases)**: solid 1.4px black, end-to-end at vertical center.
    - **Loopback** (e.g., verify → implement): **dashed 1.2px rust** (`#c96442`, `stroke-dasharray: 4 3`), rust arrow marker, routed around the right side of the source card.
  - **Animated token**: a 4px rust circle that travels along the current-edge linearly to indicate "what's happening now." Driven by a continuous `requestAnimationFrame` ticker (`t` from 0→1 mod 1, advanced ~0.18/sec).

#### 3b. Workflow picker (idle state — replaces the canvas when no sprint is active)

- Centered card, max-width 680px on the same graph-paper canvas.
- Eyebrow `"No active sprint"` (11px, `.18em` tracking, `#9c8e6c`).
- Title `"Choose a workflow to start"` (20px, weight 700, `-0.01em` tracking, `#1a1815`).
- List of workflow rows: white `#fff`, 1px `#d8cfb8` border. Each row has:
  - Name (13px, weight 700) + optional **rust `DEFAULT` tag** (uppercase, `.18em` tracking, 1px border).
  - Subtitle (11px, `#6a5e44`).
  - Command in mono (10px, `#9c8e6c`).
  - Right meta: `N STEPS · M PHASES`, `USED 2H AGO` (uppercase, 10px, `#9c8e6c`).
  - Trailing `Edit` ghost button.
- Hover: black border, **2px black drop shadow** (`box-shadow: 0 2px 0 #1a1815`).
- Selected: rust border + 3px inset left rust bar.
- CTA row below: `Run /soloflow` primary button (uppercase 11px, black border, black fill on hover).
- Add-new row: dashed warm-gray border (`#9c8e6c`), transparent fill, plus icon.

#### 3c. Terminal pane (bottom)

- Background `#f5f1e8`.
- Body is a scrolling JetBrains Mono log at **11.5px / 1.6 line-height**, padding 10/14px.
- Line variants:
  - `tool` — leading green dot `●` (`#2d8a5b`), bold tool name in `#1a1815`, args in `#6a5e44`.
  - `msg` — leading black dot.
  - `cmd` — bold, no marker.
  - `out` — `#6a5e44`, indented 14px.
  - `sys` — `#9c8e6c`, 11px.
- **Prompt strip** at bottom (38px-ish): `#ebe4d2` fill, top hairline border.
  - Rust `▸` arrow.
  - Italic placeholder prompt text in `#9c8e6c`.
  - **Progress bar:** 80×8px, `#d8cfb8` track, rust fill at 42% width.
  - Percentage `42%` (10px bold, tabular).
  - Model chip on far right: 1px `#d8cfb8` border, `#f5f1e8` fill, 10px text, `#6a5e44`.

### 4. Right rail (296px) — three tabs

- Header tab strip — 3 buttons (Workflow progress, File explorer, Diff), uppercase 10px, `.14em` tracking, `#9c8e6c`. Active tab: white background, black text, **2px inset bottom rust accent**.

#### 4a. Workflow progress feed

- One section per phase. Phase header: tiny phase-color swatch (8×8), phase name (bolded black 11), step count (right).
- Steps render as **timeline items** with a 2px left border that matches state:
  - `done` — green `#2d8a5b`
  - `running` — rust `#c96442`, with a pulsing left bullet
  - `pending` — muted `#d8cfb8`
- 8px circle bullet on the left edge.
- Per-step name (11.5px bold) + right-aligned uppercase status (`✓ done`, `● running`, `pending`) + agent name (10px, gray).
- Below each non-pending step: a list of **log lines** with mono prefixes — `▸` (tool, green), `✎` (edit, gold), `·` (note, gray), `✓` (done, green), `●` (running, rust). Each line shows a tabular elapsed timestamp (42px wide column) and a message.

#### 4b. File explorer tab

- Flat list of changed files.
- Each row: 14px **status glyph** (`M` gold, `A` green, `D` rust, `·` gray), path, right-aligned `+N` (green) / `−N` (rust) deltas.
- Clicking a file → jumps to the Diff tab and selects it.

#### 4c. Diff tab

- Header strip: filename + green `+N` / rust `−N` totals + dim path.
- **Hunks** with a dim header line (`@@ -12,7 +12,9 @@` style).
- Diff lines as a **3-column grid**: 28px old-line gutter, 28px new-line gutter, 1fr text.
- Add rows: green `rgba(45,138,91,.12)` background, `+` prefix.
- Del rows: rust `rgba(201,100,66,.12)` background, `−` prefix.
- Context rows: plain.
- Mono 11px, preserved whitespace.

### 5. Human Review screen (replaces center + right when "Human review" is selected in the rail)

- **Pane header** (`#ebe4d2`, 18/28px padding):
  - Eyebrow `"Pending checkpoints"`.
  - Title `"Human review"` (22px, weight 700).
  - Sub-line: `<N> total · <K> blocking a sprint · sorted by age`.
- **Body** is a scrolling list grouped by workflow. Group header sticks to the top of the scroll area:
  - Rust swatch (8×14px), workflow name (12px bold), pending count (uppercase 10px), and a right-aligned command in mono.
- **Card** per pending review: 3-column grid (pill / content / actions), white bg, `#d8cfb8` border, 14/16px padding, 8px gap between cards.
  - **Left pill**: `Blocking` (amber `#a86b1d`, uppercase 9px, 1px border) or `Optional` (soft gray `#9c8e6c`).
  - **Middle**:
    - Title row: card title (14px, weight 700) + phase tag (uppercase 10px in phase color) + step name (`<b>`).
    - Meta row (10.5px, `#6a5e44`): repo · branch, file count, green/rust diff totals, "since" time, mono session id.
    - Summary paragraph (12px, line-height 1.5).
  - **Right (124px min-width)**: small age text on top, then a **vertical stack of full-width 6/12px buttons** — primary (black fill, cream text, **hover turns rust**), neutral (white + black border), ghost (`#d8cfb8` border, gray text). Final ghost button: `Open session →`.

### 6. Workflow editor (modal — opened from the header `Edit flow` button or `⌘E`)

- **Full-screen modal**: dark scrim `rgba(26,24,21,.55)`, content inset 30px from the viewport edges, 1px black frame, big 30/80/45% drop shadow.
- **Modal header (38px, black fill `#1a1815`, cream text `#f5f1e8`):**
  - Uppercase title `Edit workflow · /<command> · <id>.yaml` (10px, `.18em` tracking, bold).
  - Revision marker `rev 0014 → draft` in 55%-opacity cream.
  - Right-aligned buttons: `Cancel` (outlined), `Save ▾` (outlined, with dropdown: "Save as new flow" / "Update existing flow"), and **primary `Run with modifications`** (rust fill).
- **Body** renders the **"Direction A" blueprint editor** — a more spacious version of the workflow visualization:
  - Phase **bands** as dashed rectangles with a small inset label (`PLAN / phase 01`) on a 24px paper-grid.
  - Step nodes are **178px** wide, with a black head bar (not phase-colored), keyed metadata rows (`AGENT`, `MCP`, `RETRY`), and a dashed-top footer with a state dot.
  - Selected node gets a **3px rust outline at offset 3px**.
  - Human steps: amber border + striped head + 32px human-glyph badge floating above the center top.
  - **Right inspector pane (300px)** with tabs (Step / Agent / MCP), showing the selected step's spec — prompt textarea, agent picker (2-column grid of cards, "active" card filled black), MCP toggle rows.
- **"Run with modifications" confirmation** — overlays a centered 520px card on the canvas + a 96px-tall black footer bar:
  - Card eyebrow `"Ready to run"`, big workflow name in 20px, summary line `N steps · K phases · H human checkpoint(s)`, then a white-boxed list of phases with right-aligned `N step(s) · loops up to 3×` text, then `Estimated cost ~$2.40 · ~12 min · ~190k tokens`.
  - Footer bar (black) right-aligned: outlined `Modify` button + rust primary `Run` button (13px, `.12em` tracking, weight 700, 14/36px padding).

## Interactions & behavior

- **Selecting an agent** (left rail) swaps the center + right panes to that session's data. Selecting "Human review" swaps the center+right region for the review screen.
- **Workflow run states** in the active-workflow pane derive from `session.currentStepId`. Steps before it render `done`, the matching step renders `running`, steps after render `pending`.
- **Token animation**: a continuous `requestAnimationFrame` ticker advances `t` at 0.18/sec, modulo 1. A 4px rust circle is positioned along the line from the current step's center to the next step's center using linear interpolation. No easing.
- **Pulse animation**: `@keyframes D-pulse` 1.4s infinite — opacity 1→0.4→1 and scale 1→0.8→1 — applied to the running status dot's outer ring, the running pill's dot, and the timeline running marker.
- **Workflow editor keyboard shortcut**: `⌘E` / `Ctrl+E` opens the modal; `Esc` closes it.
- **Modal "Run with modifications" flow**: clicking the primary button does NOT close the modal — it switches the modal into a confirmation overlay (inspector hides, toolbar pills hide, footer appears). `Modify` returns to edit mode; `Run` commits and closes.
- **Save dropdown** in the modal header closes on any outside click (`pointerdown` capture-phase listener).
- **File explorer → Diff**: clicking a file in the file list switches the active tab to "Diff" and selects that file.
- **Hover affordances**:
  - List rows / tabs: shift background to `#f5f1e8`.
  - Picker rows: black border + 2px black drop shadow.
  - Primary buttons: hover swaps to rust fill + rust border.
  - Ghost buttons: hover swaps the border to black + text to black.

## State management

State for an implementation should cover:

- `activeId` — selected agent session id, with a sentinel `__human_review` for the review screen.
- `editing` (bool) — modal open/closed.
- `confirmingRun` (bool) — modal sub-state.
- `editWorkflowId` — currently-being-edited workflow id (separate from the running session's workflow).
- `pickerSel` — selected option in the workflow picker (idle state).
- `t` — animation clock, driven by RAF, mod 1.
- `tab` (in the right rail) — `progress` / `files` / `diff`.
- `active` (in the right rail) — selected file path for the diff view.
- `saveMenuOpen` — modal save-dropdown open state.

Data shapes the UI consumes (real backend should mirror the field set, not the exact keys):

- **Session**: `{ id, status: 'running'|'waiting'|'idle'|'done', statusText, branch, title, repo, model, workflow, currentStepId, elapsed }`.
- **Workflow definition**: array of phases. Each phase `{ id, label, color, steps: [{ id, name, agent, mcps, retries, optional?, human?, loopback?, desc }] }`.
- **Agent**: `{ id, name, model, role, desc, tokens }`.
- **Human-review item**: `{ id, workflow, phase, stepName, sessionId, repo, branch, title, summary, files, diffPlus, diffMinus, blocking, age, waitingSince, decisions: string[] }`.
- **Terminal line**: `{ kind: 'tool'|'msg'|'cmd'|'out'|'sys'|'spc', text, tool?, ... }`.
- **Step log line**: `{ kind: 'tool'|'edit'|'note'|'done'|'running', t, text }`.
- **Diff**: `{ file, hunks: [{ header, lines: [{ kind: 'add'|'del'|'ctx', n1, n2, text }] }] }`.

## Design tokens

### Color — paper / ink palette

| Role | Hex |
|---|---|
| Page bg | `#f5f1e8` |
| Surface (rail / header / chrome) | `#ebe4d2` |
| Surface darker (gradient bottom) | `#e1d8c0` |
| Surface muted (pending step) | `#efeadc` |
| Card / white | `#ffffff` |
| Hairline / divider | `#d8cfb8` |
| Hairline-soft | `#e6dec7` |
| Ink (foreground) | `#1a1815` |
| Ink-2 (body) | `#6a5e44` |
| Ink-3 (muted) | `#9c8e6c` |
| Ink-4 (very muted) | `#b3a685` |

### Color — accents

| Role | Hex |
|---|---|
| Rust (primary accent — running, danger-ish, brand) | `#c96442` |
| Green (done / additions) | `#2d8a5b` |
| Gold (waiting / edits) | `#d4a72c` |
| Amber (human-in-the-loop) | `#a86b1d` / striped `#d99a3d`/`#c98a2d` |
| Phase blue (Plan) | `#3b6dd6` |
| Phase violet (Refine) | `#5a4ad6` |
| Phase rust (Execute) | `#c96442` |
| Phase green (Verify) | `#2d8a5b` |
| Phase tan-gold (Review) | `#a87a2c` |
| Phase purple (Compound) | `#8b5cf6` |
| Phase brick (Prune) | `#8a4a4a` |

### Typography

- **Single family**: `'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace` for almost everything.
- Title bar / chrome falls back to a system sans (`-apple-system, BlinkMacSystemFont, 'SF Pro', sans-serif`) but in the React tree the mono is dominant.
- Sizes (px):
  - **8.5** uppercase micro-tag (`OPTIONAL` chip, step foot status)
  - **9** uppercase eyebrow / phase head label (`.14–.18em` tracking)
  - **10** secondary meta, uppercase button labels (`.12em` tracking)
  - **10.5** field labels, side-pane meta
  - **11** body sub-text, log lines
  - **11.5** primary body, agent tab title, timeline step name
  - **12** card titles in the review screen
  - **12.5–13** workflow picker primary text
  - **14** review card title
  - **20** workflow picker headline
  - **22** human review screen title
- Weights: 400 (body), 600 (sub-headings, names), 700 (primary headings, button labels, uppercase chips).
- Letter-spacing: uppercase eyebrows `.14em`–`.18em`; large titles `-0.005em` to `-0.01em`.
- Line-height: 1.25 for tight card titles, 1.45 for body, 1.55 for diff/code, 1.6 for terminal.

### Spacing & sizing

- Rail widths: **left 208px**, **right 296px** (both fixed).
- Title bar **38px**, pane headers **34px**, terminal prompt strip ~38px.
- Active-workflow pane height: **46% of center column**.
- Step card width **138px** (active pane) / **178px** (editor modal).
- Step column gap **14px**, row gap **86px**.
- Card padding standard: **14/16px**.
- Card padding compact (step nodes): **4/7px** head, **6/8px** body, **4/8px** foot.
- Border radius: most surfaces are **0** (square). Status dots, avatars are circles. Primary search/inputs **3–4px**. Tab buttons in the rail **5px**. Review badge **9px** pill.
- Borders: hairlines are **1px** `#d8cfb8`. Step cards **1.4px** black `#1a1815`. Selected/run highlights **2px** rust outlines with **2–3px outline-offset**.
- Shadows: rare — used on hover for picker rows (`0 2px 0 #1a1815`), on the green completed-check (`0 2px 6px rgba(45,138,91,.35)`), and the modal (`0 30px 80px rgba(0,0,0,.45)`).

### Iconography

- Status dots, traffic lights, badges — mostly drawn as **CSS circles**, not icons.
- Human glyph: small inline SVG (head + shoulders, `stroke-width: 1.6`, stroke-linecap round).
- Check glyph: inline SVG path, `stroke-width: 2.4`, no fill.
- Diff/log prefixes: **Unicode characters** (`▸ ✎ · ✓ ●`), not icons.

### Motion

- `D-pulse` keyframes: 1.4s infinite, eases opacity 1→0.4→1 + scale 1→0.8→1.
- Token along edge: linear, ~5.5s end-to-end (`t` advances 0.18/sec mod 1).
- Hover transitions on picker rows: `border-color .12s, box-shadow .12s`.
- No bouncy / spring easing.

## Assets

There are no raster or vector asset files in the bundle. Everything is drawn with CSS, SVG paths, or Unicode glyphs. The host codebase should:

- Use its **existing icon set** for any future icons (settings cog, history, branch, etc.).
- Reuse host **monospace font** if it has one; otherwise import JetBrains Mono.

## Files in this bundle

| File | What's in it |
|---|---|
| `Protoflow.html` | Entry point — bootstraps React + Babel + loads the JSX files. |
| `dashboard.jsx` | The full dashboard shell (left rail, center column, right rail, terminal, modal). **Primary reference for screens 1–5 and the modal frame in screen 6.** |
| `direction-a.jsx` | The "blueprint" workflow editor that lives inside the modal body. **Primary reference for the editor canvas + inspector.** |
| `data.js` | Workflow / agent / MCP / model catalogues. **Reference for data shapes, not for the literal data.** |
| `dashboard-data.js` | Sessions, terminal log, review queue, files, diff samples — toy data only. |

To run the prototype locally, open `Protoflow.html` directly in a browser (it loads React/Babel from unpkg — needs internet on first load).

## Notes for the implementer

- **Don't ship the prototype's CSS.** The `.D-` and `.A-` class prefixes exist because the prototype lives in one HTML file. Convert tokens to your design-system variables; convert components to host primitives.
- **Don't ship the `window.*` data scaffolding.** Replace with real APIs / state.
- **Do preserve the visual rhythm:** paper-cream surfaces, hairline borders, mono everywhere, single warm accent, square corners, generous uppercase microcopy.
- **Do preserve the workflow visualization semantics:** column-per-phase, vertical step stacking inside, dashed rust loopbacks, animated token on the active edge, frosted-glass + green check for completed steps, amber striped human steps.
- **Do preserve the three core states** of a step card (pending muted / running rust outline / done frosted+check) — they're load-bearing for the design.
- If a host UI primitive forces a deviation (e.g., your Button component has different padding), prefer the host primitive but keep the typography and accent treatment.
