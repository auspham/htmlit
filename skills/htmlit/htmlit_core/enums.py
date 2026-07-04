"""Enumerations for the small state machines the review surface runs on.

Each is a ``str`` enum so its members compare equal to the wire strings the
browser client already speaks and serialize straight to those strings through
``json.dumps`` (for example ``Presence.WAITING`` becomes ``"waiting"``).
"""

from __future__ import annotations

from enum import Enum


class Presence(str, Enum):
    """Whether an agent is connected to a review, shown honestly in the panel."""

    WAITING = "waiting"      # no agent is polling
    LISTENING = "listening"  # an agent is attached and idle
    WORKING = "working"      # an agent is holding feedback to act on


class ChatRole(str, Enum):
    """Who authored a chat message."""

    USER = "user"
    AGENT = "agent"


class FeedbackKind(str, Enum):
    """The kind of item queued in a session inbox for the agent to poll."""

    PROMPTS = "prompts"
    LAYOUT_WARNINGS = "layout_warnings"


class PollResult(str, Enum):
    """The outcome the CLI receives from a long-poll."""

    FEEDBACK = "feedback"
    ENDED = "ended"
    TIMEOUT = "timeout"


class HighlightKind(str, Enum):
    """A persistent mark on the artifact: a local note or a comment to the agent."""

    NOTE = "note"
    COMMENT = "comment"


class ServerEvent(str, Enum):
    """Server-sent events the daemon pushes to the browser over the change feed."""

    READY = "ready"
    RELOAD = "reload"
    CHAT_SYNC = "chat-sync"
    AGENT_PRESENCE = "agent-presence"
    PERSIST = "persist"
    ENDED = "ended"
