/** Durable, replayable CRM posting of confirmed NMI payments. No gateway calls.
 *
 * Two modes (MONEY_POSTING_MODE, anything but exactly "live" is shadow):
 * - shadow (default): every confirmed event is written to the ledger with what
 *   this path WOULD post, computed by the same write code inside a READ ONLY
 *   transaction whose writes are captured, never sent. The legacy paths keep
 *   doing the real CRM writes. shadowReport() compares the two.
 * - live: postConfirmedPayment() does the CRM write itself, exactly once per
 *   transaction id (Codex design, kept whole).
 */
const ready = new WeakMap();

export function postingMode(env = process.env) {
  return String(env.MONEY_POSTING_MODE || "").trim().toLowerCase() === "live" ? "live" : "shadow";
}

async function ensureTable(pool) {
  if (!ready.has(pool)) {
    const task = pool.query(`CREATE TABLE IF NOT EXISTS nesher_money_payment_posts (
      transaction_id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
      brand TEXT NOT NULL CHECK (brand IN ('nesher', 'jrm')),
      paid_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'posted', 'review', 'shadow')),
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      posted_at TIMESTAMPTZ,
      mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'shadow')),
      first_path TEXT,
      paths TEXT[] NOT NULL DEFAULT '{}',
      seen_count INTEGER NOT NULL DEFAULT 1,
      card_last4 TEXT CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
      rep TEXT,
      would_action TEXT CHECK (would_action IS NULL OR would_action IN ('post', 'skip', 'review')),
      would JSONB,
      kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale', 'refund'))
    )`).then(() => pool.query(`CREATE INDEX IF NOT EXISTS nesher_money_payment_posts_open_idx
      ON nesher_money_payment_posts (state, updated_at) WHERE state <> 'posted'`))
      .catch((error) => { ready.delete(pool); throw error; });
    ready.set(pool, task);
  }
  await ready.get(pool);
}

/** For the sweep's reversal door (payments-sync recordSweepReversal): the ledger table exists before its reads. */
export async function ensureLedger(pool) { await ensureTable(pool); }

function result(error, needsReview = false) {
  return { ok: false, recorded: [], skipped: [], errors: [error], needsReview };
}

// "chat": a refund or void the desk chat sent (card-charge.js, 24 Sep), recorded as its own row, kind refund.
const PATHS = new Set(["guest", "webhook", "office", "open", "recovery", "chat"]);
function cleanPath(p) { return PATHS.has(p) ? p : null; }
function cleanLast4(v) { const s = String(v ?? "").trim(); return /^\d{4}$/.test(s) ? s : null; }
function cleanKind(v) { return v === 'refund' ? 'refund' : 'sale'; }
function cleanRep(v) { const s = String(v ?? "").trim(); return /^[A-Za-z][A-Za-z .'-]{0,39}$/.test(s) ? s : null; }

function validate({ transactionId, invoiceNumber, amountUsd, paidAt, brand }) {
  const txn = String(transactionId || "").trim();
  const ref = String(invoiceNumber || "").trim().toUpperCase();
  const amount = Number(amountUsd);
  const cents = Math.round(amount * 100);
  const when = new Date(paidAt || Date.now());
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(txn)) return { error: "transaction_id_required" };
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || cents <= 0 || Math.abs(amount * 100 - cents) > 0.00001) return { error: "invalid_amount" };
  if (!ref || !["nesher", "jrm"].includes(brand) || Number.isNaN(when.getTime())) return { error: "invalid_payment" };
  return { txn, ref, cents, when };
}

/** Persist before attempting CRM changes. Event + payment + balance commit together. */
export async function postConfirmedPayment({ pool, invoiceNumber, amountUsd, transactionId, paidAt, brand, write, path, cardLast4, rep, kind }) {
  const v = validate({ transactionId, invoiceNumber, amountUsd, paidAt, brand });
  if (v.error) return result(v.error);
  const { txn, ref, cents, when } = v;
  if (!pool || typeof pool.connect !== 'function') return result('database_unavailable');
  await ensureTable(pool);
  const p = cleanPath(path);
  await pool.query(`INSERT INTO nesher_money_payment_posts
    (transaction_id, invoice_number, amount_cents, brand, paid_at, first_path, paths, card_last4, rep, kind)
    VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN '{}'::text[] ELSE ARRAY[$6::text] END, $7, $8, $9)
    ON CONFLICT (transaction_id) DO NOTHING`,
    [txn, ref, cents, brand, when.toISOString(), p, cleanLast4(cardLast4), cleanRep(rep), cleanKind(kind)]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`SELECT * FROM nesher_money_payment_posts WHERE transaction_id = $1 FOR UPDATE`, [txn]);
    const row = found.rows[0];
    if (!row) throw new Error('payment_event_missing');
    if (row.invoice_number !== ref || Number(row.amount_cents) !== cents || row.brand !== brand) {
      await client.query('ROLLBACK');
      return result('transaction_conflict', true);
    }
    if (row.state === 'posted') {
      await client.query('COMMIT');
      return { ok: true, durable: true, state: 'posted', recorded: [], skipped: [`${ref}: already synced`], errors: [] };
    }
    if (row.state === 'review') {
      await client.query('COMMIT');
      return { ...result(row.reason || 'review_required', true), durable: true, state: 'review' };
    }
    if (row.state === 'shadow') {
      // Observed while the legacy path owned the CRM write. The flip to live
      // never re-posts shadow history; that is a reviewed backfill of its own.
      await client.query('COMMIT');
      return { ...result('observed_in_shadow', true), durable: true, state: 'shadow' };
    }
    // Serialize different transactions for the same booking, too. Hash collisions
    // only add waiting; they do not merge identities. All SQL remains parameterized.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`money-post:${ref.replace(/-O\d+$/, '')}`]);
    const out = { ok: false, recorded: [], skipped: [], errors: [] };
    await client.query('SAVEPOINT crm_payment_write');
    await write(client, out);
    if (out.errors.length || (!out.recorded.length && !out.skipped.some((s) => s.includes('already synced')))) {
      // Roll back any partial writes before persisting an explicit review case.
      await client.query('ROLLBACK TO SAVEPOINT crm_payment_write');
      const reason = out.errors[0] || 'manual_payment_requires_review';
      await client.query(`UPDATE nesher_money_payment_posts SET state = 'review', reason = $2,
        attempts = attempts + 1, updated_at = NOW() WHERE transaction_id = $1 AND state = 'pending'`, [txn, reason]);
      await client.query('COMMIT');
      return { ...out, ok: false, durable: true, state: 'review', needsReview: true, newlyReviewed: true, errors: out.errors.length ? out.errors : [reason] };
    }
    await client.query(`UPDATE nesher_money_payment_posts SET state = 'posted', reason = NULL,
      attempts = attempts + 1, updated_at = NOW(), posted_at = NOW() WHERE transaction_id = $1`, [txn]);
    await client.query('COMMIT');
    return { ...out, ok: true, durable: true, state: 'posted' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
    // Keep pending for the recovery worker. Never store SQL errors or payloads.
    try {
      await client.query(`UPDATE nesher_money_payment_posts SET reason = 'posting_failed',
        attempts = attempts + 1, updated_at = NOW() WHERE transaction_id = $1 AND state = 'pending'`, [txn]);
    } catch { /* original durable pending event remains */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Bounded recovery of only events already confirmed and durably recorded. */
export async function retryPaymentPosts({ pool, post, limit = 50 }) {
  await ensureTable(pool);
  const batch = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
  const pending = await pool.query(`SELECT transaction_id, invoice_number, amount_cents, paid_at, kind
    FROM nesher_money_payment_posts WHERE state = 'pending'
    ORDER BY updated_at, transaction_id LIMIT $1`, [batch]);
  const out = { checked: pending.rows.length, posted: 0, review: 0, errors: 0 };
  for (const row of pending.rows) {
    // THE RETRY DISPATCHES ON KIND (Gabbai 24 Sep, B1). `post` is the SALE writer: handed a refund
    // it would write the money coming back as money coming in (a sign flip). A reversal whose CRM
    // write failed goes to a person, never to the sale writer.
    if (row.kind === 'refund') {
      try {
        await pool.query(`UPDATE nesher_money_payment_posts SET state = 'review', reason = 'reversal_retry_requires_review',
          attempts = attempts + 1, updated_at = NOW() WHERE transaction_id = $1 AND state = 'pending'`, [row.transaction_id]);
        out.review++;
      } catch { out.errors++; }
      continue;
    }
    // A SALE VOIDED BEFORE ITS CRM ROW WAS WRITTEN (audit #26 L2, 25 Sep): the desk chat's void of this
    // sale is already in the ledger as void_<txn>. Posting now would book money that never came in, so
    // the sale goes to a person instead - the processor's own void is the latest word on it.
    try {
      const voided = await pool.query(`SELECT 1 AS hit FROM nesher_money_payment_posts WHERE transaction_id = $1 LIMIT 1`, [`void_${row.transaction_id}`]);
      if (voided.rows && voided.rows.length) {
        await pool.query(`UPDATE nesher_money_payment_posts SET state = 'review', reason = $2,
          attempts = attempts + 1, updated_at = NOW() WHERE transaction_id = $1 AND state = 'pending'`, [row.transaction_id, 'sale_voided_before_posting']);
        out.review++;
        continue;
      }
    } catch { /* the read failed: fall through to the ordinary retry */ }
    try {
      const r = await post({ pool, transactionId: row.transaction_id, invoiceNumber: row.invoice_number,
        amountUsd: Number(row.amount_cents) / 100, paidAt: row.paid_at });
      if (r.ok) out.posted++;
      else if (r.needsReview) out.review++;
      else out.errors++;
    } catch {
      out.errors++;
      // NEVER RETRIED FOREVER (audit #141): a row the CRM refuses MAX_POST_ATTEMPTS times (each attempt
      // is a live connection that reached the row, so this is the row, not an outage) goes to a person.
      try {
        const moved = await pool.query(`UPDATE nesher_money_payment_posts SET state = 'review', reason = $2, updated_at = NOW()
          WHERE transaction_id = $1 AND state = 'pending' AND attempts >= $3 RETURNING transaction_id`, [row.transaction_id, 'crm_write_keeps_failing', MAX_POST_ATTEMPTS]);
        if (moved.rows && moved.rows.length) out.review++;
      } catch { /* stays pending; the next pass tries again */ }
    }
  }
  const totals = await pool.query(`SELECT state, COUNT(*)::integer AS count
    FROM nesher_money_payment_posts WHERE state <> 'posted' GROUP BY state`);
  out.pendingTotal = Number(totals.rows.find((row) => row.state === 'pending')?.count || 0);
  out.reviewTotal = Number(totals.rows.find((row) => row.state === 'review')?.count || 0) + await shadowReviewCount(pool);
  return out;
}

export const MAX_POST_ATTEMPTS = 10;

// The CRM marker a sale's own payment row carries once it is in the CRM (the loop's rows, the office
// rows, and the hand rows the 24 Sep link pass tagged). Anchored, as everywhere else in this file.
const SALE_IN_CRM = `(EXISTS (SELECT 1 FROM core_payment WHERE notes ~ ('(^|[[:space:]])nmi:' || p.transaction_id || '($|[[:space:]])'))
  OR EXISTS (SELECT 1 FROM core_jrmhotelpayment WHERE reference ~ ('(^|[[:space:]])nmi:' || p.transaction_id || '($|[[:space:]])')))`;

/**
 * SHADOW-ERA ROWS THAT STILL WAIT (audit #73, 25 Sep): a sale observed before the flip to live whose
 * would-be action was review (an open-amount sale, a sale with no booking, a portal refund) was never
 * moved on, so no count and no list showed it. It waits until its sale is in the CRM (a row carrying
 * nmi:<txn>). Reads only. A CRM without the payment tables (tests) counts every such row.
 */
async function shadowReviewCount(pool) {
  try {
    const r = await pool.query(`SELECT COUNT(*)::integer AS n FROM nesher_money_payment_posts p
      WHERE p.state = 'shadow' AND p.would_action = 'review' AND NOT ${SALE_IN_CRM}`);
    return Number(r.rows?.[0]?.n || 0);
  } catch {
    try {
      const r = await pool.query(`SELECT COUNT(*)::integer AS n FROM nesher_money_payment_posts WHERE state = 'shadow' AND would_action = 'review'`);
      return Number(r.rows?.[0]?.n || 0);
    } catch { return 0; }
  }
}

/** Staff-only callers may inspect the reason a confirmed payment is still open. */
export async function listPaymentPostExceptions({ pool, limit = 100 }) {
  await ensureTable(pool);
  const out = await pool.query(`SELECT transaction_id, invoice_number, amount_cents, currency,
    brand, paid_at, state, reason, attempts, created_at, updated_at
    FROM nesher_money_payment_posts WHERE state IN ('pending', 'review') OR (state = 'shadow' AND would_action = 'review')
    ORDER BY created_at, transaction_id LIMIT $1`, [Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)))]);
  return out.rows;
}

// ── what waits on a person (audit #27, 25 Sep) ─────────────────────────────
// Plain words per reason: what happened + what to do. Never a card digit, never a customer name.
// Gabbai 25 Sep D2: every line that tells a person to enter, take off or delete something says to CHECK
// first - the loop cannot see what staff already did by hand. Pinned by a table scan in the tests.
export const REVIEW_WORDS = Object.freeze({
  no_crm_reference: "A card payment came in with no booking on it. Find its booking and enter it there, if it is not already there.",
  booking_not_found: "A card payment names a booking the CRM cannot find. Find the right booking and enter it there, if it is not already there.",
  request_not_found: "A card payment names a hotel request the CRM cannot find. Find the right request and enter it there, if it is not already there.",
  manual_payment_requires_review: "A card payment matches a payment already typed on the booking. If it is the same money, nothing to enter; if it is not, enter it.",
  sale_voided: "A card sale was voided at the processor, so no money came in. If the booking shows it as paid, take it off.",
  sale_voided_before_posting: "A card sale was voided before it reached the CRM, so no money came in. Nothing to enter; if the booking shows it as paid, take it off.",
  refund_voided: "A refund was started and then voided at the processor, so no money moved. Nothing to change.",
  reversal_requires_review: "Money went back to a card outside the desk chat. If the booking still shows that money as paid, take it off.",
  refund_outside_chat: "A refund was sent in the processor's portal for a sale the CRM did not record automatically. If the booking still shows the full amount, take the refund off it.",
  reversal_retry_requires_review: "A refund or void could not be written to the CRM. If the booking does not show it yet, take it off by hand.",
  sale_not_in_crm: "A refund or void is for a sale the CRM did not record automatically. If the booking shows that sale, adjust it by hand.",
  sale_on_two_crm_rows: "A refund or void matches two payment rows. Check which one it belongs to, and if it is not already off, take it off that one only.",
  crm_write_keeps_failing: "The CRM kept refusing this card payment. If the booking does not show it, enter it by hand.",
  hand_row_after_auto_post: "A card payment the CRM recorded automatically also has a hand-typed payment of the same amount. If it is the same money, delete the hand-typed copy.",
  flight_link_not_wired: "A flight pay link was paid. If the flight request does not show it, enter it there.",
  brand_mismatch: "A card payment ran on the other company's merchant. Check which booking it belongs to, and enter it there if it is not already there.",
  invoice_amount_mismatch: "A pay link was paid a different amount than it asked for. If the booking does not show what came in, enter it.",
  invoice_transaction_conflict: "A pay link shows two card payments. Check the booking; if the second one is a duplicate charge, it needs a refund.",
  legacy_transaction_conflict: "This card payment is already recorded on another booking. Do not enter it twice; check which booking is right.",
  hotel_offer_mismatch: "A card payment names a hotel offer from another request. Check which request it belongs to, and enter it there if it is not already there.",
  transaction_conflict: "The same card transaction came in with different facts. Check the booking before entering anything.",
  review: "A card payment could not be recorded in the CRM by itself. Check the booking, and enter it if it is not already there.",
  crm_write_pending: "A card payment is still being written to the CRM automatically. Do not enter it by hand while it shows here.",
  before_live: "A card payment from before the automatic recording has no booking in the CRM. Check whether it was typed in by hand; if not, enter it.",
});
// Gabbai 25 Sep D1: loop-review `reason` is a code from a closed set, never ledger free text.
export function reasonCode(reason) {
  const r = String(reason || "");
  if (/reservations match code/.test(r)) return "booking_not_found";
  if (/not found/.test(r)) return "request_not_found";
  if (Object.prototype.hasOwnProperty.call(REVIEW_WORDS, r)) return r;
  return "review";
}
function wordsFor(code, state) {
  if (state === "pending") return REVIEW_WORDS.crm_write_pending;
  if (state === "shadow" && (code === "no_crm_reference" || code === "review")) return REVIEW_WORDS.before_live;
  return REVIEW_WORDS[code] || REVIEW_WORDS.review;
}
function bookingOf(ref) {
  const s = String(ref || "").trim().toUpperCase();
  return /^(?:RES-[A-Z0-9_-]{1,40}|JRM-1[0-9]{1,12}(?:-O[0-9]{1,12})?|FLY-[A-Z0-9_-]{1,40})$/.test(s) && !/^RES-CARD-/.test(s) ? s : null;
}

/**
 * THE LOOP-REVIEW LIST (read only; GET /__money_hop/loop-review behind the hop signature). Everything
 * the collection loop could not close by itself, newest first:
 *   - ledger rows in review (live) whose sale is not in the CRM,
 *   - shadow-era rows whose would-be action was review and whose sale is not in the CRM (#73),
 *   - pending rows older than 30 minutes (the CRM has not taken them yet),
 *   - a loop-posted sale that was ALSO typed in by hand afterwards (#28) - computed live, so deleting
 *     the hand copy clears it.
 * `count` = all of them; `items` = at most 20. No card digits, no names, no transaction id.
 */
export async function loopReview({ pool, limit = 20, now = new Date() }) {
  await ensureTable(pool);
  const cap = Math.min(20, Math.max(1, Math.floor(Number(limit) || 20)));
  const rows = [];
  let marker = true;
  let ledger;
  try {
    ledger = await pool.query(`SELECT p.transaction_id, p.invoice_number, p.amount_cents, p.currency, p.brand, p.state, p.reason, p.kind,
        p.paid_at, p.created_at, p.updated_at FROM nesher_money_payment_posts p
      WHERE ((p.state = 'review' OR (p.state = 'shadow' AND p.would_action = 'review')) AND (p.kind = 'refund' OR NOT ${SALE_IN_CRM}))
         OR (p.state = 'pending' AND p.created_at < $1::timestamptz)
      ORDER BY p.created_at DESC`, [new Date(now.getTime() - 30 * 60000).toISOString()]);
  } catch {
    marker = false;
    ledger = await pool.query(`SELECT transaction_id, invoice_number, amount_cents, currency, brand, state, reason, kind, paid_at, created_at, updated_at
      FROM nesher_money_payment_posts
      WHERE state = 'review' OR (state = 'shadow' AND would_action = 'review') OR (state = 'pending' AND created_at < $1::timestamptz)
      ORDER BY created_at DESC`, [new Date(now.getTime() - 30 * 60000).toISOString()]);
  }
  for (const r of ledger.rows || []) {
    // at = when the money moved (the sale), not when the ledger first saw it
    rows.push({ at: new Date(r.paid_at || r.created_at).toISOString(), brand: r.brand === "jrm" || r.brand === "nesher" ? r.brand : null,
      amount_cents: Number(r.amount_cents), currency: "USD", booking: bookingOf(r.invoice_number),
      reason: r.state === "pending" ? "crm_write_pending" : r.state === "shadow" ? `before_live_${reasonCode(r.reason)}` : reasonCode(r.reason),
      words: wordsFor(reasonCode(r.reason), r.state) });
  }
  if (marker) {
    try {
      for (const d of await handRowsAfterAutoPost(pool)) rows.push(d);
    } catch { /* a failed read never hides the ledger half */ }
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { ok: true, as_of: now.toISOString(), count: rows.length, items: rows.slice(0, cap) };
}

/** Audit #28: a sale the loop posted (state posted, last 30 days) whose booking ALSO carries a later
 *  hand-typed row of the same amount with no marker. Reads only. */
async function handRowsAfterAutoPost(pool) {
  const posted = (await pool.query(`SELECT transaction_id, invoice_number, amount_cents, brand, posted_at
    FROM nesher_money_payment_posts WHERE state = 'posted' AND kind = 'sale' AND posted_at > NOW() - INTERVAL '30 days'`)).rows || [];
  const out = [];
  for (const p of posted) {
    const re = `(^|[[:space:]])nmi:${p.transaction_id}($|[[:space:]])`;
    const res = (await pool.query(`SELECT id, reservation_id, amount FROM core_payment WHERE notes ~ $1 ORDER BY id LIMIT 1`, [re])).rows[0];
    let hit = null;
    if (res) {
      hit = (await pool.query(`SELECT id, created_at FROM core_payment WHERE reservation_id = $1 AND id > $2 AND ABS(amount - $3) < 0.01
        AND COALESCE(notes, '') !~ '(mercury|nmi|nmi-void|nmi-refund):[A-Za-z0-9_-]+' ORDER BY id LIMIT 1`, [res.reservation_id, res.id, res.amount])).rows[0];
    } else {
      const hot = (await pool.query(`SELECT id, request_id, amount FROM core_jrmhotelpayment WHERE reference ~ $1 ORDER BY id LIMIT 1`, [re])).rows[0];
      if (hot) {
        hit = (await pool.query(`SELECT id, created_at FROM core_jrmhotelpayment WHERE request_id = $1 AND id > $2 AND ABS(amount - $3) < 0.01
          AND COALESCE(reference, '') !~ '(mercury|nmi|nmi-void|nmi-refund):[A-Za-z0-9_-]+' ORDER BY id LIMIT 1`, [hot.request_id, hot.id, hot.amount])).rows[0];
      }
    }
    if (hit) out.push({ at: new Date(hit.created_at || p.posted_at).toISOString(), brand: p.brand === "jrm" || p.brand === "nesher" ? p.brand : null,
      amount_cents: Number(p.amount_cents), currency: "USD", booking: bookingOf(p.invoice_number),
      reason: "hand_row_after_auto_post", words: REVIEW_WORDS.hand_row_after_auto_post });
  }
  return out;
}

/**
 * Live-mode exception door: a confirmed sale that must not be posted (no CRM
 * reference, amount differs from the stored request, a second transaction for
 * an already-paid request) is kept as a durable review row. It never touches a
 * CRM table.
 */
export async function recordPaymentException({ pool, invoiceNumber, amountUsd, transactionId, paidAt, brand, reason, path, cardLast4, rep, kind }) {
  const v = validate({ transactionId, invoiceNumber, amountUsd, paidAt, brand });
  if (v.error) return { ...result(v.error), durable: false };
  if (!pool || typeof pool.query !== 'function') return { ...result('database_unavailable'), durable: false };
  await ensureTable(pool);
  const why = String(reason || 'review_required').slice(0, 80);
  const p = cleanPath(path);
  const ins = await pool.query(`INSERT INTO nesher_money_payment_posts
    (transaction_id, invoice_number, amount_cents, brand, paid_at, state, reason, first_path, paths, card_last4, rep, kind)
    VALUES ($1, $2, $3, $4, $5, 'review', $6, $7, CASE WHEN $7::text IS NULL THEN '{}'::text[] ELSE ARRAY[$7::text] END, $8, $9, $10)
    ON CONFLICT (transaction_id) DO UPDATE SET seen_count = nesher_money_payment_posts.seen_count + 1, updated_at = NOW()
    RETURNING (xmax = 0) AS inserted`,
    [v.txn, v.ref, v.cents, brand, v.when.toISOString(), why, p, cleanLast4(cardLast4), cleanRep(rep), cleanKind(kind)]);
  const row = (await pool.query(`SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = $1`, [v.txn])).rows[0];
  // inserted = the first sight of this transaction (audit #142: health tells new exceptions from re-sightings)
  return { ok: false, durable: Boolean(row), inserted: ins?.rows?.[0]?.inserted === true, state: row?.state || null, needsReview: true, errors: [row?.reason || why] };
}

// ── shadow ───────────────────────────────────────────────────────────────────

const WRITE_RE = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z0-9_."]+)/i;

/** A client that forwards reads and CAPTURES writes. Used only inside a READ
 *  ONLY transaction, so even a write that slipped past the capture is refused
 *  by Postgres itself. */
export function captureClient(client, writes) {
  return {
    query: async (text, params = []) => {
      const m = WRITE_RE.exec(String(text));
      if (m) {
        writes.push({
          op: m[1].split(/\s+/)[0].toUpperCase(),
          table: m[2].replace(/"/g, ''),
          params: (params || []).map((x) => (x instanceof Date ? x.toISOString() : x == null ? null : String(x).slice(0, 160))),
        });
        return { rows: [], rowCount: 1 };
      }
      return client.query(text, params);
    },
  };
}

function actionOf(out) {
  if (out.errors.length) return { action: 'review', reason: String(out.errors[0]).slice(0, 120) };
  if (out.recorded.length) return { action: 'post', reason: null };
  if (out.skipped.some((s) => s.includes('already synced'))) return { action: 'skip', reason: 'already_synced' };
  return { action: 'review', reason: 'manual_payment_requires_review' };
}

/**
 * Shadow observation of one confirmed payment event. Writes ONLY the ledger
 * table. `write(client, out)` is the live posting code; it runs against a
 * capture client in a READ ONLY transaction that is always rolled back.
 * `decision` = {action:'post'} or {action:'exception', reason} from the caller.
 */
export async function observeShadowPayment({ pool, ev, write }) {
  const v = validate(ev || {});
  if (v.error) return { ok: false, error: v.error };
  if (!pool || typeof pool.connect !== 'function') return { ok: false, error: 'database_unavailable' };
  await ensureTable(pool);
  const p = cleanPath(ev.path);
  const ins = await pool.query(`INSERT INTO nesher_money_payment_posts
    (transaction_id, invoice_number, amount_cents, brand, paid_at, state, mode, first_path, paths, card_last4, rep, kind)
    VALUES ($1, $2, $3, $4, $5, 'shadow', 'shadow', $6, CASE WHEN $6::text IS NULL THEN '{}'::text[] ELSE ARRAY[$6::text] END, $7, $8, $9)
    ON CONFLICT (transaction_id) DO UPDATE SET
      seen_count = nesher_money_payment_posts.seen_count + 1,
      paths = CASE WHEN EXCLUDED.first_path IS NULL OR EXCLUDED.first_path = ANY(nesher_money_payment_posts.paths)
        THEN nesher_money_payment_posts.paths ELSE array_append(nesher_money_payment_posts.paths, EXCLUDED.first_path) END,
      card_last4 = COALESCE(nesher_money_payment_posts.card_last4, EXCLUDED.card_last4),
      rep = COALESCE(nesher_money_payment_posts.rep, EXCLUDED.rep),
      updated_at = NOW()
    RETURNING (xmax = 0) AS inserted, would_action, invoice_number, amount_cents, brand, state`,
    [v.txn, v.ref, v.cents, ev.brand, v.when.toISOString(), p, cleanLast4(ev.cardLast4), cleanRep(ev.rep), cleanKind(ev.kind)]);
  const row = ins.rows[0] || {};
  if (!row.inserted && (row.invoice_number !== v.ref || Number(row.amount_cents) !== v.cents || row.brand !== ev.brand)) {
    // Same transaction id, different facts: never merged, flagged.
    await pool.query(`UPDATE nesher_money_payment_posts SET reason = 'transaction_conflict', updated_at = NOW()
      WHERE transaction_id = $1`, [v.txn]);
    return { ok: true, inserted: false, conflict: true, would_action: row.would_action };
  }
  if (!row.inserted && row.would_action) return { ok: true, inserted: false, would_action: row.would_action };
  if (row.state && row.state !== 'shadow') return { ok: true, inserted: false, state: row.state };

  const decision = ev.decision || { action: 'post' };
  let plan;
  const writes = [];
  if (decision.action === 'exception') {
    plan = { action: 'review', reason: String(decision.reason || 'review_required').slice(0, 120) };
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const out = { ok: false, recorded: [], skipped: [], errors: [] };
      try {
        await write(captureClient(client, writes), out);
      } catch (e) {
        out.errors.push('plan_failed');
      }
      plan = actionOf(out);
      plan.detail = { recorded: out.recorded.slice(0, 3), skipped: out.skipped.slice(0, 3), errors: out.errors.slice(0, 3) };
    } finally {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      client.release();
    }
  }
  const would = { decision: decision.action, reason: plan.reason, writes, ...(plan.detail ? { detail: plan.detail } : {}) };
  await pool.query(`UPDATE nesher_money_payment_posts SET would_action = $2, would = $3::jsonb, reason = $4, updated_at = NOW()
    WHERE transaction_id = $1`, [v.txn, plan.action, JSON.stringify(would), plan.reason]);
  return { ok: true, inserted: true, would_action: plan.action, reason: plan.reason };
}

/** Never lets the observer slow or break a money path: bounded, swallowed. */
export async function observeSafely(fn, ev, ms = 3000) {
  if (typeof fn !== 'function') return null;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(ev)),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: 'observe_timeout' }), ms); }),
    ]);
  } catch {
    return { ok: false, error: 'observe_failed' };
  } finally {
    clearTimeout(timer);
  }
}

function anchored(prefix, txn) {
  return `(^|[[:space:]])${prefix}:${txn}($|[[:space:]])`;
}

/**
 * Read-only comparison of what the shadow path WOULD post with what the legacy
 * path DID write, per ledger row. Legacy truth is read from the CRM itself:
 * a payment row carrying the nmi:<txn> marker, or a legacy staff note naming
 * the transaction.
 */
export async function shadowReport({ pool, limit = 200 }) {
  await ensureTable(pool);
  const n = Math.min(500, Math.max(1, Math.floor(Number(limit) || 200)));
  const rows = (await pool.query(`SELECT transaction_id, invoice_number, amount_cents, brand, paid_at, state, mode,
      first_path, paths, seen_count, card_last4 IS NOT NULL AS has_last4, rep, would_action, would, reason, created_at, kind
    FROM nesher_money_payment_posts ORDER BY created_at DESC LIMIT $1`, [n])).rows;
  const items = [];
  const tally = { events: rows.length, would: { post: 0, skip: 0, review: 0, pending: 0 }, matches: 0, mismatches: 0, reasons: {}, byPath: {}, byBrand: {} };
  for (const r of rows) {
    const txn = String(r.transaction_id);
    tally.byBrand[r.brand] = (tally.byBrand[r.brand] || 0) + 1;
    for (const p of r.paths || []) tally.byPath[p] = (tally.byPath[p] || 0) + 1;
    const res = (await pool.query(`SELECT id, reservation_id, amount FROM core_payment WHERE notes ~ $1 ORDER BY id`, [anchored('nmi', txn)])).rows;
    const hot = (await pool.query(`SELECT id, request_id, amount FROM core_jrmhotelpayment WHERE reference ~ $1 ORDER BY id`, [anchored('nmi', txn)])).rows;
    const noteRe = `txn ${txn}([^0-9A-Za-z_-]|$)`;
    const resNote = (await pool.query(`SELECT COUNT(*)::integer AS n FROM core_reservation WHERE notes ~ $1`, [noteRe])).rows[0]?.n || 0;
    const hotNote = (await pool.query(`SELECT COUNT(*)::integer AS n FROM core_jrmhotelnote WHERE note ~ $1`, [noteRe])).rows[0]?.n || 0;
    const legacyRows = [...res.map((x) => ({ table: 'core_payment', target: Number(x.reservation_id), cents: Math.round(Number(x.amount) * 100) })),
      ...hot.map((x) => ({ table: 'core_jrmhotelpayment', target: Number(x.request_id), cents: Math.round(Number(x.amount) * 100) }))];
    const legacyNote = resNote + hotNote > 0;
    const would = r.would || {};
    const ins = (would.writes || []).find((w) => w.op === 'INSERT' && /core_(jrmhotel)?payment$/.test(w.table));
    // core_payment insert params: [amount, method, paid_at, notes, reservation_id, ...]
    // core_jrmhotelpayment insert params: [payment_date, amount, method, reference, note, offer_id, request_id, ...]
    const wouldRow = ins
      ? ins.table === 'core_payment'
        ? { table: ins.table, target: Number(ins.params[4]), cents: Math.round(Number(ins.params[0]) * 100) }
        : { table: ins.table, target: Number(ins.params[6]), cents: Math.round(Number(ins.params[1]) * 100) }
      : null;
    let match = false;
    let why = null;
    const act = r.would_action || 'pending';
    tally.would[act] = (tally.would[act] || 0) + 1;
    if (act === 'pending') why = 'not_yet_planned';
    else if (legacyRows.length > 1) why = 'legacy_duplicate_rows';
    else if (act === 'post') {
      if (!legacyRows.length) why = legacyNote ? 'legacy_note_only_no_payment_row' : 'legacy_recorded_nothing';
      else if (!wouldRow || legacyRows[0].table !== wouldRow.table || legacyRows[0].target !== wouldRow.target || legacyRows[0].cents !== wouldRow.cents) why = 'target_or_amount_differs';
      else match = true;
    } else if (act === 'skip') {
      match = true;
    } else if (act === 'review') {
      if (legacyRows.length) why = `legacy_posted_but_new_path_reviews:${r.reason || 'review'}`;
      else match = true;
    }
    if (r.reason === 'transaction_conflict') { match = false; why = 'transaction_conflict'; }
    if (match) tally.matches++;
    else {
      tally.mismatches++;
      tally.reasons[why] = (tally.reasons[why] || 0) + 1;
    }
    items.push({
      transaction_id: txn, invoice: r.invoice_number, brand: r.brand, kind: r.kind, amount_usd: Number(r.amount_cents) / 100,
      paths: r.paths, seen: r.seen_count, would: act, would_reason: r.reason || null, would_row: wouldRow,
      legacy_rows: legacyRows, legacy_note: legacyNote, has_last4: r.has_last4, rep: r.rep || null,
      match, mismatch_reason: match ? null : why, first_seen: r.created_at,
    });
  }
  return { tally, items };
}
