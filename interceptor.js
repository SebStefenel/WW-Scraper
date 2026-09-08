// Runs in the PAGE (MAIN) world at document_start so it can wrap the page's own
// network calls before any page script runs. It does nothing but observe: every
// fetch / XMLHttpRequest is summarized and posted to the isolated content script
// via window.postMessage. No requests are modified or blocked.
(() => {
  const TAG = "WWS_NET";
  const ORIGIN = window.location.origin;

  const post = (payload) => {
    try {
      window.postMessage({ __wws: TAG, payload }, ORIGIN);
    } catch (_) {}
  };

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
