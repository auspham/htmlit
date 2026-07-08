"""Typed shapes for the JSON that crosses the wire and lands in the sidecar.

These are ``TypedDict`` definitions rather than dataclasses because the data
arrives as parsed JSON and is handed back to ``json.dumps`` unchanged; the types
document the contract without forcing a conversion layer.
"""

from __future__ import annotations

from typing import TypedDict


class ChatMessage(TypedDict):
    """One line in a review's conversation."""

    role: str  # a ChatRole value
    text: str


class TextRange(TypedDict):
    """A commented span, resolvable back to the DOM after a live morph."""

    container: str
    start: int
    end: int
    text: str


class DiagramTarget(TypedDict):
    """A Mermaid node or edge that a comment is anchored to."""

    src: str
    nodeKey: str


class Highlight(TypedDict):
    """A persistent mark saved with the artifact (a note or a comment anchor)."""

    id: str
    kind: str  # a HighlightKind value
    prompt: str
    comments: list[str] | None
    text: str
    range: TextRange | None
    target: DiagramTarget | None


class Prompt(TypedDict, total=False):
    """A single piece of feedback the browser sends for the agent to act on."""

    selector: str
    tag: str
    text: str
    prompt: str
    range: TextRange | None
    commentId: str


class LayoutWarning(TypedDict, total=False):
    """A rendering problem the browser reports so the agent can fix it first."""

    severity: str
    kind: str
    message: str
    offenders: list[str]


class SidecarData(TypedDict, total=False):
    """The persisted-session file written next to a kept artifact."""

    chat: list[ChatMessage]
    name: str
    context: str
    highlights: list[Highlight]
    persist: bool
    saved: float


class FeedbackItem(TypedDict, total=False):
    """One entry queued in a session inbox, drained by an agent long-poll."""

    type: str  # a FeedbackKind value
    prompts: list[Prompt]
    domSnapshot: str
    layout_warnings: list[LayoutWarning]


class VendorUrls(TypedDict):
    """Where the browser loads each vendored library from (local or CDN)."""

    idiomorph: str
    mermaid: str
    hljsJs: str
    hljsLight: str
    hljsDark: str


class PageConfig(TypedDict):
    """The ``window.__HTMLIT__`` object injected into the served artifact."""

    key: str
    file: str
    name: str
    presence: str
    ended: bool
    persist: bool
    context: str
    chat: list[ChatMessage]
    highlights: list[Highlight]
    vendor: VendorUrls


class SessionSnapshot(TypedDict):
    """A session's public status, surfaced on the health endpoint."""

    key: str
    file: str
    name: str
    presence: str
    agent_attached: bool
    ended: bool
    persist: bool
    context_len: int
    chat_len: int
