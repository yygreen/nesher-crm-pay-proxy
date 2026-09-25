/**
 * NMI recovery sweep: the processor's own record (Classic query.php, READ
 * ONLY) is the durable state a lost response resumes from (plan 16.2). It
 * never charges, voids, refunds or captures; it only reads, then hands each
 * confirmed transaction to the same doors the live paths use:
 *   shadow -> observe (ledger only);  live -> post once / keep as exception.
 * A sale the processor did not approve is not money and is never recorded; a
 * screenshot or a claim is never a confirmation (16.3).
 *
 * Nothing from the gateway answer is kept but: transaction id, order id,
 * condition, processor id, amount, action type, date, last four, MDF 1
 * (brand) and MDF 5 (rep). Names, emails, addresses and the masked PAN are
 * dropped at parse time.
 */

export const NMI_PROCESSOR_BRAND = Object.freeze({ mav7067: "nesher", mav2083: "jrm" });
const MONEY_CONDITIONS = new Set(["complete", "pendingsettlement", "pending", "in_progress"]);

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? decode(m[1]).trim() : "";
}
function decode(s) {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function mdf(block, id) {
  const m = block.match(new RegExp(`<merchant_defined_field id="${id}">([^<]*)</merchant_defined_field>`));
  return m ? decode(m[1]).trim() : "";
}
/** NMI query.php stamps (YYYYMMDDhhmmss) are read as UTC - the ONE place that assumption lives
 *  (canon s.8: to be checked against one known transaction before any day/week edge is shown). */
export function nmiDateMs(s) {
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
function nmiDate(s) {
  const ms = nmiDateMs(s);
  return ms == null ? null : new Date(ms).toISOString();
}
function last4(cc) {
  const v = String(cc || "").replace(/[\s-]/g, "");
  const m = v.match(/^\d{0,6}[Xx*•]{4,}(\d{4})$/);
  return m ? m[1] : null;
}

/** query.php XML -> money events. One event per transaction (its FIRST money
 *  action: sale, refund or credit), with the transaction's condition. */
export function parseNmiQueryXml(xml) {
  const out = [];
  const blocks = String(xml || "").split("<transaction>").slice(1).map((b) => b.split("</transaction>")[0]);
  for (const b of blocks) {
    const transactionId = tag(b, "transaction_id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(transactionId)) continue;
    const actions = b.split("<action>").slice(1).map((a) => ({
      type: tag(a, "action_type").toLowerCase(),
      amount: Number(tag(a, "amount")),
      success: tag(a, "success") === "1",
      date: nmiDate(tag(a, "date")),
    }));
    const money = actions.find((a) => ["sale", "refund", "credit", "capture"].includes(a.type));
    if (!money) continue;
    const processorId = tag(b, "processor_id").toLowerCase();
    const hint = mdf(b, 1).toLowerCase();
    const rep = mdf(b, 5);
    out.push({
      transactionId,
      orderId: tag(b, "order_id") || null,
      condition: tag(b, "condition").toLowerCase(),
      processorId,
      brand: NMI_PROCESSOR_BRAND[processorId] || (hint === "jrm" || hint === "nesher" ? hint : null),
      brandHint: hint === "jrm" || hint === "nesher" ? hint : null,
      kind: money.type === "sale" || money.type === "capture" ? "sale" : "refund",
      amountUsd: Math.round(Math.abs(money.amount) * 100) / 100,
      success: money.success,
      voided: actions.some((a) => a.type === "void" && a.success),
      voidedAt: (actions.find((a) => a.type === "void" && a.success) || {}).date || null,
      originalTransactionId: /^[A-Za-z0-9_-]{1,64}$/.test(tag(b, "original_transaction_id")) ? tag(b, "original_transaction_id") : null,
      paidAt: money.date,
      cardLast4: last4(tag(b, "cc_number")),
      rep: /^[A-Za-z][A-Za-z .'-]{0,39}$/.test(rep) ? rep : null,
    });
  }
  return out;
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** READ ONLY range query. The key rides in the POST body, never a URL or log. */
export async function queryNmiRange({ host, securityKey, since, until, fetchImpl = fetch, timeoutMs = 20000 }) {
  if (!host || !securityKey) throw new Error("nmi_query_not_configured");
  const body = new URLSearchParams({
    security_key: securityKey,
    start_date: stamp(since),
    end_date: stamp(until),
  });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${String(host).replace(/\/$/, "")}/api/query.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/xml" },
      body: body.toString(),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`nmi_query_http_${res.status}`);
    if (/<error_response>/i.test(text)) throw new Error("nmi_query_refused");
    return text;
  } finally {
    clearTimeout(t);
  }
}

/**
 * How far back the 15-minute sweep reads (audit #142): never less than the floor (3 days), and always back to
 * an hour before the last sweep that WORKED - so a processor read that was down for longer than three
 * days is caught up on the first good pass instead of waiting for the next redeploy. Capped at 60.
 */
export function sweepDays(lastGoodAt, now = Date.now(), floor = 3) {
  const t = Date.parse(String(lastGoodAt || ""));
  if (!Number.isFinite(t)) return floor;
  const back = (Number(now) - t) / 86400000 + 1 / 24;
  return Math.min(60, Math.max(floor, Math.ceil(back)));
}

/** The decision the live paths would take for one processor-confirmed event. */
export function recoveryDecision(e) {
  if (e.kind === "refund") return { action: "exception", reason: "reversal_requires_review" };
  if (e.voided || e.condition === "canceled") return { action: "exception", reason: "sale_voided" };
  const ref = String(e.orderId || "");
  if (/^(?:RES-[A-Za-z0-9_-]+|JRM-1[0-9]+(?:-O[0-9]+)?)$/i.test(ref)) {
    const refBrand = /^JRM-/i.test(ref) ? "jrm" : "nesher";
    if (e.brandHint && e.brandHint !== refBrand) return { action: "exception", reason: "brand_mismatch" };
    return { action: "post" };
  }
  return { action: "exception", reason: "no_crm_reference" };
}

/**
 * One sweep. `observe(ev)` (shadow) or `post(ev)` / `except(ev)` (live) are
 * injected by the server. Returns counts only.
 */
export async function runNmiRecovery({ host, securityKey, days = 3, now = new Date(), fetchImpl, mode = "shadow", observe, post, except, reverse, settled }) {
  const until = new Date(now.getTime());
  const since = new Date(now.getTime() - Math.max(1, Math.min(60, Number(days) || 3)) * 86400000);
  const xml = await queryNmiRange({ host, securityKey, since, until, fetchImpl });
  const events = parseNmiQueryXml(xml);
  // `fresh` (audit #142): what THIS pass did for the first time - a new CRM row, a new reversal, a new
  // review row - apart from the running totals that re-count every sale still in the window.
  const out = { at: new Date().toISOString(), mode, days, transactions: events.length, confirmed: 0, notMoney: 0, noBrand: 0, observed: 0, posted: 0, reversed: 0, exceptions: 0, errors: 0,
    fresh: { posted: 0, reversed: 0, exceptions: 0 } };
  for (const e of events) {
    // Only the processor's approval makes it money. Failed = no money moved.
    if (!e.success || !(e.amountUsd > 0) || !(MONEY_CONDITIONS.has(e.condition) || e.condition === "canceled")) { out.notMoney++; continue; }
    const brand = e.brand || (/^JRM-/i.test(String(e.orderId || "")) ? "jrm" : /^RES-/i.test(String(e.orderId || "")) ? "nesher" : null);
    if (!brand) { out.noBrand++; continue; }
    out.confirmed++;
    const decision = recoveryDecision(e);
    const ev = {
      path: "recovery",
      invoiceNumber: e.orderId || `NMI-${e.transactionId}`,
      amountUsd: e.amountUsd,
      transactionId: e.transactionId,
      paidAt: e.paidAt || new Date().toISOString(),
      brand,
      kind: e.kind,
      ...(e.cardLast4 ? { cardLast4: e.cardLast4 } : {}),
      ...(e.rep ? { rep: e.rep } : {}),
      decision,
    };
    try {
      if (mode === "live") {
        // A VOID OR REFUND (audit #26): through the reversal door when the server gives one - it reverses
        // only a sale the loop itself posted, and keeps everything else for a person.
        const isReversal = e.kind === "refund" || e.voided || e.condition === "canceled";
        if (isReversal && typeof reverse === "function") {
          const r = await reverse({
            ...ev,
            reversal: e.kind === "refund" ? "refund" : "void",
            originalTransactionId: e.originalTransactionId || null,
            reversedAt: e.voidedAt || null,
            refundVoided: e.kind === "refund" && (e.voided || e.condition === "canceled"),
          });
          if (r?.reversal && r?.ok) {
            out.reversed++;
            if (r.recorded?.length) out.fresh.reversed++;
          } else if (r?.ok || r?.durable || r?.needsReview) {
            out.exceptions++;
            if (r?.inserted) out.fresh.exceptions++;
          } else out.errors++;
          continue;
        }
        const r = decision.action === "post" ? await post(ev) : await except({ ...ev, reason: decision.reason });
        if (decision.action === "post" && r?.ok) {
          out.posted++;
          if (r.recorded?.length) out.fresh.posted++;
          // Audit #145: a pay link stuck on "confirming" is cleared once its sale is in the CRM.
          if (typeof settled === "function") { try { await settled(ev); } catch { /* the link stays as it was */ } }
        } else if (r?.durable || r?.needsReview) {
          out.exceptions++;
          if (r?.inserted || r?.newlyReviewed) out.fresh.exceptions++;
        } else out.errors++;
      } else {
        const r = await observe(ev);
        if (r?.ok) out.observed++;
        else out.errors++;
      }
    } catch {
      out.errors++;
    }
  }
  return out;
}
