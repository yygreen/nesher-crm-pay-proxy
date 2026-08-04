/**
 * Build a clear quote snapshot for UI + invoice memo (exact CRM quote → Mercury).
 */

function toIsoDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  // already ISO-ish
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.slice(0, 10);
}

export function formatStay(checkIn, checkOut) {
  const a = toIsoDate(checkIn);
  const b = toIsoDate(checkOut);
  if (a && b) return `${a} → ${b}`;
  if (a) return a;
  return null;
}

/**
 * @param {object} ctx  { request, offer, resolution?, amountUsd }
 */
export function buildHotelQuoteSnapshot(ctx, amountUsd) {
  const { request, offer, resolution } = ctx;
  const email = String(request.email || "").trim();
  const stay = formatStay(request.check_in, request.check_out);
  return {
    kind: "hotel_offer",
    requestId: request.id,
    offerId: offer.id,
    resolution: resolution || "explicit_offer",
    customerName: request.customer_name || email || null,
    customerEmail: email || null,
    phone: request.phone || null,
    hotelName: offer.hotel_name || null,
    roomType: offer.room_type || null,
    city: request.city || null,
    stay,
    customerPrice: Number(offer.customer_price),
    currency: offer.currency || null,
    vatStatus: offer.vat_status || null,
    amountUsd: Number(amountUsd),
    sentToCustomer: Boolean(offer.sent_to_customer),
    customerAnswer: offer.customer_answer_status || null,
    lineItem: [
      offer.hotel_name || "Hotel",
      stay ? `(${stay})` : null,
      request.customer_name ? `— ${request.customer_name}` : null,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200),
    summary: [
      `Offer #${offer.id}`,
      offer.hotel_name || "Hotel",
      `${offer.customer_price} ${offer.currency || ""}`.trim(),
      `→ $${Number(amountUsd).toFixed(2)} USD`,
      email ? email : null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function buildReservationQuoteSnapshot(ctx, amountUsd) {
  const { reservation, balance, quote } = ctx;
  const email = String(reservation.customer_email || "").trim();
  return {
    kind: "reservation_balance",
    reservationId: Number(reservation.id),
    reservationCode: reservation.reservation_code || null,
    customerName: reservation.customer_name || email || null,
    customerEmail: email || null,
    phone: reservation.phone || null,
    customerPrice: Number(quote.customer_price),
    amountPaid: Number(quote.amount_paid),
    balance: Number(balance),
    currency: "USD",
    amountUsd: Number(amountUsd),
    lineItem: `Reservation ${reservation.reservation_code || reservation.id} balance due`,
    summary: [
      `RES ${reservation.reservation_code || reservation.id}`,
      `quote $${Number(quote.customer_price).toFixed(2)}`,
      `paid $${Number(quote.amount_paid).toFixed(2)}`,
      `due $${Number(balance).toFixed(2)}`,
      email || null,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
