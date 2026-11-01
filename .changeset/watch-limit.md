---
"localidraw": patch
---

On Linux, when the system's limit on file watches (`fs.inotify.max_user_watches`) is reached in a big folder, Localidraw now says so once, with what to do, instead of quietly missing changes in the folders past the limit.
