import type { ToolResultBlock } from '../types/claudeStream';

/**
 * Safely extract a plain string from a ToolResultBlock's `content` field.
 *
 * `ToolResultBlock.content` is `string | Array<{ type: string; text: string }>` on the wire
 * (TASK-570 widened the type to match the real Claude wire format). Any code that treats
 * `content` as always-a-string will silently break at runtime when an array arrives.
 *
 * This helper is the single safe entry point for that union. All callsites that perform string
 * operations on tool-result content (JSON.parse, .includes, template interpolation,
 * makePathsRelative) MUST route through here first.
 */
export function extractToolResultText(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => block.text ?? '').join('');
}
