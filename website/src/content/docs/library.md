---
title: The Library
description: Excalidraw's Library of reusable shapes, kept in your browser or shared in the folder as library.excalidrawlib.
---

The **Library** is Excalidraw's own panel of reusable shapes: select something on a canvas, open the Library tab in the
sidebar, and click **Add to library**. Drag an item back onto any canvas to use it. You can also import `.excalidrawlib`
files, such as those from [libraries.excalidraw.com](https://libraries.excalidraw.com/), from the panel's menu.

Localidraw keeps it in one of two places.

## In your browser (the default)

With no Library file in the folder, the Library is kept in this browser's storage (`localStorage`), like the theme and
each canvas's viewport. It's there for every canvas in the folder, and it survives a reload or a restart. It doesn't
follow you to another browser, and nobody else using the same folder sees it.

## Shared in the folder: `library.excalidrawlib`

To share a Library with everyone who uses the folder, and keep it in git with the canvases, put a file called
`library.excalidrawlib` at the **top** of the folder (the one you started Localidraw in):

```sh
touch library.excalidrawlib    # an empty file is an empty Library
# or: copy in one exported from Excalidraw (the Library panel's menu → Export)
```

From then on the Library comes from that file, and goes back into it:

- **It's written only when the Library changes:** adding, removing or publishing an item. Opening Localidraw, or
  switching canvases, never writes it.
- **It's watched like a canvas.** A change made on disk (a `git pull`, a teammate on a hosted copy, an agent) shows up
  in the open panel within a second.
- **Changes are merged, never lost.** A save carries the version it was based on. If the file changed meanwhile, the
  page merges, item by item: an item added on either side is kept, and one removed on either side is removed. Then it
  saves again.
- **Localidraw never makes the file for you, and never deletes it.** Delete it and the page goes back to the browser's
  own Library, which was left untouched in the meantime. Make it again and the page uses the file.

The file is Excalidraw's own `.excalidrawlib` format (version 2, `libraryItems`; version 1 files open too), so the
same file imports into excalidraw.com or the VS Code extension. Only the one at the top of the folder is used: a
`library.excalidrawlib` in a subfolder is just a file.
