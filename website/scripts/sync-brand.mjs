// Copies the brand kit from ../brand into this site.
//
// Cloudflare Pages builds with `website/` as the root directory, so the site can't reference ../brand at build time:
// the assets are COPIED in and committed. Run this after brand/ changes (`npm run sync-brand`), then commit.
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const brand = join(site, '..', 'brand');

const copies = {
	'favicon.svg': 'public/favicon.svg',
	'favicon.ico': 'public/favicon.ico',
	'apple-touch-icon.png': 'public/apple-touch-icon.png',
	'og-image.png': 'public/og-image.png',
	'lockup-light.svg': 'src/assets/lockup-light.svg',
	'lockup-dark.svg': 'src/assets/lockup-dark.svg',
};
for (const [from, to] of Object.entries(copies)) {
	copyFileSync(join(brand, from), join(site, to));
	console.log(`brand/${from} -> website/${to}`);
}
