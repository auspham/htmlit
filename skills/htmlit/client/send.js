import { KEY, Presence, state as appState } from "./state.js";
import { ui } from "./dom.js";
import { api } from "./util.js";
import { addBubble, renderPills, setPresence } from "./chat.js";
import { domSnapshot } from "./content.js";
import { ceClear, ceText, rebuildRail } from "./rail.js";
import { applyHighlights, persistHighlights } from "./annotate.js";
import { setLastUserQuestion } from "./exporting.js";

export function send(endAfter) {
  if (appState.ended) return;
  var text = ceText(ui.input);
  if (text) {
    setLastUserQuestion(text);
    appState.queue.push({ selector: "", tag: "message", text: "Freeform message", prompt: text });
    addBubble("user", text);
    ceClear(ui.input);
    renderPills();
  }
  if (!appState.queue.length) {
    if (endAfter) endSession();
    else flashHint("Type a message or queue an annotation first.");
    return;
  }
  var prompts = appState.queue.map(function (q) {
    return {
      selector: q.selector || "",
      tag: q.tag,
      text: q.text,
      prompt: q.prompt || "",
      range: q.range || null,
      commentId: q.commentId || "",
    };
  });
  // Comments leave a persistent "you asked here" anchor once the send succeeds:
  // a text span (real <mark>) or a diagram node/edge (a re-resolvable box). Freeform
  // messages and plain non-diagram elements have neither, so they leave no anchor.
  var anchorItems = appState.queue.filter(function (q) { return q.prompt && ((q.range && q.range.container) || (q.target && q.target.src)); });
  api("/api/" + KEY + "/prompts", { prompts: prompts, domSnapshot: domSnapshot() })
    .then(function (r) {
      if (!r.ok) throw new Error("submit failed");
      return r.json().catch(function () { return {}; });
    })
    .then(function (res) {
      appState.queue.length = 0;
      if (anchorItems.length) {
        // Anchors were created/updated when each comment was queued; clearing the
        // Queue drops their draft state, so just refresh the rail styling.
        applyHighlights();
        persistHighlights();
        rebuildRail(true);
      }
      renderPills();
      if (res && res.agent_attached === false) {
        setPresence(Presence.WAITING);
        flashHint("Queued - no agent is polling yet. It'll be delivered when one connects.");
      } else {
        setPresence(Presence.WORKING);
      }
      if (endAfter) endSession();
    })
    .catch(function () { flashHint("Could not reach the htmlit daemon."); });
}
export function flashHint(msg) {
  ui.hint.textContent = msg;
  clearTimeout(flashHint._t);
  flashHint._t = setTimeout(function () { ui.hint.textContent = ""; }, 2600);
}
export function endSession() {
  if (appState.ended) return;
  api("/api/" + KEY + "/end", {}).catch(function () {});
}

/* annotation
   Google-Docs-style: in Annotation mode the user selects text (or clicks a
   diagram element, where text can't be selected) and a small floating menu
   offers Highlight (a note) or Comment (agent replies). Highlights are drawn
   as overlay rects that survive scroll/resize/morph; the artifact DOM is
   never mutated. */
