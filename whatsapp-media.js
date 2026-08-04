/**
 * WhatsApp Cloud API media helpers for the Nesher CRM pay-proxy.
 * Download inbound voice notes, upload+send outbound audio, mirror into CRM tables.
 */

import { spawn } from "node:child_process";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPool } from "./db.js";

const GRAPH = process.env.WA_GRAPH_VERSION
  ? `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION}`
  : "https://graph.facebook.com/v25.0";

export function waConfig() {
  const token =
    process.env.WHATSAPP_ACCESS_TOKEN ||
    process.env.WA_ACCESS_TOKEN ||
    "";
  const phoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID ||
    process.env.WA_PHONE_NUMBER_ID ||
    "";
  return { token, phoneNumberId, configured: Boolean(token && phoneNumberId) };
}

/**
 * Resolve Meta media metadata + binary.
 * @param {string} mediaId
 */
export async function downloadWhatsAppMedia(mediaId) {
  const { token } = waConfig();
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN not configured on proxy");
  const id = String(mediaId || "").replace(/[^\d]/g, "");
  if (!id) throw new Error("Invalid media id");

  const metaRes = await fetch(`${GRAPH}/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) {
    throw new Error(meta?.error?.message || `Meta media meta HTTP ${metaRes.status}`);
  }
  if (!meta.url) throw new Error("Meta media has no download URL");

  const binRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!binRes.ok) throw new Error(`Meta media download HTTP ${binRes.status}`);
  const buf = Buffer.from(await binRes.arrayBuffer());
  return {
    buffer: buf,
    mimeType: meta.mime_type || binRes.headers.get("content-type") || "audio/ogg",
    fileSize: meta.file_size || buf.length,
    id: meta.id || id,
  };
}

/**
 * Convert browser WebM/other to OGG Opus via ffmpeg (required for WA voice notes).
 * @param {Buffer} input
 * @param {string} inputExt e.g. .webm .ogg .mp3
 */
export async function toOggOpus(input, inputExt = ".webm") {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-audio-"));
  const inPath = path.join(dir, `in${inputExt.startsWith(".") ? inputExt : `.${inputExt}`}`);
  const outPath = path.join(dir, "out.ogg");
  await writeFile(inPath, input);

  await new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        inPath,
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-ac",
        "1",
        "-ar",
        "16000",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let err = "";
    ff.stderr.on("data", (d) => {
      err += d.toString();
    });
    ff.on("error", (e) => reject(new Error(`ffmpeg missing: ${e.message}`)));
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`));
    });
  });

  const out = await readFile(outPath);
  await Promise.all([unlink(inPath).catch(() => {}), unlink(outPath).catch(() => {})]);
  return out;
}

/**
 * Upload media to WhatsApp Cloud API. Returns media id.
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} filename
 */
export async function uploadWhatsAppMedia(buffer, mimeType, filename = "voice.ogg") {
  const { token, phoneNumberId } = waConfig();
  if (!token || !phoneNumberId) throw new Error("WhatsApp not configured on proxy");

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    filename
  );

  const res = await fetch(`${GRAPH}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error(data?.error?.message || `Media upload HTTP ${res.status}`);
  }
  return String(data.id);
}

/**
 * Send an audio message (voice note when isVoice).
 */
export async function sendWhatsAppAudio({ to, mediaId, isVoice = true }) {
  const { token, phoneNumberId } = waConfig();
  if (!token || !phoneNumberId) throw new Error("WhatsApp not configured on proxy");
  const phone = String(to || "").replace(/\D/g, "");
  if (!phone) throw new Error("Missing recipient phone");

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type: "audio",
    audio: {
      id: mediaId,
      ...(isVoice ? { voice: true } : {}),
    },
  };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Send audio HTTP ${res.status}`);
  }
  const wamid = data?.messages?.[0]?.id || "";
  return { wamid, data };
}

/**
 * Load contact by id.
 */
export async function getContact(contactId) {
  const p = getPool();
  const id = Number(contactId);
  if (!Number.isFinite(id)) throw new Error("Invalid contact id");
  const r = await p.query(
    `SELECT id, phone_number, display_name, last_message_at, unread_count, customer_id
     FROM core_whatsappcontact WHERE id = $1`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Contact ${id} not found`);
  return r.rows[0];
}

/**
 * One-query inbox: every contact with its last message + linked customer name.
 */
export async function listInboxSummaries() {
  const p = getPool();
  const r = await p.query(
    `SELECT c.id, c.phone_number, c.display_name, c.unread_count,
            c.is_archived, c.customer_id, cust.full_name AS customer_name,
            m.direction AS lm_direction, m.status AS lm_status,
            m.message_type AS lm_type, m.body AS lm_body,
            m.message_at AS lm_at, m.raw_payload AS lm_raw
     FROM core_whatsappcontact c
     LEFT JOIN core_customer cust ON cust.id = c.customer_id
     LEFT JOIN LATERAL (
       SELECT direction, status, message_type, body, message_at, raw_payload
       FROM core_whatsappmessage
       WHERE contact_id = c.id
       ORDER BY message_at DESC, id DESC
       LIMIT 1
     ) m ON TRUE
     ORDER BY COALESCE(m.message_at, c.last_message_at, c.created_at) DESC NULLS LAST`
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    phone: row.phone_number,
    name: row.display_name,
    unread: Number(row.unread_count) || 0,
    archived: Boolean(row.is_archived),
    customerId: row.customer_id ? Number(row.customer_id) : null,
    customerName: row.customer_name || null,
    lastMessage: row.lm_at
      ? {
          direction: row.lm_direction,
          status: row.lm_status,
          messageType: row.lm_type,
          body: row.lm_body,
          messageAt: row.lm_at,
          voice: Boolean(row.lm_raw?.audio?.voice),
        }
      : null,
  }));
}

/**
 * Zero the unread counter (the operator is looking at the open chat).
 */
export async function markContactRead(contactId) {
  const p = getPool();
  const id = Number(contactId);
  if (!Number.isFinite(id)) return;
  await p.query(
    `UPDATE core_whatsappcontact SET unread_count = 0 WHERE id = $1 AND unread_count <> 0`,
    [id]
  );
}

/**
 * List messages for a contact (newest last for chat UI).
 */
export async function listContactMessages(contactId, limit = 100) {
  const p = getPool();
  const id = Number(contactId);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 300);
  const r = await p.query(
    `SELECT id, direction, status, message_type, body, whatsapp_message_id,
            raw_payload, error_message, message_at, created_at, sent_by_id
     FROM core_whatsappmessage
     WHERE contact_id = $1
     ORDER BY message_at ASC, id ASC
     LIMIT $2`,
    [id, lim]
  );
  return r.rows.map((row) => {
    const raw = row.raw_payload || {};
    const audio = raw.audio || {};
    return {
      id: Number(row.id),
      direction: row.direction,
      status: row.status,
      messageType: row.message_type,
      body: row.body,
      wamid: row.whatsapp_message_id,
      messageAt: row.message_at,
      error: row.error_message || "",
      mediaId: audio.id || null,
      voice: Boolean(audio.voice),
      mimeType: audio.mime_type || null,
    };
  });
}

/**
 * Persist outbound audio row + bump contact last_message_at.
 */
export async function recordOutboundAudio({
  contactId,
  wamid,
  mediaId,
  mimeType,
  isVoice,
}) {
  const p = getPool();
  const now = new Date();
  const raw = {
    type: "audio",
    audio: {
      id: mediaId,
      voice: Boolean(isVoice),
      mime_type: mimeType || "audio/ogg",
    },
    direction: "outbound",
  };
  const ins = await p.query(
    `INSERT INTO core_whatsappmessage
      (direction, status, message_type, body, whatsapp_message_id, raw_payload,
       error_message, created_at, message_at, contact_id, customer_id, sent_by_id)
     VALUES
      ('outbound', 'sent', 'audio', $1, $2, $3::jsonb, '', $4, $4, $5, NULL, NULL)
     RETURNING id`,
    [
      isVoice ? "[voice note sent]" : "[audio sent]",
      wamid || `local-${Date.now()}`,
      JSON.stringify(raw),
      now,
      Number(contactId),
    ]
  );
  await p.query(
    `UPDATE core_whatsappcontact
     SET last_message_at = $1, updated_at = $1
     WHERE id = $2`,
    [now, Number(contactId)]
  );
  return Number(ins.rows[0].id);
}

/**
 * Full outbound path: buffer → (optional convert) → upload → send → DB.
 */
export async function sendContactAudio({
  contactId,
  buffer,
  mimeType = "audio/webm",
  isVoice = true,
}) {
  const contact = await getContact(contactId);
  let uploadBuf = buffer;
  let uploadMime = mimeType || "application/octet-stream";
  let filename = "audio.bin";
  let voice = Boolean(isVoice);

  const isOgg =
    /ogg/i.test(uploadMime) ||
    (buffer.length > 4 && buffer.slice(0, 4).toString() === "OggS");
  const isMp3 = /mpeg|mp3/i.test(uploadMime);
  const isM4a = /mp4|m4a|aac/i.test(uploadMime);

  if (voice || (!isOgg && !isMp3 && !isM4a)) {
    // Convert browser webm/etc → ogg opus for reliable voice notes
    const ext = isOgg
      ? ".ogg"
      : /webm/i.test(uploadMime)
        ? ".webm"
        : /mp4|m4a/i.test(uploadMime)
          ? ".m4a"
          : ".webm";
    uploadBuf = await toOggOpus(buffer, ext);
    uploadMime = "audio/ogg";
    filename = "voice.ogg";
    voice = true;
  } else if (isOgg) {
    uploadMime = "audio/ogg";
    filename = "voice.ogg";
  } else if (isMp3) {
    uploadMime = "audio/mpeg";
    filename = "audio.mp3";
    voice = false;
  } else if (isM4a) {
    uploadMime = "audio/mp4";
    filename = "audio.m4a";
    voice = false;
  }

  const mediaId = await uploadWhatsAppMedia(uploadBuf, uploadMime, filename);
  const { wamid } = await sendWhatsAppAudio({
    to: contact.phone_number,
    mediaId,
    isVoice: voice,
  });
  const messageId = await recordOutboundAudio({
    contactId: contact.id,
    wamid,
    mediaId,
    mimeType: uploadMime,
    isVoice: voice,
  });
  return {
    ok: true,
    messageId,
    wamid,
    mediaId,
    phone: contact.phone_number,
    displayName: contact.display_name,
  };
}
