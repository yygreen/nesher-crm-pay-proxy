/**
 * The HARD card set (Joseph, 24 Sep: "get them different very difficult
 * examples of reading ... you should be able to read them all").
 *
 * Every number here is a published TEST number or a generated Luhn-valid test
 * number. Names are invented. Nothing here is a real card. Images are rendered
 * in memory at run time with sharp, never written to disk, never committed.
 *
 * Each item: { id, cat, buffer, contentType, pan, expiry, name, expect }
 *   expect "read"   - the full number must come back exactly
 *   expect "refuse" - the number is not all visible; any number returned is WRONG
 *   expect "either" - two cards: the clearer one, or an honest "two cards" refusal
 */

import sharp from "sharp";
import { seeded, luhnCheckDigit } from "./ocr-fixtures.js";

export const TEST_PANS = [
  "4111111111111111",
  "5555555555554444",
  "378282246310005",
  "6011111111111117",
  "4012888888881881",
  "5105105105105100",
  "371449635398431",
  "4242424242424242",
  "2223003122003222",
  "6011000990139424",
  "4000056655665556",
  "5200828282828210",
  "6011981111111113",
  "4000000760000002",
  "340000000000009",
];

const NAMES = [
  "AVROHOM COHEN", "MIRIAM SCHWARTZ", "YOSEF FRIEDMAN", "CHAYA WEISS", "SHMUEL GOLDBERG",
  "RIVKA KLEIN", "MENACHEM STERN", "ESTHER ROSENBERG", "DOVID KATZ", "LEAH GREENFIELD",
  "BINYOMIN LANDAU", "SARA HOROWITZ", "NAFTALI BRAUN", "GITTY HERSKOVITS", "ELIEZER PORTNOY",
];

export function groupPan(pan) {
  if (pan.length === 15) return `${pan.slice(0, 4)} ${pan.slice(4, 10)} ${pan.slice(10)}`;
  return pan.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function randomPan(rand, kind) {
  const pre = kind === "amex" ? (rand() < 0.5 ? "34" : "37")
    : kind === "mc" ? `5${1 + Math.floor(rand() * 5)}`
    : kind === "disc" ? "6011"
    : "4";
  const len = kind === "amex" ? 15 : 16;
  let s = pre;
  while (s.length < len - 1) s += String(Math.floor(rand() * 10));
  return s + luhnCheckDigit(s);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const FONTS = {
  mono: "Courier New, monospace",
  ocra: "OCR A Extended, OCR A Std, Courier New, monospace",
  consolas: "Consolas, Courier New, monospace",
  sans: "Arial, Liberation Sans, sans-serif",
  narrow: "Arial Narrow, Arial, sans-serif",
  bahn: "Bahnschrift, Arial, sans-serif",
  verdana: "Verdana, sans-serif",
  georgia: "Georgia, serif",
  hand: "Segoe Print, Ink Free, Comic Sans MS, cursive",
  hand2: "Ink Free, Segoe Script, Comic Sans MS, cursive",
};

const PALETTES = {
  navy: { bg: "#1a3d8f", bg2: "#0b1d4a", fg: "#f4f4f4", logo: "#ffffff" },
  black: { bg: "#151515", bg2: "#050505", fg: "#d9d9d9", logo: "#bbbbbb" },
  blackgold: { bg: "#1b1b1b", bg2: "#0a0a0a", fg: "#c9a55a", logo: "#c9a55a" },
  metal: { bg: "#b9bcc0", bg2: "#7d8187", fg: "#3a3d42", logo: "#2c2f33", metal: true },
  darkmetal: { bg: "#55595f", bg2: "#2a2d31", fg: "#c7cad0", logo: "#e0e0e0", metal: true },
  white: { bg: "#fbfbfb", bg2: "#e9e9e9", fg: "#9b9b9b", logo: "#b0b0b0" },
  pearl: { bg: "#f3efe6", bg2: "#e4dccb", fg: "#b9ad93", logo: "#c7b88f" },
  green: { bg: "#2e7d6f", bg2: "#14403a", fg: "#ffffff", logo: "#dfeeea" },
  red: { bg: "#8c1c24", bg2: "#3d0a0f", fg: "#f7e9e9", logo: "#ffd27a" },
  sky: { bg: "#8fc3ea", bg2: "#4f8fc4", fg: "#0d2a45", logo: "#0d2a45" },
  purple: { bg: "#4a2c6e", bg2: "#1e1030", fg: "#efe6ff", logo: "#ffb347" },
  orange: { bg: "#f08a24", bg2: "#b8520b", fg: "#1c1c1c", logo: "#1c1c1c" },
  // White on white (25 Sep): the digits are the card's own colour; only the raised edge shows.
  snow: { bg: "#f6f6f4", bg2: "#e2e2de", fg: "#ecece8", logo: "#c4c4c0" },
  ivory: { bg: "#f4f0e6", bg2: "#e0d8c6", fg: "#ebe5d6", logo: "#c9bda0" },
};

/**
 * One card face (front, back or vertical) as SVG.
 * layout: "front" | "back" | "vertical" | "vertical2" (number on two lines)
 */
export function cardSvg(o) {
  const p = PALETTES[o.palette || "navy"];
  const portrait = o.layout === "vertical" || o.layout === "vertical2";
  const W = portrait ? 638 : 1011;
  const H = portrait ? 1011 : 638;
  const ls = o.letterSpacing ?? (o.pan.length === 15 ? 5 : 4);
  const fontNum = FONTS[o.font || "mono"];
  const weight = o.bold ? "bold" : "normal";
  const fg = o.fg || p.fg;
  const emb = (x, y, size, s, fam, w = "normal", fill = fg, spacing = ls) => {
    const t = (dx, dy, f, op) => `<text x="${x + dx}" y="${y + dy}" font-family="${fam}" font-size="${size}" font-weight="${w}" fill="${f}" fill-opacity="${op}" letter-spacing="${spacing}">${esc(s)}</text>`;
    const shadow = o.embossOp ? o.embossOp.shadow : 0.55;
    const light = o.embossOp ? o.embossOp.light : 0.55;
    return o.embossed ? t(2, 3, "#000", shadow) + t(-1, -1, "#fff", light) + t(0, 0, fill, 1) : t(0, 0, fill, 1);
  };
  const metal = p.metal
    ? `<pattern id="brush" width="6" height="${H}" patternUnits="userSpaceOnUse"><rect width="3" height="${H}" fill="#fff" fill-opacity="0.07"/><rect x="3" width="1" height="${H}" fill="#000" fill-opacity="0.06"/></pattern><rect width="${W}" height="${H}" rx="40" fill="url(#brush)"/>`
    : "";
  const chip = (x, y) => `<rect x="${x}" y="${y}" width="122" height="92" rx="14" fill="#d9b44a"/><rect x="${x + 16}" y="${y + 16}" width="90" height="60" rx="8" fill="none" stroke="#8a6d1f" stroke-width="3"/>`;
  const grouped = groupPan(o.pan);
  const expLabel = o.expLabel ?? "VALID THRU ";
  let body = "";
  if (o.layout === "back") {
    body += `<rect y="60" width="${W}" height="120" fill="#111"/>`;
    body += `<rect x="60" y="220" width="620" height="80" fill="#f2f2f2"/><text x="700" y="275" font-family="${FONTS.sans}" font-size="34" fill="${fg}">${o.cvvShown ? "123" : ""}</text>`;
    body += emb(60, 380, 48, grouped, fontNum, weight);
    body += emb(60, 440, 30, `${expLabel}${o.expiry}`, FONTS.sans);
    body += emb(60, 495, 32, o.name, FONTS.sans);
    body += `<text x="60" y="560" font-family="${FONTS.sans}" font-size="18" fill="${fg}" fill-opacity="0.8">Customer service 1-800-432-1000  Lost or stolen 1-302-594-8200  Ref 2026 0923 1187</text>`;
    body += `<text x="60" y="590" font-family="${FONTS.sans}" font-size="18" fill="${fg}" fill-opacity="0.8">Issued by Test Bank N.A. pursuant to a license. Member FDIC. 800 555 0101</text>`;
  } else if (portrait) {
    body += chip(420, 120);
    body += `<text x="60" y="110" font-family="${FONTS.sans}" font-size="34" font-weight="bold" fill="${p.logo}">${esc(o.label || "BANK")}</text>`;
    if (o.layout === "vertical2") {
      const g = grouped.split(" ");
      const a = g.length === 3 ? `${g[0]} ${g[1]}` : `${g[0]} ${g[1]}`;
      const b = g.length === 3 ? g[2] : `${g[2]} ${g[3]}`;
      body += emb(60, 640, 62, a, fontNum, weight);
      body += emb(60, 720, 62, b, fontNum, weight);
    } else {
      body += emb(50, 680, o.pan.length === 15 ? 46 : 44, grouped, fontNum, weight, fg, 2);
    }
    body += emb(60, 800, 30, `${expLabel}${o.expiry}`, FONTS.sans);
    body += emb(60, 870, 34, o.name, FONTS.sans);
    body += `<text x="360" y="960" font-family="${FONTS.sans}" font-size="44" font-weight="bold" fill="${p.logo}">${esc(o.brand || "VISA")}</text>`;
  } else {
    body += chip(80, 150);
    body += `<text x="820" y="80" font-family="${FONTS.sans}" font-size="30" fill="${fg}" fill-opacity="0.85">${esc(o.label || "DEBIT")}</text>`;
    const size = o.numSize || (o.pan.length === 15 ? 74 : 70);
    body += emb(80, o.numY || 372, size, grouped, fontNum, weight);
    if (o.expFirst) body += emb(80, 540, 30, `${expLabel}${o.expiry}`, FONTS.sans);
    else body += emb(80, 440, 28, `${expLabel}${o.expiry}`, FONTS.sans);
    body += emb(80, o.expFirst ? 470 : 540, 40, o.name, FONTS.sans);
    body += `<text x="${(o.brand || "VISA").length > 8 ? 620 : 800}" y="590" font-family="${FONTS.sans}" font-size="44" font-weight="bold" fill="${p.logo}">${esc(o.brand || "VISA")}</text>`;
  }
  return {
    W, H,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.bg}"/><stop offset="1" stop-color="${p.bg2}"/></linearGradient>${metal ? "" : ""}</defs>
<rect width="${W}" height="${H}" rx="40" fill="url(#bg)"/>
${metal ? metal.replace("<pattern", "<defs><pattern").replace("</pattern>", "</pattern></defs>") : `<circle cx="${W - 150}" cy="120" r="260" fill="#ffffff" fill-opacity="0.06"/>`}
${body}
</svg>`,
  };
}

async function faceRgba(o) {
  const { svg, W, H } = cardSvg(o);
  const buf = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: buf.data, width: buf.info.width, height: buf.info.height, W, H };
}

// ── pixel helpers ───────────────────────────────────────────────────────────

function solve8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography h (8 values) mapping points `from` -> `to` (4 corners each). */
function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve8(A, b);
}

/** Warp an RGBA source into a dst canvas (RGBA, transparent) so its corners land on `quad`. */
function warpInto(src, sw, sh, dst, dw, dh, quad) {
  const h = homography(quad, [[0, 0], [sw - 1, 0], [sw - 1, sh - 1], [0, sh - 1]]);
  const xs = quad.map((q) => q[0]);
  const ys = quad.map((q) => q[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(dw - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(dh - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = h[6] * x + h[7] * y + 1;
      const sx = (h[0] * x + h[1] * y + h[2]) / d;
      const sy = (h[3] * x + h[4] * y + h[5]) / d;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const ix1 = Math.min(sw - 1, ix + 1);
      const iy1 = Math.min(sh - 1, iy + 1);
      const o = (y * dw + x) * 4;
      const a = src[(iy * sw + ix) * 4 + 3] * (1 - fx) * (1 - fy) + src[(iy * sw + ix1) * 4 + 3] * fx * (1 - fy) +
        src[(iy1 * sw + ix) * 4 + 3] * (1 - fx) * fy + src[(iy1 * sw + ix1) * 4 + 3] * fx * fy;
      const alpha = a / 255;
      if (alpha <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const v = src[(iy * sw + ix) * 4 + c] * (1 - fx) * (1 - fy) + src[(iy * sw + ix1) * 4 + c] * fx * (1 - fy) +
          src[(iy1 * sw + ix) * 4 + c] * (1 - fx) * fy + src[(iy1 * sw + ix1) * 4 + c] * fx * fy;
        dst[o + c] = Math.round(dst[o + c] * (1 - alpha) + v * alpha);
      }
      dst[o + 3] = 255;
    }
  }
}

function scene(kind, w, h, rand) {
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r;
      let g;
      let b;
      if (kind === "wood") {
        const t = Math.sin(x / 9 + Math.sin(y / 60) * 3) * 0.5 + 0.5;
        r = 120 + 60 * t; g = 80 + 40 * t; b = 45 + 20 * t;
      } else if (kind === "check") {
        const on = ((Math.floor(x / 40) + Math.floor(y / 40)) & 1) === 1;
        r = on ? 200 : 60; g = on ? 60 : 60; b = on ? 60 : 180;
      } else if (kind === "cloth") {
        const t = ((x * 7 + y * 13) % 17) / 17;
        r = 70 + 50 * t; g = 110 + 40 * t; b = 90 + 30 * t;
      } else if (kind === "paper") {
        const line = y % 48 === 0 ? -60 : 0;
        r = 244 + line * 0.2; g = 240 + line * 0.5; b = 226 + line;
      } else if (kind === "dark") {
        r = 30; g = 28; b = 26;
      } else {
        r = 205; g = 205; b = 200;
      }
      const n = (rand() - 0.5) * 14;
      const o = (y * w + x) * 4;
      d[o] = Math.max(0, Math.min(255, r + n));
      d[o + 1] = Math.max(0, Math.min(255, g + n));
      d[o + 2] = Math.max(0, Math.min(255, b + n));
      d[o + 3] = 255;
    }
  }
  return d;
}

/** Place a card face on a scene. quad = four destination corners (tl, tr, br, bl). */
async function composite({ faces, w = 1600, h = 1200, bg = "table", rand }) {
  const canvas = scene(bg, w, h, rand);
  for (const f of faces) {
    const src = f.face;
    warpInto(src.data, src.width, src.height, canvas, w, h, f.quad);
  }
  return { data: canvas, width: w, height: h };
}

function rectQuad(cx, cy, cw, ch, deg = 0) {
  const a = (deg * Math.PI) / 180;
  const pts = [[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]];
  return pts.map(([x, y]) => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]);
}

/** A tilted (perspective) quad: the far edge shrinks by `k`, turned about the vertical or horizontal axis. */
function tiltQuad(cx, cy, cw, ch, k, axis = "y", roll = 0) {
  let q;
  if (axis === "y") q = [[cx - cw / 2, cy - ch / 2], [cx + cw / 2, cy - (ch / 2) * k], [cx + cw / 2, cy + (ch / 2) * k], [cx - cw / 2, cy + ch / 2]];
  else q = [[cx - (cw / 2) * k, cy - ch / 2], [cx + (cw / 2) * k, cy - ch / 2], [cx + cw / 2, cy + ch / 2], [cx - cw / 2, cy + ch / 2]];
  if (!roll) return q;
  const a = (roll * Math.PI) / 180;
  return q.map(([x, y]) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]);
}

function effect(img, fx, rand) {
  const { data, width: w, height: h } = img;
  if (fx.shade) {
    // Uneven light: one lamp off to the side, falling off across the card (lo at distance r and beyond).
    const { cx, cy, r, lo, hi } = fx.shade;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const k = hi - (hi - lo) * Math.min(1, Math.hypot(x - cx, y - cy) / r);
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c += 1) data[o + c] = Math.round(data[o + c] * k);
      }
    }
  }
  if (fx.dark) {
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c += 1) data[i + c] = Math.max(0, Math.min(255, data[i + c] * fx.dark + (rand() - 0.5) * (fx.noise || 0) * 2));
    }
  } else if (fx.noise) {
    for (let i = 0; i < data.length; i += 4) {
      const n = (rand() - 0.5) * fx.noise * 2;
      for (let c = 0; c < 3; c += 1) data[i + c] = Math.max(0, Math.min(255, data[i + c] + n));
    }
  }
  if (fx.moire) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 4;
        const m = 0.78 + 0.22 * Math.sin((x * 0.9 + y * 0.35));
        const sub = x % 3;
        for (let c = 0; c < 3; c += 1) data[o + c] = Math.min(255, data[o + c] * m * (c === sub ? 1.08 : 0.92));
      }
    }
  }
  if (fx.glare) {
    // A bright streak (a lamp on a glossy card): a soft band across the number line.
    const { x0, y0, x1, y1, width: gw = 70, strength = 0.85 } = fx.glare;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dist = Math.abs(dy * x - dx * y + x1 * y0 - y1 * x0) / len;
        if (dist > gw) continue;
        const t = strength * (1 - dist / gw) ** 1.5;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c += 1) data[o + c] = Math.round(data[o + c] * (1 - t) + 255 * t);
      }
    }
  }
  if (fx.finger) {
    const { cx, cy, rx, ry } = fx.finger;
    for (let y = Math.max(0, cy - ry); y < Math.min(h, cy + ry); y += 1) {
      for (let x = Math.max(0, cx - rx); x < Math.min(w, cx + rx); x += 1) {
        const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (e > 1) continue;
        const o = (y * w + x) * 4;
        const shade = 1 - 0.25 * e;
        data[o] = 224 * shade; data[o + 1] = 172 * shade; data[o + 2] = 140 * shade;
      }
    }
  }
  return img;
}

async function encode(img, enc) {
  let s = sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } });
  if (enc.blur) s = s.blur(enc.blur);
  if (enc.resize) s = s.resize({ width: enc.resize });
  if (enc.rotate) s = s.rotate(enc.rotate);
  s = s.removeAlpha();
  if (enc.format === "png") return { buffer: await s.png().toBuffer(), contentType: "image/png" };
  if (enc.format === "webp") return { buffer: await s.webp({ quality: 80 }).toBuffer(), contentType: "image/webp" };
  if (enc.format === "heif") return { buffer: await s.heif({ compression: "av1", quality: 60 }).toBuffer(), contentType: "image/heif" };
  let js = s.jpeg({ quality: enc.quality || 88 });
  if (enc.orientation) js = js.withMetadata({ orientation: enc.orientation });
  return { buffer: await js.toBuffer(), contentType: "image/jpeg" };
}

/** A one-page PDF with the JPEG as its only image (how a scanner or "print to PDF" of a photo looks). */
export function pdfWithJpeg(jpeg, w, h) {
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1"); parts.push(buf); len += buf.length; };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); push(body); push("\nendobj\n"); };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  push(jpeg);
  push("\nendstream\nendobj\n");
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  let x = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) x += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

/** A banking-app screenshot: a phone screen with the card details as text. */
function appSvg({ pan, expiry, name, dark }) {
  const bg = dark ? "#0f1115" : "#ffffff";
  const fg = dark ? "#f1f1f1" : "#111111";
  const mute = dark ? "#9aa0a6" : "#6b6f76";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="2532">
<rect width="1170" height="2532" fill="${bg}"/>
<text x="60" y="130" font-family="${FONTS.sans}" font-size="44" fill="${fg}">9:41</text>
<text x="1000" y="130" font-family="${FONTS.sans}" font-size="44" fill="${fg}">87%</text>
<text x="60" y="300" font-family="${FONTS.sans}" font-size="72" font-weight="bold" fill="${fg}">Card details</text>
<rect x="60" y="380" width="1050" height="640" rx="50" fill="${dark ? "#2b3a67" : "#1a3d8f"}"/>
<text x="120" y="480" font-family="${FONTS.sans}" font-size="48" fill="#fff">Everyday Checking ...${pan.slice(-4)}</text>
<text x="60" y="1200" font-family="${FONTS.sans}" font-size="40" fill="${mute}">Card number</text>
<text x="60" y="1280" font-family="${FONTS.sans}" font-size="60" fill="${fg}">${groupPan(pan)}</text>
<text x="60" y="1420" font-family="${FONTS.sans}" font-size="40" fill="${mute}">Expiration date</text>
<text x="60" y="1500" font-family="${FONTS.sans}" font-size="60" fill="${fg}">${expiry}</text>
<text x="60" y="1640" font-family="${FONTS.sans}" font-size="40" fill="${mute}">Name on card</text>
<text x="60" y="1720" font-family="${FONTS.sans}" font-size="60" fill="${fg}">${name}</text>
<text x="60" y="1860" font-family="${FONTS.sans}" font-size="40" fill="${mute}">Available credit $4,210.55 of $10,000.00</text>
<text x="60" y="1940" font-family="${FONTS.sans}" font-size="40" fill="${mute}">Last payment 09/12/2026  Call 1-800-935-9935</text>
</svg>`;
}

function handSvg({ pan, expiry, name, font }) {
  const g = groupPan(pan).split(" ");
  let x = 90;
  const parts = g.map((grp, i) => {
    const rot = (i % 2 ? -2.5 : 2) ;
    const t = `<text x="${x}" y="${330 + (i % 2) * 8}" transform="rotate(${rot} ${x} 330)" font-family="${FONTS[font]}" font-size="78" fill="#1b2a6b">${grp}</text>`;
    x += grp.length * 50 + 60;
    return t;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1300" height="700">
<rect width="1300" height="700" fill="#f7f3e6"/>
${Array.from({ length: 13 }, (_, i) => `<line x1="0" y1="${60 + i * 52}" x2="1300" y2="${60 + i * 52}" stroke="#9ec3e6" stroke-width="2"/>`).join("")}
<text x="90" y="200" font-family="${FONTS[font]}" font-size="54" fill="#1b2a6b">card for the hotel</text>
${parts}
<text x="90" y="470" font-family="${FONTS[font]}" font-size="60" fill="#1b2a6b">exp ${expiry}</text>
<text x="90" y="590" font-family="${FONTS[font]}" font-size="60" fill="#1b2a6b">${name}</text>
</svg>`;
}

// ── the set ─────────────────────────────────────────────────────────────────

export function expiryAhead(now, years, month) {
  const y = now.getUTCFullYear() + years;
  return `${String(month).padStart(2, "0")}/${String(y % 100).padStart(2, "0")}`;
}

/**
 * HELD_OUT_PANS: published test numbers the thresholds were never tuned on (Gabbai C5, 25 Sep).
 * buildHardSet({ heldOut: true }) swaps the list AND the seed, so every random number changes too.
 */
export const HELD_OUT_PANS = [
  "4000000000003220", "4000002500003155", "4000003720000278", "2223000048400011",
  "378734493671000", "4000000000000077", "4000000000000093", "4000000000000341",
  "4000000000009995", "5454545454545454", "6011000400000000", "4917610000000000",
  "5425233430109903", "374245455400126", "4263982640269299",
];

export async function buildHardSet({ now = new Date(), seed = 20260924, only = null, heldOut = false } = {}) {
  const PANS = heldOut ? HELD_OUT_PANS : TEST_PANS;
  if (heldOut) seed = 777001;
  const rand = seeded(seed);
  const baseRand = rand;
  const items = [];
  let n = 0;
  let panI = 0;
  const nextPan = (kind) => (kind ? randomPan(rand, kind) : PANS[panI++ % PANS.length]);
  const person = () => NAMES[Math.floor(rand() * NAMES.length)];
  const exp = () => expiryAhead(now, 1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 12));
  const brandOfPan = (pan) => (pan[0] === "4" ? "VISA" : pan[0] === "3" ? "AMERICAN EXPRESS" : pan[0] === "6" ? "DISCOVER" : "mastercard");

  /**
   * add(cat, spec): spec.card (face options), spec.place ("flat"|"scene"|"tilt"|"two"|...),
   * spec.fx (pixel effects), spec.enc (encoding), spec.expect.
   */
  const add = async (cat, spec) => {
    if (only && !only.includes(cat)) return;
    n += 1;
    const rand = spec.rand || baseRand;
    const pan = spec.pan || nextPan(spec.kind);
    const expiry = spec.expiry || exp();
    const name = spec.name || person();
    let buffer;
    let contentType = "image/jpeg";
    if (spec.app) {
      buffer = await sharp(Buffer.from(appSvg({ pan, expiry, name, dark: spec.app === "dark" }))).png().toBuffer();
      contentType = "image/png";
      if (spec.enc && spec.enc.format === "jpeg") { buffer = await sharp(buffer).jpeg({ quality: 80 }).toBuffer(); contentType = "image/jpeg"; }
    } else if (spec.hand) {
      let s = sharp(Buffer.from(handSvg({ pan, expiry, name, font: spec.hand })));
      buffer = await s.jpeg({ quality: 85 }).toBuffer();
    } else {
      const face = await faceRgba({ pan, expiry, name, brand: brandOfPan(pan), ...spec.card });
      const W = face.width;
      const H = face.height;
      let img;
      const cw = spec.cardW || 1100;
      const ch = Math.round((cw * H) / W);
      if (spec.place === "flat") {
        img = { data: Buffer.from(face.data), width: W, height: H };
        // flat = a crop of the card itself on white (screenshot-like)
        const bgd = Buffer.alloc(W * H * 4, 255);
        warpInto(face.data, W, H, bgd, W, H, [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]]);
        img = { data: bgd, width: W, height: H };
      } else if (spec.place === "two") {
        const f2 = await faceRgba({ pan: spec.pan2, expiry: exp(), name: person(), brand: brandOfPan(spec.pan2), ...spec.card2 });
        img = await composite({
          rand, bg: spec.bg || "wood", w: 1800, h: 1300,
          faces: [
            { face: f2, quad: rectQuad(1350, 330, 640, Math.round(640 * f2.height / f2.width), 12) },
            { face, quad: rectQuad(760, 800, 1150, Math.round(1150 * H / W), -3) },
          ],
        });
      } else {
        const cx = spec.cx || 800;
        const cy = spec.cy || 600;
        const quad = spec.tilt ? tiltQuad(cx, cy, cw, ch, spec.tilt.k, spec.tilt.axis, spec.tilt.roll || 0) : rectQuad(cx, cy, cw, ch, spec.roll || 0);
        img = await composite({ rand, bg: spec.bg || "table", w: spec.sceneW || 1600, h: spec.sceneH || 1200, faces: [{ face, quad }] });
      }
      if (spec.fx) effect(img, spec.fx, rand);
      const enc = await encode(img, spec.enc || {});
      buffer = enc.buffer;
      contentType = enc.contentType;
      if (spec.pdf) {
        const meta = await sharp(buffer).metadata();
        buffer = pdfWithJpeg(buffer, meta.width, meta.height);
        contentType = "application/pdf";
      }
    }
    items.push({ id: `h${n}`, cat, buffer, contentType, pan, expiry, name, expect: spec.expect || "read", pan2: spec.pan2 || null });
  };

  // 1. clean flat print, several palettes and fonts (screenshot-like crops)
  for (const [pal, font] of [["navy", "sans"], ["green", "consolas"], ["sky", "bahn"], ["orange", "verdana"]]) await add("clean", { place: "flat", card: { palette: pal, font } });
  // 2. clean photos on a table
  for (const [pal, font] of [["red", "mono"], ["purple", "ocra"], ["navy", "narrow"]]) await add("clean-photo", { card: { palette: pal, font }, roll: (rand() - 0.5) * 8 });
  // 3. embossed raised digits with shadow
  for (const [pal, font] of [["navy", "ocra"], ["black", "mono"], ["green", "consolas"], ["red", "ocra"], ["sky", "mono"], ["purple", "ocra"]]) await add("embossed", { card: { palette: pal, font, embossed: true, bold: true } });
  // 4. dark / black / metal
  for (const pal of ["black", "blackgold", "metal", "darkmetal", "black", "metal"]) await add("dark-metal", { card: { palette: pal, font: rand() < 0.5 ? "ocra" : "mono", embossed: rand() < 0.5 }, bg: "table" });
  // 5. light on light
  for (const pal of ["white", "pearl", "white", "pearl"]) await add("light-on-light", { card: { palette: pal, font: "sans" }, bg: "table" });
  // 6. Amex 4-6-5
  for (const pal of ["green", "metal", "black", "sky"]) await add("amex", { kind: "amex", card: { palette: pal, font: "ocra", embossed: pal !== "sky" } });
  // 7. vertical (portrait) cards: one line, and two lines
  for (const [lay, pal] of [["vertical", "black"], ["vertical", "sky"], ["vertical2", "purple"], ["vertical2", "navy"]]) await add("vertical", { card: { layout: lay, palette: pal, font: "sans" }, cardW: 620 });
  // 8. number on the back, with phone numbers and a reference printed near it
  for (const pal of ["white", "navy", "black"]) await add("back", { card: { layout: "back", palette: pal, font: "sans" } });
  // 9. stylised fonts
  for (const font of ["ocra", "georgia", "narrow", "bahn"]) await add("fonts", { card: { palette: "navy", font, bold: font === "bahn" } });
  // 10. glare streaks across the number
  for (let i = 0; i < 5; i += 1) await add("glare", { card: { palette: ["navy", "black", "green", "red", "metal"][i], font: "ocra", embossed: i % 2 === 0 }, fx: { glare: { x0: 200 + i * 60, y0: 200, x1: 1300 - i * 40, y1: 900, width: 55 + i * 8, strength: 0.7 + i * 0.04 } } });
  // 11. blur
  for (let i = 0; i < 4; i += 1) await add("blur", { card: { palette: ["navy", "black", "sky", "green"][i], font: "mono" }, enc: { blur: 1.4 + i * 0.35 } });
  // 12. low light and noise
  for (let i = 0; i < 4; i += 1) await add("low-light", { card: { palette: ["navy", "red", "white", "green"][i], font: "mono", embossed: i % 2 === 1 }, fx: { dark: 0.28 + i * 0.05, noise: 14 + i * 3 } });
  // 13. JPEG artefacts
  for (let i = 0; i < 3; i += 1) await add("jpeg", { card: { palette: ["navy", "purple", "sky"][i], font: "sans" }, enc: { quality: 8 + i * 4 } });
  // 14. perspective tilt 15-40 degrees
  for (const [k, axis, roll] of [[0.86, "y", 0], [0.78, "y", 4], [0.7, "y", -6], [0.82, "x", 0], [0.72, "x", 5], [0.66, "y", 10]]) await add("tilt", { card: { palette: rand() < 0.5 ? "navy" : "black", font: "ocra", embossed: rand() < 0.5 }, tilt: { k, axis, roll } });
  // 15. rotations 90 / 180 / 270, pixels turned and EXIF-tagged
  for (const [rot, orient] of [[90, 0], [180, 0], [270, 0], [270, 6], [180, 3], [90, 8]]) await add("rotation", { card: { palette: "green", font: "mono" }, enc: orient ? { rotate: rot, orientation: orient } : { rotate: rot } });
  // 16. busy patterned table, card smaller in frame
  for (const bg of ["wood", "check", "cloth"]) await add("pattern", { card: { palette: "navy", font: "ocra" }, bg, cardW: 800, roll: (rand() - 0.5) * 10 });
  // 17. a photo of a screen (moire)
  for (let i = 0; i < 3; i += 1) await add("screen-moire", { card: { palette: ["navy", "sky", "black"][i], font: "sans" }, fx: { moire: true, noise: 6 }, enc: { blur: 0.7 } });
  // 18. banking-app screenshot
  for (const mode of ["light", "dark", "light"]) await add("app-screenshot", { app: mode, enc: mode === "light" && items.filter((x) => x.cat === "app-screenshot").length === 2 ? { format: "jpeg" } : {} });
  // 19. PDF, WEBP, HEIF-container (AVIF)
  await add("pdf", { card: { palette: "navy", font: "mono" }, pdf: true });
  await add("pdf", { card: { palette: "black", font: "ocra", embossed: true }, pdf: true });
  await add("webp-heif", { card: { palette: "red", font: "sans" }, enc: { format: "webp" } });
  await add("webp-heif", { card: { palette: "sky", font: "sans" }, enc: { format: "heif" } });
  // 20. tiny 300 px and huge 4000 px
  await add("tiny", { card: { palette: "navy", font: "sans" }, enc: { resize: 300 } });
  await add("tiny", { card: { palette: "green", font: "mono" }, cardW: 1400, enc: { resize: 420 } });
  await add("huge", { card: { palette: "black", font: "ocra", embossed: true }, enc: { resize: 4000, quality: 80 } });
  await add("huge", { card: { palette: "sky", font: "sans" }, enc: { resize: 4000, quality: 80 } });
  // 21. a finger over a corner (readable) and over the digits (must refuse)
  await add("finger", { card: { palette: "navy", font: "mono" }, fx: { finger: { cx: 1320, cy: 980, rx: 130, ry: 220 } } });
  await add("finger", { card: { palette: "black", font: "ocra" }, fx: { finger: { cx: 700, cy: 560, rx: 110, ry: 200 } }, expect: "refuse" });
  // 22. hand-written on paper
  await add("handwritten", { hand: "hand" });
  await add("handwritten", { hand: "hand2" });
  // 23. two cards in one photo: the big clear one, or an honest refusal
  await add("two-cards", { place: "two", card: { palette: "navy", font: "ocra" }, pan2: randomPan(rand, "mc"), card2: { palette: "red", font: "mono" }, expect: "either" });
  await add("two-cards", { place: "two", card: { palette: "black", font: "mono" }, pan2: randomPan(rand, "visa"), card2: { palette: "sky", font: "sans" }, expect: "either" });
  // 24. random test numbers, mixed hard conditions
  for (let i = 0; i < 4; i += 1) {
    await add("mixed", {
      kind: ["visa", "mc", "amex", "disc"][i],
      card: { palette: ["darkmetal", "pearl", "purple", "black"][i], font: ["ocra", "mono", "ocra", "consolas"][i], embossed: i % 2 === 0 },
      tilt: { k: 0.84, axis: i % 2 ? "x" : "y", roll: i * 3 - 4 },
      fx: { noise: 10, glare: i === 3 ? { x0: 300, y0: 100, x1: 1200, y1: 1000, width: 45, strength: 0.6 } : null },
      enc: { quality: 60 },
    });
  }
  // 25. white on white (Hershy's card, 25 Sep): embossed digits the same colour as the card - no ink,
  //     only the raised edge's shadow and highlight - photographed in dim or uneven light. Appended
  //     LAST so every earlier item keeps its exact bytes and numbers.
  const wrand = seeded(seed + 925);
  const WOW = [
    { card: { palette: "snow", font: "ocra", embossOp: { shadow: 0.3, light: 0.5 } }, fx: { dark: 0.6, noise: 8 } },
    { card: { palette: "snow", font: "mono", bold: true, embossOp: { shadow: 0.25, light: 0.4 } }, fx: { shade: { cx: 300, cy: 200, r: 1500, lo: 0.45, hi: 0.95 }, noise: 10 } },
    { card: { palette: "ivory", font: "ocra", embossOp: { shadow: 0.3, light: 0.5 } }, fx: { dark: 0.55, noise: 12 } },
    { card: { palette: "snow", font: "consolas", embossOp: { shadow: 0.22, light: 0.35 } }, fx: { dark: 0.65, noise: 8 }, tilt: { k: 0.85, axis: "y", roll: 3 } },
    { card: { palette: "snow", font: "ocra", embossOp: { shadow: 0.3, light: 0.5 } }, fx: { dark: 0.5, noise: 12, glare: { x0: 250, y0: 150, x1: 1350, y1: 1000, width: 60, strength: 0.35 } } },
    { card: { palette: "snow", font: "mono", embossOp: { shadow: 0.35, light: 0.5 } }, fx: { dark: 0.5, noise: 10 }, roll: 6 },
    { card: { palette: "ivory", font: "ocra", embossOp: { shadow: 0.25, light: 0.45 } }, fx: { shade: { cx: 1500, cy: 1100, r: 1700, lo: 0.35, hi: 1.0 }, noise: 8 } },
    { card: { palette: "snow", font: "mono", embossOp: { shadow: 0.3, light: 0.5 } }, fx: { dark: 0.42, noise: 14 }, enc: { blur: 1.0 } },
    { card: { palette: "snow", font: "ocra", embossOp: { shadow: 0.28, light: 0.45 } }, fx: { dark: 0.55, noise: 10 }, enc: { quality: 45 } },
    { kind: "amex", card: { palette: "snow", font: "ocra", embossOp: { shadow: 0.3, light: 0.5 } }, fx: { dark: 0.6, noise: 10 } },
  ];
  const WOW_KINDS = ["mc", "visa", "disc", "visa", "mc", "visa", "mc", "visa", "mc", "amex"];
  for (let i = 0; i < WOW.length; i += 1) {
    const w = WOW[i];
    const pan = randomPan(wrand, w.kind || WOW_KINDS[i]);
    const expiry = expiryAhead(now, 1 + Math.floor(wrand() * 6), 1 + Math.floor(wrand() * 12));
    const name = NAMES[Math.floor(wrand() * NAMES.length)];
    await add("white-on-white", { ...w, pan, expiry, name, rand: wrand, card: { embossed: true, ...w.card } });
  }
  return items;
}
