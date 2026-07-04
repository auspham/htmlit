"""Unit tests for the pure helpers: key derivation, the persisted-session
sidecar, client injection, and asset URL resolution. None need a running daemon.
"""

from __future__ import annotations

import json
from pathlib import Path

from htmlit_core import cli, config, page, sidecar


def test_session_key_is_stable_and_short() -> None:
    key = config.session_key("/tmp/example.html")
    assert key == config.session_key("/tmp/example.html")
    assert len(key) == 12
    assert all(c in "0123456789abcdef" for c in key)


def test_session_key_uses_absolute_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "a.html").write_text("x")
    assert config.session_key("a.html") == config.session_key(str(tmp_path / "a.html"))


def test_cli_and_daemon_share_key_and_version_helpers() -> None:
    # Both sides import the same helpers, so a daemon and CLI can never disagree on
    # a session key or the source version that decides a restart.
    assert cli.session_key is config.session_key
    assert cli.source_version is config.source_version


def test_artifact_is_generated_only_for_dot_htmlit_paths() -> None:
    assert sidecar.artifact_is_generated("/home/u/.htmlit/plan.html") is True
    assert sidecar.artifact_is_generated("/home/u/project/index.html") is False


def test_sidecar_roundtrip(tmp_path: Path) -> None:
    artifact = tmp_path / "review.html"
    artifact.write_text("<html></html>")
    chat = [{"role": "user", "text": "hi"}, {"role": "agent", "text": "hello"}]

    sidecar.save_sidecar(str(artifact), chat, name="Review", context="next: ship", highlights=[])
    loaded = sidecar.load_sidecar(str(artifact))
    assert loaded is not None
    assert loaded["chat"] == chat
    assert loaded["name"] == "Review"
    assert loaded["context"] == "next: ship"
    assert loaded["persist"] is True

    sidecar.remove_sidecar(str(artifact))
    assert sidecar.load_sidecar(str(artifact)) is None


def test_load_sidecar_missing_returns_none(tmp_path: Path) -> None:
    assert sidecar.load_sidecar(str(tmp_path / "nope.html")) is None


def test_inject_client_places_snippet_before_body() -> None:
    html = "<html><body><p>hi</p></body></html>"
    out = page.inject_client(html, _config())
    assert out.index("htmlit-client") < out.index("</body>")
    assert 'type="module" src="/htmlit-client/client.js"' in out
    assert "<p>hi</p>" in out


def test_inject_client_falls_back_to_html_then_append() -> None:
    before_html = page.inject_client("<html><p>x</p></html>", _config())
    assert before_html.index("htmlit-client") < before_html.index("</html>")

    appended = page.inject_client("<p>no wrappers</p>", _config())
    assert "htmlit-client" in appended
    assert appended.startswith("<p>no wrappers</p>")


def test_inject_client_embeds_config_json() -> None:
    out = page.inject_client("<body></body>", _config(key="abc123"))
    marker = "window.__HTMLIT__="
    embedded = out[out.index(marker) + len(marker) : out.index(";</script>")]
    assert json.loads(embedded)["key"] == "abc123"


def test_asset_url_prefers_local_then_cdn(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(config, "VENDOR_DIR", tmp_path)
    assert config.asset_url("mermaid.min.js").startswith("https://")
    (tmp_path / "mermaid.min.js").write_text("/* vendored */")
    assert config.asset_url("mermaid.min.js") == "/vendor/mermaid.min.js"


def test_source_version_is_twelve_hex_digits() -> None:
    version = config.source_version()
    assert len(version) == 12
    assert all(c in "0123456789abcdef" for c in version)


def _config(key: str = "deadbeef0000") -> dict:
    return {
        "key": key,
        "file": "/tmp/x.html",
        "vendor": {"idiomorph": "/vendor/idiomorph.min.js"},
    }
