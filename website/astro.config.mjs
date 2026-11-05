// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { SITE_URL, REPO_URL, TITLE, TAGLINE } from './src/site.mjs';

// https://astro.build/config
export default defineConfig({
	site: SITE_URL,
	// Astro 7's default, 'jsx', strips whitespace between elements, which glues inline text together. `true` keeps
	// the HTML-aware rules.
	compressHTML: true,
	integrations: [
		sitemap(),
		starlight({
			title: TITLE,
			description: TAGLINE,
			customCss: ['@fontsource/assistant/400.css', '@fontsource/assistant/600.css', '@fontsource/assistant/700.css', './src/styles/custom.css'],
			// Brand assets are COPIED from ../brand by `npm run sync-brand` (Cloudflare builds with website/ as its root,
			// so ../brand is out of reach). The header follows the theme, so it gets the lockup for each background.
			logo: {
				light: './src/assets/lockup-light.svg',
				dark: './src/assets/lockup-dark.svg',
				alt: TITLE,
				replacesTitle: true,
			},
			favicon: '/favicon.svg',
			head: [
				// .ico fallback for the browsers and crawlers that ignore SVG icons.
				{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
				// Social-share image. Starlight already emits per-page og:title, og:description, og:url and
				// twitter:card=summary_large_image, and a `head` entry here would override those, so only the image is
				// added.
				{ tag: 'meta', attrs: { property: 'og:image', content: `${SITE_URL}/og-image.png` } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: `${TITLE}: ${TAGLINE}` } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE_URL}/og-image.png` } },
			],
			social: [{ icon: 'github', label: 'GitHub', href: REPO_URL }],
			editLink: {
				baseUrl: `${REPO_URL}/edit/main/website/`,
			},
			// Hand-maintained: Starlight does NOT auto-discover pages. Add new ones here (test/docs.test.ts checks).
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Getting started', slug: 'getting-started' },
						{ label: 'The Canvases sidebar', slug: 'canvases' },
						{ label: 'The Library', slug: 'library' },
					],
				},
				{
					label: 'How it works',
					items: [
						{ label: 'Saving and merging', slug: 'saving-and-merging' },
						{ label: 'Working with coding agents', slug: 'agents' },
					],
				},
				{
					label: 'Running it',
					items: [
						{ label: 'Running as a service', slug: 'service' },
						{ label: 'Self-hosting', slug: 'self-hosting' },
						{ label: 'Updating', slug: 'updating' },
					],
				},
				{ label: 'FAQ', slug: 'faq' },
			],
		}),
	],
});
