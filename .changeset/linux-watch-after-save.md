---
"localidraw": patch
---

On Linux, changes made on disk to a canvas now keep showing up after you've saved it. Node's recursive file watch
there stopped hearing a file once a new one was renamed over it, which is how Localidraw (and many editors and
agents) save, so after your first save an agent's edits to that canvas no longer appeared until you reopened it.
Localidraw now watches each folder instead, and skips dot-folders and `node_modules` rather than walking them.
