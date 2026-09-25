/**
 * The low-contrast ladder (25 Sep 2026, Hershy's white-on-white card, Joseph: "the white on white and
 * not well lit"). Unit rules first (the vote that decides whether the ladder's number counts), then
 * the ten synthetic white-on-white, dim-light cards through the REAL engine: never a wrong number,
 * a number the ladder alone carried is always "low", every buffer zeroed; and the ten HELD-OUT white
 * cards, on which the reader live on 25 Sep accepted 3 wrong numbers: never a wrong one now.
 * Every number here is a generated Luhn-valid TEST number; images are rendered in memory only.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  recognizeCard,
  lowContrastPreps,
  lowContrastVerdict,
  faintGuardOk,
  readerFamily,
  bandRange,
  purge,
  LC_PREPS,
  LC_MIN_AGREE,
  LC_MIN_AGREE_SEEN,
  LC_FAINT_RANGE,
  LC_VERIFY_AGREE,
} from "../ocr-card.js";
import { sharedEnginePool } from "../ocr-engine.js";
import { buildHardSet } from "./ocr-hard-fixtures.js";

const A = "4111111111111111";
const B = "5555555555554444";
const hit = (pan, source, lc = true) => ({ pan, brand: pan[0] === "4" ? "visa" : "mastercard", source, lc });

describe("the ladder's vote (lowContrastVerdict)", () => {
  it("counts a number that LC_MIN_AGREE different preparations read alike", () => {
    assert.equal(LC_MIN_AGREE, 3);
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:gammaUp@0"), hit(A, "lc:edge@0")];
    assert.equal(lowContrastVerdict(here, []).length, 3);
  });

  it("does not count two preparations alone", () => {
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:gammaUp@0")];
    assert.deepEqual(lowContrastVerdict(here, []), []);
  });

  it("the same preparation twice is one vote", () => {
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:c3@0"), hit(A, "lc:gammaUp@0")];
    assert.deepEqual(lowContrastVerdict(here, []), []);
  });

  it("two preparations count when an ordinary read already saw the same number", () => {
    assert.equal(LC_MIN_AGREE_SEEN, 2);
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:gammaUp@0")];
    const seen = [hit(A, "paddle:p@0", false)];
    assert.equal(lowContrastVerdict(here, seen).length, 2);
  });

  it("does not count when another number has a third of the votes (ladder or ordinary)", () => {
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:c10@0"), hit(A, "lc:gammaUp@0"), hit(A, "lc:lcn@0"), hit(B, "lc:edge@0"), hit(B, "lc:relief@0")];
    assert.deepEqual(lowContrastVerdict(here, []), [], "4 against 2");
    const here2 = [hit(A, "lc:c3@0"), hit(A, "lc:c10@0"), hit(A, "lc:edge@0")];
    const seen2 = [hit(B, "paddle:p@0", false), hit(B, "glyph:a@0", false)];
    assert.deepEqual(lowContrastVerdict(here2, seen2), [], "3 against 2 ordinary reads");
  });

  it("counts against a single stray read when it has three times its votes", () => {
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:c10@0"), hit(A, "lc:gammaUp@0")];
    const seen = [hit(B, "paddle:p@0", false)];
    assert.equal(lowContrastVerdict(here, seen).length, 3);
  });

  it("never counts when the ordinary reads agree on a DIFFERENT last group", () => {
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:c10@0"), hit(A, "lc:gammaUp@0"), hit(A, "lc:edge@0")];
    assert.deepEqual(lowContrastVerdict(here, [], ["4444", "4444"]), []);
    assert.equal(lowContrastVerdict(here, [], ["4444", "4444", "1111"]).length, 4, "one agreeing read keeps it");
    assert.equal(lowContrastVerdict(here, [], ["4444"]).length, 4, "one contrary read is not enough to refuse");
  });

  it("returns only the winning number's reads", () => {
    const here = [hit(A, "lc:c3@0"), hit(A, "lc:c10@0"), hit(A, "lc:gammaUp@0"), hit(A, "lc:lcn@0"), hit(B, "lc:edge@0")];
    const got = lowContrastVerdict(here, []);
    assert.ok(got.length === 4 && got.every((x) => x.pan === A));
  });
});

describe("the faint-cut guard (faintGuardOk)", () => {
  const faint = new Set(["0:600:0"]);
  const on = (pan, source, lineKey = "0:600:0") => ({ pan, source, lineKey });

  it("names the reader of every source; a digit vote is no reader of its own", () => {
    assert.equal(readerFamily("paddle:pc@0"), "paddle");
    assert.equal(readerFamily("lc:gammaUp@0"), "paddle");
    assert.equal(readerFamily("glyph:adark@0"), "glyph");
    assert.equal(readerFamily("lc:glyph-edge@0"), "glyph");
    assert.equal(readerFamily("line612:t@0#raw"), "tesseract");
    assert.equal(readerFamily("adaptive@0#block"), "tesseract");
    assert.equal(readerFamily("vote:0:612:0"), null);
    assert.equal(readerFamily("lcvote:0:612:0"), null);
  });

  it("leaves a number read on a printed (not faint) cut alone", () => {
    const hits = [on(A, "paddle:p@0", "0:365:0"), on(A, "paddle:pc@0", "0:365:0")];
    assert.equal(faintGuardOk(A, hits, faint, []), true);
  });

  it("refuses one reader twice on a faint cut (the held-out white card: Paddle plain + CLAHE, wrong digits)", () => {
    const hits = [on(A, "paddle:p@0"), on(A, "paddle:pc@0"), on(A, "vote:0:600:0")];
    assert.equal(faintGuardOk(A, hits, faint, []), false);
    const tess = [on(A, "adaptive@0#block", undefined), on(A, "line600:t@0#line"), on(A, "line600:t@0#raw")];
    assert.equal(faintGuardOk(A, tess, faint, []), false, "three tesseract reads are still one reader");
  });

  it("takes two different readers on a faint cut", () => {
    const hits = [on(A, "paddle:p@0"), on(A, "glyph:adark@0")];
    assert.equal(faintGuardOk(A, hits, faint, []), true);
  });

  it("takes one reader when the ladder on the same cut says the same number twice, and nothing else twice", () => {
    const hits = [on(A, "paddle:p@0"), on(A, "paddle:pc@0")];
    assert.equal(LC_VERIFY_AGREE, 2);
    assert.equal(faintGuardOk(A, hits, faint, [on(A, "lc:c3@0"), on(A, "lc:lcn@0")]), true);
    assert.equal(faintGuardOk(A, hits, faint, [on(A, "lc:c3@0")]), false, "one ladder read is not enough");
    assert.equal(faintGuardOk(A, hits, faint, [on(A, "lc:c3@0"), on(A, "lc:c3@0")]), false, "the same preparation twice is one");
    assert.equal(faintGuardOk(A, hits, faint, [on(A, "lc:c3@0"), on(A, "lc:lcn@0"), on(B, "lc:edge@0"), on(B, "lc:relief@0")]), false, "the ladder also says another number twice");
    assert.equal(faintGuardOk(A, hits, faint, [on(A, "lc:c3@0", "0:900:0"), on(A, "lc:lcn@0", "0:900:0")]), false, "the ladder read another cut");
  });
});

describe("the ladder's preparations", () => {
  it("makes every preparation in LC_PREPS order, trimmed ones to the digit rows, and all of it is purgeable", async () => {
    const w = 400;
    const h = 100;
    const data = Buffer.alloc(w * h, 200);
    for (let y = 40; y < 60; y += 1) for (let x = 50; x < 350; x += 7) data[y * w + x] = 170;
    const scratch = [];
    const preps = await lowContrastPreps({ data, width: w, height: h }, scratch);
    assert.deepEqual(preps.map((p) => p.name), LC_PREPS.map(([n]) => n));
    for (const [i, p] of preps.entries()) {
      const trimmed = LC_PREPS[i][1];
      assert.equal(p.img.width, w, p.name);
      assert.equal(p.img.height, trimmed ? 60 : h, p.name);
      assert.equal(p.img.data.length, p.img.width * p.img.height, p.name);
    }
    assert.ok(scratch.length >= preps.length);
    purge(scratch);
    for (const b of scratch) assert.ok(b.every((x) => x === 0), "every buffer the ladder made is zeroed by purge");
  });

  it("bandRange tells a faint cut from a printed one", () => {
    const flat = { data: Buffer.alloc(1000, 190), width: 100, height: 10 };
    assert.equal(bandRange(flat), 0);
    const print = { data: Buffer.alloc(1000, 240), width: 100, height: 10 };
    for (let i = 0; i < 400; i += 1) print.data[i] = 20;
    assert.ok(bandRange(print) >= LC_FAINT_RANGE);
    const faint = { data: Buffer.alloc(1000, 200), width: 100, height: 10 };
    for (let i = 0; i < 400; i += 1) faint.data[i] = 175;
    assert.ok(bandRange(faint) < LC_FAINT_RANGE);
  });
});

describe("white-on-white, dim light (real engine)", () => {
  const NOW = new Date(Date.UTC(2026, 8, 24, 12, 0, 0));
  const captured = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  let pool;
  let set;
  let held;

  before(async () => {
    for (const k of Object.keys(orig)) console[k] = (...a) => captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    pool = sharedEnginePool();
    await pool.warm();
    set = await buildHardSet({ now: NOW, only: ["white-on-white"] });
    held = await buildHardSet({ now: NOW, only: ["white-on-white"], heldOut: true });
  });

  after(async () => {
    for (const k of Object.keys(orig)) console[k] = orig[k];
    if (pool) await pool.close();
  });

  it("renders ten cards (and ten held-out), the same ten whatever else the corpus selects", async () => {
    assert.equal(set.length, 10);
    assert.equal(held.length, 10);
    const all = (await buildHardSet({ now: NOW })).filter((s) => s.cat === "white-on-white");
    assert.deepEqual(all.map((s) => s.pan), set.map((s) => s.pan));
    assert.notDeepEqual(held.map((s) => s.pan), set.map((s) => s.pan));
  });

  const run = async (cards, totalMs) => {
    let exact = 0;
    let ladderRan = 0;
    for (const s of cards) {
      const trace = { buffers: [] };
      let winners = [];
      let ran = false;
      const r = await recognizeCard(Buffer.from(s.buffer), {
        engine: pool, now: NOW, trace, totalMs,
        debug: (x) => { if (x.stage === "hits") winners = x.hits; if (x.stage === "lc") ran = true; },
      });
      if (ran) ladderRan += 1;
      for (const b of trace.buffers) assert.ok(b.every((x) => x === 0), `${s.id}: buffer zeroed`);
      if (!r.ok) continue;
      assert.equal(r.pan, s.pan, `${s.id}: a wrong number was accepted`);
      exact += 1;
      const mine = winners.filter((w) => w.startsWith(s.pan.slice(-4) + "/"));
      if (mine.length && mine.every((w) => / lc(vote)?:/.test(w))) assert.equal(r.confidence, "low", `${s.id}: ladder-only read must be low`);
      r.pan = null;
    }
    return { exact, ladderRan };
  };

  it("never returns a wrong number; a ladder-only number is low; buffers are zeroed; the ladder reads some", async () => {
    // A little more than the live 7 s: this suite runs beside the other OCR suites, and the floor is about
    // what the ladder can read, not how busy the test box is (rule F2). Measured 25 Sep at 7 s: 3 of 10.
    const { exact, ladderRan } = await run(set, 10000);
    assert.ok(ladderRan >= 1, "the ladder ran on at least one white card");
    assert.ok(exact >= 2, `white-on-white exact ${exact}/10 is under the floor of 2`);
  });

  it("the held-out white cards: never a wrong number (the reader live on 25 Sep accepted 3 of 10 wrong)", async () => {
    await run(held);
    for (const line of captured) for (const s of [...set, ...held]) assert.ok(!line.includes(s.pan), "no number in any log line");
  });
});
