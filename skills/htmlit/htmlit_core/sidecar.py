"""Persistence next to the artifact: the sidecar file that lets a kept review be
resumed later, plus the rules for cleaning up an agent-generated artifact.
"""

from __future__ import annotations

import json
import os
import time

from .models import ChatMessage, Highlight, SidecarData

SIDECAR_SUFFIX = ".htmlit.json"
GENERATED_DIR = ".htmlit"


def sidecar_path(artifact_path: str) -> str:
    return os.path.abspath(artifact_path) + SIDECAR_SUFFIX


def save_sidecar(
    artifact_path: str,
    chat: list[ChatMessage],
    name: str,
    context: str = "",
    highlights: list[Highlight] | None = None,
) -> None:
    data: SidecarData = {
        "chat": chat,
        "name": name,
        "context": context,
        "highlights": highlights or [],
        "persist": True,
        "saved": time.time(),
    }
    try:
        with open(sidecar_path(artifact_path), "w", encoding="utf-8") as handle:
            json.dump(data, handle)
    except OSError:
        pass


def load_sidecar(artifact_path: str) -> SidecarData | None:
    try:
        with open(sidecar_path(artifact_path), encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def remove_sidecar(artifact_path: str) -> None:
    try:
        os.remove(sidecar_path(artifact_path))
    except OSError:
        pass


def artifact_is_generated(artifact_path: str) -> bool:
    """True when the skill created this artifact under a ``.htmlit/`` directory, so
    it is safe to auto-delete on end. A user's own file elsewhere never is."""
    return GENERATED_DIR in os.path.abspath(artifact_path).split(os.sep)


def delete_artifact(artifact_path: str) -> bool:
    """Remove the artifact and its sidecar, tidying an emptied generated directory.

    Returns whether the artifact file itself was removed.
    """
    try:
        remove_sidecar(artifact_path)
        if not os.path.isfile(artifact_path):
            return False
        os.remove(artifact_path)
        _remove_empty_generated_dir(os.path.dirname(artifact_path))
        return True
    except OSError:
        return False


def _remove_empty_generated_dir(directory: str) -> None:
    if os.path.basename(directory) != GENERATED_DIR:
        return
    try:
        if not os.listdir(directory):
            os.rmdir(directory)
    except OSError:
        pass
