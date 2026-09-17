// Finding upstream sources for SDK dependencies, automatically.
//
// For a package there is metadata to follow, so the user should not have to
// configure anything: the registry gives the latest version and the repository,
// and the repository gives release notes and a changelog. No provider is named
// anywhere in here — it is the same three lookups for every package.
//
// (HTTP integrations have no equivalent. There is no registry mapping a host to
// its changelog, which is why `sources` is manual for those, and why a shared
// upstream-knowledge service is the interesting hosted product idea.)

import type { ChangeEntry } from "../types.ts";
import { debug, warn } from "../log.ts";
import { parseChangelog } from "./changelog.ts";

export type ResolvedSource = {
  kind: "github-releases" | "github-changelog";
  url: string;
  /** The version the repository currently declares, for filtering. */
  fromVersion?: string;
  latestVersion?: string;
  repository?: string;
};

export type RegistryOptions = {
  offline: boolean;
  fetchImpl?: typeof fetch;
  /** Optional token; raises the GitHub rate limit from 60/hour to 5000. */
  githubToken?: string;
};

const CHANGELOG_NAMES = ["CHANGELOG.md", "CHANGES.md", "HISTORY.md", "CHANGELOG"];

/** Strip a range so `^4.20.0` compares as `4.20.0`. */
export function cleanVersion(range: string | undefined): string | undefined {
  if (!range) return undefined;
  const match = range.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match[0] : undefined;
}

/** Enough semver to answer "is this release newer than what we have". */
export function isNewer(candidate: string, current: string | undefined): boolean {
  const left = parseVersion(candidate);
  if (!left) return false;
  const right = parseVersion(current ?? "0.0.0");
  if (!right) return true;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

function parseVersion(text: string): [number, number, number] | undefined {
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** `git+https://github.com/openai/openai-node.git` -> `openai/openai-node`. */
export function githubSlug(repositoryUrl: string | undefined): string | undefined {
  if (!repositoryUrl) return undefined;
  const match = repositoryUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function resolveSource(
  integrationId: string,
  declaredVersion: string | undefined,
  options: RegistryOptions,
): Promise<ResolvedSource | undefined> {
  if (options.offline) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;

  const [ecosystem, ...rest] = integrationId.split(":");
  const name = rest.join(":");
  if (!name) return undefined;

  let repository: string | undefined;
  let latestVersion: string | undefined;

  if (ecosystem === "npm") {
    const metadata = await getJson<{
      "dist-tags"?: { latest?: string };
      repository?: { url?: string } | string;
      homepage?: string;
    }>(fetchImpl, `https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (!metadata) return undefined;
    latestVersion = metadata["dist-tags"]?.latest;
    const raw =
      typeof metadata.repository === "string" ? metadata.repository : metadata.repository?.url;
    repository = githubSlug(raw) ?? githubSlug(metadata.homepage);
  } else if (ecosystem === "pypi") {
    const metadata = await getJson<{
      info?: { version?: string; project_urls?: Record<string, string>; home_page?: string };
    }>(fetchImpl, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    if (!metadata) return undefined;
    latestVersion = metadata.info?.version;
    const urls = Object.values(metadata.info?.project_urls ?? {});
    repository =
      urls.map((url) => githubSlug(url)).find(Boolean) ?? githubSlug(metadata.info?.home_page);
  } else {
    return undefined;
  }

  if (!repository) {
    debug(`${integrationId}: no repository in the registry metadata`);
    return undefined;
  }

  return {
    kind: "github-releases",
    url: `https://api.github.com/repos/${repository}/releases?per_page=30`,
    fromVersion: cleanVersion(declaredVersion),
    latestVersion,
    repository,
  };
}

/**
 * Release notes newer than the declared version, as change entries. Falls back
 * to the repository's changelog file when a project publishes no releases.
 */
export async function fetchSdkChanges(
  integrationId: string,
  source: ResolvedSource,
  options: RegistryOptions,
): Promise<ChangeEntry[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "acb",
  };
  if (options.githubToken) headers.authorization = `Bearer ${options.githubToken}`;

  const releases = await getJson<
    { tag_name?: string; name?: string; body?: string; published_at?: string }[]
  >(fetchImpl, source.url, headers);

  if (releases && releases.length > 0) {
    const entries: ChangeEntry[] = [];
    for (const release of releases) {
      const version = cleanVersion(release.tag_name ?? release.name ?? "");
      if (!version || !isNewer(version, source.fromVersion)) continue;
      const title = `${release.name || release.tag_name} (${integrationId})`;
      const parsed = parseChangelog(`## ${title}\n\n${release.body ?? ""}`, {
        integrationId,
        source: `${source.repository} releases`,
        format: "markdown",
      });
      for (const entry of parsed) {
        entries.push({ ...entry, version, date: release.published_at?.slice(0, 10) ?? entry.date });
      }
    }
    if (entries.length > 0) return entries;
    debug(`${integrationId}: no releases newer than ${source.fromVersion}`);
    return [];
  }

  // No releases: try the changelog file on the default branch.
  for (const name of CHANGELOG_NAMES) {
    const url = `https://raw.githubusercontent.com/${source.repository}/HEAD/${name}`;
    const text = await getText(fetchImpl, url);
    if (!text) continue;
    debug(`${integrationId}: using ${name} from ${source.repository}`);
    return parseChangelog(text, {
      integrationId,
      source: url,
      format: "markdown",
    }).filter((entry) => !entry.version || isNewer(entry.version, source.fromVersion));
  }

  return [];
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string> = { accept: "application/json", "user-agent": "acb" },
): Promise<T | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 403 || response.status === 429) {
      warn(
        `${url} rate-limited. Set GITHUB_TOKEN to raise the limit; skipping for now.`,
      );
      return undefined;
    }
    if (!response.ok) {
      debug(`${url} returned ${response.status}`);
      return undefined;
    }
    return (await response.json()) as T;
  } catch (err) {
    warn(`could not reach ${url}: ${(err as Error).message}`);
    return undefined;
  }
}

async function getText(fetchImpl: typeof fetch, url: string): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
}
