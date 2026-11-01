---
"localidraw": patch
---

When Localidraw is started again after being stopped, an open page now catches up with what changed on disk while it
was gone (a `git pull`, an agent's edit, a new canvas): the open canvas merges the changes in and the sidebar lists
what's new. Before, it showed the old version until you drew something.
