"""Unit tests for the raw-HTML structure validator.

These pin the two things that matter: a container imbalance that would collapse the
layout is reported, and valid HTML that leans on optional end tags (``<li>``, ``<p>``,
``<td>`` ...) is never flagged.
"""

from __future__ import annotations

from htmlit_core.validation import html_structure_warnings


def _offenders(html: str) -> list[str]:
    warnings = html_structure_warnings(html)
    if not warnings:
        return []
    assert len(warnings) == 1
    assert warnings[0]["kind"] == "unbalanced-html"
    assert warnings[0]["severity"] == "error"
    return warnings[0]["offenders"]


def test_stray_closing_div_is_reported() -> None:
    # An extra </div> closes the wrapper early - the real bug that pushed sections
    # out of the centring container and made them render full-width.
    html = '<div class="wrap"><p>hi</p></div></div><h2>escaped</h2>'
    offenders = _offenders(html)
    assert len(offenders) == 1
    assert "unexpected </div>" in offenders[0]


def test_unclosed_container_is_reported() -> None:
    offenders = _offenders('<section><ol><li>a<li>b</section><h2>next</h2>')
    assert any("<ol>" in o and "never closed" in o for o in offenders)


def test_valid_optional_end_tags_are_not_flagged() -> None:
    # <li>, <p>, <td>, <tr>, <option> legitimately omit their end tags; the checker
    # must not track them, or every ordinary list/table/paragraph would false-positive.
    html = (
        '<div class="wrap">'
        "<ul><li>a<li>b<li>c</ul>"
        "<p>para one<p>para two"
        "<table><thead><tr><th>h<tbody><tr><td>x<td>y</table>"
        "<select><option>1<option>2</select>"
        "<dl><dt>t<dd>d</dl>"
        "</div>"
    )
    assert _offenders(html) == []


def test_nested_containers_balance_cleanly() -> None:
    html = "<div><section><figure><ul><li>x</ul></figure></section></div>"
    assert _offenders(html) == []


def test_tags_inside_comments_and_scripts_are_ignored() -> None:
    # html.parser treats comment bodies and <script>/<style> content as text, so a
    # stray-looking tag in a code sample or comment must not trip the checker.
    html = '<div><!-- </div> in a comment --><script>var s = "</div>";</script></div>'
    assert _offenders(html) == []


def test_well_formed_document_has_no_warnings() -> None:
    assert html_structure_warnings("<!doctype html><html><body><div><p>ok</p></div></body></html>") == []
