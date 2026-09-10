# WW-Scraper

A local, unpacked Chrome extension that bulk-collects co-op job postings from
WaterlooWorks into a JSON file, then hands it to
[ResuForge](../Resuforge) to normalize, filter and export.

This repo is the extension and nothing else. Everything downstream of the
scrape — cleaning the raw fields into a typed dataset, browsing it, writing
`postings.clean.json` / `postings.csv` — lives in ResuForge's **WaterlooWorks**
section, so there's one place to process postings instead of a CLI here and a
website there.

It never touches authentication. It runs inside the tab where you're already
logged in, so every request it makes carries your existing session cookies —
no SSO flow, no Duo, no stored credentials.

## The idea: learn, then replay

WaterlooWorks is an Orbis app whose internals change without notice, so this
extension doesn't hardcode any endpoint. Instead:

1. You turn on **learning mode** and click one job posting.
2. The extension watches the page's own network calls and captures the exact
   request WaterlooWorks used to load that posting's details.
3. It generalizes that request into a template by replacing the posting ID with
   a `{{ID}}` placeholder.
4. It replays the template — throttled — for every posting ID it found in the
   job-search table, parses each response, and stores the result.

If WaterlooWorks changes their UI, you re-learn in 10 seconds instead of
rewriting selectors.

## Install

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. **Load unpacked** → select the `Extension` folder in this repo
4. Pin the extension so its icon is visible

## Use

Open WaterlooWorks and navigate to **CO-OP JOBS → Jobs / Applications** with
your filters applied, then click the extension icon.

**Step 1 — Learn.** Click *Start learning*, then click any job posting title on
the page to open it. Requests appear in the popup as they happen. Pick the one
that looks like the posting body — usually a `POST`, a few KB or more, with the
posting ID in its URL or body. Click *Use as posting template*. If it can't
work out which number is the posting ID, it'll ask you.

**Step 2 — Collect IDs.** Go back to the job list.
- *Scan this page* grabs every posting row currently rendered, along with all
  visible columns (ID, title, org, division, openings, city, level, apps).
- *Scan + follow pages* does that, then clicks the next-page control and
  repeats. Watch it — if it stops after one page, the next-page button wasn't
  recognized and you should page manually, hitting *Scan this page* each time.
- Or paste a list of IDs into the box.

**Step 3 — Scrape.** Set a delay (1500ms is a polite default) and hit *Start
scrape*. You can close the popup; it keeps running as long as you don't
navigate that tab away. Progress is checkpointed every 10 postings, so a crash
costs you at most a few.

**Step 4 — Output.** Click *Choose folder…* once and pick where the file should
go. Chrome remembers the folder (the handle is kept in IndexedDB), so *Save JSON*
writes straight into it — no Downloads detour. With *auto-save* checked, a
finished scrape writes itself out automatically.

> **Heads up:** Chrome dismisses an extension popup when a native folder dialog
> opens, so *Choose folder…* usually fails from the popup. Click **Open in tab**
> first and pick the folder from the full-page panel; after that the popup works
> fine for everything else.

The chosen path is runtime state on your machine only — it is never written to
any file in this repo, and exported `.json` files are gitignored.

If you skip the folder step, exports fall back to your Downloads folder.

**Step 5 — Send it to ResuForge.** Click *Export to ResuForge*. That writes the
JSON (same as *Save JSON*) and opens ResuForge's WaterlooWorks section in a new
tab; drop the file onto that page to import it. The URL next to the button is
remembered — point it at your own deployment, or at `http://localhost:3000` when
running ResuForge locally.

The file is read by the page off your disk. It is not uploaded anywhere, and
ResuForge keeps the imported postings in that browser only.

On the ResuForge side you get the normalization this repo's `tools/clean.js`
used to do — typed fields, parsed deadlines and durations, de-duplication by
posting ID with the newest scrape winning — plus search, filtering by
arrangement / city / level / discipline / deadline / term length, a completeness
report, and `postings.clean.json` / `postings.csv` downloads of whatever the
filters currently select. Importing a second scrape merges into the first rather
than replacing it.

## Output shape

```jsonc
{
  "meta": { "generatedAt": "...", "count": 412, "idsKnown": 412, "template": {...} },
  "postings": [
    {
      "id": "486018",
      "title": "AI Enablement Test Developer (Co-Op)",
      "scrapedAt": "2026-09-08T...",
      "source": "https://waterlooworks.uwaterloo.ca/...",
      "listFields": { "Organization": "Agfa HealthCare Inc", "City": "Waterloo", "Apps": "59", ... },
      "fields":    { "Job Title": "...", "Work Term Duration": "...", "Application Deadline": "...", ... },
      "sections":  { "Job Summary": "...", "Job Responsibilities": "...", "Required Skills": "..." },
      "raw":       { "text": "full plain-text of the posting" }
    }
  ]
}
```

`fields` and `sections` are extracted heuristically (two-cell table rows,
definition lists, label/value sibling divs, headings + following content).
`raw.text` is always populated as a safety net — if the structured extraction
misses something, it's still in there and you can regex it out downstream.

## If the structured fields come out thin

Click **Dump one raw posting**. That downloads the complete raw response for a
single posting plus what the parser made of it. Open that file, see how the
markup is actually shaped, and tune `parseDetail()` in `content.js` to match.
That's the one place likely to need adjustment on first run.

## Notes

- Default throttle is 1500ms with ±30% jitter. Don't lower it much — this is a
  university service and you gain nothing by hammering it.
- If three requests fail in a row (HTTP error, or a response that looks like a
  login page), the scrape stops and tells you. Usually means the session or a
  captured CSRF token expired: reload WaterlooWorks and re-learn the template.
- Only use this for postings your own account can already see.
- The panel remembers its settings — max pages, delay, the checkboxes and
  the ResuForge URL are restored next time you open it. The pasted-IDs box
  isn't, since it's cleared as soon as those IDs are added, and neither is
  the output folder, whose permission rides along with the handle itself.
- `raw HTML` is off by default — turning it on makes the output several times
  larger but preserves markup like links and lists.

## Files

Everything is under `Extension/`; the repo root holds only this README.

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; storage + WaterlooWorks host permission only |
| `interceptor.js` | Runs in the page world, wraps `fetch`/`XHR`, reports requests. Observes only |
| `content.js` | All the real work: templating, ID scanning, scrape loop, parsing, export payloads |
| `popup.html` / `popup.js` | Control panel; works as a popup or a full tab. Owns the output-folder handle and the ResuForge handoff |
