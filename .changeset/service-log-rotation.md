---
"localidraw": patch
---

The service's log, `~/.localidraw/logs/service.log`, no longer grows for good: Localidraw rotates it itself once it's past 8 MB, copying it to `service.log.1` and emptying it in place, and keeps three old ones (`.1` to `.3`). A `localidraw` run in a terminal has no such log, and does nothing.

`service status` and `localidraw doctor` now warn when the service runs another install of Localidraw than the one you're asking (a second global install, or another Node's): `doctor`'s `unit` check is a warning (`!`, exit code unchanged) with the fix, `localidraw service install` from the install you mean it to run.

A first `service install` that the service manager refuses still leaves no unit behind; that's now done by the contract's reference code rather than by Localidraw.
