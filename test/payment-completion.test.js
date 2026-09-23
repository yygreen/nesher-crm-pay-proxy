import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordNmiPaid, chargePayCode } from "../nmi-card.js";
import { applyNmiSaleSuccess, parseNmiWebhook } from "../nmi-webhook.js";

const INVOICE = {
  amountUsd: 55.55,
  invoiceNumber: "RES-555TRAIN",
  customerName: "Ada",
  kind: "reservation",
  recordId: 337,
};

const SALE = parseNmiWebhook({
  event_type: "transaction.sale.success",
  event_body: {
    transaction_id: "txn_completion",
    order_id: "RES-555TRAIN",
    action: { amount: "55.55", action_type: "sale", success: "1" },
  },
});

function saleFetch(transactionId = "txn_completion") {
  return async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ response: "1", id: transactionId });
    },
  });
}

describe("NMI CRM payment completion", () => {
  it("records the confirmed transaction through the injected CRM callback", async () => {
    const calls = [];
    const out = await recordNmiPaid({
      code: "abc12xyz",
      invoice: INVOICE,
      transactionId: "txn_completion",
      paidAt: "2026-09-23T10:00:00.000Z",
      markInvoicePaid: async () => ({ ok: true }),
      recordNmiPaidInvoice: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.crmRecorded, true);
    assert.equal(out.crmPending, false);
    assert.deepEqual(calls, [{
      transactionId: "txn_completion",
      invoiceNumber: "RES-555TRAIN",
      amountUsd: 55.55,
      paidAt: "2026-09-23T10:00:00.000Z",
    }]);
  });

  it("marks CRM recording failures for review, including callback exceptions", async () => {
    for (const recordNmiPaidInvoice of [
      async () => ({ ok: false, errors: ["database unavailable"] }),
      async () => { throw new Error("database unavailable"); },
    ]) {
      const out = await recordNmiPaid({
        code: "abc12xyz",
        invoice: INVOICE,
        transactionId: "txn_completion",
        paidAt: "2026-09-23T10:00:00.000Z",
        markInvoicePaid: async () => ({ ok: true }),
        recordNmiPaidInvoice,
      });
      assert.equal(out.ok, false);
      assert.equal(out.crmRecorded, false);
      assert.equal(out.needsReview, true);
      assert.equal(out.transactionId, "txn_completion");
    }
  });

  it("keeps CRM recording success visible when the invoice stamp fails", async () => {
    const out = await recordNmiPaid({
      code: "abc12xyz",
      invoice: INVOICE,
      transactionId: "txn_completion",
      paidAt: "2026-09-23T10:00:00.000Z",
      markInvoicePaid: async () => ({ ok: false, error: "invoice_update_failed" }),
      recordNmiPaidInvoice: async () => ({ ok: true }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.crmRecorded, true);
    assert.equal(out.invoiceUpdatePending, true);
    assert.equal(out.transactionId, "txn_completion");
  });

  it("durably reviews a confirmed sale when the invoice stamp conflicts", async () => {
    const calls = [];
    let legacyNotes = 0;
    const out = await recordNmiPaid({
      code: "abc12xyz",
      invoice: INVOICE,
      transactionId: "txn_conflict",
      paidAt: "2026-09-23T10:00:00.000Z",
      markInvoicePaid: async () => ({ ok: false, error: "transaction_conflict" }),
      claimNmiNote: async () => ({ ok: true }),
      appendReservationNote: async () => { legacyNotes += 1; },
      recordNmiPaidInvoice: async (args) => {
        calls.push(args);
        return { ok: false, needsReview: true, errors: ["invoice_transaction_conflict"] };
      },
    });

    assert.equal(out.ok, false);
    assert.equal(out.crmRecorded, false);
    assert.equal(out.crmPending, true);
    assert.equal(out.needsReview, true);
    assert.equal(out.noteWritten, false);
    assert.equal(legacyNotes, 0);
    assert.deepEqual(calls, [{
      transactionId: "txn_conflict",
      invoiceNumber: "RES-555TRAIN",
      amountUsd: 55.55,
      paidAt: "2026-09-23T10:00:00.000Z",
      reviewReason: "invoice_transaction_conflict",
    }]);
  });

  it("keeps an approved guest charge successful while exposing a pending CRM record", async () => {
    const calls = [];
    const out = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice: async () => ({ ok: true, data: INVOICE }),
      claimInvoicePaid: async () => ({ ok: true, paidAt: "2026-09-23T10:00:00.000Z" }),
      markInvoicePaid: async () => ({ ok: true }),
      recordNmiPaidInvoice: async (args) => {
        calls.push(args);
        return { ok: false, errors: ["database unavailable"] };
      },
      fetchImpl: saleFetch(),
      privateKey: "test-private-key",
    });

    assert.equal(out.ok, true);
    assert.equal(out.transactionId, "txn_completion");
    assert.equal(out.crmPending, true);
    assert.equal(out.crmRecorded, false);
    assert.equal(out.httpStatus, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      transactionId: "txn_completion",
      invoiceNumber: "RES-555TRAIN",
      amountUsd: 55.55,
      paidAt: "2026-09-23T10:00:00.000Z",
    });
  });

  it("runs CRM recording even when the NMI note was already claimed", async () => {
    const calls = [];
    const out = await recordNmiPaid({
      code: "abc12xyz",
      invoice: INVOICE,
      transactionId: "txn_completion",
      paidAt: "2026-09-23T10:00:00.000Z",
      markInvoicePaid: async () => ({ ok: true }),
      claimNmiNote: async () => ({ ok: false, error: "already_noted" }),
      recordNmiPaidInvoice: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.alreadyNoted, true);
    assert.equal(out.crmRecorded, true);
    assert.equal(calls.length, 1);
  });

  it("propagates the completion callback through a successful webhook sale", async () => {
    const calls = [];
    const out = await applyNmiSaleSuccess(SALE, {
      findInvoicesByOrderId: async () => [{ id: "abc12xyz", payload: INVOICE }],
      claimInvoicePaid: async () => ({ ok: true, paidAt: "2026-09-23T10:00:00.000Z" }),
      markInvoicePaid: async () => ({ ok: true }),
      recordNmiPaidInvoice: async (args) => {
        calls.push(args);
        return { ok: true };
      },
      now: "2026-09-23T10:00:00.000Z",
    });

    assert.equal(out.ok, true);
    assert.equal(out.crmRecorded, true);
    assert.deepEqual(calls[0], {
      transactionId: "txn_completion",
      invoiceNumber: "RES-555TRAIN",
      amountUsd: 55.55,
      paidAt: "2026-09-23T10:00:00.000Z",
    });
  });

  it("surfaces a webhook CRM callback failure for review after the sale is accepted", async () => {
    const out = await applyNmiSaleSuccess(SALE, {
      findInvoicesByOrderId: async () => [{ id: "abc12xyz", payload: INVOICE }],
      claimInvoicePaid: async () => ({ ok: true, paidAt: "2026-09-23T10:00:00.000Z" }),
      recordNmiPaidInvoice: async () => ({ ok: false, errors: ["database unavailable"] }),
      now: "2026-09-23T10:00:00.000Z",
    });

    assert.equal(out.ok, false);
    assert.equal(out.crmRecorded, false);
    assert.equal(out.needsReview, true);
    assert.equal(out.transactionId, "txn_completion");
  });

  it("retries CRM recording for an already-paid invoice with the same transaction", async () => {
    let calls = 0;
    const out = await applyNmiSaleSuccess(SALE, {
      findInvoicesByOrderId: async () => [{
        id: "abc12xyz",
        payload: {
          ...INVOICE,
          paidAt: "2026-09-22T10:00:00.000Z",
          transactionId: "txn_completion",
        },
      }],
      markInvoicePaid: async () => ({ ok: true }),
      recordNmiPaidInvoice: async () => {
        calls += 1;
        return { ok: true };
      },
    });

    assert.equal(out.ok, true);
    assert.equal(out.crmRecorded, true);
    assert.equal(calls, 1);
  });

  it("refuses a different transaction or amount mismatch without CRM recording", async () => {
    let calls = 0;
    const callback = async () => {
      calls += 1;
      return { ok: true };
    };
    const differentTxn = await applyNmiSaleSuccess(
      { ...SALE, transactionId: "txn_other" },
      {
        findInvoicesByOrderId: async () => [{
          id: "abc12xyz",
          payload: { ...INVOICE, paidAt: "2026-09-22T10:00:00.000Z", transactionId: "txn_completion" },
        }],
        recordNmiPaidInvoice: callback,
      },
    );
    assert.equal(differentTxn.ok, true);
    assert.equal(differentTxn.ignored, "other_txn");
    assert.equal(calls, 0);

    const amountMismatch = await applyNmiSaleSuccess(
      { ...SALE, amountUsd: 1 },
      {
        findInvoicesByOrderId: async () => [{ id: "abc12xyz", payload: INVOICE }],
        recordNmiPaidInvoice: callback,
      },
    );
    assert.equal(amountMismatch.ok, true);
    assert.equal(amountMismatch.ignored, "amount_mismatch");
    assert.equal(calls, 0);
  });

  it("keeps the paid claim after an unknown gateway outcome and prevents a second sale", async () => {
    let paidAt = null;
    let gatewayCalls = 0;
    const loadInvoice = async () => ({ ok: true, data: { ...INVOICE, paidAt } });
    const claimInvoicePaid = async (_code, extra) => {
      if (paidAt) return { ok: false, error: "already_paid" };
      paidAt = extra.paidAt;
      return { ok: true, paidAt };
    };
    const out1 = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice,
      claimInvoicePaid,
      releaseInvoicePaidClaim: async () => {
        throw new Error("unknown outcomes must retain the claim");
      },
      fetchImpl: async () => {
        gatewayCalls += 1;
        throw new Error("network timeout after submit");
      },
      privateKey: "test-private-key",
    });
    const out2 = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice,
      claimInvoicePaid,
      fetchImpl: async () => {
        gatewayCalls += 1;
        throw new Error("must not send a second sale");
      },
      privateKey: "test-private-key",
    });
    assert.equal(out1.ok, false);
    assert.equal(out1.error, "outcome_unknown");
    assert.equal(out1.outcomeUnknown, true);
    assert.equal(out2.error, "already_paid");
    assert.equal(gatewayCalls, 1);
  });

  it("releases the paid claim after an explicit processor decline", async () => {
    let paidAt = null;
    let gatewayCalls = 0;
    const loadInvoice = async () => ({ ok: true, data: { ...INVOICE, paidAt } });
    const claimInvoicePaid = async (_code, extra) => {
      if (paidAt) return { ok: false, error: "already_paid" };
      paidAt = extra.paidAt;
      return { ok: true, paidAt };
    };
    const releaseInvoicePaidClaim = async () => {
      paidAt = null;
      return { ok: true };
    };
    const declinedFetch = async () => {
      gatewayCalls += 1;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "2", response_code: "201", response_text: "Do Not Honor" });
        },
      };
    };
    const first = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice,
      claimInvoicePaid,
      releaseInvoicePaidClaim,
      fetchImpl: declinedFetch,
      privateKey: "test-private-key",
    });
    const second = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice,
      claimInvoicePaid,
      releaseInvoicePaidClaim,
      fetchImpl: declinedFetch,
      privateKey: "test-private-key",
    });
    assert.equal(first.ok, false);
    assert.equal(first.error, "declined");
    assert.equal(second.ok, false);
    assert.equal(second.error, "declined");
    assert.equal(gatewayCalls, 2);
    assert.equal(paidAt, null);
  });
});
