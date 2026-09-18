// Finding where an HTTP provider publishes its changes.
//
// SDK dependencies resolve themselves through the registry (registry.ts), but
// `http:<host>` has no equivalent: there is no index mapping a hostname to its
// changelog. That gap is why `sources` is configured by hand, and it is the
// most tedious part of adopting acb.
//
// Two steps, in this order:
//   1. probe well-known locations — deterministic, cheap, and it already
//      covers providers that publish an OpenAPI description;
//   2. ask the model for candidates, then *verify every one by fetching it*.
//      A suggestion that was not fetched and did not look like a spec or a
//      changelog is never shown. The whole point is to save the user a search,
//      not to hand them plausible-looking URLs to check by hand.
//
// Nothing here writes to the config unless asked: `acb sources suggest --write`.

import type { SourceSpec } from "../config.ts";
import { debug } from "../log.ts";
import { chatJson, type ModelProvider } from "../model/index.ts";

export type Suggestion = {
  integrationId: string;
  source: SourceSpec;
  /** How it was found, so the user can weigh it. */
  foundBy: "probe" | "model";
  /** What the fetch actually returned, as evidence. */
  evidence: string;
  confidence: number;
};

export type DiscoverOptions = {
  fetchImpl?: typeof fetch;
  provider?: ModelProvider;
  /** Skip the network entirely. */
  offline?: boolean;
  timeoutMs?: number;
};

/** Paths worth trying blind. Ordered by how conclusive a hit is. */
const SPEC_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/.well-known/openapi.json",
  "/v1/openapi.json",
  "/api-docs",
  "/swagger/v1/swagger.json",
];

const CHANGELOG_PATHS = ["/changelog", "/changes", "/api/changelog", "/docs/changelog"];

/** `api.stripe.com` -> ["stripe.com", "docs.stripe.com", "developer.stripe.com"]. */
export function relatedHosts(host: string): string[] {
  const parts = host.split(".");
  const apex = parts.length > 2 ? parts.slice(-2).join(".") : host;
  return [...new Set([host, apex, `docs.${apex}`, `developers.${apex}`, `developer.${apex}`])];
}

export async function discoverSources(
  integrationId: string,
  options: DiscoverOptions = {},
): Promise<Suggestion[]> {
  if (!integrationId.startsWith("http:")) return [];
  if (options.offline) {
    debug(`${integrationId}: offline, skipping source discovery`);
    return [];
  }

  const host = integrationId.slice("http:".length);
  const found: Suggestion[] = [];

  // 1. Probing. A spec is worth far more than a changelog page, so try those
  // first and stop as soon as one is confirmed.
  for (const path of SPEC_PATHS) {
    const url = `https://${host}${path}`;
    const check = await classify(url, options);
    if (check?.kind === "openapi") {
      found.push({
        integrationId,
        source: { type: "openapi", url },
        foundBy: "probe",
        evidence: check.evidence,
        confidence: 1,
      });
      break;
    }
  }

  if (found.length === 0) {
    for (const candidateHost of relatedHosts(host)) {
      for (const path of CHANGELOG_PATHS) {
        const url = `https://${candidateHost}${path}`;
        const check = await classify(url, options);
        if (check?.kind === "changelog") {
          found.push({
            integrationId,
            source: { type: "changelog", url, format: "html" },
            foundBy: "probe",
            evidence: check.evidence,
            confidence: 0.7,
          });
          break;
        }
      }
      if (found.length > 0) break;
    }
  }

  // 2. The model, only when probing found nothing and only as a source of
  // candidate URLs — never as a source of truth.
  if (found.length === 0 && options.provider) {
    for (const url of await askModelForCandidates(host, options.provider)) {
      const check = await classify(url, options);
      if (!check) continue;
      found.push({
        integrationId,
        source:
          check.kind === "openapi"
            ? { type: "openapi", url }
            : { type: "changelog", url, format: "html" },
        foundBy: "model",
        evidence: check.evidence,
        confidence: check.kind === "openapi" ? 0.9 : 0.6,
      });
      if (found.length >= 2) break;
    }
  }

  return found;
}

type Classification = { kind: "openapi" | "changelog"; evidence: string };

/**
 * Fetch a candidate and decide what it actually is. This is the step that
 * makes a model suggestion safe: an unreachable or unrelated URL is dropped
 * here rather than written into someone's config.
 */
export async function classify(
  url: string,
  options: DiscoverOptions,
): Promise<Classification | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { accept: "application/json, text/html, text/markdown", "user-agent": "acb" },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  let text: string;
  try {
    text = (await response.text()).slice(0, 20_000);
  } catch {
    return undefined;
  }

  // A spec is unambiguous: it declares its own version and has paths.
  if (/"(openapi|swagger)"\s*:/.test(text) && /"paths"\s*:/.test(text)) {
    const version = text.match(/"(?:openapi|swagger)"\s*:\s*"([^"]+)"/)?.[1] ?? "?";
    const operations = (text.match(/"(get|post|put|patch|delete)"\s*:/g) ?? []).length;
    return {
      kind: "openapi",
      evidence: `OpenAPI ${version}, ${operations}+ operations at ${url}`,
    };
  }

  // A changelog is a judgement call, so require more than the word itself:
  // dated entries are what makes a page usable as a source.
  const dates = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).length;
  const longFormDates = (
    text.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}\b/gi,
    ) ?? []
  ).length;
  const mentionsChanges = /changelog|release notes|what'?s new|deprecat|breaking change/i.test(text);

  if (mentionsChanges && dates + longFormDates >= 3) {
    return {
      kind: "changelog",
      evidence: `changelog-like page with ${dates + longFormDates} dated entries at ${url}`,
    };
  }

  return undefined;
}

const SYSTEM = `You know where API providers publish their machine-readable specifications and their changelogs.

Given a hostname, name the URLs where that provider publishes:
- an OpenAPI/Swagger description of the API
- a changelog, release notes, or API deprecation announcements

Rules:
- Only URLs you are confident exist. Every one will be fetched and checked, and wrong ones are discarded, so guessing wastes everyone's time.
- Prefer the raw specification file over a documentation page that merely renders it.
- At most 5 URLs.
- Reply with JSON only: {"urls": ["https://..."]}`;

async function askModelForCandidates(host: string, provider: ModelProvider): Promise<string[]> {
  try {
    const answer = await chatJson<{ urls?: unknown }>(
      provider,
      {
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content:
              `Hostname: ${host}\n\nWhere does this provider publish its OpenAPI description and ` +
              `its changelog or deprecation notices?`,
          },
        ],
      },
      { requiredKeys: ["urls"] },
    );

    const urls = Array.isArray(answer.urls) ? answer.urls : [];
    return urls
      .filter((url): url is string => typeof url === "string" && /^https?:\/\//.test(url))
      .slice(0, 5);
  } catch (err) {
    debug(`source suggestion failed for ${host}: ${(err as Error).message}`);
    return [];
  }
}

/** The config fragment to add, ready to paste or write. */
export function renderSuggestions(suggestions: Suggestion[]): string {
  const sources: Record<string, SourceSpec[]> = {};
  for (const suggestion of suggestions) {
    sources[suggestion.integrationId] = [
      ...(sources[suggestion.integrationId] ?? []),
      suggestion.source,
    ];
  }
  return JSON.stringify({ sources }, null, 2);
}
