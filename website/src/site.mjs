// @ts-check
/**
 * Site-wide constants, in one place.
 *
 * Plain .mjs rather than .ts because astro.config.mjs imports it too, and the config is loaded before any TypeScript
 * tooling is in play.
 */

export const SITE_URL = 'https://localidraw.edspencer.net';
export const REPO_URL = 'https://github.com/edspencer/localidraw';
export const TITLE = 'Localidraw';
export const TAGLINE = 'A local Excalidraw for the .excalidraw files in a folder';

/**
 * The port Localidraw serves on by default.
 *
 * A copy of DEFAULT_PORT in server/port.ts (3729 spells "DRAW" on a phone keypad). It can't be imported from there:
 * Cloudflare builds with website/ as its root, so ../server is out of reach. MDX pages import it; code blocks can't,
 * so they write the number out. test/docs.test.ts checks this constant, and every localhost URL in these pages,
 * against server/port.ts.
 */
export const DEFAULT_PORT = 3729;
export const LOCAL_URL = `http://localhost:${DEFAULT_PORT}`;
