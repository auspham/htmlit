"""Structural validation of an artifact's raw HTML.

htmlit serves the artifact verbatim, so a malformed document - a stray or unbalanced
block-container tag - collapses the author's layout instead of htmlit misrendering it:
an extra ``</div>`` closes the centring wrapper early and every following section
escapes it. The browser silently repairs the DOM, so the injected client cannot see
the original mistake. This stdlib check reads the raw file and reports the imbalance
back to the authoring agent over the same layout-warnings channel as overflow and
Mermaid errors, so the fix lands in the source rather than being papered over.
"""

from __future__ import annotations

from html.parser import HTMLParser

from .models import LayoutWarning

# Block containers that require an explicit end tag (HTML defines no optional-end-tag
# rule for them). Tracking only these keeps the check free of false positives from
# elements that legitimately omit their close (<p>, <li>, <td>, <tr>, <option>, ...),
# while still catching the container imbalances that actually break the layout.
_CONTAINERS = frozenset(
    {
        "div",
        "section",
        "main",
        "article",
        "aside",
        "header",
        "footer",
        "nav",
        "figure",
        "ul",
        "ol",
        "dl",
        "table",
        "form",
        "fieldset",
        "details",
        "blockquote",
        "pre",
    }
)
_MAX_OFFENDERS = 10
_MESSAGE = (
    "The artifact HTML has unbalanced block tags, so the browser closes a container "
    "early and the sections after it escape the layout wrapper (rendering full-width "
    "with no centring/padding). Fix the tags listed in offenders in the source."
)


class _Structure(HTMLParser):
    """Track only block containers on a stack, recording every imbalance."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, int]] = []
        self.problems: list[tuple[str, str, int]] = []  # (kind, tag, line)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _CONTAINERS:
            self.stack.append((tag, self.getpos()[0]))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        pass  # a self-closing <div/> opens and closes at once: nothing to track

    def handle_endtag(self, tag: str) -> None:
        if tag not in _CONTAINERS:
            return
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                # Any tracked container still open above this one is closed implicitly
                # by this end tag: it was never closed inside its own scope.
                for skipped_tag, skipped_line in self.stack[i + 1 :]:
                    self.problems.append(("unclosed", skipped_tag, skipped_line))
                del self.stack[i:]
                return
        self.problems.append(("stray", tag, self.getpos()[0]))


def _describe(kind: str, tag: str, line: int) -> str:
    if kind == "stray":
        return f"unexpected </{tag}> at line {line} with no matching open <{tag}>"
    return f"<{tag}> opened at line {line} is never closed"


def html_structure_warnings(html: str) -> list[LayoutWarning]:
    """Return an ``unbalanced-html`` warning (or none) for the raw artifact HTML.

    The result is a list so it drops straight into the ``layout_warnings`` array the
    agent already reads; it holds at most one warning whose ``offenders`` name each
    stray or unclosed container with its source line.
    """
    parser = _Structure()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # a parser hiccup must never break serving the review
        return []
    problems = parser.problems + [("unclosed", tag, line) for tag, line in parser.stack]
    if not problems:
        return []
    offenders = [_describe(kind, tag, line) for kind, tag, line in problems[:_MAX_OFFENDERS]]
    return [{"severity": "error", "kind": "unbalanced-html", "message": _MESSAGE, "offenders": offenders}]
