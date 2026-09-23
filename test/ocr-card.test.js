import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import {
  OCR_PATH,
  OCR_TICKET_TTL_MS,
  OCR_MAX_BYTES,
  ROTATION_LADDER,
  BRAND_LABEL,
  luhnOk,
  brandOf,
  extractPans,
  parseExpiry,
  expiryToMMYY,
  pickName,
  voteCandidates,
  mintTicket,
  mintOcrTicket,
  verifyTicket,
  verifyOcrTicket,
  consumeTicket,
  bindHashOf,
  ticketFromHeaders,
  corsHeadersFor,
  purge,
  adaptiveThreshold,
  buildVariants,
  recognizeCard,
  registerCardHold,
  redeemCardHold,
  cardHoldCount,
  sweepCardHolds,
  zeroHold,
  CARD_HOLD_TTL_MS,
  parseMultipartImage,
  imageFromBody,
  handleOcrRequest,
  isOcrPath,
  ocrSecret,
  ocrEnabled,
  _resetCardRefsForTests,
} from "../ocr-card.js";
import { tinyImage } from "./ocr-fixtures.js";

const SECRET = "test-ocr-secret-0123456789abcdef";
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const NOW_DATE = new Date(NOW);
const PAN = "4539578763621486"; // synthetic, Luhn-valid, Visa range

/** Fake engine: returns scripted text per call; records every call. */
function fakeEngine(script) {
  const calls = [];
  return {
    calls,
    async recognize(buffer, opts) {
      const idx = calls.length;
      calls.push({ len: buffer.length, ...opts });
      const text = typeof script === "function" ? script(idx, opts) : script[idx] ?? "";
      return { text, confidence: 80 };
    },
  };
}

function ok(res) {
  return { status: res.status, headers: res.headers, body: res.json ? res.json() : null };
}

async function startServer(deps) {
  const logs = [];
  const server = http.createServer((req, res) =>
    handleOcrRequest(req, res, { log: (l) => logs.push(l), clock: () => Date.now(), ...deps })
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    logs,
    url: `http://127.0.0.1:${port}${OCR_PATH}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe("card number rules", () => {
  it("luhn", () => {
    for (const n of ["4111111111111111", "5431111111111111", "371449635398431", "6011000991300009", PAN]) {
      assert.equal(luhnOk(n), true, n);
    }
    assert.equal(luhnOk("4111111111111112"), false);
    assert.equal(luhnOk("41111111"), false);
    assert.equal(luhnOk("abc"), false);
  });

  it("brand ranges of 13.3.4 and lengths", () => {
    assert.equal(brandOf("4111111111111111"), "visa");
    assert.equal(brandOf("4222222222222"), "visa");
    assert.equal(brandOf("5100000000000000"), "mastercard");
    assert.equal(brandOf("5599999999999999"), "mastercard");
    assert.equal(brandOf("2221000000000000"), "mastercard");
    assert.equal(brandOf("2720999999999999"), "mastercard");
    assert.equal(brandOf("2721000000000000"), null);
    assert.equal(brandOf("5600000000000000"), null);
    assert.equal(brandOf("341111111111111"), "amex");
    assert.equal(brandOf("371449635398431"), "amex");
    assert.equal(brandOf("3411111111111111"), null, "amex is 15 digits");
    assert.equal(brandOf("6011000991300009"), "discover");
    assert.equal(brandOf("6440000000000000"), "discover");
    assert.equal(brandOf("6490000000000000"), "discover");
    assert.equal(brandOf("6500000000000000"), "discover");
    assert.equal(brandOf("36000000000000"), null, "diners not in the list");
    assert.equal(brandOf("3530111333300000"), null, "jcb not in the list");
    assert.equal(BRAND_LABEL.amex, "American Express");
  });

  it("extractPans: runs with spaces and dashes, stray digits trimmed, noise ignored", () => {
    const text = "4\n4539 5787 6362 1486\n10/29\n0 0\n\n4";
    assert.deepEqual(extractPans(text), [{ pan: PAN, brand: "visa" }]);
    assert.deepEqual(extractPans("4539-5787-6362-1486"), [{ pan: PAN, brand: "visa" }]);
    assert.deepEqual(extractPans("7 4539 5787 6362 1486"), [{ pan: PAN, brand: "visa" }], "one stray digit at the head");
    assert.deepEqual(extractPans("4539 5787 6362 1486 12"), [{ pan: PAN, brand: "visa" }], "two stray digits at the tail");
    assert.deepEqual(extractPans("4539 5787 6362 1487"), [], "luhn fails");
    assert.deepEqual(extractPans("1234 5678 9012 3456"), [], "no brand");
    assert.deepEqual(extractPans(`${PAN}\n${PAN}`), [{ pan: PAN, brand: "visa" }], "deduped");
    assert.deepEqual(extractPans(""), []);
  });

  it("parseExpiry: first future MM/YY within ten years, time-independent via now", () => {
    assert.equal(parseExpiry("VALID THRU 10/29", NOW_DATE), "10/29");
    assert.equal(parseExpiry("10 / 29", NOW_DATE), "10/29");
    assert.equal(parseExpiry("VALID FROM 10/24 THRU 10/29", NOW_DATE), "10/29", "past date skipped");
    assert.equal(parseExpiry("13/29 08/28", NOW_DATE), "08/28", "month 13 skipped");
    assert.equal(parseExpiry("01/2031", NOW_DATE), "01/31");
    assert.equal(parseExpiry("01/40", NOW_DATE), null, "beyond ten years");
    assert.equal(parseExpiry("08/26", NOW_DATE), null, "this year, month already past");
    assert.equal(parseExpiry("09/26", NOW_DATE), "09/26", "this month still valid");
    assert.equal(parseExpiry("4539 5787 6362 1486", NOW_DATE), null);
    assert.equal(expiryToMMYY("10/29"), "1029");
    assert.equal(expiryToMMYY(null), "");
  });

  it("pickName: longest alphabetic line, below the expiry first, never a brand word", () => {
    const text = "4539 5787 6362 1486\n\nVALID THRU 10/29\n\nAVROHOM COHEN\n\nVISA";
    assert.equal(pickName(text, "10/29"), "AVROHOM COHEN");
    assert.equal(pickName("MIRIAM SCHWARTZ\n10/29\nDEBIT", "10/29"), "MIRIAM SCHWARTZ", "falls back to above");
    assert.equal(pickName("VALID THRU 10/29\nPLATINUM\nVISA", "10/29"), null);
    assert.equal(pickName("dovid katz\n", null), "DOVID KATZ");
    assert.equal(pickName("", null), null);
  });

  it("voteCandidates: agreement across variants is high; a lone or contested read is low", () => {
    assert.equal(voteCandidates([]), null);
    const one = voteCandidates([{ pan: PAN, brand: "visa", source: "a" }]);
    assert.equal(one.confidence, "low");
    assert.equal(one.sources, 1);
    const two = voteCandidates([
      { pan: PAN, brand: "visa", source: "a" },
      { pan: PAN, brand: "visa", source: "b" },
    ]);
    assert.equal(two.confidence, "high");
    const same = voteCandidates([
      { pan: PAN, brand: "visa", source: "a" },
      { pan: PAN, brand: "visa", source: "a" },
    ]);
    assert.equal(same.confidence, "low", "the same source twice is one source");
    const contested = voteCandidates([
      { pan: PAN, brand: "visa", source: "a" },
      { pan: PAN, brand: "visa", source: "b" },
      { pan: "4111111111111111", brand: "visa", source: "c" },
      { pan: "4111111111111111", brand: "visa", source: "d" },
    ]);
    assert.equal(contested.confidence, "low");
    const clear = voteCandidates([
      { pan: PAN, brand: "visa", source: "a" },
      { pan: PAN, brand: "visa", source: "b" },
      { pan: "4111111111111111", brand: "visa", source: "c" },
    ]);
    assert.equal(clear.pan, PAN);
    assert.equal(clear.confidence, "high");
  });
});

describe("tickets", () => {
  beforeEach(() => _resetCardRefsForTests());

  it("mint + verify, five-minute cap, rep bound", () => {
    const t = mintOcrTicket({ repId: "sruly", secret: SECRET, now: NOW, ttlMs: 60 * 60 * 1000 });
    assert.equal(t.expiresAt, NOW + OCR_TICKET_TTL_MS, "ttl clamped to five minutes");
    assert.equal(t.kind, "ocr");
    const v = verifyOcrTicket(t.token, { secret: SECRET, now: NOW + 1000 });
    assert.equal(v.ok, true);
    assert.equal(v.repId, "sruly");
    assert.equal(v.ticketId, t.ticketId);
    assert.equal(ticketFromHeaders({ "x-ocr-ticket": t.token }), t.token);
    assert.equal(ticketFromHeaders({ authorization: `Ticket ${t.token}` }), t.token);
    assert.equal(ticketFromHeaders({ authorization: `Bearer ${t.token}` }), "");
  });

  it("refuses: wrong secret, tampered, expired, reused, malformed, no secret", () => {
    const t = mintOcrTicket({ repId: "sruly", secret: SECRET, now: NOW });
    assert.equal(verifyOcrTicket(t.token, { secret: "another-secret-0123456789", now: NOW }).error, "bad_signature");
    const parts = t.token.split(".");
    parts[2] = "joseph";
    assert.equal(verifyOcrTicket(parts.join("."), { secret: SECRET, now: NOW }).error, "bad_signature");
    assert.equal(verifyOcrTicket(t.token, { secret: SECRET, now: NOW + OCR_TICKET_TTL_MS + 1 }).error, "expired");
    assert.equal(verifyOcrTicket(t.token, { secret: SECRET, now: NOW - 10 * 60 * 1000 }).error, "expired", "a ticket from the future is not honoured");
    consumeTicket(t.ticketId, t.expiresAt, { now: NOW });
    assert.equal(verifyOcrTicket(t.token, { secret: SECRET, now: NOW + 1 }).error, "used");
    assert.equal(verifyOcrTicket("abc", { secret: SECRET, now: NOW }).error, "malformed");
    assert.equal(verifyOcrTicket(t.token, { secret: "", now: NOW }).error, "disabled");
    assert.throws(() => mintOcrTicket({ repId: "bad rep!", secret: SECRET }));
    assert.throws(() => mintOcrTicket({ repId: "sruly", secret: "short" }));
  });

  it("kinds and bindings: a charge ticket is bound to one card ref; an ocr ticket cannot charge", () => {
    const ref = "cr_abcdefghijklmnopqrstuvwx";
    const c = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET, now: NOW });
    assert.equal(c.bindHash, bindHashOf("charge", ref));
    assert.equal(verifyTicket(c.token, { secret: SECRET, now: NOW, kind: "charge", bind: ref }).ok, true);
    assert.equal(verifyTicket(c.token, { secret: SECRET, now: NOW, kind: "charge", bind: "cr_other" }).error, "bind_mismatch");
    assert.equal(verifyTicket(c.token, { secret: SECRET, now: NOW, kind: "ocr" }).error, "kind_mismatch");
    const o = mintOcrTicket({ repId: "sruly", secret: SECRET, now: NOW });
    assert.equal(verifyTicket(o.token, { secret: SECRET, now: NOW, kind: "charge", bind: ref }).error, "kind_mismatch");
    assert.throws(() => mintTicket({ kind: "charge", repId: "sruly", bind: "", secret: SECRET }), /binding/);
    assert.throws(() => mintTicket({ kind: "sale", repId: "sruly", bind: "x", secret: SECRET }), /kind/);
    const v = mintTicket({ kind: "void", repId: "sruly", bind: "12345", secret: SECRET, now: NOW });
    assert.equal(verifyTicket(v.token, { secret: SECRET, now: NOW, kind: "void", bind: "12345" }).ok, true);
    assert.equal(verifyTicket(v.token, { secret: SECRET, now: NOW, kind: "refund", bind: "12345" }).error, "kind_mismatch");
  });

  it("secret gate: shorter than 16 chars is off", () => {
    assert.equal(ocrSecret({ OCR_TICKET_SECRET: "" }), "");
    assert.equal(ocrSecret({ OCR_TICKET_SECRET: "tooshort" }), "");
    assert.equal(ocrEnabled({ OCR_TICKET_SECRET: SECRET }), true);
    assert.equal(ocrEnabled({}), false);
  });
});

describe("purge + image pipeline", () => {
  it("purge zeroes every buffer", () => {
    const a = Buffer.from([1, 2, 3]);
    const b = Buffer.alloc(0);
    assert.equal(purge([a, b, null, "str"]), 1);
    assert.deepEqual([...a], [0, 0, 0]);
  });

  it("adaptiveThreshold: a thin dark stroke on a light field becomes 0, the field 255, nothing else", () => {
    const w = 60;
    const h = 40;
    const gray = Buffer.alloc(w * h, 220);
    for (let y = 5; y < 35; y += 1) for (let x = 29; x < 32; x += 1) gray[y * w + x] = 40;
    const out = adaptiveThreshold(gray, w, h, 15, 10);
    assert.equal(out.length, w * h);
    assert.equal(out[5 * w + 5], 255, "far field");
    assert.equal(out[20 * w + 20], 255, "near field");
    assert.equal(out[20 * w + 30], 0, "stroke");
    for (const v of out) assert.ok(v === 0 || v === 255);
  });

  it("buildVariants makes the four variants and collects every buffer", async () => {
    const scratch = [];
    const img = await tinyImage();
    const { variants, width, height } = await buildVariants(img, { scratch });
    assert.deepEqual(variants.map((v) => v.name), ["stretch", "adaptive", "inverted", "unsharp"]);
    assert.equal(width, 240);
    assert.equal(height, 150);
    for (const v of variants) assert.ok(v.buffer.length > 100);
    assert.ok(scratch.length >= 6);
    purge(scratch);
    for (const b of scratch) assert.ok(b.every((x) => x === 0));
  });

  it("recognizeCard: votes across variants, reads expiry + name, purges, never keeps the image", async () => {
    const digits = `${PAN.replace(/(\d{4})(?=\d)/g, "$1 ")}\n10/29`;
    const engine = fakeEngine((i, o) => (o.charset === "text" ? "VALID THRU 10/29\nAVROHOM COHEN\nVISA" : digits));
    const trace = { buffers: [] };
    const img = await tinyImage();
    const r = await recognizeCard(img, { engine, now: NOW_DATE, trace });
    assert.equal(r.ok, true);
    assert.equal(r.pan, PAN);
    assert.equal(r.brand, "visa");
    assert.equal(r.last4, "1486");
    assert.equal(r.expiry, "10/29");
    assert.equal(r.name, "AVROHOM COHEN");
    assert.equal(r.confidence, "high");
    assert.equal(r.rotation, 0);
    assert.equal(r.sources, 4);
    assert.equal(r.passes, 5, "four block passes + one text pass; no sparse pass when already high");
    assert.ok(trace.buffers.length >= 6);
    for (const b of trace.buffers) assert.ok(b.every((x) => x === 0), "every buffer zeroed");
    assert.ok(img.every((x) => x === 0), "the caller's input buffer is zeroed too");
  });

  it("recognizeCard: rotation ladder is 0, 90, 270, 180 and stops at the first hit", async () => {
    assert.deepEqual(ROTATION_LADDER, [0, 90, 270, 180]);
    const engine = fakeEngine((i, o) => {
      if (o.charset === "text") return "VALID THRU 10/29\nRIVKA KLEIN";
      return i >= 4 && i < 8 ? PAN : "";
    });
    const r = await recognizeCard(await tinyImage(), { engine, now: NOW_DATE });
    assert.equal(r.ok, true);
    assert.equal(r.rotation, 90);
    assert.equal(r.name, "RIVKA KLEIN");
  });

  it("recognizeCard: a lone hit gets a sparse second pass and stays low when nothing agrees", async () => {
    const engine = fakeEngine((i, o) => (o.charset === "text" ? "" : i === 0 ? PAN : ""));
    const r = await recognizeCard(await tinyImage(), { engine, now: NOW_DATE });
    assert.equal(r.ok, true);
    assert.equal(r.confidence, "low");
    assert.equal(r.sources, 1);
    assert.ok(engine.calls.some((c) => c.mode === "sparse" && c.charset === "digits"), "sparse pass ran");
    assert.equal(r.name, null);
    assert.equal(r.expiry, null);
  });

  it("recognizeCard: nothing found -> no_card_found after the whole ladder; bad bytes -> decode_failed", async () => {
    const engine = fakeEngine(() => "hello 1234");
    const r = await recognizeCard(await tinyImage(), { engine, now: NOW_DATE });
    assert.equal(r.ok, false);
    assert.equal(r.error, "no_card_found");
    assert.equal(engine.calls.length, 16, "4 variants x 4 rotations");
    const bad = await recognizeCard(Buffer.from("not an image"), { engine, now: NOW_DATE });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "decode_failed");
  });

  it("recognizeCard: the deadline stops the ladder", async () => {
    let t = 0;
    const engine = fakeEngine(() => "");
    const clock = () => (t += 1000);
    const r = await recognizeCard(await tinyImage(), { engine, now: NOW_DATE, clock, deadlineMs: 2500 });
    assert.equal(r.ok, false);
    assert.ok(engine.calls.length < 16, `stopped early: ${engine.calls.length}`);
  });
});

describe("the card hold (our own one-time reference, no paid add-on)", () => {
  beforeEach(() => _resetCardRefsForTests());

  const hold = (over = {}) =>
    registerCardHold({ pan: PAN, expiry: "10/29", brand: "visa", rep: "sruly", ...over }, { now: NOW });

  it("mints an unguessable reference bound to the rep, and never carries the number", () => {
    const h = hold();
    assert.equal(h.ok, true);
    // 24 random bytes base64url = 32 chars = 192 bits.
    assert.match(h.ref, /^cr_[A-Za-z0-9_-]{32}$/);
    assert.equal(h.expiresAt, NOW + CARD_HOLD_TTL_MS);
    assert.equal(CARD_HOLD_TTL_MS, 5 * 60 * 1000, "five minutes, the ticket's own cap");
    assert.equal(cardHoldCount(), 1);
    assert.equal(JSON.stringify(h).includes(PAN), false);
    assert.equal(JSON.stringify(h).includes(PAN.slice(0, 12)), false);
    // Two holds of the same card are two different references.
    assert.notEqual(hold().ref, h.ref);
  });

  it("refuses to mint without a rep, a real number, or a usable expiry", () => {
    assert.equal(hold({ rep: "" }).error, "rep_required");
    assert.equal(hold({ pan: "4111" }).error, "pan_invalid");
    assert.equal(hold({ pan: null }).error, "pan_invalid");
    assert.equal(hold({ expiry: null }).error, "expiry_unknown");
    assert.equal(cardHoldCount(), 0, "nothing is stored when the mint is refused");
  });

  it("spends once: the second spend is refused and the store is empty", () => {
    const { ref } = hold();
    const first = redeemCardHold(ref, { now: NOW + 1, rep: "sruly" });
    assert.equal(first.ok, true);
    assert.equal(first.entry.last4, "1486");
    assert.equal(first.entry.brand, "visa");
    assert.equal(first.entry.expMMYY, "1029");
    assert.equal(first.entry.pan.toString("latin1"), PAN, "the number is there for the one charge");
    assert.equal(cardHoldCount(), 0);
    const second = redeemCardHold(ref, { now: NOW + 2, rep: "sruly" });
    assert.equal(second.ok, false);
    assert.equal(second.error, "unknown");
  });

  it("refuses after the TTL, and zeroes the number when it does", () => {
    const { ref } = hold();
    const late = redeemCardHold(ref, { now: NOW + CARD_HOLD_TTL_MS + 1, rep: "sruly" });
    assert.equal(late.ok, false);
    assert.equal(late.error, "expired");
    assert.equal(cardHoldCount(), 0);
  });

  it("refuses the wrong rep, burns the reference anyway, and zeroes the number", () => {
    const { ref } = hold();
    const wrong = redeemCardHold(ref, { now: NOW + 1, rep: "hershy" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "rep_mismatch");
    assert.equal(cardHoldCount(), 0, "burned, so a wrong rep cannot retry or probe");
    const retry = redeemCardHold(ref, { now: NOW + 2, rep: "sruly" });
    assert.equal(retry.ok, false, "and the right rep cannot recover it either");
  });

  it("zeroes the number on every refusal path, and on the sweep", () => {
    // Reach the stored Buffer through the refusal paths by holding a reference
    // to it before the redeem, which is exactly what an attacker cannot do.
    const a = hold();
    const gotA = redeemCardHold(a.ref, { now: NOW + 1, rep: "sruly" });
    const bufA = gotA.entry.pan;
    zeroHold(gotA.entry);
    assert.equal(bufA.every((b) => b === 0), true, "zeroed after a spend");

    const b = hold();
    const peekB = redeemCardHold(b.ref, { now: NOW + 1, rep: "sruly" });
    const bufB = peekB.entry.pan;
    // Put it back and let the expiry path zero it.
    const c = registerCardHold({ pan: PAN, expiry: "10/29", rep: "sruly" }, { now: NOW });
    const gotC = redeemCardHold(c.ref, { now: NOW + CARD_HOLD_TTL_MS + 1, rep: "sruly" });
    assert.equal(gotC.error, "expired");
    zeroHold(peekB.entry);
    assert.equal(bufB.every((x) => x === 0), true);
  });

  it("the sweeper drops and zeroes only what is past its five minutes", () => {
    registerCardHold({ pan: PAN, expiry: "10/29", rep: "sruly" }, { now: NOW - 10 * 60 * 1000 });
    registerCardHold({ pan: PAN, expiry: "10/29", rep: "sruly" }, { now: NOW });
    assert.equal(cardHoldCount(), 2);
    assert.equal(sweepCardHolds({ now: NOW }), 1);
    assert.equal(cardHoldCount(), 1);
  });

  it("no gateway call is made to mint a reference (nothing paid is on the path)", () => {
    let called = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { called += 1; throw new Error("no network from the mint"); };
    try {
      assert.equal(hold().ok, true);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(called, 0, "the hold is local: no Customer Vault, no validate, no fee");
  });

  it("the module holds no Customer Vault path at all", () => {
    const src = fs.readFileSync(new URL("../ocr-card.js", import.meta.url), "utf8");
    assert.equal(/add_to_vault/.test(src), false);
    assert.equal(/customer_vault/.test(src), false);
    assert.equal(/payments\/validate/.test(src), false);
    const nmi = fs.readFileSync(new URL("../nmi-card.js", import.meta.url), "utf8");
    assert.equal(/add_to_vault/.test(nmi), false);
    assert.equal(/deleteVaultCustomer/.test(nmi), false);
    assert.equal(/customer_vault:/.test(nmi), false);
  });
});

describe("request body", () => {
  it("parseMultipartImage finds the file part whatever the field name", () => {
    const boundary = "----abc123";
    const img = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="rep"\r\n\r\nsruly\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="card.png"\r\nContent-Type: image/png\r\n\r\n`),
      img,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const part = parseMultipartImage(body, `multipart/form-data; boundary=${boundary}`);
    assert.deepEqual([...part], [...img]);
    assert.equal(parseMultipartImage(Buffer.from("junk"), "multipart/form-data; boundary=x"), null);
    assert.equal(parseMultipartImage(body, "multipart/form-data"), null);
  });

  it("imageFromBody: raw image, json base64 (data URL too), rejects the rest; zeroes the request buffer", () => {
    const raw = Buffer.from([1, 2, 3, 4]);
    const a = imageFromBody(raw, "image/jpeg");
    assert.deepEqual([...a.buffer], [1, 2, 3, 4]);
    assert.ok(raw.every((x) => x === 0), "request buffer zeroed after copy");
    const b64 = Buffer.from([9, 8, 7]).toString("base64");
    assert.deepEqual([...imageFromBody(Buffer.from(JSON.stringify({ image: b64 })), "application/json").buffer], [9, 8, 7]);
    assert.deepEqual([...imageFromBody(Buffer.from(JSON.stringify({ imageBase64: `data:image/png;base64,${b64}` })), "application/json").buffer], [9, 8, 7]);
    assert.equal(imageFromBody(Buffer.from("{}"), "application/json").error, "no_image");
    assert.equal(imageFromBody(Buffer.from("{"), "application/json").error, "invalid_json");
    assert.equal(imageFromBody(Buffer.from("x"), "text/plain").status, 415);
    assert.equal(imageFromBody(Buffer.alloc(0), "image/png").error, "empty_body");
  });
});

describe("POST /__nesher_pay/ocr", () => {
  let img;
  before(async () => {
    img = await tinyImage();
  });
  beforeEach(() => _resetCardRefsForTests());

  it("isOcrPath", () => {
    assert.equal(isOcrPath("/__nesher_pay/ocr"), true);
    assert.equal(isOcrPath("/__nesher_pay/ocr/"), true);
    assert.equal(isOcrPath("/__nesher_pay/ocr?x=1"), true);
    assert.equal(isOcrPath("/__nesher_pay/ocrx"), false);
    assert.equal(isOcrPath("/pay/open"), false);
  });

  it("404 when the secret is absent, for every method, with Connection: close, and the engine is never asked", async () => {
    const engine = fakeEngine(() => PAN);
    const s = await startServer({ secret: "", engine });
    try {
      for (const method of ["POST", "GET", "OPTIONS"]) {
        const r = await fetch(s.url, { method, headers: { "content-type": "image/png", "x-ocr-ticket": "x" }, body: method === "POST" ? Buffer.from(img) : undefined });
        assert.equal(r.status, 404, method);
        assert.equal(r.headers.get("connection"), "close");
        assert.deepEqual(await r.json(), { ok: false, error: "not_found" });
      }
      assert.equal(engine.calls.length, 0);
      assert.equal(s.logs.length, 3);
      assert.match(s.logs[0], /"outcome":"disabled"/);
    } finally {
      await s.close();
    }
  });

  it("401 without a ticket, with a bad one, with a spent one; 405 on GET; nothing else", async () => {
    const engine = fakeEngine(() => PAN);
    const s = await startServer({ secret: SECRET, engine });
    try {
      let r = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.from(img) });
      assert.equal(r.status, 401);
      assert.deepEqual(await r.json(), { ok: false, error: "ticket_required" });
      r = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": "a.b.c" }, body: Buffer.from(img) });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, "ticket_malformed");
      const other = mintOcrTicket({ repId: "sruly", secret: "not-the-secret-0123456789" });
      r = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": other.token }, body: Buffer.from(img) });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, "ticket_bad_signature");
      const old = mintOcrTicket({ repId: "sruly", secret: SECRET, now: Date.now() - 10 * 60 * 1000 });
      r = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": old.token }, body: Buffer.from(img) });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, "ticket_expired");
      const charge = mintTicket({ kind: "charge", repId: "sruly", bind: "cr_x", secret: SECRET });
      r = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": charge.token }, body: Buffer.from(img) });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error, "ticket_kind_mismatch");
      r = await fetch(s.url, { method: "GET", headers: { "x-ocr-ticket": "x" } });
      assert.equal(r.status, 405);
      assert.equal(engine.calls.length, 0);
    } finally {
      await s.close();
    }
  });

  it("200: the tile fields, a card reference, no PAN anywhere, the ticket burns, the log carries four keys only", async () => {
    const digits = `${PAN.replace(/(\d{4})(?=\d)/g, "$1 ")}\n10/29`;
    const engine = fakeEngine((i, o) => (o.charset === "text" ? "VALID THRU 10/29\nAVROHOM COHEN" : digits));
    // The read must reach NO gateway at all: the reference is ours and free.
    const gateway = [];
    const fetchImpl = async (url, init) => {
      gateway.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      throw new Error("the reader must not call the gateway");
    };
    const trace = { buffers: [] };
    const s = await startServer({ secret: SECRET, engine, fetchImpl, privateKey: "k-test", trace });
    try {
      const t = mintOcrTicket({ repId: "sruly", secret: SECRET });
      const r = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": t.token, origin: "https://phone.jrmhotels.com" }, body: Buffer.from(img) });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("access-control-allow-origin"), "https://phone.jrmhotels.com");
      assert.equal(r.headers.get("cache-control"), "no-store");
      const text = await r.text();
      assert.equal(text.includes(PAN), false, "PAN never in the response");
      assert.equal(text.includes("4539 5787"), false);
      const body = JSON.parse(text);
      assert.deepEqual(Object.keys(body).sort(), [
        "brand", "brandLabel", "confidence", "confirmLast4", "expiry", "last4", "name", "ocrMs", "ok", "passes", "rotation", "sources", "token_ref", "token_ref_error", "token_ref_expires_at",
      ]);
      assert.equal(body.ok, true);
      assert.equal(body.brand, "visa");
      assert.equal(body.brandLabel, "Visa");
      assert.equal(body.last4, "1486");
      assert.equal(body.expiry, "10/29");
      assert.equal(body.name, "AVROHOM COHEN");
      assert.equal(body.confidence, "high");
      assert.equal(body.confirmLast4, false);
      assert.match(body.token_ref, /^cr_[A-Za-z0-9_-]{32}$/);
      assert.equal(body.token_ref_error, null);
      assert.equal(gateway.length, 0, "no gateway call: the reference is ours, and free");
      assert.equal(
        new Date(body.token_ref_expires_at).getTime() - Date.now() <= CARD_HOLD_TTL_MS + 2000,
        true,
        "five minutes at most"
      );
      // The hold is bound to the rep on the ticket and to nobody else.
      assert.equal(redeemCardHold(body.token_ref, { rep: "hershy" }).error, "rep_mismatch");
      // the same ticket again
      const again = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": t.token }, body: Buffer.from(img) });
      assert.equal(again.status, 401);
      assert.equal((await again.json()).error, "ticket_used");
      // logs: four keys, never the number, never the rep
      assert.equal(s.logs.length, 2);
      for (const line of s.logs) {
        assert.match(line, /^ocr \{/);
        const o = JSON.parse(line.slice(4));
        assert.deepEqual(Object.keys(o).sort(), ["method", "ms", "outcome", "ticket"]);
        assert.equal(line.includes(PAN), false);
        assert.equal(line.includes("1486"), false);
        assert.equal(line.includes("sruly"), false);
      }
      assert.equal(JSON.parse(s.logs[0].slice(4)).outcome, "ok:high");
      assert.equal(JSON.parse(s.logs[0].slice(4)).ticket, t.ticketId);
      assert.equal(JSON.parse(s.logs[1].slice(4)).outcome, "bad_ticket:used");
      // purge: every buffer the handler held is zero
      assert.ok(trace.buffers.length >= 7);
      for (const b of trace.buffers) assert.ok(b.every((x) => x === 0));
    } finally {
      await s.close();
    }
  });

  it("low confidence asks for the last four; a hold that cannot be made is reported, not fatal; multipart + json bodies", async () => {
    // No expiry anywhere in the text pass: the card is read, but it cannot be
    // held (a sale needs an expiry), so the tile gets the card and no token_ref.
    const lone = () => fakeEngine((i, o) => (o.charset === "text" ? "NO DATE HERE" : i === 0 ? PAN : ""));
    const fetchImpl = async () => { throw new Error("the reader must not call the gateway"); };
    let s = await startServer({ secret: SECRET, engine: lone(), fetchImpl, privateKey: "k" });
    try {
      const boundary = "----ocr";
      const mp = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n`),
        img,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      let t = mintOcrTicket({ repId: "sruly", secret: SECRET });
      let r = await fetch(s.url, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-ocr-ticket": t.token }, body: mp });
      assert.equal(r.status, 200);
      let body = await r.json();
      assert.equal(body.confidence, "low");
      assert.equal(body.confirmLast4, true);
      assert.equal(body.token_ref, null);
      assert.equal(body.token_ref_error, "expiry_unknown");
      assert.equal(body.last4, "1486");
      assert.match(s.logs.at(-1), /"outcome":"ok:low:expiry_unknown"/);
    } finally {
      await s.close();
    }
    s = await startServer({ secret: SECRET, engine: lone(), fetchImpl, privateKey: "k" });
    try {
      const t = mintOcrTicket({ repId: "sruly", secret: SECRET });
      const r = await fetch(s.url, { method: "POST", headers: { "content-type": "application/json", "x-ocr-ticket": t.token }, body: JSON.stringify({ image: `data:image/png;base64,${Buffer.from(img).toString("base64")}` }) });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.last4, "1486");
      assert.equal(body.confidence, "low");
    } finally {
      await s.close();
    }
  });

  it("422 no card, 415 not an image / wrong media type, 413 over 8 MB (declared and streamed), 400 bad json", async () => {
    const engine = fakeEngine(() => "nothing here");
    const s2 = await startServer({ secret: SECRET, engine });
    try {
      const mint = () => mintOcrTicket({ repId: "sruly", secret: SECRET }).token;
      let r = await fetch(s2.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": mint() }, body: Buffer.from(img) });
      assert.equal(r.status, 422);
      let body = await r.json();
      assert.equal(body.ok, false);
      assert.equal(body.error, "no_card_found");
      assert.equal(body.confidence, "none");
      assert.equal(body.passes, 16);
      r = await fetch(s2.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": mint() }, body: Buffer.from("this is not an image at all") });
      assert.equal(r.status, 415);
      assert.equal((await r.json()).error, "decode_failed");
      r = await fetch(s2.url, { method: "POST", headers: { "content-type": "text/plain", "x-ocr-ticket": mint() }, body: "hello" });
      assert.equal(r.status, 415);
      assert.equal((await r.json()).error, "unsupported_media");
      r = await fetch(s2.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": mint(), "content-length": String(OCR_MAX_BYTES + 1) }, body: Buffer.alloc(10) }).catch(() => null);
      if (r) {
        assert.equal(r.status, 413);
      }
      r = await fetch(s2.url, { method: "POST", headers: { "content-type": "application/json", "x-ocr-ticket": mint() }, body: "{not json" });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "invalid_json");
      const big = Buffer.alloc(OCR_MAX_BYTES + 1024, 1);
      r = await fetch(s2.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": mint() }, body: big, duplex: "half" }).catch(() => null);
      if (r) assert.equal(r.status, 413);
      assert.ok(s2.logs.some((l) => /"outcome":"body_too_large"/.test(l)), "413 logged");
    } finally {
      await s2.close();
    }
  });

  it("CORS: preflight only for the two desk hosts; others get no allow-origin", async () => {
    const s = await startServer({ secret: SECRET, engine: fakeEngine(() => "") });
    try {
      let r = await fetch(s.url, { method: "OPTIONS", headers: { origin: "https://phone.josephgreen.ai", "access-control-request-method": "POST" } });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get("access-control-allow-origin"), "https://phone.josephgreen.ai");
      assert.equal(r.headers.get("access-control-allow-methods"), "POST, OPTIONS");
      assert.match(r.headers.get("access-control-allow-headers"), /x-ocr-ticket/);
      r = await fetch(s.url, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
      assert.equal(r.status, 403);
      assert.equal(r.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(corsHeadersFor("https://crm.flynesher.com"), { Vary: "Origin" });
      assert.equal(corsHeadersFor("HTTPS://PHONE.JRMHOTELS.COM")["Access-Control-Allow-Origin"], "https://phone.jrmhotels.com");
    } finally {
      await s.close();
    }
  });

  it("engine failure answers 503 and purges; never a stack in the log", async () => {
    const engine = { async recognize() { throw new Error("wasm exploded with 4539578763621486"); } };
    const trace = { buffers: [] };
    const s = await startServer({ secret: SECRET, engine, trace });
    try {
      const t = mintOcrTicket({ repId: "sruly", secret: SECRET });
      const r = await fetch(s.url, { method: "POST", headers: { "content-type": "image/png", "x-ocr-ticket": t.token }, body: Buffer.from(img) });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, "engine_error");
      assert.equal(s.logs.length, 1);
      assert.equal(s.logs[0].includes(PAN), false);
      assert.match(s.logs[0], /"outcome":"engine_error"/);
      for (const b of trace.buffers) assert.ok(b.every((x) => x === 0));
    } finally {
      await s.close();
    }
  });
});

describe("wiring", () => {
  it("server.js mounts the reader and the money doors before the proxy, health carries the ocr block, Dockerfile copies the modules", () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /isOcrPath\(url\.pathname\)/);
    assert.match(src, /handleOcrRequest\(req, res, \{/);
    assert.match(src, /chargeFamilyPath\(url\.pathname\)/);
    assert.ok(src.indexOf("isOcrPath(url.pathname)") < src.indexOf("isOpenPayPath(url.pathname)"), "reader answers before the pay pages");
    assert.ok(src.indexOf("isOcrPath(url.pathname)") < src.lastIndexOf("proxyWithInject(req, res)"), "reader answers before the proxy");
    assert.match(src, /ocr: \{\s*enabled: ocrEnabled\(\)/);
    assert.match(src, /build: "2026-09-23-off-the-pc"/);
    assert.match(src, /startCardHoldSweeper\(/);
    // The replica proof lives in health: one boot id per process.
    assert.match(src, /const INSTANCE_ID = crypto\.randomBytes\(6\)\.toString\("hex"\)/);
    assert.match(src, /instance: INSTANCE_ID/);
    assert.match(src, /holds: cardHoldCount\(\)/);
    assert.match(src, /ocr route disabled: OCR_TICKET_SECRET not set/);
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const copy = docker.split("\n").find((l) => l.startsWith("COPY ") && l.includes("server.js"));
    for (const m of ["ocr-card.js", "ocr-engine.js", "card-charge.js", "nmi-card.js"]) assert.ok(copy.includes(` ${m} `), `Dockerfile COPY has ${m}`);
    assert.match(docker, /4\.0\.0_best_int|rm -rf node_modules\/@tesseract\.js-data\/eng\/4\.0\.0/);
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.ok(pkg.dependencies["tesseract.js"]);
    assert.ok(pkg.dependencies.sharp);
    assert.ok(pkg.dependencies["@tesseract.js-data/eng"]);
  });

  it("no request-body logging on this route: the source never logs req, body or text", () => {
    const src = fs.readFileSync(new URL("../ocr-card.js", import.meta.url), "utf8");
    const logs = src.split("\n").filter((l) => /console\.(log|warn|error)\(/.test(l));
    assert.deepEqual(logs, [], "ocr-card.js logs only through the injected access line");
    assert.match(src, /const OUTCOME_KEYS = \["method", "ticket", "outcome", "ms"\]/);
  });
});
