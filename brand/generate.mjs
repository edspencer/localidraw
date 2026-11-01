// Generate every derived brand asset from the hand-authored mark (brand/mark.svg):
//
//   lockup-light.svg, lockup-dark.svg   mark + "Localidraw" wordmark (text converted to paths)
//   favicon.svg                         the mark, as is
//   favicon.ico                         16/32/48 (PNG-in-ICO)
//   apple-touch-icon.png                180, full-bleed (iOS rounds the corners itself)
//   icon-192.png, icon-512.png          web manifest icons
//   og-image.png                        1200×630 Open Graph / Twitter card
//   social-preview.png                  1280×640 GitHub social preview
//   concepts/preview.png                every mark in concepts/, at 16 to 160px, on light and dark
//
// Run: `node brand/generate.mjs`. It uses three devDependencies: @resvg/resvg-js, opentype.js and @fontsource/assistant
// (Assistant is Excalidraw's UI font, OFL). All text is converted to paths, so nothing here needs a font installed.
// The output is deterministic, so re-run it and commit the results whenever the mark, colours or tagline change. It
// also copies the favicon into web/ for the app.
import { Resvg } from "@resvg/resvg-js";
import opentype from "opentype.js";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const BRAND = path.dirname(fileURLToPath(import.meta.url));
const out = (name) => path.join(BRAND, name);
const require = createRequire(import.meta.url);

// Brand colours (documented in brand/README.md). The violet is Excalidraw's --color-primary.
const VIOLET = "#6965db";
const VIOLET_DARKEST = "#4a47b1"; // --color-primary-darkest: violet text on white
const VIOLET_PALE = "#f1f0ff"; // --color-surface-high
const INK = "#1b1b1f"; // --color-on-surface
const GREY = "#5c5c66";

const TAGLINE = ["Draw on the .excalidraw files in a folder,", "side by side with your coding agent"];
const COMMAND = "npx localidraw";
const URL_TEXT = "localidraw.edspencer.net";

const markSvg = fs.readFileSync(out("mark.svg"), "utf8");
/** A mark's drawing, without the outer <svg>, title or comments, for nesting into bigger compositions. */
const innerOf = (svg) =>
  svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n\s*\n/g, "\n")
    .trim();
const markInner = innerOf(markSvg);
const nestedMark = (x, y, size, inner = markInner) => `<g transform="translate(${x} ${y}) scale(${size / 32})">${inner}</g>`;

const loadFont = (weight) => {
  const b = fs.readFileSync(require.resolve(`@fontsource/assistant/files/assistant-latin-${weight}-normal.woff`));
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const bold = loadFont(700);
const regular = loadFont(400);
const semibold = loadFont(600);

/** Lay out `text` in `font` as one SVG path (with kerning and optional tracking in em), so the SVG needs no font. */
function textPath(font, text, size, x, baseline, trackingEm = 0) {
  const scale = size / font.unitsPerEm;
  const glyphs = [...text].map((ch) => font.charToGlyph(ch));
  let pen = x;
  const d = [];
  glyphs.forEach((g, i) => {
    // rounded, because opentype.js writes NaN into the path for some positions with a long tail of float error
    d.push(g.getPath(Math.round(pen * 100) / 100, Math.round(baseline * 100) / 100, size).toPathData(2));
    pen += g.advanceWidth * scale + trackingEm * size;
    if (i < glyphs.length - 1) pen += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  return { d: d.join(""), width: pen - x - trackingEm * size };
}
const capHeight = (font, size) => (font.tables.os2.sCapHeight / font.unitsPerEm) * size;

// ---------- lockups ----------
// 48 units tall: the 48×48 mark, a 14-unit gap, then the wordmark with its cap height centred on the mark.
function lockup(textColour) {
  const size = 32;
  const { d, width } = textPath(bold, "Localidraw", size, 62, 24 + capHeight(bold, size) / 2, -0.005);
  const w = Math.ceil(62 + width + 1);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 48" width="${w * 2}" height="96">
  <title>Localidraw</title>
  ${nestedMark(0, 0, 48)}
  <path fill="${textColour}" d="${d}"/>
</svg>
`;
}
fs.writeFileSync(out("lockup-light.svg"), lockup(INK)); // for light backgrounds
fs.writeFileSync(out("lockup-dark.svg"), lockup("#ffffff")); // for dark backgrounds
fs.writeFileSync(out("favicon.svg"), markSvg);
fs.copyFileSync(out("favicon.svg"), path.join(BRAND, "..", "web", "favicon.svg"));

// ---------- raster icons ----------
const render = (svg, width) => new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } }).render().asPng();

const fullBleed = markSvg.replace(/(<rect id="tile"[^>]*?) rx="[\d.]+"/, "$1");
fs.writeFileSync(out("apple-touch-icon.png"), render(fullBleed, 180));
fs.writeFileSync(out("icon-192.png"), render(markSvg, 192));
fs.writeFileSync(out("icon-512.png"), render(markSvg, 512));

// favicon.ico: an ICONDIR followed by one PNG per size (PNG entries are valid ICO since Windows Vista).
const icoSizes = [16, 32, 48];
const pngs = icoSizes.map((s) => render(markSvg, s));
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(icoSizes[i], e); // width
  header.writeUInt8(icoSizes[i], e + 1); // height
  header.writeUInt8(0, e + 2); // palette colours
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.writeFileSync(out("favicon.ico"), Buffer.concat([header, ...pngs]));

// ---------- social cards ----------
// White, like Excalidraw's canvas, with a faint dot grid, a violet rule along the bottom and a large pale copy of the
// mark's folder bleeding off the right edge. The lockup, tagline, command and URL are on the left. Everything scales
// from the card's height.
function card(W, H) {
  const k = H / 630;
  const pad = Math.round(88 * k);
  const markSize = Math.round(124 * k);
  const titleSize = Math.round(104 * k);
  const titleY = Math.round(220 * k);
  const title = textPath(bold, "Localidraw", titleSize, pad + markSize + Math.round(32 * k), titleY, -0.01);
  const taglineSize = Math.round(42 * k);
  const tagline = TAGLINE.map((line, i) => textPath(regular, line, taglineSize, pad, Math.round((348 + 56 * i) * k)));
  const pillH = Math.round(56 * k);
  const pillY = Math.round(482 * k);
  const cmdSize = Math.round(28 * k);
  const cmd = textPath(semibold, COMMAND, cmdSize, 0, 0);
  const pillW = Math.round(cmd.width + 48 * k);
  const cmdPath = textPath(semibold, COMMAND, cmdSize, pad + (pillW - cmd.width) / 2, pillY + pillH / 2 + capHeight(semibold, cmdSize) / 2);
  const url = textPath(semibold, URL_TEXT, cmdSize, pad + pillW + Math.round(28 * k), pillY + pillH / 2 + capHeight(semibold, cmdSize) / 2);
  // the watermark: the folder alone (no tile, no diagram), huge and pale
  const folderOnly = markInner.replace(/<rect id="tile"[^>]*\/>/, "").replace(/<(rect|path)[^>]*#6965db[^>]*\/>/g, "").replace(/#ffffff/g, VIOLET_PALE);
  const wm = Math.round(600 * k);
  const dot = Math.round(28 * k);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><pattern id="dots" width="${dot}" height="${dot}" patternUnits="userSpaceOnUse"><circle cx="${dot / 2}" cy="${dot / 2}" r="${1.4 * k}" fill="#dddcf3"/></pattern></defs>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect width="${W}" height="${H}" fill="url(#dots)"/>
  ${nestedMark(W - wm * 0.6, H * 0.08, wm, folderOnly)}
  <rect y="${H - Math.round(14 * k)}" width="${W}" height="${Math.round(14 * k)}" fill="${VIOLET}"/>
  ${nestedMark(pad, titleY - capHeight(bold, titleSize) / 2 - markSize / 2, markSize)}
  <path fill="${INK}" d="${title.d}"/>
  ${tagline.map((t) => `<path fill="${GREY}" d="${t.d}"/>`).join("\n  ")}
  <rect x="${pad}" y="${pillY}" width="${pillW}" height="${pillH}" rx="${Math.round(10 * k)}" fill="${VIOLET}"/>
  <path fill="#ffffff" d="${cmdPath.d}"/>
  <path fill="${VIOLET_DARKEST}" d="${url.d}"/>
</svg>`;
}
fs.writeFileSync(out("og-image.png"), render(card(1200, 630), 1200));
fs.writeFileSync(out("social-preview.png"), render(card(1280, 640), 1280));

// ---------- the concepts, side by side ----------
const concepts = fs.readdirSync(out("concepts")).filter((f) => f.endsWith(".svg")).sort();
const sizes = [16, 32, 64, 160];
const colW = sizes.reduce((a, s) => a + s + 12, 0) + 40;
const labelSize = 18;
const parts = [];
concepts.forEach((file, c) => {
  const inner = innerOf(fs.readFileSync(out(`concepts/${file}`), "utf8"));
  [
    ["#ffffff", INK],
    ["#121212", "#e3e3e8"],
  ].forEach(([bg, fg], row) => {
    const y0 = row * 240;
    if (c === 0) parts.push(`<rect y="${y0}" width="${colW * concepts.length}" height="240" fill="${bg}"/>`);
    let x = c * colW + 24;
    for (const s of sizes) {
      parts.push(nestedMark(x, y0 + 52, s, inner));
      x += s + 12;
    }
    parts.push(`<path fill="${fg}" d="${textPath(semibold, file.replace(/\.svg$/, ""), labelSize, c * colW + 24, y0 + 32).d}"/>`);
  });
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${colW * concepts.length}" height="480">${parts.join("")}</svg>`;
fs.writeFileSync(out("concepts/preview.png"), render(sheet, colW * concepts.length));

console.log(
  "Wrote brand/: lockup-light.svg lockup-dark.svg favicon.svg favicon.ico apple-touch-icon.png icon-192.png icon-512.png og-image.png social-preview.png concepts/preview.png, and web/favicon.svg",
);
