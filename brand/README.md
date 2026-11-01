# Localidraw brand kit

The mark is a folder with a diagram in it: a box, a line and a diamond, the way a flowchart starts. That's what
Localidraw is, a folder of drawings. It sits on a tile in Excalidraw's violet (`#6965db`, `--color-primary`), so it
looks at home next to the editor, but it isn't Excalidraw's mark and doesn't imitate it.

It's flat and geometric, never sketchy. Excalidraw keeps its hand-drawn look for the drawing and keeps its chrome
clean ([docs/AESTHETIC.md](../docs/AESTHETIC.md)), and a logo is chrome.

## Files

| File | What it is | Use it for |
|---|---|---|
| `mark.svg` | The mark: 32×32, hand-authored. **The source of everything else.** | Anywhere a square icon is needed |
| `lockup-light.svg` | The mark + "Localidraw" in near-black (Assistant Bold, as paths) | Light backgrounds |
| `lockup-dark.svg` | The mark + "Localidraw" in white | Dark backgrounds |
| `favicon.svg` | A copy of `mark.svg`, also copied to `web/favicon.svg` for the app | `<link rel="icon" type="image/svg+xml">` |
| `favicon.ico` | 16, 32 and 48px PNGs in one ICO | `<link rel="icon" sizes="32x32">`, old browsers, `/favicon.ico` |
| `apple-touch-icon.png` | 180×180, full-bleed (iOS rounds the corners) | `<link rel="apple-touch-icon">` |
| `icon-192.png`, `icon-512.png` | Web manifest icons | a web manifest, if one is added (none ships yet) |
| `og-image.png` | 1200×630 card | `og:image` / `twitter:image` on the docs site |
| `social-preview.png` | 1280×640 card | GitHub repo Settings → Social preview |
| `generate.mjs` | Builds every file above except `mark.svg` | See "Regenerating" |
| `concepts/` | The marks that weren't chosen, and `preview.png` of them all | See "Concepts" |

The SVGs need no fonts: the wordmark is converted to outlines. Assistant, Excalidraw's own UI font, is under the SIL
Open Font Licence (from `@fontsource/assistant`), which allows that.

## Colours

All of them are Excalidraw's light-theme tokens, so the brand and the editor agree.

| Name | Hex | Excalidraw token | Where |
|---|---|---|---|
| Violet | `#6965db` | `--color-primary` | The tile, the diagram, the cards' rule and command pill |
| Violet, darkest | `#4a47b1` | `--color-primary-darkest` | Violet text on white (the URL on the cards) |
| Violet, pale | `#f1f0ff` | `--color-surface-high` | The cards' watermark |
| Ink | `#1b1b1f` | `--color-on-surface` | The light lockup's wordmark |

## Usage rules

- **Keep the tile.** The mark is the violet tile with its white folder. Don't recolour it, or set the folder on
  another background, except as the pale watermark on the social cards.
- **Pick the lockup by background**, not by theme name: `lockup-light.svg` on white or pale backgrounds,
  `lockup-dark.svg` on dark ones.
- **Clear space** around the mark is at least a quarter of its width. Don't place it smaller than 16px.
- **No hand-drawn version.** No Excalifont, no sketchy outline, no hachure. Not in the mark, the lockups or anything
  built from them.
- **Violet `#6965db` is for fills and large text.** For small text on white, use the darkest violet, `#4a47b1`.

## Concepts

Three marks were drafted; `folder.svg` was chosen, and `mark.svg` is a copy of it. The others are kept for Ed to
choose from:

- `concepts/folder.svg`: a folder with a diagram in it (**chosen**). It says "a folder of drawings", and its
  silhouette still reads at 16px.
- `concepts/page.svg`: a document with a folded corner, with the diagram on it. "A drawing is a file" but, at 16px,
  it's a generic file icon.
- `concepts/flow.svg`: just the diagram, a box and a diamond joined by an elbow, in white on violet. The boldest at
  small sizes, but it says "diagrams" rather than "your files".

`concepts/preview.png` shows each at 16, 32, 64 and 160px, on light and dark. To switch, copy the concept over
`mark.svg` (keep its comment) and regenerate.

## Regenerating

```sh
node brand/generate.mjs
```

It uses three of the repo's devDependencies (`@resvg/resvg-js`, `opentype.js` and `@fontsource/assistant`), none of
which ship in the package. The output is deterministic, so commit what it writes. Edit `mark.svg` for the mark, and
the constants at the top of `generate.mjs` for the colours, tagline and URL. Then run `npm run sync-brand` in
`website/` to copy the assets into the docs site.
