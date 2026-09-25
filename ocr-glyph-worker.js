/**
 * The glyph matcher and the row finder, OFF the main thread (Gabbai B1, 25 Sep 2026).
 *
 * ocr-glyphs.js is pure arithmetic. Run on the main thread it froze this
 * process - the front door of crm.flynesher.com, the /pay pages, the NMI
 * webhook, the money hop - for up to a second per hard card. Here it runs in
 * one worker thread, the way tesseract already runs in its own.
 *
 * Every picture sent here is a COPY whose memory is transferred (the main
 * thread keeps no view of it) and this worker overwrites it with zeros as soon
 * as the answer is computed, on success and on error. Readings (digit text)
 * go back to ocr-card.js only; nothing is logged, nothing is written anywhere.
 *
 * Main-thread side: glyphWorker().lines(...) / .rows(...), one lazy worker,
 * unref'd so it never keeps a process alive, re-created after a crash.
 */

import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { readLineGlyphs, findRows } from "./ocr-glyphs.js";
import { paddleReadLine } from "./ocr-paddle.js";

function zero(list) {
  for (const a of list) if (a && typeof a.fill === "function") a.fill(0);
}

if (!isMainThread && parentPort) {
  parentPort.on("message", async (msg) => {
    const held = [];
    let reply;
    try {
      if (msg.kind === "paddle") {
        // PaddleOCR's line recogniser (ocr-paddle.js), one cut line at a time.
        const out = [];
        for (const job of msg.jobs) {
          const band = { data: new Uint8Array(job.buffer), width: job.width, height: job.height };
          held.push(band.data);
          out.push(await paddleReadLine(band));
        }
        reply = { id: msg.id, ok: true, out };
      } else if (msg.kind === "lines") {
        const out = [];
        for (const job of msg.jobs) {
          const band = { data: new Uint8Array(job.buffer), width: job.width, height: job.height };
          held.push(band.data);
          out.push(readLineGlyphs(band, { digitPx: msg.digitPx, minGlyphs: job.minGlyphs || 13 }));
        }
        reply = { id: msg.id, ok: true, out };
      } else if (msg.kind === "rows") {
        const gray = new Uint8Array(msg.buffer);
        held.push(gray);
        reply = { id: msg.id, ok: true, out: findRows(gray, msg.width, msg.height) };
      } else {
        reply = { id: msg.id, ok: false, error: "unknown_kind" };
      }
    } catch (e) {
      reply = { id: msg.id, ok: false, error: String((e && e.message) || e).replace(/\d/g, "#").slice(0, 80) };
    } finally {
      zero(held);
    }
    parentPort.postMessage(reply);
  });
}

let worker = null;
let seq = 0;
const pending = new Map();
let workerFile = fileURLToPath(import.meta.url);
/** For the fence test: how many zeroed copies went out, and how many workers were cut off. */
export const glyphWorkerStats = { sent: 0, timeouts: 0, started: 0 };

/** Tests only: run a different worker script (a stub that never answers). null = the real one. */
export function _setGlyphWorkerFileForTests(file) {
  const w = worker;
  worker = null;
  if (w) w.terminate().catch(() => {});
  workerFile = file || fileURLToPath(import.meta.url);
}

/** Reject everything owed by THIS worker and forget it - never a newer one (Gabbai D1). */
function failAll(w, err) {
  for (const [id, p] of pending) {
    if (p.worker !== w) continue;
    pending.delete(id);
    p.reject(err);
  }
  if (worker === w) worker = null;
}

function ensure() {
  if (worker) return worker;
  const w = new Worker(workerFile);
  glyphWorkerStats.started += 1;
  worker = w;
  w.unref();
  w.on("message", (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (![...pending.values()].some((x) => x.worker === w)) w.unref();
    if (m.ok) p.resolve(m.out);
    else p.reject(new Error(m.error || "glyph_worker_failed"));
  });
  w.on("error", (e) => failAll(w, e));
  w.on("exit", () => failAll(w, new Error("glyph_worker_exit")));
  return w;
}

/** A private copy of the pixels in a fresh ArrayBuffer, so it can be transferred whole. */
function copyOf(data) {
  const ab = new ArrayBuffer(data.length);
  new Uint8Array(ab).set(data);
  glyphWorkerStats.sent += 1;
  return ab;
}

/**
 * One call, raced against the read's own time left (Gabbai D1, 25 Sep): a matcher that hangs on an
 * odd picture must not hold that read - or every read queued behind it - forever. On timeout the
 * worker is terminated (its copies die with it), everything it owed is rejected, and the next call
 * builds a fresh one; the read carries on with what it already has.
 */
function call(msg, transfer, timeoutMs) {
  const w = ensure();
  const id = ++seq;
  msg.id = id;
  w.ref(); // while an answer is owed, the worker keeps the loop alive
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (fn) => (v) => { if (timer) clearTimeout(timer); fn(v); };
    pending.set(id, { resolve: done(resolve), reject: done(reject), worker: w });
    const ms = Math.max(250, Number(timeoutMs) || 5000);
    timer = setTimeout(() => {
      if (!pending.has(id)) return;
      glyphWorkerStats.timeouts += 1;
      failAll(w, new Error("glyph_worker_timeout"));
      w.terminate().catch(() => {});
    }, ms);
    timer.unref();
    w.postMessage(msg, transfer);
  });
}

export function glyphWorker() {
  return {
    /** bands: [{data, width, height, minGlyphs}] -> [readings[]] in the same order. */
    lines(bands, { digitPx, timeoutMs } = {}) {
      const jobs = bands.map((b) => ({ buffer: copyOf(b.data), width: b.width, height: b.height, minGlyphs: b.minGlyphs }));
      return call({ kind: "lines", digitPx, jobs }, jobs.map((j) => j.buffer), timeoutMs);
    },
    /** bands -> [{text, conf}] from PaddleOCR, in the same order. */
    paddle(bands, { timeoutMs } = {}) {
      const jobs = bands.map((b) => ({ buffer: copyOf(b.data), width: b.width, height: b.height }));
      return call({ kind: "paddle", jobs }, jobs.map((j) => j.buffer), timeoutMs);
    },
    rows(gray, { timeoutMs } = {}) {
      const buffer = copyOf(gray.data);
      return call({ kind: "rows", buffer, width: gray.width, height: gray.height }, [buffer], timeoutMs);
    },
    async close() {
      if (worker) { const w = worker; worker = null; await w.terminate().catch(() => {}); }
    },
  };
}
