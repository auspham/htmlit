import { VENDOR } from "./state.js";
import { root, ui } from "./dom.js";
import { renderMermaid } from "./render.js";

export var theme = localStorage.getItem("htmlit:theme") ||
  (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
export const hljsLink = document.createElement("link");
hljsLink.rel = "stylesheet";
hljsLink.id = "htmlit-hljs-theme";
hljsLink.setAttribute("data-htmlit", "");
document.head.appendChild(hljsLink);

export function applyTheme(t) {
  theme = t;
  root.setAttribute("data-theme", t);
  ui.theme.checked = t === "dark";
  document.documentElement.classList.toggle("dark", t === "dark");
  document.documentElement.setAttribute("data-theme", t);
  document.documentElement.style.colorScheme = t;
  hljsLink.href = t === "dark" ? VENDOR.hljsDark : VENDOR.hljsLight;
  localStorage.setItem("htmlit:theme", t);
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, theme: t === "dark" ? "dark" : "default", securityLevel: "loose" });
    renderMermaid(true);
  }
}
