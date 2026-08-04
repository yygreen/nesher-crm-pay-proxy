/**
 * Validate a browser Cookie header against the real CRM Django session.
 * Presence of "sessionid=" alone is NOT enough — forged values must fail.
 */

import { fetchWithTimeout } from "./http.js";

const LOGIN_MARKERS = [
  /name=["']password["']/i,
  /Nesher CRM Login/i,
  /btn-login/i,
  /csrfmiddlewaretoken/i,
];

const STAFF_MARKERS = [
  /Log\s*out/i,
  /Travel Agency CRM/i,
  /jrm\/hotels/i,
  /Reservations/i,
];

/**
 * @param {string} cookieHeader
 * @returns {string|null} sessionid value or null
 */
export function extractSessionId(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  const m = cookieHeader.match(/(?:^|;\s*)sessionid=([^;]+)/i);
  if (!m) return null;
  const val = decodeURIComponent(m[1].trim());
  if (!val || val.length < 8) return null;
  // reject obvious forgeries used in probes
  if (/^(forged|fake|test|null|undefined)$/i.test(val)) return null;
  return val;
}

/**
 * Decide if HTML is a CRM login page vs authenticated staff UI.
 * @param {number} status
 * @param {string} body
 * @param {string|null} location
 */
export function isAuthenticatedCrmResponse(status, body, location) {
  if (location && /\/login\/?/i.test(location)) return false;
  if (status === 302 || status === 301) {
    if (location && /\/login\/?/i.test(location)) return false;
    // redirect elsewhere may still be ok; require body check if present
  }
  if (status !== 200 || !body) return false;
  const text = String(body);
  // Login page always has password field + login title/button
  const looksLogin =
    /Nesher CRM Login/i.test(text) ||
    (/name=["']password["']/i.test(text) && /btn-login/i.test(text));
  if (looksLogin) return false;
  // Staff pages show logout or main CRM chrome
  const looksStaff = STAFF_MARKERS.some((re) => re.test(text));
  return looksStaff;
}

/**
 * Validate session by asking the CRM upstream with the browser cookies.
 * @param {object} opts
 * @param {string} opts.cookieHeader
 * @param {string} opts.upstream  e.g. https://nesher-crm-production.up.railway.app
 * @param {string} opts.publicHost  Host header Django expects
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function validateStaffSession(opts) {
  const cookieHeader = opts.cookieHeader || "";
  const sessionId = extractSessionId(cookieHeader);
  if (!sessionId) {
    return { ok: false, reason: "missing_or_invalid_sessionid" };
  }

  const upstream = (opts.upstream || "").replace(/\/$/, "");
  const publicHost = opts.publicHost || "crm.flynesher.com";
  const fetchImpl = opts.fetchImpl || fetch;
  if (!upstream) return { ok: false, reason: "upstream_not_configured" };

  const url = `${upstream}/jrm/hotels/`;
  const timeoutMs = Number(opts.timeoutMs || process.env.AUTH_TIMEOUT_MS || 5000);
  let res;
  try {
    const doFetch = (u, init) =>
      fetchWithTimeout(u, { timeoutMs, ...init }, fetchImpl);
    res = await doFetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        cookie: cookieHeader,
        host: publicHost,
        "x-forwarded-host": publicHost,
        "x-forwarded-proto": "https",
        accept: "text/html",
        "user-agent": "nesher-pay-proxy-auth/1.0",
      },
    });
  } catch (e) {
    return { ok: false, reason: `upstream_error:${e.message}` };
  }

  const location = res.headers.get("location") || res.headers.get("Location");
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }

  if (isAuthenticatedCrmResponse(res.status, body, location)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `session_not_authenticated status=${res.status}`,
  };
}

export { LOGIN_MARKERS, STAFF_MARKERS };
