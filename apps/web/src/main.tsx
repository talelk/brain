import { render } from "solid-js/web";
import { UIProvider } from "@talelk/newui-atoms";
import { App } from "./app";
import "./ui/theme";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const dispose = render(() => <UIProvider dir="ltr"><App /></UIProvider>, root);
// Static-shell service worker; denied/failed registration is fine — the app
// simply runs without offline shell caching.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* shell remains fully network-served */ });
}
if (import.meta.hot) import.meta.hot.dispose(dispose);
