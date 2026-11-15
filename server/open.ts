// `--open`: the page in the person's browser. One opener for `serve`, `service install` and `service start`, which
// call it once the page answers. The service's commands take theirs from ServiceContext, so the tests never start a
// browser; the CLI's tests put a fake `xdg-open` (or `open`) first on PATH.
import { spawn } from "node:child_process";

/** Hands the URL to the default browser, and doesn't wait for it. A machine without one says nothing. */
export function openInBrowser(url: string): void {
  // On Windows, rundll32's FileProtocolHandler hands the URL to the default browser, as `start` would, without a
  // shell (`explorer <url>` works too, but it exits 1 and mangles some URLs).
  const [cmd, args]: [string, string[]] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}
