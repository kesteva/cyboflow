/**
 * Converting the composer's in-memory {@link AttachedImage} into the wire-shaped
 * {@link AgentThreadImageAttachment} the assistant turn carries.
 *
 * Every OTHER attachment path in the app persists the file and cites its path in
 * the prompt text, letting the agent `Read` it. The global assistant cannot do
 * that: it spawns with `tools: []` and folder-scoped MCP reads only. So its
 * images travel as real base64 content blocks, which means stripping the
 * `data:<media-type>;base64,` prefix a FileReader `readAsDataURL` produces and
 * proving the media type is one the Anthropic image block accepts.
 */
import {
  isAgentThreadImageMediaType,
  type AgentThreadImageAttachment,
} from '../../../../shared/types/agentThread';
import type { AttachedImage } from '../cyboflow/unified/attachments';

/** Matches `data:<media-type>;base64,<payload>` and captures both halves. */
const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

/**
 * Narrow one attached image to the wire shape, or `null` when it cannot be sent
 * (an unreadable data URL, or a media type outside the accepted set — SVG, HEIC,
 * BMP and friends all land here). The caller surfaces the rejection inline; a
 * silent drop would let someone send a turn believing the picture went with it.
 */
export function toAgentThreadImageAttachment(image: AttachedImage): AgentThreadImageAttachment | null {
  const match = DATA_URL_RE.exec(image.dataUrl);
  if (match === null) return null;
  const [, mediaType, base64] = match;
  if (!isAgentThreadImageMediaType(mediaType) || base64.length === 0) return null;
  return { name: image.name, mediaType, base64 };
}

/** True when this attachment can be sent as a content block (see above). */
export function isSendableImage(image: AttachedImage): boolean {
  return toAgentThreadImageAttachment(image) !== null;
}
