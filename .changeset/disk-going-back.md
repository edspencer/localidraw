---
"localidraw": patch
---

Putting an older version of an open canvas back on disk now sticks. A `git checkout`, `git stash` or branch switch
writes elements with lower versions than the ones on screen, and the page used to keep its own copies and save them
straight back over the file, undoing the checkout. Now an element you haven't changed since the last save takes the
file's copy, whatever its version. One you have changed is a real conflict, and the higher version still wins.
