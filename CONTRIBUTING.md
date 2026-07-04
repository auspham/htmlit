# Contributing to htmlit

Thanks for your interest in improving htmlit. This guide covers the toolchain, the test suites, and the conventions the project follows.

## Philosophy

htmlit is deliberately small and self-contained. Two principles guide most decisions:

1. **The skill has no runtime dependencies.** The daemon and CLI use only the Python standard library. A change that would require an end user to install a package is almost certainly the wrong direction. Development tools (pytest, ruff, Puppeteer) are fine because they never ship to users.
2. **A review must never crash.** The daemon serves a live collaboration surface. Best-effort filesystem and network calls are wrapped so a failure degrades gracefully rather than tearing down someone's session.

## Getting set up

The skill itself needs only Python 3.8 or newer. To run the full test suite you also need Node.js 20 or newer and a browser that Puppeteer can drive.

```bash
# Python tools, in a virtual environment
python -m venv .venv
source .venv/bin/activate
pip install pytest ruff

# Node tooling for the browser tests (Puppeteer downloads a browser here)
npm ci
```

## Running the tests

The project has two independent suites.

### Python (daemon and CLI)

```bash
python -m pytest tests/python
ruff check skills/htmlit tests/python
```

These cover the pure helpers, the HTTP routes (against a real server started on an ephemeral port), and the CLI argument parsing and review discovery. They are fast and need no browser.

### Browser client (Mermaid rearrange)

```bash
# Optional: serve Mermaid and highlight.js locally instead of from the CDN
python3 skills/htmlit/vendor.py

npm test
```

The browser tests boot the real daemon, open a review for a fixture artifact, and drive the injected client in a headless browser. They focus on the Mermaid rearrange feature, in particular that dragging a node inside a subgraph never disturbs the arrows drawn between subgraphs.

If no browser or Python is available, the browser suite skips itself rather than failing, so you can still run the Python suite on a minimal machine. Continuous integration always provides both, so the suite runs for real there.

## Code style

- **No em-dashes.** Use a regular hyphen where a dash is needed.
- **Comment sparingly.** Prefer clear names and small functions. Add a comment only where the intent is genuinely non-obvious. Never add decorative separator or banner comments.
- **Type things.** Python code uses type hints. New browser client code should keep its function contracts clear.
- **Match the surrounding style.** The client (`client/*.js`) is a set of small, dependency-free native ES modules the browser loads directly, with no build step. Keep it that way unless there is a strong reason to introduce tooling.
- **Soft-wrap Markdown.** Write full sentences and paragraphs on one line and let the editor wrap them. Do not insert hard line breaks mid-sentence.

Ruff enforces formatting and lint rules for Python. Run `ruff check` before opening a pull request.

## Commit and pull request conventions

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `fix(client): keep subgraph arrows attached when dragging`.
- Sign off your commits with `git commit -s` (the Developer Certificate of Origin).
- Add or update tests for any behavior change. A bug fix should come with a test that fails before the fix and passes after it.
- Make sure both CI jobs pass. Keep changes focused; unrelated refactors belong in their own pull request.

## Working on the client

The injected browser client lives in `skills/htmlit/client/` as a set of native ES modules (the entry is `client.js`). The daemon serves that directory under `/htmlit-client/` with a `no-store` cache header, so a reload always picks up your edits. The most fragile area is the Mermaid rearrange geometry in `diagram.js`, which computes node and edge positions across nested subgraph coordinate frames. If you touch it, run the browser tests and consider adding a fixture that reproduces the case you care about under `tests/client/fixtures`.

## Vendored assets

Mermaid, highlight.js, and Idiomorph are downloaded on demand by `htmlit vendor` and are not committed to the repository. The client falls back to their CDNs when a local copy is missing, so both a fresh clone and an offline machine work. Do not commit the vendored blobs.

## Regenerating the demo GIF

The README animation lives at `docs/demo.gif`. It is a three-act story: an agent replies in a mock terminal (`docs/demo-terminal.html`) with a wall of plain text, you run `/htmlit` to open the same reply as a review surface (`docs/demo-source.html`), and after you comment and pick an option the agent gets to work back in the terminal. It boots the real daemon and drives the injected client in a headless browser, so the review interactions are genuine.

```bash
npm ci                           # Puppeteer
python3 skills/htmlit/vendor.py  # so Mermaid renders locally
node scripts/record-demo.mjs     # writes docs/demo.gif (needs ffmpeg on PATH)
```

The recorder captures at 2x device pixels and downscales, so text in the GIF stays crisp. It encodes with ffmpeg; if `gifsicle` is also on your PATH it runs a lossy optimization pass to shrink the file, otherwise you get a larger but valid GIF. Edit the tour in `scripts/record-demo.mjs`, the terminal copy in the same file, or the rendered artifact in `docs/demo-source.html` to change what is shown.
