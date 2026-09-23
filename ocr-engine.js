/**
 * tesseract.js worker pool for the card reader (plan section 13.2).
 *
 * Free, local, no outside service: the WASM engine and the English language
 * data both live in node_modules inside the container. Nothing is downloaded
 * at request time (langPath is a directory, cacheMethod "none" writes nothing
 * to disk). LSTM only. A bounded pool of warm workers keeps the per-photo cost
 * to the recognize calls themselves (worker boot is ~150 ms + language load).
 *
 * The engine is loaded lazily (dynamic import) so a broken native module can
 * never take the CRM front door down at boot: the proxy starts, the health
 * block says the engine failed, and only the OCR route answers 503.
 *
 * Interface (also implemented by the fake engine in the tests):
 *   recognize(pngBuffer, { mode: "block" | "sparse", charset: "digits" | "text" })
 *     -> { text, confidence }
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Vendored by the @tesseract.js-data/eng npm package (npm ci puts it here). */
export const LANG_DIR = path.join(
  HERE,
  "node_modules",
  "@tesseract.js-data",
  "eng",
  "4.0.0_best_int"
);

/** Bounded: 1..3 workers. Each holds a WASM heap; the proxy shares the box with the CRM front. */
export const POOL_MAX = 3;

export function poolSizeFor(cpus) {
  const n = Number(cpus);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.min(POOL_MAX, Math.floor(n)));
}

export const POOL_SIZE = poolSizeFor(
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : (os.cpus() || []).length
);

/** 13.3.3: digit-and-slash whitelist for the number passes. */
export const DIGIT_CHARSET = "0123456789/ ";
/** Name / expiry pass: upper-case letters, digits, slash, and the few marks cards print. */
export const TEXT_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/ .-'";

/** tesseract PSM values (strings, as tesseract.js takes them). 6 = single block, 11 = sparse text. */
export const PSM_BY_MODE = { block: "6", sparse: "11" };
export const CHARSET_BY_NAME = { digits: DIGIT_CHARSET, text: TEXT_CHARSET };

let tesseractModule = null;
async function loadTesseract() {
  if (!tesseractModule) tesseractModule = await import("tesseract.js");
  return tesseractModule;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.size]
 * @param {string} [opts.langPath]
 */
export function createEnginePool(opts = {}) {
  const size = poolSizeFor(opts.size ?? POOL_SIZE);
  const langPath = opts.langPath || LANG_DIR;
  const workers = [];
  const idle = [];
  const waiters = [];
  let warmPromise = null;
  let warmError = null;
  let closed = false;

  async function makeWorker() {
    const { createWorker, OEM } = await loadTesseract();
    return createWorker("eng", OEM.LSTM_ONLY, {
      langPath,
      cacheMethod: "none",
      gzip: true,
      logger: () => {},
      errorHandler: () => {},
    });
  }

  function warm() {
    if (!warmPromise) {
      warmPromise = (async () => {
        for (let i = 0; i < size; i += 1) {
          if (closed) break;
          const w = await makeWorker();
          workers.push(w);
          const next = waiters.shift();
          if (next) next(w);
          else idle.push(w);
        }
      })().catch((e) => {
        warmError = e;
        throw e;
      });
    }
    return warmPromise;
  }

  async function acquire() {
    if (closed) throw new Error("engine_closed");
    if (idle.length) return idle.pop();
    const p = new Promise((resolve) => waiters.push(resolve));
    warm().catch(() => {});
    if (warmError) throw warmError;
    return p;
  }

  function release(w) {
    const next = waiters.shift();
    if (next) next(w);
    else idle.push(w);
  }

  async function recognize(buffer, { mode = "block", charset = "digits" } = {}) {
    const psm = PSM_BY_MODE[mode] || PSM_BY_MODE.block;
    const whitelist = CHARSET_BY_NAME[charset] || DIGIT_CHARSET;
    const w = await acquire();
    try {
      await w.setParameters({
        tessedit_char_whitelist: whitelist,
        tessedit_pageseg_mode: psm,
      });
      const r = await w.recognize(buffer);
      return {
        text: String((r && r.data && r.data.text) || ""),
        confidence: Number((r && r.data && r.data.confidence) || 0),
      };
    } finally {
      release(w);
    }
  }

  async function close() {
    closed = true;
    const all = workers.splice(0, workers.length);
    idle.length = 0;
    await Promise.all(all.map((w) => w.terminate().catch(() => {})));
  }

  return {
    warm,
    recognize,
    close,
    get size() {
      return workers.length;
    },
    get target() {
      return size;
    },
    get ready() {
      return workers.length === size && !warmError;
    },
    get error() {
      return warmError ? String(warmError.message || warmError) : null;
    },
  };
}

let shared = null;
/** One pool per process (server.js and the synthetic test share it). */
export function sharedEnginePool() {
  if (!shared) shared = createEnginePool();
  return shared;
}
