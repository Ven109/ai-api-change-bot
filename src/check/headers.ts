// Asking the API itself whether it is going away.
//
// An OpenAPI spec is the best upstream signal, and plenty of providers do not
// publish one. But a provider does not need a spec, a changelog or a docs site
// to tell you an endpoint is being retired — two standard response headers say
// it directly, at the exact URL your code calls:
//
//   Deprecation: @1688169599                      (RFC 9745)
//   Sunset: Sat, 31 Dec 2026 23:59:59 GMT         (RFC 8594)
//
// Both are machine-readable dates, so this is a fully deterministic source: no
// model, no parsing of prose, no guessing. When a provider sets them, it is the
// most reliable signal there is, because it comes from the endpoint itself
// rather than a page someone remembered to update.
//
// It is opt-in (`{"type": "headers"}`), because unlike every other source this
// one makes live requests to a third party.

import type { Config } from "../config.ts";
import { debug, warn } from "../log.ts";
import { sha256 } from "../scan/index.ts";
import type { ChangeEntry, Integration } from "../types.ts";

export type HeaderProbeOptions = {
  offline?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra headers, e.g. an Authorization value from the environment. */
  headers?: Record<string, string>;
};

export type ProbeOutcome = {
  entries: ChangeEntry[];
  /** Call sites that could not be probed, and why. */
  skipped: { pathTemplate: string; reason: string }[];
};

/** `Deprecation: @1688169599` — an RFC 9651 structured Date. */
export function parseDeprecation(value: string | null): string | undefined {
  if (!value) return undefined;
  const epoch = value.trim().match(/^@(-?\d+)$/);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString().slice(0, 10);
  // Some providers send an HTTP-date here despite the specification.
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

/** `Sunset: Sat, 31 Dec 2026 23:59:59 GMT` — an HTTP-date. */
export function parseSunset(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value.trim());
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

export async function probeDeprecationHeaders(
  integration: Integration,
  config: Config,
  options: HeaderProbeOptions = {},
): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = { entries: [], skipped: [] };
  if (integration.kind !== "http" || !integration.host) return outcome;
  if (options.offline) {
    debug(`${integration.id}: offline, not probing headers`);
    return outcome;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const seen = new Set<string>();

  for (const site of integration.callSites) {
    const pathTemplate = site.pathTemplate;
    if (!pathTemplate) continue;

    // A path parameter has no safe value to substitute: guessing one would
    // probe an endpoint that does not exist, and a 404 rarely carries the
    // headers. Those call sites are reported as skipped rather than faked.
    if (pathTemplate.includes("{")) {
      outcome.skipped.push({
        pathTemplate,
        reason: "path parameters cannot be filled in safely",
      });
      continue;
    }

    const method = (site.method ?? "GET").toUpperCase();
    // Only read-shaped calls are probed. Sending a HEAD to a POST endpoint is
    // pointless; sending a POST would be unforgivable.
    if (method !== "GET" && method !== "HEAD") {
      outcome.skipped.push({ pathTemplate, reason: `${method} is not safe to probe` });
      continue;
    }

    const url = `https://${integration.host}${pathTemplate}`;
    if (seen.has(url)) continue;
    seen.add(url);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        headers: { "user-agent": "acb", ...options.headers },
      });
    } catch (err) {
      outcome.skipped.push({ pathTemplate, reason: (err as Error).message });
      continue;
    }

    const deprecation = parseDeprecation(response.headers.get("deprecation"));
    const sunset = parseSunset(response.headers.get("sunset"));
    const link = response.headers.get("link") ?? "";

    if (!deprecation && !sunset) {
      debug(`${url}: no deprecation headers (${response.status})`);
      continue;
    }

    const title = `Endpoint announces its own deprecation: ${method} ${pathTemplate}`;
    const body =
      `\`${method} ${pathTemplate}\` returned deprecation headers:\n\n` +
      (deprecation ? `- \`Deprecation: ${deprecation}\` (RFC 9745)\n` : "") +
      (sunset ? `- \`Sunset: ${sunset}\` — it stops serving traffic then (RFC 8594)\n` : "") +
      (describeSuccessor(link) ?? "") +
      `\nThe API said this itself, at the URL this repository calls.`;

    outcome.entries.push({
      id: sha256(`${integration.id}|headers|${method}|${pathTemplate}|${deprecation}|${sunset}`).slice(0, 16),
      integrationId: integration.id,
      source: `${url} (response headers)`,
      // Structured like a spec entry, because it is exactly as precise.
      kind: "openapi",
      title,
      body,
      date: sunset ?? deprecation,
      tags: sunset ? ["deprecation", "sunset", "breaking"] : ["deprecation"],
      identifiers: [{ method, pathTemplate }],
    });
  }

  if (outcome.entries.length) {
    debug(`${integration.id}: ${outcome.entries.length} endpoint(s) announced a deprecation`);
  }
  return outcome;
}

/**
 * RFC 9745 suggests pointing at the replacement with a Link header, which is
 * the one thing that makes a deprecation immediately actionable.
 */
function describeSuccessor(linkHeader: string): string | undefined {
  const successor = linkHeader.match(/<([^>]+)>\s*;\s*rel="?(successor-version|alternate|deprecation)"?/i);
  if (!successor) return undefined;
  return `- The provider points at: ${successor[1]} (rel=${successor[2]})\n`;
}

/** Warn once when a probe is configured but nothing could be checked. */
export function explainSkipped(outcome: ProbeOutcome, integrationId: string): void {
  if (outcome.entries.length > 0 || outcome.skipped.length === 0) return;
  const reasons = [...new Set(outcome.skipped.map((entry) => entry.reason))];
  warn(
    `${integrationId}: no endpoint could be probed for deprecation headers ` +
      `(${reasons.join("; ")}). Configure an openapi or changelog source instead.`,
  );
}
