// The browser tests (e2e/). Each test starts its own server over a temporary folder (e2e/fixtures.ts), so they run
// in parallel. `npm run test:e2e` builds the page first.
//
// The theme snapshots (e2e/snapshots.spec.ts) only run with LOCALIDRAW_SNAPSHOTS=1, which is set inside the official
// Playwright image: fonts and anti-aliasing differ between machines, so the baselines are made and compared there
// only. `npm run test:e2e:snapshots` runs them in Docker; see e2e/README.md.
import { defineConfig, devices } from "@playwright/test";

const snapshots = process.env.LOCALIDRAW_SNAPSHOTS === "1";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  snapshotPathTemplate: "{testDir}/snapshots/{arg}{ext}",
  expect: { toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide" } },
  projects: [
    { name: "editor", testIgnore: /snapshots\.spec\.ts/ },
    ...(snapshots ? [{ name: "snapshots", testMatch: /snapshots\.spec\.ts/ }] : []),
  ],
});
