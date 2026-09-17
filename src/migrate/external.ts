// Handing the edit to the coding agent the user already trusts.
//
// Plenty of developers already pay for Claude Code, Codex CLI or Aider, and
// acb should not compete on agent quality. What it contributes is the upstream
// detection, the impact analysis, the brief and the validation — so letting
// someone plug in their own agent makes the bring-your-own story real.
//
// acb prepares the workspace, writes the brief to ACB_TASK.md, runs the
// configured command with the workspace as its working directory, and then
// validates the result itself. The external agent's claims are never taken at
// face value, exactly as with the built-in one.

import { spawn } from "node:child_process";
import path from "node:path";
import type { Config } from "../config.ts";
import { debug } from "../log.ts";
import { writeFile } from "../state.ts";
import { AGENT_FILES } from "./workspace.ts";

export type ExternalRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ExternalAgentInput = {
  config: Config;
  workspaceDir: string;
  brief: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_LIMIT = 200_000;

/**
 * Run the configured agent command against the workspace.
 *
 * `promptVia` decides how the brief reaches it:
 *   file   — written to ACB_TASK.md, the command is told to read it (default)
 *   stdin  — piped in, which is what `claude -p` and `aider --message-file -` want
 *   arg    — appended as a single argument
 */
export async function runExternalAgent(
  input: ExternalAgentInput,
): Promise<ExternalRunResult> {
  const agent = input.config.migrate.agent;
  if (agent.type !== "command" || !agent.command) {
    throw new Error("migrate.agent.command is not configured");
  }

  const taskFile = path.join(input.workspaceDir, AGENT_FILES[0]);
  writeFile(taskFile, input.brief);

  const promptVia = agent.promptVia ?? "file";
  const command =
    promptVia === "arg"
      ? `${agent.command} ${JSON.stringify(fileInstruction(AGENT_FILES[0]))}`
      : agent.command;

  debug(`external agent: ${command} (prompt via ${promptVia}) in ${input.workspaceDir}`);

  return new Promise<ExternalRunResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd: input.workspaceDir,
      shell: true,
      env: {
        ...process.env,
        ACB_TASK_FILE: AGENT_FILES[0],
        // Some agents look at these; make the non-interactive intent explicit.
        CI: "1",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += String(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });

    if (promptVia === "stdin") {
      child.stdin?.end(input.brief);
    } else {
      child.stdin?.end(promptVia === "file" ? fileInstruction(AGENT_FILES[0]) + "\n" : "");
    }
  });
}

function fileInstruction(taskFile: string): string {
  return (
    `Read ${taskFile} in this directory and carry out the migration it describes. ` +
    `Edit the files in place. Do not commit anything.`
  );
}

/** Presets that are known to work, for the README and for error messages. */
export const AGENT_PRESETS: Record<string, { command: string; promptVia: "stdin" | "file" }> = {
  "claude-code": {
    command: "claude -p --permission-mode acceptEdits",
    promptVia: "stdin",
  },
  codex: { command: "codex exec --full-auto", promptVia: "stdin" },
  aider: { command: "aider --yes --message-file ACB_TASK.md", promptVia: "file" },
};
