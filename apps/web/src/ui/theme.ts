import { createColorScheme } from "@talelk/newui-atoms";
import { createEffect, createRoot } from "solid-js";

const controller = createRoot(() => {
  const scheme = createColorScheme({ storageKey: "brain-theme" });
  createEffect(() => {
    document.documentElement.style.colorScheme = scheme.resolved();
  });
  return scheme;
});

export const currentTheme = controller.resolved;
export const setColorScheme = controller.setColorScheme;
