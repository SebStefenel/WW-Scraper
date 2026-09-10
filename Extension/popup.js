// Thin remote control over the content script running on the WaterlooWorks tab.

const $ = (id) => document.getElementById(id);
const WW_HOST = "waterlooworks.uwaterloo.ca";
const IN_TAB = new URLSearchParams(location.search).get("tab") === "1";

let tabId = null;
let learnPoll = null;
let dirHandle = null; // FileSystemDirectoryHandle for the output folder

// ---- output folder --------------------------------------------------------
// The handle lives in IndexedDB, never in the repo — so the chosen path is
// runtime state on this machine and there's nothing path-shaped to commit.
const DB_NAME = "wws";
const STORE = "handles";

function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbOp(mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

const idbGet = (k) => idbOp("readonly", (s) => s.get(k));
const idbSet = (k, v) => idbOp("readwrite", (s) => s.put(v, k));
const idbDel = (k) => idbOp("readwrite", (s) => s.delete(k));

function renderFolder() {
  $("folderName").textContent = dirHandle ? `${dirHandle.name}/` : "none (falls back to Downloads)";
}

async function ensurePermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

async function chooseFolder() {
  if (!window.showDirectoryPicker) {
    log("This Chrome build has no directory picker; files will go to Downloads.", "err");
    return;
  }
  try {
    const h = await window.showDirectoryPicker({ mode: "readwrite", id: "wws-output" });
    await idbSet("outputDir", h);
    dirHandle = h;
    renderFolder();
    log(`Output folder set to ${h.name}/`, "ok");
  } catch (err) {
    if (err && err.name === "AbortError" && !IN_TAB) {
      log('Chrome closed the popup to show the dialog. Click "Open in tab" and pick the folder there.', "err");
    } else if (err && err.name === "AbortError") {
      log("Folder selection cancelled.");
    } else {
      log(String(err), "err");
    }
  }
}

async function writeToFolder(filename, text) {
  if (!(await ensurePermission(dirHandle))) throw new Error("permission denied");
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}

// Write into the chosen folder; fall back to a browser download if that fails.
async function saveJson(filename, json) {
  if (dirHandle) {
    try {
      await writeToFolder(filename, json);
      log(`Saved ${filename} → ${dirHandle.name}/`, "ok");
      return;
    } catch (err) {
      log(`Folder write failed (${err.message}) — using Downloads instead.`, "err");
    }
  }
  await send("download:text", { filename, text: json });
  log(`Downloaded ${filename}.`, "ok");
}

function log(msg, cls) {
  const el = $("log");
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `${time}  ${msg}`;
  el.prepend(line);
  while (el.childNodes.length > 60) el.lastChild.remove();
}

async function send(cmd, extra = {}) {
  if (tabId == null) throw new Error("no WaterlooWorks tab");
  return chrome.tabs.sendMessage(tabId, { cmd, ...extra });
}

async function findTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.includes(WW_HOST)) return tab.id;
  const [any] = await chrome.tabs.query({ url: `https://${WW_HOST}/*` });
  return any ? any.id : null;
}

// Folder controls stay live even without a WaterlooWorks tab — picking an
// output directory doesn't need one.
const ALWAYS_ON = new Set(["chooseFolder", "clearFolder", "openTab", "autoSave", "resuforgeUrl"]);

function setEnabled(on) {
  document.querySelectorAll("button, input, textarea").forEach((el) => {
    if (!ALWAYS_ON.has(el.id)) el.disabled = !on;
  });
}

async function refresh() {
  if (tabId == null) return;
  let s;
  try {
    s = await send("state");
  } catch (e) {
    $("status").textContent =
      "Content script not loaded on that tab — reload the WaterlooWorks page.";
    setEnabled(false);
    return;
  }
  setEnabled(true);

  // The popup is a fresh context every time it opens, but learning mode lives in
  // the content script — pick the polling back up so captures already made are
  // still shown.
  if (s.learning && !learnPoll) startLearnPoll();

  const tmpl = s.hasTemplate
    ? `<span class="ok">template ✓</span> <code>${s.template.method}</code>`
    : `<span class="err">no template</span>`;
  const hooks = s.interceptorReady
    ? `<span class="ok">hooks ✓</span>`
    : `<span class="err">hooks ✗ — reload the WW page</span>`;
  $("status").innerHTML =
    `${hooks} · ${tmpl} · <b>${s.idCount}</b> IDs · <b>${s.resultCount}</b> scraped` +
    ` · <b>${s.captured || 0}</b> captured` +
    (s.scraping ? ' · <b>scraping…</b>' : "") +
    (s.progress && s.progress.message ? `<br><span style="color:var(--muted)">${s.progress.message}</span>` : "");
}

function renderEvents(events, currentUrl) {
  const box = $("events");
  box.innerHTML = "";
  if (!events.length) {
    box.innerHTML =
      '<div class="hint">Nothing captured yet. Open a posting on the WaterlooWorks tab. ' +
      "If the page navigated and still nothing appears, tick <b>show all requests</b>, or use " +
      "<b>Use current page as template</b> while the posting is on screen.</div>";
    return;
  }
  events.slice(0, 15).forEach((e) => {
    const div = document.createElement("div");
    div.className = "ev";
    const short = e.url.replace(/^https?:\/\/[^/]+/, "");
    const kind = e.kind === "form" ? '<b>form submit</b> · ' : "";
    div.innerHTML = `
      <div class="m">${e.method} ${short}</div>
      <div class="meta">${kind}${e.status || ""} ${e.contentType.split(";")[0] || ""} · ${e.bytes}b${
      e.body ? "<br>body: " + e.body.slice(0, 500).replace(/</g, "&lt;") : ""
    }</div>`;
    const btn = document.createElement("button");
    btn.textContent = "Use as posting template";
    btn.onclick = () => pick(e.i);
    div.appendChild(btn);
    box.appendChild(div);
  });
}

async function pick(eventIndex, postingId) {
  const r = await send("learn:pick", { eventIndex, postingId });
  if (r.ok) {
    log(`Template learned (sample ID ${r.template.sampleId}).`, "ok");
    stopLearnPoll();
    $("events").innerHTML = "";
    refresh();
    return;
  }
  if (r.needPostingId) {
    const guess = (r.candidates || []).join(", ");
    const answer = prompt(
      `${r.error}\n\nWhich posting ID did you open?` + (guess ? `\nNumbers seen: ${guess}` : "")
    );
    if (answer) return pick(eventIndex, answer.trim());
    return;
  }
  log(r.error, "err");
}

function startLearnPoll() {
  stopLearnPoll();
  learnPoll = setInterval(async () => {
    try {
      const r = await send("learn:get", { showAll: $("showAll").checked });
      renderEvents(r.events || [], r.currentUrl);
    } catch (_) {}
  }, 1200);
}
function stopLearnPoll() {
  if (learnPoll) clearInterval(learnPoll);
  learnPoll = null;
}

// ---- wiring ---------------------------------------------------------------
$("learnStart").onclick = async () => {
  await send("learn:start");
  log("Learning. Now click a job posting title on the page.");
  startLearnPoll();
};
$("learnStop").onclick = async () => {
  await send("learn:stop");
  stopLearnPoll();
  log("Stopped learning.");
};

async function usePage(postingId) {
  const r = await send("learn:fromPage", { postingId });
  if (r.ok) {
    log(`Template set from the current page (sample ID ${r.template.sampleId}).`, "ok");
    stopLearnPoll();
    $("events").innerHTML = "";
    refresh();
    return;
  }
  if (r.needPostingId) {
    const answer = prompt(
      `${r.error}\n\nNumbers in the URL: ${(r.candidates || []).join(", ")}`
    );
    if (answer) return usePage(answer.trim());
    return;
  }
  log(r.error, "err");
}

$("usePage").onclick = () => usePage();

$("scanPage").onclick = async () => {
  const r = await send("ids:scanPage");
  log(`Scanned this page — ${r.count} IDs total.`, "ok");
  refresh();
};
$("paginate").onclick = async () => {
  await send("ids:paginate", { maxPages: Number($("maxPages").value) || 40 });
  log("Paging through the list… watch the page.");
};
$("idsManual").onclick = async () => {
  const r = await send("ids:manual", { text: $("manualIds").value });
  log(`Added ${r.added} pasted IDs — ${r.count} total.`, "ok");
  $("manualIds").value = "";
  refresh();
};
$("dumpList").onclick = async () => {
  const r = await send("debug:listDom");
  if (!r.ok) return log(r.error, "err");
  await saveJson(r.filename, r.json);
  log(`List DOM dumped: ${r.tables} tables, ${r.ids} ID nodes found.`, "ok");
};
$("idsClear").onclick = async () => {
  await send("ids:clear");
  log("Cleared IDs.");
  refresh();
};

$("scrapeStart").onclick = async () => {
  await send("scrape:start", {
    delayMs: Number($("delayMs").value) || 1500,
    includeRawHtml: $("rawHtml").checked,
    skipExisting: $("skipExisting").checked,
  });
  log("Scrape started. You can close this popup — it keeps running.");
};
$("scrapeStop").onclick = async () => {
  await send("scrape:stop");
  log("Stopping after the current request…");
};

$("chooseFolder").onclick = chooseFolder;
$("clearFolder").onclick = async () => {
  await idbDel("outputDir");
  dirHandle = null;
  renderFolder();
  log("Output folder cleared.");
};

let savingNow = false;

// Resolves { ok, filename } once the export exists on disk — including when the
// dedupe suppressed the write, since the file sitting there is already current.
// Resolves { ok: false } when there is nothing to export; the reason is logged
// here, so callers can just bail.
async function saveResults() {
  if (savingNow) {
    log("A save is already in progress.");
    return { ok: false };
  }
  savingNow = true;
  try {
    // The destination is part of the dedupe key, so picking a new output folder
    // and saving again is a real save rather than a suppressed duplicate.
    const target = dirHandle ? dirHandle.name : "download";
    const r = await send("results:getJson", { target });
    if (!r.ok) {
      log(r.error, "err");
      return { ok: false };
    }
    if (r.skipped) {
      log(`Already saved ${Math.round(r.sinceMs / 1000)}s ago — nothing new to write.`);
      return { ok: true, filename: r.filename, skipped: true };
    }
    if (!r.count) {
      log("Nothing scraped yet.", "err");
      return { ok: false };
    }
    await saveJson(r.filename, r.json);
    return { ok: true, filename: r.filename };
  } finally {
    savingNow = false;
  }
}

$("save").onclick = saveResults;

// ---- ResuForge handoff ----------------------------------------------------
// ResuForge's WaterlooWorks section reads the same JSON this panel saves, so
// the export is: write the file, then open the import page. The file never goes
// through a server — it's picked up from disk by the page you're sent to.
const RESUFORGE_DEFAULT = "https://resuforge-app.vercel.app";
const RESUFORGE_KEY = "wws_resuforge_url";

// The field is restored from saved settings on open and written back as it's
// edited (see "remembered settings" below), so this only has to read it.
function resuforgeBase() {
  return ($("resuforgeUrl").value.trim() || RESUFORGE_DEFAULT).replace(/\/+$/, "");
}

// Clearing the box means "go back to the default", not "no target at all".
$("resuforgeUrl").addEventListener("change", () => {
  if (!$("resuforgeUrl").value.trim()) {
    $("resuforgeUrl").value = RESUFORGE_DEFAULT;
    savePrefsSoon();
  }
});

$("toResuforge").onclick = async () => {
  // Goes through saveResults so the export shares its in-flight latch and its
  // save de-duplication — clicking this right after Save JSON must not write the
  // same file twice, and a suppressed write still leaves a current file to open.
  const saved = await saveResults();
  if (!saved.ok) return;

  let base;
  try {
    base = resuforgeBase();
    // Reject anything that isn't a real http(s) URL before handing it to
    // tabs.create, which would otherwise resolve a bare host against the
    // extension's own origin.
    const u = new URL(base);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http(s)");
  } catch (_) {
    return log(`"${$("resuforgeUrl").value}" isn't a valid URL — include https://.`, "err");
  }

  await chrome.tabs.create({ url: `${base}/#/ww` });
  log(`Opened ResuForge — drop ${saved.filename} onto the page.`, "ok");
};
$("dump").onclick = async () => {
  log("Fetching one raw posting…");
  const r = await send("debug:getRaw");
  if (!r.ok) return log(r.error, "err");
  await saveJson(r.filename, r.json);
  log(`Posting ${r.id}: HTTP ${r.status}, ${r.bytes}b.`, "ok");
};
$("openTab").onclick = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?tab=1") });
$("resultsClear").onclick = async () => {
  if (!confirm("Delete all scraped results?")) return;
  await send("results:clear");
  log("Cleared results.");
  refresh();
};

// ---- remembered settings --------------------------------------------------
// The popup is a brand-new document every time it opens, so whatever you typed
// into it last time is gone unless it was written down. These are the controls
// worth carrying over, with the defaults that popup.html ships — a control falls
// back to its default only when nothing has been stored for it yet.
//
// manualIds is deliberately not in here: it's cleared the moment its IDs are
// added, so restoring a stale paste would just be confusing. Neither is the
// output folder, which is a FileSystemDirectoryHandle in IndexedDB (see the top
// of this file) because permissions ride along with the handle.
const PREFS_KEY = "wws_prefs";
const PREFS = {
  showAll: false,
  maxPages: 40,
  delayMs: 1500,
  rawHtml: false,
  skipExisting: true,
  autoSave: true,
  resuforgeUrl: RESUFORGE_DEFAULT,
};

const readControl = (el) => (el.type === "checkbox" ? el.checked : el.value);
const writeControl = (el, v) => {
  if (el.type === "checkbox") el.checked = !!v;
  else el.value = v;
};

async function loadPrefs() {
  const got = await chrome.storage.local.get([PREFS_KEY, RESUFORGE_KEY]);
  const stored = got[PREFS_KEY] || {};
  for (const [id, fallback] of Object.entries(PREFS)) {
    const el = $(id);
    if (!el) continue;
    let v = stored[id];
    // Carry over the ResuForge URL from when it had a key of its own, so an
    // already-configured target isn't silently reset to the default.
    if (v === undefined && id === "resuforgeUrl") v = got[RESUFORGE_KEY];
    writeControl(el, v === undefined ? fallback : v);
  }
}

// Debounced because this is wired to `input`, which fires per keystroke: typing
// a URL shouldn't mean one storage write per character.
let prefsTimer = null;
function savePrefsSoon() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const out = {};
    for (const id of Object.keys(PREFS)) {
      const el = $(id);
      if (el) out[id] = readControl(el);
    }
    chrome.storage.local.set({ [PREFS_KEY]: out });
  }, 250);
}

function watchPrefs() {
  for (const id of Object.keys(PREFS)) {
    const el = $(id);
    if (!el) continue;
    // Both events: `input` catches typing as it happens, `change` catches the
    // commit of a control that only reports on blur.
    el.addEventListener("input", savePrefsSoon);
    el.addEventListener("change", savePrefsSoon);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "wws:progress") return;
  if (msg.message) log(msg.message, msg.error ? "err" : msg.finished ? "ok" : null);
  refresh();
  if (msg.finished && msg.phase === "scrape" && !msg.error && $("autoSave").checked) {
    saveResults();
  }
});

(async () => {
  if (IN_TAB) document.body.classList.add("in-tab");
  try {
    dirHandle = (await idbGet("outputDir")) || null;
  } catch (_) {
    dirHandle = null;
  }
  renderFolder();

  await loadPrefs();
  watchPrefs();

  tabId = await findTab();
  if (tabId == null) {
    $("status").textContent = "Open a WaterlooWorks page first, then reopen this panel.";
    setEnabled(false);
    return;
  }
  await refresh();
  setInterval(refresh, 2500);
})();
