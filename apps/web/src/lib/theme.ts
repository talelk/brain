import { createColorScheme } from "@talelk/newui-atoms";
import { createRoot } from "solid-js";

/** Light, dark or the system's choice, remembered in this browser; the design system stamps `data-theme` on the document. */
const scheme = createRoot(() => createColorScheme({ storageKey: "brain.theme" }));
export const theme = scheme.colorScheme;
export const setTheme = scheme.setColorScheme;
