/**
 * ONE read-only line on the customer / reservation / JRM-hotel-request detail pages:
 * kashrus_standard, travel_party (jsonb) and shabbos_yomtov_notes - the three structured
 * trip columns a 2026-09-07 Gabbai-gated direct-SQL ALTER added to core_customer /
 * core_reservation / core_jrmhotelrequest (One Place v1 item 2; jrm-lead-intake commit
 * 7805d96 started populating kashrus_standard + travel_party on new requests the same day).
 *
 * Those columns exist in Postgres but have NO Django model field yet (no migration - see
 * canon.md s.3 OPEN DEBT) and so render NOWHERE on any CRM page a person looks at. This is
 * the smallest safe fix: read them straight from the same Postgres the proxy already holds
 * a pool on (same DB the PAID badges use) and print one badge line, the same anchor and the
 * same fail-silent discipline as injectPaidBadges (inject.js) - GET only, detail pages only,
 * soft on any DB error or a slow query (>1.5s: returns the HTML unchanged).
 *
 * Deliberately NOT done here: list-page badges (N+1 query shape, a wider surface than this
 * first pass needs), any write path (these columns have no Django form field to POST to -
 * writing here would be exactly the direct-SQL-bypass pattern status-extra.js warns against,
 * and there is no sanctioned reason to write from this proxy at all - jrm-lead-intake is the
 * one door that populates them), and the phone-system "one click deeper" card - that is a
 * separate, larger build (onedesk-tokens-and-components.md), out of scope for this pass.
 */

const TIMEOUT_MS = 1500;
function withTimeout(prom) {
  return Promise.race([prom, new Promise((r) => setTimeout(() => r(null), TIMEOUT_MS))]);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function travelPartyLine(tp) {
  if (!tp || typeof tp !== "object") return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const parts = [];
  if (n(tp.adults)) parts.push(`${n(tp.adults)} adult${n(tp.adults) === 1 ? "" : "s"}`);
  if (n(tp.children)) parts.push(`${n(tp.children)} child${n(tp.children) === 1 ? "" : "ren"}`);
  if (n(tp.babies)) parts.push(`${n(tp.babies)} bab${n(tp.babies) === 1 ? "y" : "ies"}`);
  if (n(tp.rooms)) parts.push(`${n(tp.rooms)} room${n(tp.rooms) === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : null;
}

/** Build the badge strip. Every field is optional; an all-empty row prints nothing. */
export function needsAxisBadges({ kashrus, travelParty, shabbosNotes } = {}) {
  const chips = [];
  if (kashrus) chips.push(`<span class="nesher-needs-badge">Kashrus: ${esc(kashrus)}</span>`);
  const tpLine = travelPartyLine(travelParty);
  if (tpLine) chips.push(`<span class="nesher-needs-badge">Party: ${esc(tpLine)}</span>`);
  if (shabbosNotes) {
    chips.push(
      `<span class="nesher-needs-badge">Shabbos/Yom Tov: ${esc(String(shabbosNotes).slice(0, 160))}</span>`
    );
  }
  return chips.join(" ");
}

async function firstRow(pool, sql, params) {
  const out = await withTimeout(pool.query(sql, params));
  return out && out.rows && out.rows[0] ? out.rows[0] : null;
}

/**
 * Server-side needs-axis badges on the three detail pages, straight from Postgres -
 * visible no matter what Django's own templates render (they cannot render a column
 * with no model field). Soft: any DB error, a slow query, or a row with nothing set
 * returns the HTML unchanged.
 */
export async function injectNeedsAxis(html, path, pool) {
  if (!html || typeof html !== "string" || !pool) return html;
  const p = path || "";
  try {
    const custDetail = p.match(/^\/customers\/(\d+)\/?$/);
    if (custDetail) {
      const row = await firstRow(
        pool,
        `SELECT kashrus_standard FROM core_customer WHERE id = $1`,
        [Number(custDetail[1])]
      );
      const badges = row ? needsAxisBadges({ kashrus: row.kashrus_standard }) : "";
      return badges ? html.replace(/<\/h1>/i, `</h1> ${badges}`) : html;
    }

    const resDetail = p.match(/^\/reservations\/(\d+)\/?$/);
    if (resDetail) {
      const row = await firstRow(
        pool,
        `SELECT kashrus_standard, shabbos_yomtov_notes, travel_party FROM core_reservation WHERE id = $1`,
        [Number(resDetail[1])]
      );
      const badges = row
        ? needsAxisBadges({
            kashrus: row.kashrus_standard,
            travelParty: row.travel_party,
            shabbosNotes: row.shabbos_yomtov_notes,
          })
        : "";
      return badges ? html.replace(/<\/h1>/i, `</h1> ${badges}`) : html;
    }

    const hotelDetail = p.match(/^\/jrm\/hotels\/(\d+)\/?$/);
    if (hotelDetail) {
      const row = await firstRow(
        pool,
        `SELECT kashrus_standard, shabbos_yomtov_notes, travel_party FROM core_jrmhotelrequest WHERE id = $1`,
        [Number(hotelDetail[1])]
      );
      const badges = row
        ? needsAxisBadges({
            kashrus: row.kashrus_standard,
            travelParty: row.travel_party,
            shabbosNotes: row.shabbos_yomtov_notes,
          })
        : "";
      return badges ? html.replace(/<\/h1>/i, `</h1> ${badges}`) : html;
    }
  } catch (e) {
    console.error("needs-axis inject failed", e.message);
  }
  return html;
}
