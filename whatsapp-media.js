/**
 * WhatsApp Cloud API media helpers for the Nesher CRM pay-proxy.
 * Download inbound voice notes, upload+send outbound audio, mirror into CRM tables.
 */

import { spawn } from "node:child_process";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
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
 * Convert any browser audio to AAC/M4A via ffmpeg. OGG-Opus voice notes sent
 * through the Cloud API error with "audio is no longer available" on iPhones
 * (verified 2026-08-05 — even a bit-perfect WhatsApp-native OGG failed when
 * re-sent via the API), so ALL outbound audio ships as AAC, which every
 * device plays natively.
 * @param {Buffer} input
 * @param {string} inputExt e.g. .webm .ogg .mp3
 */
export async function toAacM4a(input, inputExt = ".webm") {
  const dir = await mkdtemp(path.join(tmpdir(), "wa-audio-"));
  const inPath = path.join(dir, `in${inputExt.startsWith(".") ? inputExt : `.${inputExt}`}`);
  const outPath = path.join(dir, "out.m4a");
  await writeFile(inPath, input);

  await new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-i",
        inPath,
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-movflags",
        "+faststart",
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
            m.message_at AS lm_at, m.raw_payload AS lm_raw,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.username) AS lm_sender
     FROM core_whatsappcontact c
     LEFT JOIN core_customer cust ON cust.id = c.customer_id
     LEFT JOIN LATERAL (
       SELECT direction, status, message_type, body, message_at, raw_payload, sent_by_id
       FROM core_whatsappmessage
       WHERE contact_id = c.id
       ORDER BY message_at DESC, id DESC
       LIMIT 1
     ) m ON TRUE
     LEFT JOIN auth_user u ON u.id = m.sent_by_id
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
          sentBy: row.lm_sender || null,
          agentTag: String(row.lm_raw?.agent_tag || "").trim() || null,
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
    `SELECT m.id, m.direction, m.status, m.message_type, m.body, m.whatsapp_message_id,
            m.raw_payload, m.error_message, m.message_at, m.created_at, m.sent_by_id,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.username) AS sender
     FROM core_whatsappmessage m
     LEFT JOIN auth_user u ON u.id = m.sent_by_id
     WHERE m.contact_id = $1
     ORDER BY m.message_at ASC, m.id ASC
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
      sentBy: row.sender || null,
      agentTag: (raw.agent_tag || "").trim() || null,
      transcriptEn: String(raw.transcript_en || "").trim() || null,
    };
  });
}

/**
 * Resolve the Django user id behind a sessionid cookie (django_session table).
 * Handles both storage formats: legacy base64(hash:json) and the modern
 * signing.dumps "payload:timestamp:sig" (payload optionally "."-prefixed
 * zlib-compressed). Signature is NOT verified here — the auth layer already
 * validated the session against the live CRM; this only reads who it is.
 */
export async function sessionUserId(sessionKey) {
  if (!sessionKey) return null;
  try {
    const p = getPool();
    const r = await p.query(
      `SELECT session_data FROM django_session WHERE session_key = $1 AND expire_date > now()`,
      [String(sessionKey)]
    );
    if (!r.rows.length) return null;
    const data = String(r.rows[0].session_data || "");
    const candidates = [];
    const seg = data.split(":")[0];
    for (let payload of [seg, data]) {
      try {
        let compressed = false;
        if (payload.startsWith(".")) {
          compressed = true;
          payload = payload.slice(1);
        }
        const pad = "=".repeat((4 - (payload.length % 4)) % 4);
        let buf = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
        if (compressed) buf = zlib.inflateSync(buf);
        candidates.push(buf.toString("utf8"));
      } catch {
        /* try next form */
      }
    }
    for (const text of candidates) {
      const m = text.match(/"_auth_user_id"\s*:\s*"?(\d+)"?/);
      if (m) return Number(m[1]);
    }
  } catch {
    /* attribution is best-effort — never block the send */
  }
  return null;
}

/**
 * Transcribe + translate a voice-note message to English via the YiddishLabs
 * API (two steps: /transcriptions/sync → Yiddish text, /process/text
 * translate-english). Result is cached on the message row
 * (raw_payload.transcript_en + transcript_yi) so one transcription serves the
 * whole team. Internal-only — nothing is sent back to the customer.
 */
const YL_BASE = "https://app.yiddishlabs.com";
// Cloudflare in front of app.yiddishlabs.com rejects non-browser user agents
// with "error code: 1010" — every request must present a browser signature.
const YL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export async function transcribeMessage(messageId) {
  const p = getPool();
  const id = Number(messageId);
  if (!Number.isFinite(id)) throw new Error("Invalid message id");
  const r = await p.query(
    `SELECT id, message_type, raw_payload FROM core_whatsappmessage WHERE id = $1`,
    [id]
  );
  if (!r.rows.length) throw new Error(`Message ${id} not found`);
  const raw = r.rows[0].raw_payload || {};
  const cached = String(raw.transcript_en || "").trim();
  if (cached) return { text: cached, cached: true };
  if (r.rows[0].message_type !== "audio" || !raw.audio?.id) {
    throw new Error("Not an audio message");
  }

  const apiKey = process.env.YIDDISHLABS_API_KEY;
  if (!apiKey) throw new Error("Transcription not configured (YIDDISHLABS_API_KEY missing)");

  const media = await downloadWhatsAppMedia(raw.audio.id);
  if (media.buffer.length > 10 * 1024 * 1024) throw new Error("Audio too large to transcribe");

  const mime = media.mimeType.split(";")[0].trim() || "audio/ogg";
  const ext = /mp4|m4a|aac/i.test(mime) ? "m4a" : /mpeg|mp3/i.test(mime) ? "mp3" : "ogg";
  const form = new FormData();
  form.append("language", process.env.YIDDISHLABS_LANG || "auto");
  form.append("rapid", process.env.YIDDISHLABS_RAPID || "true");
  form.append("file", new Blob([media.buffer], { type: mime }), `note.${ext}`);
  const tRes = await fetch(`${YL_BASE}/api/v1/transcriptions/sync`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "User-Agent": YL_UA,
      Accept: "application/json, text/plain, */*",
    },
    body: form,
  });
  const tData = await tRes.json().catch(() => ({}));
  if (!tRes.ok) {
    throw new Error(tData?.error || tData?.message || `YiddishLabs transcription HTTP ${tRes.status}`);
  }
  const original = String(tData.text || "").trim();
  if (!original) throw new Error("Transcription came back empty — try again");

  const xRes = await fetch(`${YL_BASE}/api/v1/process/text`, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "User-Agent": YL_UA,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    },
    body: JSON.stringify({ text_content: original, action: "translate-english" }),
  });
  const xData = await xRes.json().catch(() => ({}));
  if (!xRes.ok) {
    throw new Error(xData?.error || xData?.message || `YiddishLabs translation HTTP ${xRes.status}`);
  }
  const english = String(xData.text || "").trim() || original;

  await p.query(
    `UPDATE core_whatsappmessage
     SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) ||
       jsonb_build_object(
         'transcript_en', $2::text,
         'transcript_yi', $3::text,
         'transcript_model', 'yiddishlabs'
       )
     WHERE id = $1`,
    [id, english.slice(0, 8000), original.slice(0, 8000)]
  );
  return { text: english, cached: false };
}

/**
 * Stamp a self-declared agent name onto the newest just-sent outbound text
 * row for a contact (Django creates the row; the proxy only sees the POST
 * pass through). Internal-only: raw_payload.agent_tag never reaches Meta.
 * Targets rows from the last 90s that aren't tagged yet.
 */
export async function stampAgentTag(contactId, tag) {
  const clean = String(tag || "").trim().slice(0, 40);
  if (!clean) return false;
  const p = getPool();
  const r = await p.query(
    `UPDATE core_whatsappmessage
     SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || jsonb_build_object('agent_tag', $2::text)
     WHERE id = (
       SELECT id FROM core_whatsappmessage
       WHERE contact_id = $1 AND direction = 'outbound' AND message_type = 'text'
         AND created_at > now() - interval '90 seconds'
         AND COALESCE(raw_payload->>'agent_tag', '') = ''
       ORDER BY id DESC LIMIT 1
     )`,
    [Number(contactId), clean]
  );
  return r.rowCount > 0;
}

/**
 * Active CRM users for the "Sign as" picker.
 */
export async function listAgents() {
  const p = getPool();
  const r = await p.query(
    `SELECT id, username, TRIM(first_name || ' ' || last_name) AS full_name
     FROM auth_user WHERE is_active ORDER BY username`
  );
  return r.rows.map((u) => ({
    id: Number(u.id),
    username: u.username,
    name: u.full_name || u.username,
  }));
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
  sentById = null,
  agentTag = "",
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
  const tag = String(agentTag || "").trim().slice(0, 40);
  if (tag) raw.agent_tag = tag;
  const ins = await p.query(
    `INSERT INTO core_whatsappmessage
      (direction, status, message_type, body, whatsapp_message_id, raw_payload,
       error_message, created_at, message_at, contact_id, customer_id, sent_by_id)
     VALUES
      ('outbound', 'sent', 'audio', $1, $2, $3::jsonb, '', $4, $4, $5, NULL, $6)
     RETURNING id`,
    [
      isVoice ? "[voice note sent]" : "[audio sent]",
      wamid || `local-${Date.now()}`,
      JSON.stringify(raw),
      now,
      Number(contactId),
      sentById == null ? null : Number(sentById),
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
  sentById = null,
  agentTag = "",
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

  if (isMp3) {
    // Already universally playable — pass through untouched.
    uploadMime = "audio/mpeg";
    filename = "audio.mp3";
  } else if (isM4a) {
    uploadMime = "audio/mp4";
    filename = "audio.m4a";
  } else {
    // webm recordings, ogg, and everything else → AAC/M4A (never OGG: it
    // errors on iPhones when sent via the Cloud API).
    const ext = isOgg
      ? ".ogg"
      : /webm/i.test(uploadMime)
        ? ".webm"
        : ".webm";
    uploadBuf = await toAacM4a(buffer, ext);
    uploadMime = "audio/mp4";
    filename = "voice.m4a";
  }

  const mediaId = await uploadWhatsAppMedia(uploadBuf, uploadMime, filename);
  const { wamid } = await sendWhatsAppAudio({
    to: contact.phone_number,
    mediaId,
    // Meta's voice flag is OGG-only; never send it with AAC/MP3 payloads.
    isVoice: false,
  });
  const messageId = await recordOutboundAudio({
    contactId: contact.id,
    wamid,
    mediaId,
    mimeType: uploadMime,
    isVoice: voice,
    sentById,
    agentTag,
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
