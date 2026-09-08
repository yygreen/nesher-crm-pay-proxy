import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  verifyNmiWebhookSignature,
  parseNmiWebhook,
  isSaleSuccess,
  pickInvoiceRow,
  applyNmiSaleSuccess,
} from "../nmi-webhook.js";
import { recordNmiPaid, chargePayCode } from "../nmi-card.js";

const SECRET = "test-nmi-webhook-secret";

function sign(raw, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

const SALE = {
  event_id: "evt_test_1",
  event_type: "transaction.sale.success",
  event_body: {
    transaction_id: "txn_wh_1",
    order_id: "RES-555TRAIN",
    action: {
      amount: "55.55",
      action_type: "sale",
      success: "1",
    },
    merchant_defined_fields: {
      field_1: "nesher",
      field_2: "RES-555TRAIN",
      field_3: "RES-555TRAIN",
    },
  },
};

const INVOICE = {
  amountUsd: 55.55,
  invoiceNumber: "RES-555TRAIN",
  customerName: "Ada",
  kind: "reservation",
  recordId: 337,
};

describe("verifyNmiWebhookSignature", () => {
  it("accepts official NMI t=<nonce>,s=<hex> over nonce + '.' + raw body", () => {
    // c12b370 looked for Stripe-like v1= and returned bad_signature on this header.
    const raw = JSON.stringify(SALE);
    const nonce = "1757320000";
    const s = crypto
      .createHmac("sha256", SECRET)
      .update(nonce + "." + raw)
      .digest("hex");
    const r = verifyNmiWebhookSignature(
      raw,
      { "Webhook-Signature": `t=${nonce},s=${s}` },
      SECRET
    );
    assert.equal(r.ok, true);
    const wrong = verifyNmiWebhookSignature(
      raw,
      { "webhook-signature": `t=${nonce},s=${sign(raw)}` },
      SECRET
    );
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "bad_signature");
    const otherKey = verifyNmiWebhookSignature(
      raw,
      { "webhook-signature": `t=${nonce},s=${s}` },
      "other-secret"
    );
    assert.equal(otherKey.ok, false);
    assert.equal(otherKey.error, "bad_signature");
  });

  it("accepts HMAC-SHA256 hex of the raw body", () => {
    const raw = JSON.stringify(SALE);
    const r = verifyNmiWebhookSignature(raw, { "webhook-signature": sign(raw) }, SECRET);
    assert.equal(r.ok, true);
  });

  it("accepts sha256= prefix and t=,v1= form", () => {
    const raw = JSON.stringify(SALE);
    const hex = sign(raw);
    const a = verifyNmiWebhookSignature(
      raw,
      { "Webhook-Signature": `sha256=${hex}` },
      SECRET
    );
    assert.equal(a.ok, true);
    const ts = "1757320000";
    const v1 = crypto
      .createHmac("sha256", SECRET)
      .update(Buffer.concat([Buffer.from(`${ts}.`, "utf8"), Buffer.from(raw)]))
      .digest("hex");
    const b = verifyNmiWebhookSignature(
      raw,
      { "webhook-signature": `t=${ts},v1=${v1}` },
      SECRET
    );
    assert.equal(b.ok, true);
  });

  it("rejects a missing, wrong, or empty-secret signature", () => {
    const raw = JSON.stringify(SALE);
    assert.equal(
      verifyNmiWebhookSignature(raw, {}, SECRET).error,
      "signature_missing"
    );
    assert.equal(
      verifyNmiWebhookSignature(raw, { "webhook-signature": sign(raw, "other") }, SECRET)
        .error,
      "bad_signature"
    );
    assert.equal(
      verifyNmiWebhookSignature(raw, { "webhook-signature": sign(raw) }, "").error,
      "secret_missing"
    );
  });
});

describe("parseNmiWebhook", () => {
  it("reads sale.success order id, amount, txn; never copies a PAN", () => {
    const parsed = parseNmiWebhook({
      ...SALE,
      event_body: { ...SALE.event_body, cc_number: "4111111111111111", cvv: "123" },
    });
    assert.equal(parsed.eventType, "transaction.sale.success");
    assert.equal(isSaleSuccess(parsed), true);
    assert.equal(parsed.orderId, "RES-555TRAIN");
    assert.equal(parsed.transactionId, "txn_wh_1");
    assert.equal(parsed.amountUsd, 55.55);
    assert.equal(parsed.cc_number, undefined);
    assert.equal(parsed.cvv, undefined);
    assert.equal(JSON.stringify(parsed).includes("4111111111111111"), false);
  });

  it("falls back to MDF 2 when order_id is empty", () => {
    const parsed = parseNmiWebhook({
      event_type: "transaction.sale.success",
      event_body: {
        transaction_id: "txn_mdf",
        action: { amount: "10.00", action_type: "sale", success: "1" },
        merchant_defined_field: [{ id: "2", value: "JRM-189-O50" }],
      },
    });
    assert.equal(parsed.orderId, "JRM-189-O50");
  });

  it("does not treat refund or failure as sale success", () => {
    assert.equal(
      isSaleSuccess(parseNmiWebhook({ event_type: "transaction.refund.success" })),
      false
    );
    assert.equal(
      isSaleSuccess(parseNmiWebhook({ event_type: "transaction.sale.failure" })),
      false
    );
  });
});

describe("applyNmiSaleSuccess", () => {
  function store(seed) {
    const rows = seed.map((r) => ({ id: r.id, payload: { ...r.payload } }));
    const notes = [];
    const marks = [];
    let nmiNoteAt = seed[0]?.payload?.nmiNoteAt || null;
    return {
      rows,
      notes,
      marks,
      opts: {
        findInvoicesByOrderId: async () => rows,
        claimInvoicePaid: async (code, extra) => {
          const row = rows.find((r) => r.id === code);
          if (!row) return { ok: false, error: "not found" };
          if (row.payload.paidAt) return { ok: false, error: "already_paid" };
          row.payload.paidAt = extra.paidAt;
          if (extra.transactionId) row.payload.transactionId = extra.transactionId;
          return { ok: true, paidAt: extra.paidAt };
        },
        markInvoicePaid: async (code, extra) => {
          marks.push({ code, extra });
          const row = rows.find((r) => r.id === code);
          if (row) {
            row.payload.paidAt = extra.paidAt || row.payload.paidAt;
            row.payload.transactionId = extra.transactionId || row.payload.transactionId;
          }
          return { ok: true };
        },
        claimNmiNote: async (code, extra) => {
          if (nmiNoteAt) return { ok: false, error: "already_noted" };
          nmiNoteAt = extra.nmiNoteAt;
          return { ok: true, nmiNoteAt };
        },
        appendReservationNote: async (id, note) => notes.push({ id, note }),
        appendHotelNote: async () => {
          throw new Error("hotel writer must not run");
        },
      },
    };
  }

  it("claims unpaid, stamps txn, writes the CRM note once", async () => {
    const s = store([{ id: "7wm3td6g", payload: { ...INVOICE } }]);
    const parsed = parseNmiWebhook(SALE);
    const out = await applyNmiSaleSuccess(parsed, s.opts);
    assert.equal(out.ok, true);
    assert.equal(out.noteWritten, true);
    assert.equal(s.notes.length, 1);
    assert.equal(s.notes[0].id, 337);
    assert.match(s.notes[0].note, /\$55\.55/);
    assert.match(s.notes[0].note, /txn_wh_1/);
    assert.match(s.notes[0].note, /mark the Mercury invoice PAID, never cancel\./);
    assert.equal(s.rows[0].payload.transactionId, "txn_wh_1");
    assert.ok(s.rows[0].payload.paidAt);
  });

  it("is idempotent with a prior guest charge (same txn, one note)", async () => {
    const s = store([
      {
        id: "7wm3td6g",
        payload: { ...INVOICE, paidAt: "t1", transactionId: "txn_wh_1", nmiNoteAt: "t1" },
      },
    ]);
    s.opts.claimNmiNote = async () => ({ ok: false, error: "already_noted" });
    const out = await applyNmiSaleSuccess(parseNmiWebhook(SALE), s.opts);
    assert.equal(out.ok, true);
    assert.equal(out.alreadyNoted, true);
    assert.equal(out.noteWritten, false);
    assert.equal(s.notes.length, 0);
  });

  it("does not fire a second NMI sale and ignores amount spoof", async () => {
    let fetched = 0;
    const s = store([{ id: "7wm3td6g", payload: { ...INVOICE } }]);
    const spoof = parseNmiWebhook({
      event_type: "transaction.sale.success",
      event_body: {
        transaction_id: "txn_spoof",
        order_id: "RES-555TRAIN",
        action: { amount: "1.00", action_type: "sale", success: "1" },
      },
    });
    const out = await applyNmiSaleSuccess(spoof, {
      ...s.opts,
      fetchImpl: async () => {
        fetched += 1;
        throw new Error("webhook must not charge");
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.ignored, "amount_mismatch");
    assert.equal(s.notes.length, 0);
    assert.equal(fetched, 0);
    assert.equal(s.rows[0].payload.paidAt, undefined);
  });

  it("ignores unknown order ids and non-sale events with 200", async () => {
    const empty = {
      findInvoicesByOrderId: async () => [],
    };
    const miss = await applyNmiSaleSuccess(parseNmiWebhook(SALE), empty);
    assert.equal(miss.ok, true);
    assert.equal(miss.ignored, "not_found");
    const refund = await applyNmiSaleSuccess(
      parseNmiWebhook({ event_type: "transaction.refund.success", event_body: SALE.event_body }),
      empty
    );
    assert.equal(refund.ok, true);
    assert.equal(refund.ignored, "transaction.refund.success");
  });

  it("picks the matching txn row over a later unpaid duplicate mint", () => {
    const rows = [
      { id: "newcode2", payload: { ...INVOICE } },
      { id: "7wm3td6g", payload: { ...INVOICE, paidAt: "t", transactionId: "txn_wh_1" } },
    ];
    const picked = pickInvoiceRow(rows, "txn_wh_1");
    assert.equal(picked.id, "7wm3td6g");
  });
});

describe("guest charge and webhook share the note CAS", () => {
  it("browser POST then webhook writes one CRM note", async () => {
    const notes = [];
    let paidAt = null;
    let nmiNoteAt = null;
    let transactionId = null;
    const invoice = { ...INVOICE };
    const load = async () => ({
      ok: true,
      data: { ...invoice, paidAt, transactionId },
    });
    const claim = async (_code, extra) => {
      if (paidAt) return { ok: false, error: "already_paid" };
      paidAt = extra.paidAt || "t1";
      return { ok: true, paidAt };
    };
    const mark = async (_code, extra) => {
      paidAt = extra.paidAt || paidAt;
      transactionId = extra.transactionId || transactionId;
      return { ok: true };
    };
    const claimNote = async (_code, extra) => {
      if (nmiNoteAt) return { ok: false, error: "already_noted" };
      nmiNoteAt = extra.nmiNoteAt;
      return { ok: true, nmiNoteAt };
    };
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ response: "1", id: "txn_wh_1" });
      },
    });
    const first = await chargePayCode({
      code: "7wm3td6g",
      paymentToken: "tok_collect",
      loadInvoice: load,
      claimInvoicePaid: claim,
      markInvoicePaid: mark,
      claimNmiNote: claimNote,
      appendReservationNote: async (id, note) => notes.push({ id, note }),
      fetchImpl,
      privateKey: "test-private-key",
    });
    assert.equal(first.ok, true);
    assert.equal(first.noteWritten, true);
    const second = await applyNmiSaleSuccess(parseNmiWebhook(SALE), {
      findInvoicesByOrderId: async () => [
        { id: "7wm3td6g", payload: { ...invoice, paidAt, transactionId } },
      ],
      claimInvoicePaid: claim,
      markInvoicePaid: mark,
      claimNmiNote: claimNote,
      appendReservationNote: async (id, note) => notes.push({ id, note }),
    });
    assert.equal(second.ok, true);
    assert.equal(second.alreadyNoted, true);
    assert.equal(notes.length, 1);
  });

  it("webhook-only (missed browser POST) still claims and notes", async () => {
    const recorded = await recordNmiPaid({
      code: "7wm3td6g",
      invoice: INVOICE,
      transactionId: "txn_wh_1",
      markInvoicePaid: async () => ({ ok: true }),
      claimNmiNote: async () => ({ ok: true, nmiNoteAt: "t" }),
      appendReservationNote: async () => {},
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.noteWritten, true);
  });
});

describe("wiring", () => {
  it("Dockerfile COPY and server route exist; health tag bumped", () => {
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(docker, /\bnmi-webhook\.js\b/);
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /__nesher_pay\/nmi-webhook/);
    assert.match(src, /build: "2026-09-08-stripe-post-strip"/);
    assert.match(src, /claimNmiNote/);
    assert.match(src, /verifyNmiWebhookSignature/);
    assert.match(src, /nmiWebhook:/);
    assert.doesNotMatch(src, /NMI_WEBHOOK_SECRET\s*\+/);
  });
});
