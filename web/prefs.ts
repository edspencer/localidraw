// What the browser remembers between visits; none of it goes in the canvas files. (The Library too, unless the folder
// has a library.excalidrawlib.)
import type { AppState } from "@excalidraw/excalidraw/types";

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(`localidraw:${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => localStorage.setItem(`localidraw:${key}`, JSON.stringify(value));

type Viewport = { scrollX: number; scrollY: number; zoom: AppState["zoom"] };
let last = "";

export const prefs = {
  viewport: (path: string) => read<Viewport | null>(`viewport:${path}`, null),
  theme: () => read<AppState["theme"]>("theme", "light"),
  docked: () => read("docked", true),
  setDocked: (docked: boolean) => write("docked", docked),
  /** The Library, when the folder has no library.excalidrawlib to keep it in (web/library.ts). */
  library: () => read<unknown[]>("library", []),
  setLibrary: (items: unknown) => write("library", items),
  // Open on the Canvases tab the first time.
  openSidebar: () => read<AppState["openSidebar"]>("openSidebar", { name: "default", tab: "canvases" }),
  /** Keeps the viewport per canvas, and the theme and sidebar for all of them, as they change. */
  remember(path: string, s: AppState) {
    const now = JSON.stringify([path, s.scrollX, s.scrollY, s.zoom.value, s.theme, s.openSidebar]);
    if (now === last) return;
    last = now;
    write(`viewport:${path}`, { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom });
    write("theme", s.theme);
    write("openSidebar", s.openSidebar);
  },
};
