// The page: which canvas is open (in the URL), the projects list, and the connection to the server's events.
import { useCallback, useEffect, useRef, useState } from "react";
import { createCanvas, getProjects, moveCanvas, restoreCanvas, trashCanvas, type Project } from "./api.ts";
import { CanvasesTab, TrashedNotice, type Trashed, type TrashProps } from "./CanvasesTab.tsx";
import { CanvasView } from "./CanvasView.tsx";
import { library } from "./library.ts";
import { prefs } from "./prefs.ts";
import { Screen } from "./Screen.tsx";

const pathFromUrl = () => new URLSearchParams(location.search).get("canvas");

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [rootName, setRootName] = useState("");
  const [path, setPath] = useState<string | null>(pathFromUrl());
  const [offline, setOffline] = useState(false);
  const onDiskChange = useRef<(path: string | null, hash: string | null) => void>(() => {});
  const canvases = useRef<{ release: (path: string) => Promise<void> }>({ release: async () => {} });
  const [trashed, setTrashed] = useState<Trashed | null>(null); // the canvas last deleted, to undo

  const refresh = useCallback(async () => {
    const { root, projects } = await getProjects();
    setRootName(root.split(/[\\/]/).filter(Boolean).pop() ?? root);
    setProjects(projects);
    return projects;
  }, []);

  const open = useCallback((p: string, replace = false) => {
    history[replace ? "replaceState" : "pushState"](null, "", `/?canvas=${encodeURIComponent(p)}`);
    setPath(p);
  }, []);

  useEffect(() => {
    // With no canvas in the URL, open the first one there is.
    void refresh().then((ps) => { if (!pathFromUrl() && ps[0]?.canvases[0]) open(ps[0].canvases[0].path, true); });
    let events: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lost = false;
    const connect = () => {
      events = new EventSource("/api/events");
      events.onmessage = (m) => {
        const e = JSON.parse(m.data);
        if (e.type === "projects") void refresh();
        if (e.type === "changed") onDiskChange.current(e.path, e.hash);
        if (e.type === "library") void library.onDisk(e.hash);
      };
      events.onerror = () => {
        lost = true;
        setOffline(true);
        // When the server is simply gone, the browser reconnects by itself. Through a reverse proxy, the proxy answers
        // for it (a 502), and the browser takes that as final and stops; so start again ourselves.
        if (events.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000);
      };
      // Changes made on disk while it was away were never announced, so catch up: the list, and the open canvas
      // (merged, as for any change on disk).
      events.onopen = () => {
        setOffline(false);
        if (!lost) return;
        lost = false;
        void refresh();
        onDiskChange.current(null, null);
        void library.onDisk(undefined);
      };
    };
    connect();
    const back = () => setPath(pathFromUrl());
    window.addEventListener("popstate", back);
    return () => { clearTimeout(retry); events.close(); window.removeEventListener("popstate", back); };
  }, []);

  useEffect(() => {
    document.title = path ? `${path.split("/").pop()?.replace(/\.excalidraw$/, "")} · Localidraw` : "Localidraw";
  }, [path]);

  const create = async (wanted: string) => {
    try {
      const { path: made } = await createCanvas(wanted);
      await refresh();
      open(made);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** Renames or moves a canvas (saving it first if it's open), and follows it if it is. */
  const move = async (from: string, to: string) => {
    try {
      await canvases.current.release(from);
      const { path: moved } = await moveCanvas(from, to);
      prefs.moveViewport(from, moved);
      await refresh();
      if (from === pathFromUrl()) open(moved, true);
      return null;
    } catch (err) {
      return message(err);
    }
  };

  /** Moves a canvas to the trash (saving it first if it's open), and opens a neighbour if it was the open one. */
  const trash = async (p: string) => {
    try {
      await canvases.current.release(p);
      const { trashed: where } = await trashCanvas(p);
      setTrashed({ path: p, trashed: where });
      const ps = await refresh();
      if (p === pathFromUrl()) {
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        const next = (ps.find((x) => x.dir === dir) ?? ps[0])?.canvases[0]?.path;
        if (next) open(next, true);
        else { history.replaceState(null, "", "/"); setPath(null); }
      }
      return null;
    } catch (err) {
      return message(err);
    }
  };

  const undo = async () => {
    if (!trashed) return;
    try {
      const { path: back } = await restoreCanvas(trashed.trashed, trashed.path);
      setTrashed(null);
      await refresh();
      open(back);
    } catch (err) {
      setTrashed({ ...trashed, error: message(err) });
    }
  };

  const trashProps = { trashed, onUndo: undo, onDismiss: () => setTrashed(null) };
  const tab = (
    <CanvasesTab projects={projects} rootName={rootName} current={path} onOpen={(p) => open(p)} onCreate={create}
      onMove={move} onTrash={trash} {...trashProps} />
  );
  return (
    <div className="ld-app">
      {offline && <div className="ld-offline">Localidraw isn't running: start it again and this page reconnects.</div>}
      {path
        ? <CanvasView path={path} sidebar={tab} onDiskChange={(h) => { onDiskChange.current = h; }} control={(c) => { canvases.current = c; }} />
        : <EmptyFolder rootName={rootName} onCreate={create} {...trashProps} />}
    </div>
  );
}

/** A folder with no canvases yet: offer to make the first (or to bring back the one just deleted). */
function EmptyFolder({ rootName, onCreate, trashed, onUndo, onDismiss }:
  { rootName: string; onCreate: (path: string) => Promise<string | null> } & TrashProps) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Screen>
      <div className="Island ld-screen__island">
        <h1>No canvases in {rootName || "this folder"} yet</h1>
        <p>Localidraw shows the .excalidraw files under the folder it was started in.</p>
        <button type="button" className="ld-row ld-row--primary" onClick={async () => setError(await onCreate("untitled"))}>
          Make the first one
        </button>
        {error && <p className="ld-hint ld-hint--error">{error}</p>}
        {trashed && <TrashedNotice trashed={trashed} onUndo={onUndo} onDismiss={onDismiss} />}
      </div>
    </Screen>
  );
}
