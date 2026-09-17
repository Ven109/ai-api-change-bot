# acb — self-maintaining API dependencies

Open-source tool that keeps a codebase in sync with the third-party APIs and
SDKs it depends on. Think Dependabot, but for API *semantics* rather than
package version numbers, and **raw HTTP calls first** — those are exactly the
integrations no version bump can tell you about.

The loop:

```
discover integrations -> detect upstream change -> determine repository impact
  -> generate migration -> validate it -> patch / pull request (never merged)
```

Status: prototype under construction, issue by issue. The full README lands
with AIA-15; for now:

```sh
node bin/acb --help
node bin/acb config
npm test
```

Requires Node >= 22.18 (the TypeScript sources run directly, no build step) and
has zero runtime dependencies.
