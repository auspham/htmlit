import { Presence, state as appState } from "./state.js";

var faviconLink = null, faviconTimer = null, faviconAngle = 0, faviconKind = "";
export function faviconEl() {
  // Make ours the authoritative icon: drop any the artifact declares, keep one of ours.
  Array.prototype.slice.call(document.querySelectorAll('link[rel~="icon"]')).forEach(function (l) {
    if (l !== faviconLink && !l.hasAttribute("data-htmlit")) l.remove();
  });
  if (!faviconLink || !document.head.contains(faviconLink)) {
    faviconLink = document.createElement("link");
    faviconLink.rel = "icon";
    faviconLink.setAttribute("data-htmlit", "");
    document.head.appendChild(faviconLink);
  }
  return faviconLink;
}
export function faviconDataURL(kind, angle) {
  var s = 64, c = document.createElement("canvas"); c.width = s; c.height = s;
  var x = c.getContext("2d"); if (!x) return "";
  var cx = s / 2, cy = s / 2, r = 27;
  x.clearRect(0, 0, s, s);
  if (kind === "tick") {
    x.beginPath(); x.arc(cx, cy, r, 0, 2 * Math.PI); x.fillStyle = "#2ea043"; x.fill();
    x.strokeStyle = "#fff"; x.lineWidth = 7; x.lineCap = "round"; x.lineJoin = "round";
    x.beginPath(); x.moveTo(cx - 13, cy + 1); x.lineTo(cx - 3, cy + 12); x.lineTo(cx + 15, cy - 12); x.stroke();
  } else if (kind === "idle") {
    x.beginPath(); x.arc(cx, cy, r - 3, 0, 2 * Math.PI); x.lineWidth = 7; x.strokeStyle = "#8b949e"; x.stroke();
  } else { // spin-yellow | spin-green
    var col = kind === "spin-green" ? "#2ea043" : "#e3a008";
    x.beginPath(); x.arc(cx, cy, r - 4, 0, 2 * Math.PI); x.lineWidth = 8; x.strokeStyle = "rgba(140,140,150,.3)"; x.stroke();
    x.beginPath(); x.arc(cx, cy, r - 4, angle, angle + Math.PI * 1.5); x.lineWidth = 8; x.lineCap = "round"; x.strokeStyle = col; x.stroke();
  }
  try { return c.toDataURL("image/png"); } catch (e) { return ""; }
}
export function applyFavicon(kind) {
  var url = faviconDataURL(kind, faviconAngle);
  if (url) faviconEl().href = url;
}
export function stopFaviconAnim() { if (faviconTimer) { clearInterval(faviconTimer); faviconTimer = null; } }
export function setFaviconState(state) {
  var kind = state === "ended" ? "tick"
    : state === Presence.LISTENING ? "spin-yellow"
    : state === Presence.WORKING ? "spin-green"
    : "idle";
  if (kind === faviconKind && (faviconTimer || kind === "idle" || kind === "tick")) return;
  faviconKind = kind;
  stopFaviconAnim();
  applyFavicon(kind);
  if (kind === "spin-yellow" || kind === "spin-green") {
    faviconTimer = setInterval(function () { faviconAngle += 0.34; applyFavicon(kind); }, 90);
  }
}
export function refreshFavicon() { setFaviconState(appState.ended ? "ended" : appState.presence); }
