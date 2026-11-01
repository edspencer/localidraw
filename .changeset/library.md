---
"localidraw": minor
---

Excalidraw's Library is kept now. By default it's in the browser, so it survives a reload. Put a `library.excalidrawlib` at the top of the folder (`touch` one, or copy in an export) and the Library is that file instead: shared by everyone using the folder, watched like a canvas, merged by item when it changed on both sides, and written only when the Library actually changes.
