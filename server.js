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
import {
  loadHotelPayContext,
  loadReservationPayContext,
  appendHotelNote,
  appendReservationNote,
} from "./db.js";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM =
  process.env.CRM_UPSTREAM ||
  "https://nesher-crm-production.up.railway.app";
// Django ALLOWED_HOSTS is locked to the public CRM hostname.
const PUBLIC_HOST = process.env.CRM_PUBLIC_HOST || "crm.flynesher.com";

const proxy = httpProxy.createProxyServer({
  target: UPSTREAM,
  changeOrigin: true,
  secure: true,
  xfwd: true,
  headers: {
    host: PUBLIC_HOST,
    "x-forwarded-host": PUBLIC_HOST,
    "x-forwarded-proto": "https",
  },
});

proxy.on("error", (err, req, res) => {
  console.error("proxy error", err.message);
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
  }
  res.end("Bad gateway to CRM upstream");
});

proxy.on("proxyReq", (proxyReq) => {
  proxyReq.setHeader("host", PUBLIC_HOST);
  proxyReq.setHeader("x-forwarded-host", PUBLIC_HOST);
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

/** Session cookie present ≈ staff browser session from CRM login. */
function hasSession(req) {
  const c = req.headers.cookie || "";
  return /sessionid=/.test(c);
}

async function handlePayApi(req, res, kind, id) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return;
  }
  if (!hasSession(req)) {
    sendJson(res, 401, { error: "Login required" });
    return;
  }
  try {
    const token = process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN;
    if (!token) throw new Error("MERCURY_TOKEN_NESHER not configured on Railway");

    if (kind === "hotel") {
      const { request, offer } = await loadHotelPayContext(id);
      const email = String(request.email || "").trim();
      if (!email) throw new Error("Hotel request has no customer email");
      const amountUsd = await toUsdAmount(
        offer.customer_price,
        offer.currency,
        defaultIlsSpot
      );
      const invoiceNumber = hotelInvoiceNumber(request.id, offer.id);
      const line = `${offer.hotel_name || "Hotel"} — ${request.customer_name || ""}`.trim();
      const result = await createOrReusePaymentRequest({
        token,
        customerName: request.customer_name || email,
        customerEmail: email,
        invoiceNumber,
        amountUsd,
        lineItemName: line.slice(0, 200),
        payerMemo: `JRM hotel request #${request.id} offer #${offer.id}`,
      });
      try {
        await appendHotelNote(
          request.id,
          `[Automated Mercury] ${result.reused ? "Reused" : "Created"} pay link ${result.payUrl} invoice ${invoiceNumber} amount $${amountUsd} (offer #${offer.id})`
        );
      } catch (e) {
        console.warn("note append failed", e.message);
      }
      sendJson(res, 200, {
        ok: true,
        reused: result.reused,
        payUrl: result.payUrl,
        invoiceNumber,
        amountUsd,
        slug: result.invoice.slug,
        invoiceId: result.invoice.id,
      });
      return;
    }

    if (kind === "reservation") {
      const { reservation, balance } = await loadReservationPayContext(id);
      const email = String(reservation.customer_email || "").trim();
      if (!email) {
        throw new Error(
          "Reservation customer has no email — set email on the customer record first"
        );
      }
      // Reservation prices in CRM are treated as USD (same as autopilot)
      const amountUsd = await toUsdAmount(balance, "USD", defaultIlsSpot);
      const invoiceNumber =
        reservationInvoiceNumber(reservation.reservation_code) ||
        `RES-ID${reservation.id}`;
      const result = await createOrReusePaymentRequest({
        token,
        customerName: reservation.customer_name || email,
        customerEmail: email,
        invoiceNumber,
        amountUsd,
        lineItemName: `Reservation ${reservation.reservation_code || reservation.id} balance`,
        payerMemo: `CRM reservation id ${reservation.id}`,
      });
      try {
        await appendReservationNote(
          reservation.id,
          `${result.reused ? "Reused" : "Created"} ${result.payUrl} (${invoiceNumber}) $${amountUsd}`
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
      });
      return;
    }

    sendJson(res, 404, { error: "Unknown kind" });
  } catch (e) {
    console.error("pay api error", e);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

function proxyWithInject(req, res) {
  const pathOnly = (req.url || "/").split("?")[0];
  const shouldInject =
    /^\/jrm\/hotels(\/|$)/.test(pathOnly) ||
    /^\/reservations(\/|$)/.test(pathOnly);

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
          const injected = injectPayButtons(text, pathOnly);
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
    sendJson(res, 200, {
      ok: true,
      upstream: UPSTREAM,
      hasMercury: Boolean(
        process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN
      ),
      hasDb: Boolean(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL),
    });
    return;
  }

  const payMatch = url.pathname.match(
    /^\/__nesher_pay\/(hotel|reservation)\/(\d+)\/?$/
  );
  if (payMatch) {
    await handlePayApi(req, res, payMatch[1], payMatch[2]);
    return;
  }

  proxyWithInject(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`nesher-crm-pay-proxy listening on ${PORT} → ${UPSTREAM}`);
});
