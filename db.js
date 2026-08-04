import pg from "pg";

let pool;

export function getPool() {
  const url = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!url) throw new Error("DATABASE_URL not configured");
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
      max: 4,
    });
  }
  return pool;
}

export async function loadHotelPayContext(requestId) {
  const p = getPool();
  const id = Number(requestId);
  if (!Number.isFinite(id)) throw new Error("Invalid hotel request id");

  const req = await p.query(
    `SELECT id, customer_name, email, phone, status, city, check_in, check_out, internal_notes
     FROM core_jrmhotelrequest WHERE id = $1`,
    [id]
  );
  if (!req.rows.length) throw new Error(`Hotel request ${id} not found`);
  const request = req.rows[0];

  // Prefer highest customer_price offer; fallback latest with price
  const offers = await p.query(
    `SELECT id, hotel_name, customer_price, currency, vat_status, room_type
     FROM core_jrmhoteloffer
     WHERE request_id = $1 AND customer_price IS NOT NULL AND customer_price::numeric > 0
     ORDER BY customer_price::numeric DESC, id DESC
     LIMIT 1`,
    [id]
  );
  if (!offers.rows.length) {
    throw new Error("No priced offer on this hotel request (customer_price required)");
  }
  const offer = offers.rows[0];
  return { request, offer };
}

export async function loadReservationPayContext(reservationId) {
  const p = getPool();
  const id = Number(reservationId);
  if (!Number.isFinite(id)) throw new Error("Invalid reservation id");

  const r = await p.query(
    `SELECT res.id, res.reservation_code, res.customer_price, res.amount_paid, res.is_closed, res.notes,
            cust.full_name AS customer_name, cust.email AS customer_email, cust.phone
     FROM core_reservation res
     LEFT JOIN core_customer cust ON cust.id = res.customer_id
     WHERE res.id = $1`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Reservation ${id} not found`);
  const row = r.rows[0];
  const price = Number(row.customer_price || 0);
  const paid = Number(row.amount_paid || 0);
  const balance = Math.round((price - paid) * 100) / 100;
  if (!(balance > 0)) {
    throw new Error("Reservation has no payable balance (customer_price - amount_paid <= 0)");
  }
  return { reservation: row, balance };
}

export async function appendHotelNote(requestId, note, userId = null) {
  const p = getPool();
  await p.query(
    `INSERT INTO core_jrmhotelnote (note, created_at, created_by_id, request_id)
     VALUES ($1, NOW(), $2, $3)`,
    [note, userId, Number(requestId)]
  );
}

export async function appendReservationNote(reservationId, noteText) {
  const p = getPool();
  await p.query(
    `UPDATE core_reservation
     SET notes = COALESCE(notes,'') || $1, updated_at = NOW()
     WHERE id = $2`,
    [`\n[Mercury Pay] ${noteText}`, Number(reservationId)]
  );
}
