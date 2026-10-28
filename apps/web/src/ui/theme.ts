import { createSignal } from "solid-js";

type Theme = "light" | "dark";
const [theme, update] = createSignal<Theme>("light");
export const currentTheme = theme;

export function setTheme(value: Theme): void {
  update(value); document.documentElement.dataset["theme"] = value;
  document.documentElement.style.colorScheme = value;
  try { localStorage.setItem("brain-theme", value); } catch { /* preference only */ }
}

export function initializeTheme(): () => void {
  const media = matchMedia("(prefers-color-scheme: dark)");
  let stored: string | null = null;
  try { stored = localStorage.getItem("brain-theme"); } catch { /* preference only */ }
  const initial: Theme = stored === "light" || stored === "dark" ? stored : media.matches ? "dark" : "light";
  update(initial); document.documentElement.dataset["theme"] = initial; document.documentElement.style.colorScheme = initial;
  const changed = () => {
    let preference: string | null = null;
    try { preference = localStorage.getItem("brain-theme"); } catch { /* preference only */ }
    if (!preference) { const next = media.matches ? "dark" : "light"; update(next); document.documentElement.dataset["theme"] = next; document.documentElement.style.colorScheme = next; }
  };
  media.addEventListener("change", changed);
  return () => media.removeEventListener("change", changed);
}
