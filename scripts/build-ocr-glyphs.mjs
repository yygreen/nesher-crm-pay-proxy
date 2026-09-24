/**
 * Builds ocr-glyphs.json: the ten digits of each card font as 28x32 ink maps
 * for the glyph matcher (ocr-glyphs.js). Run on a machine that has the fonts
 * (Joseph's Windows PC); the output is committed, the container needs no fonts.
 *
 *   node scripts/build-ocr-glyphs.mjs <farrington7b.ttf>
 *
 * Farrington 7B (the embossed-card font) is the GPL-3.0 build from
 * github.com/bcssupp0rt/farrington-7B-Font, kept in test/fonts/ with its licence.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { GW, GH, frameGlyph } from "../ocr-glyphs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = "C:/Windows/Fonts/";
const farrington = process.argv[2] || path.join(HERE, "..", "test", "fonts", "Farrington7B.ttf");

export const TEMPLATE_FONTS = [
  { name: "farrington7b", file: farrington, font: "Farrington 7B" },
  { name: "ocr-a", file: WIN + "OCRAEXT.TTF", font: "OCR A Extended" },
  { name: "consolas", file: WIN + "consola.ttf", font: "Consolas" },
  { name: "courier", file: WIN + "cour.ttf", font: "Courier New" },
  { name: "arial", file: WIN + "arial.ttf", font: "Arial" },
  { name: "arial-bold", file: WIN + "arialbd.ttf", font: "Arial Bold" },
  { name: "arial-narrow", file: WIN + "ARIALN.TTF", font: "Arial Narrow" },
  { name: "verdana", file: WIN + "verdana.ttf", font: "Verdana" },
  { name: "bahnschrift", file: WIN + "bahnschrift.ttf", font: "Bahnschrift" },
  { name: "georgia", file: WIN + "georgia.ttf", font: "Georgia" },
  { name: "segoe", file: WIN + "segoeui.ttf", font: "Segoe UI" },
  { name: "calibri", file: WIN + "calibri.ttf", font: "Calibri" },
  { name: "lucida-console", file: WIN + "lucon.ttf", font: "Lucida Console" },
  { name: "trebuchet", file: WIN + "trebuc.ttf", font: "Trebuchet MS" },
];

async function digitInk(f, d) {
  const r = await sharp({ text: { text: `<span size="96pt">${d}</span>`, fontfile: f.file, font: f.font, dpi: 72, rgba: true } })
    .extend({ top: 10, bottom: 10, left: 10, right: 10, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .extractChannel(3)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = r.info;
  const ink = Uint8Array.from(r.data, (v) => (v >= 128 ? 255 : 0));
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (ink[y * w + x]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { ink, w, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

const fonts = [];
for (const f of TEMPLATE_FONTS) {
  if (!fs.existsSync(f.file)) { console.log("skip (no font file):", f.name); continue; }
  const glyphs = [];
  for (let d = 0; d < 10; d += 1) glyphs.push(await digitInk(f, d));
  // One height per font (the row height the reader uses): the median digit height, centred.
  const hs = glyphs.map((g) => g.box.h).sort((a, b) => a - b);
  const H = hs[5];
  const digits = glyphs.map((g) => {
    const cy = g.box.y + g.box.h / 2;
    const box = { x: g.box.x, y: Math.round(cy - H / 2), w: g.box.w, h: H };
    return Buffer.from(frameGlyph(g.ink, g.w, box)).toString("base64");
  });
  fonts.push({ name: f.name, digits });
  console.log("font", f.name, "digit height", H);
}
const out = { built: new Date().toISOString().slice(0, 10), w: GW, h: GH, fonts };
fs.writeFileSync(path.join(HERE, "..", "ocr-glyphs.json"), JSON.stringify(out));
console.log("wrote ocr-glyphs.json fonts", fonts.length);
