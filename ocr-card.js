/**
 * The free card reader: POST /__nesher_pay/ocr (Mr Money plan section 13).
 *
 * One route, server only, behind a one-time signed ticket (HMAC, five
 * minutes, single use, one rep). tesseract.js + sharp in this container; no
 * Claude, no Gemini, no cloud vision, ever, for the card image (13.2).
 *
 * Pipeline (13.3), all in memory, nothing on disk:
 *   decode + EXIF auto-rotate + resize longest side 1600 -> four variants
 *   (contrast stretch, adaptive threshold, inverted, unsharp) -> rotation
 *   ladder 0 / 90 / 270 / 180 (13.6 says drop 180 and 270 first, so they come
 *   last and only run when nothing was found) -> digit-and-slash whitelist,
 *   PSM single block, then a sparse-text second pass at the found rotation ->
 *   candidates = 13..19 digit runs that pass Luhn and a known brand range ->
 *   vote across variants -> confidence high / low -> expiry + name from one
 *   text pass -> a server-side hold (this process, in memory, five minutes,
 *   single use, bound to the rep) -> purge (every Buffer this process holds
 *   is overwritten with zeros).
 *
 * What the response carries: brand, last four, expiry, name, confidence and a
 * one-time card reference that chargeCardRef / chargeWithToken can spend once.
 * The PAN never appears in the response, the logs, or any store. The access
 * log keeps method, ticket id, outcome and milliseconds only (13.3.7).
 *
 * CVV is never read from the image (13.4).
 *
 * PCI (13.8): this route is what puts the pay-proxy in SAQ D scope. Same host
 * that already holds NMI_PRIVATE_KEY, so the scope does not widen.
 *
 * THE HOLD (13.3.6, rebuilt 23 Sep 2026). The spec asked for "the gateway's
 * tokenization endpoint (Collect.js public key, server side)", which does not
 * exist: Collect.js is a browser flow and the public key does not
 * authenticate a server call. The first build used a gateway Customer Vault
 * record instead. That is now removed, for two reasons and not one:
 *   1. Joseph declined the Customer Vault value-added service on 2026-09-08
 *      over its fee ($10 + $40/month + $0.40 a transaction), and the reader
 *      itself is "7.2 free" - no paid add-on may be on its critical path.
 *   2. It was never proved that this merchant can vault at all.
 * So the reference this route hands back is OURS, and it costs nothing: the
 * number stays in THIS PROCESS, in a Buffer, in a Map, for five minutes at
 * most, spendable exactly once, by the one rep who uploaded the photo, and
 * only together with a charge ticket that is signed over that same reference.
 * Nothing is written to disk, to Postgres or to any backup, and the number
 * never reaches the gateway until the rep actually charges the card.
 *
 * Honest limits, stated once here and in the bundle:
 *  - JS strings are immutable: OCR text and the PAN string are dropped and
 *    become unreachable; only Buffers can be, and are, zeroed. The hold keeps
 *    the number as a Buffer precisely so it CAN be zeroed, on every path.
 *  - At the moment of the charge the number must become a string to be put in
 *    the JSON the gateway expects. That string is unreachable one tick later
 *    and cannot be zeroed. This is the same limit every Node merchant server
 *    has, and it is why the hold's life is five minutes and one use.
 *  - The tesseract worker thread receives a structured-clone copy of each
 *    variant, and tesseract.js writes it to the worker's in-memory FS at
 *    /input and never deletes it (setImage.js), so a worker used to keep the
 *    last card variant until its next read. recognizeCard now ends EVERY read
 *    (success, failure, throw) with engine.scrub(): each worker that touched
 *    the card recognises a blank (replacing /input and the API's current
 *    image) and /input is unlinked. Released to the GC, not zeroed - the FS
 *    is reachable only by message.
 *  - The store is in memory, so it belongs to one container. This service
 *    runs one replica (Railway numReplicas unset), and health reports an
 *    `instance` id so that stays provable. If it were ever scaled out, a
 *    reference minted on one replica and presented to another is simply
 *    unknown - 410, "take the photo again". It fails closed, never open.
 */

import crypto from "node:crypto";
import { chargeWithToken } from "./nmi-card.js";

export const OCR_PATH = "/__nesher_pay/ocr";
export const OCR_TICKET_SECRET_NAME = "OCR_TICKET_SECRET";
export const OCR_MAX_BYTES = 8 * 1024 * 1024;
export const OCR_TICKET_TTL_MS = 5 * 60 * 1000;
export const OCR_MAX_SIDE = 1600;
/** Soft budget for the recognize passes (13.6 target is 3 s photo to tile). */
export const OCR_DEADLINE_MS = 2600;
/** The hold's whole life. Five minutes, the same hard cap as a ticket. */
export const CARD_HOLD_TTL_MS = 5 * 60 * 1000;
export const VARIANT_NAMES = ["stretch", "adaptive", "inverted", "unsharp"];
/** 13.6: 180 and 270 are the first to drop, so they run last. */
export const ROTATION_LADDER = [0, 90, 270, 180];

// ── secret / ticket ────────────────────────────────────────────────────────

export function ocrSecret(env = process.env) {
  const s = String(env[OCR_TICKET_SECRET_NAME] || "").trim();
  return s.length >= 16 ? s : "";
}

export function ocrEnabled(env = process.env) {
  return Boolean(ocrSecret(env));
}

const REP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * ocr = one upload; hold = one typed / pasted / spoken card put behind a
 * reference (card-hold, 23 Sep); charge / void / refund = one money action
 * bound to one reference (card-charge.js).
 */
// payprep / pay / paystat: the supplier-payment doors (money-pay.js, F7, 24 Sep).
// sale: the desk chat's READ ONLY lookup of a past sale before a refund or void (card-charge.js, 24 Sep).
export const TICKET_KINDS = ["ocr", "hold", "charge", "void", "refund", "payprep", "pay", "paystat", "sale"];
const KIND_RE = /^[a-z]{2,10}$/;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

/** Short hash of the value a money ticket is bound to (a card ref or a txn id); "-" for ocr and hold. */
export function bindHashOf(kind, bind) {
  if (kind === "ocr" || kind === "hold") return "-";
  const v = String(bind || "").trim();
  if (!v) return "";
  return crypto.createHash("sha256").update(v).digest("hex").slice(0, 16);
}

function ticketSig(secret, kind, ticketId, repId, exp, bindHash) {
  return b64url(
    crypto
      .createHmac("sha256", secret)
      .update(`${kind}.${ticketId}.${repId}.${exp}.${bindHash}`)
      .digest()
  );
}

/**
 * Mint a one-time ticket for one rep. The desk chat mints the same shape
 * later with the same shared secret name. Five minutes at most, single use.
 * token = kind.ticketId.repId.expiresAtMs.bindHash.signature
 * kind "ocr" binds to nothing; "charge" binds to the card reference it may
 * spend; "void" / "refund" bind to the transaction id they may touch, so a
 * ticket can never move a different card or a different transaction.
 */
export function mintTicket({ kind = "ocr", repId, bind = "", secret, now = Date.now(), ttlMs = OCR_TICKET_TTL_MS } = {}) {
  const k = String(kind || "").trim();
  if (!TICKET_KINDS.includes(k)) throw new Error("ticket kind unknown");
  const rep = String(repId || "").trim();
  if (!REP_ID_RE.test(rep)) throw new Error("rep id required");
  const key = String(secret || "");
  if (key.length < 16) throw new Error("ticket secret required");
  const bindHash = bindHashOf(k, bind);
  if (!bindHash) throw new Error("ticket binding required");
  const ticketId = crypto.randomBytes(12).toString("hex");
  const exp = Number(now) + Math.min(Number(ttlMs) || OCR_TICKET_TTL_MS, OCR_TICKET_TTL_MS);
  const sig = ticketSig(key, k, ticketId, rep, exp, bindHash);
  return {
    kind: k,
    ticketId,
    repId: rep,
    expiresAt: exp,
    bindHash,
    token: `${k}.${ticketId}.${rep}.${exp}.${bindHash}.${sig}`,
  };
}

/** The upload ticket of plan 13.1. */
export function mintOcrTicket(opts = {}) {
  return mintTicket({ ...opts, kind: "ocr", bind: "" });
}

/** Single-use registry: ticketId -> expiresAt. Pruned as it is used. */
const usedTickets = new Map();

function pruneUsed(now) {
  if (usedTickets.size < 500) return;
  for (const [id, exp] of usedTickets) if (exp <= now) usedTickets.delete(id);
}

/**
 * @param {string} token
 * @param {object} opts
 * @param {string} opts.secret
 * @param {string} [opts.kind]   required kind ("ocr" by default)
 * @param {string} [opts.bind]   when given, the ticket's binding must match it
 * @returns {{ok:true, kind:string, ticketId:string, repId:string, expiresAt:number, bindHash:string} | {ok:false, error:string, ticketId?:string}}
 */
export function verifyTicket(token, { secret, now = Date.now(), used = usedTickets, kind = "ocr", bind } = {}) {
  const key = String(secret || "");
  if (key.length < 16) return { ok: false, error: "disabled" };
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 6) return { ok: false, error: "malformed" };
  const [k, ticketId, repId, expStr, bindHash, sig] = parts;
  if (
    !KIND_RE.test(k) ||
    !/^[0-9a-f]{24}$/.test(ticketId) ||
    !REP_ID_RE.test(repId) ||
    !/^\d{10,16}$/.test(expStr) ||
    !/^(-|[0-9a-f]{16})$/.test(bindHash)
  ) {
    return { ok: false, error: "malformed" };
  }
  const exp = Number(expStr);
  const want = ticketSig(key, k, ticketId, repId, exp, bindHash);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "bad_signature", ticketId };
  }
  if (k !== String(kind || "ocr")) return { ok: false, error: "kind_mismatch", ticketId };
  if (exp <= now) return { ok: false, error: "expired", ticketId };
  if (exp - now > OCR_TICKET_TTL_MS + 1000) return { ok: false, error: "expired", ticketId };
  if (used.has(ticketId)) return { ok: false, error: "used", ticketId };
  if (bind !== undefined && bindHashOf(k, bind) !== bindHash) {
    return { ok: false, error: "bind_mismatch", ticketId };
  }
  return { ok: true, kind: k, ticketId, repId, expiresAt: exp, bindHash };
}

export function verifyOcrTicket(token, opts = {}) {
  return verifyTicket(token, { ...opts, kind: "ocr" });
}

/** Burn the ticket. One presentation = one use, whatever happens after. */
export function consumeTicket(ticketId, expiresAt, { now = Date.now(), used = usedTickets } = {}) {
  pruneUsed(now);
  used.set(ticketId, expiresAt);
}

export const consumeOcrTicket = consumeTicket;

export function ticketFromHeaders(headers = {}) {
  const direct = String(headers["x-ocr-ticket"] || headers["x-ticket"] || "").trim();
  if (direct) return direct;
  const auth = String(headers.authorization || "").trim();
  const m = /^Ticket\s+(\S+)$/i.exec(auth);
  return m ? m[1] : "";
}

// ── CORS (upload route only: the browser posts the photo straight here) ────

export const OCR_CORS_ORIGINS = new Set([
  "https://phone.jrmhotels.com",
  "https://phone.josephgreen.ai",
]);

export function corsHeadersFor(origin) {
  const o = String(origin || "").trim().toLowerCase();
  if (!OCR_CORS_ORIGINS.has(o)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-ocr-ticket, authorization",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// ── numbers ────────────────────────────────────────────────────────────────

export function luhnOk(digits) {
  const s = String(digits || "");
  if (!/^\d{12,19}$/.test(s)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * 13.3.4 brand ranges. Visa 4; Mastercard 51-55 and 2221-2720; Amex 34 and 37;
 * Discover 6011, 644-649, 65. Lengths as the brands issue them.
 */
export function brandOf(digits) {
  const s = String(digits || "");
  const n = s.length;
  if (!/^\d+$/.test(s)) return null;
  const p2 = Number(s.slice(0, 2));
  const p3 = Number(s.slice(0, 3));
  const p4 = Number(s.slice(0, 4));
  if (s[0] === "4" && (n === 13 || n === 16 || n === 19)) return "visa";
  if (n === 16 && ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720))) return "mastercard";
  if (n === 15 && (p2 === 34 || p2 === 37)) return "amex";
  if ((n === 16 || n === 19) && (p4 === 6011 || (p3 >= 644 && p3 <= 649) || p2 === 65)) return "discover";
  return null;
}

export const BRAND_LABEL = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
};

function panIfValid(digits) {
  if (digits.length < 13 || digits.length > 19) return null;
  const brand = brandOf(digits);
  if (!brand) return null;
  if (!luhnOk(digits)) return null;
  return { pan: digits, brand };
}

/**
 * Every run of 13-19 digits (spaces and dashes ignored inside a line) that
 * passes Luhn and a brand range. A run with one or two stray digits glued on
 * (chip noise, a logo digit) is tried with up to two digits trimmed from
 * either end, longest first.
 */
export function extractPans(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const runs = line.replace(/[^0-9 \-]/g, "\n").split("\n");
    for (const run of runs) {
      const digits = run.replace(/[ \-]/g, "");
      if (digits.length < 13 || digits.length > 21) continue;
      const found = [];
      const whole = panIfValid(digits);
      if (whole) found.push(whole);
      if (!found.length) {
        for (let cut = 1; cut <= 2 && !found.length; cut += 1) {
          for (let head = 0; head <= cut; head += 1) {
            const tail = cut - head;
            const sub = digits.slice(head, digits.length - tail);
            const hit = panIfValid(sub);
            if (hit) found.push(hit);
          }
        }
      }
      for (const hit of found) {
        if (seen.has(hit.pan)) continue;
        seen.add(hit.pan);
        out.push(hit);
      }
    }
  }
  return out;
}

// ── expiry and name ────────────────────────────────────────────────────────

const EXPIRY_RE = /(0[1-9]|1[0-2])\s*\/\s*((?:20)?\d{2})(?!\d)/g;

/**
 * First MM/YY (or MM/YYYY) whose month is 01-12 and whose year is within the
 * next ten years and not in the past. Returns "MM/YY" or null.
 */
export function parseExpiry(text, now = new Date()) {
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth() + 1;
  const src = String(text || "");
  EXPIRY_RE.lastIndex = 0;
  let m;
  while ((m = EXPIRY_RE.exec(src))) {
    const month = Number(m[1]);
    let year = Number(m[2]);
    if (year < 100) year += 2000;
    if (year < nowY || year > nowY + 10) continue;
    if (year === nowY && month < nowM) continue;
    return `${String(month).padStart(2, "0")}/${String(year % 100).padStart(2, "0")}`;
  }
  return null;
}

export function expiryToMMYY(expiry) {
  const m = /^(\d{2})\/(\d{2})$/.exec(String(expiry || ""));
  return m ? `${m[1]}${m[2]}` : "";
}

const NOT_A_NAME_RE =
  /\b(VALID|THRU|FROM|GOOD|EXP|EXPIRES|MEMBER|SINCE|DEBIT|CREDIT|VISA|MASTERCARD|MASTER|AMERICAN|EXPRESS|DISCOVER|AMEX|PLATINUM|GOLD|SILVER|TITANIUM|SIGNATURE|WORLD|ELITE|BUSINESS|CORPORATE|BANK|CARD|ELECTRON|INFINITE|REWARDS|CASH|BACK|PREFERRED|PREMIER|CHASE|CAPITAL|WELLS|FARGO|CITI|BARCLAYS|HSBC|ISRACARD|LEUMI|HAPOALIM|DISCOUNT|MIZRAHI|CAL|MAX|SAPPHIRE|FREEDOM|DELTA|SKYMILES|UNITED|MILEAGE|CLASSIC|STANDARD|CHIP|CONTACTLESS|ONLY|CUSTOMER|SERVICE|AUTHORIZED|NETWORK|INC|LLC|DEPARTMENT)\b/;

function nameCandidate(line) {
  const s = String(line || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (s.length < 4 || s.length > 40) return null;
  if (!/^[A-Z][A-Z .'\-]*$/.test(s)) return null;
  const letters = s.replace(/[^A-Z]/g, "").length;
  const words = s.split(" ").filter((w) => w.replace(/[^A-Z]/g, "").length >= 2);
  if (words.length < 2 && letters < 6) return null;
  if (words.length < 1) return null;
  if (NOT_A_NAME_RE.test(s)) return null;
  return s;
}

/**
 * Cardholder name: the longest alphabetic line, searched below the expiry
 * line first (where every standard card prints it), then above. Uppercase.
 */
export function pickName(text, expiry) {
  const lines = String(text || "").split(/\r?\n/);
  let expIdx = -1;
  if (expiry) {
    const [mm, yy] = expiry.split("/");
    const re = new RegExp(`${mm}\\s*/\\s*(?:20)?${yy}(?!\\d)`);
    expIdx = lines.findIndex((l) => re.test(l));
  }
  const pick = (arr) => {
    let best = null;
    for (const l of arr) {
      const c = nameCandidate(l);
      if (c && (!best || c.length > best.length)) best = c;
    }
    return best;
  };
  if (expIdx >= 0) {
    const below = pick(lines.slice(expIdx + 1));
    if (below) return below;
    const above = pick(lines.slice(0, expIdx));
    if (above) return above;
    return null;
  }
  return pick(lines);
}

// ── voting ─────────────────────────────────────────────────────────────────

/**
 * @param {Array<{pan:string, brand:string, source:string}>} hits
 * @returns {{pan:string, brand:string, sources:number, confidence:"high"|"low"} | null}
 */
export function voteCandidates(hits) {
  const byPan = new Map();
  for (const h of hits || []) {
    if (!h || !h.pan) continue;
    let e = byPan.get(h.pan);
    if (!e) {
      e = { pan: h.pan, brand: h.brand, sources: new Set() };
      byPan.set(h.pan, e);
    }
    e.sources.add(String(h.source || ""));
  }
  const ranked = [...byPan.values()]
    .map((e) => ({ pan: e.pan, brand: e.brand, sources: e.sources.size }))
    .sort((a, b) => b.sources - a.sources || a.pan.localeCompare(b.pan));
  if (!ranked.length) return null;
  const winner = ranked[0];
  const runner = ranked[1] ? ranked[1].sources : 0;
  const high = winner.sources >= 2 && winner.sources >= 2 * runner;
  return { ...winner, confidence: high ? "high" : "low" };
}

// ── image pipeline ─────────────────────────────────────────────────────────

let sharpModule = null;
async function loadSharp() {
  if (!sharpModule) sharpModule = (await import("sharp")).default;
  return sharpModule;
}

/** Overwrite every Buffer with zeros. Strings cannot be zeroed; they are dropped. */
export function purge(buffers) {
  let n = 0;
  for (const b of buffers || []) {
    if (b && typeof b.fill === "function" && b.length) {
      b.fill(0);
      n += 1;
    }
  }
  return n;
}

/**
 * Mean adaptive threshold on a single-channel raw buffer (13.3.2). Integral
 * image, window `win`, offset `c`. Returns a new raw buffer, 0 or 255.
 */
export function adaptiveThreshold(gray, width, height, win = 41, c = 10) {
  const w = width;
  const h = height;
  const W = w + 1;
  const integral = new Uint32Array(W * (h + 1));
  for (let y = 1; y <= h; y += 1) {
    let row = 0;
    const src = (y - 1) * w;
    for (let x = 1; x <= w; x += 1) {
      row += gray[src + x - 1];
      integral[y * W + x] = integral[(y - 1) * W + x] + row;
    }
  }
  const out = Buffer.alloc(w * h);
  const r = win >> 1;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * W + (x1 + 1)] -
        integral[y0 * W + (x1 + 1)] -
        integral[(y1 + 1) * W + x0] +
        integral[y0 * W + x0];
      out[y * w + x] = gray[y * w + x] * area > (sum - c * area) ? 255 : 0;
    }
  }
  return out;
}

/**
 * Working sizes for the recognizer, measured on the synthetic set (23 Sep):
 * tesseract's LSTM reads card digits best at roughly 26-45 px tall. A card
 * that fills a 500 px frame prints ~35 px digits; 800 px covers a card that
 * fills only two thirds of the frame. At the 1600 px decode size of 13.3.1
 * the same engine dropped digits on every second face (33/48 clean), at
 * 400-500 px it read 11/12 faces per variant and ran three times faster.
 */
export const OCR_WORK_SIDE_A = 500;
export const OCR_WORK_SIDE_B = 800;

function sampledMean(buf) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 7) {
    s += buf[i];
    n += 1;
  }
  return n ? s / n : 0;
}

/**
 * 13.3.1 + 13.3.2: decode, EXIF auto-rotate, longest side 1600, grayscale,
 * then the four variants as PNG buffers at the two working sizes:
 *   stretch  (contrast stretch, side A)
 *   adaptive (mean adaptive threshold on the dark-ink polarity, side B)
 *   inverted (light-on-dark cards read as dark-on-light, side B)
 *   unsharp  (unsharp mask + stretch, side A)
 * Every buffer is pushed to `scratch` so the caller can zero it.
 */
export async function buildVariants(input, { scratch = [], maxSide = OCR_MAX_SIDE } = {}) {
  const sharp = await loadSharp();
  const base = await sharp(input, { failOn: "none", limitInputPixels: 60e6 })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .grayscale()
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = base.info;
  let gray = base.data;
  if (channels !== 1) {
    const one = Buffer.alloc(width * height);
    for (let i = 0, j = 0; i < one.length; i += 1, j += channels) one[i] = gray[j];
    scratch.push(gray);
    gray = one;
  }
  scratch.push(gray);
  const raw = { raw: { width, height, channels: 1 } };
  const png = { compressionLevel: 1 };
  const sideA = Math.min(OCR_WORK_SIDE_A, Math.max(width, height));
  const sideB = Math.min(OCR_WORK_SIDE_B, Math.max(width, height));
  const fitA = { width: sideA, height: sideA, fit: "inside" };
  const fitB = { width: sideB, height: sideB, fit: "inside" };
  const [stretch, inverted, unsharp, small] = await Promise.all([
    sharp(gray, raw).resize(fitA).normalise().png(png).toBuffer(),
    sharp(gray, raw).resize(fitB).negate().normalise().png(png).toBuffer(),
    sharp(gray, raw).resize(fitA).sharpen({ sigma: 1.0 }).normalise().png(png).toBuffer(),
    sharp(gray, raw).resize(fitB).toColourspace("b-w").raw().toBuffer({ resolveWithObject: true }),
  ]);
  // Adaptive threshold wants dark ink on a light field; flip a dark card first.
  const sw = small.info.width;
  const sh = small.info.height;
  let ink = small.data;
  scratch.push(ink);
  if (small.info.channels !== 1) {
    const one = Buffer.alloc(sw * sh);
    for (let i = 0, j = 0; i < one.length; i += 1, j += small.info.channels) one[i] = ink[j];
    ink = one;
    scratch.push(ink);
  }
  if (sampledMean(ink) < 128) {
    const flipped = Buffer.alloc(ink.length);
    for (let i = 0; i < ink.length; i += 1) flipped[i] = 255 - ink[i];
    ink = flipped;
    scratch.push(ink);
  }
  const win = Math.max(15, Math.round(Math.max(sw, sh) / 20)) | 1;
  const thresholded = adaptiveThreshold(ink, sw, sh, win, 10);
  scratch.push(thresholded);
  const adaptive = await sharp(thresholded, { raw: { width: sw, height: sh, channels: 1 } }).png(png).toBuffer();
  const variants = [
    { name: "stretch", buffer: stretch },
    { name: "adaptive", buffer: adaptive },
    { name: "inverted", buffer: inverted },
    { name: "unsharp", buffer: unsharp },
  ];
  for (const v of variants) scratch.push(v.buffer);
  return { variants, width, height };
}

async function rotated(buffer, degrees, scratch) {
  if (!degrees) return buffer;
  const sharp = await loadSharp();
  const out = await sharp(buffer).rotate(degrees).png({ compressionLevel: 1 }).toBuffer();
  scratch.push(out);
  return out;
}

/**
 * Read one card photo. `engine.recognize(buffer, {mode, charset})` is the only
 * OCR door (real pool in ocr-engine.js, fake in tests).
 *
 * @returns {Promise<object>} ok:false -> {ok:false, error, ms, passes}
 *   ok:true -> {ok:true, pan, brand, last4, expiry, name, confidence, sources, rotation, ms, passes}
 *   The caller must drop `pan` before anything leaves the process.
 */
export async function recognizeCard(input, opts = {}) {
  const engine = opts.engine;
  if (!engine || typeof engine.recognize !== "function") throw new Error("engine required");
  try {
    return await recognizeCardOnce(input, opts);
  } finally {
    if (typeof engine.scrub === "function") {
      try { await engine.scrub(); } catch { /* scrub never fails a read */ }
    }
  }
}

async function recognizeCardOnce(input, opts) {
  const engine = opts.engine;
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const now = opts.now instanceof Date ? opts.now : new Date(clock());
  const deadlineMs = Number(opts.deadlineMs) || OCR_DEADLINE_MS;
  const ladder = Array.isArray(opts.rotations) && opts.rotations.length ? opts.rotations : ROTATION_LADDER;
  const scratch = opts.trace && Array.isArray(opts.trace.buffers) ? opts.trace.buffers : [];
  if (Buffer.isBuffer(input)) scratch.push(input);
  const t0 = clock();
  let passes = 0;
  const hits = [];
  const texts = [];

  const finish = (result) => {
    purge(scratch);
    return { ...result, ms: clock() - t0, passes };
  };

  let built;
  try {
    built = await buildVariants(input, { scratch });
  } catch {
    return finish({ ok: false, error: "decode_failed" });
  }
  const { variants } = built;

  const runPass = async (rotation, mode, charset) => {
    const imgs = await Promise.all(variants.map((v) => rotated(v.buffer, rotation, scratch)));
    const results = await Promise.all(
      imgs.map(async (buf, i) => {
        passes += 1;
        const r = await engine.recognize(buf, { mode, charset });
        return { variant: variants[i].name, ...r };
      })
    );
    for (const r of results) {
      const source = `${r.variant}@${rotation}#${mode}`;
      texts.push({ source, rotation, variant: r.variant, text: r.text, confidence: r.confidence });
      for (const hit of extractPans(r.text)) hits.push({ ...hit, source });
    }
    return voteCandidates(hits);
  };

  let vote = null;
  let rotation = 0;
  for (const rot of ladder) {
    if (clock() - t0 > deadlineMs) break;
    vote = await runPass(rot, "block", "digits");
    if (vote) {
      rotation = rot;
      if (vote.confidence !== "high" && clock() - t0 <= deadlineMs) {
        // 13.3.3 second pass, sparse text, for embossed cards - at the found orientation only.
        vote = await runPass(rot, "sparse", "digits");
      }
      break;
    }
  }
  if (!vote) return finish({ ok: false, error: "no_card_found" });

  // Expiry from what the digit passes already saw at this rotation, then one text pass for the name.
  const atRot = texts.filter((t) => t.rotation === rotation);
  let expiry = null;
  for (const t of atRot) {
    expiry = parseExpiry(t.text, now);
    if (expiry) break;
  }
  const withPan = atRot.filter((t) => extractPans(t.text).some((h) => h.pan === vote.pan));
  withPan.sort((a, b) => b.confidence - a.confidence);
  const bestVariant = (withPan[0] || atRot[0] || { variant: "stretch" }).variant;
  let name = null;
  const order = [bestVariant, ...VARIANT_NAMES.filter((n) => n !== bestVariant)];
  for (const vName of order.slice(0, 2)) {
    if (name && expiry) break;
    if (clock() - t0 > deadlineMs + 600) break;
    const v = variants.find((x) => x.name === vName);
    if (!v) continue;
    const img = await rotated(v.buffer, rotation, scratch);
    passes += 1;
    const r = await engine.recognize(img, { mode: "sparse", charset: "text" });
    if (!expiry) expiry = parseExpiry(r.text, now);
    if (!name) name = pickName(r.text, expiry);
  }

  return finish({
    ok: true,
    pan: vote.pan,
    brand: vote.brand,
    last4: vote.pan.slice(-4),
    expiry,
    name,
    confidence: vote.confidence,
    sources: vote.sources,
    rotation,
  });
}

// ── the hold: our own one-time card reference (13.3.6) ─────────────────────

/**
 * ref -> { pan: Buffer, expMMYY, brand, last4, expiry, rep, expiresAt }
 * In this process only. The number is a Buffer so it can be zeroed; nothing
 * here is ever written to disk, to Postgres, to a log or to a response.
 */
const cardHolds = new Map();

/** Overwrite the number (and a held security code) in place. Safe to call twice. */
export function zeroHold(entry) {
  if (entry && entry.pan && typeof entry.pan.fill === "function") entry.pan.fill(0);
  if (entry && entry.cvv && typeof entry.cvv.fill === "function") entry.cvv.fill(0);
  return entry;
}

/**
 * Put a read card behind an opaque one-time reference.
 * 24 random bytes = 192 bits: the reference cannot be guessed, and on its own
 * it is worthless - spending it also needs a charge ticket signed over it.
 */
export function registerCardHold(entry, { now = Date.now(), ttlMs = CARD_HOLD_TTL_MS } = {}) {
  const number = String(entry.pan || "");
  if (!/^\d{12,19}$/.test(number)) return { ok: false, error: "pan_invalid" };
  const rep = String(entry.rep || "").trim();
  if (!rep) return { ok: false, error: "rep_required" };
  const expMMYY = expiryToMMYY(entry.expiry);
  if (!expMMYY) return { ok: false, error: "expiry_unknown" };
  const life = Math.min(Number(ttlMs) || CARD_HOLD_TTL_MS, CARD_HOLD_TTL_MS);
  const expiresAt = now + life;
  // A security code only ever arrives with a typed / pasted / spoken card
  // (card-hold); the photo path never has one. Held as a Buffer beside the
  // number, spent by the one charge, zeroed with it.
  const cvvText = entry.cvv == null ? "" : String(entry.cvv);
  if (cvvText && !/^\d{3,4}$/.test(cvvText)) return { ok: false, error: "cvv_invalid" };
  const ref = "cr_" + crypto.randomBytes(24).toString("base64url");
  cardHolds.set(ref, {
    pan: Buffer.from(number, "latin1"),
    cvv: cvvText ? Buffer.from(cvvText, "latin1") : null,
    expMMYY,
    brand: entry.brand || brandOf(number),
    last4: number.slice(-4),
    expiry: entry.expiry || null,
    rep,
    expiresAt,
  });
  return { ok: true, ref, expiresAt };
}

/**
 * Spend the hold. ONE presentation is the whole life of a reference: it is
 * removed from the store before anything else is checked, so a wrong rep or a
 * late arrival cannot be retried and cannot be used to probe the store. On
 * every refusal the number is zeroed here, before returning.
 */
export function redeemCardHold(ref, { now = Date.now(), rep } = {}) {
  const key = String(ref || "");
  const e = cardHolds.get(key);
  if (!e) return { ok: false, error: "unknown" };
  cardHolds.delete(key);
  if (e.expiresAt <= now) {
    zeroHold(e);
    return { ok: false, error: "expired" };
  }
  if (rep !== undefined && String(rep || "") !== e.rep) {
    zeroHold(e);
    return { ok: false, error: "rep_mismatch" };
  }
  return { ok: true, entry: e };
}

export function cardHoldCount() {
  return cardHolds.size;
}

/** Zero and drop every hold whose five minutes are up. */
export function sweepCardHolds({ now = Date.now() } = {}) {
  let n = 0;
  for (const [ref, e] of cardHolds) {
    if (e.expiresAt <= now) {
      cardHolds.delete(ref);
      zeroHold(e);
      n += 1;
    }
  }
  return n;
}

export function startCardHoldSweeper({ intervalMs = 30 * 1000 } = {}) {
  const timer = setInterval(() => {
    try {
      sweepCardHolds();
    } catch {
      /* the sweeper never takes the process down */
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export function _resetCardRefsForTests() {
  for (const e of cardHolds.values()) zeroHold(e);
  cardHolds.clear();
  usedTickets.clear();
}

// ── request body ───────────────────────────────────────────────────────────

function headerOf(headers, name) {
  const v = headers ? headers[name] : undefined;
  return v == null ? "" : String(v);
}

/** Read at most `limit` bytes; over the limit -> {error:"body_too_large"}. */
export function readLimitedBody(req, limit = OCR_MAX_BYTES) {
  return new Promise((resolve) => {
    const declared = Number(headerOf(req.headers, "content-length") || 0);
    if (declared > limit) {
      resolve({ error: "body_too_large" });
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        purge(chunks);
        resolve({ error: "body_too_large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve({ buffer: Buffer.concat(chunks) });
      purge(chunks);
    });
    req.on("error", () => {
      if (done) return;
      done = true;
      purge(chunks);
      resolve({ error: "body_read_failed" });
    });
  });
}

/** First file part of a multipart/form-data body (any field name). Returns a copy. */
export function parseMultipartImage(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  if (!m) return null;
  const boundary = (m[1] || m[2] || "").trim();
  if (!boundary) return null;
  const delim = Buffer.from(`--${boundary}`);
  const CRLF2 = Buffer.from("\r\n\r\n");
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    let start = pos + delim.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const headEnd = buf.indexOf(CRLF2, start);
    if (headEnd === -1) break;
    const head = buf.subarray(start, headEnd).toString("latin1");
    const bodyStart = headEnd + 4;
    const next = buf.indexOf(delim, bodyStart);
    if (next === -1) break;
    let bodyEnd = next;
    if (buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    if (/filename=/i.test(head) || /content-type:\s*image\//i.test(head)) {
      return Buffer.from(buf.subarray(bodyStart, bodyEnd));
    }
    pos = next;
  }
  return null;
}

/**
 * Accepts: raw image/* body; multipart/form-data with one file part;
 * application/json {image | imageBase64 | data} as base64 (data: URL allowed).
 * Returns {buffer} (a fresh Buffer) or {error, status}. The request buffer is zeroed here.
 */
export function imageFromBody(raw, contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!raw || !raw.length) return { error: "empty_body", status: 400 };
  try {
    if (ct.startsWith("image/") || ct === "application/octet-stream") {
      return { buffer: Buffer.from(raw) };
    }
    if (ct.startsWith("multipart/form-data")) {
      const part = parseMultipartImage(raw, contentType);
      return part && part.length ? { buffer: part } : { error: "no_image_part", status: 400 };
    }
    if (ct.startsWith("application/json")) {
      let json;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        return { error: "invalid_json", status: 400 };
      }
      let b64 = String((json && (json.image || json.imageBase64 || json.data)) || "");
      const dm = /^data:[^;,]+;base64,(.*)$/s.exec(b64);
      if (dm) b64 = dm[1];
      b64 = b64.replace(/\s+/g, "");
      if (!b64) return { error: "no_image", status: 400 };
      const buffer = Buffer.from(b64, "base64");
      return buffer.length ? { buffer } : { error: "no_image", status: 400 };
    }
    return { error: "unsupported_media", status: 415 };
  } finally {
    purge([raw]);
  }
}

// ── the route ──────────────────────────────────────────────────────────────

const OUTCOME_KEYS = ["method", "ticket", "outcome", "ms"];

function accessLine(fields) {
  const o = {};
  for (const k of OUTCOME_KEYS) o[k] = fields[k] == null ? null : fields[k];
  return `ocr ${JSON.stringify(o)}`;
}

export function sendTicketJson(res, status, obj, { close = false, extra = null } = {}) {
  const body = JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...(extra || {}),
  };
  if (close) headers.Connection = "close";
  res.writeHead(status, headers);
  res.end(body);
}

const send = sendTicketJson;

export function isOcrPath(pathname) {
  const p = String(pathname || "").split("?")[0].replace(/\/+$/, "");
  return p === OCR_PATH;
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {object} deps
 * @param {string} [deps.secret]         OCR_TICKET_SECRET (absent -> 404, body never read)
 * @param {object} deps.engine           ocr-engine pool (or a fake)
 * @param {Function} [deps.log]          console.log by default; gets the access line only
 * @param {Function} [deps.fetchImpl]    gateway fetch (tests mock it)
 * @param {string} [deps.privateKey]     NMI private key (env by default)
 * @param {Function} [deps.clock]
 * @param {object} [deps.trace]          {buffers:[]} collects every Buffer for the purge test
 */
export async function handleOcrRequest(req, res, deps = {}) {
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  const t0 = clock();
  const log = typeof deps.log === "function" ? deps.log : console.log;
  const method = String(req.method || "GET").toUpperCase();
  const secret = deps.secret == null ? ocrSecret() : String(deps.secret || "");
  const cors = corsHeadersFor(headerOf(req.headers, "origin"));
  const done = (status, body, fields, close) => {
    send(res, status, body, { close, extra: cors });
    log(accessLine({ method, ...fields, ms: clock() - t0 }));
  };

  if (!secret) {
    // Disabled: answer here, never proxy a card image onward to the CRM.
    done(404, { ok: false, error: "not_found" }, { ticket: null, outcome: "disabled" }, true);
    return;
  }
  if (method === "OPTIONS") {
    res.writeHead(cors["Access-Control-Allow-Origin"] ? 204 : 403, cors);
    res.end();
    log(accessLine({ method, ticket: null, outcome: cors["Access-Control-Allow-Origin"] ? "preflight" : "preflight_refused", ms: clock() - t0 }));
    return;
  }
  if (method !== "POST") {
    done(405, { ok: false, error: "post_only" }, { ticket: null, outcome: "method" }, true);
    return;
  }
  const token = ticketFromHeaders(req.headers || {});
  if (!token) {
    done(401, { ok: false, error: "ticket_required" }, { ticket: null, outcome: "no_ticket" }, true);
    return;
  }
  const ticket = verifyOcrTicket(token, { secret, now: clock() });
  if (!ticket.ok) {
    done(
      401,
      { ok: false, error: `ticket_${ticket.error}` },
      { ticket: ticket.ticketId || null, outcome: `bad_ticket:${ticket.error}` },
      true
    );
    return;
  }
  consumeOcrTicket(ticket.ticketId, ticket.expiresAt, { now: clock() });
  const fields = { ticket: ticket.ticketId };

  const read = await readLimitedBody(req, OCR_MAX_BYTES);
  if (read.error) {
    const status = read.error === "body_too_large" ? 413 : 400;
    done(status, { ok: false, error: read.error }, { ...fields, outcome: read.error }, true);
    return;
  }
  const img = imageFromBody(read.buffer, headerOf(req.headers, "content-type"));
  if (img.error) {
    done(img.status || 400, { ok: false, error: img.error }, { ...fields, outcome: img.error });
    return;
  }

  const trace = deps.trace && Array.isArray(deps.trace.buffers) ? deps.trace : { buffers: [] };
  trace.buffers.push(img.buffer);
  let result;
  try {
    result = await recognizeCard(img.buffer, {
      engine: deps.engine,
      clock,
      trace,
      deadlineMs: deps.deadlineMs,
      rotations: deps.rotations,
    });
  } catch {
    purge(trace.buffers);
    done(503, { ok: false, error: "engine_error" }, { ...fields, outcome: "engine_error" });
    return;
  }
  purge(trace.buffers);
  if (!result.ok) {
    done(
      result.error === "decode_failed" ? 415 : 422,
      { ok: false, error: result.error, confidence: "none", ocrMs: result.ms, passes: result.passes },
      { ...fields, outcome: result.error }
    );
    return;
  }

  // The hold is ours and local: no gateway call, no add-on, no cost, and the
  // number does not leave this process until the rep charges the card.
  const held = registerCardHold(
    {
      pan: result.pan,
      expiry: result.expiry,
      brand: result.brand,
      rep: ticket.repId,
    },
    { now: clock() }
  );
  result.pan = null;
  delete result.pan;

  // Explicit allowlist: nothing is spread from the OCR result into the wire.
  const body = {
    ok: true,
    brand: result.brand,
    brandLabel: BRAND_LABEL[result.brand] || result.brand,
    last4: result.last4,
    expiry: result.expiry,
    name: result.name,
    confidence: result.confidence,
    confirmLast4: result.confidence !== "high",
    sources: result.sources,
    rotation: result.rotation,
    // One name for the reference at both ends of the flow: what this route
    // hands out is exactly what POST /__nesher_pay/charge takes as token_ref.
    token_ref: held.ok ? held.ref : null,
    token_ref_expires_at: held.ok ? new Date(held.expiresAt).toISOString() : null,
    token_ref_error: held.ok ? null : held.error,
    ocrMs: result.ms,
    passes: result.passes,
  };
  done(200, body, {
    ...fields,
    outcome: `ok:${result.confidence}${held.ok ? "" : ":" + held.error}`,
  });
}

// ── the card-hold door: a typed, pasted or spoken card (23 Sep 2026) ────────
//
// Joseph, 23 Sep: "make it work by uploading a picture, make it also work by
// pasting in numbers or by writing in numbers or by speaking in numbers."
// The desk chat reads the number out of the rep's words (never the model) and
// sends it HERE, server to server, with a one-time "hold" ticket bound to the
// rep. This puts it behind the SAME in-memory hold the photo reader uses and
// answers with the SAME shape as /ocr, so the chat draws the same tile and the
// charge door spends it the same way. Nothing is written anywhere: the access
// line carries the ticket id and an outcome word, never a digit.

export const CARD_HOLD_PATH = "/__nesher_pay/card-hold";
const CARD_HOLD_BODY_MAX = 4 * 1024;

export function isCardHoldPath(pathname) {
  const p = String(pathname || "").split("?")[0].replace(/\/+$/, "");
  return p === CARD_HOLD_PATH;
}

/** "12/30", "1230", "12/2030", "12-30", "12 30" -> "MM/YY" when it is a real, unexpired month. */
export function normalizeExpiry(raw, now = new Date()) {
  const s = String(raw == null ? "" : raw).trim();
  let m = /^(\d{1,2})\s*[\/\-. ]\s*(\d{2}|\d{4})$/.exec(s) || /^(\d{2})(\d{2})$/.exec(s) || /^(\d{2})(\d{4})$/.exec(s);
  if (!m) return null;
  return parseExpiry(`${String(m[1]).padStart(2, "0")}/${m[2]}`, now);
}

export async function handleCardHoldRequest(req, res, deps = {}) {
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  const t0 = clock();
  const log = typeof deps.log === "function" ? deps.log : console.log;
  const method = String(req.method || "GET").toUpperCase();
  const secret = deps.secret == null ? ocrSecret() : String(deps.secret || "");
  const done = (status, body, fields) => {
    send(res, status, body, { close: true });
    log(`hold ${JSON.stringify({ method, ticket: fields.ticket || null, outcome: fields.outcome || null, ms: clock() - t0 })}`);
  };
  if (!secret) return done(404, { ok: false, error: "not_found" }, { outcome: "disabled" });
  if (method !== "POST") return done(405, { ok: false, error: "post_only" }, { outcome: "method" });
  const token = ticketFromHeaders(req.headers || {});
  if (!token) return done(401, { ok: false, error: "ticket_required" }, { outcome: "no_ticket" });
  const ticket = verifyTicket(token, { secret, now: clock(), kind: "hold" });
  if (!ticket.ok) {
    return done(401, { ok: false, error: `ticket_${ticket.error}` }, { ticket: ticket.ticketId || null, outcome: `bad_ticket:${ticket.error}` });
  }
  consumeTicket(ticket.ticketId, ticket.expiresAt, { now: clock() });
  const fields = { ticket: ticket.ticketId };

  const read = await readLimitedBody(req, CARD_HOLD_BODY_MAX);
  if (read.error) return done(read.error === "body_too_large" ? 413 : 400, { ok: false, error: read.error }, { ...fields, outcome: read.error });
  let body = null;
  try {
    body = JSON.parse(read.buffer.toString("utf8") || "{}");
  } catch {
    body = null;
  }
  purge([read.buffer]);
  if (!body || typeof body !== "object" || Array.isArray(body)) return done(400, { ok: false, error: "invalid_json" }, { ...fields, outcome: "invalid_json" });

  const digits = String(body.pan == null ? "" : body.pan).replace(/[\s\-.]/g, "");
  const expRaw = body.exp == null ? body.expiry : body.exp;
  const cvvRaw = body.cvv == null ? "" : String(body.cvv).trim();
  const nameRaw = typeof body.name === "string" ? body.name : "";
  const source = body.source === "spoken" ? "spoken" : "typed";
  // Off the body now; only the locals below hold them until the hold does.
  body.pan = null;
  body.cvv = null;
  delete body.pan;
  delete body.cvv;

  if (!/^\d{13,19}$/.test(digits) || !luhnOk(digits)) return done(400, { ok: false, error: "pan_invalid" }, { ...fields, outcome: "pan_invalid" });
  // NOT sliced: a five-digit slip must never reach the bank as a four-digit code.
  if (cvvRaw && !/^\d{3,4}$/.test(cvvRaw)) return done(400, { ok: false, error: "cvv_invalid" }, { ...fields, outcome: "cvv_invalid" });
  const expiry = normalizeExpiry(expRaw, new Date(clock()));
  if (!expiry) return done(400, { ok: false, error: "expiry_invalid" }, { ...fields, outcome: "expiry_invalid" });
  const brand = brandOf(digits);
  const held = registerCardHold({ pan: digits, expiry, brand, rep: ticket.repId, cvv: cvvRaw }, { now: clock() });
  if (!held.ok) return done(400, { ok: false, error: held.error }, { ...fields, outcome: held.error });
  const name = nameCandidate(nameRaw) || null;

  // Explicit allowlist, the /ocr shape: the chat reads both with one mapping.
  return done(
    200,
    {
      ok: true,
      brand: brand || "card",
      brandLabel: BRAND_LABEL[brand] || "Card",
      last4: digits.slice(-4),
      expiry: expiry,
      name: name,
      // Typed digits are what the rep meant; spoken ones were heard, so the rep confirms the last four.
      confidence: source === "spoken" ? "low" : "high",
      confirmLast4: source === "spoken",
      source: source,
      cvv_held: Boolean(cvvRaw),
      token_ref: held.ref,
      token_ref_expires_at: new Date(held.expiresAt).toISOString(),
      token_ref_error: null,
    },
    { ...fields, outcome: `ok:${source}${cvvRaw ? ":cvv" : ""}` }
  );
}
