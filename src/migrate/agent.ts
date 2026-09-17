// The built-in migration agent: a small, auditable tool-use loop.
//
// It is intentionally not clever. The value acb adds is upstream detection,
// impact analysis, the brief and the validation around the edit — not a better
// agent. Anyone who prefers their own coding agent can plug it in instead
// (AIA-25); this one exists so the tool works out of the box.

import fs from "node:fs";
import path from "node:path";
import { debug, llmStage } from "../log.ts";
import type { Message, ModelProvider, ToolCall } from "../model/provider.ts";
import type { ValidationResult } from "../types.ts";
import { AGENT_TOOLS, runTool, type ToolContext } from "./tools.ts";

export type AgentOutcome = {
  status: "finished" | "budget-exhausted";
  /** The agent's own account of what it did. */
  summary: string;
  steps: number;
  /** The last validation the agent ran, if any. */
  lastValidation?: ValidationResult;
};

export type AgentInput = {
  provider: ModelProvider;
  context: ToolContext;
  /** The migration brief (see brief.ts). */
  brief: string;
  maxSteps: number;
  /** Where to append the tool-by-tool transcript. */
  transcriptFile?: string;
};

const SYSTEM_PROMPT = `You are migrating one repository to an upstream API change. You work in a copy of the repository through the given tools; there is no shell.

How to work:
- Read before you edit. The brief's file:line references are a starting point, not necessarily complete: search for other places the same call is made, including tests.
- Prefer replace_in_file with enough surrounding context to be unique.
- Make the smallest change that completes the migration. Do not reformat, refactor or "improve" unrelated code.
- Tests and mocks that encode the old API are part of the migration: update them so they assert the new behaviour.
- If the change needs a dependency or configuration update, make it.
- Call run_validation when you believe you are done, and fix what it reports. It runs the repository's own checks, verifies the old usage is gone, and checks the calls against the provider's API description.
- Call finish with a short summary once validation passes. If you genuinely cannot complete the migration, call finish with incomplete: true and explain what a human needs to decide.

A human reviews every change you make. Nothing is merged automatically.`;

export async function runAgent(input: AgentInput): Promise<AgentOutcome> {
  const messages: Message[] = [{ role: "user", content: input.brief }];
  let steps = 0;
  let lastValidation: ValidationResult | undefined;

  const wrappedContext: ToolContext = {
    ...input.context,
    validate: async () => {
      lastValidation = await input.context.validate();
      return lastValidation;
    },
  };

  while (steps < input.maxSteps) {
    steps++;
    const response = await input.provider.chat({
      system: SYSTEM_PROMPT,
      messages,
      tools: AGENT_TOOLS,
    });

    if (response.toolCalls.length === 0) {
      // No tool call and no finish: nudge once per step rather than loop
      // silently. Models sometimes narrate instead of acting.
      record(input, { type: "text", text: response.text });
      messages.push({ role: "assistant", content: response.text });
      messages.push({
        role: "user",
        content:
          "Continue by calling a tool. If the migration is done, call finish; " +
          "if you cannot do it, call finish with incomplete: true.",
      });
      continue;
    }

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const outcome = await runTool(wrappedContext, call.name, call.input);
      record(input, {
        type: "tool",
        step: steps,
        name: call.name,
        input: redactLargeInput(call),
        isError: outcome.isError ?? false,
        result: outcome.content.slice(0, 2000),
      });
      debug(`${call.name} -> ${outcome.isError ? "error: " : ""}${firstLine(outcome.content)}`);

      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: outcome.content || "(no output)",
        isError: outcome.isError,
      });

      if (outcome.finished) {
        const incomplete = call.input.incomplete === true;
        return {
          status: "finished",
          summary: incomplete
            ? `Reported incomplete: ${outcome.content}`
            : outcome.content,
          steps,
          lastValidation,
        };
      }
    }
  }

  llmStage(input.provider.label, "migrate", `step budget of ${input.maxSteps} reached`);
  return {
    status: "budget-exhausted",
    summary: `The agent used its full budget of ${input.maxSteps} steps without finishing.`,
    steps,
    lastValidation,
  };
}

/** File contents in a tool call would dwarf the transcript; keep a summary. */
function redactLargeInput(call: ToolCall): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(call.input)) {
    input[key] =
      typeof value === "string" && value.length > 400
        ? `${value.slice(0, 400)}… (${value.length} characters)`
        : value;
  }
  return input;
}

function record(input: AgentInput, entry: Record<string, unknown>): void {
  if (!input.transcriptFile) return;
  fs.mkdirSync(path.dirname(input.transcriptFile), { recursive: true });
  fs.appendFileSync(
    input.transcriptFile,
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
  );
}

function firstLine(text: string): string {
  return text.split("\n")[0].slice(0, 160);
}
