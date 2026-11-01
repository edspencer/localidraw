// The canvases: one Excalidraw, showing one .excalidraw file at a time, saving as you draw and merging changes made
// on disk. Switching canvases swaps the scene in the same Excalidraw, rather than mounting a new one.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CaptureUpdateAction, convertToExcalidrawElements, DefaultSidebar, Excalidraw, FONT_FAMILY, Footer, MainMenu, Sidebar, getCommonBounds, restoreAppState, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { getCanvas, NO_FILE, putCanvas, type Loaded } from "./api.ts";
import { changedSince, mergeScenes, versionsOf } from "./merge.ts";
import { CloseIcon, FoldersIcon } from "./icons.tsx";
import { library } from "./library.ts";
import { prefs } from "./prefs.ts";
import { Offline, OFFLINE, Screen } from "./Screen.tsx";

const SAVE_AFTER_MS = 700;

/**
 * A file's elements as Excalidraw's own, with each text's size measured again: an agent that guessed a text's width
 * too small would otherwise have it clipped. That changes no version, so opening still never writes.
 */
const restore = (elements: Loaded["scene"]["elements"]) => restoreElements(elements, null, { repairBindings: true, refreshDimensions: true });

const FONT_NAMES = new Map<number, string>(Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]));

/**
 * Loads the fonts a scene's text is in (Excalidraw registers them once it's mounted, and loads one only when it first
 * draws it), so that measuring the text uses them rather than a fallback. Never waits more than 2 s.
 */
function fontsFor(elements: readonly any[]): Promise<unknown> {
  const wanted = new Map<string, string>(); // font → the text in it, so the right subsets (CJK, say) load too
  for (const e of elements) {
    const name = e?.type === "text" && FONT_NAMES.get(e.fontFamily);
    if (name && typeof e.text === "string") wanted.set(`20px "${name}", Xiaolai`, (wanted.get(`20px "${name}", Xiaolai`) ?? "") + e.text);
  }
  if (!wanted.size) return Promise.resolve();
  const loads = [...wanted].map(([font, text]) => document.fonts.load(font, text).catch(() => {}));
  return Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, 2000))]);
}
const RETRY_AFTER_MS = 2000; // a canvas you've left that couldn't be saved (the server was down, say)

/**
 * A handle for the browser tests (e2e/), so they wait on real state instead of sleeping: the open canvas's
 * Excalidraw API, whether a save is due or in flight, and Excalidraw's skeleton converter (which can't run in Node)
 * so a test can write the kind of elements a coding agent would. Nothing in the page reads it.
 */
export type TestHandle = {
  path: string;
  api: ExcalidrawImperativeAPI;
  /**
   * The open canvas's autosave: "due" from a change until its save starts, "saving" until it's done, else "idle";
   * how many times it has checked for changes, and how many of those wrote the file. `leaving` counts the canvases
   * switched away from whose last save isn't done yet.
   */
  saves: () => { state: "idle" | "due" | "saving"; checked: number; written: number; leaving: number };
  /** The ids of the items in Excalidraw's Library (web/library.ts). */
  library: () => string[];
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

type Scene = { elements: readonly ExcalidrawElement[]; appState: AppState; files: BinaryFiles };

/**
 * One canvas's link to its file: what the screen and the file last agreed on (the file's hash, each element's
 * version, the background), and its autosave. It outlives the canvas on screen until its last save is done.
 */
type Session = {
  path: string;
  hash: string;
  base: Map<string, number>;
  background: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  saving: boolean;
  again: boolean;
  checked: number;
  written: number;
  /** Once you've switched away: the scene as it was then, which the last save writes (and a 409 merges into). */
  left?: Scene;
  /** Its file was deleted or moved on disk, and no move was found to follow: it isn't saved until it's put back. */
  gone?: boolean;
};

/** The parts of a file's appState that belong to the canvas (Excalidraw's own export keeps these). */
const canvasAppState = (scene: Loaded["scene"]) => {
  const a = restoreAppState(scene.appState as Partial<AppState>, null);
  return { viewBackgroundColor: a.viewBackgroundColor, gridSize: a.gridSize, gridStep: a.gridStep, gridModeEnabled: a.gridModeEnabled };
};

/** What a canvas swapped in mustn't inherit from the one before: a selection, a half-made element, a menu. */
const FRESH = {
  selectedElementIds: {}, selectedGroupIds: {}, editingGroupId: null, hoveredElementIds: {}, selectedLinearElement: null,
  editingLinearElement: null, editingTextElement: null, newElement: null, multiElement: null, croppingElementId: null,
  contextMenu: null, openPopup: null,
} satisfies Partial<AppState>;

type Props = {
  path: string;
  sidebar: ReactNode; // the Canvases tab's contents
  offline: boolean; // the server is away
  /**
   * Called with a function to run when a canvas changes on disk: its path and new content hash; its path and null
   * when it's gone (deleted, or moved); or (null, null) when the open one may have changed unannounced (the server
   * was away).
   */
  onDiskChange: (handler: (path: string | null, hash: string | null) => void) => void;
  /** The open canvas was moved on disk, and followed: the page's URL goes with it. */
  onMoved: (from: string, to: string) => void;
  /**
   * Called with what the page can ask of the canvases: `release` waits until a canvas's saves have all landed, and
   * `follow` points a canvas at the path it was renamed or moved to, keeping it on screen as it is (and its undo).
   */
  control: (c: Control) => void;
};

export type Control = { release: (path: string) => Promise<void>; follow: (from: string, to: string) => void };

const RELEASE_TIMEOUT_MS = 5000;
/** A canvas that arrives this close to the open one going, with the same content, is where it was moved to. */
const MOVE_WINDOW_MS = 5000;

export function CanvasView({ path, sidebar, offline, onDiskChange, onMoved, control }: Props) {
  // The scene Excalidraw mounts with. Later canvases are swapped into the same Excalidraw.
  const [initial, setInitial] = useState<any>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState<{ path: string; message: string; retries: boolean } | null>(null);
  const [docked, setDocked] = useState(prefs.docked());
  const [shown, setShown] = useState(path);
  const [lost, setLost] = useState<{ ids: string[] } | null>(null); // edits here that lost to a change on disk
  const [gone, setGone] = useState(false); // the canvas on screen was deleted or moved on disk
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const current = useRef<Session | null>(null); // the canvas on screen
  const leaving = useRef(new Map<string, Session>()); // canvases switched away from, until their last save is done
  const announced = useRef(new Map<string, string | null>()); // changes on disk heard while a canvas was loading
  // The other canvases changed on disk a moment ago, by content hash: where the open one went, if it was moved.
  const arrived = useRef(new Map<string, { path: string; at: number }>());
  const movedRef = useRef(onMoved);
  movedRef.current = onMoved;

  const isCurrent = (s: Session) => current.current === s;

  /** The file's newer state into the canvas (on screen, or as it was left), keeping what was drawn here since. */
  const absorb = useCallback((s: Session, loaded: Loaded) => {
    const remote = restore(loaded.scene.elements);
    const ex = api.current;
    if (s.left) {
      s.left = { ...s.left, elements: mergeScenes(s.left.elements, remote, s.base).elements, files: { ...s.left.files, ...(loaded.scene.files ?? {}) } };
    } else if (ex && isCurrent(s)) {
      const files = Object.values(loaded.scene.files ?? {});
      if (files.length) ex.addFiles(files);
      const { elements, replaced } = mergeScenes(ex.getSceneElementsIncludingDeleted(), remote, s.base);
      ex.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
      remeasure(s);
      // The same element was changed here and on disk, and the disk's change won: say so, quietly.
      if (replaced.length) setLost((was) => ({ ids: [...new Set([...(was?.ids ?? []), ...replaced])] }));
    }
    s.hash = loaded.hash;
    s.base = versionsOf(remote);
    s.background = canvasAppState(loaded.scene).viewBackgroundColor;
  }, []);

  const save = useCallback(async (s: Session): Promise<void> => {
    if (s.saving) { s.again = true; return; }
    if (s.gone) { s.checked++; return; } // not saved until it's followed, comes back, or is put back
    const ex = api.current;
    const scene: Scene | null = s.left ?? (ex && isCurrent(s)
      ? { elements: ex.getSceneElementsIncludingDeleted(), appState: ex.getAppState(), files: ex.getFiles() }
      : null);
    if (!scene) return;
    const done = () => { if (s.left && leaving.current.get(s.path) === s) leaving.current.delete(s.path); };
    s.checked++;
    if (!changedSince(scene.elements, s.base) && scene.appState.viewBackgroundColor === s.background) return done();
    s.saving = true;
    if (isCurrent(s)) setStatus("Saving…");
    let retry = false;
    const at = s.path;
    try {
      const result = await putCanvas(at, s.hash, serializeAsJSON(scene.elements, scene.appState, scene.files, "local"));
      if (!result.ok && "gone" in result) {
        // Renamed from the sidebar while this was on its way: save again, at the new path.
        if (s.path !== at) s.again = true;
        else lose(s);
        return;
      }
      if (!result.ok) {
        absorb(s, result.conflict);
        // Merged: if that left anything of ours to save, the next save says "Saving…" again.
        if (isCurrent(s)) setStatus("Updated from disk");
        s.again = true; // save the merge
        return;
      }
      s.hash = result.hash;
      s.written++;
      s.base = versionsOf(scene.elements);
      s.background = scene.appState.viewBackgroundColor;
      if (isCurrent(s)) setStatus(`Saved ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (isCurrent(s)) setStatus(why ? `Not saved: ${why}` : "Not saved");
      // On screen, the next change (or status re-render) tries again; a canvas you've left has to try by itself.
      retry = !!s.left;
    } finally {
      s.saving = false;
      if (s.again) { s.again = false; void save(s); }
      else if (retry) s.timer = setTimeout(() => { s.timer = undefined; if (s.left) void save(s); }, RETRY_AFTER_MS);
      else done();
    }
  }, [absorb]);

  /**
   * Measures the text on screen again once its fonts are in, for text an agent sized too small (restore, above). It
   * changes no version, so nothing is saved for it; the right size goes in the file with the next edit.
   */
  const remeasure = (s: Session) => {
    const ex = api.current;
    if (!ex) return;
    void fontsFor(ex.getSceneElements()).then(() => {
      if (!isCurrent(s) || api.current !== ex) return;
      const elements = ex.getSceneElementsIncludingDeleted();
      const measured = restore(elements as any);
      const resized = measured.some((e, i) => e.type === "text" && (e.width !== elements[i].width || e.height !== elements[i].height));
      if (resized) ex.updateScene({ elements: measured, captureUpdate: CaptureUpdateAction.NEVER });
    });
  };

  /** Points a canvas at the path its file was renamed or moved to, keeping it on screen as it is (and its undo). */
  const retarget = (s: Session, to: string) => {
    const from = s.path;
    s.path = to;
    if (!isCurrent(s)) return;
    if (s.gone) {
      s.gone = false;
      setGone(false);
      void save(s); // whatever was drawn while it seemed gone
    }
    setShown(to);
    if (api.current) expose(api.current);
    movedRef.current(from, to);
  };

  /**
   * The canvas's file is gone from its path. If a canvas just arrived with the same content, it was moved: follow it.
   * Otherwise it was deleted, and the one on screen says so and waits to be put back. One you've left is dropped.
   */
  function lose(s: Session) {
    if (s.left) {
      if (leaving.current.get(s.path) === s) leaving.current.delete(s.path);
      return;
    }
    if (!isCurrent(s)) return;
    const twin = arrived.current.get(s.hash);
    if (twin && twin.path !== s.path && Date.now() - twin.at < MOVE_WINDOW_MS) return retarget(s, twin.path);
    s.gone = true;
    clearTimeout(s.timer);
    s.timer = undefined;
    setGone(true);
    setStatus("Not saved");
  }

  /** Writes the canvas on screen back at its path, after it was deleted there: all of it, as if new. */
  const putBack = () => {
    const s = current.current;
    if (!s?.gone) return;
    s.gone = false;
    s.hash = NO_FILE;
    s.base = new Map();
    s.background = "";
    setGone(false);
    void save(s);
  };

  /** Takes the canvas on screen off it: its scene as it is now goes with it, saved if it changed. */
  const leave = useCallback(() => {
    const s = current.current, ex = api.current;
    if (!s) return;
    current.current = null;
    clearTimeout(s.timer);
    s.timer = undefined;
    if (s.gone) return; // nowhere to save it
    if (ex) s.left = { elements: ex.getSceneElementsIncludingDeleted(), appState: ex.getAppState(), files: ex.getFiles() };
    if (!s.left) return;
    leaving.current.set(s.path, s);
    void save(s);
  }, [save]);

  /** Fetches the open canvas from disk and merges it in, unless it's the version on screen. */
  const catchUp = useCallback(async (s: Session, hash: string | null) => {
    if (hash !== null && hash === s.hash) return; // our own save
    const at = s.path;
    const loaded = await getCanvas(at).catch((err) => {
      if (err.status === 404 && isCurrent(s) && s.path === at) lose(s);
      return null;
    });
    if (!loaded || !isCurrent(s) || loaded.hash === s.hash) return;
    absorb(s, loaded);
    setStatus("Updated from disk");
  }, [absorb]);

  /** Puts a canvas on screen: in the Excalidraw that's there, or by mounting the first. */
  const show = useCallback((p: string, loaded: Loaded | null) => {
    leave();
    setFailed(null);
    setStatus("");
    setLost(null);
    setGone(false);
    // A canvas left a moment ago whose save isn't done is picked up where it was, rather than read from disk.
    const resumed = leaving.current.get(p);
    if (!resumed?.left && !loaded) return;
    let s: Session, scene: { elements: readonly ExcalidrawElement[]; files: BinaryFiles; appState: ReturnType<typeof canvasAppState> };
    if (resumed?.left) {
      s = resumed;
      leaving.current.delete(p);
      const left = s.left!;
      s.left = undefined;
      clearTimeout(s.timer);
      s.timer = undefined;
      const { viewBackgroundColor, gridSize, gridStep, gridModeEnabled } = left.appState;
      scene = { elements: left.elements, files: left.files, appState: { viewBackgroundColor, gridSize, gridStep, gridModeEnabled } };
    } else {
      const elements = restore(loaded!.scene.elements);
      s = { path: p, hash: loaded!.hash, base: versionsOf(elements), background: canvasAppState(loaded!.scene).viewBackgroundColor,
        timer: undefined, saving: false, again: false, checked: 0, written: 0 };
      scene = { elements, files: loaded!.scene.files ?? {}, appState: canvasAppState(loaded!.scene) };
    }
    current.current = s;
    setShown(p);
    const view = prefs.viewport(p);
    // The first time a canvas is opened here, show all of it; after that, where you left it. Fitting an empty canvas
    // zooms in absurdly, so that one starts at the origin.
    const fit = !view && scene.elements.some((e) => !e.isDeleted);
    const ex = api.current;
    if (!ex) {
      setInitial({ elements: scene.elements, files: scene.files, fit,
        appState: { ...scene.appState, ...(view ?? {}), theme: prefs.theme(), openSidebar: prefs.openSidebar() } });
    } else {
      const files = Object.values(scene.files);
      if (files.length) ex.addFiles(files);
      ex.updateScene({
        elements: scene.elements,
        appState: { ...FRESH, ...scene.appState, ...(view ?? { scrollX: 0, scrollY: 0, zoom: { value: 1 as AppState["zoom"]["value"] } }) },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      ex.history.clear(); // undo stays on the canvas it was done on
      expose(ex);
      remeasure(s);
      if (fit) fitToView(ex);
    }
    if (resumed) void catchUp(s, null); // it may have changed on disk while it was off screen
    else if (announced.current.has(p)) void catchUp(s, announced.current.get(p)!);
    announced.current.clear();
  }, [leave, catchUp]);

  const expose = (a: ExcalidrawImperativeAPI) => {
    const s = current.current;
    if (!s) return;
    window.localidraw = { path: s.path, api: a, convertToExcalidrawElements, saves: () => ({
      state: s.saving || s.again ? "saving" : s.timer !== undefined ? "due" : "idle", checked: s.checked, written: s.written,
      leaving: leaving.current.size,
    }), library: library.ids };
  };

  // Each time the URL names another canvas: load it, then show it. Until then, the one before stays on screen.
  useEffect(() => {
    let live = true;
    const load = () => {
      if (current.current?.path === path) return; // followed here by a rename: it's on screen already
      if (leaving.current.get(path)?.left) return show(path, null); // left a moment ago: picked up as it was
      getCanvas(path).then((loaded) => {
        if (live) show(path, loaded);
      }).catch((err) => {
        if (!live) return;
        leave();
        api.current = null; // the screen below unmounts Excalidraw; the next canvas mounts a new one
        setInitial(null);
        if (window.localidraw) delete window.localidraw;
        setFailed({ path, message: err.message, retries: err.status !== 400 });
      });
    };
    load();
    onDiskChange((p, hash) => {
      if (!live) return;
      if (p !== null && p !== path) {
        // Another canvas; any left one finds out when it saves (409). One that arrives with the content of the canvas
        // on screen may be where it was moved to.
        if (hash === null) return;
        arrived.current.delete(hash);
        arrived.current.set(hash, { path: p, at: Date.now() });
        if (arrived.current.size > 50) arrived.current.delete(arrived.current.keys().next().value!);
        const s = current.current;
        if (s?.gone && s.hash === hash) retarget(s, p);
        return;
      }
      const s = current.current;
      if (!s || s.path !== path) {
        // Still loading, or failed: hear it once it's open, or try again (it may be made, or mended, on disk now).
        if (failedRef.current) return void load();
        announced.current.set(path, hash);
        return;
      }
      if (p !== null && hash === null) return lose(s); // deleted, or moved
      if (s.gone && hash !== null) {
        // It's back (a checkout, an undo): take what's there, then save what was drawn meanwhile.
        s.gone = false;
        setGone(false);
        void catchUp(s, hash).then(() => save(s));
        return;
      }
      void catchUp(s, hash);
    });
    return () => { live = false; };
  }, [path]);

  // Before a canvas is renamed, moved or deleted, whatever was drawn on it is saved first, so it goes with the file
  // and no save lands at the old path afterwards.
  control({
    release: async (p) => {
      const until = Date.now() + RELEASE_TIMEOUT_MS;
      let checked = false;
      for (;;) {
        const s = current.current?.path === p ? current.current : leaving.current.get(p);
        if (!s) return;
        if (!checked || s.timer !== undefined) {
          checked = true;
          clearTimeout(s.timer);
          s.timer = undefined;
          void save(s);
        }
        if (!s.saving && !s.again && s.timer === undefined && !leaving.current.has(p)) return;
        if (Date.now() > until) throw new Error("It couldn't be saved first, so it was left as it is.");
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    follow: (from, to) => {
      const s = current.current;
      if (s?.path === from) retarget(s, to);
    },
  });

  // ⌘S saves the open canvas at once; leaving the page (or this view) saves it too.
  useEffect(() => {
    const saveNow = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        const s = current.current;
        if (!s) return;
        clearTimeout(s.timer);
        s.timer = undefined;
        void save(s);
      }
    };
    window.addEventListener("keydown", saveNow, true);
    return () => {
      window.removeEventListener("keydown", saveNow, true);
      leave();
      delete window.localidraw;
    };
  }, []);

  const onChange = useCallback((_elements: unknown, appState: AppState) => {
    const s = current.current;
    if (!s) return;
    prefs.remember(s.path, appState);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = undefined; void save(s); }, SAVE_AFTER_MS);
  }, [save]);

  /** Selects the elements whose edit was replaced, and brings them into view. */
  const showLost = (ids: string[]) => {
    const ex = api.current;
    if (!ex) return;
    const wanted = new Set(ids);
    const elements = ex.getSceneElements().filter((e) => wanted.has(e.id));
    if (!elements.length) return setLost(null); // gone since
    ex.updateScene({ appState: { selectedElementIds: Object.fromEntries(elements.map((e) => [e.id, true])) }, captureUpdate: CaptureUpdateAction.NEVER });
    ex.scrollToContent(elements, { animate: true });
  };

  if (failed) {
    return (
      <Screen>
        {offline && <Offline />}
        <div className="Island ld-screen__island ld-screen__island--canvases">
          <h1>Couldn't open {failed.path}</h1>
          <p>
            {failed.message}
            {failed.retries && " It opens here as soon as the file is there and valid."}
          </p>
          {sidebar}
        </div>
      </Screen>
    );
  }
  if (!initial) return <Screen>{offline && <Offline />}<span className="ld-loading">Opening…</span></Screen>;
  return (
    <Excalidraw
      initialData={initial}
      excalidrawAPI={(a) => {
        api.current = a;
        expose(a);
        // Once the first canvas is in it (not yet, as it calls this).
        setTimeout(() => { if (current.current) remeasure(current.current); });
        void library.attach(a);
        if (initial.fit) setTimeout(() => fitToView(a), 300);
      }}
      onChange={onChange}
      onLibraryChange={library.changed}
      name={shown.split("/").pop()?.replace(/\.excalidraw$/, "")}
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
        {offline && (
          <div className="ld-notice ld-notice--offline" role="status"><span className="ld-notice__text">{OFFLINE}</span></div>
        )}
        {gone && (
          <div className="ld-notice" role="status">
            <span className="ld-notice__text">This canvas was deleted or moved on disk</span>
            <button type="button" className="ld-notice__action" onClick={putBack}>Save it again</button>
          </div>
        )}
        {lost && (
          <div className="ld-notice" role="status">
            <span className="ld-notice__text">
              {lost.ids.length === 1 ? "An edit of yours was" : `${lost.ids.length} edits of yours were`} replaced by a change on disk
            </span>
            <button type="button" className="ld-notice__action" onClick={() => showLost(lost.ids)}>Show</button>
            <button type="button" className="ld-notice__close" aria-label="Dismiss" title="Dismiss" onClick={() => setLost(null)}>{CloseIcon}</button>
          </div>
        )}
      </Footer>
    </Excalidraw>
  );
}
