import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { scanRepo } from "../src/scan/index.ts";
import {
  extractSdkCallSites,
  importedBindings,
  parseRequirement,
  readDeclaredDependencies,
} from "../src/scan/sdk.ts";

const tempDirs: string[] = [];

function tempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acb-sdk-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("an ESM default import with a member chain", () => {
  const root = tempRepo({
    "package.json": JSON.stringify({
      dependencies: { openai: "^4.20.0" },
      devDependencies: { typescript: "^5.0.0" },
    }),
    "src/summarize.js": `
import OpenAI from "openai";

const client = new OpenAI();

export async function summarize(text) {
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: text }],
  });
  return completion.choices[0].message.content;
}
`,
  });

  const { manifest } = scanRepo(loadConfig(root));
  const integration = manifest.integrations.find((i) => i.id === "npm:openai");
  assert.ok(integration, "expected npm:openai");
  assert.equal(integration.kind, "sdk");
  assert.equal(integration.declaredVersion, "^4.20.0");
  const members = integration.callSites.map((s) => s.member);
  assert.ok(members.includes("OpenAI"));
  assert.ok(
    members.some((m) => m === "client.chat.completions.create"),
    `expected the member chain, got ${members.join(", ")}`,
  );
});

test("a python import with a member chain", () => {
  const root = tempRepo({
    "requirements.txt": "stripe==7.1.0\nrequests>=2.31.0\npytest==8.0.0  # dev only\n",
    "billing.py": `
import stripe

def charge(amount):
    return stripe.Charge.create(amount=amount, currency="eur")
`,
  });

  const { manifest } = scanRepo(loadConfig(root));
  const integration = manifest.integrations.find((i) => i.id === "pypi:stripe");
  assert.ok(integration, "expected pypi:stripe");
  assert.equal(integration.declaredVersion, "==7.1.0");
  assert.ok(integration.callSites.some((s) => s.member === "stripe.Charge.create"));

  // Tooling is filtered out, and requests is declared but never imported here.
  assert.equal(manifest.integrations.some((i) => i.id === "pypi:pytest"), false);
  assert.equal(manifest.integrations.some((i) => i.id === "pypi:requests"), false);
});

test("dev dependencies and unused dependencies are not integrations", () => {
  const root = tempRepo({
    "package.json": JSON.stringify({
      dependencies: { "left-pad": "^1.3.0" },
      devDependencies: { eslint: "^9.0.0" },
    }),
    "src/index.js": "export const x = 1;\n",
  });

  const { manifest } = scanRepo(loadConfig(root));
  assert.deepEqual(manifest.integrations, []);
});

test("config can force a dependency in or out", () => {
  const files = {
    "package.json": JSON.stringify({ dependencies: { dotenv: "^16.0.0" } }),
    "src/index.js": 'import dotenv from "dotenv";\ndotenv.config();\n',
  };

  const withoutOverride = scanRepo(loadConfig(tempRepo(files))).manifest;
  assert.equal(withoutOverride.integrations.length, 0, "dotenv is tooling by default");

  const root = tempRepo({
    ...files,
    "acb.config.json": JSON.stringify({ includeDeps: ["dotenv"] }),
  });
  const withOverride = scanRepo(loadConfig(root)).manifest;
  assert.deepEqual(
    withOverride.integrations.map((i) => i.id),
    ["npm:dotenv"],
  );

  const excluded = tempRepo({
    "package.json": JSON.stringify({ dependencies: { openai: "^4.0.0" } }),
    "src/index.js": 'import OpenAI from "openai";\nnew OpenAI();\n',
    "acb.config.json": JSON.stringify({ excludeDeps: ["openai"] }),
  });
  assert.deepEqual(scanRepo(loadConfig(excluded)).manifest.integrations, []);
});

test("import styles all produce bindings", () => {
  const cases: [string, Language, string, string[]][] = [
    ['import OpenAI from "openai";', "js", "openai", ["OpenAI"]],
    ['import * as stripe from "stripe";', "js", "stripe", ["stripe"]],
    ['import { Stripe } from "stripe";', "js", "stripe", ["Stripe"]],
    ['import { Stripe as S } from "stripe";', "js", "stripe", ["S"]],
    ['const OpenAI = require("openai");', "js", "openai", ["OpenAI"]],
    ['const { Stripe } = require("stripe");', "js", "stripe", ["Stripe"]],
    ['import OpenAI, { toFile } from "openai";', "js", "openai", ["OpenAI", "toFile"]],
    ['import { get } from "openai/helpers";', "js", "openai", ["get"]],
    ['import "@sentry/node";', "js", "@sentry/node", ["@sentry/node"]],
    ["import stripe", "python", "stripe", ["stripe"]],
    ["import stripe as billing", "python", "stripe", ["billing"]],
    ["from stripe import Charge", "python", "stripe", ["Charge"]],
    ["from stripe.error import CardError", "python", "stripe", ["CardError"]],
    ["import google_cloud_storage", "python", "google-cloud-storage", ["google_cloud_storage"]],
  ];

  for (const [source, language, pkg, expected] of cases) {
    assert.deepEqual(
      importedBindings(source, language, pkg).sort(),
      expected.sort(),
      `bindings for: ${source}`,
    );
  }
});

test("import lines themselves are not usage sites", () => {
  const source = 'import OpenAI from "openai";\nconst c = new OpenAI();\n';
  const sites = extractSdkCallSites(source, ["OpenAI"], "a.js");
  assert.equal(sites.length, 1);
  assert.equal(sites[0].line, 2);
});

test("requirement lines parse into dependencies", () => {
  assert.deepEqual(parseRequirement("stripe==7.1.0"), {
    id: "pypi:stripe",
    ecosystem: "pypi",
    name: "stripe",
    version: "==7.1.0",
  });
  assert.equal(parseRequirement("  # a comment"), undefined);
  assert.equal(parseRequirement("-r other.txt"), undefined);
  assert.equal(parseRequirement("requests[security]>=2.0")?.version, ">=2.0");
  assert.equal(parseRequirement("httpx")?.version, "*");
});

test("declared dependencies come back sorted", () => {
  const root = tempRepo({
    "package.json": JSON.stringify({ dependencies: { stripe: "^1", openai: "^2" } }),
    "requirements.txt": "boto3\n",
  });
  assert.deepEqual(
    readDeclaredDependencies(root).map((d) => d.id),
    ["npm:openai", "npm:stripe", "pypi:boto3"],
  );
});

type Language = "js" | "python";
