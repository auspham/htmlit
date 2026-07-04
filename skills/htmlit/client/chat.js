import { Presence, state as appState } from "./state.js";
import { ui } from "./dom.js";
import { esc } from "./util.js";
import { setFaviconState } from "./favicon.js";
import { highlightNew } from "./content.js";
import { renderHighlights, renderMarkers } from "./overlays.js";
import { rebuildRail, anchorFlashEl } from "./rail.js";
import { applyHighlights, findHighlight, persistHighlights, removeHighlight, resolveDiagramTarget } from "./annotate.js";
import { setLastUserQuestion } from "./exporting.js";

var PRESENCE_LABEL = { [Presence.WORKING]: "working\u2026", [Presence.LISTENING]: "agent connected", [Presence.WAITING]: "no agent" };
/**
 * Reflect the agent's connection state in the panel, composer, and favicon.
 * @param {PresenceState} state
 */
export function setPresence(state) {
  appState.presence = state === Presence.LISTENING || state === Presence.WORKING ? state : Presence.WAITING;
  ui.presence.dataset.state = appState.presence;
  ui.presence.textContent = PRESENCE_LABEL[appState.presence] || appState.presence;
  // The composer is only ever locked when the session has ended. While the
  // agent is working the user can still type; the message just queues and the
  // agent picks it up on its next poll, so they are never stuck.
  ui.send.disabled = appState.ended;
  ui.sendend.disabled = appState.ended;
  if (ui.noagent) ui.noagent.hidden = appState.ended || appState.presence !== Presence.WAITING;
  var working = ui.log.querySelector(".bubble.working");
  if (appState.presence === Presence.WORKING && !working) {
    var b = document.createElement("div");
    b.className = "bubble agent working";
    b.innerHTML = '<span class="spinner"></span><span>Working&hellip;</span>';
    ui.log.appendChild(b);
    ui.log.scrollTop = ui.log.scrollHeight;
  } else if (appState.presence !== Presence.WORKING && working) {
    working.remove();
  }
  setFaviconState(appState.ended ? "ended" : appState.presence);
}
export function addBubble(role, text) {
  if (!text) return;
  var el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = "<small>" + (role === "agent" ? "Agent" : "You") + "</small>" + esc(text);
  var working = ui.log.querySelector(".bubble.working");
  if (working) ui.log.insertBefore(el, working);
  else ui.log.appendChild(el);
  ui.log.scrollTop = ui.log.scrollHeight;
  refreshEmpty();
}
export function syncChat(chat) {
  Array.prototype.forEach.call(ui.log.querySelectorAll(".bubble:not(.working)"), function (b) { b.remove(); });
  var working = ui.log.querySelector(".bubble.working");
  (chat || []).forEach(function (m) {
    if (m.role !== "agent" && m.text) setLastUserQuestion(m.text);
    var el = document.createElement("div");
    el.className = "bubble " + (m.role === "agent" ? "agent" : "user");
    el.innerHTML = "<small>" + (m.role === "agent" ? "Agent" : "You") + "</small>" + esc(m.text);
    if (working) ui.log.insertBefore(el, working);
    else ui.log.appendChild(el);
  });
  ui.log.scrollTop = ui.log.scrollHeight;
  refreshEmpty();
}
export function refreshEmpty() {
  var has = ui.log.querySelector(".bubble");
  var empty = ui.log.querySelector(".empty");
  if (!has && !empty) {
    var e = document.createElement("div");
    e.className = "empty";
    e.textContent = "Select any text on the page to highlight or comment - or just type a message.";
    ui.log.appendChild(e);
  } else if (has && empty) {
    empty.remove();
  }
}

/* pills
   The send queue now holds only comments (sent to the agent) and freeform
   messages. Note highlights are local and never queue here. */
export function renderPills() {
  ui.pills.innerHTML = "";
  appState.queue.forEach(function (q, i) {
    var pill = document.createElement("span");
    pill.className = "pill";
    var targeted = !!(q.range || q.selector);
    var label = q.prompt || q.text || "";
    pill.innerHTML =
      (targeted ? '<span class="num">' + (i + 1) + "</span>" : "") +
      '<span class="txt">' + esc(label) + "</span>" +
      '<button class="x" title="Remove">&times;</button>';
    pill.querySelector(".x").addEventListener("click", function (e) { e.stopPropagation(); removeItem(i); });
    if (targeted) { pill.classList.add("clickable"); pill.title = "Jump to where this is on the page";
      pill.addEventListener("click", function () { scrollToItem(q); }); }
    ui.pills.appendChild(pill);
  });
  renderMarkers();
  renderHighlights();
}
// Scroll to (and flash) the spot a queued item targets - its comment anchor if it
// has one, else the resolved range/diagram element, else its selector.
export function scrollToItem(q) {
  var el = null;
  if (q.commentId) { var h = findHighlight(q.commentId); if (h) el = anchorFlashEl(h); }
  if (!el && q.range && q.range.container) { try { el = document.querySelector(q.range.container); } catch (e) {} }
  if (!el && q.target && q.target.src) el = resolveDiagramTarget(q.target);
  if (!el && q.selector) { try { el = document.querySelector(q.selector); } catch (e) {} }
  if (el) highlightNew([el]);
}
export function removeItem(i) {
  var q = appState.queue[i];
  appState.queue.splice(i, 1);
  // Un-sent card drafts mutated the thread when queued; undo that on removal.
  if (q && q.commentId) {
    var h = findHighlight(q.commentId);
    if (h) {
      if (q._edited && h.comments && q._idx < h.comments.length) {
        h.comments[q._idx] = q._prev;
        if (q._idx === h.comments.length - 1) h.prompt = h.comments[h.comments.length - 1];
        applyHighlights(); persistHighlights(); rebuildRail(true);
      } else if (q._appended && h.comments && h.comments.length > 1) {
        h.comments.pop();
        h.prompt = h.comments[h.comments.length - 1];
        applyHighlights(); persistHighlights(); rebuildRail(true);
      } else if (!q._edited && !q._appended) {
        // a brand-new anchor made just for this queued comment: drop it entirely.
        removeHighlight(h.id);
      } else {
        rebuildRail(true);
      }
    }
  }
  renderPills();
}
// Resolve a queued item's on-screen rectangles: text ranges are re-resolved
// from stored char offsets every time (so a morph that swaps the underlying
// text nodes can't strand a degenerate Range); element targets use their client
// rects. Coordinates are viewport (fixed) space, matching the overlay layers.
