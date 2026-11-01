---
"localidraw": patch
---

A canvas whose deletion on disk was heard before it turned up at its new path (a `git mv`), or back at its old one, no longer goes on saying "Not saved" when nothing was drawn meanwhile.
