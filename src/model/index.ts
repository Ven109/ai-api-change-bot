// Provider selection, and the JSON-shaped request helper the analysis stages
// use. Switching models is a config or env change; no stage knows which
// provider it is talking to.

import path from "node:path";
import type { Config } from "../config.ts";
import { debug, warn } from "../log.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { ClaudeCliProvider } from "./claude-cli.ts";
import { OpenAiProvider } from "./openai.ts";
import { ReplayProvider } from "./replay.ts";
import {
  ModelError,
  extractJson,
  type ChatRequest,
  type ModelProvider,
} from "./provider.ts";

export * from "./provider.ts";
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.ts";
export { OpenAiProvider, isLocalBaseUrl } from "./openai.ts";
export { ClaudeCliProvider } from "./claude-cli.ts";
export { ReplayProvider, type Recording } from "./replay.ts";

/** The configured provider, or undefined in deterministic-only mode. */
export function createProvider(config: Config): ModelProvider | undefined {
  const model = config.model;
  switch (model.provider) {
    case "none":
      return undefined;
    case "anthropic":
      return new AnthropicProvider({
        model: model.model,
        baseUrl: model.baseUrl,
        apiKeyEnv: model.apiKeyEnv,
        maxTokens: model.maxTokens,
      });
    case "openai":
      return new OpenAiProvider({
        model: model.model,
        baseUrl: model.baseUrl,
        apiKeyEnv: model.apiKeyEnv,
        maxTokens: model.maxTokens,
        temperature: model.temperature,
      });
    case "claude-cli":
      // Uses whatever credentials the Claude Code CLI already has, so a
      // subscription works with no API key.
      return new ClaudeCliProvider({ model: model.model });
    case "replay": {
      const file = model.replayFile ?? process.env.ACB_REPLAY_FILE;
      if (!file) {
        throw new ModelError(
          'the replay provider needs model.replayFile (or ACB_REPLAY_FILE) to point at a recording',
        );
      }
      return ReplayProvider.fromFile(path.resolve(config.root, file));
    }
  }
}

export type JsonChatOptions = {
  /** Keys the response must contain, so a malformed answer is caught here. */
  requiredKeys?: string[];
  maxTokens?: number;
};

/**
 * Ask for JSON and validate it. One retry, with the validation error fed back,
 * because that recovers most formatting slips for the price of one call.
 */
export async function chatJson<T = unknown>(
  provider: ModelProvider,
  request: ChatRequest,
  options: JsonChatOptions = {},
): Promise<T> {
  let attempt = 0;
  let lastError: Error | undefined;
  let messages = request.messages;

  while (attempt < 2) {
    attempt++;
    const response = await provider.chat({ ...request, messages, maxTokens: options.maxTokens });

    try {
      const parsed = extractJson(response.text);
      for (const key of options.requiredKeys ?? []) {
        if (typeof parsed !== "object" || parsed === null || !(key in parsed)) {
          throw new ModelError(`the response is missing the "${key}" field`);
        }
      }
      return parsed as T;
    } catch (err) {
      lastError = err as Error;
      debug(`invalid JSON from ${provider.label}: ${lastError.message}`);
      messages = [
        ...messages,
        { role: "assistant", content: response.text },
        {
          role: "user",
          content:
            `That was not usable: ${lastError.message}. ` +
            `Reply with the JSON object only, no prose and no code fence.`,
        },
      ];
    }
  }

  warn(`${provider.label} did not return valid JSON after two attempts`);
  throw lastError ?? new ModelError("no JSON response");
}
