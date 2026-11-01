# Localidraw docs site

The documentation site for Localidraw, served at **https://localidraw.edspencer.net**: Astro 7 and Starlight 0.42, so
it needs Node 22.12 or later. It's modelled on Local Review's site, with much less in it.

A standalone package: it isn't part of the root `localidraw` package, so it never affects the app's build, tests or
npm tarball. The build tools are in `dependencies`, not `devDependencies`, so a plain `npm install` works even with
`NODE_ENV=production`, which is what Cloudflare's build does.

## Develop

```bash
cd website
npm install
npm run dev                       # a dev server
npm run build && npm run preview  # build, then serve the built site
npm run check-links               # after a build: every internal link and #fragment in dist/ resolves
```

## Structure

- `src/content/docs/`: the pages (`.md` / `.mdx`, with Starlight frontmatter). `index.mdx` is the home page
  (Starlight's splash template).
- `astro.config.mjs`: the site config and **the sidebar, which is maintained by hand**: Starlight doesn't discover
  pages. Add a new page there; `npm test` in the repo root fails on a page missing from it, or an entry without a page.
- `src/site.mjs`: the site's URL, repo, tagline and **the default port**, a copy of `DEFAULT_PORT` in
  `server/port.ts`. MDX pages import it; code blocks can't, so they write the number out. `npm test` in the root
  checks the copy, and every `localhost:` URL in the pages, against `server/port.ts`.
- `src/styles/custom.css`: Excalidraw's violet as the accent, and Assistant, Excalidraw's UI font
  (`@fontsource/assistant`), for text. Nothing hand-drawn ([docs/AESTHETIC.md](../docs/AESTHETIC.md)).
- `scripts/check-links.mjs`: the link checker, with no dependencies. CI runs it.

Link pages site-relative, with the trailing slash: `/agents/`, `/saving-and-merging/#when-it-saves`.

## Brand assets and the GIF

These are **copied** in, not referenced: Cloudflare builds with `website/` as its root directory and can't see the
rest of the repo. Don't edit the copies; change the source, re-run the script and commit.

| From | To | Refreshed by |
| --- | --- | --- |
| `brand/favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `og-image.png` | `public/` | `npm run sync-brand` (here) |
| `brand/lockup-light.svg`, `lockup-dark.svg` | `src/assets/` (the header logo, per theme) | `npm run sync-brand` (here) |
| `docs/media/hero.gif` | `public/demo/hero.gif` (the home page) | `npm run docs:media:hero` (in the root; [tools/docs-media](../tools/docs-media/README.md)) |

## Deploy

Built and served by **Cloudflare Pages** from the GitHub repo (its git integration, no GitHub Actions). Create the
project in the Cloudflare dashboard (Workers & Pages → Create → Pages → Connect to Git) with:

| Setting | Value |
| --- | --- |
| Repository | `edspencer/localidraw` |
| Framework preset | Astro (or None) |
| Production branch | `main` |
| Root directory | `website` |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |
| Node version | 22, read from `website/.node-version` (no setting needed) |
| Environment variables | none |
| Custom domain | `localidraw.edspencer.net` (Custom domains → Set up a domain; Cloudflare adds the CNAME if `edspencer.net` is on Cloudflare DNS) |

Every PR then gets a preview deployment too. CI's "Docs site build" job builds the site and checks its links on any
PR that touches `website/`, so a broken build is caught before it merges.

There are no analytics, no Pages Functions and no secrets.
