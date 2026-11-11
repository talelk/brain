import { render } from "solid-js/web";
import { UIProvider } from "@talelk/newui-atoms";
import { App } from "./app";
import "./ui/theme";
import "./index.css";
import { listenForInstall } from "./ui/install";

listenForInstall();
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
/**
 * Reading direction: `?dir=rtl` or `?dir=ltr` forces it (remembered in localStorage under
 * `brain.dir`); otherwise a right-to-left browser language (Arabic, Hebrew, Persian, Urdu) selects RTL.
 */
function readingDirection(): "ltr" | "rtl" {
  try {
    const forced = new URLSearchParams(location.search).get("dir");
    if (forced === "rtl" || forced === "ltr") { localStorage.setItem("brain.dir", forced); return forced; }
    const saved = localStorage.getItem("brain.dir");
    if (saved === "rtl" || saved === "ltr") return saved;
  } catch { /* storage blocked: fall through to the language */ }
  return /^(ar|he|fa|ur)\b/i.test(navigator.language) ? "rtl" : "ltr";
}
const dir = readingDirection();
document.documentElement.dir = dir;
const dispose = render(() => <UIProvider dir={dir}><App /></UIProvider>, root);
// Static-shell service worker; denied/failed registration is fine — the app
// simply runs without offline shell caching.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* shell remains fully network-served */ });
}
if (import.meta.hot) import.meta.hot.dispose(dispose);
