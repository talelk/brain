import { render } from "solid-js/web";
import { UIProvider } from "@talelk/newui-atoms";
import { Toaster } from "@talelk/newui-molecules";
import { App } from "./app";
import { direction, loadLocale, locale } from "./i18n";
import "./lib/theme";
import "./index.css";

/** A page's code that is gone (the app was deployed again while this tab was open): load the new app once. */
window.addEventListener("vite:preloadError", () => { try { if (sessionStorage.getItem("brain.reloaded") === "1") return; sessionStorage.setItem("brain.reloaded", "1"); } catch { /* reload anyway */ } location.reload(); });
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
document.documentElement.lang = locale();
document.documentElement.dir = direction();
// The chosen language arrives before the first paint, so the page never flashes English first.
void loadLocale(locale()).catch(() => undefined).finally(() => {
  render(() => <UIProvider dir={direction()}><App /><Toaster /></UIProvider>, root);
  setTimeout(() => { try { sessionStorage.removeItem("brain.reloaded"); } catch { /* nothing to clear */ } }, 10_000);
});
