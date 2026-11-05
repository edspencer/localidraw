---
"localidraw": patch
---

`localidraw service install` no longer prints a linger line when `loginctl` can't answer; it prints the `sudo loginctl enable-linger` line only when linger is off, as CLI contract 1.0 (§7) says. `doctor` still reports that check as skipped. The copies of the contract's reference code are re-synced to 1.0.
