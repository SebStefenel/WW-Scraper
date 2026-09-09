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
const ALWAYS_ON = new Set(["chooseFolder", "clearFolder", "openTab", "autoSave"]);

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

async function saveResults() {
  if (savingNow) return log("A save is already in progress.");
  savingNow = true;
  try {
    // The destination is part of the dedupe key, so picking a new output folder
    // and saving again is a real save rather than a suppressed duplicate.
    const target = dirHandle ? dirHandle.name : "download";
    const r = await send("results:getJson", { target });
    if (!r.ok) return log(r.error, "err");
    if (r.skipped) {
      return log(`Already saved ${Math.round(r.sinceMs / 1000)}s ago — nothing new to write.`);
    }
    if (!r.count) return log("Nothing scraped yet.", "err");
    await saveJson(r.filename, r.json);
  } finally {
    savingNow = false;
  }
}

$("save").onclick = saveResults;
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

  tabId = await findTab();
  if (tabId == null) {
    $("status").textContent = "Open a WaterlooWorks page first, then reopen this panel.";
    setEnabled(false);
    return;
  }
  await refresh();
  setInterval(refresh, 2500);
})();
