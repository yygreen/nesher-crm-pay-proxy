/**
 * Meta WhatsApp Cloud API webhook for Nesher CRM.
 * - Status pipeline: sent / delivered / read / failed → core_whatsappmessage.status
 * - Inbound messages: idempotent upsert by whatsapp_message_id (safe if Django also writes)
 * - Proactive media cache: download+store media ids immediately on inbound
 *
 * Callback URL (Meta app → WhatsApp → Configuration):
 *   https://crm.flynesher.com/__nesher_wa/webhook/
 * Verify token: WHATSAPP_VERIFY_TOKEN (Railway env)
 * Optional: WHATSAPP_APP_SECRET for X-Hub-Signature-256 verification
 */

import crypto from "node:crypto";
import { getPool } from "./db.js";
import { downloadWhatsAppMedia, extractWaMedia } from "./whatsapp-media.js";

const STATUS_RANK = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  // failed is terminal and always applied when Meta says so
  failed: 99,
  error: 99,
  received: 1, // inbound baseline
};

export function webhookVerifyToken() {
  return (
    process.env.WHATSAPP_VERIFY_TOKEN ||
    process.env.WA_VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN_NESHER ||
    ""
  );
}

export function webhookAppSecret() {
  return process.env.WHATSAPP_APP_SECRET || process.env.WA_APP_SECRET || "";
}

/**
 * Meta hub.challenge verification (GET).
 * @returns {{ ok: true, challenge: string } | { ok: false, status: number, error: string }}
 */
export function verifyWebhookChallenge(query) {
  const mode = String(query.get("hub.mode") || query.get("hub_mode") || "");
  const token = String(query.get("hub.verify_token") || query.get("hub_verify_token") || "");
  const challenge = String(query.get("hub.challenge") || query.get("hub_challenge") || "");
  const expected = webhookVerifyToken();
  if (mode !== "subscribe") {
    return { ok: false, status: 400, error: "hub.mode must be subscribe" };
  }
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "WHATSAPP_VERIFY_TOKEN not configured on proxy",
    };
  }
  if (token !== expected) {
    return { ok: false, status: 403, error: "verify_token mismatch" };
  }
  if (!challenge) {
    return { ok: false, status: 400, error: "missing hub.challenge" };
  }
  return { ok: true, challenge };
}

/**
 * Optional HMAC check. If APP_SECRET unset, skip (log once).
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = webhookAppSecret();
  if (!secret) return { ok: true, skipped: true };
  const sig = String(signatureHeader || "");
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: "invalid X-Hub-Signature-256" };
    }
  } catch {
    return { ok: false, error: "invalid signature format" };
  }
  return { ok: true };
}

function mapMetaStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v === "read") return "read";
  if (v === "delivered") return "delivered";
  if (v === "sent") return "sent";
  if (v === "failed") return "failed";
  if (v === "deleted") return "failed";
  return v || "sent";
}

function shouldUpgradeStatus(current, next) {
  const c = String(current || "").toLowerCase();
  const n = String(next || "").toLowerCase();
  if (n === "failed" || n === "error") return true;
  if (c === "failed" || c === "error") return false; // don't un-fail
  return (STATUS_RANK[n] ?? 0) > (STATUS_RANK[c] ?? 0);
}

/**
 * Apply one Meta status object { id, status, timestamp, errors? }.
 */
export async function applyMessageStatus(st) {
  const wamid = String(st?.id || "").trim();
  if (!wamid) return { updated: false, reason: "no_id" };
  const next = mapMetaStatus(st.status);
  const p = getPool();
  const cur = await p.query(
    `SELECT id, status FROM core_whatsappmessage WHERE whatsapp_message_id = $1 LIMIT 1`,
    [wamid]
  );
  if (!cur.rows.length) return { updated: false, reason: "unknown_wamid", wamid, next };
  const row = cur.rows[0];
  if (!shouldUpgradeStatus(row.status, next)) {
    return { updated: false, reason: "no_upgrade", id: row.id, from: row.status, to: next };
  }
  let errMsg = "";
  if (next === "failed" && Array.isArray(st.errors) && st.errors[0]) {
    errMsg = JSON.stringify({ error: st.errors[0] }).slice(0, 2000);
  }
  await p.query(
    `UPDATE core_whatsappmessage
     SET status = $2,
         error_message = CASE WHEN $2 = 'failed' AND $3 <> '' THEN $3 ELSE error_message END
     WHERE id = $1`,
    [row.id, next, errMsg]
  );
  return { updated: true, id: Number(row.id), from: row.status, to: next, wamid };
}

async function findOrCreateContactByPhone(phone, profileName = "") {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) throw new Error("missing phone");
  const p = getPool();
  const existing = await p.query(
    `SELECT id FROM core_whatsappcontact
     WHERE regexp_replace(phone_number, '\\D', '', 'g') = $1
     LIMIT 1`,
    [digits]
  );
  const now = new Date();
  if (existing.rows.length) {
    const id = Number(existing.rows[0].id);
    if (profileName) {
      await p.query(
        `UPDATE core_whatsappcontact
         SET display_name = COALESCE(NULLIF(display_name, ''), $2),
             updated_at = $3
         WHERE id = $1`,
        [id, profileName, now]
      );
    }
    return id;
  }
  const ins = await p.query(
    `INSERT INTO core_whatsappcontact
      (phone_number, display_name, last_message_at, unread_count, is_archived, notes, created_at, updated_at, customer_id)
     VALUES ($1, $2, $3, 0, false, '', $3, $3, NULL)
     RETURNING id`,
    [digits, profileName || digits, now]
  );
  return Number(ins.rows[0].id);
}

function bodyPlaceholder(type, msg) {
  if (type === "text") return String(msg?.text?.body || "").slice(0, 8000);
  if (type === "image") return msg?.image?.caption || "[image message received]";
  if (type === "video") return msg?.video?.caption || "[video message received]";
  if (type === "document") {
    if (msg?.document?.caption) return String(msg.document.caption);
    if (msg?.document?.filename) return `[document] ${msg.document.filename}`;
    return "[document message received]";
  }
  if (type === "audio") return "[audio message received]";
  if (type === "sticker") return "[sticker message received]";
  if (type === "location") return "[location message received]";
  if (type === "contacts") return "[contacts message received]";
  if (type === "reaction") {
    const em = msg?.reaction?.emoji || "";
    return em ? `[reaction] ${em}` : "[reaction message received]";
  }
  if (type === "interactive") {
    const br = msg?.interactive?.button_reply || msg?.interactive?.list_reply;
    return br?.title || "[interactive message received]";
  }
  if (type === "button") return msg?.button?.text || "[button message received]";
  return `[${type || "unknown"} message received]`;
}

/**
 * Idempotent inbound message write + media warm-cache.
 */
export async function ingestInboundMessage(msg, contactsMeta = []) {
  const wamid = String(msg?.id || "").trim();
  if (!wamid) return { inserted: false, reason: "no_wamid" };
  const p = getPool();
  const exists = await p.query(
    `SELECT id FROM core_whatsappmessage WHERE whatsapp_message_id = $1 LIMIT 1`,
    [wamid]
  );
  const type = String(msg.type || "text").toLowerCase();
  const from = String(msg.from || "").replace(/\D/g, "");
  const profile =
    (Array.isArray(contactsMeta) &&
      contactsMeta.find((c) => String(c.wa_id || "").replace(/\D/g, "") === from)?.profile
        ?.name) ||
    "";
  const tsSec = Number(msg.timestamp);
  const messageAt = Number.isFinite(tsSec) && tsSec > 0 ? new Date(tsSec * 1000) : new Date();

  let contactId;
  let messageId;
  if (exists.rows.length) {
    messageId = Number(exists.rows[0].id);
    // still warm media below
  } else {
    contactId = await findOrCreateContactByPhone(from, profile);
    const body = bodyPlaceholder(type, msg);
    const raw = { ...msg }; // full Meta message object — same shape Django stores
    const ins = await p.query(
      `INSERT INTO core_whatsappmessage
        (direction, status, message_type, body, whatsapp_message_id, raw_payload,
         error_message, created_at, message_at, contact_id, customer_id, sent_by_id)
       VALUES
        ('inbound', 'received', $1, $2, $3, $4::jsonb, '', $5, $5, $6, NULL, NULL)
       RETURNING id`,
      [type || "text", body, wamid, JSON.stringify(raw), messageAt, contactId]
    );
    messageId = Number(ins.rows[0].id);
    await p.query(
      `UPDATE core_whatsappcontact
       SET last_message_at = $1,
           updated_at = $1,
           unread_count = COALESCE(unread_count, 0) + 1
       WHERE id = $2`,
      [messageAt, contactId]
    );
    // best-effort auto-link (inline SQL — avoid circular import of autoLinkContacts)
    await p
      .query(
        `UPDATE core_whatsappcontact wc
         SET customer_id = c.id, updated_at = now()
         FROM core_customer c
         WHERE wc.id = $1 AND wc.customer_id IS NULL
           AND length(regexp_replace(c.phone, '\\D', '', 'g')) >= 9
           AND right(regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g'), 9)
             = right(regexp_replace(wc.phone_number, '\\D', '', 'g'), 9)`,
        [contactId]
      )
      .catch(() => {});
  }

  // Proactive media cache (fire-and-forget caller should not await long)
  const media = extractWaMedia(msg, type);
  let mediaQueued = false;
  if (media?.mediaId) {
    mediaQueued = true;
    // download + cache; swallow errors (Meta may be slow)
    downloadWhatsAppMedia(media.mediaId)
      .then(() => {})
      .catch((e) => console.warn("wa webhook media cache", media.mediaId, e.message));
  }

  return {
    inserted: !exists.rows.length,
    messageId,
    contactId: contactId || null,
    wamid,
    mediaQueued,
    type,
  };
}

/**
 * Process a full Meta webhook body. Always returns a summary; never throws past parse.
 */
export async function processWhatsAppWebhook(body) {
  const summary = {
    statuses: { updated: 0, skipped: 0, details: [] },
    messages: { inserted: 0, existing: 0, details: [] },
    errors: [],
  };
  try {
    if (!body || body.object !== "whatsapp_business_account") {
      summary.errors.push("not a whatsapp_business_account payload");
      return summary;
    }
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];
        for (const st of value.statuses || []) {
          try {
            const r = await applyMessageStatus(st);
            if (r.updated) summary.statuses.updated++;
            else summary.statuses.skipped++;
            summary.statuses.details.push(r);
          } catch (e) {
            summary.errors.push(`status: ${e.message}`);
          }
        }
        for (const msg of value.messages || []) {
          try {
            const r = await ingestInboundMessage(msg, contacts);
            if (r.inserted) summary.messages.inserted++;
            else summary.messages.existing++;
            summary.messages.details.push(r);
          } catch (e) {
            summary.errors.push(`message: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    summary.errors.push(e.message || String(e));
  }
  return summary;
}
