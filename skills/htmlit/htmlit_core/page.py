"""Turning a session into the page the browser receives: the injected client
snippet and the configuration object it reads on load.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from .config import asset_url
from .models import PageConfig

if TYPE_CHECKING:
    from .session import Session

_BODY_CLOSE = "</body>"
_HTML_CLOSE = "</html>"


def build_page_config(session: Session) -> PageConfig:
    return {
        "key": session.key,
        "file": session.path,
        "name": session.name,
        "presence": session.presence.value,
        "ended": session.ended,
        "persist": session.is_kept(),
        "context": session.context,
        "chat": session.chat,
        "highlights": session.highlights,
        "vendor": {
            "idiomorph": asset_url("idiomorph.min.js"),
            "mermaid": asset_url("mermaid.min.js"),
            "hljsJs": asset_url("highlight.min.js"),
            "hljsLight": asset_url("hljs-light.css"),
            "hljsDark": asset_url("hljs-dark.css"),
        },
    }


def inject_client(html: str, config: PageConfig) -> str:
    """Insert the review client just before the closing body (or html) tag, or
    append it when the document has neither."""
    snippet = _client_snippet(config)
    lowered = html.lower()
    for marker in (_BODY_CLOSE, _HTML_CLOSE):
        index = lowered.rfind(marker)
        if index != -1:
            return html[:index] + snippet + html[index:]
    return html + snippet


def _client_snippet(config: PageConfig) -> str:
    config_json = json.dumps(config)
    idiomorph_url = config["vendor"]["idiomorph"]
    return (
        '\n<script data-htmlit id="htmlit-config">window.__HTMLIT__=' + config_json + ";</script>\n"
        '<script data-htmlit id="htmlit-idiomorph" src="' + idiomorph_url + '"></script>\n'
        '<script data-htmlit id="htmlit-client" type="module" src="/htmlit-client/client.js"></script>\n'
    )
