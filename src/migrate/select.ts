// Choosing which agent does the edit.
//
// The default is "auto", and auto means: use a real coding agent if this
// machine has one. acb's own loop is the fallback for a machine that has
// nothing installed, not the thing we want people running.
//
// Order of preference, and why:
//   1. the Claude Agent SDK — a maintained agent, plus a permission hook we
//      can use to enforce the workspace confinement;
//   2. an agent CLI on PATH (claude, codex, aider) — same idea, less control,
//      no install needed beyond what the user already has;
//   3. the built-in loop — works everywhere, understands nothing about the
//      repository beyond what our seven tools expose.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "../config.ts";
import { debug } from "../log.ts";
import { AGENT_PRESETS } from "./external.ts";
import { isSdkAvailable } from "./sdk-agent.ts";

const execFileAsync = promisify(execFile);

export type SelectedAgent =
  | { kind: "sdk"; label: string }
  | { kind: "command"; label: string; command: string; promptVia: "stdin" | "file" | "arg" }
  | { kind: "builtin"; label: string };

/** CLIs worth looking for, best first. */
const CLI_CANDIDATES: [string, keyof typeof AGENT_PRESETS][] = [
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["aider", "aider"],
];

export async function isOnPath(binary: string): Promise<boolean> {
  try {
    await execFileAsync("command", ["-v", binary], { shell: true });
    return true;
  } catch {
    return false;
  }
}

export async function selectAgent(config: Config): Promise<SelectedAgent> {
  const configured = config.migrate.agent;

  if (configured.type === "command" && configured.command) {
    return {
      kind: "command",
      label: `command: ${configured.command}`,
      command: configured.command,
      promptVia: configured.promptVia ?? "file",
    };
  }
  if (configured.type === "sdk") {
    return { kind: "sdk", label: "claude agent sdk" };
  }
  if (configured.type === "builtin") {
    return { kind: "builtin", label: "acb built-in agent" };
  }

  // auto
  if (await isSdkAvailable()) {
    debug("auto: using the Claude Agent SDK");
    return { kind: "sdk", label: "claude agent sdk (auto-detected)" };
  }

  for (const [binary, preset] of CLI_CANDIDATES) {
    if (await isOnPath(binary)) {
      const { command, promptVia } = AGENT_PRESETS[preset];
      debug(`auto: using ${binary} (${command})`);
      return {
        kind: "command",
        label: `${binary} (auto-detected)`,
        command,
        promptVia,
      };
    }
  }

  debug("auto: no agent found, falling back to the built-in loop");
  return { kind: "builtin", label: "acb built-in agent (no agent found on this machine)" };
}

/** One line for the user, so the choice is never a surprise. */
export function explainSelection(agent: SelectedAgent): string {
  switch (agent.kind) {
    case "sdk":
      return `agent: ${agent.label}. Set migrate.agent.type to "builtin" or "command" to change it.`;
    case "command":
      return `agent: ${agent.label}. Set migrate.agent to change it.`;
    case "builtin":
      return (
        `agent: ${agent.label}. Installing a coding agent (npm i -D @anthropic-ai/claude-agent-sdk, ` +
        `or the claude/codex/aider CLI) gives better migrations.`
      );
  }
}
