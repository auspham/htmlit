"""Shared fixtures for the htmlit Python tests.

The skill modules read ``HTMLIT_HOME`` at import time to locate their state
directory, and they expect ``client/`` and ``vendor/`` to sit next to the source
files. We point ``HTMLIT_HOME`` at a throwaway directory and add the skill folder
to ``sys.path`` here, before any test module imports ``htmlit_server`` or
``htmlit_cli``, so every test runs against isolated state.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterator

import pytest

SKILL_DIR = Path(__file__).resolve().parents[2] / "skills" / "htmlit"

# Set these at collection time, not inside a fixture: the skill computes
# STATE_DIR from HTMLIT_HOME when it is first imported, which happens while
# pytest imports the test modules (after this conftest, but before any fixture
# runs).
os.environ.setdefault("HTMLIT_HOME", tempfile.mkdtemp(prefix="htmlit-home-"))
if str(SKILL_DIR) not in sys.path:
    sys.path.insert(0, str(SKILL_DIR))

from htmlit_core import server as htmlit_server  # noqa: E402  (import after sys.path setup)


@pytest.fixture
def clean_hub() -> Iterator[None]:
    """Give each test an empty session hub so sessions never leak between tests."""
    htmlit_server.HUB.sessions.clear()
    yield
    htmlit_server.HUB.sessions.clear()


class Client:
    """A minimal JSON HTTP client for talking to the test server."""

    def __init__(self, base: str) -> None:
        self.base = base

    def request(
        self, method: str, path: str, body: dict | None = None, timeout: float = 10.0
    ) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"content-type": "application/json"} if data else {}
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, _maybe_json(raw)
        except urllib.error.HTTPError as exc:  # noqa: PERF203 - surface the status
            return exc.code, _maybe_json(exc.read())

    def get(self, path: str, **kw: Any) -> tuple[int, Any]:
        return self.request("GET", path, **kw)

    def post(self, path: str, body: dict | None = None, **kw: Any) -> tuple[int, Any]:
        return self.request("POST", path, body=body if body is not None else {}, **kw)


def _maybe_json(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return raw.decode("utf-8", "replace")


@pytest.fixture
def server(clean_hub: None) -> Iterator[Client]:
    """Start the real daemon handler on an ephemeral port in a background thread."""
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), htmlit_server.Handler)
    httpd._htmlit_running = True  # type: ignore[attr-defined]
    thread = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield Client(f"http://127.0.0.1:{httpd.server_address[1]}")
    finally:
        httpd._htmlit_running = False  # type: ignore[attr-defined]
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


@pytest.fixture
def make_artifact(tmp_path: Path) -> Callable[..., Path]:
    """Return a factory that writes a small HTML artifact and returns its path.

    Pass ``generated=True`` to place it under a ``.htmlit/`` directory, which is
    how the skill marks artifacts it created (and may auto-delete on end).
    """

    def _make(name: str = "artifact.html", body: str = "<h1>hello</h1>", generated: bool = False) -> Path:
        parent = tmp_path / ".htmlit" if generated else tmp_path
        parent.mkdir(parents=True, exist_ok=True)
        path = parent / name
        path.write_text(f"<!doctype html><html><body>{body}</body></html>", encoding="utf-8")
        return path

    return _make
