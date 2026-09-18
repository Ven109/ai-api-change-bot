// Output helpers. The one rule worth keeping: every stage announces whether it
// is deterministic or model-powered, so the boundary is visible in the terminal
// and not just in the docs.

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Something needs a human: a relevant change was found, or validation failed. */
export const EXIT_ACTION_REQUIRED = 2;

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export function isVerbose(): boolean {
  return verbose;
}

export function info(message: string): void {
  process.stdout.write(message + "\n");
}

export function debug(message: string): void {
  if (verbose) process.stdout.write(`  · ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

/** `[deterministic] scan: 2 integrations, 5 call sites` */
export function stage(label: string, message: string): void {
  info(`[deterministic] ${label}: ${message}`);
}

/** `[LLM anthropic/claude-…] impact: 3 candidates assessed` */
export function llmStage(providerLabel: string, label: string, message: string): void {
  info(`[LLM ${providerLabel}] ${label}: ${message}`);
}
