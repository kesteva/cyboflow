/**
 * The paste-able instructions for a relay-http connection. Contains the one-time token, so it is only
 * ever returned by connect / repair and never stored or logged. Endpoint shapes match the vendor HTTP
 * mailbox types in the vendored relay protocol.
 */
export interface HttpInstructionBriefInput {
  httpBase: string;
  token: string;
  handle: string;
}

export function buildHttpInstructionBrief({ httpBase, token, handle }: HttpInstructionBriefInput): string {
  return [
    'You can reach me through cyboflow. Call these HTTPS endpoints with the header',
    `"Authorization: Bearer ${token}":`,
    '',
    `- Send me a message: POST ${httpBase}/inbox with JSON {"id": "<a unique id you choose>", "text": "<message>", "links": ["https://..."]}`,
    `- Read my messages and briefs: GET ${httpBase}/outbox?since_cursor=<the cursor from your previous call>`,
    `- Accept or decline a brief: POST ${httpBase}/outbox/<brief id>/ack with JSON {"accepted": true, "note": "<optional>"}`,
    `- Report a pull request: POST ${httpBase}/inbox with JSON {"kind": "delivery_report", "pr_url": "<url>", "summary": "<optional>"}`,
    '',
    `Name your branches cf/${handle}/<task or topic> and put <!-- cyboflow:${handle} --> in pull request descriptions.`,
    'Check for my messages whenever you start working. Keep this token private: it only works for this connection.',
  ].join('\n');
}
