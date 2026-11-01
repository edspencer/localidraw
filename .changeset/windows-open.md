---
"localidraw": patch
---

Windows: `--open` starts the default browser through `rundll32 url.dll,FileProtocolHandler` instead of `explorer`, and CI now tests Windows (Node 22 and 24) on every change, the packed package included.
