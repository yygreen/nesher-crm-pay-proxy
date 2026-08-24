/**
 * Enough DOM to run the injected browser scripts under `node --test`.
 *
 * The repo tests with hand-rolled stubs and no framework, so this stays in
 * that style rather than pulling in jsdom for a dev dependency the production
 * image (`npm ci --omit=dev`) would never install.
 *
 * Supports only what the injected scripts actually touch: tag and
 * [attribute] selectors, text content, attributes, and event dispatch.
 */

const VOID_TEXT = new Set(["INPUT", "TEXTAREA", "SELECT", "OPTION"]);

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = Object.create(null);
    this.listeners = Object.create(null);
    this.parentNode = null;
    this.className = "";
    this.id = "";
    this.value = "";
    this.type = "";
    this.placeholder = "";
    this.selected = false;
    this.style = {};
    this._text = "";
    this.focused = false;
    this.selectedText = false;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.tagName ? this.parentNode : null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(node, ref) {
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    return sibs[sibs.indexOf(this) + 1] || null;
  }

  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "id") this.id = String(v);
    if (k === "class") this.className = String(v);
  }
  getAttribute(k) {
    if (k === "id" && this.id) return this.id;
    if (k === "class" && this.className) return this.className;
    return k in this.attrs ? this.attrs[k] : null;
  }
  hasAttribute(k) {
    return this.getAttribute(k) !== null;
  }

  get textContent() {
    if (this._text) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = v == null ? "" : String(v);
    this.children = [];
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.listeners[type];
    if (l) this.listeners[type] = l.filter((f) => f !== fn);
  }

  /** Fires listeners on this node only — no bubbling; nothing under test needs it. */
  dispatch(type, event = {}) {
    const ev = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
      ...event,
    };
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }

  descendants(out = []) {
    for (const c of this.children) {
      out.push(c);
      c.descendants(out);
    }
    return out;
  }

  matches(sel) {
    const s = sel.trim();
    const attr = s.match(/^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/);
    if (attr) {
      const have = this.getAttribute(attr[1]);
      if (have === null) return false;
      return attr[2] === undefined || have === attr[2];
    }
    return this.tagName === s.toUpperCase();
  }

  querySelectorAll(sel) {
    const parts = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
    return this.descendants().filter((n) => parts.some((p) => n.matches(p)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  /** <select>.options */
  get options() {
    return this.querySelectorAll("option");
  }

  /** <select>.form — nearest enclosing <form>. */
  get form() {
    let n = this.parentElement;
    while (n) {
      if (n.tagName === "FORM") return n;
      n = n.parentElement;
    }
    return null;
  }

  focus() { this.focused = true; }
  select() { this.selectedText = true; }

  /** Debug helper: flatten to something assertable. */
  text() {
    return VOID_TEXT.has(this.tagName) ? this.value : this.textContent;
  }
}

class Document extends Node {
  constructor() {
    super("#document");
    this.readyState = "complete";
    this.body = new Node("body");
    this.appendChild(this.body);
  }
  createElement(tag) {
    return new Node(tag);
  }
  getElementById(id) {
    return this.descendants().find((n) => n.id === id) || null;
  }
}

/** Build a document from a tiny declarative tree. */
export function build(spec, doc = new Document()) {
  const make = (node) => {
    const el = doc.createElement(node.tag);
    for (const [k, v] of Object.entries(node.attrs || {})) el.setAttribute(k, v);
    if (node.text != null) el.textContent = node.text;
    if (node.value != null) el.value = node.value;
    for (const c of node.children || []) el.appendChild(make(c));
    return el;
  };
  for (const node of spec) doc.body.appendChild(make(node));
  return doc;
}

/**
 * Run an injected script in a sandbox.
 * Returns the sandbox so tests can assert on the document and the calls made.
 */
export function runScript(source, { doc, fetchImpl } = {}) {
  const document = doc || new Document();
  const calls = { fetch: [], open: [], reload: 0, clipboard: [], alert: [] };

  const sandbox = {
    document,
    calls,
    console,
    encodeURIComponent,
    JSON,
    Error,
    String,
    Number,
    setTimeout: (fn) => { fn(); return 0; },
    location: { reload: () => { calls.reload++; } },
    navigator: {
      clipboard: {
        writeText: (t) => { calls.clipboard.push(t); return Promise.resolve(); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.window.open = (url, target) => { calls.open.push({ url, target }); };
  sandbox.window.alert = (m) => { calls.alert.push(m); };
  sandbox.alert = sandbox.window.alert;
  sandbox.fetch = (url, opts) => {
    calls.fetch.push({ url, opts });
    return Promise.resolve(
      fetchImpl ? fetchImpl(url, opts) : { ok: true, json: () => Promise.resolve({ ok: true }) }
    );
  };
  return sandbox;
}

/** Pull the body out of an injected <script id="...">…</script> block. */
export function scriptBody(html, id) {
  const m = html.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>'));
  if (!m) throw new Error("no script block " + id);
  return m[1];
}

export { Node, Document };
