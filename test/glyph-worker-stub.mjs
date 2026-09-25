// Test stub for the glyph worker: it receives every job and never answers (Gabbai D1, 25 Sep).
import { parentPort } from "node:worker_threads";
if (parentPort) parentPort.on("message", () => {});
