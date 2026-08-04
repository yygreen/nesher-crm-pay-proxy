import http from "node:http";
import { URL } from "node:url";
import httpProxy from "http-proxy";
import {
  createOrReusePaymentRequest,
  hotelInvoiceNumber,
  reservationInvoiceNumber,
  toUsdAmount,
  defaultIlsSpot,
} from "./mercury.js";
import { injectPayButtons } from "./inject.js";
import { injectWhatsAppUi } from "./whatsapp-ui.js";
import {
  loadHotelPayContext,
  loadHotelOfferPayContext,
  loadReservationPayContext,
  appendHotelNote,
  appendReservationNote,
} from "./db.js";
import { validateStaffSession } from "./auth.js";
import {
  buildHotelQuoteSnapshot,
  buildReservationQuoteSnapshot,
  resolveCustomerEmail,
} from "./quote.js";
import {
  waConfig,
  downloadWhatsAppMedia,
  getContact,
  listContactMessages,
  sendContactAudio,
} from "./whatsapp-media.js";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM =
  process.env.CRM_UPSTREAM ||
  "https://nesher-crm-production.up.railway.app";
// Default when request Host is the railway internal hostname.
const PUBLIC_HOST = process.env.CRM_PUBLIC_HOST || "crm.flynesher.com";
const ALLOWED_PUBLIC_HOSTS = new Set(
  String(process.env.CRM_ALLOWED_HOSTS || "crm.flynesher.com,www.flynesher.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

/** Prefer the browser Host (crm or www) so Django ALLOWED_HOSTS + cookies work. */
function publicHostFor(req) {
  const raw = String(req?.headers?.host || "")
    .split(":")[0]
    .toLowerCase();
  if (raw && ALLOWED_PUBLIC_HOSTS.has(raw)) return raw;
  return PUBLIC_HOST;
}

const proxy = httpProxy.createProxyServer({
  target: UPSTREAM,
  changeOrigin: true,
  secure: true,
  xfwd: true,
});

proxy.on("error", (err, req, res) => {
  console.error("proxy error", err.message);
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
  }
  res.end("Bad gateway to CRM upstream");
});

proxy.on("proxyReq", (proxyReq, req) => {
  const host = publicHostFor(req);
  proxyReq.setHeader("host", host);
  proxyReq.setHeader("x-forwarded-host", host);
  proxyReq.setHeader("x-forwarded-proto", "https");
});

function isHtml(headers) {
  const ct = String(headers["content-type"] || headers["Content-Type"] || "");
  return ct.includes("text/html");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function requireStaff(req, res) {
  const auth = await validateStaffSession({
    cookieHeader: req.headers.cookie || "",
    upstream: UPSTREAM,
    publicHost: publicHostFor(req),
  });
  if (!auth.ok) {
    sendJson(res, 401, {
      error: "Login required",
      reason: auth.reason || "unauthorized",
    });
    return false;
  }
  return true;
}

async function createHotelPayment(token, ctx) {
  const { request, offer } = ctx;
  const resolved = resolveCustomerEmail(
    request.email,
    `jrm${request.id}o${offer.id}`
  );
  // Use resolved email in snapshot path
  const requestForQuote = { ...request, email: resolved.email };
  const amountUsd = await toUsdAmount(
    offer.customer_price,
    offer.currency,
    defaultIlsSpot
  );
  const quote = buildHotelQuoteSnapshot(
    { ...ctx, request: requestForQuote },
    amountUsd
  );
  quote.emailPlaceholder = resolved.placeholder;
  const invoiceNumber = hotelInvoiceNumber(request.id, offer.id);
  const result = await createOrReusePaymentRequest({
    token,
    customerName: quote.customerName || resolved.email,
    customerEmail: resolved.email,
    invoiceNumber,
    amountUsd,
    lineItemName: quote.lineItem,
    payerMemo: `Exact CRM quote: req #${request.id} offer #${offer.id} | ${quote.summary}`,
  });
  try {
    const ph = resolved.placeholder ? " (placeholder email)" : "";
    await appendHotelNote(
      request.id,
      `[Automated Mercury] ${result.reused ? "Reused" : "Created"} pay link ${result.payUrl} | ${quote.summary} | invoice ${invoiceNumber}${ph}`
    );
  } catch (e) {
    console.warn("note append failed", e.message);
  }
  return {
    ok: true,
    reused: result.reused,
    payUrl: result.payUrl,
    invoiceNumber,
    amountUsd,
    slug: result.invoice.slug,
    invoiceId: result.invoice.id,
    quote,
    emailPlaceholder: resolved.placeholder,
  };
}

async function handlePayApi(req, res, kind, id, query) {
  if (req.method !== "POST" && req.method !== "GET") {
    sendJson(res, 405, { error: "GET (preview) or POST (create) only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;

  try {
    const token = process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN;
    if (!token && req.method === "POST") {
      throw new Error("MERCURY_TOKEN_NESHER not configured on Railway");
    }

    // Body may include offerId for hotel request-level calls
    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
    }

    if (kind === "hotel-offer") {
      const ctx = await loadHotelOfferPayContext(id);
      ctx.resolution = "explicit_offer";
      if (req.method === "GET") {
        const amountUsd = await toUsdAmount(
          ctx.offer.customer_price,
          ctx.offer.currency,
          defaultIlsSpot
        );
        sendJson(res, 200, {
          ok: true,
          preview: true,
          quote: buildHotelQuoteSnapshot(ctx, amountUsd),
          invoiceNumber: hotelInvoiceNumber(ctx.request.id, ctx.offer.id),
        });
        return;
      }
      const out = await createHotelPayment(token, ctx);
      sendJson(res, 200, out);
      return;
    }

    if (kind === "hotel") {
      const offerId =
        body.offerId || body.offer_id || query.get("offerId") || query.get("offer_id");
      let ctx;
      try {
        ctx = await loadHotelPayContext(id, offerId || null);
      } catch (e) {
        if (e.code === "AMBIGUOUS_OFFERS") {
          sendJson(res, 409, {
            error: e.message,
            code: "AMBIGUOUS_OFFERS",
            offers: e.offers,
          });
          return;
        }
        throw e;
      }
      if (req.method === "GET") {
        const amountUsd = await toUsdAmount(
          ctx.offer.customer_price,
          ctx.offer.currency,
          defaultIlsSpot
        );
        sendJson(res, 200, {
          ok: true,
          preview: true,
          quote: buildHotelQuoteSnapshot(ctx, amountUsd),
          invoiceNumber: hotelInvoiceNumber(ctx.request.id, ctx.offer.id),
          resolution: ctx.resolution,
        });
        return;
      }
      const out = await createHotelPayment(token, ctx);
      sendJson(res, 200, out);
      return;
    }

    if (kind === "reservation") {
      const ctx = await loadReservationPayContext(id);
      const ref =
        ctx.reservation.reservation_code || `resid${ctx.reservation.id}`;
      const resolved = resolveCustomerEmail(
        ctx.reservation.customer_email,
        `res${ref}`
      );
      // Inject resolved email so quote/summary include it
      const reservationForQuote = {
        ...ctx.reservation,
        customer_email: resolved.email,
      };
      const amountUsd = await toUsdAmount(ctx.balance, "USD", defaultIlsSpot);
      const quote = buildReservationQuoteSnapshot(
        { ...ctx, reservation: reservationForQuote },
        amountUsd
      );
      quote.emailPlaceholder = resolved.placeholder;
      const invoiceNumber =
        reservationInvoiceNumber(ctx.reservation.reservation_code) ||
        `RES-ID${ctx.reservation.id}`;
      if (req.method === "GET") {
        sendJson(res, 200, {
          ok: true,
          preview: true,
          quote,
          invoiceNumber,
          emailPlaceholder: resolved.placeholder,
        });
        return;
      }
      const result = await createOrReusePaymentRequest({
        token,
        customerName: quote.customerName || resolved.email,
        customerEmail: resolved.email,
        invoiceNumber,
        amountUsd,
        lineItemName: quote.lineItem,
        payerMemo: `Exact CRM reservation quote: id ${ctx.reservation.id} | ${quote.summary}`,
      });
      try {
        const ph = resolved.placeholder
          ? ` | email placeholder ${resolved.email}`
          : "";
        await appendReservationNote(
          ctx.reservation.id,
          `${result.reused ? "Reused" : "Created"} ${result.payUrl} | ${quote.summary} | ${invoiceNumber}${ph}`
        );
      } catch (e) {
        console.warn("res note failed", e.message);
      }
      sendJson(res, 200, {
        ok: true,
        reused: result.reused,
        payUrl: result.payUrl,
        invoiceNumber,
        amountUsd,
        slug: result.invoice.slug,
        invoiceId: result.invoice.id,
        quote,
        emailPlaceholder: resolved.placeholder,
      });
      return;
    }

    sendJson(res, 404, { error: "Unknown kind" });
  } catch (e) {
    console.error("pay api error", e);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

function readBodyBuffer(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large (max 12MB)"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleWaMedia(req, res, mediaId) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;
  try {
    const file = await downloadWhatsAppMedia(mediaId);
    res.writeHead(200, {
      "Content-Type": file.mimeType || "audio/ogg",
      "Content-Length": String(file.buffer.length),
      "Cache-Control": "private, max-age=300",
    });
    res.end(file.buffer);
  } catch (e) {
    console.error("wa media", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

async function handleWaMessages(req, res, contactId) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;
  try {
    const contact = await getContact(contactId);
    const messages = await listContactMessages(contactId);
    sendJson(res, 200, {
      ok: true,
      contact: {
        id: Number(contact.id),
        phone: contact.phone_number,
        name: contact.display_name,
      },
      messages,
      whatsappConfigured: waConfig().configured,
    });
  } catch (e) {
    console.error("wa messages", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

async function handleWaSendAudio(req, res, contactId) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;
  try {
    const raw = await readBodyBuffer(req);
    const ct = String(req.headers["content-type"] || "");
    let buffer;
    let mimeType = "audio/webm";
    let isVoice = true;

    if (ct.includes("application/json")) {
      const j = JSON.parse(raw.toString("utf8") || "{}");
      if (!j.audioBase64) throw new Error("audioBase64 required");
      buffer = Buffer.from(j.audioBase64, "base64");
      mimeType = j.mimeType || "audio/webm";
      isVoice = j.voice !== false;
    } else {
      buffer = raw;
      mimeType = ct.split(";")[0].trim() || "audio/webm";
    }
    if (!buffer.length) throw new Error("Empty audio");

    const out = await sendContactAudio({
      contactId,
      buffer,
      mimeType,
      isVoice,
    });
    sendJson(res, 200, out);
  } catch (e) {
    console.error("wa send-audio", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

function proxyWithInject(req, res) {
  const pathOnly = (req.url || "/").split("?")[0];
  const shouldInject =
    /^\/jrm\/hotels(\/|$)/.test(pathOnly) ||
    /^\/reservations(\/|$)/.test(pathOnly) ||
    /^\/whatsapp(\/|$)/.test(pathOnly);

  if (!shouldInject || req.method !== "GET") {
    proxy.web(req, res);
    return;
  }

  // Buffer HTML response and inject buttons
  const chunks = [];
  const fakeRes = {
    statusCode: 200,
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          this.headers[k.toLowerCase()] = v;
        }
      }
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    removeHeader(k) {
      delete this.headers[k.toLowerCase()];
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      let headers = { ...this.headers };
      // drop length/encoding so we can rewrite body
      delete headers["content-length"];
      delete headers["content-encoding"];
      delete headers["transfer-encoding"];

      let body = Buffer.concat(chunks);
      // If upstream gzipped, we asked without accepting gzip ideally
      if (isHtml(headers) && this.statusCode === 200) {
        try {
          const text = body.toString("utf8");
          let injected = injectPayButtons(text, pathOnly);
          injected = injectWhatsAppUi(injected, pathOnly);
          body = Buffer.from(injected, "utf8");
        } catch (e) {
          console.error("inject failed", e.message);
        }
      }
      headers["content-length"] = String(body.length);
      res.writeHead(this.statusCode || 200, headers);
      res.end(body);
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
    pipe() {
      return this;
    },
  };

  // Avoid compressed responses we can't easily rewrite
  req.headers["accept-encoding"] = "identity";
  proxy.web(req, fakeRes);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/__nesher_pay/health") {
    const wa = waConfig();
    sendJson(res, 200, {
      ok: true,
      upstream: UPSTREAM,
      hasMercury: Boolean(
        process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN
      ),
      hasDb: Boolean(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL),
      hasWhatsApp: wa.configured,
    });
    return;
  }

  // ── WhatsApp audio / media API (staff session required) ─────────────
  const waMediaMatch = url.pathname.match(
    /^\/__nesher_wa\/media\/(\d+)\/?$/
  );
  if (waMediaMatch) {
    await handleWaMedia(req, res, waMediaMatch[1]);
    return;
  }
  const waMsgsMatch = url.pathname.match(
    /^\/__nesher_wa\/contact\/(\d+)\/messages\/?$/
  );
  if (waMsgsMatch) {
    await handleWaMessages(req, res, waMsgsMatch[1]);
    return;
  }
  const waSendAudioMatch = url.pathname.match(
    /^\/__nesher_wa\/contact\/(\d+)\/send-audio\/?$/
  );
  if (waSendAudioMatch) {
    await handleWaSendAudio(req, res, waSendAudioMatch[1]);
    return;
  }

  const payMatch = url.pathname.match(
    /^\/__nesher_pay\/(hotel-offer|hotel|reservation)\/(\d+)\/?$/
  );
  if (payMatch) {
    await handlePayApi(req, res, payMatch[1], payMatch[2], url.searchParams);
    return;
  }

  proxyWithInject(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`nesher-crm-pay-proxy listening on ${PORT} → ${UPSTREAM}`);
});
