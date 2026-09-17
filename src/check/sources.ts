// Fetching upstream sources: a local file or an HTTP URL.
//
// Network failures are warnings, never errors: one unreachable changelog must
// not abort a scheduled run over a dozen integrations.

import fs from "node:fs";
import path from "node:path";
import type { SourceSpec } from "../config.ts";
import { debug, warn } from "../log.ts";

export type LoadedSource = {
  spec: SourceSpec;
  /** Human-readable origin, used in reports. */
  origin: string;
  text: string;
};

export type LoadOptions = {
  root: string;
  offline: boolean;
  timeoutMs?: number;
};

export async function loadSource(
  spec: SourceSpec,
  options: LoadOptions,
): Promise<LoadedSource | undefined> {
  if (spec.path) {
    const absolute = path.resolve(options.root, spec.path);
    try {
      return { spec, origin: spec.path, text: fs.readFileSync(absolute, "utf8") };
    } catch (err) {
      warn(`could not read ${spec.path}: ${(err as Error).message}`);
      return undefined;
    }
  }

  if (!spec.url) return undefined;
  if (options.offline) {
    debug(`offline: skipping ${spec.url}`);
    return undefined;
  }

  try {
    const response = await fetch(spec.url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      headers: { accept: "application/json, text/markdown, text/html, text/plain" },
    });
    if (!response.ok) {
      warn(`${spec.url} returned ${response.status}`);
      return undefined;
    }
    return { spec, origin: spec.url, text: await response.text() };
  } catch (err) {
    warn(`could not fetch ${spec.url}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Snapshot file for an integration's spec, e.g. `.acb/specs/api.stripe.com.json`. */
export function snapshotName(integrationId: string, origin: string): string {
  const host = integrationId.startsWith("http:") ? integrationId.slice(5) : integrationId;
  const suffix = origin.endsWith(".yaml") || origin.endsWith(".yml") ? ".yaml" : ".json";
  return `${host.replace(/[^\w.-]/g, "_")}${suffix}`;
}
