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

function zero(list) {
  for (const a of list) if (a && typeof a.fill === "function") a.fill(0);
}

if (!isMainThread && parentPort) {
  parentPort.on("message", (msg) => {
    const held = [];
    let reply;
    try {
      if (msg.kind === "lines") {
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
/** For the fence test: how many zeroed copies went out. */
export const glyphWorkerStats = { sent: 0 };

function failAll(err) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
  worker = null;
}

function ensure() {
  if (worker) return worker;
  worker = new Worker(fileURLToPath(import.meta.url));
  worker.unref();
  worker.on("message", (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (!pending.size) worker && worker.unref();
    if (m.ok) p.resolve(m.out);
    else p.reject(new Error(m.error || "glyph_worker_failed"));
  });
  worker.on("error", (e) => failAll(e));
  worker.on("exit", () => failAll(new Error("glyph_worker_exit")));
  return worker;
}

/** A private copy of the pixels in a fresh ArrayBuffer, so it can be transferred whole. */
function copyOf(data) {
  const ab = new ArrayBuffer(data.length);
  new Uint8Array(ab).set(data);
  glyphWorkerStats.sent += 1;
  return ab;
}

function call(msg, transfer) {
  const w = ensure();
  const id = ++seq;
  msg.id = id;
  w.ref(); // while an answer is owed, the worker keeps the loop alive
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage(msg, transfer);
  });
}

export function glyphWorker() {
  return {
    /** bands: [{data, width, height, minGlyphs}] -> [readings[]] in the same order. */
    lines(bands, { digitPx }) {
      const jobs = bands.map((b) => ({ buffer: copyOf(b.data), width: b.width, height: b.height, minGlyphs: b.minGlyphs }));
      return call({ kind: "lines", digitPx, jobs }, jobs.map((j) => j.buffer));
    },
    rows(gray) {
      const buffer = copyOf(gray.data);
      return call({ kind: "rows", buffer, width: gray.width, height: gray.height }, [buffer]);
    },
    async close() {
      if (worker) { const w = worker; worker = null; await w.terminate().catch(() => {}); }
    },
  };
}
