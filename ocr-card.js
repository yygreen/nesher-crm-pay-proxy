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
// The glyph matcher and the row finder run in a worker thread (ocr-glyph-worker.js): pure
// arithmetic on the main thread froze the proxy for up to a second a read (Gabbai B1, 25 Sep).
import { glyphWorker } from "./ocr-glyph-worker.js";

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

/**
 * Lengths a PHOTO may produce: 15 (Amex), 16, 19. A 13-digit Visa has not been issued for
 * decades, and 13 is exactly what a read that dropped three digits of a 16 looks like -
 * on the hard set such a leftover passed Luhn and was accepted as a wrong card (24 Sep).
 * The typed card-hold door keeps its own 13-19 rule.
 */
const PHOTO_LENGTHS = new Set([15, 16, 19]);

function panIfValid(digits) {
  if (!PHOTO_LENGTHS.has(digits.length)) return null;
  const brand = brandOf(digits);
  if (!brand) return null;
  if (!luhnOk(digits)) return null;
  return { pan: digits, brand };
}

/**
 * Every run of 13-19 digits (spaces and dashes ignored inside a line) that
 * passes Luhn and a brand range. Stray digits glued on (chip noise, a logo
 * digit) are dropped only when they stand as their OWN printed group: the run
 * is split where the card prints its gaps and every window of whole groups is
 * tried. A digit blob with no gaps is never trimmed (24 Sep: cutting one or
 * two digits off either end of a 17-18 digit blob gives six more chances for
 * a wrong number to pass Luhn by luck - that is how two wrong numbers were
 * accepted on the hard set).
 */
export function extractPans(text) {
  const out = [];
  const seen = new Set();
  const keep = (hit) => {
    if (!hit || seen.has(hit.pan)) return;
    seen.add(hit.pan);
    out.push(hit);
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const runs = line.replace(/[^0-9 \-]/g, "\n").split("\n");
    for (const run of runs) {
      const groups = run.split(/[ \-]+/).filter(Boolean);
      const digits = groups.join("");
      if (digits.length < 13) continue;
      if (digits.length <= 19) {
        const whole = panIfValid(digits);
        if (whole) { keep(whole); continue; }
      }
      for (let i = 0; i < groups.length; i += 1) {
        let s = "";
        for (let j = i; j < groups.length; j += 1) {
          s += groups[j];
          if (s.length > 19) break;
          if (i === 0 && j === groups.length - 1) continue; // the whole run, tried above
          if (s.length >= 13) keep(panIfValid(s));
        }
      }
    }
  }
  return out;
}

/**
 * The printed groups of a number line, for voting digit by digit across reads
 * that each got a different digit wrong. Returns [{key, groups}] for every
 * window of whole groups that has a card's shape (4-4-4-4, 4-6-5, or two
 * lines of 4-4). The text is never kept past the read.
 */
const GROUP_SHAPES = ["4-4-4-4", "4-6-5", "4-4-4-4-3"];
export function groupedReads(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/[^0-9 \-]/g, " ").split(/[ \-]+/).filter(Boolean));
  const scan = (groups) => {
    for (let i = 0; i < groups.length; i += 1) {
      for (const shape of GROUP_SHAPES) {
        const lens = shape.split("-").map(Number);
        if (i + lens.length > groups.length) continue;
        let ok = true;
        for (let k = 0; k < lens.length; k += 1) if (groups[i + k].length !== lens[k]) { ok = false; break; }
        if (ok) out.push({ key: shape, groups: groups.slice(i, i + lens.length) });
      }
    }
  };
  for (let li = 0; li < lines.length; li += 1) {
    scan(lines[li]);
    // A vertical card prints the number on two lines: 4-4 over 4-4, or 4-6 over 5.
    if (li + 1 < lines.length) scan([...lines[li].slice(-2), ...lines[li + 1].slice(0, 2)]);
  }
  return out;
}

/**
 * Digit-by-digit majority across the reads of one number line that share a
 * shape. Needs three reads; every position must have a clear winner (more
 * than half the reads). Returns the card numbers that pass Luhn + brand.
 */
export function consensusPans(reads) {
  const byKey = new Map();
  for (const r of reads || []) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r.groups.join(""));
  }
  const out = [];
  for (const [, strs] of byKey) {
    if (strs.length < 3) continue;
    const L = strs[0].length;
    let s = "";
    let clear = true;
    for (let p = 0; p < L; p += 1) {
      const count = new Map();
      for (const x of strs) count.set(x[p], (count.get(x[p]) || 0) + 1);
      const [best, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
      if (n * 2 <= strs.length) { clear = false; break; }
      s += best;
    }
    if (!clear) continue;
    const hit = panIfValid(s);
    if (hit) out.push(hit);
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
  const second = ranked[1] ? { pan: ranked[1].pan, sources: ranked[1].sources } : null;
  // `second` stays inside the reader (the two-cards decision); it never reaches a response.
  return { ...winner, confidence: high ? "high" : "low", second };
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
  const meta = await sharp(input, { failOn: "none", limitInputPixels: 60e6 }).metadata();
  const origMaxSide = Math.max(meta.width || 0, meta.height || 0);
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
  return { variants, width, height, gray, origMaxSide };
}

async function rotated(buffer, degrees, scratch) {
  if (!degrees) return buffer;
  const sharp = await loadSharp();
  const out = await sharp(buffer).rotate(degrees).png({ compressionLevel: 1 }).toBuffer();
  scratch.push(out);
  return out;
}

// ── formats: PDF, HEIC ─────────────────────────────────────────────────────

/** What the bytes are, by their first bytes (the content type is the sender's guess). */
export function sniffFormat(buf) {
  if (!buf || buf.length < 12) return "unknown";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "pdf";
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs)$/.test(brand)) return "heic";
    if (/^(avif|avis|mif1|msf1)$/.test(brand)) return "heif";
  }
  return "image";
}

/**
 * The largest picture inside a PDF (a scan, a "print to PDF" of a photo, a
 * bank statement page with the card on it). JPEG streams (DCTDecode) are
 * handed over as they are; 8-bit Flate streams (RGB or grey, PNG predictors
 * included) are rebuilt as raw pixels. A PDF with no picture (vector text
 * only) returns null - "that PDF has no picture of a card in it".
 * Every intermediate Buffer goes to `scratch` so the caller zeroes it.
 */
/** The largest picture a PDF may declare (25 MP, a 5000 x 5000 scan). */
export const PDF_MAX_PIXELS = 25e6;

export async function imageFromPdf(pdf, scratch = []) {
  const zlib = await import("node:zlib");
  const src = pdf.toString("latin1");
  const found = [];
  const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(src))) {
    const dict = m[1];
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const start = m.index + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) continue;
    let stop = end;
    while (stop > start && (src.charCodeAt(stop - 1) === 0x0a || src.charCodeAt(stop - 1) === 0x0d)) stop -= 1;
    const w = Number((/\/Width\s+(\d+)/.exec(dict) || [])[1] || 0);
    const h = Number((/\/Height\s+(\d+)/.exec(dict) || [])[1] || 0);
    // Bounds before any work (Gabbai C1): a declared picture over 25 MP is refused unread.
    if (!w || !h || w * h > PDF_MAX_PIXELS) continue;
    found.push({ dict, start, stop, w, h });
  }
  found.sort((a, b) => b.w * b.h - a.w * a.h);
  for (const f of found) {
    const bytes = Buffer.from(pdf.subarray(f.start, f.stop));
    scratch.push(bytes);
    if (/\/DCTDecode/.test(f.dict)) return bytes;
    if (!/\/FlateDecode/.test(f.dict) || /\/Filter\s*\[[^\]]*\/\w+\s+\/\w+/.test(f.dict)) continue;
    const bpc = Number((/\/BitsPerComponent\s+(\d+)/.exec(f.dict) || [])[1] || 8);
    if (bpc !== 8) continue;
    const ch = /\/DeviceGray/.test(f.dict) ? 1 : /\/DeviceRGB/.test(f.dict) ? 3 : 0;
    if (!ch) continue;
    let raw;
    // Never inflate past the picture's own size: a 10 KB stream can claim gigabytes.
    try { raw = zlib.inflateSync(bytes, { maxOutputLength: f.w * f.h * ch + f.h }); } catch { continue; }
    scratch.push(raw);
    const pred = Number((/\/Predictor\s+(\d+)/.exec(f.dict) || [])[1] || 1);
    let pix = raw;
    if (pred >= 10) {
      const row = f.w * ch;
      pix = Buffer.alloc(row * f.h);
      scratch.push(pix);
      for (let y = 0; y < f.h; y += 1) {
        // Undoing the PNG predictor is main-thread arithmetic: hand the loop back every 64 rows.
        if (y && y % 64 === 0) await new Promise((r) => setImmediate(r));
        const t = raw[y * (row + 1)];
        for (let x = 0; x < row; x += 1) {
          const v = raw[y * (row + 1) + 1 + x];
          const a = x >= ch ? pix[y * row + x - ch] : 0;
          const b = y ? pix[(y - 1) * row + x] : 0;
          const c = x >= ch && y ? pix[(y - 1) * row + x - ch] : 0;
          let p = 0;
          if (t === 1) p = a;
          else if (t === 2) p = b;
          else if (t === 3) p = (a + b) >> 1;
          else if (t === 4) { const q = a + b - c; const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
          pix[y * row + x] = (v + p) & 255;
        }
      }
    }
    if (pix.length < f.w * f.h * ch) continue;
    const sharp = await loadSharp();
    const png = await sharp(pix, { raw: { width: f.w, height: f.h, channels: ch } }).png({ compressionLevel: 1 }).toBuffer();
    scratch.push(png);
    return png;
  }
  return null;
}

// ── the stronger read (24 Sep 2026) ────────────────────────────────────────
//
// Joseph, 24 Sep: "i need better reading abilties for complicated cards" and
// "set yourself up for success that you should be able to read them all".
// The fast passes above read a clean card in well under a second. When they
// do not agree, the reader now FINDS the number line (tesseract's own word
// boxes, digits only), cuts that one line out of the full-size picture,
// straightens it, scales it so the digits are ~40 px tall (where the engine
// reads best), and reads the line alone in six preparations (contrast,
// local contrast, inverted, threshold, sharpened, de-noised) and two line
// modes, both ways up. Every read votes. A number is accepted only when two
// different reads agree on it digit for digit and nothing else comes close;
// otherwise the answer is "could not read" with what WAS read (the last four
// when reads agree on them, the expiry, the name) and why.

/** The whole read, fast passes and rescue together, stays under this (Joseph: under ~8 s). */
export const OCR_TOTAL_MS = 7000;
/** Height the line reader scales printed digits to. */
export const LINE_DIGIT_PX = 40;
/** A glyph-matcher reading votes only when every glyph in it was a clear match (calibrated on the hard set). */
export const GLYPH_MIN_MARGIN = 0.04;
export const GLYPH_MIN_SCORE = 0.35;
const LOCATE_SIDE = 1100;

/** CLAHE tile that fits the picture (libvips refuses a window larger than the image: 'hist_local: window too large'). */
function claheTile(want, w, h) {
  return Math.max(3, Math.min(want, w - 1, h - 1));
}

function toGray1(data, info) {
  if (info.channels === 1) return data;
  const one = Buffer.alloc(info.width * info.height);
  for (let i = 0, j = 0; i < one.length; i += 1, j += info.channels) one[i] = data[j];
  return one;
}

async function rawGray(sharpChain, scratch) {
  const r = await sharpChain.raw().toBuffer({ resolveWithObject: true });
  scratch.push(r.data);
  const g = toGray1(r.data, r.info);
  if (g !== r.data) scratch.push(g);
  return { data: g, width: r.info.width, height: r.info.height };
}

async function rotateGray(img, deg, scratch) {
  if (!deg) return img;
  const sharp = await loadSharp();
  const mean = Math.round(sampledMean(img.data));
  return rawGray(
    sharp(img.data, { raw: { width: img.width, height: img.height, channels: 1 } })
      .rotate(deg, { background: { r: mean, g: mean, b: mean } })
      .toColourspace("b-w"),
    scratch
  );
}

/** Mean, share of blown-out pixels, and sharpness (variance of the Laplacian) of a region. */
export function regionStats(img, box) {
  const { data, width } = img;
  const x0 = Math.max(1, Math.floor(box ? box.left : 1));
  const y0 = Math.max(1, Math.floor(box ? box.top : 1));
  const x1 = Math.min(img.width - 2, Math.ceil(box ? box.left + box.width : img.width - 2));
  const y1 = Math.min(img.height - 2, Math.ceil(box ? box.top + box.height : img.height - 2));
  let n = 0, sum = 0, sat = 0, lap = 0, lap2 = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 60000)));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = y * width + x;
      const v = data[i];
      sum += v;
      if (v >= 250) sat += 1;
      const L = 4 * v - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      lap += L;
      lap2 += L * L;
      n += 1;
    }
  }
  if (!n) return { mean: 0, sat: 0, sharp: 0 };
  const mu = lap / n;
  return { mean: sum / n, sat: sat / n, sharp: lap2 / n - mu * mu };
}

/** Debug output only: the printed group lengths ("4-4-4-4"), never a digit. */
function digitShape(t) {
  return String(t || "").split(/\r?\n/).map((l) => (l.match(/[0-9]+/g) || []).map((r) => r.length).join("-")).filter(Boolean).join("|");
}

function digitsIn(s) {
  return (String(s).match(/\d/g) || []).length;
}

/**
 * Where are the number lines? tesseract's sparse mode with the digit
 * whitelist, on two or three preparations of the whole picture, gives word
 * boxes; boxes are merged into lines and ranked by how many digits they hold.
 * Only geometry leaves this function.
 */
async function locateLines(engine, img, scratch, budget, { textPass = false, notAfter } = {}) {
  const sharp = await loadSharp();
  const k = LOCATE_SIDE / Math.max(img.width, img.height);
  const lw = Math.max(1, Math.round(img.width * k));
  const lh = Math.max(1, Math.round(img.height * k));
  const base = () => sharp(img.data, { raw: { width: img.width, height: img.height, channels: 1 } }).resize(lw, lh);
  const preps = textPass ? [] : await Promise.all([
    base().normalise().png({ compressionLevel: 1 }).toBuffer(),
    base().negate().normalise().png({ compressionLevel: 1 }).toBuffer(),
    base().clahe({ width: claheTile(64, lw, lh), height: claheTile(64, lw, lh), maxSlope: 4 }).png({ compressionLevel: 1 }).toBuffer(),
    // A photo of a screen: the moire is fine and regular, the digits are not - a soft blur keeps only the digits.
    base().blur(1.6).normalise().png({ compressionLevel: 1 }).toBuffer(),
  ]);
  for (const p of preps) scratch.push(p);
  const words = [];
  let passes = 0;
  const results = await Promise.all(preps.map(async (p) => {
    if (budget.left() < 400) return { words: [] };
    passes += 1;
    return engine.recognize(p, { mode: "sparse", charset: "digits", words: true, notAfter });
  }));
  // One text pass too: with letters allowed, tesseract keeps a faint digit group it drops under the digit-only list.
  // It runs on the full-size picture (up to 1600 px): Joseph's own card of 24 Sep, a light card with
  // faint embossed digits, showed its number line only there.
  // It is the SECOND locate, run only when the first found nothing to accept (rescue() below), and
  // de-noised first: on a noisy dark photo an undenoised full-size text pass took 11 s on its own.
  const scaled = results.map(() => k);
  if (textPass && budget.left() >= 2500) {
    passes += 1;
    const full = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 1 } }).median(3).normalise().png({ compressionLevel: 1 }).toBuffer();
    scratch.push(full);
    results.push(await engine.recognize(full, { mode: "sparse", charset: "text", words: true, notAfter }));
    scaled.push(1);
  }
  results.forEach((r, ri) => {
    const kk = scaled[ri];
    for (const w of r.words || []) {
      const d = digitsIn(w.text);
      if (d < 2 || d < 0.6 * w.text.replace(/\s/g, "").length || w.height < 6) continue;
      words.push({ left: w.left / kk, top: w.top / kk, width: w.width / kk, height: w.height / kk, d });
    }
  });
  // Rows of digit-sized shapes, found without tesseract (embossed and metal cards).
  const small = textPass ? null : await rawGray(base().toColourspace("b-w"), scratch);
  // A worker that does not answer within the read's time left is cut off; the read goes on without it.
  const shapeLines = (!small ? [] : await glyphWorker().rows(small, { timeoutMs: Math.max(250, budget.left()) }).catch(() => [])).map((L) => ({ ...L, left: L.left / k, right: L.right / k, top: L.top / k, bottom: L.bottom / k, h: L.h / k }));
  // Dedupe the same word seen in several preparations: keep the one with more digits.
  words.sort((a, b) => b.d - a.d);
  const uniq = [];
  for (const w of words) {
    const dup = uniq.find((u) => {
      const ix = Math.max(0, Math.min(u.left + u.width, w.left + w.width) - Math.max(u.left, w.left));
      const iy = Math.max(0, Math.min(u.top + u.height, w.top + w.height) - Math.max(u.top, w.top));
      return ix * iy > 0.5 * Math.min(u.width * u.height, w.width * w.height);
    });
    if (!dup) uniq.push(w);
  }
  // Words into lines: centres within half a word height, allowing a slope.
  uniq.sort((a, b) => a.left - b.left);
  const lines = [];
  for (const w of uniq) {
    const cy = w.top + w.height / 2;
    let best = null;
    for (const L of lines) {
      const last = L.words[L.words.length - 1];
      const gap = w.left - (last.left + last.width);
      const lcy = last.top + last.height / 2;
      const hh = Math.max(last.height, w.height);
      if (Math.abs(cy - lcy) < 0.6 * hh && gap < 6 * hh && gap > -0.5 * hh && w.height < 1.8 * last.height && last.height < 1.8 * w.height) {
        if (!best || Math.abs(cy - lcy) < best.dy) best = { L, dy: Math.abs(cy - lcy) };
      }
    }
    if (best) best.L.words.push(w);
    else lines.push({ words: [w] });
  }
  const out = lines.map((L) => {
    const ws = L.words;
    const left = Math.min(...ws.map((w) => w.left));
    const right = Math.max(...ws.map((w) => w.left + w.width));
    const top = Math.min(...ws.map((w) => w.top));
    const bottom = Math.max(...ws.map((w) => w.top + w.height));
    const hs = ws.map((w) => w.height).sort((a, b) => a - b);
    const h = hs[Math.floor(hs.length / 2)];
    let angle = 0;
    if (ws.length >= 2) {
      const xs = ws.map((w) => w.left + w.width / 2);
      const ys = ws.map((w) => w.top + w.height / 2);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < xs.length; i += 1) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
      if (sxx > 0) angle = (Math.atan(sxy / sxx) * 180) / Math.PI;
    }
    return { left, right, top, bottom, h, angle, digits: ws.reduce((a, w) => a + w.d, 0), words: ws.length };
  // Four digits are enough to be a candidate: on a light embossed card the engine may see only one group.
  }).filter((L) => L.digits >= 4);
  // A line box taller than one row has swallowed a word from the row above or below (Joseph's card,
  // 24 Sep): also offer a tight line around its strongest word, full width.
  for (const L of [...out]) {
    if (L.bottom - L.top <= 1.3 * L.h) continue;
    const ws = lines.find((x) => x.words && Math.min(...x.words.map((w) => w.top)) === L.top);
    const core = ws ? [...ws.words].sort((a, b) => b.d - a.d)[0] : null;
    if (!core) continue;
    out.push({ ...L, top: core.top, bottom: core.top + core.height, h: core.height, angle: 0, core: true });
  }
  for (const S of shapeLines) {
    const same = out.find((L) => Math.abs((L.top + L.bottom) / 2 - (S.top + S.bottom) / 2) < 0.6 * S.h && L.left < S.right && S.left < L.right);
    if (same) { same.digits = Math.max(same.digits, S.digits); same.left = Math.min(same.left, S.left); same.right = Math.max(same.right, S.right); }
    else out.push(S);
  }
  out.sort((a, b) => b.digits - a.digits || b.h - a.h);
  // Two short lines stacked (a vertical card's 4-4 over 4-4): one band over both.
  for (let i = 0; i < out.length; i += 1) {
    for (let j = 0; j < out.length; j += 1) {
      const a = out[i], b = out[j];
      if (i === j || a.stacked || b.stacked) continue;
      const gap = b.top - a.bottom;
      if (gap > 0 && gap < 1.2 * a.h && Math.abs(a.left - b.left) < 2 * a.h && Math.abs(a.h - b.h) < 0.35 * a.h && a.digits >= 6 && b.digits >= 4 && a.digits + b.digits >= 13 && a.digits <= 12) {
        out.push({ left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: a.top, bottom: b.bottom, h: a.h, angle: 0, digits: a.digits + b.digits, words: a.words + b.words, stacked: true, parts: [a, b] });
      }
    }
  }
  // The number is the card's BIGGEST row of digits: rank by digits (capped) times height^1.5, so a
  // row of small print (legal text, a phone number) never pushes the number line out.
  // A row that touches the edge of the photo is cut off - it is tried last.
  const edge = (L) => (L.top <= 2 || L.bottom >= img.height - 2 ? 0.2 : 1);
  const rank = (L) => Math.min(L.stacked ? 16 : L.digits, 19) * Math.pow(L.h, 1.5) * edge(L);
  out.sort((a, b) => rank(b) - rank(a));
  return { lines: out, passes };
}

/** Cut one line out of the picture, straighten it, scale digits to LINE_DIGIT_PX tall. Returns gray raw. */
async function cutLine(img, line, { flip = false, below = false } = {}, scratch) {
  const sharp = await loadSharp();
  const h = line.h;
  const padX = below ? 1.5 * h : 8 * h;
  let x0 = Math.max(0, Math.floor(line.left - padX));
  let x1 = Math.min(img.width, Math.ceil(line.right + padX));
  const slope = Math.tan((line.angle * Math.PI) / 180);
  const drift = Math.abs(slope) * (x1 - x0) / 2;
  let y0, y1;
  if (below) {
    y0 = Math.floor(line.bottom + 0.2 * h);
    y1 = Math.ceil(line.bottom + 5.5 * h + drift);
  } else {
    // Generous above and below: a line box found on a busy picture can sit off the digits.
    y0 = Math.floor(line.top - 0.75 * h - drift);
    y1 = Math.ceil(line.bottom + 0.75 * h + drift);
  }
  y0 = Math.max(0, y0);
  y1 = Math.min(img.height, y1);
  x1 = Math.max(x1, x0 + 4);
  if (y1 - y0 < 4 || x1 - x0 < 8) return null;
  let chain = sharp(img.data, { raw: { width: img.width, height: img.height, channels: 1 } })
    .extract({ left: x0, top: y0, width: Math.min(img.width - x0, x1 - x0), height: y1 - y0 });
  let band = await rawGray(chain.toColourspace("b-w"), scratch);
  if (Math.abs(line.angle) > 1.5) band = await rotateGray(band, -line.angle, scratch);
  if (flip) band = await rotateGray(band, 180, scratch);
  const f = Math.max(0.25, Math.min(5, LINE_DIGIT_PX / Math.max(4, h)));
  const W = Math.min(3000, Math.max(16, Math.round(band.width * f)));
  const H = Math.max(16, Math.round(band.height * (W / band.width)));
  const scaled = await rawGray(sharp(band.data, { raw: { width: band.width, height: band.height, channels: 1 } }).resize(W, H, { kernel: "lanczos3" }).toColourspace("b-w"), scratch);
  return scaled;
}

/** The six preparations of a cut line, as PNGs (dark ink on a light field where it matters). */
async function linePreps(band, scratch, which) {
  const sharp = await loadSharp();
  const raw = { raw: { width: band.width, height: band.height, channels: 1 } };
  const png = { compressionLevel: 1 };
  const tile = Math.max(8, Math.round(LINE_DIGIT_PX * 2));
  const darkField = sampledMean(band.data) < 128;
  let ink = band.data;
  if (darkField) {
    ink = Buffer.alloc(band.data.length);
    for (let i = 0; i < ink.length; i += 1) ink[i] = 255 - band.data[i];
    scratch.push(ink);
  }
  const win = Math.max(15, Math.round(LINE_DIGIT_PX * 1.6)) | 1;
  const makers = {
    n: () => sharp(band.data, raw).normalise().png(png).toBuffer(),
    c: () => sharp(band.data, raw).clahe({ width: claheTile(tile, band.width, band.height), height: claheTile(tile, band.width, band.height), maxSlope: 5 }).normalise().png(png).toBuffer(),
    i: () => sharp(band.data, raw).negate().normalise().png(png).toBuffer(),
    t: async () => {
      const th = adaptiveThreshold(ink, band.width, band.height, win, 12);
      scratch.push(th);
      return sharp(th, raw).png(png).toBuffer();
    },
    s: () => sharp(ink, raw).sharpen({ sigma: 1.2 }).normalise().png(png).toBuffer(),
    m: () => sharp(ink, raw).median(3).normalise().png(png).toBuffer(),
  };
  const out = [];
  for (const k of which) {
    const b = await makers[k]();
    scratch.push(b);
    out.push({ name: k, buffer: b });
  }
  return out;
}

const PROBLEM_SAY = {
  glare: "I couldn't read the card number - the photo has glare on it. Take it again flat, out of direct light, or type the number here.",
  dark: "I couldn't read the card number - the photo is too dark. Take it again in better light, or type the number here.",
  blurry: "I couldn't read the card number - the photo is blurry. Hold the phone still and take it again, or type the number here.",
  small: "I couldn't read the card number - the card is too small in the photo. Take it again closer, so the card fills the picture, or type the number here.",
  no_number: "I couldn't find a card number in that picture. If the number is on the back of the card, send the back, or type the number here.",
  unclear: "I couldn't read the whole card number. Take it again straight on and flat, or type the number here.",
  two_cards: "I see two cards in that photo. Send one card at a time.",
  covered: "I couldn't read the whole card number - part of it is covered. Take it again with the whole number showing, or type the number here.",
  decode_failed: "That file did not open as a picture. Send a photo or screenshot (JPEG or PNG), or type the number here.",
  heic_unsupported: "That is an iPhone HEIC photo, and I can't open that format here. Send it as a screenshot or JPEG, or type the number here.",
  pdf_no_image: "That PDF has no picture of a card in it. Send a photo or screenshot of the card, or type the number here.",
};

/** The sentence the tile shows when the read failed: what went wrong, what to do, and what WAS read. */
export function sayForFailure(problem, partial) {
  let s = PROBLEM_SAY[problem] || PROBLEM_SAY.unclear;
  if (partial && (partial.last4 || partial.expiry || partial.name)) {
    const got = [];
    if (partial.last4) got.push(`the number ends ${partial.last4}`);
    if (partial.expiry) got.push(`expiry ${partial.expiry}`);
    if (partial.name) got.push(`name ${partial.name}`);
    s += ` What I did read: ${got.join(", ")}.`;
    if (partial.expiry) s += " So you only need to type the full number with that expiry.";
  }
  return s;
}

/**
 * Read one card photo. `engine.recognize(buffer, {mode, charset, words})` is
 * the only OCR door (real pool in ocr-engine.js, fake in tests).
 *
 * @returns {Promise<object>} ok:false -> {ok:false, error, problem, say, partial, ms, passes}
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
  const totalMs = Math.max(deadlineMs, Number(opts.totalMs) || OCR_TOTAL_MS);
  const ladder = Array.isArray(opts.rotations) && opts.rotations.length ? opts.rotations : ROTATION_LADDER;
  const scratch = opts.trace && Array.isArray(opts.trace.buffers) ? opts.trace.buffers : [];
  if (Buffer.isBuffer(input)) scratch.push(input);
  const t0 = clock();
  const budget = { left: () => totalMs - (clock() - t0) };
  // Wall-clock cut-off the engine honours when a queued pass finally gets a worker (Date.now, as the pool uses).
  const notAfter = Date.now() + totalMs - 400;
  let passes = 0;
  const hits = [];
  const texts = [];
  const lineReads = []; // grouped reads of the number line, for the digit vote
  const lastGroups = []; // the last printed group of every line read, for the partial "ends in"
  const noteLast = (text) => {
    for (const l of String(text || "").split(/\r?\n/)) {
      const g = l.replace(/[^0-9 ]/g, " ").split(/ +/).filter(Boolean);
      if (g.length >= 3 && (g[g.length - 1].length === 4 || g[g.length - 1].length === 5)) lastGroups.push(g[g.length - 1].slice(-4));
    }
  };

  const finish = (result) => {
    purge(scratch);
    return { ...result, ms: clock() - t0, passes };
  };
  const fail = (error, problem, partial = null) => finish({
    ok: false, error, problem, say: sayForFailure(problem || error, partial), partial,
  });

  // Formats the picture decoder does not take: PDF (the picture inside it) and HEIC.
  let source = input;
  const format = sniffFormat(input);
  if (format === "pdf") {
    try { source = await imageFromPdf(input, scratch); } catch { source = null; }
    if (!source) return fail("pdf_no_image", "pdf_no_image");
  }

  let built;
  try {
    built = await buildVariants(source, { scratch });
  } catch {
    if (format === "heic") return fail("heic_unsupported", "heic_unsupported");
    return fail("decode_failed", "decode_failed");
  }
  const { variants } = built;

  const accepted = (v) => v && v.confidence === "high";
  const vote = () => voteCandidates(hits);

  // Stage 1: the fast whole-card passes (unchanged from 23 Sep), one rotation at a time.
  const runPass = async (rotation, mode, charset) => {
    const imgs = await Promise.all(variants.map((v) => rotated(v.buffer, rotation, scratch)));
    const results = await Promise.all(
      imgs.map(async (buf, i) => {
        passes += 1;
        const r = await engine.recognize(buf, { mode, charset, notAfter });
        return { variant: variants[i].name, ...r };
      })
    );
    for (const r of results) {
      const source = `${r.variant}@${rotation}#${mode}`;
      texts.push({ source, rotation, variant: r.variant, text: r.text, confidence: r.confidence });
      for (const hit of extractPans(r.text)) hits.push({ ...hit, source });
    }
    return vote();
  };

  // Stage 2: find the number line, cut it out, read it alone.
  let base = null;
  const bases = new Map();
  const baseAt = async (rot) => {
    if (!base) base = { data: built.gray, width: built.width, height: built.height };
    if (!bases.has(rot)) bases.set(rot, await rotateGray(base, rot, scratch));
    return bases.get(rot);
  };
  const seenLines = []; // {rot, line, img} for the partial read and the problem words
  const readLine = async (img, line, rot, flip, which, modes) => {
    const band = await cutLine(img, line, { flip }, scratch);
    if (!band) return;
    const preps = await linePreps(band, scratch, which);
    if (opts.debugBands) for (const p of preps) opts.debugBands(`${Math.round(line.top)}-${rot}-${flip ? 1 : 0}-${p.name}`, Buffer.from(p.buffer));
    // The glyph matcher on the same cut (ocr-glyphs.js): a second reader that knows card fonts.
    // Also on a local-contrast copy (glare lifts one part of the line), and for a number printed on
    // two lines, on each line alone with the two readings joined.
    const glyphReads = [];
    const sharpG = await loadSharp();
    const clahe = await rawGray(sharpG(band.data, { raw: { width: band.width, height: band.height, channels: 1 } })
      .clahe({ width: claheTile(LINE_DIGIT_PX * 2, band.width, band.height), height: claheTile(LINE_DIGIT_PX * 2, band.width, band.height), maxSlope: 6 }).toColourspace("b-w"), scratch);
    if (line.parts) {
      const halves = [];
      for (const part of line.parts) {
        const pb = await cutLine(img, part, { flip }, scratch);
        halves.push(pb ? (await glyphWorker().lines([{ ...pb, minGlyphs: 6 }], { digitPx: LINE_DIGIT_PX, timeoutMs: Math.max(250, budget.left()) }).catch(() => [[]]))[0] : []);
      }
      for (const a of halves[flip ? 1 : 0] || []) {
        const b = (halves[flip ? 0 : 1] || []).find((x) => x.prep === a.prep && x.font === a.font);
        if (!b) continue;
        glyphReads.push({ ...a, text: a.text + " " + b.text, minMargin: Math.min(a.minMargin, b.minMargin), minScore: Math.min(a.minScore, b.minScore), meanScore: (a.meanScore + b.meanScore) / 2 });
      }
    } else {
      // A photo of a screen: soften the moire before the glyphs are cut.
      const soft = await rawGray(sharpG(band.data, { raw: { width: band.width, height: band.height, channels: 1 } }).blur(1.4).toColourspace("b-w"), scratch);
      const [plain, local, softened] = await glyphWorker().lines([band, clahe, soft], { digitPx: LINE_DIGIT_PX, timeoutMs: Math.max(250, budget.left()) }).catch(() => [[], [], []]);
      glyphReads.push(...plain);
      glyphReads.push(...local.map((g) => ({ ...g, prep: "c" + g.prep })));
      glyphReads.push(...softened.map((g) => ({ ...g, prep: "b" + g.prep })));
    }
    for (const g of glyphReads) {
      if (g.minScore >= GLYPH_MIN_SCORE) noteLast(g.text);
      if (opts.debug) opts.debug({ stage: "glyph", prep: g.prep, font: g.font, shape: digitShape(g.text), mean: +g.meanScore.toFixed(3), minS: +g.minScore.toFixed(3), minM: +g.minMargin.toFixed(3) });
      const gsrc = `glyph:${g.prep}@${rot}${flip ? "f" : ""}`;
      const lk = `${rot}:${Math.round(line.top)}:${flip ? 1 : 0}`;
      for (const gr of groupedReads(g.text)) lineReads.push({ ...gr, lineKey: lk });
      if (g.minScore >= GLYPH_MIN_SCORE && (g.minMargin >= GLYPH_MIN_MARGIN || (g.thin <= 1 && g.minMargin >= 0))) {
        const direct = extractPans(g.text);
        for (const hit of direct) hits.push({ ...hit, source: gsrc, lineKey: lk, h: line.h });
        if (!direct.length && g.alt && g.thin === 1) {
          for (const hit of extractPans(g.alt)) hits.push({ ...hit, source: gsrc + ":2nd", lineKey: lk, h: line.h });
        }
      }
    }
    // The glyph matcher is pure arithmetic and runs first; when two of its readings already agree on
    // a card number, the slow tesseract passes on this cut are not needed (a slow box keeps its budget).
    if (!accepted(vote())) {
      const jobs = [];
      for (const p of preps) for (const mode of modes) jobs.push({ p, mode });
      await Promise.all(jobs.map(async ({ p, mode }) => {
        if (budget.left() < 250) return;
        passes += 1;
        const r = await engine.recognize(p.buffer, { mode: line.stacked ? "block" : mode, charset: "digits", notAfter });
        const source = `line${Math.round(line.top)}:${p.name}@${rot}${flip ? "f" : ""}#${mode}`;
        texts.push({ source, rotation: rot, variant: p.name, text: r.text, confidence: r.confidence, line: true });
        noteLast(r.text);
        if (opts.debug) opts.debug({ stage: "line", source, shape: digitShape(r.text) });
        for (const hit of extractPans(r.text)) hits.push({ ...hit, source, lineKey: `${rot}:${Math.round(line.top)}:${flip ? 1 : 0}`, h: line.h });
        for (const g of groupedReads(r.text)) lineReads.push({ ...g, lineKey: `${rot}:${Math.round(line.top)}:${flip ? 1 : 0}` });
      }));
    }
    // Digit-by-digit vote across this line's reads: one more source when it lands on a real number.
    const key = `${rot}:${Math.round(line.top)}:${flip ? 1 : 0}`;
    for (const hit of consensusPans(lineReads.filter((x) => x.lineKey === key))) {
      hits.push({ ...hit, source: `vote:${key}`, lineKey: key, h: line.h });
    }
  };
  const rescue = async (rot) => {
    if (budget.left() < 900) return;
    const img = await baseAt(rot);
    const inside = (L) => L.top > 2 && L.bottom < img.height - 2;
    const locate = async (textPass) => {
      const { lines, passes: lp } = await locateLines(engine, img, scratch, budget, { textPass, notAfter });
      passes += lp;
      if (opts.debug) opts.debug({ stage: "locate", rot, text: textPass, lines: lines.slice(0, 5).map((l) => ({ top: Math.round(l.top), bot: Math.round(l.bottom), left: Math.round(l.left), right: Math.round(l.right), h: Math.round(l.h), d: l.digits, ang: Math.round(l.angle), st: !!l.stacked, sh: !!l.shapes })) });
      return lines;
    };
    const tried = (L) => seenLines.some((s) => s.rot === rot && Math.abs(s.line.top - L.top) < 0.5 * L.h && Math.abs(s.line.bottom - L.bottom) < 0.5 * L.h && Math.abs((s.line.angle || 0) - (L.angle || 0)) < 1);
    const readAll = async (lines) => {
      // Rows cut off by the photo's edge only when there is nothing else.
      const fresh = lines.filter((L) => !tried(L));
      const pool = fresh.filter(inside).length ? fresh.filter(inside) : fresh;
      const top = pool.slice(0, 4);
      for (const line of top) seenLines.push({ rot, line, img });
      for (const line of top) {
        if (accepted(vote()) || budget.left() < 700) break;
        await readLine(img, line, rot, false, ["n", "c", "i", "t", "s", "m"], ["line", "raw"]);
        const lk = `${rot}:${Math.round(line.top)}:0`;
        const gotHere = hits.some((x) => x.lineKey === lk);
        if (!gotHere && !accepted(vote()) && budget.left() > 700) {
          // Upside down, or the digit line is really the other way round: the same cut, turned.
          await readLine(img, line, rot, true, ["n", "c", "i", "t"], ["line"]);
        }
      }
    };
    const rankOf = (L) => Math.min(L.stacked ? 16 : L.digits, 19) * Math.pow(L.h, 1.5) * (inside(L) ? 1 : 0.2);
    let lines = await locate(false);
    let textDone = false;
    // No row inside the photo that already looks like most of a number: find rows the other way
    // (the full-size text pass) BEFORE spending the time on weak rows - that order is what reads
    // Joseph's light embossed card inside the budget on a slow box.
    if (!lines.some((L) => inside(L) && L.digits >= 10) && budget.left() >= 2500) {
      lines = [...lines, ...(await locate(true))].sort((a, b) => rankOf(b) - rankOf(a));
      textDone = true;
    }
    await readAll(lines);
    if (!textDone && !accepted(vote()) && budget.left() >= 2500) await readAll(await locate(true));
  };

  const stages = [];
  const order = [...ladder];
  // Fast pass at the first rotation, then the rescue at 0 and 90 (turned cuts cover 180 and 270),
  // then the remaining fast rotations.
  stages.push(["fast", order[0]]);
  stages.push(["rescue", 0]);
  for (const r of order.slice(1)) {
    stages.push(["fast", r]);
    if (r === 90) stages.push(["rescue", 90]);
  }
  let fastRotation = null;
  for (const [kind, rot] of stages) {
    if (accepted(vote())) break;
    if (kind === "fast") {
      if (clock() - t0 > deadlineMs) continue;
      const v = await runPass(rot, "block", "digits");
      if (v && !accepted(v) && clock() - t0 <= deadlineMs) {
        // 13.3.3 second pass, sparse text, for embossed cards - at the found orientation only.
        await runPass(rot, "sparse", "digits");
      }
      if (v && fastRotation == null) fastRotation = rot;
    } else {
      // The rescue is extra: if it throws (an odd picture size, a decoder edge), what was read stands.
      try { await rescue(rot); } catch (e) { if (opts.debug) opts.debug({ stage: "rescue_error", error: String(e && e.message).slice(0, 80) }); }
    }
  }

  const final = vote();
  // Two different numbers each read more than once: two cards in the frame, unless one is plainly bigger.
  if (final && final.second && final.second.sources >= 2 && !accepted(final)) {
    const sizeOf = (pan) => Math.max(0, ...hits.filter((x) => x.pan === pan && x.h).map((x) => x.h));
    const a = sizeOf(final.pan);
    const b = sizeOf(final.second.pan);
    if (!(a && b && Math.max(a, b) > 1.35 * Math.min(a, b))) {
      return fail("two_cards", "two_cards", null);
    }
    const bigger = a > b ? final.pan : final.second.pan;
    const own = hits.filter((x) => x.pan === bigger);
    hits.length = 0;
    hits.push(...own);
  }
  const win = vote();
  // Diagnosis only (the route never passes opts.debug): the last four, the length and where it came from - never the number.
  if (opts.debug) opts.debug({ stage: "hits", hits: hits.map((x) => `${x.pan.slice(-4)}/${x.pan.length} ${x.source}`) });

  // What was read of the number line even when the whole number was not: the last group, when two reads agree.
  const partialLast4 = () => {
    const tally = new Map();
    for (const l4 of lastGroups) tally.set(l4, (tally.get(l4) || 0) + 1);
    const best = [...tally.entries()].sort((x, y) => y[1] - x[1])[0];
    // Shown to the rep as fact ("the number ends ..."), so it needs three agreeing reads and a clear lead.
    if (!best || best[1] < 3) return null;
    const next = [...tally.entries()].sort((x, y) => y[1] - x[1])[1];
    return next && next[1] * 3 > best[1] ? null : best[0];
  };

  // Expiry and name: from what the passes already saw, then the strip under the number line.
  const readBelow = async (rot, line, img, flip) => {
    let expiry = null;
    let name = null;
    const band = await cutLine(img, { ...line, angle: line.angle }, { below: true, flip }, scratch);
    if (!band) return { expiry, name };
    const preps = await linePreps(band, scratch, ["n", "i"]);
    for (const p of preps) {
      if (expiry && name) break;
      if (budget.left() < 200) break;
      passes += 1;
      const r = await engine.recognize(p.buffer, { mode: "sparse", charset: "text", notAfter });
      if (!expiry) expiry = parseExpiry(r.text, now);
      if (!name) name = pickName(r.text, expiry);
    }
    return { expiry, name };
  };

  if (!win || !accepted(win)) {
    // Nothing accepted: say why, and hand back what was read.
    let expiry = null;
    for (const t of texts) { expiry = parseExpiry(t.text, now); if (expiry) break; }
    let name = null;
    const best = seenLines[0];
    if (best && budget.left() > 300 && !best.line.stacked) {
      const got = await readBelow(best.rot, best.line, best.img, false);
      expiry = expiry || got.expiry;
      name = got.name;
    }
    const last4 = partialLast4();
    const partial = last4 || expiry || name ? { last4, expiry, name } : null;
    let problem = "unclear";
    const whole = regionStats({ data: built.gray, width: built.width, height: built.height });
    if (!seenLines.length) {
      problem = whole.mean < 55 ? "dark" : whole.sharp < 40 ? "blurry" : "no_number";
    } else {
      const L = best.line;
      const st = regionStats(best.img, { left: L.left, top: L.top - 0.5 * L.h, width: L.right - L.left, height: 2 * L.h });
      const scaleBack = Math.max(1, built.origMaxSide || 1) / Math.max(built.width, built.height);
      if (st.sat > 0.03) problem = "glare";
      else if (st.mean < 55 || whole.mean < 50) problem = "dark";
      else if (L.h * scaleBack < 13) problem = "small";
      else if (st.sharp < 60) problem = "blurry";
    }
    return fail("no_card_found", problem, partial);
  }

  // Accepted. Rotation = where the winning reads came from.
  const winHits = hits.filter((x) => x.pan === win.pan);
  const rotOf = (src) => { const m = /@(\d+)/.exec(src); return m ? Number(m[1]) : 0; };
  const rotation = winHits.length ? rotOf(winHits[0].source) : fastRotation || 0;
  const atRot = texts.filter((t) => t.rotation === rotation);
  let expiry = null;
  for (const t of atRot) {
    expiry = parseExpiry(t.text, now);
    if (expiry) break;
  }
  let name = null;
  const lineHit = winHits.find((x) => x.lineKey);
  if (lineHit) {
    const [r, top, fl] = lineHit.lineKey.split(":");
    const seen = seenLines.find((s) => s.rot === Number(r) && Math.round(s.line.top) === Number(top));
    if (seen && !seen.line.stacked) {
      const got = await readBelow(seen.rot, seen.line, seen.img, fl === "1");
      expiry = expiry || got.expiry;
      name = got.name;
    } else if (seen && seen.line.stacked) {
      const got = await readBelow(seen.rot, { ...seen.line, top: seen.line.bottom - seen.line.h }, seen.img, fl === "1");
      expiry = expiry || got.expiry;
      name = got.name;
    }
  }
  if (!name || !expiry) {
    const withPan = atRot.filter((t) => !t.line && extractPans(t.text).some((h) => h.pan === win.pan));
    withPan.sort((a, b) => b.confidence - a.confidence);
    const bestVariant = (withPan[0] || atRot.find((t) => !t.line) || { variant: "stretch" }).variant;
    const vorder = [bestVariant, ...VARIANT_NAMES.filter((n) => n !== bestVariant)];
    for (const vName of vorder.slice(0, 2)) {
      if (name && expiry) break;
      if (budget.left() < 200) break;
      const v = variants.find((x) => x.name === vName);
      if (!v) continue;
      const img = await rotated(v.buffer, rotation, scratch);
      passes += 1;
      const r = await engine.recognize(img, { mode: "sparse", charset: "text", notAfter });
      if (!expiry) expiry = parseExpiry(r.text, now);
      if (!name) name = pickName(r.text, expiry);
    }
  }

  return finish({
    ok: true,
    pan: win.pan,
    brand: win.brand,
    last4: win.pan.slice(-4),
    expiry,
    name,
    // Accepted means two different reads agreed and nothing else came close. Three or more = high;
    // exactly two = low, and the rep confirms the last four before a charge.
    confidence: win.sources >= 3 ? "high" : "low",
    sources: win.sources,
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
export function registerCardHold(entry, { now = Date.now(), ttlMs = CARD_HOLD_TTL_MS, allowNoExpiry = false } = {}) {
  const number = String(entry.pan || "");
  if (!/^\d{12,19}$/.test(number)) return { ok: false, error: "pan_invalid" };
  const rep = String(entry.rep || "").trim();
  if (!rep) return { ok: false, error: "rep_required" };
  const expMMYY = expiryToMMYY(entry.expiry);
  // Mr. AT (25 Sep, the Kaufman charge): a typed card whose expiry comes in the NEXT message is held
  // without one (card-hold `partial`), and fillCardHold adds it. It can never be charged without one:
  // redeemCardHold refuses a hold that still needs its expiry.
  if (!expMMYY && !allowNoExpiry) return { ok: false, error: "expiry_unknown" };
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
    expMMYY: expMMYY || "",
    brand: entry.brand || brandOf(number),
    last4: number.slice(-4),
    expiry: expMMYY ? entry.expiry || null : null,
    rep,
    expiresAt,
    declines: 0,
  });
  return { ok: true, ref, expiresAt, needsExpiry: !expMMYY };
}

/**
 * The missing piece of a held card, typed in a later message (Mr. AT): its expiry, and/or a code.
 * Same rep only - a wrong rep burns the hold, exactly like redeemCardHold. The life of the hold is
 * NOT extended here: five minutes from the read, whatever is added to it.
 */
export function fillCardHold(ref, { now = Date.now(), rep, expiry, cvv } = {}) {
  const key = String(ref || "");
  const e = cardHolds.get(key);
  if (!e) return { ok: false, error: "unknown" };
  if (e.expiresAt <= now) {
    cardHolds.delete(key);
    zeroHold(e);
    return { ok: false, error: "expired" };
  }
  if (String(rep || "") !== e.rep) {
    cardHolds.delete(key);
    zeroHold(e);
    return { ok: false, error: "rep_mismatch" };
  }
  const cvvText = cvv == null ? "" : String(cvv).trim();
  if (cvvText && !/^\d{3,4}$/.test(cvvText)) return { ok: false, error: "cvv_invalid" };
  if (expiry != null && expiry !== "") {
    const mmyy = expiryToMMYY(expiry);
    if (!mmyy) return { ok: false, error: "expiry_invalid" };
    e.expMMYY = mmyy;
    e.expiry = expiry;
  }
  if (cvvText) {
    if (e.cvv && typeof e.cvv.fill === "function") e.cvv.fill(0);
    e.cvv = Buffer.from(cvvText, "latin1");
  }
  return { ok: true, expiresAt: e.expiresAt, entry: { brand: e.brand, last4: e.last4, expiry: e.expiry, cvvHeld: Boolean(e.cvv), needsExpiry: !e.expMMYY } };
}

/** How many clear declines one held card may take before it is dropped (Mr. AT). */
export const MAX_HOLD_DECLINES = 3;

/**
 * AFTER A CLEAR DECLINE (Mr. AT, Joseph 25 Sep): the card goes back behind the SAME reference for
 * five more minutes, bound to the same rep, so a corrected security code, expiry or amount can be
 * tried without sending the card again. Only a clear answer from the gateway ever gets here - an
 * approval spends the hold for good and an unknown outcome zeroes it (it may have charged). After
 * MAX_HOLD_DECLINES declines the number is zeroed and the rep sends the card again.
 */
export function reholdAfterDecline(ref, entry, { now = Date.now(), ttlMs = CARD_HOLD_TTL_MS } = {}) {
  const key = String(ref || "");
  if (!entry || !entry.pan || !CARD_REF_OK.test(key)) {
    zeroHold(entry);
    return { ok: false, error: "invalid" };
  }
  const n = (Number(entry.declines) || 0) + 1;
  if (n >= MAX_HOLD_DECLINES || cardHolds.has(key)) {
    zeroHold(entry);
    return { ok: false, error: "too_many" };
  }
  entry.declines = n;
  entry.expiresAt = now + Math.min(Number(ttlMs) || CARD_HOLD_TTL_MS, CARD_HOLD_TTL_MS);
  cardHolds.set(key, entry);
  return { ok: true, expiresAt: entry.expiresAt, declinesLeft: MAX_HOLD_DECLINES - n };
}
const CARD_REF_OK = /^cr_[A-Za-z0-9_-]{16,64}$/;

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
  // Never charged without its expiry (Mr. AT partial hold). The desk never arms one; this is the lock.
  if (!e.expMMYY) {
    zeroHold(e);
    return { ok: false, error: "needs_expiry" };
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
    // A PDF (a scan, a bank page) is read for the picture inside it (imageFromPdf).
    if (ct.startsWith("image/") || ct === "application/octet-stream" || ct === "application/pdf") {
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
    // Joseph, 24 Sep: when it cannot read, say what went wrong and what to do, and hand back what
    // WAS read so the rep types only what is missing. `partial` is the last four (when several reads
    // agree), the expiry and the name - never more of the number.
    const partial = result.partial
      ? { last4: result.partial.last4 || null, expiry: result.partial.expiry || null, name: result.partial.name || null }
      : null;
    const format = ["decode_failed", "heic_unsupported", "pdf_no_image"].includes(result.error);
    done(
      format ? 415 : 422,
      {
        ok: false,
        error: result.error,
        problem: result.problem || null,
        say: result.say || sayForFailure(result.problem || result.error, partial),
        partial,
        confidence: "none",
        ocrMs: result.ms,
        passes: result.passes,
      },
      { ...fields, outcome: result.problem && result.problem !== result.error ? `${result.error}:${result.problem}` : result.error }
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

  // FILL (Mr. AT, 25 Sep): the expiry (or a code) for a card ALREADY held, typed in a later message.
  // No number on this body - the reference and the ticket's rep find the hold.
  if (body.token_ref != null && body.pan == null) {
    const ref = String(body.token_ref || "");
    const cvvF = body.cvv == null ? "" : String(body.cvv).trim();
    body.cvv = null;
    delete body.cvv;
    if (!/^cr_[A-Za-z0-9_-]{16,64}$/.test(ref)) return done(400, { ok: false, error: "token_ref_invalid" }, { ...fields, outcome: "fill:token_ref_invalid" });
    const expF = body.exp == null ? body.expiry : body.exp;
    let expiryF = null;
    if (expF != null && String(expF).trim() !== "") {
      expiryF = normalizeExpiry(expF, new Date(clock()));
      if (!expiryF) return done(400, { ok: false, error: "expiry_invalid" }, { ...fields, outcome: "fill:expiry_invalid" });
    }
    if (!expiryF && !cvvF) return done(400, { ok: false, error: "nothing_to_fill" }, { ...fields, outcome: "fill:nothing" });
    const f = fillCardHold(ref, { now: clock(), rep: ticket.repId, expiry: expiryF, cvv: cvvF });
    if (!f.ok) {
      const status = f.error === "cvv_invalid" || f.error === "expiry_invalid" ? 400 : 410;
      return done(status, { ok: false, error: f.error === "unknown" || f.error === "expired" || f.error === "rep_mismatch" ? "token_ref_spent_or_expired" : f.error }, { ...fields, outcome: `fill:${f.error}` });
    }
    return done(
      200,
      {
        ok: true,
        brand: f.entry.brand || "card",
        brandLabel: BRAND_LABEL[f.entry.brand] || "Card",
        last4: f.entry.last4,
        expiry: f.entry.expiry || null,
        needs_expiry: f.entry.needsExpiry === true,
        cvv_held: f.entry.cvvHeld === true,
        token_ref: ref,
        token_ref_expires_at: new Date(f.expiresAt).toISOString(),
      },
      { ...fields, outcome: `fill:ok${expiryF ? ":exp" : ""}${cvvF ? ":cvv" : ""}` }
    );
  }

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
  // A card typed WITHOUT its expiry (Mr. AT): held as `partial` only when the desk asks for it, so the
  // rep's next message ("08/29") completes it instead of the card being typed again. An expiry that was
  // given but is wrong or past is still refused here, in words.
  const partial = body.partial === true && (expRaw == null || String(expRaw).trim() === "");
  if (!expiry && !partial) return done(400, { ok: false, error: "expiry_invalid" }, { ...fields, outcome: "expiry_invalid" });
  const brand = brandOf(digits);
  const held = registerCardHold({ pan: digits, expiry: expiry || null, brand, rep: ticket.repId, cvv: cvvRaw }, { now: clock(), allowNoExpiry: partial });
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
      expiry: expiry || null,
      needs_expiry: !expiry,
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
    { ...fields, outcome: `ok:${source}${cvvRaw ? ":cvv" : ""}${expiry ? "" : ":partial"}` }
  );
}
