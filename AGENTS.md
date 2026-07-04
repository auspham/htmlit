# AGENTS.md

Guidance for coding agents working in this repository. Humans should read [CONTRIBUTING.md](./CONTRIBUTING.md); this file is the terse version for agents.

## What this repository is

A single agent skill, `htmlit`, that serves an HTML artifact as a live review surface. The skill is pure Python standard library (a daemon plus a CLI) with a browser client that has no build step.

## Layout

- `skills/htmlit/` is the installable unit. Everything an end user gets lives here.
  - `htmlit_server.py` and `htmlit_cli.py` are thin entry points; the logic lives in the `htmlit_core` package.
  - `htmlit_core/` is split by concern: `enums`, `models`, `config`, `sidecar`, `session`, `page`, `server`, `cli`.
  - `client/` holds the injected browser client as native ES modules (entry `client.js`) plus `client.css`, served verbatim.
  - `vendor.py` downloads the vendored front-end assets (not committed).
  - `SKILL.md` is the agent-facing instruction file.
- `tests/python/` is the pytest suite. `tests/client/` is the browser suite.

## Ground rules

- Do not add runtime dependencies to the skill. Standard library only for the `htmlit_core` package.
- Keep the client as dependency-free native ES modules. They are served as-is, so no bundler.
- Do not commit vendored assets (Mermaid, highlight.js, Idiomorph). The client falls back to their CDNs.
- No em-dashes. Comment only where intent is non-obvious. Use type hints in Python.

## Verifying a change

```bash
python -m pytest tests/python        # daemon and CLI
ruff check skills/htmlit tests/python # lint
npm ci && npm test                    # browser client (needs Node and a browser)
```

Add a test for any behavior change. For a bug fix, the test should fail before the fix and pass after it. The `tests/client` suite already demonstrates this pattern for the Mermaid subgraph rearrange bug.

## Fragile areas

The Mermaid rearrange geometry in `client/diagram.js` reasons about node and edge positions across nested subgraph coordinate frames. Endpoints of arrows between subgraphs bind to cluster borders, not inner nodes. If you change how nodes, edges, or clusters are measured, run the browser tests and add a fixture under `tests/client/fixtures` for the case you are fixing.
