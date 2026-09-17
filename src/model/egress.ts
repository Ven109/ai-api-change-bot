// The single point where anything leaves this machine.
//
// acb's promise is that your code stays in your environment. With a
// bring-your-own-model setup something does go to whichever provider you
// chose (unless it is a local one), so the least we can do is make that
// exactly inspectable and exactly limited:
//
//   * every model request goes through EgressGuard — there is no other path;
//   * secrets are redacted before sending;
//   * privacy.mode "local-only" refuses a remote provider outright;
//   * --dry-run-llm writes the prompts to .acb/egress/ and sends nothing;
//   * the report footer says what was sent, how much, and to whom.

import path from "node:path";
import type { Config } from "../config.ts";
import { debug, warn } from "../log.ts";
import { isIgnored } from "../scan/walk.ts";
import { acbPaths } from "../state.ts";
import { writeJson } from "../state.ts";
import {
  ModelError,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type Usage,
} from "./provider.ts";

/** Patterns whose *value* must never be sent. Names stay, values go. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]"],
  [/\b(sk-ant-[A-Za-z0-9_-]{8,})/g, "[REDACTED]"],
  [/\b(ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED]"],
  [/\b(AKIA[0-9A-Z]{12,})/g, "[REDACTED]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, "[REDACTED]"],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, "[REDACTED]"],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
  // KEY=secret, "api_key": "secret", appid=secret. The name is kept so the
  // model still knows which credential the code is reaching for.
  [
    /\b([\w.-]*(?:key|token|secret|password|passwd|appid)[\w.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"',;}&]{6,})\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
];

export type Redaction = { count: number; text: string };

export function redactSecrets(text: string): Redaction {
  let count = 0;
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, (...args) => {
      count++;
      // Let String.replace do the group substitution for us.
      const groups = args.slice(0, -2) as string[];
      return replacement.replace(/\$(\d)/g, (_m, index) => groups[Number(index)] ?? "");
    });
  }
  return { count, text: result };
}

/** True when the agent must not read this path at all. */
export function isExcludedPath(relativePath: string, excludePaths: string[]): boolean {
  const patterns = [...excludePaths, ".env", ".env.*"];
  return isIgnored(relativePath, patterns);
}

export type EgressStats = {
  requests: number;
  charactersSent: number;
  redactions: number;
  provider: string;
  dryRun: boolean;
};

export class DryRunError extends ModelError {
  readonly file: string;

  constructor(file: string) {
    super(`dry run: the prompt was written to ${file} and nothing was sent`);
    this.file = file;
  }
}

export type GuardOptions = {
  config: Config;
  /** Write prompts to .acb/egress/ instead of sending them. */
  dryRun?: boolean;
};

export class EgressGuard implements ModelProvider {
  readonly label: string;
  readonly remote: boolean;
  readonly stats: EgressStats;

  private readonly inner: ModelProvider;
  private readonly config: Config;
  private readonly dryRun: boolean;
  private sequence = 0;

  constructor(inner: ModelProvider, options: GuardOptions) {
    this.inner = inner;
    this.config = options.config;
    this.dryRun = options.dryRun ?? false;
    this.label = inner.label;
    this.remote = inner.remote;
    this.stats = {
      requests: 0,
      charactersSent: 0,
      redactions: 0,
      provider: inner.label,
      dryRun: this.dryRun,
    };

    if (this.config.privacy.mode === "local-only" && inner.remote) {
      throw new ModelError(
        `privacy.mode is "local-only" but ${inner.label} is a remote provider. ` +
          `Point model.baseUrl at a local endpoint (for example Ollama at ` +
          `http://localhost:11434/v1), switch to the replay provider, or relax privacy.mode.`,
      );
    }
  }

  get usage(): Usage {
    return this.inner.usage;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const redacted = this.redactRequest(request);
    this.sequence++;
    this.stats.requests++;
    this.stats.charactersSent += requestSize(redacted);

    if (this.dryRun) {
      const file = path.join(
        acbPaths(this.config.root).egress,
        `${String(this.sequence).padStart(3, "0")}-request.json`,
      );
      writeJson(file, { provider: this.inner.label, request: redacted });
      debug(`dry run: wrote ${file}`);
      throw new DryRunError(file);
    }

    return this.inner.chat(redacted);
  }

  private redactRequest(request: ChatRequest): ChatRequest {
    let redactions = 0;
    const scrub = (text: string): string => {
      const result = redactSecrets(text);
      redactions += result.count;
      return result.text;
    };

    const scrubbed: ChatRequest = {
      ...request,
      system: request.system ? scrub(request.system) : undefined,
      messages: request.messages.map((message) =>
        message.role === "assistant"
          ? { ...message, content: scrub(message.content) }
          : { ...message, content: scrub(message.content) },
      ),
    };

    if (redactions > 0) {
      this.stats.redactions += redactions;
      debug(`redacted ${redactions} secret-looking value(s) before sending`);
    }
    return scrubbed;
  }

  /** One line for the report footer. */
  summary(): string {
    if (this.stats.dryRun) {
      return `Dry run: ${this.stats.requests} prompt(s) written to .acb/egress/, nothing sent.`;
    }
    const where = this.remote ? this.stats.provider : `${this.stats.provider} (local)`;
    return (
      `Sent ${this.stats.requests} request(s), ${this.stats.charactersSent} characters ` +
      `of context to ${where}; ${this.stats.redactions} secret-looking value(s) redacted.`
    );
  }
}

function requestSize(request: ChatRequest): number {
  let size = request.system?.length ?? 0;
  for (const message of request.messages) size += message.content.length;
  return size;
}

/** Wrap a provider, unless there is none (deterministic-only mode). */
export function guard(
  provider: ModelProvider | undefined,
  options: GuardOptions,
): EgressGuard | undefined {
  if (!provider) return undefined;
  const guarded = new EgressGuard(provider, options);
  if (guarded.remote && options.config.privacy.mode === "snippets") {
    debug(`${guarded.label} is remote: matched snippets will be sent, not whole files`);
  }
  if (guarded.remote && options.dryRun !== true) {
    warn(
      `sending context to ${guarded.label}. Use --dry-run-llm to inspect the prompts first.`,
    );
  }
  return guarded;
}
