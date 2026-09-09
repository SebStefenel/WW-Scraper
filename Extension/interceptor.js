// Runs in the PAGE (MAIN) world at document_start so it can wrap the page's own
// network calls before any page script runs. It does nothing but observe: every
// fetch / XMLHttpRequest is summarized and posted to the isolated content script
// via window.postMessage. No requests are modified or blocked.
(() => {
  const TAG = "WWS_NET";
  const ORIGIN = window.location.origin;

  // This file is installed twice on purpose — declared as a MAIN-world content
  // script (fast, but needs Chrome 111+ and has had ordering bugs) and injected
  // as a <script> tag by content.js (works everywhere). Whichever wins, patch once.
  if (window.__wwsInstalled) return;
  window.__wwsInstalled = true;

  const post = (payload) => {
    try {
      window.postMessage({ __wws: TAG, payload }, ORIGIN);
    } catch (_) {}
  };

  // Lets the panel show whether hooks are actually live in the page.
  post({ kind: "__ready", url: location.href });

  const summarizeBody = (body) => {
    if (body == null) return null;
    if (typeof body === "string") return body.slice(0, 20000);
    try {
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) {
        return (
          "[FormData] " +
          [...body.entries()]
            .map(([k, v]) => `${k}=${typeof v === "string" ? v : "[file]"}`)
            .join("&")
        );
      }
      if (body instanceof Blob) return `[Blob ${body.type} ${body.size}b]`;
      if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength}b]`;
      return "[" + (body.constructor ? body.constructor.name : typeof body) + "]";
    } catch (_) {
      return "[unserializable body]";
    }
  };

  // ---- fetch ----------------------------------------------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const [input, init = {}] = args;
      const url =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input && input.url;
      const method = String(
        init.method || (input && input.method) || "GET"
      ).toUpperCase();
      const body = summarizeBody(init.body);
      const started = Date.now();
      return origFetch.apply(this, args).then(
        async (res) => {
          let preview = "";
          try {
            preview = (await res.clone().text()).slice(0, 4000);
          } catch (_) {}
          post({
            kind: "fetch",
            url,
            method,
            body,
            status: res.status,
            contentType: res.headers.get("content-type") || "",
            preview,
            ms: Date.now() - started,
          });
          return res;
        },
        (err) => {
          post({ kind: "fetch", url, method, body, error: String(err) });
          throw err;
        }
      );
    };
  }

  // ---- XMLHttpRequest ------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    this.__wws = { method: String(method || "GET").toUpperCase(), url: String(url) };
    return origOpen.apply(this, arguments);
  };

  // ---- form submissions ----------------------------------------------------
  // Orbis opens a posting by submitting a hidden form, which is a document
  // navigation rather than fetch/XHR — invisible to the hooks above. Capture it
  // on the way out so the posting request survives the page unload.
  function reportForm(form, submitter) {
    if (!form || form.tagName !== "FORM") return;
    try {
      const fd = new FormData(form);
      // include the button that triggered the submit; Orbis often keys off it
      if (submitter && submitter.name) fd.append(submitter.name, submitter.value || "");

      const pairs = [...fd.entries()]
        .map(
          ([k, v]) =>
            `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === "string" ? v : "")}`
        )
        .join("&");

      const method = String(form.method || "GET").toUpperCase();
      let url = form.action || window.location.href;
      let body = pairs;
      if (method === "GET") {
        url += (url.includes("?") ? "&" : "?") + pairs;
        body = null;
      }
      post({ kind: "form", url, method, body, status: 0, contentType: "", preview: "" });
    } catch (_) {}
  }

  // User-driven submits, capture phase so we see them even if propagation stops.
  document.addEventListener("submit", (ev) => reportForm(ev.target, ev.submitter), true);

  // Programmatic form.submit() fires NO submit event — a DOM quirk, and exactly
  // how Orbis opens a posting. Without this hook the request is invisible.
  const origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    reportForm(this, null);
    return origSubmit.apply(this, arguments);
  };

  // requestSubmit() does fire the event, but only if the form is valid; hook it
  // too so a rejected submit still shows up as an attempt.
  if (HTMLFormElement.prototype.requestSubmit) {
    const origRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.requestSubmit = function (submitter) {
      reportForm(this, submitter);
      return origRequestSubmit.apply(this, arguments);
    };
  }

  XHR.prototype.send = function (body) {
    const meta = this.__wws || {};
    const summarized = summarizeBody(body);
    const started = Date.now();
    this.addEventListener("loadend", () => {
      let preview = "";
      try {
        if (this.responseType === "" || this.responseType === "text") {
          preview = String(this.responseText || "").slice(0, 4000);
        } else if (this.responseType === "json") {
          preview = JSON.stringify(this.response).slice(0, 4000);
        }
      } catch (_) {}
      let contentType = "";
      try {
        contentType = this.getResponseHeader("content-type") || "";
      } catch (_) {}
      post({
        kind: "xhr",
        url: meta.url,
        method: meta.method,
        body: summarized,
        status: this.status,
        contentType,
        preview,
        ms: Date.now() - started,
      });
    });
    return origSend.apply(this, arguments);
  };
})();
