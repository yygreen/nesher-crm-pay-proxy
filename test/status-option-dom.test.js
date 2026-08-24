/**
 * Runs the INJECTED browser script against a small DOM stub.
 *
 * The Change Status markup lives in the Django CRM, so this is the only place
 * the selection heuristic, the option append and the submit intercept can be
 * exercised before it reaches a real page. The fixture deliberately carries a
 * second status-ish <select> (the per-offer answer status), because binding to
 * the wrong control is the failure mode that would silently write the wrong row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { injectStatusOption, STATUS_LABEL } from "../status-option.js";

class El {
  constructor(tag, attrs = {}, text = "") {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this._text = text;
    this.listeners = {};
    this.className = "";
    this.value = attrs.value == null ? "" : attrs.value;
  }
  get id() { return this.attrs.id || ""; }
  getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  get parentNode() { return this.parentElement; }
  get nextSibling() {
    if (!this.parentElement) return null;
    const i = this.parentElement.children.indexOf(this);
    return this.parentElement.children[i + 1] || null;
  }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  insertBefore(node, ref) {
    node.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get options() { return this.children.filter((c) => c.tagName === "OPTION"); }
  descendants() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c.descendants()); }
    return out;
  }
  querySelectorAll(sel) {
    const tags = sel.split(",").map((s) => s.trim().toUpperCase());
    return this.descendants().filter((e) => tags.includes(e.tagName));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, ev) { for (const fn of this.listeners[type] || []) fn(ev); }
}

/** Mirrors the fixture markup in status-option.test.js. */
function buildPage() {
  const doc = new El("#document");
  const body = new El("body");
  doc.appendChild(body);

  body.appendChild(new El("h1", {}, "Hotel request 87"));

  const card = new El("div", { class: "card" });
  card.appendChild(new El("h3", {}, "Change Status"));
  const form = new El("form", { method: "post" });
  const sel = new El("select", { name: "status" });
  sel.appendChild(new El("option", { value: "New" }, "New"));
  sel.appendChild(new El("option", { value: "Quoted" }, "Quoted"));
  sel.value = "New";
  sel.form = form;
  form.appendChild(sel);
  form.appendChild(new El("button", { type: "submit" }, "Update Status"));
  card.appendChild(form);
  body.appendChild(card);

  // decoy: another status-named select elsewhere on the page
  const decoy = new El("select", { name: "customer_answer_status" });
  decoy.appendChild(new El("option", { value: "" }, "--"));
  decoy.form = new El("form");
  body.appendChild(decoy);

  doc.body = body;
  doc.createElement = (t) => new El(t);
  return { doc, body, sel, decoy, form };
}

function scriptSource() {
  const html = injectStatusOption(
    "<html><body><select name='status'></select></body></html>",
    "/jrm/hotels/87/"
  );
  const m = html.match(/<script id="nesher-status-option-js">([\s\S]*?)<\/script>/);
  assert.ok(m, "script block present");
  return m[1];
}

/** Boot the injected script over the stub; returns the recorded calls. */
function run({ getBody = { ok: true, value: STATUS_LABEL, label: STATUS_LABEL, current: "New" }, postOk = true, postBody = null } = {}) {
  const page = buildPage();
  const calls = [];
  let reloads = 0;

  const fetchStub = (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if ((opts.method || "GET") === "GET") {
      return Promise.resolve({ ok: true, json: async () => getBody });
    }
    return Promise.resolve({
      ok: postOk,
      json: async () => postBody || (postOk ? { ok: true, status: STATUS_LABEL } : { error: "nope" }),
    });
  };

  const sandbox = {
    document: page.doc,
    fetch: fetchStub,
    location: { reload: () => { reloads++; } },
    setTimeout: (fn) => fn(),
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(scriptSource()).runInContext(sandbox);
  return { page, calls, reloads: () => reloads };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("injected browser script", () => {
  it("binds to the Change Status select, not the per-offer one", async () => {
    const { page } = run();
    await tick();
    assert.equal(page.sel.getAttribute("data-nesher-status-option"), "1");
    assert.equal(page.decoy.getAttribute("data-nesher-status-option"), null);
  });

  it("asks the proxy for the value before touching the dropdown", async () => {
    const { calls, page } = run();
    assert.equal(page.sel.options.length, 2, "no option added before the API answers");
    await tick();
    assert.deepEqual(calls[0], { url: "/__nesher_status/hotel/87/", method: "GET", body: null });
  });

  it("appends the new option with the right label and value", async () => {
    const { page } = run();
    await tick();
    const opts = page.sel.options;
    assert.equal(opts.length, 3);
    assert.equal(opts[2].value, STATUS_LABEL);
    assert.equal(opts[2].textContent, STATUS_LABEL);
    assert.equal(opts[2].getAttribute("data-nesher-status-option"), "1");
  });

  it("re-selects the option when the stored status is already ours", async () => {
    const { page } = run({
      getBody: { ok: true, value: STATUS_LABEL, label: STATUS_LABEL, current: STATUS_LABEL },
    });
    await tick();
    assert.equal(page.sel.value, STATUS_LABEL, "would otherwise display as New");
  });

  it("leaves the selection alone for a normal CRM status", async () => {
    const { page } = run();
    await tick();
    assert.equal(page.sel.value, "New");
  });

  it("intercepts submit and saves through the proxy when ours is picked", async () => {
    const { page, calls, reloads } = run();
    await tick();
    page.sel.value = STATUS_LABEL;
    let prevented = false;
    page.form.fire("submit", {
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    });
    await tick();
    await tick();
    assert.equal(prevented, true, "the CRM form must not post a value it rejects");
    const post = calls.find((c) => c.method === "POST");
    assert.deepEqual(post, {
      url: "/__nesher_status/hotel/87/",
      method: "POST",
      body: { status: STATUS_LABEL },
    });
    assert.equal(reloads(), 1);
  });

  it("lets a normal status submit to the CRM untouched", async () => {
    const { page, calls } = run();
    await tick();
    page.sel.value = "Quoted";
    let prevented = false;
    page.form.fire("submit", {
      preventDefault: () => { prevented = true; },
      stopPropagation: () => {},
    });
    await tick();
    assert.equal(prevented, false);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  it("surfaces a failed save instead of failing silently", async () => {
    const { page, reloads } = run({ postOk: false, postBody: { error: "Login required" } });
    await tick();
    page.sel.value = STATUS_LABEL;
    page.form.fire("submit", { preventDefault: () => {}, stopPropagation: () => {} });
    await tick();
    await tick();
    const note = page.form.children.find((c) => c.tagName === "P");
    assert.match(note.className, /err/);
    assert.equal(note.textContent, "Login required");
    assert.equal(reloads(), 0, "no reload on failure — the message must stay visible");
  });

  it("does nothing at all if the proxy cannot answer", async () => {
    const { page } = run({ getBody: { ok: false } });
    await tick();
    assert.equal(page.sel.options.length, 2);
  });
});
