// Making the calls that a profile is built from.
//
// Two rules govern everything here, and both come from the brief rather than
// from convenience:
//
//   1. The developer's credentials come from the developer's environment and
//      are never written anywhere. A profile records types, not values, so
//      even the recorded artifact cannot leak a response.
//   2. We only ever send requests that are safe to repeat. A probe runs on a
//      schedule, unattended, against production, so a mutating verb is not a
//      thing we will guess at.

import type { Integration } from "../types.ts";
import { debug } from "../log.ts";

export type ObserveSpec = {
  /** Defaults to `https://<host>`. */
  baseUrl?: string;
  /**
   * Header auth. The value may contain `${ENV_VAR}`, resolved from the
   * process environment at call time, so no secret is written in the config.
   */
  auth?: { header?: string; value?: string };
  /**
   * Concrete paths to probe, with real ids filled in. When omitted we derive
   * them from the manifest's own GET call sites, which is the zero-config path.
   */
  paths?: string[];
  /** How many times to call each path. More samples, fewer false positives. */
  samples?: number;
};

export type Probe = { method: "GET"; url: string; path: string };

export type ProbeResult = {
  probe: Probe;
  status: number;
  /** Parsed JSON bodies, one per sample. */
  bodies: unknown[];
  /** Why this probe produced nothing, when it did not. */
  skipped?: string;
};

export const DEFAULT_SAMPLES = 3;

/**
 * Turn an integration into a probe list.
 *
 * Templated paths are skipped, not guessed: `/v1/users/{id}` has no safe
 * concrete form we can invent, and calling `/v1/users/%7Bid%7D` teaches us
 * nothing except what a 404 looks like. The developer fills those in via
 * `paths`, which is the one piece of configuration this feature asks for.
 */
export function plannedProbes(
  integration: Integration,
  spec: ObserveSpec,
): { probes: Probe[]; skipped: { path: string; reason: string }[] } {
  const base = (spec.baseUrl ?? `https://${integration.host ?? ""}`).replace(/\/+$/, "");
  const probes: Probe[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const seen = new Set<string>();

  const explicit = spec.paths ?? [];
  const candidates = explicit.length
    ? explicit.map((path) => ({ path, method: "GET" }))
    : integration.callSites.map((site) => ({
        path: site.pathTemplate ?? "",
        method: (site.method ?? "GET").toUpperCase(),
      }));

  for (const candidate of candidates) {
    if (!candidate.path) continue;
    if (candidate.method !== "GET") {
      skipped.push({ path: candidate.path, reason: `${candidate.method} is not safe to repeat` });
      continue;
    }
    // Only when derived: an explicit path is the developer saying "this one".
    if (!explicit.length && candidate.path.includes("{")) {
      skipped.push({
        path: candidate.path,
        reason: "templated — add a concrete path under observe to include it",
      });
      continue;
    }
    const url = `${base}${candidate.path.startsWith("/") ? "" : "/"}${candidate.path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    probes.push({ method: "GET", url, path: candidate.path });
  }

  return { probes, skipped };
}

/** `Bearer ${STRIPE_KEY}` -> the value, or an explanation of what is missing. */
export function resolveAuth(spec: ObserveSpec): { header: string; value: string } | { error: string } | null {
  const auth = spec.auth;
  if (!auth?.header || !auth.value) return null;

  const missing: string[] = [];
  const value = auth.value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const found = process.env[name];
    if (found === undefined || found === "") missing.push(name);
    return found ?? "";
  });

  if (missing.length) {
    return { error: `set ${missing.join(", ")} in your environment to probe this API` };
  }
  return { header: auth.header, value };
}

export type RunProbeOptions = {
  spec: ObserveSpec;
  samples?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function runProbe(probe: Probe, options: RunProbeOptions): Promise<ProbeResult> {
  const samples = options.samples ?? options.spec.samples ?? DEFAULT_SAMPLES;
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };

  const auth = resolveAuth(options.spec);
  if (auth && "error" in auth) {
    return { probe, status: 0, bodies: [], skipped: auth.error };
  }
  if (auth) headers[auth.header] = auth.value;

  const bodies: unknown[] = [];
  let status = 0;

  for (let index = 0; index < samples; index++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
    try {
      const response = await doFetch(probe.url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      status = response.status;
      const text = await response.text();
      try {
        bodies.push(JSON.parse(text));
      } catch {
        // A non-JSON body is a legitimate observation of "this is not the API
        // any more" -- an HTML error page, for instance -- but it cannot be
        // profiled, so it is reported rather than silently dropped.
        return { probe, status, bodies, skipped: `response was not JSON (HTTP ${status})` };
      }
    } catch (err) {
      clearTimeout(timer);
      return { probe, status, bodies, skipped: (err as Error).message };
    }
    clearTimeout(timer);
    debug(`probe ${probe.url} -> ${status}`);
  }

  return { probe, status, bodies };
}
