// Checking this repository's HTTP calls against the provider's current spec.
//
// Repository tests usually mock HTTP, so they keep passing even when the call
// itself is wrong — which is exactly the failure mode a migration can
// introduce. When the provider publishes an OpenAPI description we can check
// the calls against it statically, without the network and without trusting
// the repo's own test quality. That makes this the strongest validation signal
// acb has for an HTTP integration, and it works as a standalone check too
// (`acb contract`), even when nothing changed upstream.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { indexOperations, canonicalizePath, type SpecOperation } from "../check/openapi.ts";
import { debug } from "../log.ts";
import { acbPaths } from "../state.ts";
import { snapshotName } from "../check/sources.ts";
import type { CallSite, Manifest } from "../types.ts";

export type ContractProblem = {
  severity: "error" | "warning";
  integrationId: string;
  file: string;
  line: number;
  message: string;
};

export type ContractResult = {
  problems: ContractProblem[];
  /** Integrations that were checked, and how many call sites each. */
  checked: { integrationId: string; callSites: number }[];
  /** Integrations skipped because no spec snapshot is available. */
  skipped: string[];
};

export type ContractOptions = {
  config: Config;
  manifest: Manifest;
  /** Where the spec snapshots live. Defaults to the config root's .acb/specs. */
  specsDir?: string;
  /** Only check this integration. */
  integrationId?: string;
};

export function checkContracts(options: ContractOptions): ContractResult {
  const { config, manifest } = options;
  const specsDir = options.specsDir ?? acbPaths(config.root).specs;
  const result: ContractResult = { problems: [], checked: [], skipped: [] };

  for (const integration of manifest.integrations) {
    if (integration.kind !== "http") continue;
    if (options.integrationId && integration.id !== options.integrationId) continue;

    const operations = loadSpec(specsDir, integration.id, config);
    if (!operations) {
      result.skipped.push(integration.id);
      continue;
    }

    result.checked.push({ integrationId: integration.id, callSites: integration.callSites.length });
    for (const site of integration.callSites) {
      result.problems.push(...checkCallSite(site, integration.id, operations));
    }
  }

  result.problems.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message),
  );
  return result;
}

function checkCallSite(
  site: CallSite,
  integrationId: string,
  operations: Map<string, SpecOperation>,
): ContractProblem[] {
  if (!site.pathTemplate) return [];
  const method = (site.method ?? "GET").toUpperCase();
  const where = `${method} ${site.pathTemplate}`;
  const problem = (severity: "error" | "warning", message: string): ContractProblem => ({
    severity,
    integrationId,
    file: site.file,
    line: site.line,
    message,
  });

  const operation = findOperation(operations, method, site.pathTemplate);
  if (!operation) {
    const alternatives = sameePathOtherMethods(operations, site.pathTemplate);
    return [
      problem(
        "error",
        `\`${where}\` is not in the provider's API description` +
          (alternatives.length ? `. That path exists for: ${alternatives.join(", ")}` : ""),
      ),
    ];
  }

  const problems: ContractProblem[] = [];
  if (operation.deprecated) {
    problems.push(
      problem(
        "error",
        `\`${where}\` is deprecated upstream` +
          (operation.sunset ? ` (sunset ${operation.sunset})` : "") +
          (operation.description ? `: ${firstSentence(operation.description)}` : ""),
      ),
    );
  }

  const declared = new Map(
    operation.parameters.filter((p) => p.in === "query").map((p) => [p.name, p]),
  );
  const used = new Set(site.queryParams ?? []);

  for (const name of used) {
    // A templated parameter name (`{key}`) means the code builds it
    // dynamically; there is nothing to check.
    if (name.includes("{")) continue;
    if (!declared.has(name)) {
      problems.push(
        problem(
          "error",
          `\`${where}\` passes the query parameter \`${name}\`, which the provider does not ` +
            `define` +
            (declared.size ? `. Defined: ${[...declared.keys()].join(", ")}` : ""),
        ),
      );
    }
  }

  for (const [name, parameter] of declared) {
    if (parameter.required && !used.has(name)) {
      problems.push(
        problem(
          "warning",
          `\`${where}\` does not visibly pass the required query parameter \`${name}\` ` +
            `(it may be added dynamically)`,
        ),
      );
    }
  }

  return problems;
}

/**
 * Match a call site against the spec. Paths are compared with parameter names
 * erased, and a spec whose server URL carries a base path has already had it
 * folded in, so `/v1/shipments/{id}` matches `{shipment_id}` too.
 */
export function findOperation(
  operations: Map<string, SpecOperation>,
  method: string,
  pathTemplate: string,
): SpecOperation | undefined {
  const canonical = canonicalizePath(pathTemplate);
  const direct = operations.get(`${method} ${canonical}`);
  if (direct) return direct;

  // The code may include a prefix the spec omits (or the other way round),
  // e.g. a gateway mount point. Accept a full trailing-segment match.
  for (const operation of operations.values()) {
    if (operation.method !== method) continue;
    if (segmentsEqualFromEnd(canonical, operation.canonicalPath)) return operation;
  }
  return undefined;
}

function segmentsEqualFromEnd(a: string, b: string): boolean {
  const left = a.split("/").filter(Boolean);
  const right = b.split("/").filter(Boolean);
  if (left.length === 0 || right.length === 0) return false;
  const shared = Math.min(left.length, right.length);
  if (shared < Math.max(left.length, right.length) && shared < 2) return false;
  for (let i = 1; i <= shared; i++) {
    if (left[left.length - i] !== right[right.length - i]) return false;
  }
  return true;
}

function sameePathOtherMethods(
  operations: Map<string, SpecOperation>,
  pathTemplate: string,
): string[] {
  const canonical = canonicalizePath(pathTemplate);
  return [...operations.values()]
    .filter((operation) => operation.canonicalPath === canonical)
    .map((operation) => operation.method);
}

function loadSpec(
  specsDir: string,
  integrationId: string,
  config: Config,
): Map<string, SpecOperation> | undefined {
  // Prefer the snapshot acb keeps, which is the version the last `check` saw.
  const candidates = [path.join(specsDir, snapshotName(integrationId, ".json"))];

  // Fall back to a configured local spec, so `acb contract` works before the
  // first `check` has run.
  for (const source of config.sources[integrationId] ?? []) {
    if (source.type === "openapi" && source.path) {
      candidates.push(path.resolve(config.root, source.path));
    }
  }

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const operations = indexOperations(JSON.parse(fs.readFileSync(file, "utf8")));
      if (operations.size > 0) {
        debug(`contract check for ${integrationId} against ${file}`);
        return operations;
      }
    } catch {
      // Not usable as a spec; try the next candidate.
    }
  }
  return undefined;
}

function firstSentence(text: string): string {
  const match = text.match(/^(.{0,200}?[.!?])(\s|$)/s);
  return (match?.[1] ?? text.slice(0, 200)).trim();
}

export function contractSummary(result: ContractResult): string {
  const errors = result.problems.filter((p) => p.severity === "error").length;
  const warnings = result.problems.length - errors;
  if (result.checked.length === 0) {
    return "no integration with a spec, contract check skipped";
  }
  const sites = result.checked.reduce((total, entry) => total + entry.callSites, 0);
  return `${sites} call site(s) against ${result.checked.length} spec(s): ${errors} error(s), ${warnings} warning(s)`;
}
