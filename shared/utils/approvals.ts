/** Pure runtime utility sibling of shared/types/approvals.ts. NO imports — leaf module. */
export const PAYLOAD_PREVIEW_MAX_LEN = 512;

export function truncatePayloadPreview(raw: string): string {
  return raw.length > PAYLOAD_PREVIEW_MAX_LEN ? raw.slice(0, PAYLOAD_PREVIEW_MAX_LEN) : raw;
}
