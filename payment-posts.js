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

function result(error, needsReview = false) {
  return { ok: false, recorded: [], skipped: [], errors: [error], needsReview };
}

const PATHS = new Set(["guest", "webhook", "office", "open", "recovery"]);
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
export async function postConfirmedPayment({ pool, invoiceNumber, amountUsd, transactionId, paidAt, brand, write, path, cardLast4, rep }) {
  const v = validate({ transactionId, invoiceNumber, amountUsd, paidAt, brand });
  if (v.error) return result(v.error);
  const { txn, ref, cents, when } = v;
  if (!pool || typeof pool.connect !== 'function') return result('database_unavailable');
  await ensureTable(pool);
  const p = cleanPath(path);
  await pool.query(`INSERT INTO nesher_money_payment_posts
    (transaction_id, invoice_number, amount_cents, brand, paid_at, first_path, paths, card_last4, rep)
    VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN '{}'::text[] ELSE ARRAY[$6::text] END, $7, $8)
    ON CONFLICT (transaction_id) DO NOTHING`,
    [txn, ref, cents, brand, when.toISOString(), p, cleanLast4(cardLast4), cleanRep(rep)]);
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
      return { ...out, ok: false, durable: true, state: 'review', needsReview: true, errors: out.errors.length ? out.errors : [reason] };
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
  const pending = await pool.query(`SELECT transaction_id, invoice_number, amount_cents, paid_at
    FROM nesher_money_payment_posts WHERE state = 'pending'
    ORDER BY updated_at, transaction_id LIMIT $1`, [batch]);
  const out = { checked: pending.rows.length, posted: 0, review: 0, errors: 0 };
  for (const row of pending.rows) {
    try {
      const r = await post({ pool, transactionId: row.transaction_id, invoiceNumber: row.invoice_number,
        amountUsd: Number(row.amount_cents) / 100, paidAt: row.paid_at });
      if (r.ok) out.posted++;
      else if (r.needsReview) out.review++;
      else out.errors++;
    } catch { out.errors++; }
  }
  const totals = await pool.query(`SELECT state, COUNT(*)::integer AS count
    FROM nesher_money_payment_posts WHERE state <> 'posted' GROUP BY state`);
  out.pendingTotal = Number(totals.rows.find((row) => row.state === 'pending')?.count || 0);
  out.reviewTotal = Number(totals.rows.find((row) => row.state === 'review')?.count || 0);
  return out;
}

/** Staff-only callers may inspect the reason a confirmed payment is still open. */
export async function listPaymentPostExceptions({ pool, limit = 100 }) {
  await ensureTable(pool);
  const out = await pool.query(`SELECT transaction_id, invoice_number, amount_cents, currency,
    brand, paid_at, state, reason, attempts, created_at, updated_at
    FROM nesher_money_payment_posts WHERE state IN ('pending', 'review')
    ORDER BY created_at, transaction_id LIMIT $1`, [Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)))]);
  return out.rows;
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
  await pool.query(`INSERT INTO nesher_money_payment_posts
    (transaction_id, invoice_number, amount_cents, brand, paid_at, state, reason, first_path, paths, card_last4, rep, kind)
    VALUES ($1, $2, $3, $4, $5, 'review', $6, $7, CASE WHEN $7::text IS NULL THEN '{}'::text[] ELSE ARRAY[$7::text] END, $8, $9, $10)
    ON CONFLICT (transaction_id) DO UPDATE SET seen_count = nesher_money_payment_posts.seen_count + 1, updated_at = NOW()`,
    [v.txn, v.ref, v.cents, brand, v.when.toISOString(), why, p, cleanLast4(cardLast4), cleanRep(rep), cleanKind(kind)]);
  const row = (await pool.query(`SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = $1`, [v.txn])).rows[0];
  return { ok: false, durable: Boolean(row), state: row?.state || null, needsReview: true, errors: [row?.reason || why] };
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
