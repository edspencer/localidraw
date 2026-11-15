---
"localidraw": minor
---

**The page, serving the list of folders.** The Canvases sidebar is grouped by folder, Scratch first, with each
folder's projects as smaller headers; a folder that isn't there is greyed out as missing, and a `config.json` that
doesn't parse is reported at the top. A brand-new install opens on "Start drawing" (in Scratch), and with no folders
added a dismissable card gives the command to add one (`localidraw add ~/path/to/project`) with a copy button; after
that, a small "Add a folder" link. Serving the list, the Library is `~/.localidraw/library.excalidrawlib`, made on the
first change from the browser's Library, unless the open canvas's folder has its own.
