/**
 * Flexible invoice draft builder.
 * - Pack every CRM detail we can find into memo + line items.
 * - Never hard-block: missing fields are listed so staff can fill them in.
 */

import { resolveCustomerEmail, formatStay, toIsoDate } from "./quote.js";
import {
  hotelInvoiceNumber,
  reservationInvoiceNumber,
  toUsdAmount,
  defaultIlsSpot,
} from "./mercury.js";

export function missingField(field, label, reason, required = true) {
  return { field, label, reason, required };
}

function parseOverrides(raw = {}) {
  const o = raw && typeof raw === "object" ? raw : {};
  const amountUsd =
    o.amountUsd != null && o.amountUsd !== ""
      ? Number(o.amountUsd)
      : o.amount_usd != null && o.amount_usd !== ""
        ? Number(o.amount_usd)
        : undefined;
  return {
    customerEmail:
      o.customerEmail != null
        ? String(o.customerEmail).trim()
        : o.customer_email != null
          ? String(o.customer_email).trim()
          : undefined,
    customerName:
      o.customerName != null
        ? String(o.customerName).trim()
        : o.customer_name != null
          ? String(o.customer_name).trim()
          : undefined,
    amountUsd:
      amountUsd !== undefined && Number.isFinite(amountUsd) ? amountUsd : undefined,
    lineItemName:
      o.lineItemName != null
        ? String(o.lineItemName)
        : o.line_item_name != null
          ? String(o.line_item_name)
          : undefined,
    payerMemo: o.payerMemo != null ? String(o.payerMemo) : o.payer_memo != null ? String(o.payer_memo) : undefined,
    invoiceNumber:
      o.invoiceNumber != null
        ? String(o.invoiceNumber).trim()
        : o.invoice_number != null
          ? String(o.invoice_number).trim()
          : undefined,
    offerId:
      o.offerId != null
        ? o.offerId
        : o.offer_id != null
          ? o.offer_id
          : undefined,
  };
}

/**
 * Build a full editable draft for a reservation (soft — no throw on zero price).
 */
export function buildReservationDraft(ctx, overridesIn = {}) {
  const overrides = parseOverrides(overridesIn);
  const { reservation, quote, warnings = [] } = ctx;
  const code = reservation.reservation_code || `ID${reservation.id}`;
  const ref = String(code).replace(/[^A-Za-z0-9_-]/g, "") || `id${reservation.id}`;

  const realEmail =
    overrides.customerEmail !== undefined
      ? overrides.customerEmail
      : reservation.customer_email;
  const resolved = resolveCustomerEmail(realEmail, `res${ref}`);
  const name =
    String(
      overrides.customerName !== undefined
        ? overrides.customerName
        : reservation.customer_name || ""
    ).trim() || "Customer";

  let amountUsd =
    overrides.amountUsd !== undefined ? Number(overrides.amountUsd) : NaN;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    amountUsd = Number(quote.balance) > 0 ? Number(quote.balance) : 0;
  }

  const journeys = quote.journeyLines || [];
  const travelers = quote.travelers || [];
  const flights = quote.flights || [];
  const pricedJourneys = journeys.filter((j) => Number(j.customer_price) > 0);

  // Rich line items: one per journey with price, unless staff overrode total
  let lineItems = [];
  if (overrides.amountUsd !== undefined && Number(overrides.amountUsd) > 0) {
    lineItems = [
      {
        name: String(
          overrides.lineItemName || `Reservation ${code} — payment`
        ).slice(0, 180),
        unitPrice: amountUsd,
        quantity: 1,
      },
    ];
  } else if (pricedJourneys.length) {
    lineItems = pricedJourneys.map((j) => ({
      name: String(j.label || j.line_type || "Service").slice(0, 180),
      unitPrice: Number(j.customer_price),
      quantity: 1,
    }));
    // If balance differs from sum (partial payment), scale or single line
    const lineSum = lineItems.reduce((s, li) => s + li.unitPrice, 0);
    if (amountUsd > 0 && Math.abs(lineSum - amountUsd) > 0.02) {
      lineItems = [
        {
          name: String(
            overrides.lineItemName ||
              `Reservation ${code} balance due (quote $${Number(quote.customer_price || 0).toFixed(2)}, paid $${Number(quote.amount_paid || 0).toFixed(2)})`
          ).slice(0, 180),
          unitPrice: amountUsd,
          quantity: 1,
        },
      ];
    }
  } else if (amountUsd > 0) {
    lineItems = [
      {
        name: String(
          overrides.lineItemName || `Reservation ${code} balance due`
        ).slice(0, 180),
        unitPrice: amountUsd,
        quantity: 1,
      },
    ];
  }

  // Customer-facing memo: reads like a booking confirmation, not a debug log.
  // Internal fields (CRM ids, price source, booking method) stay out of it.
  const usd = (n) =>
    Number(n || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const memoLines = [
    `Nesher / FlyNesher — trip services`,
    name && name !== "Customer" ? `For: ${name}` : null,
    `Booking reference: ${code}`,
  ].filter((l) => l !== null);

  if (journeys.length) {
    memoLines.push("", "Included in this payment:");
    for (const j of journeys.slice(0, 20)) {
      const priceBit =
        Number(j.customer_price) > 0 ? ` — $${usd(j.customer_price)}` : "";
      const conf = j.confirmation_number
        ? ` (conf ${j.confirmation_number})`
        : "";
      memoLines.push(`  - ${j.label || j.line_type || "Service"}${priceBit}${conf}`);
    }
  }
  if (travelers.length) {
    memoLines.push(
      "",
      `Travelers (${travelers.length}): ${travelers
        .map((t) => t.full_name || "Traveler")
        .join(", ")}`
    );
  }
  if (flights.length) {
    memoLines.push("", "Flights:");
    for (const f of flights.slice(0, 12)) {
      memoLines.push(
        `  ${f.airline || ""} ${f.flight_number || ""}  ${f.from_location || "?"} → ${f.to_location || "?"}  ${f.departure_date || ""} ${f.departure_time || ""}`
          .replace(/\s+$/, "")
      );
    }
  }
  if (Number(quote.amount_paid) > 0) {
    memoLines.push(
      "",
      `Trip total: $${usd(quote.customer_price)}`,
      `Paid to date: $${usd(quote.amount_paid)}`,
      `Balance due: $${usd(amountUsd)} USD`
    );
  }
  if (overrides.payerMemo) {
    memoLines.push("", `Note: ${overrides.payerMemo}`);
  }
  memoLines.push("", "Thank you for traveling with Nesher / FlyNesher.");

  const missing = [];
  if (!(amountUsd > 0)) {
    missing.push(
      missingField(
        "amountUsd",
        "Amount due (USD)",
        "No customer price on the reservation or ticket lines — enter the amount to charge."
      )
    );
  }
  if (resolved.placeholder) {
    missing.push(
      missingField(
        "customerEmail",
        "Customer email",
        "CRM has no email — a placeholder will be used unless you enter a real one. Prefer a real customer email.",
        false
      )
    );
  }
  if (
    !String(reservation.customer_name || "").trim() &&
    overrides.customerName === undefined
  ) {
    missing.push(
      missingField(
        "customerName",
        "Customer name",
        "No name on the customer record — optional but clearer on the invoice.",
        false
      )
    );
  }
  if (!pricedJourneys.length && !(Number(quote.customer_price) > 0)) {
    missing.push(
      missingField(
        "crmPrice",
        "CRM price on reservation/journeys",
        "Optional: set Customer Price in CRM for next time. You can still charge by entering Amount due now.",
        false
      )
    );
  }

  const invoiceNumber =
    overrides.invoiceNumber ||
    reservationInvoiceNumber(code) ||
    `RES-ID${reservation.id}`;

  const summary = [
    `RES ${code}`,
    amountUsd > 0 ? `due $${amountUsd.toFixed(2)}` : "amount TBD",
    name,
    resolved.email,
  ]
    .filter(Boolean)
    .join(" · ");

  const advice = [];
  if (missing.some((m) => m.required)) {
    advice.push(
      "Fill the required fields below, then create the payment link."
    );
  } else if (missing.length) {
    advice.push(
      "You can create the link now. Optional fields below improve the invoice for the customer."
    );
  } else {
    advice.push(
      "All key details found. Review the invoice preview, then create the payment link."
    );
  }
  for (const w of warnings) advice.push(w);

  // Service period from flight dates; internal CRM facts go to Mercury's
  // internalNote (org-visible, hidden from the payer).
  const flightDates = flights
    .map((f) => String(f.departure_date || ""))
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
    .sort();
  const internalNote = [
    `CRM reservation ${reservation.id}`,
    reservation.booking_method
      ? `booked via ${reservation.booking_method}`
      : null,
    quote.priceSource ? `price source: ${quote.priceSource}` : null,
    `quoted $${Number(quote.customer_price || amountUsd || 0).toFixed(2)} · paid $${Number(quote.amount_paid || 0).toFixed(2)} · due $${Number(amountUsd || 0).toFixed(2)}`,
    resolved.email ? `email: ${resolved.email}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 1000);

  return {
    kind: "reservation",
    canCreate: amountUsd > 0 && Boolean(resolved.email),
    needsInput: missing.some((m) => m.required),
    missing,
    advice,
    draft: {
      customerName: name,
      customerEmail: resolved.email,
      emailPlaceholder: resolved.placeholder,
      amountUsd,
      currency: "USD",
      invoiceNumber,
      lineItems,
      payerMemo: memoLines.join("\n").slice(0, 1800),
      lineItemName: lineItems[0]?.name || `Reservation ${code}`,
      poNumber: code || undefined,
      internalNote,
      servicePeriodStartDate: flightDates[0] || undefined,
      servicePeriodEndDate: flightDates[flightDates.length - 1] || undefined,
      summary,
      details: {
        reservationId: Number(reservation.id),
        reservationCode: code,
        bookingMethod: reservation.booking_method || null,
        phone: reservation.phone || null,
        customerPrice: Number(quote.customer_price) || 0,
        amountPaid: Number(quote.amount_paid) || 0,
        balance: amountUsd,
        priceSource: quote.priceSource || null,
        travelers,
        flights,
        journeyLines: journeys,
      },
    },
  };
}

export async function buildHotelDraft(ctx, overridesIn = {}) {
  const overrides = parseOverrides(overridesIn);
  const { request, offer, resolution, allOffers = [], ambiguous, payments } = ctx;
  const stay = formatStay(request.check_in, request.check_out);
  const resolved = resolveCustomerEmail(
    overrides.customerEmail !== undefined
      ? overrides.customerEmail
      : request.email,
    `jrm${request.id}o${offer?.id || "x"}`
  );
  const name =
    String(
      overrides.customerName !== undefined
        ? overrides.customerName
        : request.customer_name || ""
    ).trim() || "Customer";

  let amountUsd =
    overrides.amountUsd !== undefined ? Number(overrides.amountUsd) : NaN;
  let currency = offer?.currency || "USD";
  let customerPrice = Number(offer?.customer_price) || 0;
  const hotelPrice = Number(offer?.hotel_price) || 0;
  let usedHotelPrice = false;

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    if (customerPrice > 0) {
      try {
        amountUsd = await toUsdAmount(
          customerPrice,
          currency,
          defaultIlsSpot
        );
      } catch {
        amountUsd = 0;
      }
    } else if (hotelPrice > 0) {
      // No customer price set — pre-fill from the hotel's own price so staff
      // always has an amount to start from; they add markup in the field.
      try {
        amountUsd = await toUsdAmount(hotelPrice, currency, defaultIlsSpot);
        usedHotelPrice = true;
      } catch {
        amountUsd = 0;
      }
    } else {
      amountUsd = 0;
    }
  }

  // Deduct USD payments already recorded on this request (auto amounts only —
  // an explicit staff override is charged as typed).
  const paidUsd = Number(payments?.paidUsd || 0);
  const quotedUsd = amountUsd > 0 ? amountUsd : 0;
  let fullyPaid = false;
  if (overrides.amountUsd === undefined && amountUsd > 0 && paidUsd > 0) {
    amountUsd = Math.round((amountUsd - paidUsd) * 100) / 100;
    if (amountUsd <= 0) {
      amountUsd = 0;
      fullyPaid = true;
    }
  }

  const missing = [];
  if (!(amountUsd > 0)) {
    missing.push(
      missingField(
        "amountUsd",
        "Amount due (USD)",
        fullyPaid
          ? `Recorded payments ($${paidUsd.toFixed(2)}) already cover the quote ($${quotedUsd.toFixed(2)}) — enter an amount only if charging more.`
          : "No customer price on this offer — enter the USD amount to charge."
      )
    );
  }
  if (resolved.placeholder) {
    missing.push(
      missingField(
        "customerEmail",
        "Customer email",
        "No email on the hotel request — placeholder used unless you enter one.",
        false
      )
    );
  }
  if (!offer || !offer.id) {
    missing.push(
      missingField(
        "offerId",
        "Hotel offer",
        "No offer selected. Enter amount manually, or open the specific offer and click Pay on that quote.",
        false
      )
    );
  }
  if (ambiguous && allOffers.length > 1) {
    missing.push(
      missingField(
        "offerId",
        "Confirm which offer",
        `Multiple offers on this request — invoice uses offer #${offer?.id || "?"}. Prefer Pay on the exact quote row.`,
        false
      )
    );
  }

  const invoiceNumber =
    overrides.invoiceNumber ||
    (offer?.id
      ? hotelInvoiceNumber(request.id, offer.id)
      : `JRM-1${request.id}`);

  const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
  const guests = [
    request.adults != null ? plural(request.adults, "adult", "adults") : null,
    request.children != null
      ? plural(request.children, "child", "children")
      : null,
    request.rooms != null ? plural(request.rooms, "room", "rooms") : null,
  ]
    .filter(Boolean)
    .join(", ");

  const lineName = String(
    overrides.lineItemName ||
      [
        offer?.hotel_name || "Hotel booking",
        stay ? `(${stay})` : null,
        request.city ? `— ${request.city}` : null,
        name ? `— ${name}` : null,
      ]
        .filter(Boolean)
        .join(" ")
  ).slice(0, 180);

  // Customer-facing memo: reads like a booking confirmation, not a CRM dump.
  // Internal fields (request/offer ids, resolution path, answer status) stay out.
  const hotelLine = [offer?.hotel_name, offer?.room_type]
    .filter(Boolean)
    .join(" — ");
  const stayLine =
    stay ||
    [toIsoDate(request.check_in), toIsoDate(request.check_out)]
      .filter(Boolean)
      .join(" → ");
  const memoLines = [
    `JRM Hotels / Nesher — hotel booking`,
    name && name !== "Customer" ? `For: ${name}` : null,
    `Booking reference: ${invoiceNumber}`,
  ].filter((l) => l !== null);
  if (hotelLine || request.city) {
    memoLines.push(
      "",
      [hotelLine, request.city].filter(Boolean).join(", ")
    );
  }
  if (stayLine) memoLines.push(`Stay: ${stayLine}`);
  if (guests) memoLines.push(`Guests: ${guests}`);
  if (offer?.vat_status) {
    memoLines.push(
      /^vat\b/i.test(offer.vat_status)
        ? offer.vat_status
        : `VAT: ${offer.vat_status}`
    );
  }
  if (paidUsd > 0 && quotedUsd > 0 && overrides.amountUsd === undefined && !fullyPaid) {
    const usd2 = (n) =>
      Number(n || 0).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    memoLines.push(
      "",
      `Booking total: $${usd2(quotedUsd)}`,
      `Paid to date: $${usd2(paidUsd)}`,
      `Balance due: $${usd2(amountUsd)} USD`
    );
  }
  if (overrides.payerMemo) {
    memoLines.push("", `Note: ${overrides.payerMemo}`);
  }
  memoLines.push("", "Thank you for booking with JRM Hotels / Nesher.");

  const summary = [
    offer?.hotel_name || `Request #${request.id}`,
    stay,
    amountUsd > 0 ? `$${amountUsd.toFixed(2)}` : "amount TBD",
    name,
    resolved.email,
  ]
    .filter(Boolean)
    .join(" · ");

  const advice = [];
  if (missing.some((m) => m.required)) {
    advice.push(
      "Fill the required fields below, then create the payment link."
    );
  } else if (missing.length) {
    advice.push(
      "You can create the link now. Optional fields below improve the invoice."
    );
  } else {
    advice.push(
      "All key details found. Review the invoice preview, then create the payment link."
    );
  }

  if (usedHotelPrice && !fullyPaid) {
    advice.push(
      `Amount pre-filled from the hotel's own price (${hotelPrice} ${currency || "USD"}) — no JRM markup added. Adjust before creating if this quote should be higher.`
    );
  }
  if (paidUsd > 0 && !fullyPaid && overrides.amountUsd === undefined) {
    advice.push(
      `$${paidUsd.toFixed(2)} in recorded payments deducted — amount due is the remaining balance.`
    );
  }
  if (Number(payments?.otherCurrencyCount) > 0) {
    advice.push(
      `${payments.otherCurrencyCount} recorded payment(s) in another currency were NOT deducted — check the request's payment history.`
    );
  }

  const internalNote = [
    `CRM hotel request #${request.id}`,
    offer?.id ? `offer #${offer.id}` : null,
    resolution ? `resolved via ${resolution}` : null,
    customerPrice > 0 ? `quoted ${customerPrice} ${currency || "USD"}` : null,
    usedHotelPrice
      ? `amount from hotel_price ${hotelPrice} ${currency || "USD"} (no markup)`
      : null,
    paidUsd > 0 ? `payments recorded $${paidUsd.toFixed(2)} USD` : null,
    offer?.customer_answer_status
      ? `customer answer: ${offer.customer_answer_status}`
      : null,
    resolved.email ? `email: ${resolved.email}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 1000);

  return {
    kind: "hotel",
    canCreate: amountUsd > 0 && Boolean(resolved.email),
    needsInput: missing.some((m) => m.required),
    missing,
    advice,
    draft: {
      customerName: name,
      customerEmail: resolved.email,
      emailPlaceholder: resolved.placeholder,
      amountUsd,
      currency: "USD",
      sourceCurrency: currency,
      sourceAmount: customerPrice > 0 ? customerPrice : usedHotelPrice ? hotelPrice : 0,
      amountSource: usedHotelPrice ? "offer.hotel_price" : customerPrice > 0 ? "offer.customer_price" : null,
      internalNote,
      servicePeriodStartDate: toIsoDate(request.check_in) || undefined,
      servicePeriodEndDate: toIsoDate(request.check_out) || undefined,
      invoiceNumber,
      lineItems:
        amountUsd > 0
          ? [{ name: lineName, unitPrice: amountUsd, quantity: 1 }]
          : [],
      payerMemo: memoLines.join("\n").slice(0, 1800),
      lineItemName: lineName,
      summary,
      details: {
        requestId: request.id,
        offerId: offer?.id || null,
        hotelName: offer?.hotel_name || null,
        roomType: offer?.room_type || null,
        city: request.city || null,
        phone: request.phone || null,
        stay,
        checkIn: toIsoDate(request.check_in),
        checkOut: toIsoDate(request.check_out),
        adults: request.adults ?? null,
        children: request.children ?? null,
        rooms: request.rooms ?? null,
        vatStatus: offer?.vat_status || null,
        customerPrice: quotedUsd,
        amountPaid: overrides.amountUsd === undefined ? paidUsd : 0,
        balance: amountUsd,
        resolution: resolution || null,
        allOffers: (allOffers || []).map((o) => ({
          id: o.id,
          hotel_name: o.hotel_name,
          customer_price: o.customer_price,
          currency: o.currency,
        })),
      },
    },
  };
}

/**
 * Build Mercury create opts from a finished draft payload.
 */
export function mercuryOptsFromDraft(token, draftPayload) {
  const d = draftPayload.draft || draftPayload;
  return {
    token,
    customerName: d.customerName,
    customerEmail: d.customerEmail,
    invoiceNumber: d.invoiceNumber,
    amountUsd: d.amountUsd,
    lineItemName: d.lineItemName,
    lineItems: d.lineItems,
    payerMemo: d.payerMemo,
    poNumber: d.poNumber || undefined,
    internalNote: d.internalNote || undefined,
    servicePeriodStartDate: d.servicePeriodStartDate || undefined,
    servicePeriodEndDate: d.servicePeriodEndDate || undefined,
  };
}
