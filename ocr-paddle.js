/**
 * PaddleOCR line recogniser (25 Sep 2026) - the primary reader of a cut number line.
 *
 * Joseph, 25 Sep: "it still very, very far from reading cards ... choppy and
 * sloppy". tesseract's English model reads book print; PP-OCR's recogniser
 * (PP-OCRv4 English, ONNX, 7.7 MB, Apache-2.0) is trained on scene text and
 * reads card digits far better. It runs here on the ONE line ocr-card.js has
 * already found, cut, straightened and scaled - recognition only, no detector.
 *
 * Runtime: onnxruntime-web (WebAssembly) - no native binary, so it runs on the
 * Alpine image unchanged. Loaded lazily, inside the glyph worker thread
 * (ocr-glyph-worker.js), never on the proxy's main thread.
 *
 * Model + dictionary: models/paddle/en_PP-OCRv4_rec.onnx + en_dict.txt
 * (PaddleOCR en_dict: 95 characters; CTC classes = blank + 95 + space).
 * Nothing is fetched at run time; nothing is written anywhere.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PADDLE_MODEL = path.join(HERE, "models", "paddle", "en_PP-OCRv4_rec.onnx");
export const PADDLE_DICT = path.join(HERE, "models", "paddle", "en_dict.txt");
export const REC_H = 48;
export const REC_MAX_W = 1600;

let loading = null;

async function load() {
  if (!loading) {
    loading = (async () => {
      const ort = await import("onnxruntime-web");
      ort.env.wasm.numThreads = 1; // one thread: the worker is already off the main loop; no nested pools
      ort.env.logLevel = "error";
      const model = fs.readFileSync(PADDLE_MODEL);
      const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      const dict = fs.readFileSync(PADDLE_DICT, "utf8").split(/\r?\n/).filter((l, i, a) => l.length || i < a.length - 1);
      const chars = ["", ...dict, " "];
      return { ort, session, chars, input: session.inputNames[0], output: session.outputNames[0] };
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/** Load the model now (Gabbai P1, 25 Sep): a fresh worker must not pay the load inside a read's budget. */
export async function paddleWarm() {
  const t0 = Date.now();
  await load();
  return Date.now() - t0;
}

export function paddleAvailable() {
  return fs.existsSync(PADDLE_MODEL) && fs.existsSync(PADDLE_DICT);
}

/**
 * Read one grey line (dark or light ink; the model takes both). The caller
 * scales digits to ~40 px, which is what REC_H 48 expects. Returns
 * {text, conf} where conf is the mean of the chosen characters' probabilities.
 */
export async function paddleReadLine(gray) {
  const m = await load();
  const { data, width: w, height: h } = gray;
  const scale = REC_H / h;
  const W = Math.max(16, Math.min(REC_MAX_W, Math.round(w * scale)));
  const tensor = new Float32Array(3 * REC_H * W);
  // Nearest-neighbour resize into CHW, normalised to [-1, 1], grey copied to the three channels.
  for (let y = 0; y < REC_H; y += 1) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < W; x += 1) {
      const sx = Math.min(w - 1, Math.floor((x * w) / W));
      const v = data[sy * w + sx] / 127.5 - 1;
      const o = y * W + x;
      tensor[o] = v;
      tensor[REC_H * W + o] = v;
      tensor[2 * REC_H * W + o] = v;
    }
  }
  const feeds = { [m.input]: new m.ort.Tensor("float32", tensor, [1, 3, REC_H, W]) };
  const out = (await m.session.run(feeds))[m.output];
  tensor.fill(0);
  const [, T, C] = out.dims;
  const p = out.data;
  let text = "";
  let last = 0;
  let sum = 0;
  let n = 0;
  for (let t = 0; t < T; t += 1) {
    let best = 0;
    let bp = -1;
    for (let c = 0; c < C; c += 1) {
      const v = p[t * C + c];
      if (v > bp) { bp = v; best = c; }
    }
    if (best !== 0 && best !== last) {
      text += m.chars[best] || "";
      sum += bp;
      n += 1;
    }
    last = best;
  }
  if (p.fill) p.fill(0);
  return { text, conf: n ? sum / n : 0 };
}
