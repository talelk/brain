import { Dropdown } from "@talelk/newui-molecules";
import { currentTheme, setColorScheme } from "../theme";

const OPTIONS = ["light", "dark", "system"] as const;

/** The one theme control (header); renders the current scheme with Light/Dark/System options. */
export function ThemeToggle() {
  return <Dropdown aria-label="Choose theme" class="justify-start" options={OPTIONS.map((scheme) => ({ value: scheme, label: scheme === "light" ? "Light" : scheme === "dark" ? "Dark" : "System", icon: scheme === "light" ? "lucide-sun" : scheme === "dark" ? "lucide-moon" : "lucide-monitor" }))}
    onSelect={(value) => { if (value === "light" || value === "dark" || value === "system") void setColorScheme(value); }}>
    <span class="flex min-w-0 items-center gap-2"><span class={`${currentTheme() === "dark" ? "lucide-moon" : "lucide-sun"} size-4 shrink-0`} aria-hidden="true" /><span class="truncate">{currentTheme() === "dark" ? "Dark" : "Light"} theme</span></span>
  </Dropdown>;
}
