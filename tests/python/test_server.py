"""Integration tests that drive the real daemon handler over HTTP.

The ``server`` fixture starts the actual ``ThreadingHTTPServer`` on an ephemeral
port, so these exercise routing, session creation, the feedback long-poll, and
artifact cleanup end to end.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from conftest import Client


def _open_session(server: Client, artifact: Path) -> str:
    status, body = server.post("/api/sessions", {"file": str(artifact)})
    assert status == 200, body
    return body["key"]


def test_health_reports_version(server: Client) -> None:
    status, body = server.get("/health")
    assert status == 200
    assert body["ok"] is True
    assert len(body["version"]) == 12


def test_create_session_serves_injected_page(server: Client, make_artifact: Callable[..., Path]) -> None:
    artifact = make_artifact(body="<p>unique-marker</p>")
    key = _open_session(server, artifact)

    status, page = server.get(f"/s/{key}")
    assert status == 200
    assert "unique-marker" in page
    assert 'type="module" src="/htmlit-client/client.js"' in page
    assert f'"key": "{key}"' in page or f'"key":"{key}"' in page


def test_artifact_route_is_not_injected(server: Client, make_artifact: Callable[..., Path]) -> None:
    key = _open_session(server, make_artifact(body="<p>raw</p>"))
    status, page = server.get(f"/artifact/{key}")
    assert status == 200
    assert "raw" in page
    assert "htmlit-client" not in page


def test_prompts_then_poll_returns_feedback(server: Client, make_artifact: Callable[..., Path]) -> None:
    key = _open_session(server, make_artifact())
    prompt = {"selector": "#intro", "tag": "text", "text": "the title", "prompt": "make it punchier"}

    status, ack = server.post(f"/api/{key}/prompts", {"prompts": [prompt], "domSnapshot": "<html></html>"})
    assert status == 200
    assert ack["count"] == 1

    status, feedback = server.get(f"/api/poll?key={key}&timeout=5")
    assert status == 200
    assert feedback["type"] == "feedback"
    assert feedback["prompts"][0]["prompt"] == "make it punchier"
    assert any(m["role"] == "user" and m["text"] == "make it punchier" for m in feedback["chat"])


def test_poll_times_out_without_feedback(server: Client, make_artifact: Callable[..., Path]) -> None:
    key = _open_session(server, make_artifact())
    status, body = server.get(f"/api/poll?key={key}&timeout=1", timeout=5)
    assert status == 200
    assert body["type"] == "timeout"


def test_agent_reply_appends_to_chat(server: Client, make_artifact: Callable[..., Path]) -> None:
    key = _open_session(server, make_artifact())
    status, _ = server.post("/api/agent-reply", {"key": key, "text": "done, fixed the title"})
    assert status == 200

    _, page = server.get(f"/s/{key}")
    marker = "window.__HTMLIT__="
    config = json.loads(page[page.index(marker) + len(marker) : page.index(";</script>")])
    assert config["chat"][-1] == {"role": "agent", "text": "done, fixed the title"}


def test_persist_toggle_writes_sidecar(server: Client, make_artifact: Callable[..., Path]) -> None:
    artifact = make_artifact(generated=True)  # generated -> cleanup on by default
    key = _open_session(server, artifact)
    sidecar = Path(str(artifact) + ".htmlit.json")

    status, body = server.post(f"/api/{key}/persist", {"persist": True})
    assert status == 200 and body["persist"] is True
    assert sidecar.is_file()


def test_end_deletes_generated_artifact(server: Client, make_artifact: Callable[..., Path]) -> None:
    artifact = make_artifact(generated=True)
    key = _open_session(server, artifact)

    status, body = server.post(f"/api/{key}/end", {})
    assert status == 200
    assert body["removed"] is True
    assert not artifact.exists()


def test_end_keeps_persisted_artifact(server: Client, make_artifact: Callable[..., Path]) -> None:
    artifact = make_artifact(generated=True)
    key = _open_session(server, artifact)
    server.post(f"/api/{key}/persist", {"persist": True})

    status, body = server.post(f"/api/{key}/end", {})
    assert status == 200
    assert body["removed"] is False
    assert artifact.exists()


def test_vendor_route_rejects_path_traversal(server: Client) -> None:
    status, _ = server.get("/vendor/../htmlit_server.py")
    assert status in (403, 404)


def test_unknown_session_returns_404(server: Client) -> None:
    status, _ = server.get("/s/deadbeefcafe")
    assert status == 404
