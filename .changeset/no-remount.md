---
"localidraw": patch
---

Switching canvases no longer flashes: the page keeps one Excalidraw and swaps the canvas in it, instead of mounting a new one each time. Each canvas keeps its own view and its own undo history, and a save that's still due or on its way when you switch lands in the canvas it came from (merged, if an agent changed that file meanwhile).
