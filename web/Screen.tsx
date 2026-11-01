// A whole page outside Excalidraw (an empty folder, a canvas opening or that won't open), in its chrome.
import type { ReactNode } from "react";
import { prefs } from "./prefs.ts";

/** Not inside Excalidraw, so it takes the theme itself: the one the canvases were last shown in. */
export function Screen({ children }: { children: ReactNode }) {
  return <div className={`excalidraw ld-screen${prefs.theme() === "dark" ? " theme--dark" : ""}`}>{children}</div>;
}

export const OFFLINE = "Localidraw isn't running: start it again and this page reconnects";
/** The server is away: a banner at the top of a page outside Excalidraw. Over a canvas, it's a notice in the footer
 * instead (CanvasView), clear of the toolbar. */
export const Offline = () => <div className="ld-offline" role="status">{OFFLINE}.</div>;
