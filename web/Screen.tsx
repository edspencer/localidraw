// A whole page outside Excalidraw (an empty folder, a canvas opening or that won't open), in its chrome.
import type { ReactNode } from "react";
import { prefs } from "./prefs.ts";

/** Not inside Excalidraw, so it takes the theme itself: the one the canvases were last shown in. */
export function Screen({ children }: { children: ReactNode }) {
  return <div className={`excalidraw ld-screen${prefs.theme() === "dark" ? " theme--dark" : ""}`}>{children}</div>;
}
