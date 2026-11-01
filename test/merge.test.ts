import { test } from "node:test";
import assert from "node:assert/strict";
import { changedSince, mergeScenes, versionsOf, type Versioned } from "../web/merge.ts";

const el = (id: string, version: number, index = id, isDeleted = false): Versioned => ({ id, version, index, isDeleted });
const ids = (es: Versioned[]) => es.map((e) => `${e.id}@${e.version}${e.isDeleted ? "x" : ""}`);

test("an element only on disk is added; one only on screen and new here is kept", () => {
  const base = versionsOf([el("a", 1)]);
  assert.deepEqual(ids(mergeScenes([el("a", 1), el("mine", 1)], [el("a", 1), el("theirs", 1)], base)), ["a@1", "mine@1", "theirs@1"]);
});

test("the higher version wins; a tie goes to disk", () => {
  const base = versionsOf([el("a", 1), el("b", 1), el("c", 1)]);
  const local = [el("a", 3), el("b", 1), el("c", 2)];
  const remote = [el("a", 2), el("b", 2), el("c", 2)];
  const merged = mergeScenes(local, remote, base);
  assert.deepEqual(ids(merged), ["a@3", "b@2", "c@2"]);
  assert.equal(merged[2], remote[2], "a tie takes the disk's copy");
});

test("an element removed on disk goes, unless it was changed here since", () => {
  const base = versionsOf([el("gone", 1), el("edited", 1)]);
  assert.deepEqual(ids(mergeScenes([el("gone", 1), el("edited", 2)], [], base)), ["edited@2"]);
});

test("an element deleted here stays deleted, so the save drops it", () => {
  const base = versionsOf([el("a", 1)]);
  assert.deepEqual(ids(mergeScenes([el("a", 2, "a", true)], [el("a", 1)], base)), ["a@2x"]);
});

test("the result is in z-order", () => {
  assert.deepEqual(ids(mergeScenes([el("x", 1, "a2")], [el("y", 1, "a1"), el("z", 1, "a3")], new Map())), ["y@1", "x@1", "z@1"]);
});

test("changedSince: looking around isn't a change; drawing and deleting are", () => {
  const base = versionsOf([el("a", 1)]);
  assert.equal(changedSince([el("a", 1)], base), false);
  assert.equal(changedSince([el("a", 2)], base), true);
  assert.equal(changedSince([el("a", 1), el("new", 1)], base), true);
  assert.equal(changedSince([el("a", 1), el("drawn-and-deleted", 2, "b", true)], base), false);
});
