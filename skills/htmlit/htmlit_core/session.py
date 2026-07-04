"""In-memory review state: a :class:`Session` per artifact and a :class:`Hub` that
owns them all. A session tracks the conversation, queued feedback, connected
browsers, and whether an agent is currently serving the review.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time

from . import config
from .enums import ChatRole, Presence, ServerEvent
from .models import ChatMessage, FeedbackItem, Highlight, SessionSnapshot
from .sidecar import artifact_is_generated, load_sidecar, save_sidecar

EventQueue = "queue.Queue[Tuple[str, str]]"


class Session:
    """Everything known about one artifact under review."""

    def __init__(self, path: str, name: str) -> None:
        self.path = os.path.abspath(path)
        self.name = name
        self.key = config.session_key(path)
        self.created = time.time()
        self.mtime = self._current_mtime()

        self.chat: list[ChatMessage] = []
        self.highlights: list[Highlight] = []  # local marks, persisted, never sent to the agent
        self.inbox: list[FeedbackItem] = []  # feedback waiting for the agent to poll
        self.context = ""  # agent handoff note for whoever resumes the review

        self.presence = Presence.WAITING
        self.ended = False
        self.auto_delete = artifact_is_generated(self.path)  # delete the file on explicit end
        self.just_resumed = False  # a sidecar was loaded when the session opened

        self.pollers = 0  # in-flight agent long-polls
        self.last_poll = 0.0  # last time an agent polled or replied
        self.subscribers: list[EventQueue] = []  # connected browser event streams

        self.cond = threading.Condition()  # guards the inbox / ended for long-polls
        self.lock = threading.Lock()  # guards the subscriber list

    def _current_mtime(self) -> float:
        try:
            return os.path.getmtime(self.path)
        except OSError:
            return 0.0

    def file_changed(self) -> bool:
        mtime = self._current_mtime()
        if mtime and mtime != self.mtime:
            self.mtime = mtime
            return True
        return False

    def subscribe(self) -> EventQueue:
        stream: EventQueue = queue.Queue()
        with self.lock:
            self.subscribers.append(stream)
        return stream

    def unsubscribe(self, stream: EventQueue) -> None:
        with self.lock:
            if stream in self.subscribers:
                self.subscribers.remove(stream)

    def broadcast(self, event: ServerEvent, data: dict) -> None:
        payload = (event.value, json.dumps(data))
        with self.lock:
            streams = list(self.subscribers)
        for stream in streams:
            stream.put(payload)

    def push_feedback(self, item: FeedbackItem) -> None:
        with self.cond:
            self.inbox.append(item)
            self.cond.notify_all()

    def drain_feedback(self) -> list[FeedbackItem]:
        with self.cond:
            drained = self.inbox[:]
            self.inbox.clear()
        return drained

    def set_presence(self, state: Presence | str) -> None:
        try:
            presence = Presence(state)
        except ValueError:
            return
        if presence is self.presence:
            return
        self.presence = presence
        self.broadcast(ServerEvent.AGENT_PRESENCE, {"state": presence})

    def agent_attached(self) -> bool:
        """True while an agent is polling now or polled within the attach window."""
        return self.pollers > 0 or (time.time() - self.last_poll) < config.AGENT_TTL

    def is_kept(self) -> bool:
        """True when the artifact is kept on end (the panel's Keep toggle is on)."""
        return not self.auto_delete

    def save_state(self) -> None:
        """Persist the conversation, handoff note, and highlights, if kept."""
        if self.is_kept():
            save_sidecar(self.path, self.chat, self.name, self.context, self.highlights)

    def add_chat(self, role: ChatRole, text: str) -> None:
        if not text:
            return
        self.chat.append({"role": role.value, "text": text})
        self.broadcast(ServerEvent.CHAT_SYNC, {"chat": self.chat})
        self.save_state()

    def snapshot(self) -> SessionSnapshot:
        return {
            "key": self.key,
            "file": self.path,
            "name": self.name,
            "presence": self.presence.value,
            "agent_attached": self.agent_attached(),
            "ended": self.ended,
            "persist": self.is_kept(),
            "context_len": len(self.context),
            "chat_len": len(self.chat),
        }


class Hub:
    """Owns every open session and tracks daemon-wide activity for idle shutdown."""

    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.lock = threading.Lock()
        self.last_activity = time.time()

    def touch(self) -> None:
        self.last_activity = time.time()

    def all(self) -> list[Session]:
        with self.lock:
            return list(self.sessions.values())

    def get(self, key: str) -> Session | None:
        with self.lock:
            return self.sessions.get(key)

    def by_path(self, path: str) -> Session | None:
        return self.get(config.session_key(path))

    def connected_count(self) -> int:
        return sum(len(s.subscribers) for s in self.all())

    def has_live_review(self) -> bool:
        """True when restarting the daemon would disrupt a live review: a session
        with a connected browser, or with un-polled feedback and an agent attached
        to receive it. Moving the shared daemon to a new port would orphan an open
        tab and drop the in-memory inbox, which is how a final send gets lost."""
        for session in self.all():
            if session.ended:
                continue
            if session.subscribers:
                return True
            if session.inbox and session.agent_attached():
                return True
        return False

    def open(self, path: str, name: str, auto_delete: bool | None = None) -> Session:
        key = config.session_key(path)
        with self.lock:
            session = self.sessions.get(key)
            if session is None:
                session = Session(path, name)
                _resume_from_sidecar(session)
                self.sessions[key] = session
            else:
                session.ended = False
                session.name = name
                session.mtime = session._current_mtime()
            if auto_delete is not None:
                session.auto_delete = auto_delete
            return session


def _resume_from_sidecar(session: Session) -> None:
    """Restore a previously persisted review's conversation and kept flag."""
    saved = load_sidecar(session.path)
    if not saved:
        return
    session.chat = saved.get("chat", []) or []
    session.context = saved.get("context", "") or ""
    session.highlights = saved.get("highlights", []) or []
    session.auto_delete = False  # it was kept before, so keep it now
    session.just_resumed = bool(session.chat or session.context or session.highlights)
