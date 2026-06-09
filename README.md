# OSINT Capture

A Chrome extension (Manifest V3) for OSINT analysts to capture web pages as
structured, schema-defined records and export them as JSON or CSV.

Built for evidence collection: every capture is URL-cleaned, content-hashed, and
timestamped, then organized under analyst-defined schemas for consistent,
portable output. Nothing leaves your browser unless you export it — all data is
stored locally in `chrome.storage.local`.

---

## What it does

OSINT Capture turns any web page into a structured record:

- **Capture** the active tab — title, cleaned URL, extracted article text,
  source, author, publish date — from a keystroke, a toolbar button, or the
  right-click menu.
- **Structure** captures with custom schemas (column templates) so every export
  has consistent fields.
- **Export** to JSON or CSV (UTF-8 BOM, RFC 4180) for downstream analysis.
- **Merge** CSV exports from multiple analysts into one deduplicated,
  conflict-resolved dataset.

---

## Features

### Capture

- **Multiple entry points** — keyboard shortcut **Alt+Shift+C**, the popup
  **Capture** button, right-click **"Capture this page"**, and right-click
  **"Capture this link"** (captures a link target without leaving the page).
- **Article extraction** via [Defuddle](https://github.com/kepano/defuddle) —
  pulls the main content out of cluttered pages.
- **URL cleaning** via [ClearURLs](https://github.com/ClearURLs/Addon) rules —
  strips tracking parameters (`utm_*`, `fbclid`, …) before storing.
- **Content hashing** — every capture carries a SHA-256 hash of its content for
  integrity and deduplication.
- **Date normalization** — recognizes ISO 8601, compact, English-month, and
  Chinese (`YYYY年M月D日`) publish-date formats.
- **Pick mode** — manually select text on the page to fill any field.
- **Badge feedback** — ✓ / ✗ on the toolbar icon confirms each capture.

### Schemas

- Define **column templates** that map to capture fields (title, URL, source,
  author, capture time, publish time, content, content hash) plus custom fields.
- A read-only **Default schema** ships built in; create, edit, duplicate,
  reorder (drag & drop), and delete your own.
- **Import / export** schemas as JSON to share them across machines.
- The active schema is stamped onto each capture at capture time.

### Export

- **JSON** (versioned envelope with schema metadata) or **CSV / TSV** (UTF-8 BOM,
  RFC 4180 quoting, comma or tab delimiter).
- **Export all** or **export selected**; captures are grouped per schema into
  separate files.
- Files download to `Downloads/<subfolder>/` named
  `<timestamp>_<schema>_<operator>`.

### Merge (team workflow)

- Pick a folder of exported CSVs; files are grouped by header (schema).
- Rows are **deduplicated by URL**; conflicting values are concatenated with
  operator attribution — `value [AnalystA] | value [AnalystB]`.
- One merged file is produced per schema group.

### Settings

- Operator name, downloads subfolder, default export format, CSV delimiter.

---

## Origin

Forked from [obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper)
(MIT). The approach has since diverged substantially.

URL-cleaning rules come from [ClearURLs](https://github.com/ClearURLs/Addon)
(`src/lib/data.min.json`, LGPL-3.0). See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full attribution.

---

## Install (developer mode)

1. `npm install && npm run build`
2. Chrome → `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

---

## Development

```bash
npm install     # install dependencies
npm run build   # build to dist/
npm run watch   # rebuild on change
```

### Project structure

```
src/
  manifest.json       version source of truth (package.json must match)
  background.js       service worker — commands, context menus, link capture, badge
  content.js          content script — Defuddle extraction, URL cleaning, pick mode
  popup/              popup UI — capture, schema editor, export, merge, settings
  lib/data.min.json   ClearURLs tracking rules (LGPL-3.0)
  icons/              extension icons (SVG + PNG)
build.js              esbuild bundler
```

---

## Release

Tag with `v*` (semver); GitHub Actions builds the extension, zips `dist/`, and
publishes a GitHub Release with `osint-capture.zip`.

```bash
git tag v0.1.3
git push origin main --tags
```

---

## License

MIT — see [LICENSE](LICENSE). Third-party components retain their own licenses —
see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
