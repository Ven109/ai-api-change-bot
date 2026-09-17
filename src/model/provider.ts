// The model interface every stage talks to.
//
// Bring your own model: a hosted frontier model, something local over an
// OpenAI-compatible endpoint, or recorded responses for offline demos and
// tests. Adapters are written against the providers' HTTP APIs with `fetch`
// rather than their SDKs, because acb ships with zero runtime dependencies and
// has to speak to several providers through one interface.

export type ToolSchema = {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
};

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export type ChatRequest = {
  system?: string;
  messages: Message[];
  tools?: ToolSchema[];
  maxTokens?: number;
};

export type Usage = { inputTokens: number; outputTokens: number };

export type ChatResponse = {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
  usage: Usage;
};

export interface ModelProvider {
  /** Shown in stage output, e.g. `anthropic/claude-opus-5`. */
  readonly label: string;
  /** True when requests leave this machine, which the privacy mode checks. */
  readonly remote: boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Totals across the run, for the report footer. */
  readonly usage: Usage;
}

export class ModelError extends Error {}

/** Thrown when a stage needs a model but none is configured. */
export class NoModelConfiguredError extends ModelError {
  constructor(what: string) {
    super(
      `${what} needs a model, but none is configured. Set "model" in acb.config.json ` +
        `(provider: anthropic | openai | replay) or pass --no-llm for the deterministic ` +
        `report only.`,
    );
  }
}

export function requireEnv(name: string, provider: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ModelError(
      `the ${provider} provider needs ${name} to be set in the environment`,
    );
  }
  return value;
}

/**
 * Pull the first JSON object out of a model response. Models wrap JSON in
 * prose or fences often enough that failing on it would be a papercut.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const start = candidate.search(/[[{]/);
    if (start === -1) continue;
    const opening = candidate[start];
    const closing = opening === "{" ? "}" : "]";

    let depth = 0;
    let quote = false;
    for (let i = start; i < candidate.length; i++) {
      const char = candidate[i];
      if (quote) {
        if (char === "\\") i++;
        else if (char === '"') quote = false;
        continue;
      }
      if (char === '"') quote = true;
      else if (char === opening) depth++;
      else if (char === closing) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new ModelError("the model did not return JSON");
}
