// The page: which canvas is open (in the URL), the projects list, and the connection to the server's events.
import { useCallback, useEffect, useRef, useState } from "react";
import { createCanvas, getProjects, type Project } from "./api.ts";
import { CanvasesTab } from "./CanvasesTab.tsx";
import { CanvasView } from "./CanvasView.tsx";
import { Screen } from "./Screen.tsx";

const pathFromUrl = () => new URLSearchParams(location.search).get("canvas");

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [rootName, setRootName] = useState("");
  const [path, setPath] = useState<string | null>(pathFromUrl());
  const [offline, setOffline] = useState(false);
  const onDiskChange = useRef<(hash: string) => void>(() => {});

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
    const events = new EventSource("/api/events");
    events.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "projects") void refresh();
      if (e.type === "changed" && e.path === pathFromUrl()) onDiskChange.current(e.hash);
    };
    events.onerror = () => setOffline(true);
    events.onopen = () => setOffline(false);
    const back = () => setPath(pathFromUrl());
    window.addEventListener("popstate", back);
    return () => { events.close(); window.removeEventListener("popstate", back); };
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

  const tab = <CanvasesTab projects={projects} rootName={rootName} current={path} onOpen={(p) => open(p)} onCreate={create} />;
  return (
    <div className="ld-app">
      {offline && <div className="ld-offline">Localidraw isn't running: start it again and this page reconnects.</div>}
      {path
        ? <CanvasView key={path} path={path} sidebar={tab} onDiskChange={(h) => { onDiskChange.current = h; }} />
        : <EmptyFolder rootName={rootName} onCreate={create} />}
    </div>
  );
}

/** A folder with no canvases yet: offer to make the first. */
function EmptyFolder({ rootName, onCreate }: { rootName: string; onCreate: (path: string) => Promise<string | null> }) {
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
      </div>
    </Screen>
  );
}
