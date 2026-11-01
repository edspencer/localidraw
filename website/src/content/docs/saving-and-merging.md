---
title: Saving and merging
description: When Localidraw writes a file, and how it merges a change made on disk with what's on screen.
---

Localidraw makes three promises about your files:

1. **Opening never writes.** Opening a canvas, panning, zooming or switching theme never touches the file, so browsing
   leaves `git status` clean.
2. **Drawing is saved.** A change is written to the file about 0.7 seconds after you stop (or at once with
   <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>S</kbd>).
3. **Nothing written on disk is lost.** If something else changes the file (an agent, an editor, `git pull`), that
   change is merged in, not saved over.

## When it saves

A canvas is saved only when an element changed (each has a `version` that Excalidraw raises on every edit) or the
background colour did. Excalidraw tidies a scene when it loads it, so comparing the JSON before and after would
rewrite every file you open; comparing versions doesn't.

Saves are atomic: the new content goes to a temporary file in the same folder, which is then renamed over the canvas.
A crash mid-save leaves the old file, never half of a new one.

## When the file changes on disk

Localidraw watches the folder. When an open canvas's file changes, the page reads it and merges it with what's on
screen, element by element, then shows **Updated from disk**.

The merge needs to know who changed what, so the page remembers each element's `version` as of the last time the
screen and the file agreed (the last load or save). Then, for each element:

| The element… | Result |
| --- | --- |
| changed only in the file | The file's copy, even if its `version` is lower. So a `git checkout` or `git stash` of the file sticks. |
| changed on both sides | The higher `version` wins; the file wins a tie. |
| was removed from the file, and not changed here since | Removed. |
| was removed from the file, but changed here since | Kept. |
| is new on screen | Kept. |
| is new in the file | Added. |

### A save that crosses a change

Saves can't overwrite changes either. Each save sends the hash of the file it was based on. If the file has changed
since, the server refuses the save (HTTP 409) and returns the current file; the page merges it as above and saves the
result. So when you and an agent write at the same moment, both changes end up in the file.

### What "wins" means in practice

Two people (or a person and an agent) changing **different elements** never conflict: both changes are kept.

Changing **the same element** on both sides at once is the only real conflict, and the higher `version` decides it.
That's why an agent should [bump the version](/agents/#the-rules) of anything it changes: an edit that leaves `version`
alone loses to any edit made in the browser since the last save.

Today the losing side of such a conflict is dropped silently. Showing it is on the list.

## The open canvas and git

Because the file's copy wins for anything you haven't touched, git works as you'd expect with a canvas open:
`git checkout -- file`, `git stash`, `git pull` and switching branches all show up on screen within a second, and
none of them is undone by the next save.

If the open canvas is deleted or moved on disk, the page keeps showing it, and your next change saves it again at the
old path. Nothing you drew is lost, but a `git mv` leaves a copy behind. Following a move is on the list too.
