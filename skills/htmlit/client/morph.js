import { CFG, KEY, Presence, SseEvent, state as appState } from "./state.js";
import { root, ui, applyDocTitle } from "./dom.js";
import { api, copyText, esc } from "./util.js";
import { decorateAnswers } from "./exporting.js";
import { detectNewContent, highlightNew, initContent } from "./content.js";
import { refreshFavicon } from "./favicon.js";
import { setPresence, syncChat } from "./chat.js";
import { renderHighlights, renderMarkers } from "./overlays.js";
import { rebuildRail } from "./rail.js";
import { applyHighlights, clearPending, unwrapHighlights, getPending } from "./annotate.js";

export function protectRemoved(node) {
  if (node.nodeType !== 1) return true;
  // The per-diagram zoom bar is transient client UI: let a morph remove it with its
  // frame (otherwise Idiomorph strands it onto another element); it is rebuilt after.
  if (node.hasAttribute && node.hasAttribute("data-htmlit-tools")) return true;
  return !(node.id === "htmlit-chrome" || (node.hasAttribute && node.hasAttribute("data-htmlit")));
}
export function protectMorphed(oldNode) {
  if (oldNode.nodeType === 1 && oldNode.hasAttribute && oldNode.hasAttribute("data-htmlit-tools")) return true;
  return !(oldNode.nodeType === 1 && oldNode.hasAttribute && oldNode.hasAttribute("data-htmlit"));
}
export function reExec(node) {
  if (node && node.tagName === "SCRIPT") {
    var s = document.createElement("script");
    for (var i = 0; i < node.attributes.length; i++) s.setAttribute(node.attributes[i].name, node.attributes[i].value);
    s.textContent = node.textContent;
    node.replaceWith(s);
  }
}
export function reload() {
  if (!window.Idiomorph) { location.reload(); return; }
  fetch("/artifact/" + KEY + "?t=" + Date.now(), { cache: "no-store" })
    .then(function (r) { return r.text(); })
    .then(function (html) {
      var doc = new DOMParser().parseFromString(html, "text/html");
      var opts = { morphStyle: "innerHTML", callbacks: { beforeNodeRemoved: protectRemoved, beforeNodeMorphed: protectMorphed, afterNodeAdded: reExec } };
      // Remove our note-highlight <mark>s first so the morph diffs clean artifact
      // text on both sides; they are re-applied from stored ranges after.
      unwrapHighlights();
      // Pass innerHTML *strings*: handing Idiomorph a <body>/<head> node in
      // innerHTML mode nests it as a child, which corrupts the DOM on every reload.
      // Head changes are rare; never let a head hiccup nuke the in-place body update.
      try { window.Idiomorph.morph(document.head, doc.head.innerHTML, opts); } catch (e) {}
      // Body morph is the important one: patch in place, keep scroll + chrome.
      window.Idiomorph.morph(document.body, doc.body.innerHTML, opts);
      applyDocTitle(); // a head morph can restore the artifact's own <title>
      refreshFavicon(); // ...and its own favicon
      decorateAnswers();
      initContent();
      // A morph replaces the artifact's nodes, so drop any half-made selection
      // and re-anchor note highlights + overlays against the new DOM.
      if (getPending()) clearPending();
      applyHighlights();
      renderMarkers();
      renderHighlights();
      rebuildRail(true);
      highlightNew(detectNewContent(false));
    })
    .catch(function () { location.reload(); });
}

export function resumeCmd() { return "htmlit resume " + (CFG.file || ""); }
// Render the "kept - here's how to resume" box. `mode`: "live" (still open) or "ended".
export function renderKeepHint(mode) {
  if (!ui.keephint) return;
  if (!appState.persist) { ui.keephint.classList.add("hidden"); ui.keephint.innerHTML = ""; return; }
  var lead = mode === "ended"
    ? "Saved - this review was kept. Resume it anytime:"
    : "Kept on end. Resume this review anytime:";
  ui.keephint.classList.remove("hidden");
  ui.keephint.innerHTML =
    '<div class="kh-lead">' + esc(lead) + "</div>" +
    '<div class="kh-row"><code class="kh-cmd"></code>' +
    '<button class="link kh-copy" data-act="copyresume" title="Copy">Copy</button></div>';
  ui.keephint.querySelector(".kh-cmd").textContent = resumeCmd();
  var btn = ui.keephint.querySelector(".kh-copy");
  btn.addEventListener("click", function () {
    copyText(resumeCmd());
    btn.textContent = "Copied";
    setTimeout(function () { btn.textContent = "Copy"; }, 1400);
  });
}
export function setPersist(on, fromServer) {
  appState.persist = !!on;
  if (ui.persist) ui.persist.checked = appState.persist;
  renderKeepHint(appState.ended ? "ended" : "live");
  if (!fromServer) api("/api/" + KEY + "/persist", { persist: appState.persist }).catch(function () {});
}

/* SSE */
/** Open the change feed and route each server-sent event to its handler. */
export function connect() {
  var es = new EventSource("/events/" + KEY);
  es.addEventListener(SseEvent.RELOAD, function () { reload(); });
  es.addEventListener(SseEvent.CHAT_SYNC, function (e) { syncChat(JSON.parse(e.data).chat || []); });
  es.addEventListener(SseEvent.AGENT_PRESENCE, function (e) { setPresence(JSON.parse(e.data).state); });
  es.addEventListener(SseEvent.PERSIST, function (e) {
    var d = {}; try { d = JSON.parse(e.data || "{}"); } catch (_) {}
    setPersist(!!d.persist, true); // sync across tabs without re-POSTing
  });
  es.addEventListener(SseEvent.ENDED, function (e) {
    var d = {};
    try { d = JSON.parse(e.data || "{}"); } catch (_) {}
    if (typeof d.persist === "boolean") appState.persist = d.persist;
    markEnded(d.removed);
  });
  es.onerror = function () {/* EventSource auto-reconnects */};
}
export function markEnded(removed) {
  appState.ended = true;
  clearPending();
  ui.banner.textContent = removed
    ? "Session ended - this artifact has been cleaned up."
    : (appState.persist ? "Session ended - the artifact and this thread were kept." : "Session ended.");
  ui.banner.classList.remove("hidden");
  ui.input.setAttribute("contenteditable", "false");
  ui.input.classList.add("disabled");
  if (ui.persist) ui.persist.disabled = true;
  renderKeepHint("ended");
  var reloadBtn = root.querySelector('[data-act="reload"]');
  if (reloadBtn) reloadBtn.disabled = true;
  setPresence(Presence.WAITING);
}
