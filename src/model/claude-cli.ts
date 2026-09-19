// Using the Claude Code CLI as the model for the analysis stage.
//
// The migration stage can already run on a Claude Code login, because an agent
// is a CLI. The analysis stage could not: it wanted an API key. That left
// anyone with a Claude subscription and no API key stuck on recorded
// responses for half the loop, which is a silly place to be.
//
// This provider shells out to `claude -p`, which uses whatever credentials the
// CLI already has. It answers text, which is all the analysis stage needs —
// it asks for JSON. Tool calling is not supported here (that is what the agent
// adapters are for), and asking for it fails loudly rather than silently
// degrading.

import { spawn } from "node:child_process";
import {
  ModelError,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type Usage,
} from "./provider.ts";

export type ClaudeCliOptions = {
  /** Passed to `claude --model`. Omit to use the CLI's own default. */
  model?: string;
  /** The binary to run. */
  binary?: string;
  timeoutMs?: number;
};

export class ClaudeCliProvider implements ModelProvider {
  readonly label: string;
  /** It reaches Anthropic, so privacy.mode "local-only" must still refuse it. */
  readonly remote = true;
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };

  private readonly model?: string;
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCliOptions = {}) {
    this.model = options.model;
    this.binary = options.binary ?? "claude";
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.label = `claude-cli${this.model ? `/${this.model}` : ""}`;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.tools?.length) {
      throw new ModelError(
        "the claude-cli provider cannot do tool calls. Use it for analysis, and let the " +
          'agent do the editing (migrate.agent.type "auto" or "sdk").',
      );
    }

    const args = ["-p"];
    if (this.model) args.push("--model", this.model);

    const text = await this.spawn(args, renderPrompt(request));
    return {
      text,
      toolCalls: [],
      stopReason: "end_turn",
      // The CLI does not report usage in this mode; the report says so rather
      // than inventing a number.
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private spawn(args: string[], prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1" },
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr?.on("data", (chunk) => (stderr += String(chunk)));

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new ModelError(
            `could not run \`${this.binary}\`: ${err.message}. Install the Claude Code CLI, ` +
              `or set model.provider to anthropic/openai with an API key.`,
          ),
        );
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new ModelError(`\`${this.binary} -p\` timed out after ${this.timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          reject(
            new ModelError(
              `\`${this.binary} -p\` exited with ${code}: ${stderr.trim().slice(0, 400)}`,
            ),
          );
          return;
        }
        resolve(stripNotices(stdout).trim());
      });

      // A short-lived child can exit before the prompt finishes writing, and an
      // unhandled EPIPE on stdin takes the whole process down. The exit
      // handlers above already have everything needed to report the outcome,
      // so a broken pipe here is not news.
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    });
  }
}

/** The CLI takes one prompt, so system and messages are flattened into it. */
export function renderPrompt(request: ChatRequest): string {
  const parts: string[] = [];
  if (request.system) parts.push(request.system, "---");
  for (const message of request.messages) {
    if (message.role === "user") parts.push(message.content);
    else if (message.role === "assistant") parts.push(`(your previous answer)\n${message.content}`);
    else parts.push(`(tool result)\n${message.content}`);
  }
  return parts.join("\n\n");
}

/**
 * The CLI occasionally prints an advisory line before the answer (an MCP
 * warning, for instance). Drop leading lines that look like a notice; keep
 * everything from the first real line onward, so prose answers survive.
 */
export function stripNotices(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (
    start < lines.length &&
    /^\s*(\[[\w.-]+\]|warning:|note:)/i.test(lines[start])
  ) {
    start++;
  }
  return lines.slice(start).join("\n");
}
