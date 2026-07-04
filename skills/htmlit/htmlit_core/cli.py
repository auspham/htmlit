"""The command-line front end that drives the daemon: it spawns the daemon on
demand, opens and serves reviews, long-polls for feedback, and relays replies.
"""

from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from .config import (
    DAEMON_LOG,
    REGISTRY,
    SERVER_ENTRY,
    STATE_DIR,
    VENDOR_SCRIPT,
    session_key,
    source_version,
)
from .enums import PollResult, Presence

DAEMON_START_TIMEOUT = 8.0
RESTART_TIMEOUT = 5.0
SIDECAR_GLOB = "*.htmlit.json"
SIDECAR_SUFFIX = ".htmlit.json"


def request(method: str, url: str, body: dict | None = None, timeout: float = 30.0) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except (ValueError, TypeError):
            return exc.code, {}


def copilot_session_name() -> str:
    """The Copilot CLI session name that launched htmlit, so the page title says
    which session a review belongs to. Empty when not in a Copilot session."""
    session_id = os.environ.get("COPILOT_AGENT_SESSION_ID", "").strip()
    if not session_id or "/" in session_id or ".." in session_id:
        return ""
    home = Path(os.environ.get("COPILOT_HOME", Path.home() / ".copilot"))
    workspace = home / "session-state" / session_id / "workspace.yaml"
    try:
        for line in workspace.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("name:"):
                return line.split(":", 1)[1].strip().strip("'\"")[:120]
    except OSError:
        pass
    return ""


def read_registry() -> dict | None:
    if not REGISTRY.is_file():
        return None
    try:
        return json.loads(REGISTRY.read_text())
    except (ValueError, OSError):
        return None


def daemon_health() -> tuple[str, str] | None:
    """Return ``(base_url, version)`` for a live daemon, or None."""
    registry = read_registry()
    if not registry:
        return None
    base = f"http://127.0.0.1:{registry['port']}"
    try:
        status, data = request("GET", base + "/health", timeout=2)
    except (urllib.error.URLError, OSError):
        return None
    if status == 200:
        return base, str(data.get("version", ""))
    return None


def daemon_base() -> str | None:
    health = daemon_health()
    return health[0] if health else None


def daemon_has_live_review(base: str) -> bool:
    """Whether restarting the daemon now would disrupt an open review."""
    try:
        status, data = request("GET", base + "/health", timeout=2)
        if status == 200:
            return bool(data.get("busy"))
    except (urllib.error.URLError, OSError):
        pass
    return False


def ensure_daemon() -> str:
    """Return a live daemon on the current source version, restarting a stale one
    when it is safe to do so."""
    health = daemon_health()
    if health:
        base, running_version = health
        if running_version == source_version():
            return base
        if daemon_has_live_review(base):
            print(
                "htmlit: skill code changed, but a review is open on the running "
                "daemon - keeping it so the live session isn't dropped (restarting "
                "would move the daemon to a new port and orphan the open tab). The "
                "update applies automatically once no review is open."
            )
            return base
        print("htmlit: skill code changed - restarting the daemon to pick it up")
        _restart_daemon(base)
    return _spawn_daemon()


def _restart_daemon(base: str) -> None:
    try:
        request("POST", base + "/shutdown", {})
    except (urllib.error.URLError, OSError):
        pass
    deadline = time.time() + RESTART_TIMEOUT
    while time.time() < deadline and daemon_base():
        time.sleep(0.15)
    try:
        if REGISTRY.is_file():
            REGISTRY.unlink()
    except OSError:
        pass


def _spawn_daemon() -> str:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    log = open(DAEMON_LOG, "ab")
    subprocess.Popen(
        [sys.executable, str(SERVER_ENTRY), "--port", "0"],
        stdout=log,
        stderr=log,
        cwd=str(SERVER_ENTRY.parent),
        **_detach_kwargs(),
    )
    deadline = time.time() + DAEMON_START_TIMEOUT
    while time.time() < deadline:
        base = daemon_base()
        if base:
            return base
        time.sleep(0.15)
    raise SystemExit("htmlit: daemon did not start; see " + str(DAEMON_LOG))


def _detach_kwargs() -> dict[str, object]:
    """Spawn the daemon so it outlives the launching shell, on every platform.

    POSIX uses a new session (setsid); Windows has no setsid, so it needs the
    DETACHED_PROCESS / new-process-group creation flags instead.
    """
    if os.name == "nt":
        return {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def require_daemon() -> str:
    base = daemon_base()
    if not base:
        raise SystemExit("htmlit: no daemon running. Run `htmlit <file>` first.")
    return base


def cmd_open(args: argparse.Namespace) -> int:
    path = os.path.abspath(args.file)
    if not os.path.isfile(path):
        raise SystemExit(f"htmlit: file not found: {path}")
    base = ensure_daemon()
    payload: dict[str, object] = {
        "file": path,
        "name": args.name or copilot_session_name() or os.path.basename(path),
    }
    if args.keep:
        payload["keep"] = True
    if args.clean:
        payload["clean"] = True
    status, res = request("POST", base + "/api/sessions", payload)
    if status != 200:
        raise SystemExit(f"htmlit: could not open session: {res}")
    url = base + res["url"]
    if not args.no_open:
        _open_browser(url)
    _print_ready(args.file, path, url, res)
    return 0


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001 - a headless machine must not crash the open
        pass


def _print_ready(file_arg: str, path: str, url: str, res: dict) -> None:
    fate = "auto-deleted on end" if res.get("cleanup") else "kept on end"
    print(f"htmlit review ready:\n  {url}\n  key: {res['key']}\n  file: {path}  ({fate})")
    if res.get("resumed"):
        _print_resume_banner(res)
    print("Now SERVE the review - keep polling until the user ends it (otherwise")
    print("the panel shows 'no agent connected' and messages just queue):")
    print(f"  htmlit poll {file_arg}")


def _print_resume_banner(res: dict) -> None:
    print("\n  RESUMING a persisted review - restore your context from the thread below,")
    print("  read the current artifact, then continue the workflow.")
    note = (res.get("context") or "").strip()
    if note:
        print("\n  handoff note (previous agent):")
        for line in note.splitlines():
            print("  " + line)
    chat = res.get("chat") or []
    if chat:
        print("\n  conversation so far:")
        for message in chat:
            who = "you (agent)" if message.get("role") == "agent" else "user"
            text = " ".join((message.get("text") or "").split())
            if len(text) > 500:
                text = text[:500] + "\u2026"
            print(f"  [{who}] {text}")


def cmd_resume(args: argparse.Namespace) -> int:
    if args.file:
        args.name = getattr(args, "name", None)
        args.keep = False
        args.clean = False
        return cmd_open(args)
    reviews = discover_resumable_reviews()
    if not reviews:
        print("No resumable reviews found under ~/.htmlit or ./.htmlit.")
        print("A review becomes resumable once the user turns on the panel's Keep")
        print('toggle, or the agent runs `htmlit context <file> "..."`.')
        return 0
    _print_review_list(reviews)
    return 0


def _print_review_list(reviews: dict[str, dict]) -> None:
    print("Resumable reviews:\n")
    for info in sorted(reviews.values(), key=lambda i: (i.get("saved") or 0), reverse=True):
        when = ""
        if info.get("saved"):
            when = " \u00b7 saved " + datetime.datetime.fromtimestamp(info["saved"]).strftime("%Y-%m-%d %H:%M")
        count = info["chat"]
        summary = f"{count} msg" + ("s" if count != 1 else "")
        if info["note"]:
            summary += ", handoff note"
        missing = "  [artifact missing]" if not info.get("exists", True) else ""
        try:
            location = os.path.relpath(info["file"])
        except ValueError:
            location = info["file"]
        print(f"  \u2022 {info['name']}  ({summary}){when}{missing}")
        print(f"      htmlit resume {location}\n")
    print("Run one of the commands above to resume: it restores the conversation and")
    print("prints the previous agent's handoff note so you can continue the workflow.")


def discover_resumable_reviews() -> dict[str, dict]:
    """Persisted reviews from sidecars under ~/.htmlit and ./.htmlit, plus any
    kept sessions the running daemon knows about. Keyed by absolute artifact path."""
    reviews: dict[str, dict] = {}
    seen: set = set()
    for search_dir in (str(STATE_DIR), os.path.join(os.getcwd(), ".htmlit")):
        for sidecar in sorted(glob.glob(os.path.join(search_dir, SIDECAR_GLOB))):
            if sidecar in seen:
                continue
            seen.add(sidecar)
            reviews[os.path.abspath(sidecar[: -len(SIDECAR_SUFFIX)])] = _review_from_sidecar(sidecar)
    _add_daemon_reviews(reviews)
    return reviews


def _review_from_sidecar(sidecar: str) -> dict:
    artifact = sidecar[: -len(SIDECAR_SUFFIX)]
    try:
        with open(sidecar, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    return {
        "file": artifact,
        "name": data.get("name") or os.path.basename(artifact),
        "chat": len(data.get("chat") or []),
        "note": bool((data.get("context") or "").strip()),
        "saved": data.get("saved"),
        "exists": os.path.isfile(artifact),
    }


def _add_daemon_reviews(reviews: dict[str, dict]) -> None:
    base = daemon_base()
    if not base:
        return
    status, res = request("GET", base + "/health")
    if status != 200:
        return
    for snapshot in res.get("sessions", []):
        if not (snapshot.get("persist") and snapshot.get("file")):
            continue
        path = os.path.abspath(snapshot["file"])
        reviews.setdefault(path, {
            "file": snapshot["file"],
            "name": snapshot.get("name") or os.path.basename(snapshot["file"]),
            "chat": snapshot.get("chat_len", 0),
            "note": bool(snapshot.get("context_len")),
            "saved": None,
            "exists": os.path.isfile(snapshot["file"]),
        })


def _poll_once(base: str, key: str, timeout: int) -> dict:
    status, res = request("GET", f"{base}/api/poll?key={key}&timeout={timeout}", timeout=timeout + 10)
    if status == 404:
        raise SystemExit("htmlit: session not found. Run `htmlit <file>` first.")
    return res


def cmd_poll(args: argparse.Namespace) -> int:
    base = require_daemon()
    key = session_key(args.file)
    if args.agent_reply:
        request("POST", base + "/api/agent-reply", {
            "key": key,
            "text": args.agent_reply,
            "presence": Presence.LISTENING.value,
        })
    while True:
        res = _poll_once(base, key, args.timeout)
        result = res.get("type")
        if result in (PollResult.FEEDBACK.value, PollResult.ENDED.value) or args.once:
            print(json.dumps(res, indent=2))
            return 0
        # A timeout means the agent is still waiting; keep polling silently.


def cmd_reply(args: argparse.Namespace) -> int:
    base = require_daemon()
    key = session_key(args.file)
    status, res = request("POST", base + "/api/agent-reply", {
        "key": key,
        "text": args.text,
        "presence": args.presence,
    })
    if status != 200:
        raise SystemExit(f"htmlit: reply failed: {res}")
    print("ok")
    return 0


def cmd_context(args: argparse.Namespace) -> int:
    base = require_daemon()
    key = session_key(args.file)
    note = args.note if args.note is not None else sys.stdin.read()
    status, res = request("POST", f"{base}/api/{key}/context", {"context": note})
    if status != 200:
        raise SystemExit(f"htmlit: context failed: {res}")
    print("ok - handoff note saved (review will persist so it can be resumed)")
    return 0


def cmd_end(args: argparse.Namespace) -> int:
    base = require_daemon()
    key = session_key(args.file)
    status, res = request("POST", f"{base}/api/{key}/end", {"keep": bool(args.keep)})
    if status != 200:
        raise SystemExit(f"htmlit: end failed: {res}")
    if res.get("removed"):
        print(f"session ended; artifact deleted: {res.get('file')}")
    else:
        print("session ended")
    return 0


def cmd_stop(_args: argparse.Namespace) -> int:
    base = daemon_base()
    if not base:
        print("htmlit: no daemon running")
        return 0
    request("POST", base + "/shutdown", {})
    try:
        if REGISTRY.is_file():
            REGISTRY.unlink()
    except OSError:
        pass
    print("htmlit daemon stopped")
    return 0


def cmd_vendor(args: argparse.Namespace) -> int:
    command = [sys.executable, str(VENDOR_SCRIPT)]
    if args.force:
        command.append("--force")
    return subprocess.call(command)


SUBCOMMANDS = ("open", "resume", "poll", "reply", "end", "context", "stop", "vendor")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="htmlit", description="Collaborative HTML review surface")
    sub = parser.add_subparsers(dest="cmd")

    p_open = sub.add_parser("open", help="open/resume a review session")
    p_open.add_argument("file")
    p_open.add_argument("--name", default="")
    p_open.add_argument("--no-open", action="store_true", help="do not launch a browser")
    p_open.add_argument("--keep", action="store_true", help="never auto-delete this artifact on end")
    p_open.add_argument("--clean", action="store_true", help="auto-delete this artifact on end even outside .htmlit/")
    p_open.set_defaults(func=cmd_open)

    p_resume = sub.add_parser("resume", help="list resumable reviews, or resume one")
    p_resume.add_argument("file", nargs="?", default=None, help="a kept review to resume (omit to list)")
    p_resume.add_argument("--name", default="")
    p_resume.add_argument("--no-open", action="store_true", help="do not launch a browser")
    p_resume.set_defaults(func=cmd_resume)

    p_poll = sub.add_parser("poll", help="long-poll for feedback")
    p_poll.add_argument("file")
    p_poll.add_argument("--agent-reply", default="", help="post this agent message before polling")
    p_poll.add_argument("--timeout", type=int, default=25)
    p_poll.add_argument("--once", action="store_true", help="return after one long-poll even on timeout")
    p_poll.set_defaults(func=cmd_poll)

    p_reply = sub.add_parser("reply", help="post an agent message")
    p_reply.add_argument("file")
    p_reply.add_argument("text")
    p_reply.add_argument("--presence", default=Presence.LISTENING.value, choices=[p.value for p in Presence])
    p_reply.set_defaults(func=cmd_reply)

    p_end = sub.add_parser("end", help="end a session")
    p_end.add_argument("file")
    p_end.add_argument("--keep", action="store_true", help="end without deleting the artifact")
    p_end.set_defaults(func=cmd_end)

    p_ctx = sub.add_parser("context", help="save a handoff note (workflow state) for resuming")
    p_ctx.add_argument("file")
    p_ctx.add_argument("note", nargs="?", default=None, help="the note text (or pipe via stdin)")
    p_ctx.set_defaults(func=cmd_context)

    sub.add_parser("stop", help="stop the daemon").set_defaults(func=cmd_stop)

    p_vendor = sub.add_parser("vendor", help="download local assets")
    p_vendor.add_argument("--force", action="store_true")
    p_vendor.set_defaults(func=cmd_vendor)

    return parser


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] not in SUBCOMMANDS and argv[0] not in ("-h", "--help"):
        argv = ["open"] + argv  # bare `htmlit file.html` means open
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    return args.func(args)
