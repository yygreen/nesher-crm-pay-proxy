import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import httpProxy from "http-proxy";
import {
  createOrReusePaymentRequest,
  humanizePayError,
} from "./mercury.js";
import {
  createSquarePaymentLink,
  isSquareConfigured,
} from "./square.js";
import {
  buildCombinedPayUrl,
  renderInvoiceHtml,
  renderInvoiceErrorHtml,
} from "./invoice-page.js";
import { storeInvoice, loadInvoice } from "./invoice-store.js";
import { injectPayButtons, injectPaidBadges } from "./inject.js";
import { injectWhatsAppUi } from "./whatsapp-ui.js";
import {
  getPool,
  loadHotelPayContext,
  loadHotelOfferPayContext,
  loadReservationPayContext,
  appendHotelNote,
  appendReservationNote,
} from "./db.js";
import { syncPaidInvoices } from "./payments-sync.js";
import { validateStaffSession, extractSessionId } from "./auth.js";
import {
  buildReservationDraft,
  buildHotelDraft,
  mercuryOptsFromDraft,
} from "./draft.js";
import {
  waConfig,
  downloadWhatsAppMedia,
  getContact,
  listContactMessages,
  listInboxSummaries,
  markContactRead,
  sendContactAudio,
  sendContactMedia,
  sendContactTemplate,
  sessionUserId,
  stampAgentTag,
  listAgents,
  transcribeMessage,
  listApprovedTemplates,
  listTemplates,
  findContactByPhone,
  startChat,
  whatsappByCustomer,
} from "./whatsapp-media.js";
import {
  verifyWebhookChallenge,
  verifyWebhookSignature,
  processWhatsAppWebhook,
  webhookVerifyToken,
} from "./whatsapp-webhook.js";

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
  // Avoid header overflow / hop-by-hop junk on long sessions
  for (const h of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
  ]) {
    try {
      proxyReq.removeHeader(h);
    } catch {
      /* ignore */
    }
  }
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

/**
 * Flexible pay API:
 * - GET → always returns a draft (rich details + missing fields list). Never hard-fails on missing price/email.
 * - POST without enough data → same draft + needsInput (200), so UI can fill gaps.
 * - POST with amount (+ email always resolved) → create Mercury invoice with full memo.
 */
async function handlePayApi(req, res, kind, id, query) {
  if (req.method !== "POST" && req.method !== "GET") {
    sendJson(res, 405, { error: "GET (preview) or POST (create) only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;

  try {
    const token = process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN;

    let body = {};
    if (req.method === "POST") {
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
    }
    // Also accept query overrides on GET for previews
    const overrides = {
      ...body,
      offerId:
        body.offerId ||
        body.offer_id ||
        query.get("offerId") ||
        query.get("offer_id") ||
        undefined,
      amountUsd:
        body.amountUsd ?? body.amount_usd ?? query.get("amountUsd") ?? undefined,
      customerEmail:
        body.customerEmail ??
        body.customer_email ??
        query.get("customerEmail") ??
        undefined,
      customerName:
        body.customerName ??
        body.customer_name ??
        query.get("customerName") ??
        undefined,
      lineItemName: body.lineItemName ?? body.line_item_name,
      payerMemo: body.payerMemo ?? body.payer_memo,
      invoiceNumber: body.invoiceNumber ?? body.invoice_number,
      create: body.create === true || body.create === "1" || query.get("create") === "1",
    };

    let draftBundle;
    let ctx;

    if (kind === "hotel-offer") {
      ctx = await loadHotelOfferPayContext(id);
      ctx.resolution = "explicit_offer";
      draftBundle = await buildHotelDraft(ctx, overrides);
    } else if (kind === "hotel") {
      ctx = await loadHotelPayContext(id, overrides.offerId || null);
      draftBundle = await buildHotelDraft(ctx, overrides);
    } else if (kind === "reservation") {
      ctx = await loadReservationPayContext(id);
      draftBundle = buildReservationDraft(ctx, overrides);
    } else {
      sendJson(res, 404, { error: "Unknown kind" });
      return;
    }

    // GET always previews. POST with create:false previews. Otherwise try create (soft if incomplete).
    const wantsCreate =
      req.method === "POST" && body.create !== false && query.get("create") !== "0";

    if (req.method === "GET" || !wantsCreate) {
      sendJson(res, 200, {
        ok: true,
        preview: true,
        ...draftBundle,
        quote: {
          summary: draftBundle.draft.summary,
          amountUsd: draftBundle.draft.amountUsd,
          customerName: draftBundle.draft.customerName,
          customerEmail: draftBundle.draft.customerEmail,
          emailPlaceholder: draftBundle.draft.emailPlaceholder,
          invoiceNumber: draftBundle.draft.invoiceNumber,
          lineItem: draftBundle.draft.lineItemName,
          details: draftBundle.draft.details,
        },
        invoiceNumber: draftBundle.draft.invoiceNumber,
      });
      return;
    }

    if (!token) {
      sendJson(res, 200, {
        ok: false,
        needsInput: true,
        error: "MERCURY_TOKEN_NESHER not configured on Railway",
        ...draftBundle,
      });
      return;
    }

    // Soft: if cannot create yet, return draft + exact missing fields (HTTP 200, not 400)
    if (!draftBundle.canCreate) {
      sendJson(res, 200, {
        ok: false,
        needsInput: true,
        message:
          "Cannot create yet — fill the required fields below, then try again.",
        ...draftBundle,
      });
      return;
    }

    const result = await createOrReusePaymentRequest(
      mercuryOptsFromDraft(token, draftBundle)
    );

    // Card via Stripe (Mercury) when healthy. When Stripe is blocked, create a
    // Square checkout link so guests still have a card path.
    let cardProcessor =
      result.cardProcessor || (result.creditCardEnabled ? "stripe" : "none");
    let creditCardEnabled = Boolean(result.creditCardEnabled);
    let squarePayUrl = null;
    let squarePaymentLinkId = null;
    let squareError = null;
    let paymentMethodsLabel = result.paymentMethodsLabel;

    const needsCardBackup =
      !creditCardEnabled || result.cardFallback || cardProcessor === "none";

    if (needsCardBackup) {
      if (isSquareConfigured()) {
        try {
          const d = draftBundle.draft;
          const sq = await createSquarePaymentLink({
            amountUsd: d.amountUsd,
            invoiceNumber: d.invoiceNumber,
            lineName: d.lineItemName || d.summary || d.invoiceNumber,
            customerEmail: d.customerEmail,
            customerName: d.customerName,
            // Stable-ish key so double-clicks don't mint many links for same invoice+amount
            idempotencyKey: `crm-${d.invoiceNumber}-${Math.round(Number(d.amountUsd) * 100)}`,
          });
          if (sq.ok && sq.payUrl) {
            squarePayUrl = sq.payUrl;
            squarePaymentLinkId = sq.paymentLinkId || null;
            cardProcessor = "square";
            creditCardEnabled = true; // card available — via Square, not Mercury
            paymentMethodsLabel = "Bank transfer / ACH + card (Square)";
          } else {
            squareError = sq.error || "Square link not created";
            console.warn("square backup failed", squareError);
          }
        } catch (e) {
          squareError = e.message || String(e);
          console.warn("square backup threw", squareError);
        }
      } else {
        squareError =
          "Square access token not set on server (SQUARE_ACCESS_TOKEN_NESHER) — card backup offline";
      }
    }

    // One short guest invoice URL (bank + card on one clean page).
    const d = draftBundle.draft;
    let combinedPayUrl = null;
    try {
      const stored = await storeInvoice({
        amountUsd: d.amountUsd,
        invoiceNumber: d.invoiceNumber,
        customerName: d.customerName,
        summary: d.summary || d.lineItemName,
        lineName: d.lineItemName,
        mercuryUrl: result.payUrl,
        squareUrl: squarePayUrl || "",
        cardProcessor,
      });
      const origin = `https://${publicHostFor(req)}`;
      if (stored.ok && stored.code) {
        combinedPayUrl = buildCombinedPayUrl(origin, stored.code);
      } else if (stored.longToken) {
        combinedPayUrl = buildCombinedPayUrl(origin, stored.longToken);
      } else {
        combinedPayUrl = result.payUrl;
      }
    } catch (e) {
      console.warn("combined invoice failed", e.message);
      combinedPayUrl = result.payUrl;
    }

    const shareUrl = combinedPayUrl || result.payUrl;

    // CRM note
    try {
      const ph = d.emailPlaceholder ? " (placeholder email)" : "";
      const cardNote =
        cardProcessor === "stripe"
          ? " | card+ACH (Stripe/Mercury)"
          : cardProcessor === "square"
            ? " | one invoice: bank (Mercury) + card (Square)"
            : " | bank/ACH only (card offline)";
      const note = `[Automated Mercury] ${result.updated ? "Updated" : result.reused ? "Reused" : "Created"} invoice ${shareUrl} | mercury ${result.payUrl}${squarePayUrl ? ` | square ${squarePayUrl}` : ""} | ${d.summary} | ${d.invoiceNumber} | ${paymentMethodsLabel || "pay"}${cardNote}${ph}`;
      if (kind === "reservation") {
        await appendReservationNote(ctx.reservation.id, note);
      } else if (ctx.request?.id) {
        await appendHotelNote(ctx.request.id, note);
      }
    } catch (e) {
      console.warn("note append failed", e.message);
    }

    sendJson(res, 200, {
      ok: true,
      reused: result.reused,
      updated: Boolean(result.updated),
      // Guest-facing primary link = unified invoice page
      payUrl: shareUrl,
      combinedPayUrl: shareUrl,
      mercuryPayUrl: result.payUrl,
      squarePayUrl,
      squarePaymentLinkId,
      squareError: squareError || undefined,
      invoiceNumber: draftBundle.draft.invoiceNumber,
      amountUsd: draftBundle.draft.amountUsd,
      slug: result.invoice.slug,
      invoiceId: result.invoice.id,
      creditCardEnabled,
      cardProcessor,
      cardFallback: Boolean(result.cardFallback) || cardProcessor === "square",
      achDebitEnabled: result.achDebitEnabled !== false,
      paymentMethodsLabel,
      emailPlaceholder: draftBundle.draft.emailPlaceholder,
      missing: draftBundle.missing,
      advice: draftBundle.advice,
      draft: draftBundle.draft,
      quote: {
        summary: draftBundle.draft.summary,
        amountUsd: draftBundle.draft.amountUsd,
        customerName: draftBundle.draft.customerName,
        customerEmail: draftBundle.draft.customerEmail,
        emailPlaceholder: draftBundle.draft.emailPlaceholder,
        invoiceNumber: draftBundle.draft.invoiceNumber,
        lineItem: draftBundle.draft.lineItemName,
        details: draftBundle.draft.details,
      },
    });
  } catch (e) {
    console.error("pay api error", e);
    // Even on unexpected errors, try not to hard-block the UI — structured message
    // Never dump raw Stripe/Mercury stack traces into the modal.
    sendJson(res, 200, {
      ok: false,
      error: humanizePayError(e),
      needsInput: true,
      advice: [
        "Could not create the link this time. Confirm amount and email, then try again. Bank transfer does not need card processing.",
      ],
      missing: [],
    });
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
    // Cached blobs are durable — allow long browser cache. Fresh Meta pulls
    // still cache for a day so refresh storms don't re-download.
    const maxAge = file.cached ? 86400 * 30 : 86400;
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const wantName = url.searchParams.get("filename") || "";
    const safeName = String(wantName || "")
      .replace(/[^\w.\- ()[\]]+/g, "_")
      .slice(0, 180);
    const isDoc =
      /pdf|msword|officedocument|zip|csv|text\/plain/i.test(file.mimeType || "") ||
      /\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt)$/i.test(safeName);
    const headers = {
      "Content-Type": file.mimeType || "application/octet-stream",
      "Content-Length": String(file.buffer.length),
      "Cache-Control": `private, max-age=${maxAge}`,
      "X-WA-Media-Cache": file.cached ? "hit" : "miss",
      "X-Content-Type-Options": "nosniff",
    };
    if (safeName) {
      const disp = isDoc ? "attachment" : "inline";
      headers["Content-Disposition"] = `${disp}; filename="${safeName}"`;
    }
    res.writeHead(200, headers);
    res.end(file.buffer);
  } catch (e) {
    console.error("wa media", e.message);
    const status = e.expired ? 410 : 400;
    sendJson(res, status, {
      error: e.message || String(e),
      expired: Boolean(e.expired),
    });
  }
}

async function handleWaInbox(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;
  try {
    const chats = await listInboxSummaries();
    sendJson(res, 200, {
      ok: true,
      chats,
      whatsappConfigured: waConfig().configured,
    });
  } catch (e) {
    console.error("wa inbox", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

async function handleWaMessages(req, res, contactId, query) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "GET only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;
  try {
    const contact = await getContact(contactId);
    const lim = Number(query?.get("limit") || 80);
    const beforeRaw = query?.get("before_id") || query?.get("beforeId");
    const beforeId = beforeRaw ? Number(beforeRaw) : null;
    const pack = await listContactMessages(contactId, {
      limit: lim,
      beforeId: Number.isFinite(beforeId) ? beforeId : null,
    });
    const messages = Array.isArray(pack) ? pack : pack.messages || [];
    const meta = Array.isArray(pack) ? {} : pack.meta || {};
    if (query && query.get("read") === "1" && !beforeId) {
      markContactRead(contactId).catch((e) =>
        console.warn("mark read failed", e.message)
      );
    }
    sendJson(res, 200, {
      ok: true,
      contact: {
        id: Number(contact.id),
        phone: contact.phone_number,
        name: contact.display_name,
      },
      messages,
      meta,
      whatsappConfigured: waConfig().configured,
    });
  } catch (e) {
    console.error("wa messages", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

async function handleWaSendTemplate(req, res, contactId) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;
  try {
    const body = await readJson(req);
    const sentById = await sessionUserId(
      extractSessionId(String(req.headers.cookie || ""))
    );
    const out = await sendContactTemplate({
      contactId,
      templateName: String(body.templateName || body.template || ""),
      params: Array.isArray(body.params) ? body.params : [],
      sentById,
      agentTag: typeof body.agentTag === "string" ? body.agentTag : "",
    });
    sendJson(res, 200, out);
  } catch (e) {
    console.error("wa send-template", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

async function handleWaWebhook(req, res, url) {
  // Public Meta endpoint — no staff session.
  if (req.method === "GET") {
    const result = verifyWebhookChallenge(url.searchParams);
    if (!result.ok) {
      sendJson(res, result.status || 403, { error: result.error });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(result.challenge);
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "GET (verify) or POST (events) only" });
    return;
  }
  try {
    const rawBuf = await readBodyBuffer(req, 5 * 1024 * 1024);
    const sig = req.headers["x-hub-signature-256"] || req.headers["X-Hub-Signature-256"];
    const sigCheck = verifyWebhookSignature(rawBuf, sig);
    if (!sigCheck.ok) {
      console.warn("wa webhook signature", sigCheck.error);
      sendJson(res, 403, { error: sigCheck.error || "bad signature" });
      return;
    }
    let body = {};
    try {
      body = JSON.parse(rawBuf.toString("utf8") || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid JSON" });
      return;
    }
    // Respond 200 quickly; Meta retries on slow/non-200.
    const summary = await processWhatsAppWebhook(body);
    if (summary.errors.length) console.warn("wa webhook errors", summary.errors);
    else if (summary.statuses.updated || summary.messages.inserted) {
      console.log(
        "wa webhook",
        `status+${summary.statuses.updated}`,
        `msg+${summary.messages.inserted}`,
        `media warm queued`
      );
    }
    sendJson(res, 200, { ok: true, ...summary });
  } catch (e) {
    console.error("wa webhook", e.message);
    // Still 200 when possible so Meta doesn't storm — but parse failures already handled.
    sendJson(res, 200, { ok: false, error: e.message || String(e) });
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

    let agentTag = "";
    if (ct.includes("application/json")) {
      const j = JSON.parse(raw.toString("utf8") || "{}");
      if (!j.audioBase64) throw new Error("audioBase64 required");
      buffer = Buffer.from(j.audioBase64, "base64");
      mimeType = j.mimeType || "audio/webm";
      isVoice = j.voice !== false;
      agentTag = typeof j.agentTag === "string" ? j.agentTag : "";
    } else {
      buffer = raw;
      mimeType = ct.split(";")[0].trim() || "audio/webm";
    }
    if (!buffer.length) throw new Error("Empty audio");

    const sentById = await sessionUserId(
      extractSessionId(String(req.headers.cookie || ""))
    );
    const out = await sendContactAudio({
      contactId,
      buffer,
      mimeType,
      isVoice,
      sentById,
      agentTag,
    });
    sendJson(res, 200, out);
  } catch (e) {
    console.error("wa send-audio", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

async function handleWaSendMedia(req, res, contactId) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "POST only" });
    return;
  }
  if (!(await requireStaff(req, res))) return;
  try {
    // Base64 inflates ~33% — allow up to ~18 MB binary (Meta video max is 16 MB).
    const raw = await readBodyBuffer(req, 25 * 1024 * 1024);
    const j = JSON.parse(raw.toString("utf8") || "{}");
    const b64 = j.fileBase64 || j.mediaBase64 || j.audioBase64;
    if (!b64) throw new Error("fileBase64 required");
    const buffer = Buffer.from(b64, "base64");
    if (!buffer.length) throw new Error("Empty file");
    const sentById = await sessionUserId(
      extractSessionId(String(req.headers.cookie || ""))
    );
    const out = await sendContactMedia({
      contactId,
      buffer,
      mimeType: j.mimeType || "application/octet-stream",
      filename: typeof j.filename === "string" ? j.filename.slice(0, 240) : "file.bin",
      caption: typeof j.caption === "string" ? j.caption.slice(0, 1024) : "",
      sentById,
      agentTag: typeof j.agentTag === "string" ? j.agentTag : "",
    });
    sendJson(res, 200, out);
  } catch (e) {
    console.error("wa send-media", e.message);
    sendJson(res, 400, { error: e.message || String(e) });
  }
}

function proxyWithInject(req, res) {
  const pathOnly = (req.url || "/").split("?")[0];
  const shouldInject =
    /^\/jrm\/hotels(\/|$)/.test(pathOnly) ||
    /^\/reservations(\/|$)/.test(pathOnly) ||
    /^\/whatsapp(\/|$)/.test(pathOnly) ||
    /^\/customers\/\d+\/?$/.test(pathOnly);

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

      const body = Buffer.concat(chunks);
      const finish = (buf) => {
        headers["content-length"] = String(buf.length);
        res.writeHead(this.statusCode || 200, headers);
        res.end(buf);
      };
      // If upstream gzipped, we asked without accepting gzip ideally
      if (isHtml(headers) && this.statusCode === 200) {
        (async () => {
          try {
            const text = body.toString("utf8");
            let injected = injectPayButtons(text, pathOnly);
            injected = injectWhatsAppUi(injected, pathOnly);
            injected = await injectPaidBadges(injected, pathOnly, badgePool());
            finish(Buffer.from(injected, "utf8"));
          } catch (e) {
            console.error("inject failed", e.message);
            finish(body);
          }
        })();
        return;
      }
      finish(body);
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

  // ── Mercury AR relay for the JRM Concierge booking machine ────────────────
  // Vercel egress IPs rotate and cannot sit on the Mercury token's IP
  // whitelist; this Railway service's egress IP already does. Key-gated,
  // GET/POST only, AR paths ONLY (invoices/customers) — the money-moving API
  // surface is never reachable through here. The Mercury token stays on
  // Railway; the caller never holds it.
  const relayMatch = url.pathname.match(/^\/__mercury_relay\/(.+)$/);
  if (relayMatch) {
    const relayKey = process.env.MERCURY_RELAY_KEY || "";
    const given = String(req.headers["x-relay-key"] || "");
    const keyOk =
      relayKey.length >= 24 &&
      given.length === relayKey.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(relayKey));
    if (!keyOk) {
      sendJson(res, 403, { error: "relay key" });
      return;
    }
    const relPath = relayMatch[1];
    const pathOk = /^ar\/(invoices|customers)(\/[A-Za-z0-9-]+)?(\/cancel)?$/.test(relPath);
    if (!pathOk || !["GET", "POST"].includes(req.method || "")) {
      sendJson(res, 404, { error: "not relayed" });
      return;
    }
    let token = process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN || "";
    if (token && !token.startsWith("secret-token:") && token.startsWith("mercury_")) token = "secret-token:" + token;
    if (!token) {
      sendJson(res, 503, { error: "MERCURY_TOKEN_NESHER not configured" });
      return;
    }
    try {
      const bodyRaw = req.method === "POST" ? await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
      }) : null;
      // Same egress path the pay modal itself uses: MERCURY_API_BASE (the
      // whitelisted-IP relay tunnel) when set, the API directly otherwise.
      const mercuryBase = (process.env.MERCURY_API_BASE || "https://api.mercury.com").replace(/\/$/, "");
      const upstreamRes = await fetch(`${mercuryBase}/api/v1/${relPath}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: bodyRaw && bodyRaw.length ? bodyRaw : undefined,
      });
      const text = await upstreamRes.text();
      res.writeHead(upstreamRes.status, {
        "Content-Type": upstreamRes.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      });
      res.end(text);
    } catch (e) {
      sendJson(res, 502, { error: "relay upstream failed", detail: String(e.message || e).slice(0, 200) });
    }
    return;
  }

  // Public guest invoice — short code or long token (no staff auth)
  const payPageMatch =
    url.pathname.match(/^\/pay\/([^/]+)\/?$/) ||
    url.pathname.match(/^\/__nesher_pay\/i\/([^/]+)\/?$/);
  if (payPageMatch && (req.method || "GET") === "GET") {
    const verified = await loadInvoice(decodeURIComponent(payPageMatch[1]));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!verified.ok || !verified.data?.mercuryUrl) {
      res.writeHead(410);
      res.end(
        renderInvoiceErrorHtml(
          verified.error === "expired"
            ? "This payment link has expired. Please ask for a new one."
            : "This payment link is invalid. Please ask for a new one."
        )
      );
      return;
    }
    res.writeHead(200);
    res.end(renderInvoiceHtml(verified.data));
    return;
  }

  if (url.pathname === "/__nesher_pay/health") {
    // include square readiness (no secrets) so ops can see card-backup status
    const wa = waConfig();
    sendJson(res, 200, {
      ok: true,
      build: "2026-08-11-clean-invoice",
      upstream: UPSTREAM,
      paySync: lastPaySync
        ? {
            at: lastPaySync.at,
            checked: lastPaySync.checked,
            recorded: lastPaySync.recorded.length,
            skipped: lastPaySync.skipped.length,
            errors: lastPaySync.errors.length,
          }
        : null,
      hasMercury: Boolean(
        process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN
      ),
      hasSquare: isSquareConfigured(),
      squareAppIdSet: Boolean(
        process.env.SQUARE_APP_ID_NESHER || process.env.SQUARE_APPLICATION_ID
      ),
      squareLocationSet: Boolean(
        process.env.SQUARE_LOCATION_ID_NESHER || process.env.SQUARE_LOCATION_ID
      ),
      hasDb: Boolean(process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL),
      hasWhatsApp: wa.configured,
      hasMercuryRelay: (process.env.MERCURY_RELAY_KEY || "").length >= 24,
      whatsappWebhook: {
        path: "/__nesher_wa/webhook/",
        verifyTokenConfigured: Boolean(webhookVerifyToken()),
      },
    });
    return;
  }

  // ── Meta WhatsApp webhook (public — no staff session) ───────────────
  // Primary path + legacy Django path (Meta app dashboard may still list it).
  if (
    /^\/__nesher_wa\/webhook\/?$/.test(url.pathname) ||
    /^\/whatsapp\/webhook\/?$/.test(url.pathname)
  ) {
    await handleWaWebhook(req, res, url);
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
  if (/^\/__nesher_wa\/inbox\/?$/.test(url.pathname)) {
    await handleWaInbox(req, res);
    return;
  }
  const waMsgsMatch = url.pathname.match(
    /^\/__nesher_wa\/contact\/(\d+)\/messages\/?$/
  );
  if (waMsgsMatch) {
    await handleWaMessages(req, res, waMsgsMatch[1], url.searchParams);
    return;
  }
  const waSendAudioMatch = url.pathname.match(
    /^\/__nesher_wa\/contact\/(\d+)\/send-audio\/?$/
  );
  if (waSendAudioMatch) {
    await handleWaSendAudio(req, res, waSendAudioMatch[1]);
    return;
  }
  const waSendMediaMatch = url.pathname.match(
    /^\/__nesher_wa\/contact\/(\d+)\/send-media\/?$/
  );
  if (waSendMediaMatch) {
    await handleWaSendMedia(req, res, waSendMediaMatch[1]);
    return;
  }
  const waSendTplMatch = url.pathname.match(
    /^\/__nesher_wa\/contact\/(\d+)\/send-template\/?$/
  );
  if (waSendTplMatch) {
    await handleWaSendTemplate(req, res, waSendTplMatch[1]);
    return;
  }

  // Manual Mercury→CRM payment sync (the scheduler also runs this every 5 min)
  if (/^\/__nesher_pay\/sync-payments\/?$/.test(url.pathname)) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return;
    }
    if (!(await requireStaff(req, res))) return;
    try {
      const out = await runPaySync("manual");
      sendJson(res, 200, { ok: true, ...out });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (/^\/__nesher_wa\/agents\/?$/.test(url.pathname)) {
    if (!(await requireStaff(req, res))) return;
    try {
      sendJson(res, 200, { ok: true, agents: await listAgents() });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (/^\/__nesher_wa\/templates\/?$/.test(url.pathname)) {
    if (!(await requireStaff(req, res))) return;
    try {
      const all = await listTemplates();
      const templates = all.filter((t) => t.status === "APPROVED" && !t.sample);
      const pending = all.filter((t) => t.status === "PENDING" && !t.sample);
      sendJson(res, 200, {
        ok: true,
        templates,
        pending,
        // keep approved-only helper for older UI clients
        approved: await listApprovedTemplates(),
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (/^\/__nesher_wa\/find-contact\/?$/.test(url.pathname)) {
    if (!(await requireStaff(req, res))) return;
    try {
      const phone = url.searchParams.get("phone") || "";
      const hit = await findContactByPhone(phone);
      sendJson(res, 200, { ok: true, contact: hit });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  if (/^\/__nesher_wa\/new-chat\/?$/.test(url.pathname)) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return;
    }
    if (!(await requireStaff(req, res))) return;
    try {
      const body = await readJson(req);
      const sentById = await sessionUserId(
        extractSessionId(String(req.headers.cookie || ""))
      );
      const out = await startChat({
        phone: body.phone,
        name: typeof body.name === "string" ? body.name.slice(0, 80) : "",
        templateName: String(body.templateName || ""),
        params: Array.isArray(body.params) ? body.params : [],
        sentById,
        agentTag: typeof body.agentTag === "string" ? body.agentTag : "",
        openExistingOnly: Boolean(body.openExistingOnly),
      });
      sendJson(res, 200, { ok: true, ...out });
    } catch (e) {
      console.error("wa new-chat", e.message);
      sendJson(res, 400, { error: e.message || String(e) });
    }
    return;
  }
  const waByCustMatch = url.pathname.match(
    /^\/__nesher_wa\/by-customer\/(\d+)\/?$/
  );
  if (waByCustMatch) {
    if (!(await requireStaff(req, res))) return;
    try {
      const info = await whatsappByCustomer(waByCustMatch[1]);
      sendJson(res, 200, { ok: true, whatsapp: info });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return;
  }
  const waTranscribeMatch = url.pathname.match(
    /^\/__nesher_wa\/message\/(\d+)\/transcribe\/?$/
  );
  if (waTranscribeMatch) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return;
    }
    if (!(await requireStaff(req, res))) return;
    try {
      const out = await transcribeMessage(waTranscribeMatch[1]);
      sendJson(res, 200, { ok: true, text: out.text, cached: out.cached });
    } catch (e) {
      console.error("wa transcribe", e.message);
      sendJson(res, 400, { error: e.message || String(e) });
    }
    return;
  }

  // Text replies POST straight to Django through this proxy. When the UI
  // declares who is typing (X-Agent-Tag), stamp that name onto the row Django
  // is about to create — retries because the row lands during/after this
  // request. Fire-and-forget: stamping must never delay the reply itself.
  const replyMatch = url.pathname.match(/^\/whatsapp\/(\d+)\/reply\/?$/);
  if (replyMatch && req.method === "POST" && req.headers["x-agent-tag"]) {
    let tag = "";
    try {
      tag = decodeURIComponent(String(req.headers["x-agent-tag"]));
    } catch {
      tag = String(req.headers["x-agent-tag"]);
    }
    const contactId = replyMatch[1];
    (async () => {
      for (const delayMs of [1500, 3000, 6000]) {
        await new Promise((r) => setTimeout(r, delayMs));
        try {
          if (await stampAgentTag(contactId, tag)) return;
        } catch (e) {
          console.error("agent-tag stamp", e.message);
        }
      }
    })();
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

// ── Mercury → CRM payment sync: on boot, then every 5 minutes ──
let lastPaySync = null;
let paySyncBusy = false;

async function runPaySync(trigger) {
  if (paySyncBusy) return lastPaySync || { skippedRun: "busy" };
  paySyncBusy = true;
  try {
    const out = await syncPaidInvoices({
      token: process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN,
      pool: getPool(),
    });
    lastPaySync = out;
    if (out.recorded.length || out.errors.length) {
      console.log(
        `pay-sync (${trigger}): recorded=${JSON.stringify(out.recorded)} errors=${JSON.stringify(out.errors)}`
      );
    }
    return out;
  } catch (e) {
    console.error(`pay-sync (${trigger}) failed:`, e.message);
    lastPaySync = { at: new Date().toISOString(), checked: 0, recorded: [], skipped: [], errors: [e.message] };
    return lastPaySync;
  } finally {
    paySyncBusy = false;
  }
}

function badgePool() {
  return process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL
    ? getPool()
    : null;
}

if (
  (process.env.MERCURY_TOKEN_NESHER || process.env.MERCURY_TOKEN) &&
  (process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL)
) {
  setTimeout(() => runPaySync("boot"), 10 * 1000);
  setInterval(() => runPaySync("interval"), 60 * 1000);
} else {
  console.warn("pay-sync disabled: MERCURY_TOKEN or DATABASE_URL missing");
}
