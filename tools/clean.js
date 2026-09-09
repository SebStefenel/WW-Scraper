#!/usr/bin/env node
/**
 * Normalizes raw WaterlooWorks scrapes into a clean, typed dataset.
 *
 *   node tools/clean.js [files...] [--out DIR] [--keep-raw] [--no-csv]
 *
 * With no files given it picks up every waterlooworks-postings*.json in the
 * current directory, merges them, and de-duplicates by posting ID (newest
 * scrape wins) — so re-running a partial scrape and a full one is safe.
 *
 * Writes postings.clean.json and postings.csv. No dependencies.
 */

"use strict";
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const txt = (v) => (v == null ? null : String(v).trim() || null);

/** Bulleted values arrive as "• a\n\n• b"; tighten to one line per bullet. */
function tidy(v) {
  const s = txt(v);
  if (!s) return null;
  return s
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}(?=\s*•)/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
}

const asArray = (v) =>
  v == null ? [] : Array.isArray(v) ? v.map((x) => txt(x)).filter(Boolean) : [txt(v)].filter(Boolean);

function toInt(v) {
  const n = parseInt(String(v == null ? "" : v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/** "Sep 17, 2026 9:00 AM" -> { raw, iso, date }. Times are local (Waterloo). */
function parseDeadline(raw) {
  const s = txt(raw);
  if (!s) return null;
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i.exec(s);
  if (!m) return { raw: s, iso: null, date: null };
  const [, mon, day, year, hh, mm, ampm] = m;
  const month = MONTHS[mon.toLowerCase()];
  if (month === undefined) return { raw: s, iso: null, date: null };
  let hour = hh ? parseInt(hh, 10) % 12 : 0;
  if (ampm && /pm/i.test(ampm)) hour += 12;
  const dt = new Date(+year, month, +day, hour, mm ? +mm : 0);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    raw: s,
    iso: dt.toISOString(),
    date: `${year}-${pad(month + 1)}-${pad(+day)}`,
  };
}

/** "8 month consecutive work term required" -> months/terms/consecutive/requirement */
function parseDuration(raw) {
  const s = txt(raw);
  if (!s) return null;
  const months = /(\d+)\s*month/i.exec(s);
  // "2 work term commitment" counts terms, not months — only match a bare digit
  // directly before "work term".
  const terms = /(\d+)\s*work\s*term/i.exec(s);
  return {
    raw: s,
    months: months ? +months[1] : null,
    terms: terms ? +terms[1] : null,
    consecutive: /consecutive/i.test(s),
    requirement: /required/i.test(s) ? "required" : /preferred/i.test(s) ? "preferred" : null,
  };
}

/** "2027 - Winter" -> { raw, year, season } */
function parseWorkTerm(raw) {
  const s = txt(raw);
  if (!s) return null;
  const m = /(\d{4})\s*-\s*(\w+)/.exec(s);
  return m ? { raw: s, year: +m[1], season: m[2] } : { raw: s, year: null, season: null };
}

/**
 * "Targeted Clusters\n\n• ENG - Software Engineering\n\n• MATH - Computer Science"
 * -> ["ENG - Software Engineering", "MATH - Computer Science"]
 */
function parseClusters(raw) {
  const s = txt(raw);
  if (!s) return [];
  return s
    .split("•")
    .slice(1) // drop the "Targeted Clusters" heading before the first bullet
    .map((c) => c.replace(/\s+/g, " ").trim().replace(/^-\s*/, ""))
    .filter(Boolean);
}

/** Header cells carry sort-icon glyph names: "Job Titleswap_vert" -> "Job Title" */
const ICON_NAMES =
  /(swap_vert|keyboard_arrow_down|keyboard_arrow_up|unfold_more|arrow_upward|arrow_downward)/g;
function cleanKey(k) {
  return String(k).replace(ICON_NAMES, "").replace(/^Select All/, "").trim();
}

function cleanListFields(listFields) {
  const out = {};
  for (const [k, v] of Object.entries(listFields || {})) {
    const key = cleanKey(k);
    if (key && txt(v)) out[key] = txt(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

// Field keys consumed below; anything left over is surfaced as `extra` so a new
// WaterlooWorks field is never silently dropped.
const MAPPED = new Set([
  "Job Title", "Organization", "Division", "Job Type", "Work Term",
  "Work Term Duration", "Number of Job Openings", "Level", "Region",
  "Job - City", "Job - Province/State", "Job - Country", "Job - Postal/Zip Code",
  "Job - Address Line One", "Job - Address Line Two",
  "Employment Location Arrangement",
  "Job Location (If Exact Address Unknown or Multiple Locations)",
  "Additional Employment Arrangement Location Information",
  "Application Deadline", "Application Method", "Application Documents Required",
  "Additional Application Information",
  "Job Summary", "Job Responsibilities", "Required Skills",
  "Compensation and Benefits", "Targeted Degrees and Disciplines",
  "Special Job Requirements", "Special Work Term Start/End Date Considerations",
  "Transportation and Housing", "Additional Information",
  "Employer Internal Job Number", "Additional Job Identifiers",
]);

function normalize(p) {
  const f = p.fields || {};
  const list = cleanListFields(p.listFields);

  const extra = {};
  for (const [k, v] of Object.entries(f)) if (!MAPPED.has(k)) extra[k] = v;

  return {
    id: String(p.id),
    title: txt(f["Job Title"]) || txt(p.title),
    organization: txt(f["Organization"]),
    division: txt(f["Division"]),
    jobType: txt(f["Job Type"]),

    workTerm: parseWorkTerm(f["Work Term"]),
    duration: parseDuration(f["Work Term Duration"]),
    openings: toInt(f["Number of Job Openings"]),
    applicants: toInt(list["Apps"]),
    levels: asArray(f["Level"]).flatMap((l) => l.split(",").map((x) => x.trim())).filter(Boolean),

    location: {
      city: txt(f["Job - City"]) || txt(list["City"]),
      province: txt(f["Job - Province/State"]),
      country: txt(f["Job - Country"]),
      region: txt(f["Region"]),
      postalCode: txt(f["Job - Postal/Zip Code"]),
      addressLines: [f["Job - Address Line One"], f["Job - Address Line Two"]]
        .map(txt)
        .filter(Boolean),
      arrangement: txt(f["Employment Location Arrangement"]),
      approximate: txt(f["Job Location (If Exact Address Unknown or Multiple Locations)"]),
      note: tidy(f["Additional Employment Arrangement Location Information"]),
    },

    deadline: parseDeadline(f["Application Deadline"]),
    application: {
      method: txt(f["Application Method"]),
      documents: (txt(f["Application Documents Required"]) || "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      additionalInfo: tidy(f["Additional Application Information"]),
    },

    compensation: tidy(f["Compensation and Benefits"]),
    summary: tidy(f["Job Summary"]),
    responsibilities: tidy(f["Job Responsibilities"]),
    skills: tidy(f["Required Skills"]),
    clusters: parseClusters(f["Targeted Degrees and Disciplines"]),

    specialRequirements: tidy(f["Special Job Requirements"]),
    scheduleNotes: tidy(f["Special Work Term Start/End Date Considerations"]),
    transportationHousing: tidy(f["Transportation and Housing"]),
    additionalInformation: asArray(f["Additional Information"]),
    jobIdentifiers: asArray(f["Additional Job Identifiers"]),
    employerJobNumber: txt(f["Employer Internal Job Number"]),

    scrapedAt: p.scrapedAt || null,
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

// ---------------------------------------------------------------------------
// csv
// ---------------------------------------------------------------------------
const CSV_COLUMNS = [
  ["id", (r) => r.id],
  ["title", (r) => r.title],
  ["organization", (r) => r.organization],
  ["division", (r) => r.division],
  ["city", (r) => r.location.city],
  ["province", (r) => r.location.province],
  ["country", (r) => r.location.country],
  ["arrangement", (r) => r.location.arrangement],
  ["levels", (r) => r.levels.join("; ")],
  ["openings", (r) => r.openings],
  ["applicants", (r) => r.applicants],
  ["deadline", (r) => r.deadline && r.deadline.date],
  ["durationMonths", (r) => r.duration && r.duration.months],
  ["workTerm", (r) => r.workTerm && r.workTerm.raw],
  ["clusters", (r) => r.clusters.join("; ")],
  ["documents", (r) => r.application.documents.join("; ")],
];

function toCsv(rows) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v).replace(/\s+/g, " ").trim();
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([h]) => h).join(",")];
  for (const r of rows) lines.push(CSV_COLUMNS.map(([, get]) => esc(get(r))).join(","));
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx !== -1 ? argv[outIdx + 1] : ".";
  let files = argv.filter((a, i) => !a.startsWith("--") && !(outIdx !== -1 && i === outIdx + 1));

  if (!files.length) {
    files = fs
      .readdirSync(".")
      // matches both the current stable name and older timestamped exports
      .filter((f) => /^waterlooworks-postings.*\.json$/.test(f))
      .sort();
  }
  if (!files.length) {
    console.error("No input files. Pass paths, or run where waterlooworks-postings-*.json live.");
    process.exit(1);
  }

  const byId = new Map();
  let read = 0;
  let duplicates = 0;

  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`  skipped ${file}: ${err.message}`);
      continue;
    }
    const postings = Array.isArray(doc) ? doc : doc.postings || [];
    console.log(`  read ${file} — ${postings.length} postings`);
    for (const p of postings) {
      if (!p || p.id == null) continue;
      read++;
      const id = String(p.id);
      const prev = byId.get(id);
      if (prev) {
        duplicates++;
        // newest scrape wins
        if ((p.scrapedAt || "") <= (prev._scrapedAt || "")) continue;
      }
      const rec = normalize(p);
      rec._scrapedAt = p.scrapedAt || "";
      if (flags.has("--keep-raw") && p.raw && p.raw.text) rec.rawText = p.raw.text;
      byId.set(id, rec);
    }
  }

  const rows = [...byId.values()]
    .map(({ _scrapedAt, ...r }) => r)
    .sort((a, b) => {
      const d = (a.deadline && a.deadline.date ? a.deadline.date : "9999") .localeCompare(
        b.deadline && b.deadline.date ? b.deadline.date : "9999"
      );
      return d || String(a.id).localeCompare(String(b.id));
    });

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "postings.clean.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: rows.length, sources: files, postings: rows },
      null,
      2
    )
  );

  let csvPath = null;
  if (!flags.has("--no-csv")) {
    csvPath = path.join(outDir, "postings.csv");
    fs.writeFileSync(csvPath, toCsv(rows));
  }

  // ---- report -------------------------------------------------------------
  const count = (fn) => rows.filter(fn).length;
  const missing = (name, fn) => {
    const n = count((r) => !fn(r));
    if (n) console.log(`  ${String(n).padStart(4)} missing ${name}`);
  };

  console.log(`\nread ${read} records, ${duplicates} duplicate ids collapsed`);
  console.log(`wrote ${jsonPath} — ${rows.length} postings`);
  if (csvPath) console.log(`wrote ${csvPath}`);

  console.log("\ncompleteness:");
  missing("title", (r) => r.title);
  missing("summary", (r) => r.summary);
  missing("skills", (r) => r.skills);
  missing("deadline date", (r) => r.deadline && r.deadline.date);
  missing("city", (r) => r.location.city);
  missing("clusters", (r) => r.clusters.length);
  missing("duration months", (r) => r.duration && r.duration.months);

  const withExtra = rows.filter((r) => r.extra);
  if (withExtra.length) {
    const keys = new Set();
    withExtra.forEach((r) => Object.keys(r.extra).forEach((k) => keys.add(k)));
    console.log(`\n  ${withExtra.length} postings carry unmapped fields: ${[...keys].join(", ")}`);
  }

  const tally = (get) => {
    const m = {};
    rows.forEach((r) => {
      const v = get(r);
      (Array.isArray(v) ? v : [v]).filter(Boolean).forEach((x) => (m[x] = (m[x] || 0) + 1));
    });
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };

  console.log("\narrangement: " + tally((r) => r.location.arrangement).map(([k, n]) => `${k} ${n}`).join(" · "));
  console.log("top cities:  " + tally((r) => r.location.city).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(" · "));
  console.log("levels:      " + tally((r) => r.levels).map(([k, n]) => `${k} ${n}`).join(" · "));
}

main();
