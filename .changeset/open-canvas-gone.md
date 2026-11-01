---
"localidraw": patch
---

When the open canvas is moved on disk (a `git mv`, an agent's rename), the page now follows it to its new path instead of saving a copy back at the old one. When it's deleted on disk, the page says so and never writes it back by itself: **Save it again** does that, and if the file comes back (a checkout), it picks up where it was. Also, on Linux, a canvas that arrived along with a new folder (moved into one, or a checkout) wasn't announced until it next changed.
