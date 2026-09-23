/**
 * Synthetic card set for the card reader tests (plan 13.7). Rendered at test
 * time with sharp from SVG, held in memory, never written to disk and never
 * committed. Numbers are generated (Luhn-valid) from the six range families
 * of 13.3.4; names are invented; nothing here is a real card.
 */

import sharp from "sharp";

/** The six brand range families the reader accepts (13.3.4). */
export const FAMILIES = [
  { id: "visa", label: "VISA", prefix: () => "4", length: 16, bg: "#1a3d8f", bg2: "#0b1d4a", fg: "#f4f4f4", logo: "#ffffff" },
  { id: "mastercard", label: "MASTERCARD", prefix: (r) => `5${1 + Math.floor(r() * 5)}`, length: 16, bg: "#3a3a3a", bg2: "#111111", fg: "#f0f0f0", logo: "#ff5f00" },
  { id: "mastercard", label: "MASTERCARD", prefix: (r) => String(2221 + Math.floor(r() * 500)), length: 16, bg: "#7a1f1f", bg2: "#3a0d0d", fg: "#f6e6e6", logo: "#ffcc66" },
  { id: "amex", label: "AMERICAN EXPRESS", prefix: (r) => (r() < 0.5 ? "34" : "37"), length: 15, bg: "#2e7d6f", bg2: "#14403a", fg: "#ffffff", logo: "#dfeeea" },
  { id: "discover", label: "DISCOVER", prefix: () => "6011", length: 16, bg: "#ece4d4", bg2: "#cbbf9f", fg: "#1d1d1d", logo: "#e86a10" },
  { id: "discover", label: "DISCOVER", prefix: (r) => (r() < 0.5 ? "65" : `64${4 + Math.floor(r() * 6)}`), length: 16, bg: "#4a4e69", bg2: "#22243a", fg: "#f2f2f2", logo: "#ffb347" },
];

export const NAMES = [
  "AVROHOM COHEN",
  "MIRIAM SCHWARTZ",
  "YOSEF FRIEDMAN",
  "CHAYA WEISS",
  "SHMUEL GOLDBERG",
  "RIVKA KLEIN",
  "MENACHEM STERN",
  "ESTHER ROSENBERG",
  "DOVID KATZ",
  "LEAH GREENFIELD",
  "BINYOMIN LANDAU",
  "SARA HOROWITZ",
];

/** mulberry32: small deterministic PRNG so the set is the same on every run. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function luhnCheckDigit(partial) {
  let sum = 0;
  let dbl = true;
  for (let i = partial.length - 1; i >= 0; i -= 1) {
    let d = partial.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return String((10 - (sum % 10)) % 10);
}

export function generatePan(family, rand) {
  let s = family.prefix(rand);
  while (s.length < family.length - 1) s += String(Math.floor(rand() * 10));
  return s + luhnCheckDigit(s);
}

export function groupDigits(pan) {
  if (pan.length === 15) return `${pan.slice(0, 4)} ${pan.slice(4, 10)} ${pan.slice(10)}`;
  return pan.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * One card face as SVG. `embossed` paints each glyph three times (shadow,
 * highlight, face) the way raised digits photograph; flat paints once.
 */
export function cardSvg({ pan, name, expiry, family, embossed, glare }) {
  const mono = "Courier New, DejaVu Sans Mono, Liberation Mono, monospace";
  const sans = "Arial, DejaVu Sans, Liberation Sans, sans-serif";
  const ls = pan.length === 15 ? 5 : 4;
  const txt = (x, y, size, s, fam, weight = "normal") =>
    embossed
      ? `<text x="${x + 2}" y="${y + 2}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="#000" fill-opacity="0.45" letter-spacing="${ls}">${esc(s)}</text>` +
        `<text x="${x - 1}" y="${y - 1}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="#fff" fill-opacity="0.5" letter-spacing="${ls}">${esc(s)}</text>` +
        `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="${family.fg}" letter-spacing="${ls}">${esc(s)}</text>`
      : `<text x="${x}" y="${y}" font-family="${fam}" font-size="${size}" font-weight="${weight}" fill="${family.fg}" letter-spacing="${ls}">${esc(s)}</text>`;
  const glareSvg = glare
    ? `<ellipse cx="520" cy="360" rx="330" ry="120" fill="url(#glare)"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1011" height="638">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${family.bg}"/><stop offset="1" stop-color="${family.bg2}"/></linearGradient>
    <radialGradient id="glare" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="0.55" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1011" height="638" rx="42" fill="url(#bg)"/>
  <circle cx="860" cy="120" r="260" fill="#ffffff" fill-opacity="0.06"/>
  <rect x="80" y="150" width="122" height="92" rx="14" fill="#d9b44a"/>
  <rect x="96" y="166" width="90" height="60" rx="8" fill="none" stroke="#8a6d1f" stroke-width="3"/>
  <text x="820" y="80" font-family="${sans}" font-size="30" fill="${family.fg}" fill-opacity="0.85">DEBIT</text>
  ${txt(80, 372, pan.length === 15 ? 78 : 74, groupDigits(pan), mono)}
  ${txt(80, 440, 28, "VALID THRU " + expiry, sans)}
  ${txt(80, 540, 40, name, sans)}
  <text x="${family.label.length > 8 ? 620 : 800}" y="590" font-family="${sans}" font-size="44" font-weight="bold" fill="${family.logo}">${esc(family.label)}</text>
  ${glareSvg}
</svg>`;
}

/**
 * Render one card to a JPEG buffer (phones send JPEG). rotation rotates the
 * pixels (a sideways photo), effect adds glare (in the SVG) or blur.
 */
export async function renderCard(spec) {
  const svg = cardSvg({ ...spec, glare: spec.effect === "glare" });
  let img = sharp(Buffer.from(svg)).png();
  let png = await img.toBuffer();
  let out = sharp(png);
  if (spec.rotation) out = out.rotate(spec.rotation);
  if (spec.effect === "blur") out = out.blur(1.6);
  return out.jpeg({ quality: 86 }).toBuffer();
}

export function expiryFor(now, yearsAhead, month) {
  const y = now.getUTCFullYear() + yearsAhead;
  return `${String(month).padStart(2, "0")}/${String(y % 100).padStart(2, "0")}`;
}

/**
 * The 60-image set: 6 families x {embossed, flat} x 4 rotations = 48 clean,
 * + 6 glare (embossed, 0 deg) + 6 blur (flat, 0 deg) = 60.
 */
export function syntheticSpecs({ now, seed = 20260923 } = {}) {
  const rand = seeded(seed);
  const specs = [];
  let n = 0;
  FAMILIES.forEach((family, fi) => {
    for (const embossed of [true, false]) {
      const pan = generatePan(family, rand);
      const name = NAMES[(fi * 2 + (embossed ? 0 : 1)) % NAMES.length];
      const expiry = expiryFor(now, 2 + ((fi + (embossed ? 0 : 1)) % 5), 1 + ((fi * 3 + (embossed ? 2 : 7)) % 12));
      for (const rotation of [0, 90, 180, 270]) {
        n += 1;
        specs.push({ id: `c${n}`, family, familyIndex: fi, embossed, rotation, effect: null, pan, name, expiry, clean: true });
      }
    }
  });
  FAMILIES.forEach((family, fi) => {
    const clean = specs.find((s) => s.familyIndex === fi && s.embossed && s.rotation === 0);
    n += 1;
    specs.push({ ...clean, id: `g${n}`, effect: "glare", clean: false });
  });
  FAMILIES.forEach((family, fi) => {
    const clean = specs.find((s) => s.familyIndex === fi && !s.embossed && s.rotation === 0);
    n += 1;
    specs.push({ ...clean, id: `b${n}`, effect: "blur", clean: false });
  });
  return specs;
}

export async function buildSyntheticSet(opts = {}) {
  const specs = syntheticSpecs(opts);
  const out = [];
  for (const spec of specs) {
    const buffer = await renderCard(spec);
    out.push({ ...spec, buffer });
  }
  return out;
}

/** A tiny real image for the fake-engine tests (no card on it). */
export async function tinyImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150"><rect width="240" height="150" fill="#dddddd"/><rect x="20" y="40" width="200" height="60" fill="#333333"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
