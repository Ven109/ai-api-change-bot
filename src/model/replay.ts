// Recorded model responses.
//
// Two jobs: let the test suite exercise the model-powered stages offline, and
// let `npm run demo` run the whole loop on a machine with no API key. It is
// **not a model** — it replays a script, and every stage that uses it says so
// in its output, so a demo can never be mistaken for a live run.

import fs from "node:fs";
import {
  ModelError,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type Usage,
} from "./provider.ts";

export type RecordedResponse = {
  /** Optional note about where this recording came from. */
  note?: string;
  /** Only replay this when the request text contains all of these. */
  when?: string[];
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  stopReason?: string;
};

export type Recording = { responses: RecordedResponse[] };

export class ReplayProvider implements ModelProvider {
  readonly label = "replay (recorded responses, not a live model)";
  readonly remote = false;
  readonly usage: Usage = { inputTokens: 0, outputTokens: 0 };

  private readonly responses: RecordedResponse[];
  private readonly used = new Set<number>();
  private callIndex = 0;

  constructor(recording: Recording) {
    this.responses = recording.responses ?? [];
  }

  static fromFile(file: string): ReplayProvider {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new ModelError(`could not read the replay file ${file}: ${(err as Error).message}`);
    }
    try {
      return new ReplayProvider(JSON.parse(raw) as Recording);
    } catch (err) {
      throw new ModelError(`${file} is not valid JSON: ${(err as Error).message}`);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const haystack = requestText(request);
    const index = this.responses.findIndex(
      (response, i) =>
        !this.used.has(i) &&
        (response.when ?? []).every((needle) => haystack.includes(needle)),
    );

    if (index === -1) {
      throw new ModelError(
        `no recorded response left for request #${this.callIndex + 1}. ` +
          `Record one whose "when" matches, for example: ` +
          `${JSON.stringify(haystack.slice(0, 160))}`,
      );
    }

    this.used.add(index);
    this.callIndex++;
    const recorded = this.responses[index];

    return {
      text: recorded.text ?? "",
      toolCalls: (recorded.toolCalls ?? []).map((call, i) => ({
        id: `replay-${this.callIndex}-${i}`,
        name: call.name,
        input: call.input,
      })),
      stopReason: recorded.stopReason ?? (recorded.toolCalls?.length ? "tool_use" : "end_turn"),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

function requestText(request: ChatRequest): string {
  const parts = [request.system ?? ""];
  for (const message of request.messages) parts.push(message.content ?? "");
  return parts.join("\n");
}
