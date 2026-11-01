---
"localidraw": patch
---

A canvas that won't open is no longer a dead end. A link to one that isn't there (a bookmark to a renamed file), or
a file that isn't a scene, now shows why, with your canvases listed so you can open another or make one, in your
theme. It opens by itself once the file is there and valid, so an agent can fix it while you watch. A `.excalidraw`
file that's JSON but not a scene is no longer opened as a blank canvas that a drawing would save over, and an empty
file (`touch plan.excalidraw`) opens as an empty canvas. The "Opening…" screen follows the dark theme too.
