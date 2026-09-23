/** Durable, replayable CRM posting of confirmed NMI payments. No gateway calls. */
const ready = new WeakMap();

async function ensureTable(pool) {
  if (!ready.has(pool)) {
    const task = pool.query(`CREATE TABLE IF NOT EXISTS nesher_money_payment_posts (
      transaction_id TEXT PRIMARY KEY,
      invoice_number TEXT NOT NULL,
      amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
      currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
      brand TEXT NOT NULL CHECK (brand IN ('nesher', 'jrm')),
      paid_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'posted', 'review')),
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      posted_at TIMESTAMPTZ
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

/** Persist before attempting CRM changes. Event + payment + balance commit together. */
export async function postConfirmedPayment({ pool, invoiceNumber, amountUsd, transactionId, paidAt, brand, write }) {
  const txn = String(transactionId || '').trim();
  const ref = String(invoiceNumber || '').trim().toUpperCase();
  const amount = Number(amountUsd);
  const cents = Math.round(amount * 100);
  const when = new Date(paidAt || Date.now());
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(txn)) return result('transaction_id_required');
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || cents <= 0 || Math.abs(amount * 100 - cents) > 0.00001) return result('invalid_amount');
  if (!ref || !['nesher', 'jrm'].includes(brand) || Number.isNaN(when.getTime())) return result('invalid_payment');
  if (!pool || typeof pool.connect !== 'function') return result('database_unavailable');
  await ensureTable(pool);
  await pool.query(`INSERT INTO nesher_money_payment_posts
    (transaction_id, invoice_number, amount_cents, brand, paid_at)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT (transaction_id) DO NOTHING`,
    [txn, ref, cents, brand, when.toISOString()]);
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
    FROM nesher_money_payment_posts WHERE state <> 'posted'
    ORDER BY created_at, transaction_id LIMIT $1`, [Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)))]);
  return out.rows;
}
