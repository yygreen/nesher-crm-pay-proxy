import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSessionId,
  isAuthenticatedCrmResponse,
  validateStaffSession,
} from "../auth.js";

describe("extractSessionId", () => {
  it("returns null without cookie", () => {
    assert.equal(extractSessionId(""), null);
    assert.equal(extractSessionId(null), null);
  });
  it("rejects empty or forged values", () => {
    assert.equal(extractSessionId("sessionid=forged"), null);
    assert.equal(extractSessionId("sessionid=fake"), null);
    assert.equal(extractSessionId("sessionid=ab"), null);
  });
  it("extracts real-looking sessionid", () => {
    assert.equal(
      extractSessionId("csrftoken=x; sessionid=h0os2msrschhf4525eko8g30g12jvt0s"),
      "h0os2msrschhf4525eko8g30g12jvt0s"
    );
  });
});

describe("isAuthenticatedCrmResponse", () => {
  it("rejects login page HTML", () => {
    const html = `<title>Nesher CRM Login</title><input name="password"><button class="btn-login">`;
    assert.equal(isAuthenticatedCrmResponse(200, html, null), false);
  });
  it("rejects redirect to login", () => {
    assert.equal(
      isAuthenticatedCrmResponse(302, "", "/login/?next=/jrm/hotels/"),
      false
    );
  });
  it("accepts staff CRM HTML", () => {
    const html = `<title>Travel Agency CRM</title><a href="/jrm/hotels/">Hotels</a> Log out`;
    assert.equal(isAuthenticatedCrmResponse(200, html, null), true);
  });
});

describe("validateStaffSession", () => {
  it("fails when sessionid missing", async () => {
    const r = await validateStaffSession({
      cookieHeader: "csrftoken=only",
      upstream: "https://example.com",
      fetchImpl: async () => {
        throw new Error("should not call fetch");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "missing_or_invalid_sessionid");
  });

  it("fails for forged sessionid without calling success path", async () => {
    const r = await validateStaffSession({
      cookieHeader: "sessionid=forged",
      upstream: "https://example.com",
      fetchImpl: async () => {
        throw new Error("should not call fetch for forged");
      },
    });
    assert.equal(r.ok, false);
  });

  it("fails when CRM returns login HTML for bad session", async () => {
    const r = await validateStaffSession({
      cookieHeader: "sessionid=abcdefghijklmnopqrstuv",
      upstream: "https://crm-upstream.example",
      publicHost: "crm.flynesher.com",
      fetchImpl: async (url, init) => {
        assert.match(url, /\/jrm\/hotels\/$/);
        assert.match(init.headers.cookie, /sessionid=abcdefghijklmnopqrstuv/);
        return {
          status: 200,
          headers: { get: () => null },
          async text() {
            return `<title>Nesher CRM Login</title><form><input name="password"><button class="btn-login">`;
          },
        };
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /session_not_authenticated/);
  });

  it("succeeds when CRM returns staff page", async () => {
    const r = await validateStaffSession({
      cookieHeader: "sessionid=realstaffsessionid999",
      upstream: "https://crm-upstream.example",
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => null },
        async text() {
          return `<title>Travel Agency CRM</title><a href="/logout/">Log out</a>`;
        },
      }),
    });
    assert.equal(r.ok, true);
  });
});
