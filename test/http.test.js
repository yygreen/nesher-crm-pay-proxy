import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout } from "../http.js";

describe("fetchWithTimeout", () => {
  it("returns response when fetch is fast", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
    });
    const r = await fetchWithTimeout("https://example.com/x", { timeoutMs: 2000 }, fetchImpl);
    assert.equal(r.status, 200);
  });

  it("aborts slow fetch", async () => {
    const fetchImpl = (_url, init) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ ok: true, status: 200 }), 5000);
        if (init && init.signal) {
          init.signal.addEventListener("abort", () => {
            clearTimeout(t);
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }
      });
    await assert.rejects(
      () => fetchWithTimeout("https://example.com/slow", { timeoutMs: 50 }, fetchImpl),
      (err) => err.code === "TIMEOUT" || /timed out/i.test(err.message)
    );
  });
});
