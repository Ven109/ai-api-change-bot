// Anthropic Messages API adapter (raw HTTP, no SDK — see provider.ts).
//
// Notes that cost time if you rediscover them the hard way:
//   * current models reject `temperature` and the other sampling parameters,
//     so acb never sends them;
//   * thinking is adaptive by default on these models, so there is no thinking
//     parameter here either;
//   * tool results go back as a user message containing tool_result blocks.

import {
  ModelError,
  requireEnv,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type ModelProvider,
  type ToolCall,
  type Usage,
} from "./provider.ts";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type AnthropicOptions = {
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

export class AnthropicProvider implements ModelProvider {
  readonly label: string;
  readonly remote = true;
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };

  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKeyEnv: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKeyEnv = options.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    this.maxTokens = options.maxTokens ?? 16000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.label = `anthropic/${this.model}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages: toAnthropicMessages(request.messages),
    };
    if (request.system) body.system = request.system;
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": requireEnv(this.apiKeyEnv, "anthropic"),
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      throw new ModelError(
        `anthropic request failed: ${response.status} ${await safeText(response)}`,
      );
    }

    const payload = (await response.json()) as {
      content?: Block[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of payload.content ?? []) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
      }
    }

    this.usage.inputTokens += payload.usage?.input_tokens ?? 0;
    this.usage.outputTokens += payload.usage?.output_tokens ?? 0;

    return {
      text,
      toolCalls,
      stopReason: payload.stop_reason ?? "end_turn",
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
      },
    };
  }
}

export function toAnthropicMessages(
  messages: Message[],
): { role: "user" | "assistant"; content: Block[] }[] {
  const result: { role: "user" | "assistant"; content: Block[] }[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      result.push({ role: "user", content: [{ type: "text", text: message.content }] });
      continue;
    }

    if (message.role === "assistant") {
      const content: Block[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      }
      result.push({ role: "assistant", content });
      continue;
    }

    // Tool results are user-role blocks, and consecutive ones belong in the
    // same message so parallel tool calls come back together.
    const block: Block = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
      ...(message.isError ? { is_error: true } : {}),
    };
    const last = result.at(-1);
    if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) {
      last.content.push(block);
    } else {
      result.push({ role: "user", content: [block] });
    }
  }

  return result;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}
