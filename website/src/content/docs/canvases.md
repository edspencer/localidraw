---
title: The Canvases sidebar
description: Projects, canvases, the filter, New canvas, and renaming, moving and deleting, in a tab of Excalidraw's own sidebar.
---

Localidraw adds one thing to Excalidraw's screen: a **Canvases** tab in its sidebar, beside the Library. Open it from
the **Canvases** button at the top right. It docks like the Library does (the pin in its header), and the browser
remembers whether it's docked.

## Projects and canvases

Every folder under the one you started Localidraw in that holds `.excalidraw` files is a **project**, and each file is
a **canvas**. A project's header is its path in the folder; canvases at the top level are under the folder's own name.

```
notes/                      ← you ran `localidraw notes`
├── roadmap.excalidraw      → "notes": roadmap
├── web-app/
│   ├── architecture.excalidraw   → "web-app": architecture, login-flow
│   └── login-flow.excalidraw
└── research/
    └── interviews/
        └── themes.excalidraw     → "research/interviews": themes
```

Folders without canvases aren't listed, and nor are `node_modules` or dot-folders. The list follows the disk: a file
added, renamed or deleted in your shell, by git or by an agent shows up (or goes) within a second.

The open canvas is highlighted, and is in the page's URL (`?canvas=web-app/architecture.excalidraw`), so the back
button and bookmarks work.

## Finding a canvas

**Find a canvas** filters the list as you type. It matches anywhere in the canvas's path, so `web` finds everything
in `web-app/`, and `arch` finds `architecture`.

## New canvas

**New canvas** opens a field with a path to fill in, starting in the open canvas's folder with `untitled` selected, so
typing replaces just the name. The **+** beside a project's header does the same in that project.

- Type a path in the folder: `ideas`, or `web-app/deploy`, or `plans/2027/q1`. Folders are made as needed, and
  `.excalidraw` is added if you leave it off.
- **Enter** creates it and opens it; **Esc** cancels.
- It won't overwrite a canvas that's there already, and won't make one outside the folder, in a dot-folder or in
  `node_modules`. It says why under the field.

The new file is an empty scene, written at once, so it's in `git status` straight away.

## Rename, move and delete

Each canvas has a menu: the **⋯** that shows when you point at its row, or a right-click on the row.

- **Rename or move** turns the row into a field with the canvas's path, the name selected. Type a new name, or change
  the folder to move it (`archive/2026/plan`); folders are made as needed. **Enter** renames it; **Esc** cancels.
  - It never replaces another canvas: if the name is taken, it says so under the field and nothing changes.
  - If it's the open canvas, what you drew is saved first, then the file is renamed and the page follows it (the URL
    too). Its view comes along.
- **Delete** asks first, in place of the row. It doesn't delete anything: the file is moved into the folder's trash,
  `.localidraw/trash/`, as `<date and time>-<name>.excalidraw`. A notice at the top of the tab says so, with
  **Undo**, which puts it back where it was (unless another canvas has taken its place since).
  - If it's the open canvas, it's saved first, and another canvas opens: the first in the same project, or else the
    first there is.
  - The trash is a dot-folder, so it's never listed. Empty it yourself when you like (`rm -r .localidraw/trash`), and
    consider adding `.localidraw/` to your `.gitignore`.

Renaming, moving and deleting in your shell, file manager or git works as before: the list follows.

## The status, in the footer

Next to the undo buttons, in small grey text:

| Status | Means |
| --- | --- |
| **Saving…** | A change is being written. |
| **Saved** *(time)* | The file has everything on screen. |
| **Updated from disk** | The file changed on disk and the change was merged in. See [Saving and merging](/saving-and-merging/). |
| **Not saved:** *(reason)* | The save failed. It keeps trying, and saves once it can. |

<kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>S</kbd> on a Mac) saves at once rather than waiting.

If Localidraw stops, the page says it isn't running, in the footer. Keep drawing: when it's started again the page reconnects,
catches up with anything that changed on disk meanwhile, and saves what you drew.

## An empty folder, or a canvas that won't open

On a folder with no canvases yet, the page says so, with a button to **make the first one**.

A canvas that can't be opened (it isn't in the folder, or the file isn't valid JSON, or isn't an Excalidraw scene)
gets a page that says why and lists the canvases. It's never opened as a blank canvas, so it can't be drawn over and
saved. If the file is fixed on disk, it opens.
