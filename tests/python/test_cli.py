"""Tests for the CLI argument parsing, dispatch, and review discovery.

These avoid spawning a real daemon: they check the parser wiring, the bare
``htmlit <file>`` shorthand, resumable-review discovery from sidecars, and the
Copilot session-name lookup.
"""

from __future__ import annotations

import json
from pathlib import Path

from htmlit_core import cli


def test_parser_wires_each_subcommand_to_its_handler() -> None:
    parser = cli.build_parser()
    cases = {
        "open": cli.cmd_open,
        "poll": cli.cmd_poll,
        "reply": cli.cmd_reply,
        "end": cli.cmd_end,
        "context": cli.cmd_context,
        "vendor": cli.cmd_vendor,
    }
    for name, handler in cases.items():
        if name == "vendor":
            argv = [name]
        elif name == "reply":
            argv = [name, "file.html", "a message"]
        else:
            argv = [name, "file.html"]
        args = parser.parse_args(argv)
        assert args.func is handler


def test_main_rewrites_bare_file_to_open(monkeypatch) -> None:
    captured: dict[str, str] = {}

    def fake_open(args) -> int:
        captured["file"] = args.file
        return 0

    monkeypatch.setattr(cli, "cmd_open", fake_open)
    assert cli.main(["plan.html"]) == 0
    assert captured["file"] == "plan.html"


def test_main_without_command_returns_one() -> None:
    assert cli.main([]) == 1


def test_discover_resumable_reviews_lists_sidecars(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "STATE_DIR", tmp_path)
    monkeypatch.chdir(tmp_path)
    artifact = tmp_path / "kept.html"
    artifact.write_text("<html></html>")
    (tmp_path / "kept.html.htmlit.json").write_text(
        json.dumps(
            {
                "name": "Kept Review",
                "chat": [{"role": "user", "text": "hi"}],
                "context": "next: ship it",
                "saved": 1_700_000_000,
            }
        )
    )

    reviews = cli.discover_resumable_reviews()
    entry = reviews[str(artifact.resolve())]
    assert entry["name"] == "Kept Review"
    assert entry["chat"] == 1
    assert entry["note"] is True
    assert entry["exists"] is True


def test_copilot_session_name_reads_workspace_yaml(tmp_path: Path, monkeypatch) -> None:
    session_id = "session-abc"
    workspace = tmp_path / "session-state" / session_id
    workspace.mkdir(parents=True)
    (workspace / "workspace.yaml").write_text("name: My Review Session\nbranch: main\n")
    monkeypatch.setenv("COPILOT_HOME", str(tmp_path))
    monkeypatch.setenv("COPILOT_AGENT_SESSION_ID", session_id)

    assert cli.copilot_session_name() == "My Review Session"


def test_copilot_session_name_is_empty_without_session(monkeypatch) -> None:
    monkeypatch.delenv("COPILOT_AGENT_SESSION_ID", raising=False)
    assert cli.copilot_session_name() == ""
