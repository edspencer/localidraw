---
title: Working with coding agents
description: How a coding agent (or any script) should edit a .excalidraw file while it's open in Localidraw.
---

Localidraw is built for drawing in the same files a coding agent reads and writes. Ask Claude Code, Codex or Cursor to
"add the cache to the architecture diagram", keep the canvas open, and its edit shows up within a second, merged with
whatever you've drawn since. No plugin or API: the agent edits the JSON file, and Localidraw watches it.

This page is what an agent needs to know to do that well. You can point it here, or paste [the rules](#the-rules)
into your `AGENTS.md` or `CLAUDE.md`.

## The file

A `.excalidraw` file is JSON:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "http://localhost:3729",
  "elements": [ … ],
  "appState": { "viewBackgroundColor": "#ffffff", "gridSize": 20 },
  "files": {}
}
```

`elements` is the drawing, back to front. Each element has an `id`, a `type` (`rectangle`, `ellipse`, `diamond`,
`arrow`, `line`, `text`, `freedraw`, `image`, `frame`), its geometry and style, and three fields that matter here:

- `version`: a number Excalidraw raises every time the element changes. [The merge](/saving-and-merging/) compares it.
- `index`: the element's place in the z-order, as a fractional index string (`"a0"`, `"a1"`, `"a1V"`…).
- `isDeleted`: Excalidraw keeps deleted elements as tombstones with `isDeleted: true`. Skip them when reading.

The format is Excalidraw's own, documented in
[its JSON schema](https://docs.excalidraw.com/docs/codebase/json-schema).

## The rules

1. **Bump `version` on anything you change.** Add 1 to the `version` of every existing element you edit (and set a new
   random `versionNonce`). If the person at the canvas has changed the same element since it was last saved, the
   higher version wins; an edit that leaves `version` alone loses.
2. **New elements get new ids and `version: 1`.** Any unique string will do for an `id`.
3. **Drop `index` on new elements, or set it yourself.** Don't copy an `index` from another element or number your
   own from `"a0"`: they'd clash with the file's. Without one, Excalidraw numbers the element after the others, on
   top, and the number is written with the next save. To choose its place yourself, give it an `index` between its
   neighbours'; above the highest in the file, the highest with a character added (`"a5"` → `"a5V"`) always is.
4. **Leave alone what you didn't mean to change**, including other elements' `version`, and `appState`.
5. **Write the whole file, atomically**: write to a temporary file in the same folder and rename it over the canvas.
   Localidraw reads the file as soon as it changes. A half-written file won't be opened or saved over, but it shows as
   an error until the write finishes.
6. **Give text room.** Excalidraw draws a text element at the `width` and `height` the file gives it, so a box that's
   too small cuts the text off. Localidraw measures text again when it opens a canvas, and when your change arrives,
   so there it shows in full (and the right size is saved with the next edit). Other editors, the VS Code extension
   included, don't. In Excalifont (`fontFamily: 5`), allow about 0.6 × `fontSize` per character, and 1.25 ×
   `fontSize` per line.
7. **Keep bindings two-way.** A label is a `text` element whose `containerId` is its box, and the box lists it in
   `boundElements`. An arrow attached to a shape names it in `startBinding`/`endBinding`, and the shape lists the
   arrow in its `boundElements`; adding the arrow changes the shape, so bump the shape's `version` too.

## Making elements: `convertToExcalidrawElements`

Excalidraw elements have many required fields. Rather than write them by hand, an agent that can run JavaScript can
describe elements as **skeletons** and let Excalidraw fill in the rest, with fresh ids, versions and seeds:

```js
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

const elements = convertToExcalidrawElements([
  { type: "rectangle", id: "cache", x: 640, y: 180, width: 180, height: 80,
    backgroundColor: "#ffc9c9", fillStyle: "solid", label: { text: "Redis cache" } },
  { type: "arrow", x: 500, y: 60, width: 140, height: 160,
    start: { id: "api" }, end: { id: "cache" } },
], { regenerateIds: false });
```

It handles labels, bindings and text measurement (when it runs where fonts can be measured, as in a browser), and the
skeleton format is [in Excalidraw's docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton).
Its output still needs the rules above: drop the `index` it numbers from `"a0"` (it doesn't know the file's), and bump
the `version` of any existing element you bind to.

Editing an element by hand is fine too: change the fields, then bump `version`. Copying an existing element as a
template, as below, is the easiest way to get every field right.

## An example: adding a box and an arrow in Node

What the script behind the [demo GIF](https://github.com/edspencer/localidraw#readme) does, trimmed. Run from
the repo's `demo/` folder, it works as is:

```js
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const file = "web-app/architecture.excalidraw";
const scene = JSON.parse(readFileSync(file, "utf8"));
const api = scene.elements.find((e) => e.id === "api");
const label = scene.elements.find((e) => e.containerId === "api");
const rand = () => Math.floor(Math.random() * 2 ** 31);
// a copy of an existing element, as new: a new version, nonce and seed, and no index
const fresh = ({ index, ...e }) => ({ ...e, version: 1, versionNonce: rand(), seed: rand(), updated: Date.now() });

const box = { ...fresh(api), id: "cache", x: 640, y: 180, strokeColor: "#e03131", backgroundColor: "#ffc9c9",
  boundElements: [{ type: "text", id: "cache-label" }, { type: "arrow", id: "api-cache" }] };
const text = { ...fresh(label), id: "cache-label", containerId: "cache", strokeColor: "#e03131",
  text: "Redis cache", originalText: "Redis cache",
  width: 11 * label.fontSize * 0.6, height: label.fontSize * 1.25 };
text.x = box.x + (box.width - text.width) / 2;
text.y = box.y + (box.height - text.height) / 2;
const arrow = { ...fresh(scene.elements.find((e) => e.type === "arrow")), id: "api-cache",
  x: 500, y: 60, width: 140, height: 160, points: [[0, 0], [140, 160]],
  startBinding: { elementId: "api", focus: 0, gap: 1 },
  endBinding: { elementId: "cache", focus: 0, gap: 1 } };

// the API box gains the arrow, so it changed: bump it
api.boundElements = [...(api.boundElements ?? []), { type: "arrow", id: "api-cache" }];
api.version += 1;
api.versionNonce = rand();

scene.elements.push(box, text, arrow);
writeFileSync(`${file}.tmp`, JSON.stringify(scene, null, 2) + "\n");
renameSync(`${file}.tmp`, file);
```

## Reading a canvas

To read what someone drew, skip elements with `isDeleted: true`, and read labels from `text` elements: a label's
`containerId` says which shape it's on. Arrows name what they connect in `startBinding.elementId` and
`endBinding.elementId`.

## For your AGENTS.md

```md
## Diagrams (.excalidraw)

Diagrams are Excalidraw JSON files, often open in Localidraw while you work. When you edit one:
- add 1 to the `version` (and set a new random `versionNonce`) of every element you change;
- give new elements new ids and `version: 1`, and no `index` (or one above the file's highest);
- keep bindings two-way (`containerId`/`boundElements`, `startBinding`/`endBinding`), bumping the shapes you bind to;
- size text generously: about 0.6 × fontSize per character, 1.25 × fontSize per line;
- write the whole file to a temporary file and rename it over the original.
See https://localidraw.edspencer.net/agents/
```
