"""htmlit: a self-contained collaborative review surface for HTML artifacts.

The package is split by concern:

- :mod:`htmlit_core.enums` and :mod:`htmlit_core.models` hold the shared types.
- :mod:`htmlit_core.config` holds paths, tunables, and identity helpers.
- :mod:`htmlit_core.sidecar` handles persistence next to the artifact.
- :mod:`htmlit_core.session` holds the in-memory review state.
- :mod:`htmlit_core.page` builds the injected page.
- :mod:`htmlit_core.server` is the daemon; :mod:`htmlit_core.cli` drives it.
"""

from __future__ import annotations

__all__ = ["cli", "config", "enums", "models", "page", "server", "session", "sidecar"]
