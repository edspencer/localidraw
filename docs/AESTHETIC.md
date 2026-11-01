# The Excalidraw aesthetic

What Localidraw's own UI has to match. The values below come from Excalidraw 0.18.1's stylesheet
(`@excalidraw/excalidraw/dist/prod/index.css`); read them there rather than guessing. Everything Localidraw adds
should look as if it shipped with Excalidraw.

## Two layers: the drawing is sketched, the chrome isn't

Excalidraw has two visual languages, and keeps them apart.

- **The canvas is hand-drawn.** Shapes are drawn by Rough.js with deliberate wobble ("sloppiness"). Text is in
  Excalifont, a handwriting font. Fills are hachured by default. Colours come from a small fixed palette of strokes,
  each with a matching pale fill (Open Color).
- **The interface is not.** Toolbars, menus, dialogs and sidebars are clean, quiet and modern. They use a plain
  sans-serif (Assistant), flat fills, soft shadows and small rounded corners. Nothing in the chrome wobbles or uses
  the handwriting font.

**The rule for Localidraw:** our UI is chrome. Never use Excalifont, sketchy borders or hachure in it, however
"on-brand" it might seem. The charm belongs to the drawing.

## The shape of the UI: islands on a canvas

- **Islands.** Controls float over the canvas in separate rounded panels (`.Island`): the toolbar top centre, the
  menu top left, zoom and undo bottom left, help bottom right. Each is white (`--island-bg-color`) with
  `--border-radius-lg` (0.5rem) corners and a very soft, layered shadow (`--shadow-island`). They don't touch the
  edges, and there's no app frame, header bar or footer bar. The canvas runs edge to edge.
- **The sidebar is the one exception.** Library and Search live in a full-height panel on the **right**
  (`.sidebar`). It floats over the canvas with a long, soft shadow (`--sidebar-shadow`) and a 1px left border, or
  docks and pushes the canvas over. It has a header row (a title, then dock and close buttons) and tabs. Anything
  that lists things belongs there, as tabs.
- **Sparse.** Few words, small type, generous space. Icons do most of the work, and labels appear only where an icon
  wouldn't be clear (the "Library" trigger shows its label).

## Type

| Use | Font | Size | Weight |
|---|---|---|---|
| All UI text | `--ui-font`: Assistant, then the system sans-serif | — | 400 |
| Menu items, list rows | | 0.875rem (14px) | 400 |
| Small labels, the sidebar trigger | | 0.75rem, letter-spacing 0.4px | 400 |
| Section headers in a sidebar (the Library's "Personal library") | | 1.125rem | 700, in `--color-primary` |
| Tooltips | | 13px | 500, white on black, 6px radius |

## Colour

Light theme values; dark mode is the `.theme--dark` override of each variable, so use the variables, never these hex
values.

| Token | Light | Role |
|---|---|---|
| `--color-primary` | `#6965db` | The one accent: the selected tool, section headers, focus. A soft violet, not a loud blue. |
| `--color-primary-darker` / `-darkest` | `#5b57d1` / `#4a47b1` | Hover and pressed on primary. |
| `--color-primary-light` | `#e3e2fe` | A selected row's background. |
| `--color-surface-high` | `#f1f0ff` | Hover background; the sidebar's border. |
| `--color-surface-low` | `#ececf4` | Inputs, the sidebar trigger's background. |
| `--color-surface-lowest` | `#ffffff` | The plainest surface. |
| `--island-bg-color` | `#ffffff` | Islands and the sidebar. |
| `--color-on-surface` | `#1b1b1f` | Body text. |
| `--color-gray-40` … `-60` | `#b8b8b8` … `#7a7a7a` | Secondary text, keyboard hints, disabled. |
| `--color-gray-20` | `#ebebeb` | Text field borders. |
| `--button-hover-bg` | (per component) | What a hovered row or button fills with. |

The violet accent is used sparingly: one selected thing at a time. Everything else is near-white surfaces and
near-black text.

## Components to copy

- **Rows** (menu items, list entries): `.dropdown-menu-item`. 2rem tall (2.25rem in some menus), padding
  `0 0.5rem`, `--border-radius-md` (0.375rem), 14px text with an optional 1rem icon and a 0.625rem gap. Hover fills
  with `--button-hover-bg`, selected with `--color-primary-light`. No borders or dividers between rows.
- **Text fields**: `.ExcTextField__input`. 3rem tall, `--color-surface-low` background, a 1px `--color-gray-20`
  border, 0.5rem radius, 0.75rem side padding. The border turns `--color-brand-hover` on hover and
  `--color-brand-active` on focus.
- **Icon buttons**: `--default-button-size` (2.25rem) square, `--border-radius-lg`, transparent until hovered.
- **Sidebar header**: 1rem by 0.75rem padding, with a 1px `--sidebar-border-color` rule under it, inset 0.75rem on
  each side.
- **Icons**: outline icons with a 1.25 stroke, 20px (`--lg-icon-size`) in triggers and 16px in rows. Excalidraw
  uses Tabler icons, so new icons should come from Tabler to match.

## In Localidraw

- **Projects and canvases are a sidebar tab**, "Canvases", next to Excalidraw's own Library. It's opened from a
  "Canvases" trigger beside the Library trigger at the top right, and it docks like the Library does. It's built
  from Excalidraw's own `DefaultSidebar`, `Sidebar.TabTrigger` and `Sidebar.Tab`, so the panel, header, tabs, dock
  button and dark mode are Excalidraw's, not a copy of them.
- **Inside the tab**, everything uses the tokens above, scoped under `.excalidraw`:
  - each project is a section header in the Library's style (`--color-primary`, bold), shown as its folder path;
  - canvases are menu rows, with the open one selected;
  - "New canvas" is a row with a plus icon, and naming the new canvas uses a text field in the
    `.ExcTextField` style.
- **The save status** ("Saved", "Saving…", "Updated from disk") sits in Excalidraw's footer, beside the undo
  buttons, in small gray text, as quiet as the rest of the chrome.
- **A notice** that an edit lost to a change on disk sits beside it, as a small island (`--island-bg-color`,
  `--shadow-island`), with a violet text button (**Show**) and a gray close icon. It stays until it's dismissed.
