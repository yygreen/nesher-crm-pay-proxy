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
    customer_price: row.customer_price != null ? Number(row.customer_price) : null,
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
    adults: row.adults ?? null,
    children: row.children ?? null,
    rooms: row.rooms ?? null,
  };
}

/** Soft query — returns [] on any failure (missing table/column). */
async function softQuery(sql, params = []) {
  try {
    const r = await getPool().query(sql, params);
    return r.rows || [];
  } catch (e) {
    console.warn("softQuery failed:", e.message);
    return [];
  }
}

/**
 * Load offer + parent request. Soft: zero price is allowed (draft will ask for amount).
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
  return { request, offer, soft: true };
}

/**
 * Resolve hotel request → offer. Soft when unpriced/ambiguous:
 * returns request + best-effort offer (may be null) + allOffers for the UI.
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
    return { ...ctx, resolution: "explicit_offer", soft: true };
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
     WHERE request_id = $1
     ORDER BY
       CASE WHEN customer_price IS NOT NULL AND customer_price::numeric > 0 THEN 0 ELSE 1 END,
       CASE WHEN customer_answer_status ILIKE 'accepted%' OR customer_answer_status ILIKE 'book%' THEN 0 ELSE 1 END,
       CASE WHEN sent_to_customer IS TRUE THEN 0 ELSE 1 END,
       sent_to_customer_at DESC NULLS LAST,
       id DESC`,
    [id]
  );
  const allOffers = offersRes.rows.map(mapOffer);
  const priced = allOffers.filter(
    (o) => Number.isFinite(Number(o.customer_price)) && Number(o.customer_price) > 0
  );

  // Prefer accepted/booked, then sent-to-customer, else single priced, else latest any
  const accepted = priced.filter(
    (o) =>
      o.customer_answer_status &&
      /accept|book|want/i.test(String(o.customer_answer_status))
  );
  const sent = priced.filter((o) => o.sent_to_customer);

  let offer = null;
  let resolution = "no_offer";
  let ambiguous = false;

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
    offer = sent[0];
    resolution = "latest_sent_offer";
    ambiguous = true;
  } else if (priced.length > 1) {
    offer = priced[0];
    resolution = "multiple_priced_pick_latest";
    ambiguous = true;
  } else if (allOffers.length === 1) {
    offer = allOffers[0];
    resolution = "single_unpriced_offer";
  } else if (allOffers.length > 1) {
    offer = allOffers[0];
    resolution = "latest_unpriced_offer";
    ambiguous = true;
  }

  return {
    request,
    offer,
    resolution,
    soft: true,
    ambiguous,
    allOffers,
    allPricedOffers: priced,
  };
}

async function loadReservationEnrichment(reservationId) {
  const id = Number(reservationId);
  const travelers = (
    await softQuery(
      `SELECT id, full_name, date_of_birth, passport_number, type
       FROM core_traveler
       WHERE reservation_id = $1
       ORDER BY id`,
      [id]
    )
  ).map((t) => ({
    id: t.id,
    full_name: t.full_name,
    date_of_birth: t.date_of_birth,
    passport_number: t.passport_number,
    type: t.type,
  }));

  // Flights may hang off journey segments
  let flights = (
    await softQuery(
      `SELECT fs.id, fs.airline, fs.flight_number, fs.from_location, fs.to_location,
              fs.departure_date, fs.departure_time, fs.arrival_date, fs.arrival_time,
              j.id AS journey_id, j.label AS journey_label
       FROM core_flightsegment fs
       JOIN core_journey j ON j.id = fs.journey_id
       WHERE j.reservation_id = $1
       ORDER BY fs.departure_date NULLS LAST, fs.id`,
      [id]
    )
  ).map((f) => ({
    id: f.id,
    airline: f.airline,
    flight_number: f.flight_number,
    from_location: f.from_location,
    to_location: f.to_location,
    departure_date: f.departure_date,
    departure_time: f.departure_time,
    arrival_date: f.arrival_date,
    arrival_time: f.arrival_time,
    journey_id: f.journey_id,
    journey_label: f.journey_label,
  }));

  // Alternate schema: segments linked differently or named columns vary
  if (!flights.length) {
    flights = (
      await softQuery(
        `SELECT id, airline, flight_number, origin AS from_location, destination AS to_location,
                departure_date, departure_time, arrival_date, arrival_time
         FROM core_flightsegment
         WHERE reservation_id = $1
         ORDER BY departure_date NULLS LAST, id`,
        [id]
      )
    ).map((f) => ({
      id: f.id,
      airline: f.airline,
      flight_number: f.flight_number,
      from_location: f.from_location,
      to_location: f.to_location,
      departure_date: f.departure_date,
      departure_time: f.departure_time,
      arrival_date: f.arrival_date,
      arrival_time: f.arrival_time,
    }));
  }

  return { travelers, flights };
}

/**
 * Resolve payable quote for a reservation — SOFT.
 * Never throws for zero price / zero balance. Still throws if reservation missing.
 * Packs journey lines, travelers, flights when available.
 */
export async function loadReservationPayContext(reservationId) {
  const p = getPool();
  const id = Number(reservationId);
  if (!Number.isFinite(id)) throw new Error("Invalid reservation id");

  const r = await p.query(
    `SELECT res.id, res.reservation_code, res.customer_price, res.amount_paid, res.is_closed, res.notes,
            res.booking_method, res.supplier_cost, res.tax_amount,
            cust.full_name AS customer_name, cust.email AS customer_email, cust.phone
     FROM core_reservation res
     LEFT JOIN core_customer cust ON cust.id = res.customer_id
     WHERE res.id = $1`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Reservation ${id} not found`);
  const row = r.rows[0];
  const paid = Number(row.amount_paid || 0);

  let price = Number(row.customer_price || 0);
  let priceSource = "reservation.customer_price";
  let journeyLines = [];

  // Always load journey lines for invoice detail (even when header has a price)
  const j = await softQuery(
    `SELECT id, label, customer_price, supplier_cost, line_type, confirmation_number, "order"
     FROM core_journey
     WHERE reservation_id = $1
     ORDER BY "order" NULLS LAST, id`,
    [id]
  );
  journeyLines = j.map((l) => ({
    id: l.id,
    label: l.label,
    customer_price: Number(l.customer_price) || 0,
    supplier_cost: Number(l.supplier_cost) || 0,
    line_type: l.line_type,
    confirmation_number: l.confirmation_number,
  }));

  if (!Number.isFinite(price) || price <= 0) {
    const journeySum = journeyLines.reduce(
      (s, line) => s + (Number(line.customer_price) || 0),
      0
    );
    if (journeySum > 0) {
      price = Math.round(journeySum * 100) / 100;
      priceSource = "sum(journey.customer_price)";
    }
  }

  if (!Number.isFinite(price) || price <= 0) {
    const t = await softQuery(
      `SELECT COALESCE(SUM(jtp.customer_price), 0) AS total
       FROM core_journeytravelerpricing jtp
       JOIN core_journey j ON j.id = jtp.journey_id
       WHERE j.reservation_id = $1`,
      [id]
    );
    const tSum = Number(t[0]?.total || 0);
    if (tSum > 0) {
      price = Math.round(tSum * 100) / 100;
      priceSource = "sum(journeytravelerpricing.customer_price)";
    }
  }

  if (!Number.isFinite(price) || price < 0) price = 0;

  const balance = Math.round((price - paid) * 100) / 100;
  const { travelers, flights } = await loadReservationEnrichment(id);

  return {
    reservation: row,
    balance: balance > 0 ? balance : 0,
    soft: true,
    warnings: [
      !(price > 0)
        ? "No customer price on reservation or journey lines — enter amount to charge."
        : null,
      price > 0 && !(balance > 0)
        ? `Quote $${price.toFixed(2)} is fully paid ($${paid.toFixed(2)}). Enter a new amount if charging more.`
        : null,
    ].filter(Boolean),
    quote: {
      customer_price: price,
      amount_paid: paid,
      balance: balance > 0 ? balance : 0,
      currency: "USD",
      priceSource: price > 0 ? priceSource : null,
      journeyLines,
      travelers,
      flights,
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
