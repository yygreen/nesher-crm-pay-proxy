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

function mapOffer(row) {
  return {
    id: Number(row.id),
    hotel_name: row.hotel_name,
    customer_price: row.customer_price,
    currency: row.currency,
    vat_status: row.vat_status,
    room_type: row.room_type,
    sent_to_customer: row.sent_to_customer,
    sent_to_customer_at: row.sent_to_customer_at,
    customer_answer_status: row.customer_answer_status,
    request_id: Number(row.request_id),
  };
}

function mapRequest(row) {
  return {
    id: Number(row.id),
    customer_name: row.customer_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    city: row.city,
    check_in: row.check_in,
    check_out: row.check_out,
    internal_notes: row.internal_notes,
  };
}

/**
 * Load exact offer + parent request. Fails if offer has no customer_price.
 */
export async function loadHotelOfferPayContext(offerId) {
  const p = getPool();
  const id = Number(offerId);
  if (!Number.isFinite(id)) throw new Error("Invalid offer id");

  const r = await p.query(
    `SELECT o.id, o.hotel_name, o.customer_price, o.currency, o.vat_status, o.room_type,
            o.sent_to_customer, o.sent_to_customer_at, o.customer_answer_status, o.request_id,
            r.id AS req_id, r.customer_name, r.email, r.phone, r.status AS req_status,
            r.city, r.check_in, r.check_out, r.internal_notes
     FROM core_jrmhoteloffer o
     JOIN core_jrmhotelrequest r ON r.id = o.request_id
     WHERE o.id = $1`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Hotel offer ${id} not found`);
  const row = r.rows[0];
  const price = Number(row.customer_price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(
      `Offer #${id} has no customer price (quote not set) — set Customer Price first`
    );
  }
  const request = mapRequest({
    id: row.req_id,
    customer_name: row.customer_name,
    email: row.email,
    phone: row.phone,
    status: row.req_status,
    city: row.city,
    check_in: row.check_in,
    check_out: row.check_out,
    internal_notes: row.internal_notes,
  });
  const offer = mapOffer(row);
  return { request, offer };
}

/**
 * Resolve the exact quote for a hotel request.
 * @param {number|string} requestId
 * @param {number|string|null} offerId  when set, that offer is required
 */
export async function loadHotelPayContext(requestId, offerId = null) {
  const p = getPool();
  const id = Number(requestId);
  if (!Number.isFinite(id)) throw new Error("Invalid hotel request id");

  if (offerId != null && offerId !== "" && offerId !== undefined) {
    const ctx = await loadHotelOfferPayContext(offerId);
    if (ctx.request.id !== id) {
      throw new Error(
        `Offer #${offerId} does not belong to hotel request #${id}`
      );
    }
    return { ...ctx, resolution: "explicit_offer" };
  }

  const req = await p.query(
    `SELECT id, customer_name, email, phone, status, city, check_in, check_out, internal_notes
     FROM core_jrmhotelrequest WHERE id = $1`,
    [id]
  );
  if (!req.rows.length) throw new Error(`Hotel request ${id} not found`);
  const request = mapRequest(req.rows[0]);

  const offersRes = await p.query(
    `SELECT id, hotel_name, customer_price, currency, vat_status, room_type,
            sent_to_customer, sent_to_customer_at, customer_answer_status, request_id
     FROM core_jrmhoteloffer
     WHERE request_id = $1 AND customer_price IS NOT NULL AND customer_price::numeric > 0
     ORDER BY
       CASE WHEN customer_answer_status ILIKE 'accepted%' OR customer_answer_status ILIKE 'book%' THEN 0 ELSE 1 END,
       CASE WHEN sent_to_customer IS TRUE THEN 0 ELSE 1 END,
       sent_to_customer_at DESC NULLS LAST,
       id DESC`,
    [id]
  );
  const priced = offersRes.rows.map(mapOffer);
  if (!priced.length) {
    throw new Error(
      "No priced offer on this hotel request (set Customer Price on an offer)"
    );
  }

  // Prefer accepted/booked, then sent-to-customer, else only if single priced offer
  const accepted = priced.filter(
    (o) =>
      o.customer_answer_status &&
      /accept|book|want/i.test(String(o.customer_answer_status))
  );
  const sent = priced.filter((o) => o.sent_to_customer);

  let offer;
  let resolution;
  if (accepted.length === 1) {
    offer = accepted[0];
    resolution = "accepted_offer";
  } else if (sent.length === 1) {
    offer = sent[0];
    resolution = "sent_to_customer";
  } else if (priced.length === 1) {
    offer = priced[0];
    resolution = "single_priced_offer";
  } else if (sent.length > 1) {
    // latest sent
    offer = sent[0];
    resolution = "latest_sent_offer";
  } else {
    // ambiguous: multiple priced, none clearly the customer quote
    const summary = priced
      .map(
        (o) =>
          `#${o.id} ${o.hotel_name || "?"} ${o.customer_price} ${o.currency || ""}`
      )
      .join("; ");
    const err = new Error(
      `Multiple priced offers on request #${id} — open the request and click Pay on the exact quote. Offers: ${summary}`
    );
    err.code = "AMBIGUOUS_OFFERS";
    err.offers = priced;
    throw err;
  }

  return { request, offer, resolution, allPricedOffers: priced };
}

export async function loadReservationPayContext(reservationId) {
  const p = getPool();
  const id = Number(reservationId);
  if (!Number.isFinite(id)) throw new Error("Invalid reservation id");

  const r = await p.query(
    `SELECT res.id, res.reservation_code, res.customer_price, res.amount_paid, res.is_closed, res.notes,
            res.booking_method, res.supplier_cost,
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
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Reservation has no customer_price quote");
  }
  const balance = Math.round((price - paid) * 100) / 100;
  if (!(balance > 0)) {
    throw new Error(
      "Reservation has no payable balance (customer_price - amount_paid <= 0)"
    );
  }
  return {
    reservation: row,
    balance,
    quote: {
      customer_price: price,
      amount_paid: paid,
      balance,
      currency: "USD",
    },
  };
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
