// OpenAPI specs as a change source.
//
// This is the strongest signal acb has for an HTTP integration: comparing two
// snapshots of a provider's spec yields exact `method + path + parameter`
// change items, so deciding whether they affect the repository needs no model
// at all. Prose changelogs (AIA-6) cover providers that publish no spec, and
// explain the "why" for those that do.

import type { ChangeEntry, ChangeIdentifier } from "../types.ts";
import { sha256 } from "../scan/index.ts";

export type SpecParameter = {
  name: string;
  in: string;
  required: boolean;
  description: string;
};

export type SpecOperation = {
  method: string;
  /** Path as written in the spec, including any server base path. */
  path: string;
  /** Path with parameter names erased, so {id} and {shipment_id} compare equal. */
  canonicalPath: string;
  operationId?: string;
  summary: string;
  description: string;
  deprecated: boolean;
  sunset?: string;
  parameters: SpecParameter[];
  /** Top-level property names of the success response schema. */
  responseProperties: string[];
};

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function canonicalizePath(path: string): string {
  const withoutParams = path.replace(/\{[^}]*\}/g, "{}");
  return withoutParams.length > 1 ? withoutParams.replace(/\/$/, "") : withoutParams;
}

/** Resolve local `$ref`s. Remote refs are left alone: a spec is one document here. */
export function resolveRefs(node: unknown, root: unknown, depth = 0): unknown {
  if (depth > 12 || node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((item) => resolveRefs(item, root, depth + 1));

  const object = node as Record<string, unknown>;
  const ref = object.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    const target = ref
      .slice(2)
      .split("/")
      .reduce<unknown>((current, rawSegment) => {
        const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
        if (current === null || typeof current !== "object") return undefined;
        return (current as Record<string, unknown>)[segment];
      }, root);
    if (target === undefined) return object;
    const { $ref: _ref, ...rest } = object;
    return { ...(resolveRefs(target, root, depth + 1) as object), ...rest };
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    result[key] = resolveRefs(value, root, depth + 1);
  }
  return result;
}

/** The server base path, so spec paths line up with the URLs in the code. */
export function serverBasePath(spec: Record<string, unknown>): string {
  const servers = spec.servers;
  if (!Array.isArray(servers) || servers.length === 0) return "";
  const url = (servers[0] as Record<string, unknown>)?.url;
  if (typeof url !== "string") return "";
  try {
    const parsed = new URL(url.replace(/\{[^}]*\}/g, "x"));
    return parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  } catch {
    // A relative server URL such as "/v3" is itself the base path.
    return url.startsWith("/") ? url.replace(/\/$/, "") : "";
  }
}

/** Flatten a spec into operations keyed by `METHOD canonicalPath`. */
export function indexOperations(rawSpec: unknown): Map<string, SpecOperation> {
  const operations = new Map<string, SpecOperation>();
  if (rawSpec === null || typeof rawSpec !== "object") return operations;

  const spec = resolveRefs(rawSpec, rawSpec) as Record<string, unknown>;
  const base = serverBasePath(spec);
  const paths = spec.paths;
  if (paths === null || typeof paths !== "object") return operations;

  for (const [rawPath, rawItem] of Object.entries(paths as Record<string, unknown>)) {
    if (rawItem === null || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    const sharedParameters = readParameters(item.parameters);

    for (const method of METHODS) {
      const rawOperation = item[method];
      if (rawOperation === null || typeof rawOperation !== "object") continue;
      const operation = rawOperation as Record<string, unknown>;

      const fullPath = `${base}${rawPath}`;
      const parameters = [...sharedParameters, ...readParameters(operation.parameters)];
      const record: SpecOperation = {
        method: method.toUpperCase(),
        path: fullPath,
        canonicalPath: canonicalizePath(fullPath),
        operationId: asString(operation.operationId),
        summary: asString(operation.summary) ?? "",
        description: asString(operation.description) ?? "",
        deprecated: operation.deprecated === true,
        sunset: asString(operation["x-sunset"]),
        parameters,
        responseProperties: readResponseProperties(operation.responses),
      };
      operations.set(`${record.method} ${record.canonicalPath}`, record);
    }
  }

  return operations;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readParameters(value: unknown): SpecParameter[] {
  if (!Array.isArray(value)) return [];
  const parameters: SpecParameter[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const parameter = entry as Record<string, unknown>;
    const name = asString(parameter.name);
    if (!name) continue;
    parameters.push({
      name,
      in: asString(parameter.in) ?? "query",
      required: parameter.required === true,
      description: asString(parameter.description) ?? "",
    });
  }
  return parameters;
}

function readResponseProperties(responses: unknown): string[] {
  if (responses === null || typeof responses !== "object") return [];
  const byStatus = responses as Record<string, unknown>;
  const successStatus = Object.keys(byStatus).find((status) => /^2\d\d$/.test(status));
  if (!successStatus) return [];

  const response = byStatus[successStatus] as Record<string, unknown> | undefined;
  const content = response?.content as Record<string, unknown> | undefined;
  if (!content) return [];
  const jsonType = Object.keys(content).find((type) => type.includes("json"));
  if (!jsonType) return [];

  const schema = (content[jsonType] as Record<string, unknown> | undefined)?.schema as
    | Record<string, unknown>
    | undefined;
  const target = (schema?.type === "array" ? schema.items : schema) as
    | Record<string, unknown>
    | undefined;
  const properties = target?.properties;
  if (properties === null || typeof properties !== "object") return [];
  return Object.keys(properties as Record<string, unknown>).sort();
}

export type SpecDiffOptions = {
  integrationId: string;
  /** Where the new spec came from, for the report. */
  source: string;
};

/**
 * Structural diff between two spec snapshots, as change entries.
 *
 * Every entry carries machine-matchable identifiers, which is what lets the
 * prefilter (AIA-7) decide relevance without asking a model anything.
 */
export function diffSpecs(
  oldSpec: unknown,
  newSpec: unknown,
  options: SpecDiffOptions,
): ChangeEntry[] {
  const before = indexOperations(oldSpec);
  const after = indexOperations(newSpec);
  const entries: ChangeEntry[] = [];

  const add = (input: {
    title: string;
    body: string;
    tags: string[];
    identifiers: ChangeIdentifier[];
    date?: string;
  }): void => {
    entries.push({
      id: sha256(`${options.integrationId}|${input.title}|${input.body}`).slice(0, 16),
      integrationId: options.integrationId,
      source: options.source,
      kind: "openapi",
      title: input.title,
      body: input.body,
      date: input.date,
      tags: input.tags,
      identifiers: input.identifiers,
    });
  };

  for (const [key, operation] of before) {
    const updated = after.get(key);
    const where = `${operation.method} ${operation.path}`;

    if (!updated) {
      add({
        title: `Operation removed: ${where}`,
        body:
          `\`${where}\` is no longer present in the API description.\n\n` +
          (operation.summary ? `It used to be: ${operation.summary}\n` : "") +
          suggestReplacements(operation, before, after),
        tags: ["breaking", "removal"],
        identifiers: [{ method: operation.method, pathTemplate: operation.path }],
      });
      continue;
    }

    if (!operation.deprecated && updated.deprecated) {
      add({
        title: `Operation deprecated: ${where}`,
        body:
          `\`${where}\` is now marked deprecated.\n\n` +
          (updated.description || updated.summary || "") +
          (updated.sunset ? `\n\nSunset date: ${updated.sunset}.` : "") +
          suggestReplacements(operation, before, after),
        tags: ["deprecation", updated.sunset ? "sunset" : "breaking"],
        identifiers: [{ method: updated.method, pathTemplate: updated.path }],
        date: updated.sunset,
      });
    }

    diffParameters(operation, updated, where, add);
    diffResponseProperties(operation, updated, where, add);
  }

  for (const [key, operation] of after) {
    if (before.has(key)) continue;
    add({
      title: `Operation added: ${operation.method} ${operation.path}`,
      body:
        `\`${operation.method} ${operation.path}\` is new.\n\n` +
        (operation.summary || operation.description || ""),
      tags: ["new"],
      identifiers: [{ method: operation.method, pathTemplate: operation.path }],
    });
  }

  return entries.sort((a, b) => a.title.localeCompare(b.title));
}

type AddEntry = (input: {
  title: string;
  body: string;
  tags: string[];
  identifiers: ChangeIdentifier[];
  date?: string;
}) => void;

function diffParameters(
  before: SpecOperation,
  after: SpecOperation,
  where: string,
  add: AddEntry,
): void {
  const beforeByName = new Map(before.parameters.map((p) => [p.name, p]));
  const afterByName = new Map(after.parameters.map((p) => [p.name, p]));

  const removed = before.parameters.filter((p) => !afterByName.has(p.name));
  const added = after.parameters.filter((p) => !beforeByName.has(p.name));

  for (const parameter of removed) {
    // A parameter that disappears while a similar one appears is a rename in
    // practice, and saying so makes the migration obvious.
    const renamedTo = added.find(
      (candidate) =>
        candidate.in === parameter.in &&
        (similarDescription(candidate.description, parameter.description) ||
          mentionsName(candidate.description, parameter.name)),
    );

    if (renamedTo) {
      add({
        title: `Parameter renamed: ${parameter.name} -> ${renamedTo.name} (${where})`,
        body:
          `The \`${parameter.in}\` parameter \`${parameter.name}\` of \`${where}\` ` +
          `is now called \`${renamedTo.name}\`.` +
          (renamedTo.description ? `\n\n${renamedTo.description}` : ""),
        tags: ["breaking", "rename"],
        identifiers: [
          { method: after.method, pathTemplate: after.path, param: parameter.name },
          { method: after.method, pathTemplate: after.path, param: renamedTo.name },
        ],
      });
      continue;
    }

    add({
      title: `Parameter removed: ${parameter.name} (${where})`,
      body: `The \`${parameter.in}\` parameter \`${parameter.name}\` of \`${where}\` is gone.`,
      tags: ["breaking", "removal"],
      identifiers: [
        { method: after.method, pathTemplate: after.path, param: parameter.name },
      ],
    });
  }

  for (const parameter of after.parameters) {
    const previous = beforeByName.get(parameter.name);
    if (previous && !previous.required && parameter.required) {
      add({
        title: `Parameter now required: ${parameter.name} (${where})`,
        body:
          `The \`${parameter.in}\` parameter \`${parameter.name}\` of \`${where}\` ` +
          `is now mandatory.` +
          (parameter.description ? `\n\n${parameter.description}` : ""),
        tags: ["breaking"],
        identifiers: [
          { method: after.method, pathTemplate: after.path, param: parameter.name },
        ],
      });
    }
  }
}

function diffResponseProperties(
  before: SpecOperation,
  after: SpecOperation,
  where: string,
  add: AddEntry,
): void {
  const removed = before.responseProperties.filter((p) => !after.responseProperties.includes(p));
  const added = after.responseProperties.filter((p) => !before.responseProperties.includes(p));

  for (const field of removed) {
    add({
      title: `Response field removed: ${field} (${where})`,
      body:
        `The success response of \`${where}\` no longer contains \`${field}\`.` +
        (added.length ? `\n\nNew fields in this response: ${added.map((f) => `\`${f}\``).join(", ")}.` : ""),
      tags: ["breaking", "removal"],
      identifiers: [
        { method: after.method, pathTemplate: after.path, field },
        ...added.map((f) => ({ method: after.method, pathTemplate: after.path, field: f })),
      ],
    });
  }
}

/** Point a removed or deprecated operation at plausible successors. */
function suggestReplacements(
  operation: SpecOperation,
  before: Map<string, SpecOperation>,
  after: Map<string, SpecOperation>,
): string {
  const tail = operation.canonicalPath.split("/").filter(Boolean).pop() ?? "";
  const candidates = [...after.values()].filter(
    (candidate) =>
      !before.has(`${candidate.method} ${candidate.canonicalPath}`) &&
      (candidate.method === operation.method || candidate.canonicalPath.includes(tail)) &&
      !candidate.deprecated,
  );
  if (candidates.length === 0) return "";
  const list = candidates
    .slice(0, 3)
    .map((candidate) => `- \`${candidate.method} ${candidate.path}\`${candidate.summary ? `: ${candidate.summary}` : ""}`)
    .join("\n");
  return `\n\nNew operations that may replace it:\n${list}\n`;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function similarDescription(a: string, b: string): boolean {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.startsWith(right) || right.startsWith(left)) return true;

  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  let shared = 0;
  for (const word of leftWords) if (rightWords.has(word)) shared++;
  return shared / Math.max(leftWords.size, rightWords.size) >= 0.6;
}

function mentionsName(description: string, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(description);
}
