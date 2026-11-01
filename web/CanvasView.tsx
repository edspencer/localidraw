// One canvas: Excalidraw on a .excalidraw file, saving as you draw and merging changes made on disk.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CaptureUpdateAction, convertToExcalidrawElements, DefaultSidebar, Excalidraw, Footer, MainMenu, Sidebar, getCommonBounds, restoreAppState, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { getCanvas, putCanvas, type Loaded } from "./api.ts";
import { changedSince, mergeScenes, versionsOf } from "./merge.ts";
import { FoldersIcon } from "./icons.tsx";
import { prefs } from "./prefs.ts";

const SAVE_AFTER_MS = 700;

/**
 * A handle for the browser tests (e2e/), so they wait on real state instead of sleeping: the open canvas's
 * Excalidraw API, whether a save is due or in flight, and Excalidraw's skeleton converter (which can't run in Node)
 * so a test can write the kind of elements a coding agent would. Nothing in the page reads it.
 */
export type TestHandle = {
  path: string;
  api: ExcalidrawImperativeAPI;
  /**
   * The autosave: "due" from a change until its save starts, "saving" until it's done, else "idle"; how many times
   * it has checked for changes, and how many of those wrote the file.
   */
  saves: () => { state: "idle" | "due" | "saving"; checked: number; written: number };
  convertToExcalidrawElements: typeof convertToExcalidrawElements;
};
declare global { interface Window { localidraw?: TestHandle } }

/**
 * Shows the whole drawing in the part of the canvas you can see. Excalidraw's own fit (scrollToContent with
 * fitToViewport) uses the full width, so a docked sidebar covers the right of the drawing.
 */
function fitToView(api: ExcalidrawImperativeAPI) {
  const elements = api.getSceneElements();
  if (!elements.length) return;
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const { width, height } = api.getAppState();
  // Docked or floating, an open sidebar covers the canvas from its left edge on.
  const sidebar = document.querySelector<HTMLElement>(".excalidraw .sidebar");
  const visible = sidebar ? Math.min(width, sidebar.getBoundingClientRect().left) : width;
  const zoom = Math.min(1, Math.max(0.1, 0.9 * Math.min(visible / (maxX - minX), height / (maxY - minY))));
  api.updateScene({
    appState: {
      zoom: { value: zoom as AppState["zoom"]["value"] },
      scrollX: visible / (2 * zoom) - (minX + maxX) / 2,
      scrollY: height / (2 * zoom) - (minY + maxY) / 2,
    },
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}
export const CANVASES_TAB = "canvases";

type Props = {
  path: string;
  sidebar: ReactNode; // the Canvases tab's contents
  /** Called with a function to run when the file changes on disk (its new content hash). */
  onDiskChange: (handler: (hash: string) => void) => void;
};

export function CanvasView({ path, sidebar, onDiskChange }: Props) {
  const [initial, setInitial] = useState<any>(null);
  const [status, setStatus] = useState("");
  const [docked, setDocked] = useState(prefs.docked());
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  // What the screen and the file last agreed on: the file's hash, each element's version, the background.
  const sync = useRef({ hash: "", base: new Map<string, number>(), background: "", timer: undefined as any, saving: false, again: false, checked: 0, written: 0 });

  /** The file's newer state onto the screen, keeping what was drawn here since. */
  const absorb = useCallback((loaded: Loaded) => {
    const s = sync.current;
    const remote = restoreElements(loaded.scene.elements, null);
    const ex = api.current;
    if (ex) {
      const files = Object.values(loaded.scene.files ?? {});
      if (files.length) ex.addFiles(files);
      ex.updateScene({ elements: mergeScenes(ex.getSceneElementsIncludingDeleted(), remote, s.base), captureUpdate: CaptureUpdateAction.NEVER });
    }
    s.hash = loaded.hash;
    s.base = versionsOf(remote);
    s.background = restoreAppState(loaded.scene.appState as Partial<AppState>, null).viewBackgroundColor;
  }, []);

  const save = useCallback(async (): Promise<void> => {
    const s = sync.current, ex = api.current;
    if (!ex) return;
    if (s.saving) { s.again = true; return; }
    const elements = ex.getSceneElementsIncludingDeleted();
    const appState = ex.getAppState();
    s.checked++;
    if (!changedSince(elements, s.base) && appState.viewBackgroundColor === s.background) return;
    s.saving = true;
    setStatus("Saving…");
    try {
      const result = await putCanvas(path, s.hash, serializeAsJSON(elements, appState, ex.getFiles(), "local"));
      if (!result.ok) {
        absorb(result.conflict);
        s.again = true; // save the merge
        return;
      }
      s.hash = result.hash;
      s.written++;
      s.base = versionsOf(elements);
      s.background = appState.viewBackgroundColor;
      setStatus(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } catch (err) {
      setStatus(`Not saved: ${err instanceof Error ? err.message : err}`);
    } finally {
      s.saving = false;
      if (s.again) { s.again = false; void save(); }
    }
  }, [path, absorb]);

  useEffect(() => {
    let live = true;
    getCanvas(path).then((loaded) => {
      if (!live) return;
      const s = sync.current;
      const elements = restoreElements(loaded.scene.elements, null);
      s.hash = loaded.hash;
      s.base = versionsOf(elements);
      s.background = restoreAppState(loaded.scene.appState as Partial<AppState>, null).viewBackgroundColor;
      const view = prefs.viewport(path);
      setInitial({
        elements,
        files: loaded.scene.files ?? {},
        fit: !view && elements.some((e) => !e.isDeleted), // fitting an empty canvas zooms in absurdly
        appState: { ...loaded.scene.appState, ...(view ?? {}), theme: prefs.theme(), openSidebar: prefs.openSidebar() },
      });
    }).catch((err) => setStatus(`Couldn't open it: ${err.message}`));

    onDiskChange(async (hash) => {
      if (hash === sync.current.hash) return; // our own save
      const loaded = await getCanvas(path).catch(() => null);
      if (!loaded || loaded.hash === sync.current.hash) return;
      absorb(loaded);
      setStatus("Updated from disk");
    });
    const saveNow = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(sync.current.timer);
        sync.current.timer = undefined;
        void save();
      }
    };
    window.addEventListener("keydown", saveNow, true);
    return () => {
      live = false;
      window.removeEventListener("keydown", saveNow, true);
      clearTimeout(sync.current.timer);
      sync.current.timer = undefined;
      if (window.localidraw?.path === path) delete window.localidraw;
      void save(); // switching canvases: keep what was drawn
    };
  }, [path]);

  const onChange = useCallback((_elements: unknown, appState: AppState) => {
    prefs.remember(path, appState);
    clearTimeout(sync.current.timer);
    sync.current.timer = setTimeout(() => { sync.current.timer = undefined; void save(); }, SAVE_AFTER_MS);
  }, [path, save]);

  if (!initial) return <div className="ld-loading">{status || "Opening…"}</div>;
  return (
    <Excalidraw
      initialData={initial}
      excalidrawAPI={(a) => {
        api.current = a;
        const s = sync.current;
        window.localidraw = { path, api: a, convertToExcalidrawElements, saves: () => ({
          state: s.saving || s.again ? "saving" : s.timer !== undefined ? "due" : "idle", checked: s.checked, written: s.written,
        }) };
        // The first time a canvas is opened here, show all of it; after that, where you left it.
        if (initial.fit) setTimeout(() => fitToView(a), 300);
      }}
      onChange={onChange}
      name={path.split("/").pop()?.replace(/\.excalidraw$/, "")}
      // The page is all canvas, so shortcuts work wherever the focus is (Excalidraw still skips text fields).
      handleKeyboardGlobally
      // It saves to this file only: no "open" or "save to" that would leave the file behind.
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false }, dockedSidebarBreakpoint: 0 }}
      renderTopRightUI={() => (
        <DefaultSidebar.Trigger tab={CANVASES_TAB} icon={FoldersIcon} title="Canvases">Canvases</DefaultSidebar.Trigger>
      )}
    >
      <MainMenu>
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ToggleTheme />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
      <DefaultSidebar docked={docked} onDock={(d) => { prefs.setDocked(d); setDocked(d); }}>
        <DefaultSidebar.TabTriggers>
          <Sidebar.TabTrigger tab={CANVASES_TAB}>{FoldersIcon}</Sidebar.TabTrigger>
        </DefaultSidebar.TabTriggers>
        <Sidebar.Tab tab={CANVASES_TAB}>{sidebar}</Sidebar.Tab>
      </DefaultSidebar>
      <Footer>
        <div className="ld-status" title={status}>{status}</div>
      </Footer>
    </Excalidraw>
  );
}
