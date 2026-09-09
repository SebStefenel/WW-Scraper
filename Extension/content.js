// Isolated-world content script. Owns all the actual work:
//   - buffers network events reported by interceptor.js
//   - turns one observed "open a posting" request into a reusable template
//   - enumerates posting IDs off the job-search table
//   - replays the template for every ID, parses the response, stores results
// The popup is a thin remote control over this file via chrome.runtime messaging.

const LOG = "[WWS]";
const NET_BUFFER_MAX = 300;
const ID_RE = /\b\d{5,7}\b/g;

const state = {
  net: [], // recent network events
  netSeq: 0, // monotonic id; array indices shift as the buffer rolls
  interceptorReady: false,
  learnStartedAt: 0,
  learning: false,
  rows: new Map(), // id -> { id, title, listFields }
  results: new Map(), // id -> parsed posting
  scraping: false,
  abort: false,
  progress: null,
};

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) =>
  String(s == null ? "" : s)
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function emit(msg) {
  state.progress = msg;
  try {
    chrome.runtime.sendMessage({ type: "wws:progress", ...msg });
  } catch (_) {
    // popup closed — that's fine, the scrape keeps running
  }
}

async function waitFor(pred, timeoutMs = 8000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (pred()) return true;
    } catch (_) {}
    await sleep(stepMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// network capture
// ---------------------------------------------------------------------------
let netSaveTimer = null;

// While learning we mirror the buffer to storage, because the request that
// opens a posting is usually a navigation — the page unloads a moment later and
// would otherwise take the capture with it.
function persistNetLog() {
  clearTimeout(netSaveTimer);
  netSaveTimer = setTimeout(() => {
    chrome.storage.local.set({
      wws_netlog: state.net.slice(-80),
      wws_learn: { learning: state.learning, startedAt: state.learnStartedAt },
    });
  }, 250);
}

// Backstop for the MAIN-world content script, which some Chrome builds either
// don't support or run too late to catch the page's own network calls.
(function injectInterceptor() {
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("interceptor.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (err) {
    console.warn(LOG, "interceptor injection failed", err);
  }
})();

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__wws !== "WWS_NET" || !d.payload) return;

  if (d.payload.kind === "__ready") {
    state.interceptorReady = true;
    console.log(LOG, "interceptor active in page");
    return;
  }

  const e = { ...d.payload, at: Date.now(), i: state.netSeq++ };
  state.net.push(e);
  if (state.net.length > NET_BUFFER_MAX) state.net.shift();
  if (state.learning) persistNetLog();
});

// Requests worth showing the user when they're hunting for the detail call.
function interestingEvents(sinceTs, showAll) {
  return state.net
    .filter((e) => e.at >= sinceTs)
    .filter((e) => {
      if (e.error) return false;
      const u = String(e.url || "");
      if (/\.(css|js|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)(\?|$)/i.test(u)) return false;
      if (showAll) return true;
      // Form submits are navigations: they never have a response body here, so
      // judging them on payload size would hide exactly what we're after.
      if (e.kind === "form") return true;
      const blob = u + " " + (e.body || "");
      const looksRelevant =
        e.method !== "GET" || /job|posting|position|detail|view|search|info/i.test(blob);
      return looksRelevant && (e.preview || "").length > 200;
    })
    .map((e) => ({
      i: e.i,
      kind: e.kind,
      method: e.method,
      url: e.url,
      body: e.body ? e.body.slice(0, 1500) : null,
      status: e.status,
      contentType: e.contentType,
      bytes: (e.preview || "").length,
      preview: (e.preview || "").slice(0, 240),
      at: e.at,
    }))
    .reverse();
}

// ---------------------------------------------------------------------------
// template building — turn one observed request into a parameterized one
// ---------------------------------------------------------------------------
function buildTemplate(eventIndex, explicitId) {
  const e = state.net.find((x) => x.i === eventIndex);
  if (!e) return { ok: false, error: "That request is no longer in the buffer." };

  let body = e.body;
  let contentType = null;
  if (body && body.startsWith("[FormData] ")) {
    body = body.slice("[FormData] ".length);
    contentType = "application/x-www-form-urlencoded";
  } else if (body && /^\[[A-Za-z]/.test(body)) {
    return {
      ok: false,
      error: `Request body was ${body} — this extension can only replay text/urlencoded bodies.`,
    };
  } else if (body) {
    contentType = /^\s*[{[]/.test(body)
      ? "application/json"
      : "application/x-www-form-urlencoded";
  }

  const haystack = `${e.url}\n${body || ""}`;
  let id = explicitId ? String(explicitId).trim() : null;

  if (!id) {
    // Prefer a number that also appears as a posting ID in the visible table.
    const known = new Set([...state.rows.keys(), ...scanCurrentPage().map((r) => r.id)]);
    const found = [...new Set(haystack.match(ID_RE) || [])];
    const matches = found.filter((n) => known.has(n));
    if (matches.length === 1) id = matches[0];
    else if (found.length === 1) id = found[0];
    else
      return {
        ok: false,
        needPostingId: true,
        candidates: found.slice(0, 12),
        error:
          found.length === 0
            ? "No posting ID found in that request."
            : "Ambiguous posting ID — tell me which posting you opened.",
      };
  }

  if (!haystack.includes(id)) {
    return { ok: false, needPostingId: true, error: `ID ${id} doesn't appear in that request.` };
  }

  const template = {
    method: e.method || "GET",
    url: e.url.split(id).join("{{ID}}"),
    body: body ? body.split(id).join("{{ID}}") : null,
    contentType,
    sampleId: id,
    responseContentType: e.contentType || "",
    capturedAt: Date.now(),
  };
  return { ok: true, template };
}

async function saveTemplate(template) {
  await chrome.storage.local.set({ wws_detailTemplate: template });
}
async function loadTemplate() {
  const { wws_detailTemplate } = await chrome.storage.local.get("wws_detailTemplate");
  return wws_detailTemplate || null;
}

// ---------------------------------------------------------------------------
// posting ID enumeration off the job-search table
// ---------------------------------------------------------------------------
// Row shape (Vue-rendered):
//   <tr class="table__row--body">
//     <th scope="row"> … <input name="dataViewerSelection" value="485614"> …
//                        <span class="overflow--ellipsis">485614</span> </th>
//     <td class="table__value"><a class="overflow--ellipsis">Job Title</a></td>
//     … 7 more <td> …
// The ID has to come off the checkbox: the <th>'s own text also contains
// "Select Row" plus the material-icon names of its four action buttons.
function scanCurrentPage() {
  const out = [];
  const seen = new Set();

  document.querySelectorAll("tr.table__row--body, tbody tr").forEach((tr) => {
    const cb = tr.querySelector(
      'input[name="dataViewerSelection"], input[id^="resultRow_"]'
    );
    let id = cb ? clean(cb.value || "") : "";
    if (!/^\d{5,7}$/.test(id)) {
      const m = /resultRow_(\d{5,7})/.exec(tr.innerHTML || "");
      id = m ? m[1] : "";
    }
    if (!/^\d{5,7}$/.test(id) || seen.has(id)) return;
    seen.add(id);

    const table = tr.closest("table");
    const headers = table
      ? [...table.querySelectorAll("thead th, thead td")].map((h) => clean(h.textContent))
      : [];

    const listFields = {};
    [...tr.querySelectorAll("th, td")].forEach((cell, i) => {
      // the ellipsis span/anchor holds just the display value, without the
      // surrounding checkbox label and icon glyph names
      const inner = cell.querySelector(".overflow--ellipsis");
      const val = clean(inner ? inner.textContent : cell.textContent);
      if (!val) return;
      const key = headers[i] || `col${i}`;
      listFields[key] = val;
    });
    listFields.ID = id;

    const link = tr.querySelector("td a");
    out.push({
      id,
      title: link ? clean(link.textContent) : listFields["Job Title"] || "",
      listFields,
    });
  });

  return out;
}

function firstRowId() {
  const r = scanCurrentPage();
  return r.length ? r[0].id : null;
}

function findNextPageButton() {
  const cands = [...document.querySelectorAll('button, a, [role="button"]')];
  return cands.find((el) => {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    const cls = typeof el.className === "string" ? el.className : "";
    if (/disabled/i.test(cls)) return false;
    if (el.offsetParent === null) return false; // not visible

    const s = [
      el.getAttribute("aria-label") || "",
      el.title || "",
      cls,
      clean(el.textContent).slice(0, 40), // material-icons render as their glyph name
    ].join(" ");

    // "last page" / "»" would skip straight to the end, and "previous" walks
    // backwards — both must lose to an actual next control.
    if (/\b(last|first|prev|previous|back)\b|«|»|‹|skip[-_ ]?to/i.test(s)) return false;
    return /\bnext\b|navigate[-_ ]?next|chevron[-_ ]?right|keyboard[-_ ]?arrow[-_ ]?right|arrow[-_ ]?forward|›/i.test(
      s
    );
  });
}

function mergeRows(rows) {
  rows.forEach((r) => {
    const prev = state.rows.get(r.id);
    state.rows.set(r.id, prev ? { ...prev, ...r, listFields: { ...prev.listFields, ...r.listFields } } : r);
  });
}

// Reports where posting IDs actually live in the DOM, so row detection can be
// written against the real markup instead of guessed at.
function debugListDom() {
  const info = {
    url: location.href,
    title: document.title,
    iframes: document.querySelectorAll("iframe").length,
    tables: [],
    idNodes: [],
    rowSample: "",
    scanFound: scanCurrentPage().length,
  };

  document.querySelectorAll('table, [role="table"], [role="grid"]').forEach((t, i) => {
    info.tables.push({
      i,
      tag: t.tagName.toLowerCase(),
      cls: String(t.className || "").slice(0, 140),
      rows: t.querySelectorAll('tr, [role="row"]').length,
      cells: t.querySelectorAll('td, [role="cell"], [role="gridcell"]').length,
    });
  });

  // anything with a shadow root would be invisible to querySelectorAll
  let shadowHosts = 0;
  document.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) shadowHosts++;
  });
  info.shadowHosts = shadowHosts;

  const describe = (el) =>
    el.tagName.toLowerCase() +
    (el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
      : "");

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && info.idNodes.length < 10) {
    const t = (node.nodeValue || "").trim();
    if (!/^\d{5,7}$/.test(t)) continue;
    const chain = [];
    let el = node.parentElement;
    for (let h = 0; el && h < 7; h++) {
      chain.push(describe(el));
      el = el.parentElement;
    }
    info.idNodes.push({ id: t, chain });
    if (!info.rowSample) {
      // walk up to something row-shaped and capture its markup
      let row = node.parentElement;
      for (let h = 0; row && h < 6; h++) {
        if (row.tagName === "TR" || row.getAttribute("role") === "row") break;
        row = row.parentElement;
      }
      row = row || node.parentElement;
      info.rowSample = (row.outerHTML || "").slice(0, 12000);
    }
  }

  return info;
}

async function scanWithPagination(maxPages) {
  if (state.scanning) return; // clicking the button twice must not race
  state.scanning = true;
  for (let p = 0; p < maxPages; p++) {
    mergeRows(scanCurrentPage());
    emit({ phase: "ids", done: state.rows.size, total: 0, message: `page ${p + 1} · ${state.rows.size} IDs` });
    if (state.abort) break;

    const btn = findNextPageButton();
    if (!btn) {
      emit({ phase: "ids", done: state.rows.size, total: 0, message: `no next-page control found · ${state.rows.size} IDs` });
      break;
    }
    const before = firstRowId();
    btn.click();
    const changed = await waitFor(() => firstRowId() && firstRowId() !== before, 10000);
    if (!changed) {
      emit({ phase: "ids", done: state.rows.size, total: 0, message: `last page · ${state.rows.size} IDs` });
      break;
    }
    await sleep(700);
  }
  await persistRows();
  state.scanning = false;
  emit({ phase: "ids", done: state.rows.size, total: 0, message: `done · ${state.rows.size} IDs`, finished: true });
}

async function persistRows() {
  await chrome.storage.local.set({ wws_rows: Object.fromEntries(state.rows) });
}
async function persistResults() {
  // Stored without rawHtml to keep storage sane; the download uses in-memory copies.
  const slim = {};
  for (const [id, v] of state.results) {
    const { raw, ...rest } = v;
    slim[id] = { ...rest, raw: { text: raw && raw.text ? raw.text : "" } };
  }
  await chrome.storage.local.set({ wws_results: slim });
}

// ---------------------------------------------------------------------------
// detail parsing (format-agnostic: JSON or HTML, always keeps raw text)
// ---------------------------------------------------------------------------
function flattenJson(obj, prefix, out) {
  if (obj == null) return out;
  if (Array.isArray(obj)) {
    if (obj.every((v) => v == null || typeof v !== "object")) {
      out[prefix] = obj.join(", ");
    } else {
      obj.forEach((v, i) => flattenJson(v, `${prefix}[${i}]`, out));
    }
    return out;
  }
  if (typeof obj === "object") {
    Object.entries(obj).forEach(([k, v]) => flattenJson(v, prefix ? `${prefix}.${k}` : k, out));
    return out;
  }
  out[prefix] = obj;
  return out;
}

// textContent flattens <br> and <li> into an unreadable run-on, which matters
// for the long prose fields (summary, responsibilities, skills). Rebuild the
// line breaks the markup implies.
function richText(el) {
  if (!el) return "";
  const c = el.cloneNode(true);
  // Interactive chrome ("View Targeted Degrees and Disciplines") is not content.
  c.querySelectorAll("script, style, button, noscript").forEach((e) => e.remove());
  c.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  c.querySelectorAll("li").forEach((li) => li.prepend("• "));
  c.querySelectorAll("li, p, div, tr").forEach((b) => b.append("\n"));
  // Orbis nests wrapper divs many levels deep, which yields runs of blank lines.
  return clean(c.textContent)
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sectionText(h) {
  const parts = [];
  let n = h.nextElementSibling;
  let hops = 0;
  while (n && hops < 40) {
    if (/^H[1-6]$/.test(n.tagName)) break;
    if (n.querySelector && n.querySelector("h1,h2,h3,h4,h5,h6")) break;
    const t = clean(n.textContent);
    if (t) parts.push(t);
    n = n.nextElementSibling;
    hops++;
  }
  return parts.join("\n");
}

// WaterlooWorks renders every posting field as:
//   <div class="tag__key-value-list">
//     <span class="label">Work Term:</span>
//     <p>2027 - Winter</p>          <- or a nested <table> for multi-value
//   </div>
// grouped into <div class="panel"> sections titled by <h4 class="heading--banner">.
function parseWaterlooWorks(doc, out) {
  const blocks = doc.querySelectorAll(".tag__key-value-list");
  if (!blocks.length) return false;

  blocks.forEach((block) => {
    const labelEl = block.querySelector("span.label, .label");
    if (!labelEl) return;
    const key = clean(labelEl.textContent).replace(/\s*:\s*$/, "");
    if (!key) return;

    // Read from the whole block, not from the <p>. Multi-value fields nest a
    // <table>, and HTML parsing forbids a <table>/<div> inside <p> — the browser
    // auto-closes the paragraph, leaving the real value as its sibling.
    const cells = block.querySelectorAll("td.table__value, td");
    let value;
    if (cells.length) {
      const list = [...cells].map((c) => clean(c.textContent)).filter(Boolean);
      value = list.length === 1 ? list[0] : list;
    } else {
      const copy = block.cloneNode(true);
      copy.querySelectorAll(".label").forEach((e) => e.remove());
      value = richText(copy);
      // short values pick up stray breaks from wrapper divs ("Sep 17, 2026\n\n9:00 AM")
      if (value.length < 80) value = value.replace(/\s*\n+\s*/g, " ").trim();
    }
    if (value === "" || (Array.isArray(value) && !value.length)) return;

    out.fields[key] = value;

    const panel = block.closest(".panel");
    const heading = panel && panel.querySelector(".heading--banner");
    const section = heading ? clean(heading.textContent) : "Other";
    (out.panels[section] = out.panels[section] || {})[key] = value;
  });

  return Object.keys(out.fields).length > 0;
}

function parseDetail(text, contentType, sourceUrl, id, includeRawHtml) {
  const out = {
    id,
    scrapedAt: new Date().toISOString(),
    source: sourceUrl,
    fields: {},
    panels: {},
    sections: {},
    raw: {},
  };

  const ct = (contentType || "").toLowerCase();
  if (ct.includes("json") || /^\s*[{[]/.test(text)) {
    try {
      const json = JSON.parse(text);
      out.fields = flattenJson(json, "", {});
      out.raw.json = json;
      out.raw.text = clean(JSON.stringify(json)).slice(0, 200000);
      return out;
    } catch (_) {
      // not really JSON — fall through to HTML parsing
    }
  }

  const doc = new DOMParser().parseFromString(text, "text/html");

  // The precise path. Everything below is fallback for if Orbis restyles.
  if (parseWaterlooWorks(doc, out)) {
    out.raw.text = richText(doc.body).slice(0, 200000);
    if (includeRawHtml) out.raw.html = text;
    return out;
  }

  const kv = {};

  // two-cell table rows: the dominant pattern in Orbis posting panels
  doc.querySelectorAll("tr").forEach((tr) => {
    const cells = tr.querySelectorAll("th, td");
    if (cells.length !== 2) return;
    const k = clean(cells[0].textContent);
    const v = clean(cells[1].textContent);
    if (k && v && k.length <= 120) kv[k] = v;
  });

  // definition lists
  doc.querySelectorAll("dl").forEach((dl) => {
    const dts = dl.querySelectorAll("dt");
    const dds = dl.querySelectorAll("dd");
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
      const k = clean(dts[i].textContent);
      const v = clean(dds[i].textContent);
      if (k && v) kv[k] = v;
    }
  });

  // label/value sibling divs
  doc.querySelectorAll('[class*="label"], [class*="key"]').forEach((el) => {
    const k = clean(el.textContent);
    const sib = el.nextElementSibling;
    if (!k || k.length > 120 || !sib) return;
    const cls = typeof sib.className === "string" ? sib.className : "";
    if (!/value|content|data|desc/i.test(cls)) return;
    const v = clean(sib.textContent);
    if (v) kv[k] = v;
  });

  out.fields = kv;

  doc.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    const title = clean(h.textContent);
    if (!title || title.length > 120) return;
    const body = sectionText(h);
    if (body && body.length > 20) out.sections[title] = body;
  });

  out.raw.text = clean(doc.body ? doc.body.textContent : text).slice(0, 200000);
  if (includeRawHtml) out.raw.html = text;
  return out;
}

// ---------------------------------------------------------------------------
// the scrape loop
// ---------------------------------------------------------------------------
function looksLikeLoginWall(text, url) {
  return (
    /central authentication service|duo security|sign in to waterloo|<title>[^<]*login/i.test(
      text.slice(0, 4000)
    ) || /login|adfs|auth/i.test(url)
  );
}

async function fetchDetail(id, template) {
  const url = template.url.split("{{ID}}").join(id);
  const body = template.body ? template.body.split("{{ID}}").join(id) : undefined;
  const headers = {};
  if (template.contentType && body != null) headers["content-type"] = template.contentType;
  headers["x-requested-with"] = "XMLHttpRequest";

  const res = await fetch(url, {
    method: template.method || "GET",
    headers,
    body,
    credentials: "include",
  });
  // WaterlooWorks serves ISO-8859-1, so res.text() (which assumes UTF-8)
  // mangles accented characters — "Résumé" arrives as "R?sum?".
  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();
  const m = /charset=([\w-]+)/i.exec(contentType);
  let text;
  try {
    text = new TextDecoder(m ? m[1] : "utf-8").decode(buf);
  } catch (_) {
    text = new TextDecoder("utf-8").decode(buf);
  }
  return { status: res.status, contentType, text, url: res.url || url };
}

async function scrapeAll({ delayMs = 1500, includeRawHtml = false, skipExisting = true }) {
  const template = await loadTemplate();
  if (!template) {
    emit({ phase: "scrape", done: 0, total: 0, message: "No detail template learned yet.", finished: true, error: true });
    return;
  }

  // Without this, a second click runs an overlapping loop against the same
  // results Map and emits a second finish event — i.e. a second auto-save.
  if (state.scraping) {
    emit({ phase: "scrape", done: 0, total: 0, message: "A scrape is already running." });
    return;
  }

  const ids = [...state.rows.keys()].filter((id) => !(skipExisting && state.results.has(id)));
  state.scraping = true;
  state.abort = false;

  let done = 0;
  let consecutiveFailures = 0;

  for (const id of ids) {
    if (state.abort) break;
    try {
      const r = await fetchDetail(id, template);

      if (r.status >= 400 || looksLikeLoginWall(r.text, r.url)) {
        consecutiveFailures++;
        emit({
          phase: "scrape",
          done,
          total: ids.length,
          message: `id ${id}: HTTP ${r.status}${looksLikeLoginWall(r.text, r.url) ? " (login wall)" : ""}`,
        });
        if (consecutiveFailures >= 3) {
          emit({
            phase: "scrape",
            done,
            total: ids.length,
            message:
              "Stopped after 3 failures in a row. Your session or the captured token may have expired — reload WaterlooWorks and re-learn the template.",
            finished: true,
            error: true,
          });
          break;
        }
      } else {
        consecutiveFailures = 0;
        const parsed = parseDetail(r.text, r.contentType, r.url, id, includeRawHtml);
        const row = state.rows.get(id);
        parsed.listFields = row ? row.listFields : {};
        parsed.title = (row && row.title) || parsed.fields["Job Title"] || "";
        state.results.set(id, parsed);
      }
    } catch (err) {
      consecutiveFailures++;
      emit({ phase: "scrape", done, total: ids.length, message: `id ${id}: ${err}` });
    }

    done++;
    if (done % 10 === 0) await persistResults();
    emit({
      phase: "scrape",
      done,
      total: ids.length,
      message: `${done}/${ids.length} · ${state.results.size} stored`,
    });

    // jittered delay so we're not a metronome hammering their server
    const jitter = delayMs * (0.7 + Math.random() * 0.6);
    await sleep(jitter);
  }

  await persistResults();
  state.scraping = false;
  emit({
    phase: "scrape",
    done,
    total: ids.length,
    message: state.abort ? `stopped · ${state.results.size} stored` : `done · ${state.results.size} stored`,
    finished: true,
  });
}

// ---------------------------------------------------------------------------
// download (done here, not in a service worker, so Blob URLs are available)
// ---------------------------------------------------------------------------
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// A stable filename, deliberately: a timestamped one turns every re-save into a
// new file, so duplicates accumulate by construction. Overwriting is idempotent,
// and meta.generatedAt still records when the export was built.
const RESULTS_FILENAME = "waterlooworks-postings.json";

// How long after a save a request for the same data, to the same destination,
// is treated as redundant. Covers the auto-save-then-manual-click sequence and
// the case where two panel contexts both react to the same finish event.
const SAVE_DEDUPE_MS = 60000;

// count + newest scrapedAt: changes exactly when there is new data to write.
function resultsSignature() {
  let newest = "";
  for (const r of state.results.values()) {
    if (r.scrapedAt && r.scrapedAt > newest) newest = r.scrapedAt;
  }
  return `${state.results.size}:${newest}`;
}

// The panel asks for these payloads and writes them into the folder you picked.
// Blob download is only the fallback when no folder is set.
async function buildResultsPayload() {
  const template = await loadTemplate();
  return {
    filename: RESULTS_FILENAME,
    data: {
      meta: {
        generatedAt: new Date().toISOString(),
        count: state.results.size,
        idsKnown: state.rows.size,
        template: template ? { method: template.method, url: template.url } : null,
      },
      postings: [...state.results.values()],
    },
  };
}

async function buildRawPayload() {
  const template = await loadTemplate();
  if (!template) return { ok: false, error: "No template learned yet." };
  const id = [...state.rows.keys()][0] || template.sampleId;
  if (!id) return { ok: false, error: "No posting IDs known — scan the list first." };
  const r = await fetchDetail(id, template);
  return {
    ok: true,
    id,
    status: r.status,
    bytes: r.text.length,
    filename: `waterlooworks-raw-${id}.json`,
    data: {
      id,
      request: template,
      status: r.status,
      contentType: r.contentType,
      finalUrl: r.url,
      body: r.text,
      parsed: parseDetail(r.text, r.contentType, r.url, id, false),
    },
  };
}

// ---------------------------------------------------------------------------
// restore prior session state
// ---------------------------------------------------------------------------
(async () => {
  const { wws_rows, wws_results, wws_netlog, wws_learn } = await chrome.storage.local.get([
    "wws_rows",
    "wws_results",
    "wws_netlog",
    "wws_learn",
  ]);
  if (wws_rows) Object.entries(wws_rows).forEach(([id, r]) => state.rows.set(id, r));
  if (wws_results) Object.entries(wws_results).forEach(([id, r]) => state.results.set(id, r));

  // Carry a learning session across the navigation it just triggered.
  if (wws_learn && wws_learn.learning) {
    state.learning = true;
    state.learnStartedAt = wws_learn.startedAt || 0;
    if (Array.isArray(wws_netlog) && wws_netlog.length) {
      state.net = wws_netlog.slice();
      state.netSeq = Math.max(...wws_netlog.map((e) => e.i || 0)) + 1;
    }
  }
  console.log(
    LOG,
    `restored ${state.rows.size} IDs, ${state.results.size} results, ${state.net.length} captured`
  );
})();

// ---------------------------------------------------------------------------
// popup message API
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.cmd) {
      case "state": {
        const template = await loadTemplate();
        sendResponse({
          ok: true,
          url: location.href,
          interceptorReady: state.interceptorReady,
          captured: state.net.length,
          hasTemplate: !!template,
          template: template
            ? { method: template.method, url: template.url, sampleId: template.sampleId }
            : null,
          idCount: state.rows.size,
          resultCount: state.results.size,
          scraping: state.scraping,
          learning: state.learning,
          progress: state.progress,
        });
        break;
      }
      case "learn:start":
        state.learning = true;
        state.learnStartedAt = Date.now();
        state.net = [];
        persistNetLog();
        sendResponse({ ok: true });
        break;
      case "learn:stop":
        state.learning = false;
        persistNetLog();
        sendResponse({ ok: true });
        break;
      case "learn:get":
        sendResponse({
          ok: true,
          events: interestingEvents(state.learnStartedAt, msg.showAll),
          currentUrl: location.href,
        });
        break;
      case "learn:fromPage": {
        // Fallback for when a posting is just a URL: use this page as the
        // template, with the posting ID in the address swapped for {{ID}}.
        const url = location.href;
        const known = new Set(state.rows.keys());
        const found = [...new Set(url.match(ID_RE) || [])];
        let id = msg.postingId ? String(msg.postingId).trim() : null;
        if (!id) {
          const hits = found.filter((n) => known.has(n));
          if (hits.length === 1) id = hits[0];
          else if (found.length === 1) id = found[0];
        }
        if (!id || !url.includes(id)) {
          sendResponse({
            ok: false,
            needPostingId: found.length > 0,
            candidates: found.slice(0, 12),
            error:
              found.length === 0
                ? "This page's URL contains no posting ID, so it can't be used as a template. The posting must be loaded by a form POST — use one of the captured requests instead."
                : "Tell me which posting ID this page is showing.",
          });
          break;
        }
        const template = {
          method: "GET",
          url: url.split(id).join("{{ID}}"),
          body: null,
          contentType: null,
          sampleId: id,
          responseContentType: "text/html",
          capturedAt: Date.now(),
        };
        await saveTemplate(template);
        state.learning = false;
        sendResponse({ ok: true, template });
        break;
      }
      case "learn:pick": {
        const r = buildTemplate(msg.eventIndex, msg.postingId);
        if (r.ok) {
          await saveTemplate(r.template);
          state.learning = false;
        }
        sendResponse(r);
        break;
      }
      case "ids:scanPage": {
        mergeRows(scanCurrentPage());
        await persistRows();
        sendResponse({ ok: true, count: state.rows.size });
        break;
      }
      case "ids:paginate":
        scanWithPagination(msg.maxPages || 40);
        sendResponse({ ok: true, started: true });
        break;
      case "ids:manual": {
        const ids = String(msg.text || "").match(/\d{5,7}/g) || [];
        ids.forEach((id) => {
          if (!state.rows.has(id)) state.rows.set(id, { id, title: "", listFields: {} });
        });
        await persistRows();
        sendResponse({ ok: true, count: state.rows.size, added: ids.length });
        break;
      }
      case "ids:clear":
        state.rows.clear();
        await chrome.storage.local.remove("wws_rows");
        sendResponse({ ok: true });
        break;
      case "scrape:start":
        scrapeAll({
          delayMs: msg.delayMs,
          includeRawHtml: msg.includeRawHtml,
          skipExisting: msg.skipExisting !== false,
        });
        sendResponse({ ok: true, started: true });
        break;
      case "scrape:stop":
        state.abort = true;
        sendResponse({ ok: true });
        break;
      case "results:getJson": {
        // The claim below is synchronous, before any await, so two requests
        // arriving back-to-back cannot both get through and race each other
        // writing the same file.
        const sig = `${resultsSignature()}@${msg.target || "?"}`;
        const last = state.lastSaved;
        if (last && last.sig === sig && Date.now() - last.at < SAVE_DEDUPE_MS) {
          sendResponse({
            ok: true,
            skipped: true,
            // Named even though nothing was written: the file on disk is still
            // the current export, and callers want to point at it.
            filename: RESULTS_FILENAME,
            count: state.results.size,
            sinceMs: Date.now() - last.at,
          });
          break;
        }
        state.lastSaved = { sig, at: Date.now() };

        const { filename, data } = await buildResultsPayload();
        sendResponse({
          ok: true,
          filename,
          json: JSON.stringify(data, null, 2),
          count: state.results.size,
        });
        break;
      }
      case "debug:getRaw": {
        const p = await buildRawPayload();
        if (!p.ok) {
          sendResponse(p);
          break;
        }
        sendResponse({
          ok: true,
          filename: p.filename,
          json: JSON.stringify(p.data, null, 2),
          id: p.id,
          status: p.status,
          bytes: p.bytes,
        });
        break;
      }
      case "debug:listDom": {
        const info = debugListDom();
        sendResponse({
          ok: true,
          filename: "waterlooworks-listdom.json",
          json: JSON.stringify(info, null, 2),
          tables: info.tables.length,
          ids: info.idNodes.length,
        });
        break;
      }
      case "download:text":
        downloadText(msg.filename, msg.text);
        sendResponse({ ok: true });
        break;
      case "results:clear":
        state.results.clear();
        await chrome.storage.local.remove("wws_results");
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: "unknown command " + msg.cmd });
    }
  })();
  return true; // keep the channel open for the async response
});

console.log(LOG, "content script ready on", location.href);
