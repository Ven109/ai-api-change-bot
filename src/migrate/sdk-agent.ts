// Handing the edit to the Claude Agent SDK.
//
// We should not be writing a coding agent. This adapter uses one that is
// maintained by people working on nothing else, and keeps for ourselves the
// parts that are actually acb's: the isolated workspace, the brief, the
// deterministic validation and the egress rules.
//
// Why this rather than shelling out to `claude -p` (external.ts):
//   * structured messages, so the transcript records real tool calls instead
//     of scraped stdout;
//   * `canUseTool`, which lets us enforce the same path confinement the
//     built-in agent has — a subprocess cannot be constrained that way;
//   * no dependence on which CLI version the user happens to have.
//
// The package is an *optional* dependency, imported lazily. acb still installs
// with no required runtime dependencies, and a user who never selects this
// agent never pays for it.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { debug, warn } from "../log.ts";
import { isExcludedPath } from "../model/egress.ts";
import { isIgnored } from "../scan/walk.ts";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Tools the agent may use — for documentation, *not* passed as `allowedTools`.
 *
 * A bare name in `allowedTools` auto-approves the tool before `canUseTool` is
 * consulted (the SDK warns about this, and a live run is how we found out).
 * Leaving the list off means every file operation falls through to our
 * permission check, which is the whole reason for using the SDK over a bare
 * subprocess.
 */
const EXPECTED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "TodoWrite"];

/**
 * Denied outright: acb runs validation itself, so the agent never needs a
 * shell, and it has no business fetching anything while migrating.
 */
const DENIED_TOOLS = ["Bash", "WebFetch", "WebSearch", "Task"];

export type SdkQuery = (input: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

export type SdkRunResult = {
  /** Tool calls the agent made, for the transcript. */
  events: { type: string; name?: string; detail?: string }[];
  /** The agent's closing text, if it produced any. */
  summary: string;
  turns: number;
  /** Set when the run ended badly rather than finishing. */
  error?: string;
};

export { EXPECTED_TOOLS };

export type SdkRunInput = {
  config: Config;
  workspaceDir: string;
  brief: string;
  /** Injected in tests; otherwise the real SDK is imported lazily. */
  query?: SdkQuery;
  maxTurns?: number;
};

export async function isSdkAvailable(): Promise<boolean> {
  try {
    await import(SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

async function loadQuery(): Promise<SdkQuery> {
  const module = (await import(SDK_PACKAGE)) as { query?: SdkQuery };
  if (typeof module.query !== "function") {
    throw new Error(`${SDK_PACKAGE} does not export query(); is it the expected version?`);
  }
  return module.query;
}

/**
 * The permission hook. It exists to make one guarantee the subprocess adapter
 * cannot: the agent cannot touch anything outside the workspace copy, and
 * cannot read the paths the user excluded.
 *
 * The signature follows the SDK's installed type definitions — positional
 * arguments, and a `behavior` decision. (The published docs describe a
 * different shape; a live run is how we found out which one is real, because
 * returning the wrong shape silently denies every call.)
 */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export function makePermissionCheck(config: Config, workspaceDir: string) {
  // Resolve symlinks once: on macOS /tmp is /private/tmp, so an agent sending
  // an absolute path would otherwise never look like it is inside the
  // workspace.
  const root = realPath(path.resolve(workspaceDir));

  return async (
    toolName: string,
    input: Record<string, unknown> = {},
  ): Promise<PermissionDecision> => {
    const deny = (message: string): PermissionDecision => {
      debug(`denied ${toolName}: ${message}`);
      return { behavior: "deny", message };
    };

    if (DENIED_TOOLS.includes(toolName)) {
      return deny(`acb does not allow ${toolName} during a migration`);
    }

    const candidates = [input.file_path, input.path, input.notebook_path].filter(
      (value): value is string => typeof value === "string",
    );

    for (const candidate of candidates) {
      const absolute = realPath(path.resolve(root, candidate));
      if (absolute !== root && !absolute.startsWith(root + path.sep)) {
        return deny(`${candidate} is outside the migration workspace`);
      }
      const relative = path.relative(root, absolute);
      if (isExcludedPath(relative, config.privacy.excludePaths)) {
        return deny(`${relative} is excluded by privacy.excludePaths`);
      }
      if (isIgnored(relative, config.ignore)) {
        return deny(`${relative} is outside the scanned tree`);
      }
    }

    return { behavior: "allow", updatedInput: input };
  };
}

export async function runSdkAgent(input: SdkRunInput): Promise<SdkRunResult> {
  const query = input.query ?? (await loadQuery());
  const result: SdkRunResult = { events: [], summary: "", turns: 0 };

  const options: Record<string, unknown> = {
    cwd: input.workspaceDir,
    // No allowedTools: see EXPECTED_TOOLS. Everything must reach canUseTool.
    disallowedTools: DENIED_TOOLS,
    canUseTool: makePermissionCheck(input.config, input.workspaceDir),
    maxTurns: input.maxTurns ?? input.config.migrate.maxSteps,
    // The agent's own instructions live in the brief; this only frames them.
    appendSystemPrompt:
      "You are completing an API migration in a copy of a repository. Make the smallest " +
      "change that completes it, including any tests or mocks that encode the old API. " +
      "Do not touch unrelated code. A human reviews everything you write.",
  };

  try {
    for await (const message of query({ prompt: input.brief, options })) {
      result.turns++;
      const type = String(message.type ?? "unknown");

      if (type === "assistant" || type === "text") {
        const text = extractText(message);
        if (text) result.summary = text;
      }

      for (const call of extractToolCalls(message)) {
        result.events.push({ type: "tool", name: call.name, detail: call.detail });
        debug(`sdk agent: ${call.name} ${call.detail ?? ""}`.trim());
      }

      if (type === "result") {
        const text = extractText(message);
        if (text) result.summary = text;
        if (message.is_error === true || message.subtype === "error") {
          result.error = text || "the agent reported an error";
        }
      }
    }
  } catch (err) {
    result.error = (err as Error).message;
    warn(`the agent SDK stopped early: ${result.error}`);
  }

  return result;
}

/**
 * The real path of `target`, resolving symlinks. For a file that does not
 * exist yet, the nearest existing ancestor is resolved and the rest appended,
 * so a new file in the workspace is judged by where it would land.
 */
function realPath(target: string): string {
  let current = target;
  const trailing: string[] = [];

  for (let depth = 0; depth < 40; depth++) {
    try {
      return path.join(fs.realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      trailing.push(path.basename(current));
      current = parent;
    }
  }
  return target;
}

function extractText(message: Record<string, unknown>): string {
  if (typeof message.result === "string") return message.result;
  if (typeof message.text === "string") return message.text;

  const inner = message.message as { content?: unknown } | undefined;
  const content = inner?.content ?? message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  return "";
}

function extractToolCalls(
  message: Record<string, unknown>,
): { name: string; detail?: string }[] {
  const inner = message.message as { content?: unknown } | undefined;
  const content = inner?.content ?? message.content;
  if (!Array.isArray(content)) return [];

  const calls: { name: string; detail?: string }[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: string; name?: string; input?: Record<string, unknown> };
    if (typed.type !== "tool_use" || !typed.name) continue;
    const target =
      typed.input?.file_path ?? typed.input?.path ?? typed.input?.pattern ?? typed.input?.command;
    calls.push({
      name: typed.name,
      detail: typeof target === "string" ? target.slice(0, 200) : undefined,
    });
  }
  return calls;
}
