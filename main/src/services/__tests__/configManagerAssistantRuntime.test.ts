/**
 * ConfigManager.getAssistantRuntime / getAssistantModelFor coverage — which
 * runtime hosts the global assistant, and what model alias that runtime gets
 * out of the single stored `assistantModel` key
 * (docs/proposals/ASSISTANT-CODEX-RUNTIME.md §1).
 *
 * Contract:
 *   - getAssistantRuntime() floors to 'claude-sdk' on a fresh instance (the key
 *     is intentionally absent from constructor defaults, so existing
 *     config.json files stay byte-identical);
 *   - an explicit `assistantRuntime` wins when its provider is enabled;
 *   - with no explicit pick the assistant FOLLOWS `defaultAgentRuntime`'s
 *     provider — this is what carries the onboarding "Codex is my default"
 *     choice through with no extra UI — including from an omp-/pi- runtime,
 *     which is NOT an assistant runtime and therefore falls back to Claude;
 *   - a pick whose provider is switched off in Settings → Integrations is
 *     ignored rather than honoured;
 *   - getAssistantModelFor('claude-sdk') keeps the pre-existing
 *     `assistantModel ?? defaultModel` behaviour, while
 *     getAssistantModelFor('codex-sdk') floors a STALE CLAUDE alias to null
 *     (send no model ⇒ the Codex app-server's own default).
 *
 * Hermetic: each test points ConfigManager at a unique temp dir via
 * setCyboflowDirectory(), so the real ~/.cyboflow config is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';
import type { UpdateConfigRequest } from '../../types/config';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-assistantruntime-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function managerWith(config: Record<string, unknown>): Promise<ConfigManager> {
  await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(config, null, 2));
  const mgr = new ConfigManager('/tmp/test-git-path');
  await mgr.initialize();
  return mgr;
}

describe('ConfigManager.getAssistantRuntime', () => {
  it('floors to claude-sdk on a fresh instance (field not seeded)', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().assistantRuntime).toBeUndefined();
    expect(mgr.getAssistantRuntime()).toBe('claude-sdk');
  });

  it('honours an explicit pick whose provider is enabled', async () => {
    const mgr = await managerWith({ assistantRuntime: 'codex-sdk' });
    expect(mgr.getAssistantRuntime()).toBe('codex-sdk');
  });

  it('follows defaultAgentRuntime when no explicit pick is stored (onboarding path)', async () => {
    const mgr = await managerWith({ defaultAgentRuntime: 'codex-sdk' });
    expect(mgr.getConfig().assistantRuntime).toBeUndefined();
    expect(mgr.getAssistantRuntime()).toBe('codex-sdk');
  });

  it('follows a codex-PTY default onto codex-sdk (provider, not runtime, is what carries)', async () => {
    const mgr = await managerWith({ defaultAgentRuntime: 'codex-pty' });
    expect(mgr.getAssistantRuntime()).toBe('codex-sdk');
  });

  it('leaves the assistant on Claude when the launch default is a non-assistant provider', async () => {
    const mgr = await managerWith({
      defaultAgentRuntime: 'omp-sdk',
      agentProviderAccess: { claude: true, codex: true, omp: true },
    });
    expect(mgr.getAssistantRuntime()).toBe('claude-sdk');
  });

  it('ignores an explicit pick whose provider the user switched off, and its disabled follow-default too', async () => {
    const explicit = await managerWith({
      assistantRuntime: 'codex-sdk',
      agentProviderAccess: { claude: true, codex: false },
    });
    expect(explicit.getAssistantRuntime()).toBe('claude-sdk');

    const followed = await managerWith({
      defaultAgentRuntime: 'codex-sdk',
      agentProviderAccess: { claude: true, codex: false },
    });
    expect(followed.getAssistantRuntime()).toBe('claude-sdk');
  });

  it('treats an unknown stored runtime string as absent and falls through the ladder', async () => {
    const mgr = await managerWith({
      assistantRuntime: 'gpt-sdk',
      defaultAgentRuntime: 'codex-sdk',
    });
    expect(mgr.getAssistantRuntime()).toBe('codex-sdk');
  });

  it('persists a pick through the generic updateConfig merge and round-trips it', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ assistantRuntime: 'codex-sdk' } satisfies UpdateConfigRequest);
    expect(mgr.getAssistantRuntime()).toBe('codex-sdk');

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getAssistantRuntime()).toBe('codex-sdk');
  });
});

describe('ConfigManager.getAssistantModelFor', () => {
  it('Claude: falls back to defaultModel when no assistant override is stored', async () => {
    const mgr = await managerWith({ defaultModel: 'opus' });
    expect(mgr.getAssistantModelFor('claude-sdk')).toBe('opus');
  });

  it('Claude: the assistant override wins over defaultModel', async () => {
    const mgr = await managerWith({ defaultModel: 'sonnet', assistantModel: 'fable' });
    expect(mgr.getAssistantModelFor('claude-sdk')).toBe('fable');
  });

  it('Codex: a Codex alias passes through unchanged', async () => {
    const mgr = await managerWith({ assistantModel: 'gpt-5.3-codex' });
    expect(mgr.getAssistantModelFor('codex-sdk')).toBe('gpt-5.3-codex');
  });

  it('Codex: a STALE Claude alias floors to null (send no model ⇒ the app-server default)', async () => {
    const mgr = await managerWith({ defaultModel: 'sonnet', assistantModel: 'opus' });
    // Claude still resolves it; Codex refuses to forward another family's alias.
    expect(mgr.getAssistantModelFor('claude-sdk')).toBe('opus');
    expect(mgr.getAssistantModelFor('codex-sdk')).toBeNull();
  });

  it('Codex: an unset assistantModel is null — defaultModel is NEVER borrowed across providers', async () => {
    const mgr = await managerWith({ defaultModel: 'opus' });
    expect(mgr.getAssistantModelFor('codex-sdk')).toBeNull();
  });
});
