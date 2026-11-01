---
title: The Canvases sidebar
description: Projects, canvases, the filter and New canvas, in a tab of Excalidraw's own sidebar.
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

Renaming, moving and deleting canvases aren't in the sidebar yet: do them in your shell, file manager or git, and the
list follows.

## The status, in the footer

Next to the undo buttons, in small grey text:

| Status | Means |
| --- | --- |
| **Saving…** | A change is being written. |
| **Saved** *(time)* | The file has everything on screen. |
| **Updated from disk** | The file changed on disk and the change was merged in. See [Saving and merging](/saving-and-merging/). |
| **Not saved:** *(reason)* | The save failed. It keeps trying, and saves once it can. |

<kbd>Ctrl</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>S</kbd> on a Mac) saves at once rather than waiting.

If Localidraw stops, the page says it isn't running. Keep drawing: when it's started again the page reconnects,
catches up with anything that changed on disk meanwhile, and saves what you drew.

## An empty folder, or a canvas that won't open

On a folder with no canvases yet, the page says so, with a button to **make the first one**.

A canvas that can't be opened (it isn't in the folder, or the file isn't valid JSON, or isn't an Excalidraw scene)
gets a page that says why and lists the canvases. It's never opened as a blank canvas, so it can't be drawn over and
saved. If the file is fixed on disk, it opens.
