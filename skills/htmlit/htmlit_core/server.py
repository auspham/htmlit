"""The review daemon: an HTTP handler that serves the injected artifact, streams
changes over server-sent events, and exchanges feedback with the agent. One
daemon serves many sessions, keyed by the artifact's absolute path.
"""

from __future__ import annotations

import json
import os
import queue
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlparse

from . import config, vendoring
from .enums import ChatRole, FeedbackKind, HighlightKind, PollResult, Presence, ServerEvent
from .models import FeedbackItem, Highlight, LayoutWarning, Prompt, TextRange
from .page import build_page_config, inject_client
from .session import Hub, Session
from .sidecar import delete_artifact, remove_sidecar

VERSION = config.source_version()
HUB = Hub()

MAX_POLL_SECONDS = 60.0
MIN_POLL_SECONDS = 1.0
DEFAULT_POLL_SECONDS = 25.0


class Handler(BaseHTTPRequestHandler):
    server_version = "htmlit/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:
        pass  # keep the daemon quiet

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self._health()
        elif path == "/api/poll":
            self._long_poll(parse_qs(parsed.query))
        else:
            handler = self._prefixed_get_route(path)
            if handler is None:
                self._json(404, {"error": "not found"})

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_POST(self) -> None:
        HUB.touch()
        path = urlparse(self.path).path
        exact = self._exact_post_routes().get(path)
        if exact is not None:
            exact()
            return
        key, action = _split_api_path(path)
        keyed = self._keyed_post_routes().get(action) if key else None
        if keyed is not None:
            keyed(key)
            return
        self._json(404, {"error": "not found"})

    def _prefixed_get_route(self, path: str) -> Callable[[str], None] | None:
        routes: tuple[tuple[str, Callable[[str], None]], ...] = (
            ("/htmlit-client/", self._serve_client),
            ("/vendor/", self._serve_vendor),
            ("/s/", self._serve_injected_page),
            ("/artifact/", self._serve_raw_artifact),
            ("/events/", self._serve_events),
        )
        for prefix, handler in routes:
            if path.startswith(prefix):
                handler(path[len(prefix):])
                return handler
        return None

    def _exact_post_routes(self) -> dict[str, Callable[[], None]]:
        return {
            "/api/sessions": self._create_session,
            "/api/agent-reply": self._agent_reply,
            "/api/presence": self._set_presence,
            "/api/end": self._end_from_body,
            "/shutdown": self._shutdown,
        }

    def _keyed_post_routes(self) -> dict[str, Callable[[str], None]]:
        return {
            "prompts": self._queue_prompts,
            "layout-warnings": self._record_layout_warnings,
            "persist": self._set_persist,
            "highlights": self._replace_highlights,
            "context": self._save_context,
            "end": self._end_keyed,
        }

    def _send(self, code: int, body: bytes, ctype: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for header, value in (extra or {}).items():
            self.send_header(header, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            return {}

    def _serve_file(self, path: Path, ctype: str, cache: bool = False) -> None:
        if not path.is_file():
            self._json(404, {"error": "not found"})
            return
        extra = {"Cache-Control": "public, max-age=86400"} if cache else None
        self._send(200, path.read_bytes(), ctype, extra)

    def _require_session(self, key: str) -> Session | None:
        session = HUB.get(key)
        if session is None:
            self._json(404, {"error": "unknown session"})
        return session

    def _health(self) -> None:
        self._json(200, {
            "ok": True,
            "version": VERSION,
            "connected": HUB.connected_count(),
            "busy": HUB.has_live_review(),
            "sessions": [session.snapshot() for session in HUB.all()],
        })

    def _serve_vendor(self, rel: str) -> None:
        target = (config.VENDOR_DIR / rel).resolve()
        vendor_root = config.VENDOR_DIR.resolve()
        if vendor_root not in target.parents and target != vendor_root:
            self._json(403, {"error": "forbidden"})
            return
        ctype = "text/css" if rel.endswith(".css") else "application/javascript"
        self._serve_file(target, ctype, cache=True)

    def _serve_client(self, rel: str) -> None:
        target = (config.CLIENT_DIR / rel).resolve()
        client_root = config.CLIENT_DIR.resolve()
        if client_root not in target.parents and target != client_root:
            self._json(403, {"error": "forbidden"})
            return
        ctype = "text/css" if rel.endswith(".css") else "application/javascript"
        self._serve_file(target, ctype)

    def _serve_injected_page(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        html = self._read_artifact(session, decode=True)
        if html is None:
            return
        page = inject_client(html, build_page_config(session))
        self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")

    def _serve_raw_artifact(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        body = self._read_artifact(session, decode=False)
        if body is None:
            return
        self._send(200, body, "text/html; charset=utf-8")

    def _read_artifact(self, session: Session, decode: bool):
        try:
            path = Path(session.path)
            return path.read_text(encoding="utf-8", errors="replace") if decode else path.read_bytes()
        except OSError as exc:
            self._send(500, f"cannot read artifact: {exc}".encode(), "text/plain")
            return None

    def _serve_events(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        self._open_event_stream(session)

    def _open_event_stream(self, session: Session) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        stream = session.subscribe()
        HUB.touch()
        last_ping = time.time()
        try:
            self._sse_write(ServerEvent.READY.value, {"presence": session.presence.value, "ended": session.ended})
            self._sse_write(ServerEvent.CHAT_SYNC.value, {"chat": session.chat})
            while getattr(self.server, "_htmlit_running", True):
                if self._client_disconnected():
                    break
                try:
                    event, data = stream.get(timeout=1.0)
                    self._sse_write(event, json.loads(data))
                except queue.Empty:
                    if time.time() - last_ping >= config.HEARTBEAT:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            session.unsubscribe(stream)
            HUB.touch()

    def _client_disconnected(self) -> bool:
        # A closed tab makes the socket readable with EOF, so we notice promptly
        # instead of waiting for the next heartbeat write to fail.
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and not self.connection.recv(1, socket.MSG_PEEK)
        except OSError:
            return True

    def _sse_write(self, event: str, data: dict) -> None:
        frame = f"event: {event}\ndata: {json.dumps(data)}\n\n"
        self.wfile.write(frame.encode("utf-8"))
        self.wfile.flush()

    def _long_poll(self, query: dict[str, list[str]]) -> None:
        HUB.touch()
        key = _first(query, "key")
        path = _first(query, "file")
        timeout = _poll_timeout(_first(query, "timeout"))
        session = HUB.get(key) if key else (HUB.by_path(path) if path else None)
        if session is None:
            self._json(404, {"error": "unknown session"})
            return
        with session.lock:
            session.pollers += 1
            session.last_poll = time.time()
        if session.presence is Presence.WAITING and not session.ended:
            session.set_presence(Presence.LISTENING)  # an agent just attached
        try:
            drained = self._await_feedback(session, timeout)
            self._answer_poll(session, drained)
        finally:
            with session.lock:
                session.pollers -= 1
                session.last_poll = time.time()

    def _await_feedback(self, session: Session, timeout: float) -> list[FeedbackItem]:
        deadline = time.time() + timeout
        with session.cond:
            while not session.inbox and not session.ended and time.time() < deadline:
                session.cond.wait(timeout=deadline - time.time())
            drained = session.inbox[:]
            session.inbox.clear()
        return drained

    def _answer_poll(self, session: Session, drained: list[FeedbackItem]) -> None:
        if drained:
            prompts, warnings, snapshot = _aggregate_feedback(drained)
            session.set_presence(Presence.WORKING)
            self._json(200, {
                "type": PollResult.FEEDBACK.value,
                "key": session.key,
                "file": session.path,
                "prompts": prompts,
                "layout_warnings": warnings,
                "domSnapshot": snapshot,
                "chat": session.chat,
            })
        elif session.ended:
            self._json(200, {"type": PollResult.ENDED.value, "key": session.key, "chat": session.chat})
        else:
            # An empty long-poll means the agent is idle but present. Clear back to
            # listening so "working" can never stick once it comes back to poll.
            session.set_presence(Presence.LISTENING)
            self._json(200, {"type": PollResult.TIMEOUT.value, "key": session.key})

    def _create_session(self) -> None:
        data = self._read_json()
        path = data.get("file") or ""
        if not path or not os.path.isfile(path):
            self._json(400, {"error": "file not found", "file": path})
            return
        name = data.get("name") or os.path.basename(path)
        session = HUB.open(path, name, auto_delete=_requested_auto_delete(data))
        response = {
            "key": session.key,
            "url": f"/s/{session.key}",
            "file": session.path,
            "cleanup": session.auto_delete,
        }
        if session.just_resumed:
            response["resumed"] = True
            response["chat"] = session.chat
            response["context"] = session.context
            session.just_resumed = False  # surface the handoff once, to the opener
        self._json(200, response)

    def _queue_prompts(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        data = self._read_json()
        prompts: list[Prompt] = [p for p in data.get("prompts", []) if isinstance(p, dict)]
        for prompt in prompts:
            # Show only the user's words in the chat; the selector still travels to
            # the agent inside the prompt payload below.
            label = prompt.get("prompt") or prompt.get("text") or ""
            session.chat.append({"role": ChatRole.USER.value, "text": label})
        session.broadcast(ServerEvent.CHAT_SYNC, {"chat": session.chat})
        session.push_feedback({
            "type": FeedbackKind.PROMPTS.value,
            "prompts": prompts,
            "domSnapshot": data.get("domSnapshot", ""),
        })
        # Only show "working" if an agent is actually polling to pick this up.
        session.set_presence(Presence.WORKING if session.agent_attached() else Presence.WAITING)
        self._json(200, {"ok": True, "count": len(prompts), "agent_attached": session.agent_attached()})

    def _record_layout_warnings(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        raw = self._read_json().get("layout_warnings", [])
        warnings: list[LayoutWarning] = raw if isinstance(raw, list) else []
        if warnings:
            session.push_feedback({"type": FeedbackKind.LAYOUT_WARNINGS.value, "layout_warnings": warnings})
        self._json(200, {"ok": True})

    def _agent_reply(self) -> None:
        data = self._read_json()
        session = self._require_session(data.get("key", ""))
        if session is None:
            return
        session.last_poll = time.time()  # a reply proves an agent is alive
        text = (data.get("text") or "").strip()
        if text:
            # add_chat broadcasts the authoritative chat-sync, which fully re-renders
            # the conversation in every open browser. That is the single render path,
            # so there is no separate per-message event to avoid double-rendering.
            session.add_chat(ChatRole.AGENT, text)
        session.set_presence(data.get("presence") or Presence.LISTENING)
        self._json(200, {"ok": True})

    def _set_presence(self) -> None:
        data = self._read_json()
        session = self._require_session(data.get("key", ""))
        if session is None:
            return
        session.set_presence(data.get("state", Presence.WAITING.value))
        self._json(200, {"ok": True})

    def _replace_highlights(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        raw = self._read_json().get("highlights", [])
        items = raw if isinstance(raw, list) else []
        session.highlights = [h for h in (_clean_highlight(item) for item in items) if h is not None]
        session.save_state()  # persisted with the review (written only when kept)
        self._json(200, {"ok": True, "count": len(session.highlights)})

    def _set_persist(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        persist = bool(self._read_json().get("persist"))
        session.auto_delete = not persist
        if persist:
            session.save_state()  # write the sidecar now so it survives immediately
        else:
            remove_sidecar(session.path)
        session.broadcast(ServerEvent.PERSIST, {"persist": persist, "file": session.path})
        self._json(200, {"ok": True, "persist": persist, "file": session.path})

    def _save_context(self, key: str) -> None:
        session = self._require_session(key)
        if session is None:
            return
        session.context = str(self._read_json().get("context", "") or "")
        if not session.is_kept():
            session.auto_delete = False  # a handoff note means the review should resume
        session.save_state()
        session.broadcast(ServerEvent.PERSIST, {"persist": session.is_kept(), "file": session.path})
        self._json(200, {"ok": True, "context": session.context, "persist": session.is_kept()})

    def _end_from_body(self) -> None:
        body = self._read_json()
        self._end_session(body.get("key", ""), keep=bool(body.get("keep")))

    def _end_keyed(self, key: str) -> None:
        self._end_session(key, keep=bool(self._read_json().get("keep")))

    def _end_session(self, key: str, keep: bool) -> None:
        session = self._require_session(key)
        if session is None:
            return
        with session.cond:
            session.ended = True
            session.cond.notify_all()
        removed = delete_artifact(session.path) if (session.auto_delete and not keep) else False
        if not removed:
            session.save_state()  # keep the thread with the persisted artifact
        session.broadcast(ServerEvent.ENDED, {"removed": removed, "file": session.path, "persist": not removed})
        session.set_presence(Presence.WAITING)
        self._json(200, {"ok": True, "removed": removed, "file": session.path})

    def _shutdown(self) -> None:
        self._json(200, {"ok": True})
        threading.Thread(target=self.server.shutdown, daemon=True).start()


def _split_api_path(path: str) -> tuple[str | None, str | None]:
    """Pull the session key and action from ``/api/<key>/<action>``."""
    parts = path.split("/")
    if len(parts) == 4 and parts[1] == "api":
        return parts[2], parts[3]
    return None, None


def _first(query: dict[str, list[str]], name: str) -> str:
    values = query.get(name)
    return values[0] if values else ""


def _poll_timeout(raw: str) -> float:
    try:
        requested = float(raw) if raw else DEFAULT_POLL_SECONDS
    except ValueError:
        requested = DEFAULT_POLL_SECONDS
    return max(MIN_POLL_SECONDS, min(requested, MAX_POLL_SECONDS))


def _requested_auto_delete(data: dict) -> bool | None:
    if "keep" in data:
        return not bool(data["keep"])
    if "clean" in data:
        return bool(data["clean"])
    return None


def _aggregate_feedback(items: list[FeedbackItem]) -> tuple[list[Prompt], list[LayoutWarning], str]:
    prompts: list[Prompt] = []
    warnings: list[LayoutWarning] = []
    snapshot = ""
    for item in items:
        if item.get("type") == FeedbackKind.PROMPTS.value:
            prompts.extend(item.get("prompts", []))
            snapshot = item.get("domSnapshot") or snapshot
        elif item.get("type") == FeedbackKind.LAYOUT_WARNINGS.value:
            warnings.extend(item.get("layout_warnings", []))
    return prompts, warnings, snapshot


def _clean_highlight(raw: object) -> Highlight | None:
    """Keep only a well-formed mark: an id plus a resolvable text range or a stable
    diagram target. A mark is a note or a comment anchor carrying the user's ask."""
    if not isinstance(raw, dict):
        return None
    text_range = _clean_text_range(raw.get("range"))
    target = _clean_target(raw.get("target"))
    if text_range is None and target is None:
        return None
    return {
        "id": str(raw.get("id", "")),
        "kind": _clean_kind(raw.get("kind")),
        "prompt": str(raw.get("prompt", ""))[:500],
        "comments": _clean_comments(raw.get("comments")),
        "text": str(raw.get("text", ""))[:300],
        "range": text_range,
        "target": target,
    }


def _clean_kind(value: object) -> str:
    allowed = (HighlightKind.NOTE.value, HighlightKind.COMMENT.value)
    return value if value in allowed else HighlightKind.NOTE.value


def _clean_comments(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [str(comment)[:500] for comment in value][:50]


def _clean_text_range(value: object) -> TextRange | None:
    if not isinstance(value, dict) or not value.get("container"):
        return None
    return {
        "container": str(value.get("container", "")),
        "start": int(value.get("start", 0)),
        "end": int(value.get("end", 0)),
        "text": str(value.get("text", ""))[:300],
    }


def _clean_target(value: object) -> dict | None:
    if not isinstance(value, dict) or not value.get("src"):
        return None
    return {"src": str(value.get("src", ""))[:4000], "nodeKey": str(value.get("nodeKey", ""))[:200]}


def watcher_loop(server: ThreadingHTTPServer) -> None:
    """Drop stale presence and broadcast a reload whenever a source file changes."""
    while getattr(server, "_htmlit_running", True):
        for session in HUB.all():
            if session.ended:
                continue
            if session.presence in (Presence.LISTENING, Presence.WORKING) and not session.agent_attached():
                session.set_presence(Presence.WAITING)
            if session.file_changed():
                session.broadcast(ServerEvent.RELOAD, {"mtime": session.mtime})
        time.sleep(config.WATCH_INTERVAL)


def idle_loop(server: ThreadingHTTPServer, grace: float) -> None:
    """Self-stop once no browser is connected and the agent has gone quiet."""
    if grace <= 0:
        return
    step = max(1.0, min(5.0, grace / 3))
    while getattr(server, "_htmlit_running", True):
        time.sleep(step)
        if HUB.connected_count() > 0:
            continue
        if time.time() - HUB.last_activity < grace:
            continue
        print("htmlit daemon idle (no browser, no activity) - shutting down", flush=True)
        threading.Thread(target=server.shutdown, daemon=True).start()
        return


def write_registry(port: int) -> None:
    config.STATE_DIR.mkdir(parents=True, exist_ok=True)
    config.REGISTRY.write_text(json.dumps({"port": port, "pid": os.getpid(), "started": time.time()}))


def create_server(host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    server._htmlit_running = True  # type: ignore[attr-defined]
    return server


def _prefetch_vendor() -> None:
    """Best-effort background download of any missing vendored assets, so the next
    page load is served locally instead of from the CDN."""
    items = vendoring.missing()
    if not items:
        return
    saved, failed = vendoring.download(items)
    if saved:
        print(f"htmlit: cached {len(saved)} asset(s) locally for the next load", flush=True)
    if failed:
        print(f"htmlit: {len(failed)} asset(s) stayed on the CDN: {', '.join(sorted(failed))}", flush=True)


def serve(host: str = "127.0.0.1", port: int = 0) -> int:
    server = create_server(host, port)
    bound_port = server.server_address[1]
    write_registry(bound_port)
    threading.Thread(target=watcher_loop, args=(server,), daemon=True).start()
    threading.Thread(target=idle_loop, args=(server, config.IDLE_GRACE), daemon=True).start()
    if config.AUTO_VENDOR:
        threading.Thread(target=_prefetch_vendor, name="htmlit-vendor", daemon=True).start()
    print(
        f"htmlit daemon on http://{host}:{bound_port} "
        f"(pid {os.getpid()}, idle-stop {config.IDLE_GRACE:g}s)",
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server._htmlit_running = False  # type: ignore[attr-defined]
        _remove_registry()
    return 0


def _remove_registry() -> None:
    try:
        if config.REGISTRY.is_file():
            config.REGISTRY.unlink()
    except OSError:
        pass


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="htmlit review daemon")
    parser.add_argument("--port", type=int, default=0, help="port (0 = auto-pick)")
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)
    return serve(host=args.host, port=args.port)
