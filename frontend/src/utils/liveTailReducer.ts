/**
 * liveTailReducer — pure derivation of the in-flight "live tail" (progressively
 * rendered text/thinking) from a raw StreamEvent log, shared by BOTH hosts:
 * workflow runs feed it `cyboflowStore.streamEvents`; quick panels feed it the
 * `panelLiveEventsStore` buffer (see LiveTail.tsx for the presentational side).
 *
 * This is a PURE function over the full ordered event log, recomputed on every
 * call (not an incremental reducer with persisted state) — cheap at the sizes
 * both buffers reach in practice and consistent with the existing
 * `deriveRunContextUsageParts` precedent (runContextUsage.ts), which is
 * recomputed via `useMemo` on every stream-event append.
 *
 * Algorithm:
 *   1. Scope to events AFTER the last `result` envelope. A `result` is the
 *      turn boundary — everything before it is already a settled message, so
 *      re-scanning it would resurrect content the transcript has already
 *      rendered from the debounced refetch.
 *   2. Walk the scoped `stream_event` envelopes, tracking one text/thinking
 *      accumulator per content-block `index`:
 *        - `content_block_start` opens an accumulator for `text` / `thinking`
 *          blocks only. `tool_use` (and any other) block starts are skipped —
 *          the existing working indicator already covers tool calls, and
 *          `input_json_delta` fragments are not valid JSON until
 *          `content_block_stop` anyway.
 *        - `content_block_delta` (`text_delta` / `thinking_delta`) appends to
 *          the matching accumulator, creating one defensively if the matching
 *          `content_block_start` fell outside the scope window somehow.
 *        - `content_block_stop` DROPS the accumulator — the block is
 *          complete; it disappears from the tail here and reappears as a
 *          settled message once the debounced refetch lands (an accepted
 *          brief gap — see render-map.md).
 *   3. `isGenerating` is true iff at least one `stream_event` envelope has
 *      arrived since the last result (message_start onward) — i.e. a turn is
 *      in flight, independent of whether any block currently has content.
 *
 * Malformed events (a `stream_event` missing `event`, a non-numeric `index`,
 * an unrecognized delta shape) are skipped defensively — this reducer never
 * throws on adversarial or truncated input.
 */
import type { StreamEvent } from './cyboflowApi';

export type LiveTailBlockKind = 'text' | 'thinking';

export interface LiveTailBlock {
  /** The SDK content-block index — stable React key, not shown to the user. */
  index: number;
  kind: LiveTailBlockKind;
  text: string;
}

export interface LiveTailState {
  /** Not-yet-stopped blocks for the in-flight message, ordered by index. */
  activeBlocks: LiveTailBlock[];
  isGenerating: boolean;
}

const EMPTY_STATE: LiveTailState = { activeBlocks: [], isGenerating: false };

/** Index of the first event to scan — everything after the LAST `result`. */
function scopeStartIndex(events: readonly StreamEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'result') return i + 1;
  }
  return 0;
}

export function reduceLiveTail(events: readonly StreamEvent[]): LiveTailState {
  if (events.length === 0) return EMPTY_STATE;

  const start = scopeStartIndex(events);
  const blocks = new Map<number, LiveTailBlock>();
  let isGenerating = false;

  for (let i = start; i < events.length; i++) {
    const env = events[i];
    if (env.type !== 'stream_event') continue;
    const evt = env.payload?.event;
    if (evt === null || typeof evt !== 'object') continue;

    isGenerating = true;

    switch (evt.type) {
      case 'content_block_start': {
        const index = evt.index;
        if (typeof index !== 'number') break;
        const blockType = evt.content_block?.type;
        if (blockType === 'text' || blockType === 'thinking') {
          blocks.set(index, { index, kind: blockType, text: '' });
        }
        // tool_use (and any other block type) is intentionally not tracked —
        // the existing spinner/working indicator covers it.
        break;
      }
      case 'content_block_delta': {
        const index = evt.index;
        if (typeof index !== 'number') break;
        const delta = evt.delta;
        if (delta === undefined) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          const existing = blocks.get(index) ?? { index, kind: 'text' as const, text: '' };
          blocks.set(index, { ...existing, kind: 'text', text: existing.text + delta.text });
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          const existing = blocks.get(index) ?? { index, kind: 'thinking' as const, text: '' };
          blocks.set(index, { ...existing, kind: 'thinking', text: existing.text + delta.thinking });
        }
        // input_json_delta / signature_delta: not renderable text — ignored.
        break;
      }
      case 'content_block_stop': {
        const index = evt.index;
        if (typeof index === 'number') blocks.delete(index);
        break;
      }
      default:
        // message_start / message_delta / message_stop: no block-level effect
        // beyond the isGenerating flag already set above.
        break;
    }
  }

  if (blocks.size === 0 && !isGenerating) return EMPTY_STATE;

  const activeBlocks = Array.from(blocks.values()).sort((a, b) => a.index - b.index);
  return { activeBlocks, isGenerating };
}
