// acb.config.json loading, defaults and validation.
//
// Everything has a usable default: with no config file at all, acb runs in
// deterministic-only mode (scan + spec/changelog diff + prefilter) and never
// contacts a model provider.

import fs from "node:fs";
import path from "node:path";

export type SourceSpec = {
  type: "openapi" | "changelog";
  /** Remote source. Exactly one of url/path is required. */
  url?: string;
  /** Local source, relative to the repo root. Handy for tests and demos. */
  path?: string;
  /** changelog sources only. */
  format?: "markdown" | "html" | "text";
};

export type ModelConfig = {
  /** "none" means deterministic-only: no model is ever called. */
  provider: "none" | "anthropic" | "openai" | "replay";
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  /** replay provider only: recorded responses, relative to the repo root. */
  replayFile?: string;
};

export type Config = {
  /** Repo root; derived, not read from the file. */
  root: string;
  /** Path of the config file that was loaded, if any. */
  configPath?: string;
  model: ModelConfig;
  sources: Record<string, SourceSpec[]>;
  validate: { commands: string[]; timeoutMs: number };
  impact: { minScore: number };
  migrate: {
    agent: {
      /** "auto" picks the best agent available on this machine (see migrate/select.ts). */
      type: "auto" | "sdk" | "builtin" | "command";
      command?: string;
      promptVia?: "stdin" | "arg" | "file";
    };
    maxSteps: number;
    maxAttempts: number;
  };
  privacy: { mode: "snippets" | "local-only"; excludePaths: string[] };
  ignore: string[];
  ignoreHosts: string[];
  /** SDK scanning: force-include or force-exclude dependencies. */
  includeDeps: string[];
  excludeDeps: string[];
};

export const ACB_DIR = ".acb";

export const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ACB_DIR,
  "dist",
  "build",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "coverage",
];

/** Hosts that are never third-party integrations. */
export const DEFAULT_IGNORE_HOSTS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "example.com",
  "www.example.com",
  "example.org",
];

function defaults(root: string): Config {
  return {
    root,
    model: { provider: "none", maxTokens: 4096, temperature: 0 },
    sources: {},
    validate: { commands: [], timeoutMs: 120_000 },
    impact: { minScore: 0.4 },
    migrate: { agent: { type: "auto" }, maxSteps: 30, maxAttempts: 3 },
    privacy: { mode: "snippets", excludePaths: [".env", ".env.*", "*.pem", "*.key"] },
    ignore: [...DEFAULT_IGNORE],
    ignoreHosts: [...DEFAULT_IGNORE_HOSTS],
    includeDeps: [],
    excludeDeps: [],
  };
}

export class ConfigError extends Error {}

const PROVIDERS = new Set(["none", "anthropic", "openai", "replay"]);
const SOURCE_TYPES = new Set(["openapi", "changelog"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Merge a parsed config file over the defaults. Unknown keys are reported
 * rather than ignored, because a silently misspelled key would look like the
 * tool ignoring the user's intent.
 */
export function parseConfig(raw: unknown, root: string, configPath?: string): Config {
  const cfg = defaults(root);
  cfg.configPath = configPath;
  if (raw === undefined) return applyEnvOverrides(cfg);
  if (!isObject(raw)) throw new ConfigError("config root must be a JSON object");

  const known = new Set([
    "model",
    "sources",
    "validate",
    "impact",
    "migrate",
    "privacy",
    "ignore",
    "ignoreHosts",
    "includeDeps",
    "excludeDeps",
    "$schema",
  ]);
  for (const key of Object.keys(raw)) {
    // JSON has no comments, so "//" keys are the usual workaround. Allow them.
    if (key.startsWith("//")) continue;
    if (!known.has(key)) throw new ConfigError(`unknown config key: ${key}`);
  }

  if (raw.model !== undefined) {
    if (!isObject(raw.model)) throw new ConfigError("model must be an object");
    const m = raw.model;
    if (m.provider !== undefined) {
      if (typeof m.provider !== "string" || !PROVIDERS.has(m.provider)) {
        throw new ConfigError(
          `model.provider must be one of: ${[...PROVIDERS].join(", ")}`,
        );
      }
      cfg.model.provider = m.provider as ModelConfig["provider"];
    }
    for (const key of ["model", "baseUrl", "apiKeyEnv", "replayFile"] as const) {
      if (m[key] !== undefined) {
        if (typeof m[key] !== "string") throw new ConfigError(`model.${key} must be a string`);
        cfg.model[key] = m[key] as string;
      }
    }
    for (const key of ["maxTokens", "temperature"] as const) {
      if (m[key] !== undefined) {
        if (typeof m[key] !== "number") throw new ConfigError(`model.${key} must be a number`);
        cfg.model[key] = m[key] as number;
      }
    }
  }

  if (raw.sources !== undefined) {
    if (!isObject(raw.sources)) throw new ConfigError("sources must be an object");
    for (const [integrationId, list] of Object.entries(raw.sources)) {
      if (!Array.isArray(list)) {
        throw new ConfigError(`sources["${integrationId}"] must be an array`);
      }
      cfg.sources[integrationId] = list.map((entry, i) => {
        const where = `sources["${integrationId}"][${i}]`;
        if (!isObject(entry)) throw new ConfigError(`${where} must be an object`);
        if (typeof entry.type !== "string" || !SOURCE_TYPES.has(entry.type)) {
          throw new ConfigError(`${where}.type must be one of: ${[...SOURCE_TYPES].join(", ")}`);
        }
        if (typeof entry.url !== "string" && typeof entry.path !== "string") {
          throw new ConfigError(`${where} needs either a url or a path`);
        }
        if (entry.url !== undefined && entry.path !== undefined) {
          throw new ConfigError(`${where} cannot set both url and path`);
        }
        return {
          type: entry.type as SourceSpec["type"],
          url: entry.url as string | undefined,
          path: entry.path as string | undefined,
          format: entry.format as SourceSpec["format"] | undefined,
        };
      });
    }
  }

  if (raw.validate !== undefined) {
    if (!isObject(raw.validate)) throw new ConfigError("validate must be an object");
    if (raw.validate.commands !== undefined) {
      cfg.validate.commands = requireStringArray(raw.validate.commands, "validate.commands");
    }
    if (raw.validate.timeoutMs !== undefined) {
      if (typeof raw.validate.timeoutMs !== "number") {
        throw new ConfigError("validate.timeoutMs must be a number");
      }
      cfg.validate.timeoutMs = raw.validate.timeoutMs;
    }
  }

  if (raw.impact !== undefined) {
    if (!isObject(raw.impact)) throw new ConfigError("impact must be an object");
    if (raw.impact.minScore !== undefined) {
      if (typeof raw.impact.minScore !== "number") {
        throw new ConfigError("impact.minScore must be a number");
      }
      cfg.impact.minScore = raw.impact.minScore;
    }
  }

  if (raw.migrate !== undefined) {
    if (!isObject(raw.migrate)) throw new ConfigError("migrate must be an object");
    const m = raw.migrate;
    if (m.agent !== undefined) {
      if (!isObject(m.agent)) throw new ConfigError("migrate.agent must be an object");
      const type = m.agent.type ?? "auto";
      if (!["auto", "sdk", "builtin", "command"].includes(type as string)) {
        throw new ConfigError(
          'migrate.agent.type must be "auto", "sdk", "builtin" or "command"',
        );
      }
      if (type === "command" && typeof m.agent.command !== "string") {
        throw new ConfigError('migrate.agent.command is required when type is "command"');
      }
      cfg.migrate.agent = {
        type: type as Config["migrate"]["agent"]["type"],
        command: m.agent.command as string | undefined,
        promptVia: (m.agent.promptVia as "stdin" | "arg" | "file" | undefined) ?? "file",
      };
    }
    for (const key of ["maxSteps", "maxAttempts"] as const) {
      if (m[key] !== undefined) {
        if (typeof m[key] !== "number") throw new ConfigError(`migrate.${key} must be a number`);
        cfg.migrate[key] = m[key] as number;
      }
    }
  }

  if (raw.privacy !== undefined) {
    if (!isObject(raw.privacy)) throw new ConfigError("privacy must be an object");
    if (raw.privacy.mode !== undefined) {
      if (raw.privacy.mode !== "snippets" && raw.privacy.mode !== "local-only") {
        throw new ConfigError('privacy.mode must be "snippets" or "local-only"');
      }
      cfg.privacy.mode = raw.privacy.mode;
    }
    if (raw.privacy.excludePaths !== undefined) {
      cfg.privacy.excludePaths = requireStringArray(
        raw.privacy.excludePaths,
        "privacy.excludePaths",
      );
    }
  }

  if (raw.ignore !== undefined) {
    cfg.ignore = [...DEFAULT_IGNORE, ...requireStringArray(raw.ignore, "ignore")];
  }
  if (raw.ignoreHosts !== undefined) {
    cfg.ignoreHosts = [
      ...DEFAULT_IGNORE_HOSTS,
      ...requireStringArray(raw.ignoreHosts, "ignoreHosts"),
    ];
  }
  if (raw.includeDeps !== undefined) {
    cfg.includeDeps = requireStringArray(raw.includeDeps, "includeDeps");
  }
  if (raw.excludeDeps !== undefined) {
    cfg.excludeDeps = requireStringArray(raw.excludeDeps, "excludeDeps");
  }

  return applyEnvOverrides(cfg);
}

/** ACB_PROVIDER / ACB_MODEL / ACB_BASE_URL win over the file, for CI and demos. */
function applyEnvOverrides(cfg: Config): Config {
  const provider = process.env.ACB_PROVIDER;
  if (provider) {
    if (!PROVIDERS.has(provider)) {
      throw new ConfigError(
        `ACB_PROVIDER must be one of: ${[...PROVIDERS].join(", ")} (got "${provider}")`,
      );
    }
    cfg.model.provider = provider as ModelConfig["provider"];
  }
  if (process.env.ACB_MODEL) cfg.model.model = process.env.ACB_MODEL;
  if (process.env.ACB_BASE_URL) cfg.model.baseUrl = process.env.ACB_BASE_URL;
  return cfg;
}

export const CONFIG_FILENAME = "acb.config.json";

export function loadConfig(root: string): Config {
  const configPath = path.join(root, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return parseConfig(undefined, root);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parseConfig(raw, root, configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw new ConfigError(`${CONFIG_FILENAME}: ${err.message}`);
    }
    throw err;
  }
}
