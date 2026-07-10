export interface CodexChatGptAccount {
  type: 'chatgpt';
  email: string | null;
  planType: string;
}

export interface CodexAccountReadResponse {
  account: CodexChatGptAccount;
  requiresOpenaiAuth: boolean;
}

export class CodexChatGptAuthRequiredError extends Error {
  override readonly name = 'CodexChatGptAuthRequiredError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

export function requireCodexChatGptAccount(value: unknown): CodexAccountReadResponse {
  if (
    !isRecord(value)
    || typeof value.requiresOpenaiAuth !== 'boolean'
    || !isRecord(value.account)
    || value.account.type !== 'chatgpt'
    || !isStringOrNull(value.account.email)
    || typeof value.account.planType !== 'string'
  ) {
    throw new CodexChatGptAuthRequiredError(
      'Codex requires a ChatGPT login. Run `codex login` and try again.',
    );
  }

  return {
    account: {
      type: 'chatgpt',
      email: value.account.email,
      planType: value.account.planType,
    },
    requiresOpenaiAuth: value.requiresOpenaiAuth,
  };
}
