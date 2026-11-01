// The "Canvases" tab in Excalidraw's sidebar: each project (a folder) as a section, its canvases as rows, each with a
// menu (its ⋯ button, or a right-click) to rename, move or delete it. Styled with Excalidraw's own tokens
// (docs/AESTHETIC.md), in styles.css.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Canvas, Project } from "./api.ts";
import { CanvasIcon, CloseIcon, DotsIcon, PlusIcon, RenameIcon, SearchIcon, TrashIcon } from "./icons.tsx";

/** The canvas last deleted: where it was, and where it is in the trash. */
export type Trashed = { path: string; trashed: string; error?: string };
export type TrashProps = { trashed: Trashed | null; onUndo: () => void; onDismiss: () => void };

type Props = {
  projects: Project[];
  rootName: string;
  current: string | null;
  onOpen: (path: string) => void;
  // Each of these resolves to an error message, or null once it's done.
  onCreate: (path: string) => Promise<string | null>;
  onMove: (from: string, to: string) => Promise<string | null>;
  onTrash: (path: string) => Promise<string | null>;
} & TrashProps;

const withoutExt = (path: string) => path.replace(/\.excalidraw$/, "");
const nameOf = (path: string) => withoutExt(path.split("/").pop() ?? path);

export function CanvasesTab({ projects, rootName, current, onOpen, onCreate, onMove, onTrash, trashed, onUndo, onDismiss }: Props) {
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<string | null>(null); // the suggested path while the field is open
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ path: string; error: string | null } | null>(null);
  const needle = filter.trim().toLowerCase();
  const shown = projects
    .map((p) => ({ ...p, canvases: p.canvases.filter((c) => !needle || c.path.toLowerCase().includes(needle)) }))
    .filter((p) => p.canvases.length > 0);
  const currentDir = current?.includes("/") ? current.slice(0, current.lastIndexOf("/") + 1) : "";

  const row = (c: Canvas) => {
    if (renaming === c.path) {
      return (
        <PathField key={c.path} suggestion={withoutExt(c.path)} label={`New path for ${c.name}`}
          hint="Change the name, or the folder to move it; new folders are made as needed. Enter to rename, Esc to cancel."
          onCancel={() => setRenaming(null)}
          onSubmit={async (to) => { const err = await onMove(c.path, to); if (!err) setRenaming(null); return err; }} />
      );
    }
    if (confirming?.path === c.path) {
      return (
        <ConfirmDelete key={c.path} name={c.name} error={confirming.error} onCancel={() => setConfirming(null)}
          onConfirm={async () => { const err = await onTrash(c.path); setConfirming(err ? { path: c.path, error: err } : null); }} />
      );
    }
    const openMenu = (x: number, y: number) => setMenu({ path: c.path, x, y });
    return (
      <div key={c.path} className={`ld-canvas${menu?.path === c.path ? " ld-canvas--menu" : ""}`}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY); }}>
        <button type="button" title={c.path} className={`ld-row${c.path === current ? " ld-row--selected" : ""}`}
          onClick={(e) => { e.currentTarget.blur(); onOpen(c.path); }}>
          {CanvasIcon}<span className="ld-row__text">{c.name}</span>
        </button>
        <button type="button" className="ld-icon-button ld-canvas__more" title={`More for ${c.name}`} aria-label={`More for ${c.name}`}
          aria-haspopup="menu" aria-expanded={menu?.path === c.path}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.right, r.bottom); }}>{DotsIcon}</button>
      </div>
    );
  };

  return (
    <div className="ld-canvases">
      <label className="ld-field ld-field--icon">
        {SearchIcon}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a canvas" spellCheck={false} />
      </label>

      {creating !== null ? (
        <PathField suggestion={creating} label="New canvas path" onCancel={() => setCreating(null)}
          hint="A path in the folder; new folders are made as needed. Enter to create, Esc to cancel."
          onSubmit={async (path) => { const err = await onCreate(path); if (!err) setCreating(null); return err; }} />
      ) : (
        <button type="button" className="ld-row" onClick={() => setCreating(`${currentDir}untitled`)}>
          {PlusIcon}<span className="ld-row__text">New canvas</span>
        </button>
      )}

      {trashed && <TrashedNotice trashed={trashed} onUndo={onUndo} onDismiss={onDismiss} />}

      <div className="ld-projects" onScroll={() => setMenu(null)}>
        {shown.length === 0 && <p className="ld-empty">{needle ? "No canvas matches." : "No canvases here yet."}</p>}
        {shown.map((p) => (
          <section key={p.dir} className="ld-project">
            <header className="ld-project__header">
              <span className="ld-project__name" title={p.dir || rootName}>{p.dir || rootName}</span>
              <button type="button" className="ld-icon-button" title={`New canvas in ${p.dir || rootName}`}
                onClick={() => setCreating(`${p.dir ? `${p.dir}/` : ""}untitled`)}>{PlusIcon}</button>
            </header>
            {p.canvases.map(row)}
          </section>
        ))}
      </div>

      {menu && (
        <RowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          { label: "Rename or move", icon: RenameIcon, run: () => { setConfirming(null); setRenaming(menu.path); } },
          { label: "Delete", icon: TrashIcon, run: () => { setRenaming(null); setConfirming({ path: menu.path, error: null }); } },
        ]} />
      )}
    </div>
  );
}

/** A canvas's menu, in Excalidraw's dropdown style, at a point on the screen (kept inside it). */
function RowMenu({ x, y, items, onClose }: { x: number; y: number; onClose: () => void; items: { label: string; icon: ReactNode; run: () => void }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: x, top: y, ready: false });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    // Right-aligned to the point, like Excalidraw's own menus from a button; flipped up if it would run off the bottom.
    setAt({ left: Math.max(8, Math.min(x - width, innerWidth - width - 8)), top: y + height + 8 > innerHeight ? y - height : y, ready: true });
  }, [x, y]);
  // Once it's placed and visible (a hidden element can't take focus), the first item has the focus, for the keyboard.
  useEffect(() => { if (at.ready) box.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [at.ready]);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation(); // not Excalidraw's: it would move the selected shapes
        const buttons = [...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", away, true); document.removeEventListener("keydown", key, true); };
  }, [onClose]);
  return (
    <div ref={box} className="dropdown-menu ld-menu" role="menu"
      style={{ left: at.left, top: at.top, visibility: at.ready ? "visible" : "hidden" }}>
      <div className="Island dropdown-menu-container">
        {items.map((item) => (
          <button key={item.label} type="button" role="menuitem" className="dropdown-menu-item dropdown-menu-item-base"
            onClick={() => { onClose(); item.run(); }}>
            {item.icon}<div className="dropdown-menu-item__text">{item.label}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** In place of a canvas's row: are you sure? It's only moved to the trash, and can be undone. */
function ConfirmDelete({ name, error, onConfirm, onCancel }: { name: string; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="ld-confirm" role="alertdialog" aria-label={`Delete ${name}?`}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <p className="ld-confirm__text">Delete <strong>{name}</strong>? It goes to the folder's trash, and you can undo it.</p>
      <div className="ld-confirm__buttons">
        <button type="button" className="ld-button ld-button--danger" onClick={onConfirm}>Delete</button>
        <button type="button" ref={cancel} className="ld-button" onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="ld-hint ld-hint--error">{error}</p>}
    </div>
  );
}

/** After a delete: where the canvas went, and a way to bring it back. */
export function TrashedNotice({ trashed, onUndo, onDismiss }: { trashed: Trashed } & Omit<TrashProps, "trashed">) {
  return (
    <div className="ld-trashed" role="status">
      <p className="ld-trashed__text" title={trashed.trashed}>
        Deleted <strong>{nameOf(trashed.path)}</strong>. It's in <code>.localidraw/trash</code>.
      </p>
      <button type="button" className="ld-trashed__action" aria-label="Undo the delete" onClick={onUndo}>Undo</button>
      <button type="button" className="ld-trashed__close" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>{CloseIcon}</button>
      {trashed.error && <p className="ld-hint ld-hint--error">{trashed.error}</p>}
    </div>
  );
}

/** A path in the folder, typed in place: a new canvas's, or a new name or folder for one. */
function PathField({ suggestion, label, hint, onSubmit, onCancel }:
  { suggestion: string; label: string; hint: string; onSubmit: (path: string) => Promise<string | null>; onCancel: () => void }) {
  const [value, setValue] = useState(suggestion);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Select the name, not the folder, so typing replaces just the name.
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
        <input ref={input} value={value} spellCheck={false} aria-label={label}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void submit(); if (e.key === "Escape") onCancel(); }} />
      </label>
      <p className={error ? "ld-hint ld-hint--error" : "ld-hint"}>{error ?? hint}</p>
    </div>
  );
}
