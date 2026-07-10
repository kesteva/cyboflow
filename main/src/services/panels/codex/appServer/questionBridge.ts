import type { QuestionAnswer, QuestionPayload } from '../../../../orchestrator/questionRouter';
import type { AppServerServerRequestDispatch } from './client';
import type {
  ToolRequestUserInputQuestion,
  ToolRequestUserInputResponse,
} from './protocol';

type QuestionDispatch = Extract<
  AppServerServerRequestDispatch,
  { method: 'item/tool/requestUserInput' }
>;

type CodexQuestionPayload = QuestionPayload & Pick<
  ToolRequestUserInputQuestion,
  'id' | 'isOther' | 'isSecret'
>;

export interface QuestionRouterPort {
  requestQuestion(
    runId: string,
    toolUseId: string,
    questions: QuestionPayload[],
    socketReply: (answer: QuestionAnswer) => void,
  ): Promise<QuestionAnswer>;
  clearPendingForRun(runId: string, options?: { preserveGates?: boolean }): void;
}

export interface CodexAppServerQuestionBridgeOptions {
  runId: string;
  questionRouter: QuestionRouterPort;
  onError?: (error: Error) => void;
}

export class CodexAppServerQuestionBridge {
  private readonly pending = new Map<string, QuestionDispatch>();
  private disposed = false;

  constructor(private readonly options: CodexAppServerQuestionBridgeOptions) {}

  async handleServerRequest(request: QuestionDispatch): Promise<void> {
    if (this.disposed) {
      request.respond({ answers: {} });
      return;
    }

    const key = `${typeof request.id}:${String(request.id)}`;
    this.pending.set(key, request);
    if (request.params.autoResolutionMs !== null) {
      await new Promise<void>((resolve) => setTimeout(resolve, request.params.autoResolutionMs!));
      this.respondIfPending(key, { answers: {} });
      return;
    }

    try {
      const answer = await this.options.questionRouter.requestQuestion(
        this.options.runId,
        request.params.itemId,
        request.params.questions.map(toQuestionPayload),
        () => undefined,
      );
      this.respondIfPending(key, toCodexResponse(request.params.questions, answer));
    } catch (cause) {
      this.respondIfPending(key, { answers: {} });
      this.reportError(new Error(
        `Codex user-input routing failed for request ${String(request.id)}`,
        { cause },
      ));
    }
  }

  teardown(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of [...this.pending.keys()]) {
      this.respondIfPending(key, { answers: {} });
    }
  }

  private respondIfPending(key: string, response: ToolRequestUserInputResponse): void {
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    try {
      request.respond(response);
    } catch (cause) {
      this.reportError(new Error(
        `Failed to respond to Codex user-input request ${String(request.id)}`,
        { cause },
      ));
    }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics must not destabilize question delivery.
    }
  }
}

function toQuestionPayload(question: ToolRequestUserInputQuestion): CodexQuestionPayload {
  return {
    id: question.id,
    header: question.header,
    question: question.question,
    isOther: question.isOther,
    isSecret: question.isSecret,
    multiSelect: false,
    options: question.options?.map((option) => ({ ...option })) ?? [],
  };
}

function toCodexResponse(
  questions: ToolRequestUserInputQuestion[],
  answer: QuestionAnswer,
): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse['answers'] = {};
  for (const question of questions) {
    const value = answer.answers[question.question];
    if (value === undefined) continue;
    answers[question.id] = {
      answers: value.split(',').map((entry) => entry.trim()).filter(Boolean),
    };
  }
  return { answers };
}
