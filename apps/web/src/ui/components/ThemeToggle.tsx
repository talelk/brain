import { Button } from "@talelk/newui-atoms";
import { currentTheme, setTheme } from "../theme";

export function ThemeToggle() {
  return <Button onClick={() => setTheme(currentTheme() === "dark" ? "light" : "dark")} class="min-h-11">Switch to {currentTheme() === "dark" ? "light" : "dark"} theme</Button>;
}
