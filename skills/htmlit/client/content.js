import { KEY, state as appState } from "./state.js";
import { api, cssPath, inChrome } from "./util.js";
import { ensureHljs, ensureMermaid, enhanceCode, highlight, renderMermaid } from "./render.js";
import { decorateAnswers } from "./exporting.js";
import { applyHighlights, unwrapHighlights } from "./annotate.js";

var prevChildSigs = null;
export function childSig(el) {
  return el.tagName + "\u0000" + (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400);
}
export function detectNewContent(seedOnly) {
  if (!document.body) return [];
  var kids = Array.prototype.filter.call(document.body.children, function (el) {
    return !inChrome(el) && !(el.hasAttribute && el.hasAttribute("data-htmlit"));
  });
  var cur = kids.map(childSig);
  var fresh = [];
  if (!seedOnly && prevChildSigs) {
    var prev = prevChildSigs.slice();
    kids.forEach(function (el, i) {
      var idx = prev.indexOf(cur[i]);
      if (idx === -1) { if (childSig(el).length > el.tagName.length + 1) fresh.push(el); }
      else prev.splice(idx, 1);
    });
  }
  prevChildSigs = cur;
  return fresh;
}
// Flash the given elements and scroll the first into view.
export function highlightNew(nodes) {
  if (!nodes || !nodes.length) return;
  nodes.forEach(function (n) {
    if (n.nodeType !== 1 || !document.body.contains(n)) return;
    n.classList.add("htmlit-new");
    setTimeout(function () { n.classList.remove("htmlit-new"); }, 2800);
  });
  try { nodes[0].scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
}

// Whether an element is currently rendered (has box rects). A display:none ancestor
// - a collapsed <details> or an unchecked CSS option - yields zero rects.
function isShown(el) { return !!(el && el.getClientRects && el.getClientRects().length); }
// The outermost hidden element on the path from el up to its first shown ancestor:
// the collapsed panel that needs revealing.
function hiddenPanel(el) {
  var panel = null;
  for (var n = el; n && n !== document.body; n = n.parentElement) {
    if (isShown(n)) break;
    panel = n;
  }
  return panel;
}
// Make an element reachable when a collapsed section hides it: open any <details>,
// clear [hidden], and - for the common CSS radio/checkbox "tabs" pattern - check the
// control in the panel's container that reveals it (restoring state if none does).
export function revealElement(el) {
  if (!el) return false;
  for (var n = el; n && n !== document.body; n = n.parentElement) {
    if (n.tagName === "DETAILS") n.open = true;
    if (n.nodeType === 1 && n.hasAttribute("hidden")) n.removeAttribute("hidden");
  }
  if (isShown(el)) return true;
  var panel = hiddenPanel(el);
  if (!panel) return isShown(el);
  var scope = panel.parentElement || document.body;
  var toggles = Array.prototype.slice.call(scope.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
  var snapshot = toggles.map(function (t) { return t.checked; });
  for (var i = 0; i < toggles.length; i++) {
    if (toggles[i].checked) continue;
    toggles[i].checked = true;
    toggles[i].dispatchEvent(new Event("change", { bubbles: true }));
    if (isShown(el)) return true;
  }
  toggles.forEach(function (t, i) {
    if (t.checked !== snapshot[i]) { t.checked = snapshot[i]; t.dispatchEvent(new Event("change", { bubbles: true })); }
  });
  return isShown(el);
}

export function initContent() {
  var jobs = [];
  if (document.querySelector(".mermaid, code.language-mermaid")) jobs.push(ensureMermaid());
  if (document.querySelector("pre code")) jobs.push(ensureHljs());
  Promise.all(jobs).then(function () {
    var mermaidDone = renderMermaid(false);
    highlight();
    enhanceCode();
    decorateAnswers();
    applyHighlights(); // re-draw note highlights after (re)rendering the content
    // Wait for diagrams to settle (a failed one degrades asynchronously) so the
    // layout check sees the final DOM before reporting warnings to the agent.
    Promise.resolve(mermaidDone).then(function () { setTimeout(checkLayout, 120); });
  });
}

/* snapshot */
export function domSnapshot() {
  var clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll("[data-htmlit], #htmlit-chrome, script").forEach(function (n) { n.remove(); });
  unwrapHighlights(clone); // local note highlights are not part of what the agent sees
  return ("<!doctype html>\n<html>" + clone.innerHTML + "</html>").slice(0, 200000);
}
export function checkLayout() {
  var de = document.documentElement;
  var warnings = [];
  var avail = de.clientWidth; // already excludes the reserved panel margin
  if (de.scrollWidth > avail + 2) {
    var offenders = Array.prototype.filter
      .call(document.body.querySelectorAll("*"), function (el) {
        if (inChrome(el)) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.right > avail + 2;
      })
      .slice(0, 5)
      .map(function (el) { return { selector: cssPath(el), width: Math.round(el.getBoundingClientRect().width) }; });
    warnings.push({ severity: "error", kind: "horizontal-overflow", message: "Artifact overflows horizontally", offenders: offenders });
  }
  // A diagram that failed to parse (now showing its source) is a defect to fix at
  // the source, not just a runtime fallback - surface it so the agent corrects it.
  document.querySelectorAll(".htmlit-diagram-error").forEach(function (el) {
    warnings.push({ severity: "error", kind: "mermaid-syntax",
      message: "A Mermaid diagram failed to parse and is showing its source. Fix the syntax - quote any node or edge label that contains a space, parenthesis, or punctuation.",
      offenders: [cssPath(el)] });
  });
  // No author stylesheet means the page is relying on htmlit's fallback typography.
  // Prompt the agent to ship real CSS (themed for light and dark) instead. Ignore
  // htmlit's own styles and the scoped <style> Mermaid injects inside a diagram.
  var authorCss = false;
  document.querySelectorAll('style, link[rel~="stylesheet"]').forEach(function (el) {
    if (el.hasAttribute("data-htmlit")) return;
    if (el.closest && el.closest(".mermaid, svg")) return;
    authorCss = true;
  });
  if (!authorCss) {
    warnings.push({ severity: "warn", kind: "no-artifact-css",
      message: "The artifact ships no CSS and is falling back to htmlit's base typography. Add a <style> that themes the page for both light and html.dark.",
      offenders: [] });
  }
  api("/api/" + KEY + "/layout-warnings", { layout_warnings: warnings }).catch(function () {});
}

/* favicon
   A dynamic favicon reflects the review/agent state in the browser tab so the
   user can tell at a glance when to act (and the agent isn't left idling):
     - listening (agent connected, long-polling = waiting for YOUR input) -> yellow spinner
     - working   (agent processing your feedback)                          -> green spinner
     - waiting   (no agent connected)                                      -> grey idle ring
     - ended     (review closed)                                           -> green tick */
