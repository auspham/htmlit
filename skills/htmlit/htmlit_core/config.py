"""Filesystem locations, tunables, and the identity helpers shared by the daemon
and the CLI. Keeping these in one place lets both sides derive the same session
keys and source version so a code change reliably restarts a stale daemon.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
SKILL_DIR = PACKAGE_DIR.parent
CLIENT_DIR = SKILL_DIR / "client"
VENDOR_DIR = SKILL_DIR / "vendor"

STATE_DIR = Path(os.environ.get("HTMLIT_HOME", Path.home() / ".htmlit"))
REGISTRY = STATE_DIR / "server.json"
DAEMON_LOG = STATE_DIR / "daemon.log"

SERVER_ENTRY = SKILL_DIR / "htmlit_server.py"
VENDOR_SCRIPT = SKILL_DIR / "vendor.py"

# Local vendored asset -> the CDN url the browser falls back to when it is absent.
VENDOR_CDN = {
    "idiomorph.min.js": "https://cdn.jsdelivr.net/npm/idiomorph@0.7.4/dist/idiomorph.min.js",
    "mermaid.min.js": "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
    "highlight.min.js": "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/highlight.min.js",
    "hljs-light.css": "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/github.min.css",
    "hljs-dark.css": "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/styles/github-dark.min.css",
}

WATCH_INTERVAL = 0.3
HEARTBEAT = 10.0
# Seconds with no connected browser and no agent activity before the daemon
# self-stops, so it never lingers after the page or the Copilot session closes.
IDLE_GRACE = float(os.environ.get("HTMLIT_IDLE_SECS", "60"))
# An agent counts as attached while it is long-polling or polled this recently
# (one long-poll is about 25 seconds; this covers the gap before it re-polls).
AGENT_TTL = float(os.environ.get("HTMLIT_AGENT_TTL", "35"))

# On first serve the daemon downloads any missing vendored assets in the
# background so later page loads are served locally. Set HTMLIT_AUTO_VENDOR=0 to
# keep loading from the CDN instead.
AUTO_VENDOR = os.environ.get("HTMLIT_AUTO_VENDOR", "1").strip().lower() not in ("0", "false", "no", "off", "")

# The files whose content defines the runtime behavior the browser sees. Both the
# daemon and the CLI hash these; when the CLI finds a running daemon on a stale
# hash it restarts it, so edits to the skill always take effect.
SOURCE_FILES = (
    *sorted(CLIENT_DIR.glob("*.js")),
    *sorted(CLIENT_DIR.glob("*.css")),
    *sorted(PACKAGE_DIR.glob("*.py")),
)


def session_key(path: str) -> str:
    """A short, stable id for an artifact, derived from its absolute path."""
    return hashlib.sha1(os.path.abspath(path).encode()).hexdigest()[:12]


def source_version() -> str:
    """A hash of every runtime source file, used to detect a stale daemon."""
    digest = hashlib.sha1()
    for path in SOURCE_FILES:
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"?")
    return digest.hexdigest()[:12]


def asset_url(name: str) -> str:
    """Prefer the locally vendored copy of an asset; fall back to the CDN."""
    if (VENDOR_DIR / name).is_file():
        return "/vendor/" + name
    return VENDOR_CDN.get(name, "/vendor/" + name)
