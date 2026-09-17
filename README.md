# acb — self-maintaining API dependencies

Dependabot tells you a package has a new version. It cannot tell you that the
REST endpoint you call with `fetch` is being retired in November, that the query
parameter was renamed, or that the field you read is gone — because there is no
version number involved at all.

**acb watches the APIs your code actually calls, works out whether an upstream
change affects *this* repository, and prepares the migration as a pull request
for you to review.**

```
discover integrations → detect upstream change → determine repository impact
    → generate migration → validate it → patch / pull request (never merged)
```

Raw HTTP integrations come first, because that is the gap: `fetch`, `axios`,
`requests`, `httpx`. SDK dependencies are covered too, as a secondary case.

Status: **working prototype.** Open source, CLI-first, bring your own model,
zero runtime dependencies, no build step.

---

## See it work (offline, no API key)

```sh
git clone <this repo> && cd ai-api-change-bot
npm install       # dev dependencies only: @types/node and typescript
npm run demo
```

The demo runs the whole loop on two example repositories, in copies under
`.demo/`, using recorded model responses:

| Fixture | Integration | Upstream source | How the change is caught |
| --- | --- | --- | --- |
| `examples/weather-dashboard` | OpenWeather One Call 2.5, Node + `fetch` | a prose changelog | the model reads the retirement notice and judges it |
| `examples/shipping-service` | a REST shipping API, Python + `requests` | an OpenAPI diff | matched deterministically, no model needed |

Both end in `validated`, having produced a patch. Each fixture's changelog also
contains unrelated changes, which are filtered out before a model is ever
called — that filtering is most of what makes this affordable.

Then look at what it produced:

```sh
cat .demo/weather-dashboard/.acb/reports/*.md        # the impact report
cat .demo/shipping-service/.acb/patches/*.patch      # the migration
cat .demo/*/.acb/reports/*.transcript.jsonl          # every tool call the agent made
```

---

## Deterministic or model-powered — which is which

The split is the design, not an implementation detail, so the CLI labels every
stage as it runs (`[deterministic]` / `[LLM anthropic/claude-opus-5]`).

| Stage | Kind | What it does | What is sent to the model |
| --- | --- | --- | --- |
| `scan` | deterministic | Finds HTTP call sites (host, method, path template, query params) and SDK usage; writes an incremental manifest | nothing |
| `check` | deterministic | Diffs the provider's OpenAPI spec against a snapshot, and splits changelog pages into entries | nothing |
| `impact` (1) | deterministic | Matches change identifiers against real call sites. **No match, no further work** | nothing |
| `impact` (2) | **LLM** | Judges whether a matched change really affects you, how risky it is, and drafts the migration | the change text plus the matched snippets (±15 lines), never whole files |
| `migrate` | **LLM agent** | Edits an isolated copy of the repository | files the agent reads, all logged |
| `validate` | deterministic | Repo tests + "the old usage is gone" + "the calls match the provider's spec" | nothing |
| `pr` | deterministic | Writes a patch, optionally opens a pull request | nothing |

`acb run --no-llm` stops after the deterministic half and still produces a
useful report. `--dry-run-llm` writes every prompt to `.acb/egress/` and sends
nothing, so you can read exactly what would leave first.

---

## Use it on your own repository

```sh
node bin/acb scan          # what external APIs does this repo use?
node bin/acb config        # the effective configuration
```

`scan` needs no configuration. To watch an API you need to tell acb where the
provider publishes changes (there is no registry for HTTP APIs the way there is
for packages), in `acb.config.json`:

```jsonc
{
  "sources": {
    // Best case: the provider publishes an OpenAPI description.
    "http:api.stripe.com": [
      { "type": "openapi", "url": "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json" }
    ],
    // Otherwise a changelog page works; the model reads it.
    "http:api.openweathermap.org": [
      { "type": "changelog", "url": "https://openweathermap.org/changelog", "format": "html" }
    ]
  },
  "validate": { "commands": ["npm test", "npx tsc --noEmit"] },
  "model": { "provider": "anthropic", "model": "claude-opus-5" }
}
```

Then:

```sh
node bin/acb run            # scan → check → impact → migrate → validate
node bin/acb run --pr       # …and open a pull request
```

The first run on a new source records a baseline and reports nothing: there is
nothing to compare against yet. Everything after that is a diff.

Exit codes: `0` nothing to do · `1` error · `2` a human needs to look at this
(which includes a migration that validated — acb never merges).

### Commands

| Command | |
| --- | --- |
| `acb scan` | discover integrations, write `.acb/manifest.json` (`--full` to ignore the cache) |
| `acb check` | fetch upstream sources, report new changes (`--offline`, `--baseline`, `--since <date>`) |
| `acb impact` | decide what affects this repo (`--no-llm`, `--dry-run-llm`) |
| `acb migrate` | prepare and validate a migration (`--item`, `--keep-workspace`) |
| `acb contract` | check your calls against the provider's spec — useful in CI on its own |
| `acb run` | the whole loop (`--pr`, `--no-llm`, `--no-migrate`, `--offline`, `--json`) |
| `acb config` | print the effective configuration |

### Configuration reference

Every key is optional; the defaults are what the demo uses.

| Key | Default | |
| --- | --- | --- |
| `sources` | `{}` | upstream sources per integration id (`http:<host>`, `npm:<pkg>`, `pypi:<pkg>`) |
| `model` | `{ "provider": "none" }` | see below |
| `validate.commands` | `[]` | the checks a migration must pass. Empty means acb says so, loudly |
| `validate.timeoutMs` | `120000` | per command |
| `impact.minScore` | `0.4` | how strong the deterministic match must be to reach the model |
| `migrate.agent` | `{ "type": "builtin" }` | or `{ "type": "command", "command": …, "promptVia": "stdin" \| "file" \| "arg" }` |
| `migrate.maxSteps` | `30` | tool calls per attempt |
| `migrate.maxAttempts` | `3` | validation failures fed back before giving up |
| `privacy.mode` | `"snippets"` | or `"local-only"`, which refuses a remote provider |
| `privacy.excludePaths` | `[".env", ".env.*", "*.pem", "*.key"]` | never read, never sent |
| `ignore` | `node_modules`, `.git`, `dist`, `.venv`, … | extends the defaults, never replaces them |
| `ignoreHosts` | `localhost`, `127.0.0.1`, `example.com`, … | hosts that are not third-party APIs |
| `includeDeps` / `excludeDeps` | `[]` | override the "is this dependency an integration" heuristic |

### Bring your own model

| `model.provider` | Notes |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY`. Defaults to `claude-opus-5` |
| `openai` | `OPENAI_API_KEY`. Set `baseUrl` for Azure, OpenRouter, vLLM, or Ollama (`http://localhost:11434/v1`) |
| `replay` | recorded responses — the demo and the test suite |
| `none` | deterministic only; no model is ever contacted |

Or keep the coding agent you already use and let acb do the rest:

```jsonc
{
  "migrate": {
    "agent": {
      "type": "command",
      "command": "claude -p --permission-mode acceptEdits",
      "promptVia": "stdin"
    }
  }
}
```

acb prepares the isolated workspace, writes the brief to `ACB_TASK.md`, runs
your agent there, and validates the result itself. Presets exist for Claude
Code, Codex CLI (`codex exec --full-auto`) and Aider
(`aider --yes --message-file ACB_TASK.md`).

---

## Privacy and safety

* **Bring your own key.** acb talks to the provider you configure, and to no
  one else. There is no acb service.
* **Nothing is sent until something matches.** The deterministic prefilter runs
  first; an upstream change that names nothing you use costs nothing and sends
  nothing.
* **Snippets, not repositories.** The impact stage sends matched call sites with
  a little context. The migration agent reads files on demand, and each read is
  logged in the transcript.
* **Secrets are redacted** before any request leaves (`sk-…`, `Bearer …`,
  `AWS…`, `NAME=value` for key/token/secret/password/appid). The name survives,
  the value does not.
* **`--dry-run-llm`** writes the prompts to `.acb/egress/` and sends nothing.
* **`privacy.mode: "local-only"`** refuses a remote provider outright, so a
  local model is enforceable rather than aspirational.
* **`privacy.excludePaths`** (plus `.env*` always) are invisible to the agent.
* **Your working tree is never touched.** Migrations happen in a copy under
  `.acb/work/`, and the output is a patch.
* **acb cannot merge.** There is no merge call, no auto-merge, and no push to
  the default branch anywhere in the code — and a test greps for that.

---

## GitHub Action

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - uses: Ven109/ai-api-change-bot@main
    with:
      provider: anthropic
      api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Full example with a weekly schedule: [`examples/github-workflow.yml`](examples/github-workflow.yml).

---

## What lives where

```
bin/acb              entry point (Node runs the TypeScript directly)
src/cli.ts           argument parsing and command dispatch
src/run.ts           `acb run`: the whole loop and its summary table
src/config.ts        acb.config.json: defaults, validation, env overrides
src/state.ts         the .acb/ layout
src/types.ts         the JSON contracts between stages

src/scan/            [deterministic] discovery
  http.ts            HTTP call sites: base-URL constants, template strings,
                     f-strings, wrappers, query parameters
  sdk.ts             declared dependencies and their real usage
  walk.ts            file walking, ignore rules, API-spec sniffing
  index.ts           manifest assembly and incremental rescans

src/check/           [deterministic] upstream change detection
  openapi.ts         spec snapshot diffing (the precise signal)
  changelog.ts       prose sources: splitting, dates, tags, identifiers
  sources.ts         fetching a source from a URL or a file

src/impact/          the boundary
  prefilter.ts       [deterministic] change identifiers vs. real call sites
  assess.ts          [LLM] relevance, risk, migration plan
  report.ts          Markdown and JSON reports

src/migrate/         [LLM agent] the edit
  workspace.ts       the isolated copy and the patch
  tools.ts           the agent's tools, and the path confinement
  agent.ts           the tool-use loop
  brief.ts           the migration brief (also read by external agents)
  external.ts        handing the edit to your own coding agent
  index.ts           per-integration orchestration and the retry loop

src/validate/        [deterministic] proof
  contract.ts        call sites vs. the provider's current spec
  index.ts           repo checks, residual usage, contract check

src/deliver/pr.ts    patch, branch, pull request (never a merge)
```

Tests live in `test/` and run on `node --test`, with no framework. `npm run
check` typechecks and runs them; everything is offline.

---

## Limitations, honestly

* **The scanner is lexical**, not a parser. It handles base-URL constants,
  template strings, f-strings, `const url = …; fetch(url)` and injected
  clients, but it will miss URLs assembled across several files or behind
  layers of indirection. Tree-sitter is the planned replacement.
* **HTTP sources must be configured.** There is no registry that maps a host to
  its changelog, so `sources` is manual for HTTP integrations. Package
  registries are resolved automatically for SDKs.
* **OpenAPI specs must be JSON.** YAML is reported as unsupported rather than
  half-parsed.
* **Only JS/TS and Python** are scanned today.
* **The agent is deliberately basic.** If you want a better one, plug it in.
* **The demo's migration tool calls are scripted**, so it can run offline and in
  CI. The impact assessments in the recordings are genuine model output for the
  prompts acb generated. Both are labelled in the files and in the output.

## Where this is going

The prototype's question was whether one generic loop can handle *arbitrary*
APIs without hand-written support per provider. On these fixtures it does, and
the deterministic/LLM split is what makes it affordable and auditable. What is
worth building next, in order: an evaluation harness over real historical
migrations (the honest test of generality), a tree-sitter scanner if recall is
the limit, and automatic source discovery for HTTP hosts — which is also the
part a hosted service could do better than any single repository can.

## License

MIT.
