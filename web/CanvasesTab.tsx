// The "Canvases" tab in Excalidraw's sidebar: each project (a folder) as a section, its canvases as rows.
// Styled with Excalidraw's own tokens (docs/AESTHETIC.md), in styles.css.
import { useEffect, useRef, useState } from "react";
import type { Project } from "./api.ts";
import { CanvasIcon, PlusIcon, SearchIcon } from "./icons.tsx";

type Props = {
  projects: Project[];
  rootName: string;
  current: string | null;
  onOpen: (path: string) => void;
  onCreate: (path: string) => Promise<string | null>; // an error message, or null once created
};

export function CanvasesTab({ projects, rootName, current, onOpen, onCreate }: Props) {
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<string | null>(null); // the suggested path while the field is open
  const needle = filter.trim().toLowerCase();
  const shown = projects
    .map((p) => ({ ...p, canvases: p.canvases.filter((c) => !needle || c.path.toLowerCase().includes(needle)) }))
    .filter((p) => p.canvases.length > 0);
  const currentDir = current?.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : "";

  return (
    <div className="ld-canvases">
      <label className="ld-field ld-field--icon">
        {SearchIcon}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a canvas" spellCheck={false} />
      </label>

      {creating !== null ? (
        <NewCanvasField suggestion={creating} onCancel={() => setCreating(null)}
          onSubmit={async (path) => { const err = await onCreate(path); if (!err) setCreating(null); return err; }} />
      ) : (
        <button type="button" className="ld-row" onClick={() => setCreating(`${currentDir}untitled`)}>
          {PlusIcon}<span className="ld-row__text">New canvas</span>
        </button>
      )}

      <div className="ld-projects">
        {shown.length === 0 && <p className="ld-empty">{needle ? "No canvas matches." : "No canvases here yet."}</p>}
        {shown.map((p) => (
          <section key={p.dir} className="ld-project">
            <header className="ld-project__header">
              <span className="ld-project__name" title={p.dir || rootName}>{p.dir || rootName}</span>
              <button type="button" className="ld-icon-button" title={`New canvas in ${p.dir || rootName}`}
                onClick={() => setCreating(`${p.dir ? `${p.dir}/` : ""}untitled`)}>{PlusIcon}</button>
            </header>
            {p.canvases.map((c) => (
              <button type="button" key={c.path} title={c.path}
                className={`ld-row${c.path === current ? " ld-row--selected" : ""}`}
                onClick={(e) => { e.currentTarget.blur(); onOpen(c.path); }}>
                {CanvasIcon}<span className="ld-row__text">{c.name}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function NewCanvasField({ suggestion, onSubmit, onCancel }:
  { suggestion: string; onSubmit: (path: string) => Promise<string | null>; onCancel: () => void }) {
  const [value, setValue] = useState(suggestion);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Select the name, not the folder, so typing replaces just "untitled".
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(suggestion.lastIndexOf("/") + 1, suggestion.length);
  }, [suggestion]);
  const submit = async () => {
    if (!value.trim()) return onCancel();
    setError(await onSubmit(value.trim()));
  };
  return (
    <div className="ld-new">
      <label className="ld-field">
        <input ref={input} value={value} spellCheck={false} aria-label="New canvas path"
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onCancel(); }} />
      </label>
      <p className={error ? "ld-hint ld-hint--error" : "ld-hint"}>
        {error ?? "A path in the folder; new folders are made as needed. Enter to create, Esc to cancel."}
      </p>
    </div>
  );
}
