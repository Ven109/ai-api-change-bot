// OpenAI-compatible Chat Completions adapter (raw HTTP, no SDK).
//
// One adapter covers a lot of ground: OpenAI itself, Azure, OpenRouter, vLLM,
// llama.cpp and Ollama (`baseUrl: "http://localhost:11434/v1"`). A local
// endpoint is also the only way to run acb with no code leaving the machine at
// all, which is why privacy mode `local-only` checks the base URL.

import {
  ModelError,
  requireEnv,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ToolCall,
  type Usage,
} from "./provider.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type OpenAiOptions = {
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
  } catch {
    return false;
  }
}

export class OpenAiProvider implements ModelProvider {
  readonly label: string;
  readonly remote: boolean;
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  private readonly maxTokens: number;
  private readonly temperature?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiOptions = {}) {
    this.model = options.model ?? "gpt-4o-mini";
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKeyEnv = options.apiKeyEnv ?? "OPENAI_API_KEY";
    this.maxTokens = options.maxTokens ?? 16000;
    this.temperature = options.temperature;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.remote = !isLocalBaseUrl(this.baseUrl);
    this.label = `openai/${this.model}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages: toOpenAiMessages(request),
    };
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    // A local server usually needs no key; requiring one would block Ollama.
    if (this.remote || process.env[this.apiKeyEnv]) {
      headers.authorization = `Bearer ${requireEnv(this.apiKeyEnv, "openai")}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      throw new ModelError(
        `openai request failed: ${response.status} ${await safeText(response)}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = payload.choices?.[0];
    const toolCalls: ToolCall[] = [];
    for (const call of choice?.message?.tool_calls ?? []) {
      toolCalls.push({
        id: call.id,
        name: call.function?.name ?? "",
        input: parseArguments(call.function?.arguments),
      });
    }

    this.usage.inputTokens += payload.usage?.prompt_tokens ?? 0;
    this.usage.outputTokens += payload.usage?.completion_tokens ?? 0;

    return {
      text: choice?.message?.content ?? "",
      toolCalls,
      stopReason: choice?.finish_reason ?? "stop",
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    };
  }
}

export function toOpenAiMessages(request: ChatRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (request.system) messages.push({ role: "system", content: request.system });

  for (const message of request.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      });
    } else {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      });
    }
  }

  return messages;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A truncated or malformed tool call is the caller's problem to report,
    // but it must not crash the loop.
    return {};
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}
