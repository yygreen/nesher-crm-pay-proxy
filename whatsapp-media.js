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

/** Durable media cache — Meta only keeps media downloadable ~30 days. */
const MEDIA_CACHE_MAX = 12 * 1024 * 1024; // 12 MB
let mediaCacheReady = false;

async function ensureMediaCache() {
  if (mediaCacheReady) return;
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS nesher_wa_media_cache (
      media_id TEXT PRIMARY KEY,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      bytes BYTEA NOT NULL,
      byte_size INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  mediaCacheReady = true;
}

export async function cacheMediaBlob(mediaId, buffer, mimeType) {
  const id = String(mediaId || "").replace(/[^\d]/g, "");
  if (!id || !buffer?.length || buffer.length > MEDIA_CACHE_MAX) return false;
  try {
    await ensureMediaCache();
    const p = getPool();
    await p.query(
      `INSERT INTO nesher_wa_media_cache (media_id, mime_type, bytes, byte_size)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (media_id) DO NOTHING`,
      [id, mimeType || "application/octet-stream", buffer, buffer.length]
    );
    // Cap cache so Railway Postgres doesn't grow forever (keep ~200 newest).
    await p.query(`
      DELETE FROM nesher_wa_media_cache
      WHERE media_id IN (
        SELECT media_id FROM nesher_wa_media_cache
        ORDER BY created_at DESC
        OFFSET 200
      )
    `).catch(() => {});
    return true;
  } catch (e) {
    console.warn("wa media cache write", e.message);
    return false;
  }
}

async function readMediaCache(mediaId) {
  const id = String(mediaId || "").replace(/[^\d]/g, "");
  if (!id) return null;
  try {
    await ensureMediaCache();
    const r = await getPool().query(
      `SELECT mime_type, bytes, byte_size FROM nesher_wa_media_cache WHERE media_id = $1`,
      [id]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      buffer: row.bytes,
      mimeType: row.mime_type,
      fileSize: row.byte_size,
      id,
      cached: true,
    };
  } catch (e) {
    console.warn("wa media cache read", e.message);
    return null;
  }
}

/** Coalesce concurrent downloads of the same media id (poll storms). */
const mediaInflight = new Map();

/**
 * Resolve Meta media metadata + binary (with durable Postgres cache).
 * @param {string} mediaId
 */
export async function downloadWhatsAppMedia(mediaId) {
  const id = String(mediaId || "").replace(/[^\d]/g, "");
  if (!id) throw new Error("Invalid media id");

  const hit = await readMediaCache(id);
  if (hit) return hit;

  if (mediaInflight.has(id)) return mediaInflight.get(id);

  const job = (async () => {
    const { token } = waConfig();
    if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN not configured on proxy");

    const metaRes = await fetch(`${GRAPH}/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) {
      const human = humanizeMetaSendError(meta, `Meta media meta HTTP ${metaRes.status}`);
      const err = new Error(human);
      err.code = meta?.error?.code;
      err.expired = metaRes.status === 404 || /not found|expired|unsupported/i.test(human);
      throw err;
    }
    if (!meta.url) throw new Error("Meta media has no download URL (may have expired)");

    const binRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!binRes.ok) {
      const err = new Error(`Meta media download HTTP ${binRes.status}`);
      err.expired = binRes.status === 404 || binRes.status === 410;
      throw err;
    }
    const buf = Buffer.from(await binRes.arrayBuffer());
    const out = {
      buffer: buf,
      mimeType: meta.mime_type || binRes.headers.get("content-type") || "application/octet-stream",
      fileSize: meta.file_size || buf.length,
      id: meta.id || id,
      cached: false,
    };
    await cacheMediaBlob(out.id, out.buffer, out.mimeType);
    return out;
  })();

  mediaInflight.set(id, job);
  try {
    return await job;
  } finally {
    mediaInflight.delete(id);
  }
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
    ff.on("error", (e) =>
      reject(
        new Error(
          `Voice conversion failed — ffmpeg is not available on this server (${e.message}). Send an MP3/M4A file instead, or install ffmpeg on the Railway image.`
        )
      )
    );
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Voice conversion failed (ffmpeg exit ${code}). Try a shorter note or upload an MP3. ${err.slice(-200)}`
          )
        );
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
    throw new Error(humanizeMetaSendError(data, `Media upload HTTP ${res.status}`));
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
    throw new Error(humanizeMetaSendError(data, `Send audio HTTP ${res.status}`));
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
  await autoLinkContacts().catch(() => {});
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
      ? (() => {
          const media = extractWaMedia(row.lm_raw || {}, row.lm_type);
          return {
            direction: row.lm_direction,
            status: row.lm_status,
            messageType: row.lm_type,
            body: row.lm_body,
            messageAt: row.lm_at,
            voice: media?.mediaKind === "audio" ? Boolean(media.voice) : Boolean(row.lm_raw?.audio?.voice),
            mediaKind: media?.mediaKind || null,
            caption: media?.caption || null,
            filename: media?.filename || null,
            sentBy: row.lm_sender || null,
            agentTag: String(row.lm_raw?.agent_tag || "").trim() || null,
          };
        })()
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

/** Normalize webhook / CRM shapes to a list of candidate message objects. */
export function waPayloadCandidates(raw) {
  const root = raw && typeof raw === "object" ? raw : {};
  const candidates = [root];
  if (root.message && typeof root.message === "object") candidates.push(root.message);
  if (Array.isArray(root.messages) && root.messages[0]) candidates.push(root.messages[0]);
  try {
    const msgs = root.entry?.[0]?.changes?.[0]?.value?.messages;
    if (Array.isArray(msgs) && msgs[0]) candidates.push(msgs[0]);
  } catch {
    /* ignore */
  }
  return candidates.filter((o) => o && typeof o === "object");
}

/**
 * Pull media metadata out of a WhatsApp Cloud API message raw_payload.
 * Returns null when no media id is present.
 */
export function extractWaMedia(raw, messageType) {
  const candidates = waPayloadCandidates(raw);
  const kinds = ["image", "video", "sticker", "document", "audio"];
  const prefer = String(messageType || candidates[0]?.type || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (prefer && kinds.includes(prefer)) {
    kinds.splice(kinds.indexOf(prefer), 1);
    kinds.unshift(prefer);
  }

  for (const obj of candidates) {
    for (const kind of kinds) {
      const m = obj[kind];
      if (m && typeof m === "object" && (m.id || m.link)) {
        return {
          mediaId: m.id ? String(m.id) : null,
          mediaKind: kind,
          voice: Boolean(m.voice),
          mimeType: m.mime_type || null,
          caption: m.caption ? String(m.caption) : null,
          filename: m.filename ? String(m.filename) : null,
        };
      }
    }
  }
  return null;
}

function phonesFromVcard(vcard) {
  if (!vcard) return [];
  let text = String(vcard);
  // Django sometimes stores base64-encoded vcards
  if (!/^BEGIN:VCARD/i.test(text) && /^[A-Za-z0-9+/=]+$/.test(text.replace(/\s/g, ""))) {
    try {
      text = Buffer.from(text.replace(/\s/g, ""), "base64").toString("utf8");
    } catch {
      /* keep original */
    }
  }
  const phones = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^TEL[^:]*:(.+)$/i);
    if (m) phones.push(m[1].trim());
  }
  return phones;
}

/**
 * Non-media structured fields: location, contacts, reaction, interactive, context.
 */
export function extractWaStructured(raw, messageType) {
  const candidates = waPayloadCandidates(raw);
  const out = {
    location: null,
    contacts: null,
    reaction: null,
    interactive: null,
    forwarded: false,
    contextWamid: null,
  };

  for (const obj of candidates) {
    if (obj.location && typeof obj.location === "object") {
      const loc = obj.location;
      out.location = {
        lat: loc.latitude != null ? Number(loc.latitude) : null,
        lng: loc.longitude != null ? Number(loc.longitude) : null,
        name: loc.name ? String(loc.name) : null,
        address: loc.address ? String(loc.address) : null,
      };
    }
    if (Array.isArray(obj.contacts) && obj.contacts.length) {
      out.contacts = obj.contacts.map((c) => {
        const name =
          c?.name?.formatted_name ||
          [c?.name?.first_name, c?.name?.last_name].filter(Boolean).join(" ") ||
          "Contact";
        const phones = [];
        if (Array.isArray(c.phones)) {
          for (const p of c.phones) {
            if (p?.phone) phones.push(String(p.phone));
            else if (p?.wa_id) phones.push(String(p.wa_id));
          }
        }
        for (const p of phonesFromVcard(c.vcard)) {
          if (!phones.includes(p)) phones.push(p);
        }
        return { name: String(name), phones };
      });
    }
    if (obj.reaction && typeof obj.reaction === "object") {
      out.reaction = {
        emoji: String(obj.reaction.emoji || "").trim() || "👍",
        messageId: obj.reaction.message_id ? String(obj.reaction.message_id) : null,
      };
    }
    if (obj.interactive && typeof obj.interactive === "object") {
      const it = obj.interactive;
      const br = it.button_reply || it.list_reply || null;
      if (br) {
        out.interactive = {
          kind: it.type || (it.button_reply ? "button_reply" : "list_reply"),
          title: String(br.title || br.id || "Reply"),
          id: br.id ? String(br.id) : null,
          description: br.description ? String(br.description) : null,
        };
      }
    }
    if (obj.button && typeof obj.button === "object" && obj.button.text) {
      out.interactive = {
        kind: "button",
        title: String(obj.button.text),
        id: obj.button.payload ? String(obj.button.payload) : null,
        description: null,
      };
    }
    if (obj.context && typeof obj.context === "object") {
      if (obj.context.forwarded || obj.context.frequently_forwarded) out.forwarded = true;
      if (obj.context.id) out.contextWamid = String(obj.context.id);
    }
  }

  // Fallback when message_type alone is the only signal
  const mt = String(messageType || "").toLowerCase();
  if (mt === "reaction" && !out.reaction && raw?.reaction) {
    out.reaction = {
      emoji: String(raw.reaction.emoji || "👍"),
      messageId: raw.reaction.message_id ? String(raw.reaction.message_id) : null,
    };
  }
  return out;
}

/** Parse Django-stored Meta error_message (JSON blob or plain text) into staff English. */
export function humanizeStoredError(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";
  try {
    const j = JSON.parse(s);
    if (j?.error || j?.message) return humanizeMetaSendError(j, s);
  } catch {
    /* plain text */
  }
  if (/Authentication Error|code.?190|OAuthException/i.test(s)) {
    return "WhatsApp token expired or invalid — reconnect Meta / refresh WHATSAPP_ACCESS_TOKEN.";
  }
  if (/131047|24 hour|re-engagement|outside the allowed window/i.test(s)) {
    return "Free-form chat is closed (24h window). Send an approved template to re-open.";
  }
  return s.length > 240 ? s.slice(0, 240) + "…" : s;
}

function bodyFromPayload(rowBody, raw, messageType) {
  const body = String(rowBody || "").trim();
  if (body && !/^\[.+ message (received|sent)\]$/i.test(body)) return body;
  const candidates = waPayloadCandidates(raw);
  for (const obj of candidates) {
    if (obj?.text?.body) return String(obj.text.body);
    if (obj?.button?.text) return String(obj.button.text);
    if (obj?.interactive?.button_reply?.title) return String(obj.interactive.button_reply.title);
    if (obj?.interactive?.list_reply?.title) return String(obj.interactive.list_reply.title);
  }
  return body;
}

function mapMessageRows(rows) {
  const mapped = rows.map((row) => {
    const raw = row.raw_payload || {};
    const media = extractWaMedia(raw, row.message_type);
    const structured = extractWaStructured(raw, row.message_type);
    const body = bodyFromPayload(row.body, raw, row.message_type);
    return {
      id: Number(row.id),
      direction: row.direction,
      status: row.status,
      messageType: row.message_type,
      body,
      wamid: row.whatsapp_message_id,
      messageAt: row.message_at,
      error: humanizeStoredError(row.error_message),
      mediaId: media?.mediaId || null,
      mediaKind: media?.mediaKind || null,
      voice: media?.mediaKind === "audio" ? Boolean(media.voice) : false,
      mimeType: media?.mimeType || null,
      caption: media?.caption || null,
      filename: media?.filename || null,
      location: structured.location,
      contacts: structured.contacts,
      reaction: structured.reaction,
      interactive: structured.interactive,
      forwarded: structured.forwarded,
      contextWamid: structured.contextWamid,
      quote: null,
      reactions: [],
      sentBy: row.sender || null,
      agentTag: (raw.agent_tag || "").trim() || null,
      transcriptEn: String(raw.transcript_en || "").trim() || null,
    };
  });

  const byWamid = new Map();
  for (const m of mapped) {
    if (m.wamid) byWamid.set(String(m.wamid), m);
  }
  const out = [];
  for (const m of mapped) {
    if (m.messageType === "reaction" && m.reaction?.messageId) {
      const target = byWamid.get(String(m.reaction.messageId));
      if (target) {
        target.reactions.push({
          emoji: m.reaction.emoji,
          direction: m.direction,
          id: m.id,
        });
        continue;
      }
    }
    out.push(m);
  }
  for (const m of out) {
    if (!m.contextWamid) continue;
    const t = byWamid.get(String(m.contextWamid));
    if (!t) continue;
    const qBody =
      t.caption ||
      (t.body && !/^\[/.test(t.body) ? t.body : null) ||
      (t.mediaKind === "image" || t.messageType === "image"
        ? "Photo"
        : t.mediaKind === "audio" || t.messageType === "audio"
          ? "Voice note"
          : t.messageType === "document"
            ? t.filename || "Document"
            : t.messageType === "location"
              ? "Location"
              : t.messageType === "contacts"
                ? "Contact"
                : "Message");
    m.quote = {
      body: String(qBody).slice(0, 160),
      messageType: t.messageType,
      direction: t.direction,
      id: t.id,
    };
  }
  return out;
}

/**
 * List messages for a contact (newest last for chat UI).
 * opts: { limit, beforeId } — beforeId loads older page (cursor = that message id).
 * Returns { messages, meta }.
 */
export async function listContactMessages(contactId, limitOrOpts = 200) {
  const opts =
    typeof limitOrOpts === "object" && limitOrOpts
      ? limitOrOpts
      : { limit: limitOrOpts };
  const p = getPool();
  const id = Number(contactId);
  const lim = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
  const beforeId = opts.beforeId != null ? Number(opts.beforeId) : null;

  let r;
  if (beforeId && Number.isFinite(beforeId)) {
    // Older page: messages strictly before the cursor row (by time, then id).
    r = await p.query(
      `SELECT * FROM (
         SELECT m.id, m.direction, m.status, m.message_type, m.body, m.whatsapp_message_id,
                m.raw_payload, m.error_message, m.message_at, m.created_at, m.sent_by_id,
                COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.username) AS sender
         FROM core_whatsappmessage m
         LEFT JOIN auth_user u ON u.id = m.sent_by_id
         WHERE m.contact_id = $1
           AND (m.message_at, m.id) < (
             SELECT message_at, id FROM core_whatsappmessage WHERE id = $2 AND contact_id = $1
           )
         ORDER BY m.message_at DESC, m.id DESC
         LIMIT $3
       ) older
       ORDER BY message_at ASC, id ASC`,
      [id, beforeId, lim]
    );
  } else {
    r = await p.query(
      `SELECT * FROM (
         SELECT m.id, m.direction, m.status, m.message_type, m.body, m.whatsapp_message_id,
                m.raw_payload, m.error_message, m.message_at, m.created_at, m.sent_by_id,
                COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.username) AS sender
         FROM core_whatsappmessage m
         LEFT JOIN auth_user u ON u.id = m.sent_by_id
         WHERE m.contact_id = $1
         ORDER BY m.message_at DESC, m.id DESC
         LIMIT $2
       ) recent
       ORDER BY message_at ASC, id ASC`,
      [id, lim]
    );
  }

  const totalR = await p.query(
    `SELECT count(*)::int AS n,
            max(message_at) FILTER (WHERE direction = 'inbound') AS last_inbound_at,
            min(id) AS min_id
     FROM core_whatsappmessage WHERE contact_id = $1`,
    [id]
  );
  const total = totalR.rows[0]?.n || 0;
  const lastInboundAt = totalR.rows[0]?.last_inbound_at || null;
  const freeFormOpenUntil = lastInboundAt
    ? new Date(new Date(lastInboundAt).getTime() + 24 * 60 * 60 * 1000)
    : null;
  const freeFormOpen = freeFormOpenUntil ? freeFormOpenUntil.getTime() > Date.now() : false;

  const out = mapMessageRows(r.rows);
  const oldestId = out.length ? out[0].id : null;
  const newestId = out.length ? out[out.length - 1].id : null;
  const minId = totalR.rows[0]?.min_id != null ? Number(totalR.rows[0].min_id) : null;
  // More history exists if the oldest row we returned is not the thread's first row.
  const hasMoreOlder = oldestId != null && minId != null && Number(oldestId) !== Number(minId);

  return {
    messages: out,
    meta: {
      total,
      returned: out.length,
      truncated: total > out.length,
      hasMoreOlder: Boolean(hasMoreOlder && oldestId),
      oldestId,
      newestId,
      beforeId: beforeId || null,
      lastInboundAt,
      freeFormOpenUntil: freeFormOpenUntil ? freeFormOpenUntil.toISOString() : null,
      freeFormOpen,
    },
  };
}

/**
 * Send an approved template into an existing contact thread (re-open 24h window).
 */
export async function sendContactTemplate({
  contactId,
  templateName,
  params = [],
  sentById = null,
  agentTag = "",
}) {
  const contact = await getContact(contactId);
  const out = await startChat({
    phone: contact.phone_number,
    name: contact.display_name || "",
    templateName,
    params,
    sentById,
    agentTag,
    openExistingOnly: false,
  });
  return {
    ok: true,
    contactId: Number(contact.id),
    wamid: out.wamid,
    template: out.template,
  };
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
  // Tag the newest untagged outbound in the last 5 minutes (text OR media).
  // Previous 90s text-only window missed slow CRM writes and voice/media rows.
  const r = await p.query(
    `UPDATE core_whatsappmessage
     SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || jsonb_build_object('agent_tag', $2::text)
     WHERE id = (
       SELECT id FROM core_whatsappmessage
       WHERE contact_id = $1 AND direction = 'outbound'
         AND created_at > now() - interval '5 minutes'
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
 * Auto-link unlinked WhatsApp contacts to customers by phone (last 9 digits;
 * only when exactly ONE customer matches, so shared/ambiguous numbers are
 * never guessed). Cheap single statement — safe to run on every inbox load.
 */
export async function autoLinkContacts() {
  const p = getPool();
  const r = await p.query(
    `WITH cand AS (
       SELECT wc.id wc_id, c.id cust_id,
              count(*) OVER (PARTITION BY wc.id) matches
       FROM core_whatsappcontact wc
       JOIN core_customer c
         ON length(regexp_replace(coalesce(c.phone,''), '\\D', '', 'g')) >= 9
        AND right(regexp_replace(c.phone, '\\D', '', 'g'), 9)
          = right(regexp_replace(wc.phone_number, '\\D', '', 'g'), 9)
       WHERE wc.customer_id IS NULL
     )
     UPDATE core_whatsappcontact wc SET customer_id = cand.cust_id, updated_at = now()
     FROM cand WHERE wc.id = cand.wc_id AND cand.matches = 1
     RETURNING wc.id, wc.customer_id`
  );
  return r.rows;
}

/**
 * WhatsApp presence for a customer detail page: contact + message stats.
 */
export async function whatsappByCustomer(customerId) {
  const p = getPool();
  const id = Number(customerId);
  if (!Number.isFinite(id)) return null;
  const r = await p.query(
    `SELECT wc.id, wc.phone_number, wc.display_name,
            count(m.id) AS msg_count, max(m.message_at) AS last_at
     FROM core_whatsappcontact wc
     LEFT JOIN core_whatsappmessage m ON m.contact_id = wc.id
     WHERE wc.customer_id = $1
     GROUP BY wc.id ORDER BY max(m.message_at) DESC NULLS LAST LIMIT 1`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return {
    contactId: Number(row.id),
    phone: row.phone_number,
    name: row.display_name,
    messages: Number(row.msg_count) || 0,
    lastAt: row.last_at,
  };
}

/** Meta sample templates only work on Public Test Numbers — never usable in prod. */
const SAMPLE_TEMPLATE_NAMES = new Set(["hello_world"]);

function normalizePhoneDigits(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  // Israeli local: 05X… → 9725X…
  if (digits.length === 10 && digits.startsWith("0")) {
    digits = `972${digits.slice(1)}`;
  }
  // Bare Israeli mobile without country code: 5X… (9 digits)
  if (digits.length === 9 && digits.startsWith("5")) {
    digits = `972${digits}`;
  }
  return digits;
}

function mapTemplate(t) {
  const body = (t.components || []).find((c) => c.type === "BODY");
  const text = body?.text || "";
  const varCount = (text.match(/\{\{\d+\}\}/g) || []).length;
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    body: text,
    varCount,
    sample: SAMPLE_TEMPLATE_NAMES.has(t.name),
  };
}

/**
 * All non-rejected templates (for UI status: approved vs still pending Meta).
 */
export async function listTemplates() {
  const { token } = waConfig();
  if (!token) throw new Error("WhatsApp not configured on proxy");
  const res = await fetch(
    `${GRAPH}/${process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "1548491333738289"}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Templates HTTP ${res.status}`);
  return (data.data || [])
    .map(mapTemplate)
    .filter((t) => t.status !== "REJECTED" && t.status !== "DISABLED");
}

/**
 * Production-usable templates only: APPROVED and not Meta sample packs.
 * Needed to START a conversation (business-initiated).
 */
export async function listApprovedTemplates() {
  const all = await listTemplates();
  return all.filter((t) => t.status === "APPROVED" && !t.sample);
}

/**
 * Find an existing WhatsApp contact by phone (exact digits, then last-9 fallback).
 */
export async function findContactByPhone(phone) {
  const digits = normalizePhoneDigits(phone);
  if (digits.length < 9) return null;
  const p = getPool();
  const exact = await p.query(
    `SELECT id, phone_number, display_name
     FROM core_whatsappcontact
     WHERE regexp_replace(phone_number, '\\D', '', 'g') = $1
     LIMIT 1`,
    [digits]
  );
  if (exact.rows.length) {
    return {
      contactId: Number(exact.rows[0].id),
      phone: exact.rows[0].phone_number,
      name: exact.rows[0].display_name,
    };
  }
  const tail = digits.slice(-9);
  const fuzzy = await p.query(
    `SELECT id, phone_number, display_name
     FROM core_whatsappcontact
     WHERE length(regexp_replace(phone_number, '\\D', '', 'g')) >= 9
       AND right(regexp_replace(phone_number, '\\D', '', 'g'), 9) = $1
     ORDER BY last_message_at DESC NULLS LAST
     LIMIT 1`,
    [tail]
  );
  if (!fuzzy.rows.length) return null;
  return {
    contactId: Number(fuzzy.rows[0].id),
    phone: fuzzy.rows[0].phone_number,
    name: fuzzy.rows[0].display_name,
  };
}

export function humanizeMetaSendError(data, fallbackStatus) {
  const err = data?.error || data || {};
  const code = err.code;
  const msg = String(err.message || fallbackStatus || "WhatsApp send failed");
  if (code === 190 || /Authentication Error|OAuthException|access token/i.test(msg)) {
    return "WhatsApp token expired or invalid — reconnect Meta / refresh WHATSAPP_ACCESS_TOKEN on Railway.";
  }
  if (
    code === 131058 ||
    /Hello World|Public Test Numbers/i.test(msg)
  ) {
    return (
      "Meta blocked that send: the only approved template right now is Meta's sample " +
      '"Hello World", which only works on Public Test Numbers. Our real booking templates ' +
      "(nesher_open_chat / booking_followup) are still PENDING Meta approval — usually a few hours. " +
      "Once approved, New chat works for any number."
    );
  }
  if (code === 131026 || /not a valid whatsapp/i.test(msg)) {
    return "That number is not on WhatsApp (or is invalid). Use full international digits, e.g. 972501234567.";
  }
  if (code === 131047 || /re-engagement|24 hour|outside/i.test(msg)) {
    return "Free-form chat is closed (24h window). Send an approved template to re-open the conversation.";
  }
  if (code === 131051 || /unsupported message type/i.test(msg)) {
    return "That message type is not supported on this WhatsApp number.";
  }
  if (code === 131052 || /media download error|media.*not available/i.test(msg)) {
    return "Media is no longer available on Meta (expired). Ask the customer to resend.";
  }
  if (code === 131053 || /media upload error/i.test(msg)) {
    return "Media upload failed at Meta. Try a smaller JPEG/PDF (images max 5 MB).";
  }
  if (code === 132000 || /parameter/i.test(msg)) {
    return `Template parameter error from Meta: ${msg}`;
  }
  if (code === 130472 || /user.?s number is part of an experiment/i.test(msg)) {
    return "This number can't receive business messages right now (Meta experiment restriction).";
  }
  if (code === 368 || /temporarily blocked/i.test(msg)) {
    return "This WhatsApp Business account is temporarily restricted by Meta.";
  }
  return code ? `(#${code}) ${msg}` : msg;
}

/**
 * Start a business-initiated conversation: send an approved template to a
 * phone that never messaged us, create/reuse the contact row, record the
 * rendered message, and auto-link to a customer by phone.
 *
 * If openExistingOnly is true (or templateName is empty and the contact already
 * exists), just open the inbox thread without sending.
 */
export async function startChat({
  phone,
  name = "",
  templateName,
  params = [],
  sentById = null,
  agentTag = "",
  openExistingOnly = false,
}) {
  const { token, phoneNumberId } = waConfig();
  if (!token || !phoneNumberId) throw new Error("WhatsApp not configured on proxy");
  const digits = normalizePhoneDigits(phone);
  if (digits.length < 9) {
    throw new Error("Phone must be international digits, e.g. 972501234567 (or 0501234567)");
  }

  const existingHit = await findContactByPhone(digits);
  if (openExistingOnly || (!templateName && existingHit)) {
    if (!existingHit) {
      throw new Error(
        "No existing WhatsApp chat for that number. Pick an approved template to open a new conversation."
      );
    }
    if (name) {
      const p = getPool();
      await p.query(
        `UPDATE core_whatsappcontact
         SET display_name = COALESCE(NULLIF(display_name, ''), $2), updated_at = now()
         WHERE id = $1`,
        [existingHit.contactId, name]
      );
    }
    return { contactId: existingHit.contactId, existing: true, wamid: null };
  }

  if (SAMPLE_TEMPLATE_NAMES.has(String(templateName || ""))) {
    throw new Error(
      'Cannot use Meta\'s sample "hello_world" template on real numbers. Wait for nesher_open_chat / booking_followup to be approved.'
    );
  }

  const all = await listTemplates();
  const approved = all.filter((t) => t.status === "APPROVED" && !t.sample);
  const pending = all.filter((t) => t.status === "PENDING" && !t.sample);

  let tpl = approved.find((t) => t.name === templateName);
  // Allow matching by name+language if UI sends "name (lang)" leftovers — UI sends name only.
  if (!tpl && templateName) {
    tpl = approved.find((t) => t.name === templateName && t.language);
  }
  if (!tpl) {
    if (!approved.length) {
      const pendingNames = pending.map((t) => `${t.name} (${t.language})`).join(", ") || "none yet";
      throw new Error(
        `No production WhatsApp templates are approved yet. Pending Meta review: ${pendingNames}. ` +
          "Until then you can only open numbers that already messaged us (they appear in the inbox)."
      );
    }
    throw new Error(
      `Template "${templateName}" is not approved yet. Approved: ${approved.map((t) => t.name).join(", ") || "none"}.`
    );
  }
  if (params.length !== tpl.varCount) {
    throw new Error(`Template needs ${tpl.varCount} value(s), got ${params.length}`);
  }

  const payload = {
    messaging_product: "whatsapp",
    to: digits,
    type: "template",
    template: {
      name: tpl.name,
      language: { code: tpl.language },
      ...(tpl.varCount
        ? {
            components: [
              {
                type: "body",
                parameters: params.map((v) => ({ type: "text", text: String(v).slice(0, 500) })),
              },
            ],
          }
        : {}),
    },
  };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(humanizeMetaSendError(data, `Template send HTTP ${res.status}`));
  }
  const wamid = data?.messages?.[0]?.id || "";

  const p = getPool();
  const now = new Date();
  const existing = await p.query(
    `SELECT id FROM core_whatsappcontact WHERE regexp_replace(phone_number, '\\D', '', 'g') = $1 LIMIT 1`,
    [digits]
  );
  let contactId;
  if (existing.rows.length) {
    contactId = Number(existing.rows[0].id);
    if (name) {
      await p.query(
        `UPDATE core_whatsappcontact SET display_name = COALESCE(NULLIF(display_name, ''), $2), updated_at = $3 WHERE id = $1`,
        [contactId, name, now]
      );
    }
  } else {
    const ins = await p.query(
      `INSERT INTO core_whatsappcontact
        (phone_number, display_name, last_message_at, unread_count, is_archived, notes, created_at, updated_at, customer_id)
       VALUES ($1, $2, $3, 0, false, '', $3, $3, NULL) RETURNING id`,
      [digits, name || digits, now]
    );
    contactId = Number(ins.rows[0].id);
  }

  let rendered = tpl.body;
  params.forEach((v, i) => {
    rendered = rendered.split(`{{${i + 1}}}`).join(String(v));
  });
  const raw = { type: "template", template: tpl.name, language: tpl.language, direction: "outbound" };
  const tag = String(agentTag || "").trim().slice(0, 40);
  if (tag) raw.agent_tag = tag;
  await p.query(
    `INSERT INTO core_whatsappmessage
      (direction, status, message_type, body, whatsapp_message_id, raw_payload,
       error_message, created_at, message_at, contact_id, customer_id, sent_by_id)
     VALUES ('outbound', 'sent', 'text', $1, $2, $3::jsonb, '', $4, $4, $5, NULL, $6)`,
    [rendered, wamid || `tpl-${Date.now()}`, JSON.stringify(raw), now, contactId, sentById == null ? null : Number(sentById)]
  );
  await p.query(
    `UPDATE core_whatsappcontact SET last_message_at = $1, updated_at = $1 WHERE id = $2`,
    [now, contactId]
  );
  await autoLinkContacts().catch(() => {});
  return { contactId, wamid, existing: false, template: tpl.name };
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
  if (!buffer?.length) throw new Error("Empty audio");
  if (buffer.length < 200) throw new Error("Recording too short — hold the mic longer.");
  if (buffer.length > 16 * 1024 * 1024) {
    throw new Error("Voice note too large (max 16 MB). Keep it under ~3 minutes.");
  }
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
  await cacheMediaBlob(mediaId, uploadBuf, uploadMime);
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

/**
 * Infer Cloud API media kind from mime / filename.
 * @returns {"image"|"video"|"document"|"audio"|null}
 */
export function inferMediaKind(mimeType, filename = "") {
  const mime = String(mimeType || "").toLowerCase();
  const name = String(filename || "").toLowerCase();
  if (mime.startsWith("image/") || /\.(jpe?g|png|gif|webp)$/i.test(name)) return "image";
  if (mime.startsWith("video/") || /\.(mp4|mov|3gp|webm)$/i.test(name)) return "video";
  if (mime.startsWith("audio/") || /\.(ogg|mp3|m4a|aac|opus|wav)$/i.test(name)) return "audio";
  if (mime && mime !== "application/octet-stream") return "document";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip)$/i.test(name)) return "document";
  return null;
}

/**
 * Send image / video / document via Cloud API.
 */
export async function sendWhatsAppMediaMessage({ to, kind, mediaId, caption, filename }) {
  const { token, phoneNumberId } = waConfig();
  if (!token || !phoneNumberId) throw new Error("WhatsApp not configured on proxy");
  const phone = String(to || "").replace(/\D/g, "");
  if (!phone) throw new Error("Missing recipient phone");
  const type = String(kind || "").toLowerCase();
  if (!["image", "video", "document"].includes(type)) {
    throw new Error(`Unsupported media send kind: ${kind}`);
  }
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone,
    type,
    [type]: {
      id: mediaId,
      ...(caption ? { caption: String(caption).slice(0, 1024) } : {}),
      ...(type === "document" && filename ? { filename: String(filename).slice(0, 240) } : {}),
    },
  };
  const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(humanizeMetaSendError(data, `Send ${type} HTTP ${res.status}`));
  }
  return { wamid: data?.messages?.[0]?.id || "", data };
}

/**
 * Persist outbound image/video/document row.
 */
export async function recordOutboundMedia({
  contactId,
  wamid,
  kind,
  mediaId,
  mimeType,
  caption = "",
  filename = "",
  sentById = null,
  agentTag = "",
}) {
  const p = getPool();
  const now = new Date();
  const type = String(kind || "document");
  const raw = {
    type,
    [type]: {
      id: mediaId,
      mime_type: mimeType || null,
      ...(caption ? { caption } : {}),
      ...(filename ? { filename } : {}),
    },
    direction: "outbound",
  };
  const tag = String(agentTag || "").trim().slice(0, 40);
  if (tag) raw.agent_tag = tag;
  const body =
    caption ||
    (type === "image"
      ? "[image sent]"
      : type === "video"
        ? "[video sent]"
        : filename
          ? `[document sent] ${filename}`
          : "[document sent]");
  const ins = await p.query(
    `INSERT INTO core_whatsappmessage
      (direction, status, message_type, body, whatsapp_message_id, raw_payload,
       error_message, created_at, message_at, contact_id, customer_id, sent_by_id)
     VALUES
      ('outbound', 'sent', $1, $2, $3, $4::jsonb, '', $5, $5, $6, NULL, $7)
     RETURNING id`,
    [
      type,
      body,
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
 * Full outbound path for image / video / document attachments.
 */
export async function sendContactMedia({
  contactId,
  buffer,
  mimeType = "application/octet-stream",
  filename = "file.bin",
  caption = "",
  sentById = null,
  agentTag = "",
}) {
  if (!buffer?.length) throw new Error("Empty file");
  if (buffer.length > 64 * 1024 * 1024) throw new Error("File too large (max 64 MB)");

  const lowerName = String(filename || "").toLowerCase();
  const lowerMime = String(mimeType || "").toLowerCase();
  if (
    lowerMime.includes("heic") ||
    lowerMime.includes("heif") ||
    /\.heic$|\.heif$/i.test(lowerName)
  ) {
    throw new Error(
      "iPhone HEIC photos aren't accepted by WhatsApp Cloud API. Export as JPEG (or use the phone's \"Most Compatible\" camera setting) and try again."
    );
  }

  const contact = await getContact(contactId);
  let kind = inferMediaKind(mimeType, filename);
  if (!kind || kind === "audio") {
    // Audio still goes through the AAC conversion path
    if (kind === "audio" || /^audio\//i.test(mimeType)) {
      return sendContactAudio({
        contactId,
        buffer,
        mimeType,
        isVoice: false,
        sentById,
        agentTag,
      });
    }
    kind = "document";
  }

  // Meta limits (approximate, enforced server-side too)
  const limits = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, document: 100 * 1024 * 1024 };
  if (buffer.length > (limits[kind] || limits.document)) {
    throw new Error(
      `${kind} is too large (${Math.round(buffer.length / 1024 / 1024)} MB). Max for ${kind}: ${Math.round((limits[kind] || limits.document) / 1024 / 1024)} MB.`
    );
  }

  let uploadMime = mimeType || "application/octet-stream";
  let uploadName = filename || "file.bin";
  if (kind === "image") {
    if (!/^image\//i.test(uploadMime)) uploadMime = "image/jpeg";
    if (!/\.(jpe?g|png|webp|gif)$/i.test(uploadName)) uploadName = "photo.jpg";
  } else if (kind === "video") {
    if (!/^video\//i.test(uploadMime)) uploadMime = "video/mp4";
    if (!/\.(mp4|3gp|mov)$/i.test(uploadName)) uploadName = "video.mp4";
  } else {
    if (!uploadName || uploadName === "file.bin") uploadName = "document.bin";
  }

  const mediaId = await uploadWhatsAppMedia(buffer, uploadMime, uploadName);
  await cacheMediaBlob(mediaId, buffer, uploadMime);
  const { wamid } = await sendWhatsAppMediaMessage({
    to: contact.phone_number,
    kind,
    mediaId,
    caption,
    filename: uploadName,
  });
  const messageId = await recordOutboundMedia({
    contactId: contact.id,
    wamid,
    kind,
    mediaId,
    mimeType: uploadMime,
    caption,
    filename: uploadName,
    sentById,
    agentTag,
  });
  return {
    ok: true,
    messageId,
    wamid,
    mediaId,
    kind,
    phone: contact.phone_number,
    displayName: contact.display_name,
  };
}
