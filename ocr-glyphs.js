/**
 * Card-digit glyph matcher (24 Sep 2026) - the second reader beside tesseract.
 *
 * Why: tesseract's English model reads book print. Card numbers are printed
 * or embossed in card fonts (Farrington 7B on embossed cards, OCR-A, narrow
 * sans on flat cards), and on those it drops digits and reads 8 as 4. A card
 * line is ten kinds of glyph in ONE font, so it is read the way card
 * readers have always read it: cut the line into glyphs, compare each glyph
 * with the ten digits of each card font, and keep the ONE font that fits the
 * whole line best.
 *
 * Pure JavaScript over a grey band that ocr-card.js has already cut out,
 * straightened and scaled (digits ~40 px tall). No model, no network, nothing
 * written anywhere. Templates: ocr-glyphs.json (built by
 * scripts/build-ocr-glyphs.mjs from the fonts named in it: 10 digits per
 * font, 28x32 grey levels, base64).
 *
 * Output: readings as text ("4111 1111 1111 1111"), each with the weakest
 * glyph's margin, so the caller only lets a reading vote when every glyph in
 * it was a clear match.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GW = 28;
export const GH = 32;

let TEMPLATES = null;
export function loadTemplates(file = path.join(HERE, "ocr-glyphs.json")) {
  if (TEMPLATES) return TEMPLATES;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    TEMPLATES = [];
    return TEMPLATES;
  }
  TEMPLATES = (json.fonts || []).map((f) => ({
    name: f.name,
    digits: f.digits.map((b64) => normVec(Uint8Array.from(Buffer.from(b64, "base64")))),
  }));
  return TEMPLATES;
}

/** Zero-mean, unit-length vector of a GW x GH glyph (ink = high). */
export function normVec(u8) {
  const n = GW * GH;
  const v = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += u8[i] || 0;
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (u8[i] || 0) - mean;
    v[i] = x;
    ss += x * x;
  }
  const k = ss > 0 ? 1 / Math.sqrt(ss) : 0;
  for (let i = 0; i < n; i += 1) v[i] *= k;
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/**
 * Put one glyph (a box of an ink map, ink 0..255 high) into the GW x GH
 * frame: scaled by HEIGHT to GH-4, centred, so a narrow 1 stays narrow.
 */
export function frameGlyph(ink, width, box) {
  const out = new Uint8Array(GW * GH);
  const s = (GH - 4) / box.h;
  const gw = box.w * s;
  const ox = (GW - gw) / 2;
  for (let y = 0; y < GH; y += 1) {
    const sy = (y - 2) / s;
    if (sy < 0 || sy >= box.h) continue;
    for (let x = 0; x < GW; x += 1) {
      const sx = (x - ox) / s;
      if (sx < 0 || sx >= box.w) continue;
      // area-ish sample: average of a 2x2 neighbourhood in the source
      const x0 = box.x + Math.floor(sx);
      const y0 = box.y + Math.floor(sy);
      const x1 = Math.min(box.x + box.w - 1, x0 + 1);
      const y1 = Math.min(box.y + box.h - 1, y0 + 1);
      out[y * GW + x] = (ink[y0 * width + x0] + ink[y0 * width + x1] + ink[y1 * width + x0] + ink[y1 * width + x1]) >> 2;
    }
  }
  return out;
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** Mean adaptive threshold -> ink mask (1 = darker than its neighbourhood by c). */
function adaptiveInk(gray, w, h, win, c) {
  const W = w + 1;
  const integral = new Float64Array(W * (h + 1));
  for (let y = 1; y <= h; y += 1) {
    let row = 0;
    for (let x = 1; x <= w; x += 1) {
      row += gray[(y - 1) * w + x - 1];
      integral[y * W + x] = integral[(y - 1) * W + x] + row;
    }
  }
  const out = new Uint8Array(w * h);
  const r = win >> 1;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * W + x1 + 1] - integral[y0 * W + x1 + 1] - integral[(y1 + 1) * W + x0] + integral[y0 * W + x0];
      out[y * w + x] = gray[y * w + x] * area < sum - c * area ? 1 : 0;
    }
  }
  return out;
}

/** Sliding min (or max) over a window of k, rows then columns (a square erosion / dilation). */
function morph(src, w, h, k, useMax) {
  const r = k >> 1;
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = useMax ? 0 : 255;
      for (let d = Math.max(0, x - r); d <= Math.min(w - 1, x + r); d += 1) {
        const p = src[y * w + d];
        if (useMax ? p > v : p < v) v = p;
      }
      tmp[y * w + x] = v;
    }
  }
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let v = useMax ? 0 : 255;
      for (let d = Math.max(0, y - r); d <= Math.min(h - 1, y + r); d += 1) {
        const p = tmp[d * w + x];
        if (useMax ? p > v : p < v) v = p;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * White top-hat: the picture minus its opening with a window wider than a
 * digit stroke. Thin bright strokes (the digits) stay; anything broad and
 * bright (a glare streak, a light patch of the card) is removed.
 */
export function topHat(gray, w, h, k) {
  const open = morph(morph(gray, w, h, k, false), w, h, k, true);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) out[i] = Math.max(0, gray[i] - open[i]);
  return out;
}

/** 8-connected components of a 0/1 mask -> boxes {x,y,w,h,n}. */
function components(mask, w, h) {
  const label = new Int32Array(w * h);
  const boxes = [];
  const stack = [];
  let next = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || label[i]) continue;
    next += 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w;
      const py = (p - px) / w;
      n += 1;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = px + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !label[q]) { label[q] = next; stack.push(q); }
        }
      }
    }
    boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n });
  }
  return boxes;
}

/**
 * The digit row in a mask: components of about digit height, sharing a
 * baseline band, pieces of one glyph merged. Returns boxes left to right.
 */
function digitRow(mask, w, h, digitPx) {
  let boxes = components(mask, w, h).filter((b) => b.h >= 0.45 * digitPx && b.h <= 1.7 * digitPx && b.w <= 1.3 * digitPx && b.n >= 0.08 * b.w * b.h);
  if (boxes.length < 8) return [];
  // The row: the densest band of centres.
  const cys = boxes.map((b) => b.y + b.h / 2).sort((a, b) => a - b);
  let bestC = cys[0], bestN = 0;
  for (const c of cys) {
    const n = cys.filter((x) => Math.abs(x - c) < 0.35 * digitPx).length;
    if (n > bestN) { bestN = n; bestC = c; }
  }
  boxes = boxes.filter((b) => Math.abs(b.y + b.h / 2 - bestC) < 0.4 * digitPx);
  boxes.sort((a, b) => a.x - b.x);
  // Merge pieces that overlap in x (a broken embossed stroke).
  const merged = [];
  for (const b of boxes) {
    const last = merged[merged.length - 1];
    if (last && b.x < last.x + last.w - 0.25 * Math.min(b.w, last.w)) {
      const x0 = Math.min(last.x, b.x), y0 = Math.min(last.y, b.y);
      const x1 = Math.max(last.x + last.w, b.x + b.w), y1 = Math.max(last.y + last.h, b.y + b.h);
      if (x1 - x0 <= 1.3 * digitPx) {
        merged[merged.length - 1] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, n: last.n + b.n };
        continue;
      }
    }
    merged.push({ ...b });
  }
  // One glyph height per glyph: the median of its neighbours, so a broken glyph is framed like the
  // rest and a card photographed at an angle (far digits smaller) is framed digit by digit.
  const hs = merged.map((b) => b.h).sort((a, b) => a - b);
  const H = hs[Math.floor(hs.length / 2)];
  const kept = merged.filter((b) => b.h >= 0.6 * H);
  return kept.map((b, i) => {
    const near = kept.slice(Math.max(0, i - 2), i + 3).map((x) => x.h).sort((p, q) => p - q);
    const Hl = near[Math.floor(near.length / 2)];
    const cy = b.y + b.h / 2;
    const y = Math.max(0, Math.round(cy - Hl / 2));
    return { x: b.x, y, w: b.w, h: Math.min(h - y, Hl) };
  });
}

/** Split a row into printed groups by the gaps between glyphs. */
function groupsOf(boxes) {
  if (!boxes.length) return [];
  const gaps = [];
  for (let i = 1; i < boxes.length; i += 1) gaps.push(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].w));
  const pitch = boxes.map((b) => b.w).sort((a, b) => a - b)[Math.floor(boxes.length / 2)];
  const sorted = [...gaps].sort((a, b) => a - b);
  const small = sorted[Math.floor(sorted.length * 0.3)] || 0;
  const cut = Math.max(small + 0.45 * pitch, 0.55 * pitch);
  const out = [[0]];
  for (let i = 1; i < boxes.length; i += 1) {
    if (gaps[i - 1] > cut) out.push([i]);
    else out[out.length - 1].push(i);
  }
  return out;
}

/**
 * Read one cut line. `band` = {data, width, height} grey, digits ~digitPx tall.
 * Returns [{text, minMargin, meanScore, font, prep}] - one per preparation that found a row.
 */
export function readLineGlyphs(band, { digitPx = 40, templates = loadTemplates(), minGlyphs = 13 } = {}) {
  if (!templates.length) return [];
  const { data, width: w, height: h } = band;
  const inv = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) inv[i] = 255 - data[i];
  const win = Math.max(15, Math.round(digitPx * 1.6)) | 1;
  const t1 = otsu(data);
  const preps = [
    { name: "adark", mask: adaptiveInk(data, w, h, win, 10), ink: inv },
    { name: "alight", mask: adaptiveInk(inv, w, h, win, 10), ink: data },
    { name: "odark", mask: Uint8Array.from(data, (v) => (v < t1 ? 1 : 0)), ink: inv },
    { name: "olight", mask: Uint8Array.from(data, (v) => (v > t1 ? 1 : 0)), ink: data },
  ];
  // Glare: the top-hat of each polarity, thresholded. k ~ 0.4 digit height, wider than any stroke.
  const k = Math.max(7, Math.round(digitPx * 0.4)) | 1;
  for (const [name, src] of [["hlight", data], ["hdark", inv]]) {
    const th = topHat(src, w, h, k);
    const t = otsu(th);
    preps.push({ name, mask: Uint8Array.from(th, (v) => (v > Math.max(t, 20) ? 1 : 0)), ink: th });
  }
  const out = [];
  // Every preparation's ink map, so a grid cell one preparation lost can be read from another.
  const allInks = preps.map((p) => Uint8Array.from(p.mask, (v) => (v ? 255 : 0)));
  // ...and the top-hat images themselves, unthresholded: a digit washed faint by glare keeps its shape there.
  for (const p of preps) if (p.name[0] === "h") allInks.push(p.ink);
  for (const p of preps) {
    const row = digitRow(p.mask, w, h, digitPx);
    if (row.length < minGlyphs || row.length > 22) continue;
    // Glyph images from the mask itself (clean edges), ink high.
    const ink255 = new Uint8Array(w * h);
    for (let i = 0; i < ink255.length; i += 1) ink255[i] = p.mask[i] ? 255 : 0;
    const vecs = row.map((b) => normVec(frameGlyph(ink255, w, b)));
    // The ONE font that fits the whole line best.
    let best = null;
    for (const f of templates) {
      let total = 0;
      const picks = [];
      for (const v of vecs) {
        let d1 = -1, d2 = -1, s1 = -2, s2 = -2;
        for (let d = 0; d < 10; d += 1) {
          const s = dot(v, f.digits[d]);
          if (s > s1) { s2 = s1; d2 = d1; s1 = s; d1 = d; } else if (s > s2) { s2 = s; d2 = d; }
        }
        total += s1;
        picks.push({ d: d1, d2, s: s1, m: s1 - s2 });
      }
      if (!best || total > best.total) best = { font: f.name, total, picks };
    }
    // A shape at either end that is no digit at all (the card's edge, a logo) is not part of the number.
    let a = 0;
    let z = row.length - 1;
    while (a < z && best.picks[a].s < 0.25) a += 1;
    while (z > a && best.picks[z].s < 0.25) z -= 1;
    const keep = row.slice(a, z + 1);
    const picks = best.picks.slice(a, z + 1);
    if (keep.length < minGlyphs) continue;
    const groups = groupsOf(keep);
    const text = groups.map((g) => g.map((i) => String(picks[i].d)).join("")).join(" ");
    // The one uncertain glyph's runner-up, same layout: the caller tries it only when the first
    // reading is not a card number and every other glyph was a clear match.
    const thinAt = picks.map((x, i) => (x.m < 0.04 ? i : -1)).filter((i) => i >= 0);
    const alt = thinAt.length === 1 && picks[thinAt[0]].d2 >= 0
      ? groups.map((g) => g.map((i) => String(i === thinAt[0] ? picks[i].d2 : picks[i].d)).join("")).join(" ")
      : null;
    out.push({
      text,
      prep: p.name,
      font: best.font,
      meanScore: picks.reduce((s, x) => s + x.s, 0) / picks.length,
      minMargin: Math.min(...picks.map((x) => x.m)),
      minScore: Math.min(...picks.map((x) => x.s)),
      // Glyphs whose best digit only just beat the second. One alone is safe: a single wrong
      // digit can never pass Luhn. Two or more could, by luck, so such a reading does not vote.
      thin: thinAt.length,
      alt,
    });
    const refill = gridRefill(keep, picks, groups, allInks, w, templates.find((f) => f.name === best.font));
    if (refill) out.push({ ...refill, prep: p.name + ":grid", font: best.font, thin: 0, alt: null });
  }
  return out;
}

const CARD_SHAPES = [[4, 4, 4, 4], [4, 6, 5]];

/**
 * A card font is monospaced and the number sits on a fixed grid: every digit
 * one pitch apart, every group one gap apart. When a glare streak or a worn
 * stroke hides one or two glyphs from the segmenter, the complete groups say
 * exactly where the missing cells are. Each such cell is cut at its grid place
 * and matched on its own; it must be a clear match, or there is no reading.
 * The filled digits are READ, never computed, so Luhn still checks them.
 */
function gridRefill(boxes, picks, groups, inks, w, font) {
  if (!font || boxes.length < 12) return null;
  const cx = boxes.map((b) => b.x + b.w / 2);
  const within = [];
  for (const g of groups) for (let i = 1; i < g.length; i += 1) within.push(cx[g[i]] - cx[g[i - 1]]);
  if (within.length < 6) return null;
  within.sort((a, b) => a - b);
  const p = within[Math.floor(within.length / 2)];
  const bw = boxes.map((b) => b.w).sort((a, b) => a - b)[Math.floor(boxes.length / 2)];
  const bh = boxes.map((b) => b.h).sort((a, b) => a - b)[Math.floor(boxes.length / 2)];
  const by = boxes.map((b) => b.y).sort((a, b) => a - b)[Math.floor(boxes.length / 2)];
  for (const shape of CARD_SHAPES) {
    const total = shape.reduce((a, b) => a + b, 0);
    const missing = total - boxes.length;
    if (missing < 1 || missing > 2) continue;
    // The gap between groups, from two neighbouring groups that are both complete for this shape.
    const gaps = [];
    for (let k = 0; k + 1 < groups.length; k += 1) {
      const len = groups[k].length;
      if (len === shape[k] && groups[k + 1].length === shape[k + 1]) {
        gaps.push(cx[groups[k + 1][0]] - cx[groups[k][len - 1]] - p);
      }
    }
    if (!gaps.length) continue;
    const gap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    if (gap < 0.3 * p) continue;
    // Anchor the grid on the first glyph (it must be slot 0) and the last (it must be the last slot).
    const slots = [];
    let x = 0;
    for (let k = 0; k < shape.length; k += 1) {
      for (let j = 0; j < shape[k]; j += 1) { slots.push(x); x += p; }
      x += gap;
    }
    const span = slots[slots.length - 1];
    const measured = cx[cx.length - 1] - cx[0];
    if (Math.abs(measured - span) > 0.6 * p) continue;
    const k = measured / span; // stretch for a slight tilt
    const at = slots.map((s) => cx[0] + s * k);
    const used = new Array(boxes.length).fill(false);
    const fill = [];
    let ok = true;
    for (let s = 0; s < at.length; s += 1) {
      let hit = -1;
      for (let i = 0; i < boxes.length; i += 1) if (!used[i] && Math.abs(cx[i] - at[s]) < 0.4 * p) { hit = i; break; }
      if (hit >= 0) { used[hit] = true; fill.push({ d: picks[hit].d, s: picks[hit].s, m: picks[hit].m }); continue; }
      const box = { x: Math.max(0, Math.round(at[s] - bw / 2)), y: by, w: bw, h: bh };
      let d1 = -1, s1 = -2, s2 = -2;
      for (const ink of inks) {
        const v = normVec(frameGlyph(ink, w, box));
        let e1 = -1, t1 = -2, t2 = -2;
        for (let d = 0; d < 10; d += 1) {
          const sc = dot(v, font.digits[d]);
          if (sc > t1) { t2 = t1; t1 = sc; e1 = d; } else if (sc > t2) t2 = sc;
        }
        if (t1 - t2 >= 0.05 && t1 > s1) { d1 = e1; s1 = t1; s2 = t2; }
      }
      if (s1 < 0.45 || s1 - s2 < 0.05) { ok = false; break; }
      fill.push({ d: d1, s: s1, m: s1 - s2 });
    }
    if (!ok || used.some((u) => !u)) continue;
    let text = "";
    let n = 0;
    for (const len of shape) { text += (text ? " " : "") + fill.slice(n, n + len).map((f) => f.d).join(""); n += len; }
    return {
      text,
      meanScore: fill.reduce((a, f) => a + f.s, 0) / fill.length,
      minScore: Math.min(...fill.map((f) => f.s)),
      minMargin: Math.min(...fill.map((f) => f.m)),
    };
  }
  return null;
}

/**
 * Where are the digit rows, without tesseract? On an embossed or metal card
 * tesseract's word finder often sees nothing. A card number is twelve to
 * nineteen shapes of one height standing in one row: find those rows in the
 * ink maps of the whole picture (both polarities). Returns line geometry only.
 */
export function findRows(gray, w, h) {
  const inv = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) inv[i] = 255 - gray[i];
  const lines = [];
  const masks = [];
  for (const g of [gray, inv]) for (const win of [31, 61]) masks.push(adaptiveInk(g, w, h, win, 12));
  // A glare streak joins the digits it crosses into one blob; the top-hat takes the streak out.
  for (const g of [gray, inv]) for (const k of [11, 21]) {
    const th = topHat(g, w, h, k);
    const t = Math.max(20, otsu(th));
    masks.push(Uint8Array.from(th, (v) => (v > t ? 1 : 0)));
  }
  {
    for (const mask of masks) {
      const boxes = components(mask, w, h).filter((b) => b.h >= 10 && b.h <= h / 4 && b.w <= 0.95 * b.h && b.w >= 0.12 * b.h && b.n >= 0.12 * b.w * b.h && b.n <= 0.85 * b.w * b.h);
      boxes.sort((a, b) => a.x - b.x);
      const used = new Set();
      for (let i = 0; i < boxes.length; i += 1) {
        if (used.has(i)) continue;
        const row = [i];
        let last = boxes[i];
        for (let j = i + 1; j < boxes.length; j += 1) {
          if (used.has(j)) continue;
          const b = boxes[j];
          const gap = b.x - (last.x + last.w);
          if (gap > 2.6 * last.h) break;
          const dcy = Math.abs(b.y + b.h / 2 - (last.y + last.h / 2));
          if (gap > -0.3 * last.h && dcy < 0.3 * last.h && Math.abs(b.h - last.h) < 0.25 * last.h) {
            row.push(j);
            last = b;
          }
        }
        if (row.length < 10) continue;
        row.forEach((k) => used.add(k));
        const bs = row.map((k) => boxes[k]);
        const hs = bs.map((b) => b.h).sort((a, b) => a - b);
        const H = hs[Math.floor(hs.length / 2)];
        const xs = bs.map((b) => b.x + b.w / 2);
        const ys = bs.map((b) => b.y + b.h / 2);
        const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
        const my = ys.reduce((a, b) => a + b, 0) / ys.length;
        let sxy = 0, sxx = 0;
        for (let k = 0; k < xs.length; k += 1) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
        const angle = sxx > 0 ? (Math.atan(sxy / sxx) * 180) / Math.PI : 0;
        lines.push({
          left: Math.min(...bs.map((b) => b.x)),
          right: Math.max(...bs.map((b) => b.x + b.w)),
          top: Math.min(...bs.map((b) => b.y)),
          bottom: Math.max(...bs.map((b) => b.y + b.h)),
          h: H, angle, digits: row.length, words: 0, shapes: true,
        });
      }
    }
  }
  return lines;
}
