import { describe, expect, it, vi } from 'vitest';
import type { AppServerServerRequestDispatch } from './client';
import {
  CodexAppServerQuestionBridge,
  type QuestionRouterPort,
} from './questionBridge';

type QuestionDispatch = Extract<
  AppServerServerRequestDispatch,
  { method: 'item/tool/requestUserInput' }
>;

function dispatch(autoResolutionMs: number | null = null): {
  request: QuestionDispatch;
  respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn();
  return {
    respond,
    request: {
      id: 'request-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        autoResolutionMs,
        questions: [{
          id: 'codex-question-1',
          header: 'Deploy',
          question: 'Choose a target',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Staging', description: 'Deploy to staging.' },
            { label: 'Production', description: 'Deploy to production.' },
          ],
        }],
      },
      respond,
      reject: vi.fn(),
    },
  };
}

function router(answer = { answers: { 'Choose a target': 'Staging, Production' } }): {
  port: QuestionRouterPort;
  requestQuestion: ReturnType<typeof vi.fn>;
  clearPendingForRun: ReturnType<typeof vi.fn>;
} {
  const requestQuestion = vi.fn(async () => answer);
  const clearPendingForRun = vi.fn();
  return { port: { requestQuestion, clearPendingForRun }, requestQuestion, clearPendingForRun };
}

describe('CodexAppServerQuestionBridge', () => {
  it('preserves pinned question metadata and keys the response by Codex question id', async () => {
    const fake = router();
    const bridge = new CodexAppServerQuestionBridge({ runId: 'run-1', questionRouter: fake.port });
    const { request, respond } = dispatch();

    await bridge.handleServerRequest(request);

    expect(fake.requestQuestion).toHaveBeenCalledWith(
      'run-1',
      'tool-1',
      [{
        id: 'codex-question-1',
        header: 'Deploy',
        question: 'Choose a target',
        isOther: true,
        isSecret: false,
        multiSelect: false,
        options: [
          { label: 'Staging', description: 'Deploy to staging.' },
          { label: 'Production', description: 'Deploy to production.' },
        ],
      }],
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith({
      answers: { 'codex-question-1': { answers: ['Staging', 'Production'] } },
    });
  });

  it('auto-resolves safely without opening or clearing a run-wide router gate', async () => {
    vi.useFakeTimers();
    try {
      const fake = router();
      const bridge = new CodexAppServerQuestionBridge({ runId: 'run-1', questionRouter: fake.port });
      const { request, respond } = dispatch(50);
      const handling = bridge.handleServerRequest(request);

      expect(fake.requestQuestion).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      await handling;
      expect(respond).toHaveBeenCalledWith({ answers: {} });
      expect(fake.clearPendingForRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears down only its RPC requests and never clears sibling questions run-wide', () => {
    const fake = router();
    const bridge = new CodexAppServerQuestionBridge({ runId: 'run-1', questionRouter: fake.port });
    const { request, respond } = dispatch(100);
    void bridge.handleServerRequest(request);

    bridge.teardown();

    expect(respond).toHaveBeenCalledWith({ answers: {} });
    expect(fake.clearPendingForRun).not.toHaveBeenCalled();
  });
});
