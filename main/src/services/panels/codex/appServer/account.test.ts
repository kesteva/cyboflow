import { describe, expect, it } from 'vitest';
import {
  CodexChatGptAuthRequiredError,
  requireCodexChatGptAccount,
} from './account';

describe('requireCodexChatGptAccount', () => {
  it('accepts a ChatGPT account with a nullable email', () => {
    expect(requireCodexChatGptAccount({
      account: { type: 'chatgpt', email: null, planType: 'enterprise' },
      requiresOpenaiAuth: true,
    })).toEqual({
      account: { type: 'chatgpt', email: null, planType: 'enterprise' },
      requiresOpenaiAuth: true,
    });
  });

  it.each([
    { account: null, requiresOpenaiAuth: true },
    { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
    { account: { type: 'personalAccessToken' }, requiresOpenaiAuth: true },
    { account: { type: 'chatgpt', email: 42, planType: 'pro' }, requiresOpenaiAuth: true },
    { account: { type: 'chatgpt', email: 'user@example.com' } },
  ])('rejects unsupported or malformed auth state %#', (response) => {
    expect(() => requireCodexChatGptAccount(response)).toThrow(CodexChatGptAuthRequiredError);
    expect(() => requireCodexChatGptAccount(response)).toThrow(
      'Codex requires a ChatGPT login. Run `codex login` and try again.',
    );
  });
});
