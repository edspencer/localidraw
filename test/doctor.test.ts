// `localidraw doctor`'s own counting (server/doctor.ts): the CLI tests run the whole command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countFolders } from "../server/doctor.ts";

test("the folders to watch are the ones serve watches: itself and its folders, not dot-folders or node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "localidraw-doctor-"));
  try {
    for (const d of ["a/b", "c", ".git/objects", "node_modules/pkg", "a/.hidden"]) mkdirSync(join(root, d), { recursive: true });
    assert.deepEqual(countFolders(root, 100), { folders: 4, complete: true });
    assert.equal(countFolders(root, 2).complete, false, "it stops counting past the limit");
    assert.equal(countFolders(root, 100, -1).complete, false, "and when its time is up");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
